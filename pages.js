/* ============================================================
   PAGES
   Each page is a function(container, fs) that renders itself.
   Shared helpers below avoid duplicating the "team breakdown"
   and "drill-down" logic across pages.
   ============================================================ */

function uniqueSorted(rows, field) {
  return Array.from(new Set(rows.map(r => r[field]).filter(Boolean))).sort();
}

// Week picker + country pills side by side — used at the top of every page.
function weekAndCountryRow(fs, render) {
  return el('div', { class: 'top-filter-row' }, [WeekRangePicker(fs, render), MarketPillRow(fs, render)]);
}

// Renders the drill breadcrumb into the floating top-right slot (next to the
// reset button) instead of inline, so it stays visible while scrolling.
function renderFloatingBreadcrumb(rootLabel, fs, onNavigate) {
  const holder = document.getElementById('floatingBreadcrumb');
  if (!holder) return;
  holder.innerHTML = '';
  if (fs.drillPath.length) holder.appendChild(Breadcrumb(rootLabel, fs, onNavigate));
}

// "market" key comments are stored against: the one specific market selected,
// or 'FA-EU' for combined/multiple — comments always work, never gated.
function commentMarketKey(fs) {
  return (fs.state.markets.length === 1 && fs.state.markets[0] !== 'FA-EU') ? fs.state.markets[0] : 'FA-EU';
}

// Builds the {commentsFor, onCellClick} pair to drop straight into a PivotTable
// or chart's opts.
function commentHooksFor(scope, scopeLabel, market, valueType, render) {
  return {
    commentsFor: (entity, week) => CommentsStore.getFor(scope, entity, market, week),
    onCellClick: (entity, week, value) => {
      showCommentModal({ scope, scopeLabel, entity, market, week, value, valueType, onSaved: render });
    },
  };
}
// currently scoped to, so it's not lost once the top-level breadcrumb scrolls
// out of the normal page flow.
function drillPathLabel(fs) {
  return fs.drillPath.map(c => c.label).join(' → ');
}

function optionsFor(list) { return list.map(v => ({ value: v, label: v })); }

function standardFilterSpec(fs, rows, { includeTeamFilter = true, teamScope = null } = {}) {
  const spec = [
    { key: 'markets', label: 'Country', type: 'multiselect', exclusiveValue: 'FA-EU', options: optionsFor(MARKET_FILTER_OPTIONS) },
  ];
  if (includeTeamFilter) {
    const teamOptions = teamScope ? teamScope : uniqueSorted(rows, 'team');
    spec.push({ key: 'teams', label: 'Team', type: 'multiselect', options: optionsFor(teamOptions) });
  }
  spec.push({ key: 'errorCategory', label: 'Error Category', type: 'multiselect', options: optionsFor(uniqueSorted(rows, 'error_category')) });
  spec.push({ key: 'errorSubcategory', label: 'Subcategory', type: 'multiselect', options: optionsFor(uniqueSorted(rows, 'error_subcategory')) });
  spec.push({ key: 'complaint', label: 'Complaint', type: 'multiselect', options: optionsFor(uniqueSorted(rows, 'complaint')) });
  spec.push({ key: 'sourceType', label: '', type: 'toggle3', options: [
    { value: 'all', label: 'All' }, { value: 'agent', label: 'Agent/Cert' }, { value: 'bulk', label: 'Bulk' },
  ] });
  return spec;
}

function kpiRowFor(agg) {
  return el('div', { class: 'kpi-row' }, [
    KpiCard({ label: 'Error %', value: fmtPct(agg.errorPct) }),
    KpiCard({ label: 'Total Compensation', value: fmtEur(agg.compensationTotal) }),
    KpiCard({ label: 'Compensation / Box', value: fmtEurPrecise(agg.compPerBox) }),
    KpiCard({ label: 'Total Boxes', value: fmtInt(agg.boxes) }),
  ]);
}

// Groups filtered rows by `groupField`, computing error% against the *total*
// box denominator (not a per-group denominator) so results are comparable
// against the per-team targets.
function groupedBreakdown(rows, groupField, boxes) {
  const map = new Map();
  rows.forEach(r => {
    const key = r[groupField] || '(blank)';
    if (!map.has(key)) map.set(key, { key, errorCount: 0, compensationTotal: 0 });
    const g = map.get(key);
    g.errorCount++;
    g.compensationTotal += r.compensation;
  });
  return Array.from(map.values()).map(g => ({
    ...g,
    errorPct: boxes > 0 ? (g.errorCount / boxes) * 100 : 0,
    compPerBox: boxes > 0 ? g.compensationTotal / boxes : 0,
  })).sort((a, b) => b.errorCount - a.errorCount);
}

// The drill hierarchy used by every "team-centric" page.
const DRILL_CHAIN = ['team', 'error_category', 'error_subcategory', 'complaint', 'mapped_detail_1'];

function nextDrillLevel(fs) {
  const idx = fs.drillPath.length;
  return DRILL_CHAIN[Math.min(idx, DRILL_CHAIN.length - 1)];
}

function applyDrillToFilter(fs, baseFilter) {
  const f = { ...baseFilter };
  fs.drillPath.forEach(crumb => {
    const fieldMap = { team: 'teams', error_category: 'errorCategory', error_subcategory: 'errorSubcategory', complaint: 'complaint' };
    const key = fieldMap[crumb.level];
    if (key) f[key] = [crumb.value];
  });
  return f;
}

// ---- Shared "Team Error Rates" page builder (used by Page 1 & Page 3) --------

function buildTeamRatesPage(container, fs, { title, subtitle, teamScope }) {
  const allRows = DataStore.rawRows;
  const scopedRows = teamScope ? allRows.filter(r => teamScope.includes(r.team)) : allRows;

  let compensationMode = 'total'; // 'total' | 'perbox'
  let breakdownMode = 'pct'; // 'pct' | 'absolute'

  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader(title, subtitle);

    renderFloatingBreadcrumb(title, fs, render);
    container.appendChild(weekAndCountryRow(fs, render));

    const spec = standardFilterSpec(fs, scopedRows, { includeTeamFilter: !fs.drillPath.length, teamScope });
    container.appendChild(FilterBar(fs, spec, render));

    // Built fresh every render from live fs.state — this must never be
    // captured once outside render(), or filter changes silently stop
    // affecting the error count while the box count keeps updating.
    const baseFilter = {
      markets: fs.state.markets, errorCategory: fs.state.errorCategory,
      errorSubcategory: fs.state.errorSubcategory, complaint: fs.state.complaint, sourceType: fs.state.sourceType,
      weeks: fs.state.weeks,
      teams: fs.state.teams.length ? fs.state.teams : (teamScope || []),
    };
    const filter = applyDrillToFilter(fs, baseFilter);
    const weeks = fs.effectiveWeeks();
    const markets = fs.effectiveMarkets();
    const filtered = filterRows(scopedRows, filter);
    const agg = aggregate(filtered, weeks, markets);
    const level = nextDrillLevel(fs);
    const levelLabel = { team: 'Team', error_category: 'Error Category', error_subcategory: 'Subcategory', complaint: 'Complaint', mapped_detail_1: 'Mapped Detail' }[level];
    const groupField = level === 'team' ? 'team' : level;
    const target = blendedTarget(filter.teams && filter.teams.length ? filter.teams : (teamScope || OPERATIONAL_TEAMS), markets, weeks);

    container.appendChild(kpiRowFor(agg));

    // "All" (Agent/Cert + Bulk combined) version of the same filter, used only
    // to keep the chart's group order/colors and Y-axis scale constant while
    // toggling Agent/Cert vs Bulk — per instruction, only that toggle should
    // leave the scale untouched; every other filter still rescales normally.
    const filteredAll = fs.state.sourceType === 'all' ? filtered : filterRows(scopedRows, { ...filter, sourceType: 'all' });
    const matrix = buildWeekGroupMatrix(filtered, groupField, weeks, markets);
    const matrixAll = fs.state.sourceType === 'all' ? matrix : buildWeekGroupMatrix(filteredAll, groupField, weeks, markets);
    const cellOrZero = (m, k, w) => (m[k] && m[k][w]) || { errorCount: 0, compensationTotal: 0, errorPct: 0, compPerBox: 0 };

    const groupKeys = level === 'team' ? orderTeamsGrouped(matrixAll, weeks) : orderGroupsByImpact(matrixAll, weeks);
    const canDrillFurther = DRILL_CHAIN.indexOf(level) < DRILL_CHAIN.length - 1;

    if (!groupKeys.length || !weeks.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    // Each row needs ITS OWN target, not the combined target of every team
    // stacked together — a Warehousing row must be checked against
    // Warehousing's 0.50%, not against all-teams-summed ~5%.
    const rowTargets = {};
    groupKeys.forEach(k => { rowTargets[k] = level === 'team' ? teamTarget(k, markets, weeks) : target; });

    // ---- Chart 1: stacked weekly Error % by group, with legend + total label ----
    const groupErrorPctByWeek = {};
    const remainderByWeek = fs.state.sourceType === 'all' ? null : {};
    groupKeys.forEach(k => {
      groupErrorPctByWeek[k] = {};
      if (remainderByWeek) remainderByWeek[k] = {};
      weeks.forEach(w => {
        const selected = cellOrZero(matrix, k, w).errorPct;
        groupErrorPctByWeek[k][w] = selected;
        if (remainderByWeek) remainderByWeek[k][w] = Math.max(0, cellOrZero(matrixAll, k, w).errorPct - selected);
      });
    });
    const fullTotals = weeks.map(w => groupKeys.reduce((s, k) => s + cellOrZero(matrixAll, k, w).errorPct, 0));
    const fixedMax = Math.max(...fullTotals, 0.01) * 1.18;

    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Weekly Error % by ${levelLabel}`]), el('div', { class: 'card-desc' }, [
          'Stacked by ' + levelLabel.toLowerCase() + ' · shaded band = combined target across the stack · total % labeled above each bar' +
          (remainderByWeek ? ' · dimmed portion = excluded by the Agent/Cert-Bulk toggle, shown for comparison' : ''),
        ])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chartCard);
    renderStackedWeeklyChart(chartCard.querySelector('canvas'), weeks, groupKeys, groupErrorPctByWeek, target, { remainderByWeek, fixedMax });

    const market = commentMarketKey(fs);
    const commentsEnabled = CommentsStore.loaded;
    const breakdownHooks = commentsEnabled ? commentHooksFor('general-team', `Breakdown by ${levelLabel} · ${title}`, market, breakdownMode === 'pct' ? 'pct' : 'count', render) : {};
    const compHooks = commentsEnabled ? commentHooksFor('general-comp', `Compensation per Week · ${title}`, market, 'money', render) : {};

    // ---- Table 1: per week per group (breakdown), colored vs EACH ROW'S OWN target in % mode ----
    const breakdownCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('div', { class: 'card-title' }, [`Breakdown by ${levelLabel} — ${breakdownMode === 'pct' ? 'Error % per Week' : 'Absolute Errors per Week'}`]),
          fs.drillPath.length ? el('div', { class: 'card-path' }, [`Viewing: ${drillPathLabel(fs)}`]) : null,
          el('div', { class: 'card-desc' }, [breakdownMode === 'pct' ? (canDrillFurther ? 'Click a row to drill in · red = above that row\'s own target' : 'Red = above target') : (canDrillFurther ? 'Click a row to drill in · raw error counts, no target formatting' : 'Raw error counts, no target formatting')]),
          el('div', { class: CommentsStore.loadError ? 'card-desc comments-error' : 'card-desc' }, [
            CommentsStore.loadError ? `Comments unavailable: ${CommentsStore.loadError}` : 'Click a value cell to view or add a comment · dot = has comments',
          ]),
        ]),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: breakdownMode === 'pct' ? 'active' : '', onclick: () => { breakdownMode = 'pct'; render(); } }, ['Error %']),
          el('button', { class: breakdownMode === 'absolute' ? 'active' : '', onclick: () => { breakdownMode = 'absolute'; render(); } }, ['Absolute']),
        ]),
      ]),
    ]);
    breakdownCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { const c = cellOrZero(matrix, k, w); acc[w] = breakdownMode === 'pct' ? c.errorPct : c.errorCount; return acc; }, {}) })),
      cellFormatter: (v, w, rowKey) => {
        if (breakdownMode === 'absolute') return { display: fmtInt(v), cls: '' };
        const rt = rowTargets[rowKey];
        return { display: fmtPct(v), cls: (rt === null || rt === undefined) ? '' : (v > rt ? 'cell-pct-bad' : 'cell-pct-good') };
      },
      onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
      commentsFor: breakdownHooks.commentsFor,
      onCellClick: breakdownHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => {
          const totalErrors = groupKeys.reduce((s, k) => s + cellOrZero(matrix, k, w).errorCount, 0);
          const totalPct = groupKeys.reduce((s, k) => s + cellOrZero(matrix, k, w).errorPct, 0);
          acc[w] = breakdownMode === 'pct' ? totalPct : totalErrors;
          return acc;
        }, {}),
        cellFormatter: (v) => breakdownMode === 'absolute' ? { display: fmtInt(v) } : { display: fmtPct(v), cls: (target !== null && target !== undefined && v > target) ? 'cell-pct-bad' : '' },
      },
    }));
    container.appendChild(breakdownCard);

    // ---- Table 2: Compensation per week per group, with Total/Per-Box/Per-Error toggle ----
    const compCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, ['Compensation per Week']), fs.drillPath.length ? el('div', { class: 'card-path' }, [`Viewing: ${drillPathLabel(fs)}`]) : null, el('div', { class: 'card-desc' }, [canDrillFurther ? 'Click a row to drill in' : ''])]),
        (function () {
          return el('div', { class: 'toggle-pill' }, [
            el('button', { class: compensationMode === 'total' ? 'active' : '', onclick: () => { compensationMode = 'total'; render(); } }, ['Total']),
            el('button', { class: compensationMode === 'perbox' ? 'active' : '', onclick: () => { compensationMode = 'perbox'; render(); } }, ['Per Box']),
            el('button', { class: compensationMode === 'pererror' ? 'active' : '', onclick: () => { compensationMode = 'pererror'; render(); } }, ['Per Error']),
          ]);
        })(),
      ]),
    ]);
    function compValueFor(c) {
      if (compensationMode === 'total') return c.compensationTotal;
      if (compensationMode === 'perbox') return c.compPerBox;
      return c.errorCount > 0 ? c.compensationTotal / c.errorCount : 0;
    }
    compCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = compValueFor(cellOrZero(matrix, k, w)); return acc; }, {}) })),
      cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v), cls: '' }),
      onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
      commentsFor: compHooks.commentsFor,
      onCellClick: compHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => {
          const totalComp = groupKeys.reduce((s, k) => s + cellOrZero(matrix, k, w).compensationTotal, 0);
          const totalErrors = groupKeys.reduce((s, k) => s + cellOrZero(matrix, k, w).errorCount, 0);
          const boxes = DataStore.boxCount(markets, [w]);
          acc[w] = compensationMode === 'total' ? totalComp : compensationMode === 'perbox' ? (boxes > 0 ? totalComp / boxes : 0) : (totalErrors > 0 ? totalComp / totalErrors : 0);
          return acc;
        }, {}),
        cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v) }),
      },
    }));
    container.appendChild(compCard);
  }

  render();
}

// ---- Page 1: General Operational Error Rates ---------------------------------

function PageGeneral(container, fs) {
  buildTeamRatesPage(container, fs, {
    title: 'Operational Errors',
    subtitle: 'Operational teams only · weekly review view',
    teamScope: OPERATIONAL_TEAMS,
  });
}

// ---- Page 3: All Errors --------------------------------------------------------

function PageAll(container, fs) {
  buildTeamRatesPage(container, fs, {
    title: 'All Errors',
    subtitle: 'Every team, not only operational teams',
    teamScope: null,
  });
}

// ---- Page 2: Recipe Deep Dive --------------------------------------------------

function PageRecipe(container, fs) {
  const recipeRows = DataStore.rawRows.filter(r =>
    r.error_subcategory.includes('_recipes') || r.error_subcategory.includes('_ingredients')
  );

  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Recipe Deep Dive', 'Which recipes create the biggest operational impact');

    container.appendChild(weekAndCountryRow(fs, render));

    const spec = [
      { key: 'recipe', label: 'Recipe', type: 'multiselect', options: optionsFor(uniqueSorted(recipeRows, 'recipe_title')) },
    ];
    container.appendChild(FilterBar(fs, spec, render));

    const filter = { weeks: fs.state.weeks, markets: fs.state.markets, recipe: fs.state.recipe };
    const filtered = filterRows(recipeRows, filter);
    const weeks = fs.effectiveWeeks(); const markets = fs.effectiveMarkets();
    const agg = aggregate(filtered, weeks, markets);
    container.appendChild(kpiRowFor(agg));

    const teamStats = uniqueSorted(filtered, 'team').map(team => {
      const teamRows = filtered.filter(r => r.team === team);
      return { team, errorCount: teamRows.length, compensationTotal: teamRows.reduce((s, r) => s + r.compensation, 0) };
    });
    if (!teamStats.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No recipe-related errors match the current filters.'])]));
      return;
    }
    // Group Production - X teams together, each bucket ordered by impact (compensation).
    const production = teamStats.filter(t => t.team.startsWith('Production -')).sort((a, b) => b.compensationTotal - a.compensationTotal);
    const others = teamStats.filter(t => !t.team.startsWith('Production -')).sort((a, b) => b.compensationTotal - a.compensationTotal);
    const orderedTeamStats = [...production, ...others];
    const teams = orderedTeamStats.map(t => t.team);

    container.appendChild(el('div', { class: 'compact-stat-row' }, orderedTeamStats.map((t, i) =>
      el('div', { class: 'compact-stat', style: `--accent-color:${colorForIndex(i)};` }, [
        el('div', { class: 'compact-stat-label' }, [t.team]),
        el('div', { class: 'compact-stat-value' }, [`${fmtInt(t.errorCount)} errors`]),
        el('div', { class: 'compact-stat-sub' }, [fmtEur(t.compensationTotal)]),
      ])
    )));

    teams.forEach(team => {
      const teamRows = filtered.filter(r => r.team === team);
      const teamErrorCount = teamRows.length;
      const teamCompTotal = teamRows.reduce((s, r) => s + r.compensation, 0);
      const rows = teamRows.map(r => ({
        recipe: r.recipe_title || '(none)', complaint: r.complaint, mapped_detail_1: r.mapped_detail_1,
        errorCount: 1, compensationTotal: r.compensation,
      }));
      // Group by recipe+complaint+mapped_detail_1
      const map = new Map();
      rows.forEach(r => {
        const key = [r.recipe, r.complaint, r.mapped_detail_1].join(' | ');
        if (!map.has(key)) map.set(key, { recipe: r.recipe, complaint: r.complaint, mapped_detail_1: r.mapped_detail_1, errorCount: 0, compensationTotal: 0 });
        const g = map.get(key); g.errorCount++; g.compensationTotal += r.compensationTotal;
      });
      const grouped = Array.from(map.values()).map(g => ({ ...g, errorPct: agg.boxes > 0 ? (g.errorCount / agg.boxes) * 100 : 0 }))
        .sort((a, b) => b.compensationTotal - a.compensationTotal);

      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', { class: 'card-title' }, [`${team}  |  ${fmtInt(teamErrorCount)} errors  |  ${fmtEur(teamCompTotal)} compensation`]),
        ]),
      ]);
      card.appendChild(DataTable({
        columns: [
          { key: 'recipe', label: 'Recipe' },
          { key: 'complaint', label: 'Complaint' },
          { key: 'mapped_detail_1', label: 'Mapped Detail' },
          { key: 'errorCount', label: 'Errors', numeric: true, int: true },
          { key: 'errorPct', label: 'Error %', numeric: true, pct: true },
          { key: 'compensationTotal', label: 'Compensation', numeric: true, money: true },
        ],
        rows: grouped,
      }));
      container.appendChild(card);
    });
  }
  render();
}

function PageCategoryDrill(container, fs) {
  const allRows = DataStore.rawRows;
  let breakdownMode = 'pct'; // 'pct' | 'absolute'
  let compensationMode = 'total'; // 'total' | 'perbox' | 'pererror'

  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Error Category Drill Down', 'Click through category → subcategory → complaint → mapped detail');

    container.appendChild(weekAndCountryRow(fs, render));

    const spec = [
      { key: 'teams', label: 'Team', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'team')) },
    ];
    container.appendChild(FilterBar(fs, spec, render));

    const filter = { weeks: fs.state.weeks, markets: fs.state.markets, teams: fs.state.teams };
    const filtered = filterRows(allRows, filter);
    const weeks = fs.effectiveWeeks(); const markets = fs.effectiveMarkets();
    const agg = aggregate(filtered, weeks, markets);
    container.appendChild(kpiRowFor(agg));

    if (!weeks.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    const level = CATEGORY_DRILL_CHAIN[Math.min(fs.drillPath.length, CATEGORY_DRILL_CHAIN.length - 1)];
    const levelLabel = { error_category: 'Error Category', error_subcategory: 'Subcategory', complaint: 'Complaint', mapped_detail_1: 'Mapped Detail' }[level];
    const canDrillFurther = CATEGORY_DRILL_CHAIN.indexOf(level) < CATEGORY_DRILL_CHAIN.length - 1;

    const drillFilteredRows = applyGenericDrillFilter(filtered, fs.drillPath);
    const rowsForLevel = withBlankGroupLabel(drillFilteredRows, level);
    const matrix = buildWeekGroupMatrix(rowsForLevel, level, weeks, markets);
    const groupKeys = orderGroupsByImpact(matrix, weeks);

    renderFloatingBreadcrumb('All Categories', fs, render);

    const market = commentMarketKey(fs);
    const commentsEnabled = CommentsStore.loaded;
    const catBreakdownHooks = commentsEnabled ? commentHooksFor('category-drill', `${levelLabel} · Error Category Drill Down`, market, breakdownMode === 'pct' ? 'pct' : 'count', render) : {};
    const catCompHooks = commentsEnabled ? commentHooksFor('category-drill-comp', `${levelLabel} · Compensation`, market, 'money', render) : {};
    const catMarketHooks = commentsEnabled ? commentHooksFor('category-drill-market', `Market Comparison · ${drillPathLabel(fs) || 'All Categories'}`, 'FA-EU', 'pct', render) : {};

    if (!groupKeys.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    const groupErrorPctByWeek = {};
    groupKeys.forEach(k => { groupErrorPctByWeek[k] = {}; weeks.forEach(w => { groupErrorPctByWeek[k][w] = matrix[k][w].errorPct; }); });

    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Weekly Error % by ${levelLabel}`]), el('div', { class: 'card-desc' }, ['Click a row in the table below to drill in'])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chartCard);
    renderStackedWeeklyChart(chartCard.querySelector('canvas'), weeks, groupKeys, groupErrorPctByWeek, undefined);

    const breakdownCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('div', { class: 'card-title' }, [`${breakdownMode === 'pct' ? 'Error % per Week' : 'Absolute Errors per Week'} by ${levelLabel}`]),
          fs.drillPath.length ? el('div', { class: 'card-path' }, [`Viewing: ${drillPathLabel(fs)}`]) : null,
          el('div', { class: 'card-desc' }, [canDrillFurther ? 'Click a row to drill in' : '']),
        ]),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: breakdownMode === 'pct' ? 'active' : '', onclick: () => { breakdownMode = 'pct'; render(); } }, ['Error %']),
          el('button', { class: breakdownMode === 'absolute' ? 'active' : '', onclick: () => { breakdownMode = 'absolute'; render(); } }, ['Absolute']),
        ]),
      ]),
    ]);
    breakdownCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = breakdownMode === 'pct' ? matrix[k][w].errorPct : matrix[k][w].errorCount; return acc; }, {}) })),
      cellFormatter: (v) => breakdownMode === 'pct' ? { display: fmtPct(v), cls: '' } : { display: fmtInt(v), cls: '' },
      onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
      commentsFor: catBreakdownHooks.commentsFor,
      onCellClick: catBreakdownHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => {
          acc[w] = groupKeys.reduce((s, k) => s + (breakdownMode === 'pct' ? matrix[k][w].errorPct : matrix[k][w].errorCount), 0);
          return acc;
        }, {}),
        cellFormatter: (v) => breakdownMode === 'pct' ? { display: fmtPct(v) } : { display: fmtInt(v) },
      },
    }));
    container.appendChild(breakdownCard);

    const compCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Compensation per Week by ${levelLabel}`]), fs.drillPath.length ? el('div', { class: 'card-path' }, [`Viewing: ${drillPathLabel(fs)}`]) : null]),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: compensationMode === 'total' ? 'active' : '', onclick: () => { compensationMode = 'total'; render(); } }, ['Total']),
          el('button', { class: compensationMode === 'perbox' ? 'active' : '', onclick: () => { compensationMode = 'perbox'; render(); } }, ['Per Box']),
          el('button', { class: compensationMode === 'pererror' ? 'active' : '', onclick: () => { compensationMode = 'pererror'; render(); } }, ['Per Error']),
        ]),
      ]),
    ]);
    function catCompValueFor(c) {
      if (compensationMode === 'total') return c.compensationTotal;
      if (compensationMode === 'perbox') return c.compPerBox;
      return c.errorCount > 0 ? c.compensationTotal / c.errorCount : 0;
    }
    compCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = catCompValueFor(matrix[k][w]); return acc; }, {}) })),
      cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v), cls: '' }),
      onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
      commentsFor: catCompHooks.commentsFor,
      onCellClick: catCompHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => {
          const totalComp = groupKeys.reduce((s, k) => s + matrix[k][w].compensationTotal, 0);
          const totalErrors = groupKeys.reduce((s, k) => s + matrix[k][w].errorCount, 0);
          const boxes = DataStore.boxCount(markets, [w]);
          acc[w] = compensationMode === 'total' ? totalComp : compensationMode === 'perbox' ? (boxes > 0 ? totalComp / boxes : 0) : (totalErrors > 0 ? totalComp / totalErrors : 0);
          return acc;
        }, {}),
        cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v) }),
      },
    }));
    container.appendChild(compCard);

    // ---- Market comparison table, once drilled at least one level ----
    // Ignores the country filter deliberately — the whole point is to see
    // every market side by side once you've narrowed down to a specific
    // category (e.g. account_management).
    if (fs.drillPath.length >= 1) {
      const marketMatrix = buildMarketComparisonMatrix(drillFilteredRows, weeks);
      const marketRows = ALL_MARKETS.map(m => ({ key: m.replace('FA-', ''), cells: weeks.reduce((acc, w) => { acc[w] = marketMatrix[m][w].errorPct; return acc; }, {}) }));
      const marketCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [el('div', { class: 'card-title' }, ['Market Comparison']), el('div', { class: 'card-path' }, [`Viewing: ${drillPathLabel(fs)}`]), el('div', { class: 'card-desc' }, ['Error % per market, ignoring the country filter above — for comparing markets directly'])]),
        ]),
      ]);
      marketCard.appendChild(PivotTable({
        rowLabel: 'Market',
        weeks,
        rows: marketRows,
        cellFormatter: (v) => ({ display: fmtPct(v), cls: '' }),
        commentsFor: catMarketHooks.commentsFor,
        onCellClick: catMarketHooks.onCellClick,
      }));
      container.appendChild(marketCard);
    }

    // Granular reference table: subcategory / complaint / mapped_detail_1 combos
    if (fs.drillPath.length < 1) return;

    const map = new Map();
    drillFilteredRows.forEach(r => {
      const key = [r.error_subcategory, r.complaint, r.mapped_detail_1].join(' | ');
      if (!map.has(key)) map.set(key, { error_subcategory: r.error_subcategory, complaint: r.complaint, mapped_detail_1: r.mapped_detail_1, errorCount: 0, compensationTotal: 0 });
      const g = map.get(key); g.errorCount++; g.compensationTotal += r.compensation;
    });
    const grouped = Array.from(map.values()).map(g => ({ ...g, errorPct: agg.boxes > 0 ? (g.errorCount / agg.boxes) * 100 : 0 })).sort((a, b) => b.compensationTotal - a.compensationTotal);

    const tableCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('div', { class: 'card-title' }, ['Subcategory · Complaint · Mapped Detail']), el('div', { class: 'card-desc' }, ['Reference detail, accumulated across the selected weeks'])]),
    ]);
    tableCard.appendChild(DataTable({
      columns: [
        { key: 'error_subcategory', label: 'Subcategory' },
        { key: 'complaint', label: 'Complaint' },
        { key: 'mapped_detail_1', label: 'Mapped Detail' },
        { key: 'errorCount', label: 'Errors', numeric: true, int: true },
        { key: 'errorPct', label: 'Error %', numeric: true, pct: true },
        { key: 'compensationTotal', label: 'Compensation', numeric: true, money: true },
      ],
      rows: grouped,
    }));
    container.appendChild(tableCard);
  }
  render();
}

// ---- Page: Logistics ------------------------------------------------------------

function PageLogistics(container, fs) {
  const allRows = DataStore.logisticsRows;
  let compensationMode = 'total'; // 'total' | 'perbox' | 'pererror'
  let statusMode = 'pct'; // 'pct' | 'absolute'
  let issueMode = 'pct'; // 'pct' | 'absolute' — shared by the issue-type chart and main subcategory table
  let carrierBreakdownMode = 'pct'; // 'pct' | 'absolute' | 'costperbox' — the per-carrier breakdown cards
  let subcategoryView = 'normal'; // 'normal' | 'carrier' — only used at the top subcategory level

  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Logistics', 'Delivery and courier errors — same targets and business logic as the rest of the dashboard');

    if (!allRows.length) {
      container.appendChild(el('div', { class: 'config-banner' }, [
        el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['Logistics data not connected']),
        'This page reads from a third CSV feed. Make sure CONFIG.LOGISTICS_CSV_URL is set at the top of index.html and points to the published Logistics tab.',
      ]));
      return;
    }

    container.appendChild(weekAndCountryRow(fs, render));

    const spec = [
      { key: 'markets', label: 'Country', type: 'multiselect', exclusiveValue: 'FA-EU', options: optionsFor(MARKET_FILTER_OPTIONS) },
      { key: 'errorSubcategory', label: 'Subcategory', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'error_subcategory')) },
      { key: 'complaint', label: 'Complaint', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'complaint')) },
      { key: 'carrier', label: 'Carrier', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'carrier')) },
      { key: 'sourceType', label: '', type: 'toggle3', options: [
        { value: 'all', label: 'All' }, { value: 'agent', label: 'Agent/Cert' }, { value: 'bulk', label: 'Bulk' },
      ] },
    ];
    container.appendChild(FilterBar(fs, spec, render));

    const filter = { weeks: fs.state.weeks, markets: fs.state.markets, errorSubcategory: fs.state.errorSubcategory, complaint: fs.state.complaint, carrier: fs.state.carrier, sourceType: fs.state.sourceType };
    const filtered = filterRows(allRows, filter);
    const weeks = fs.effectiveWeeks();
    const markets = fs.effectiveMarkets();
    const agg = aggregate(filtered, weeks, markets);
    const target = logisticsTarget(markets, weeks);

    // Each carrier's errorPct uses its own market box count as denominator —
    // PostNord (SE+DK) divided by SE+DK boxes, not all-EU boxes.
    const carrierMarketMap = buildCarrierMarketMap(DataStore.logisticsRows, markets);
    const carrierGetBoxes = (carrier, w) => DataStore.boxCount(carrierMarketMap[carrier] || markets, [w]);

    container.appendChild(kpiRowFor(agg));

    if (!weeks.length || !filtered.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    // ---- Sections 1 & 2: drillable subcategory → complaint → detail breakdown ----
    // Starts broad (just subcategories) and expands on click — a flat 3-level
    // table gets unreadable once there are more than a handful of combinations.
    const level = LOGISTICS_DRILL_CHAIN[Math.min(fs.drillPath.length, LOGISTICS_DRILL_CHAIN.length - 1)];
    const levelLabel = { error_subcategory: 'Subcategory', complaint: 'Complaint', mapped_detail_1: 'Detail' }[level];
    const canDrillFurther = LOGISTICS_DRILL_CHAIN.indexOf(level) < LOGISTICS_DRILL_CHAIN.length - 1;

    const drillFilteredRows = applyGenericDrillFilter(filtered, fs.drillPath);
    const rowsForLevel = withBlankGroupLabel(drillFilteredRows, level);
    const issueMatrix = buildWeekGroupMatrix(rowsForLevel, level, weeks, markets);
    const issueKeys = orderGroupsByImpact(issueMatrix, weeks);

    renderFloatingBreadcrumb('All Subcategories', fs, render);
    const market = commentMarketKey(fs);
    const commentsEnabled = CommentsStore.loaded;
    const issueHooks = commentsEnabled ? commentHooksFor('logistics-issue', `${levelLabel} · Logistics`, market, issueMode === 'pct' ? 'pct' : 'count', render) : {};
    const carrierBreakdownHooksFor = (carrier) => commentsEnabled ? commentHooksFor('logistics-carrier', `${carrier} · ${levelLabel} · Logistics`, market, issueMode === 'pct' ? 'pct' : 'count', render) : {};
    const carrierLineHooks = commentsEnabled ? { commentsFor: (carrier, w) => CommentsStore.getFor('logistics-carrier-line', carrier, market, w) } : {};
    const compLogisticsHooks = commentsEnabled ? commentHooksFor('logistics-compensation', 'Compensation per Carrier · Logistics', market, 'money', render) : {};

    container.appendChild(el('div', { style: 'display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:10px;' }, [
      el('div', { class: 'toggle-pill' }, [
        el('button', { class: issueMode === 'pct' ? 'active' : '', onclick: () => { issueMode = 'pct'; render(); } }, ['Error %']),
        el('button', { class: issueMode === 'absolute' ? 'active' : '', onclick: () => { issueMode = 'absolute'; render(); } }, ['Absolute']),
      ]),
    ]));

    const issuePctByWeek = {};
    issueKeys.forEach(k => { issuePctByWeek[k] = {}; weeks.forEach(w => { issuePctByWeek[k][w] = issueMode === 'pct' ? issueMatrix[k][w].errorPct : issueMatrix[k][w].errorCount; }); });

    const chart1Card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Weekly ${issueMode === 'pct' ? 'Error %' : 'Absolute Errors'} by ${levelLabel}`]), el('div', { class: 'card-desc' }, [issueMode === 'pct' ? 'Shaded band = Last Mile target · click a row in the table below to drill in' : 'Raw error counts · click a row in the table below to drill in'])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chart1Card);
    renderStackedWeeklyChart(chart1Card.querySelector('canvas'), weeks, issueKeys, issuePctByWeek, target, { mode: issueMode });

    // ---- Section 2: table by current drill level, with Totals row ----
    // At the top subcategory level, an extra "Carrier View" mode nests each
    // carrier's contribution underneath its subcategory bucket.
    const showSubcategoryViewToggle = level === 'error_subcategory';
    const inCarrierView = showSubcategoryViewToggle && subcategoryView === 'carrier';

    let table1Rows;
    if (inCarrierView) {
      table1Rows = [];
      issueKeys.forEach(subKey => {
        table1Rows.push({
          key: subKey, bold: true,
          cells: weeks.reduce((acc, w) => { acc[w] = issueMode === 'pct' ? issueMatrix[subKey][w].errorPct : issueMatrix[subKey][w].errorCount; return acc; }, {}),
        });
        const subRows = rowsForLevel.filter(r => r.error_subcategory === subKey);
        const carrierSubMatrix = buildWeekGroupMatrix(subRows, 'carrier', weeks, markets, { getBoxes: carrierGetBoxes });
        const carrierSubKeys = orderGroupsByImpact(carrierSubMatrix, weeks);
        carrierSubKeys.forEach(ck => {
          table1Rows.push({
            key: ck, indent: true,
            cells: weeks.reduce((acc, w) => { acc[w] = issueMode === 'pct' ? carrierSubMatrix[ck][w].errorPct : carrierSubMatrix[ck][w].errorCount; return acc; }, {}),
          });
        });
      });
    } else {
      table1Rows = issueKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = issueMode === 'pct' ? issueMatrix[k][w].errorPct : issueMatrix[k][w].errorCount; return acc; }, {}) }));
    }

    const table1Card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('div', { class: 'card-title' }, [`${issueMode === 'pct' ? 'Error %' : 'Absolute Errors'} per Week by ${levelLabel}`]),
          el('div', { class: 'card-desc' }, [inCarrierView ? 'Each subcategory bucket broken into its carriers · red = above the Last Mile target' : (issueMode === 'pct' ? (canDrillFurther ? 'Click a row to drill in · red = above the Last Mile target' : 'Red = above the Last Mile target') : (canDrillFurther ? 'Click a row to drill in · raw counts, no target formatting' : 'Raw counts, no target formatting'))]),
        ]),
        showSubcategoryViewToggle ? el('div', { class: 'toggle-pill' }, [
          el('button', { class: subcategoryView === 'normal' ? 'active' : '', onclick: () => { subcategoryView = 'normal'; render(); } }, ['Normal']),
          el('button', { class: subcategoryView === 'carrier' ? 'active' : '', onclick: () => { subcategoryView = 'carrier'; render(); } }, ['Carrier View']),
        ]) : null,
      ]),
    ]);
    table1Card.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: table1Rows,
      cellFormatter: (v) => issueMode === 'absolute' ? { display: fmtInt(v), cls: '' } : { display: fmtPct(v), cls: (target !== null && target !== undefined && v > target) ? 'cell-pct-bad' : 'cell-pct-good' },
      onRowClick: (!inCarrierView && canDrillFurther) ? (key) => { fs.pushDrill(level, key); render(); } : null,
      commentsFor: issueHooks.commentsFor,
      onCellClick: issueHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => { acc[w] = issueKeys.reduce((s, k) => s + (issueMode === 'pct' ? issueMatrix[k][w].errorPct : issueMatrix[k][w].errorCount), 0); return acc; }, {}),
        cellFormatter: (v) => issueMode === 'absolute' ? { display: fmtInt(v) } : { display: fmtPct(v), cls: (target !== null && target !== undefined && v > target) ? 'cell-pct-bad' : '' },
      },
    }));
    container.appendChild(table1Card);

    // ---- Section 3: Error % per carrier per week (line chart) ----
    const carrierMatrix = buildWeekGroupMatrix(filtered, 'carrier', weeks, markets, { getBoxes: carrierGetBoxes });
    const carrierKeys = orderGroupsByImpact(carrierMatrix, weeks);
    const carrierSeries = carrierKeys.map(k => ({ label: k, dataByWeek: Object.fromEntries(weeks.map(w => [w, carrierMatrix[k][w].errorPct])) }));

    const chart2Card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, ['Error % per Carrier per Week']), el('div', { class: 'card-desc' }, ['One line per carrier · shaded band = Last Mile target · rows with no carrier assigned are excluded from this and the per-carrier sections below, but still count in the KPIs above'])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chart2Card);
    renderMultiLineChart(chart2Card.querySelector('canvas'), weeks, carrierSeries, {
      targetPct: target,
      commentsFor: carrierLineHooks.commentsFor,
      onPointClick: commentsEnabled ? (carrier, w, value) => {
        showCommentModal({ scope: 'logistics-carrier-line', scopeLabel: 'Error % per Carrier per Week · Logistics', entity: carrier, market, week: w, value, valueType: 'pct', onSaved: render });
      } : undefined,
    });

    // ---- Section 4: per-carrier breakdown cards, separate mode toggle ----
    const carrierGroup = el('div', { class: 'carrier-group' }, [
      el('div', { style: 'display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:4px;' }, [
        el('div', { class: 'carrier-group-title', style: 'margin-bottom:0;' }, [`${levelLabel} Breakdown per Carrier`]),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: carrierBreakdownMode === 'pct' ? 'active' : '', onclick: () => { carrierBreakdownMode = 'pct'; render(); } }, ['Error %']),
          el('button', { class: carrierBreakdownMode === 'absolute' ? 'active' : '', onclick: () => { carrierBreakdownMode = 'absolute'; render(); } }, ['Absolute']),
          el('button', { class: carrierBreakdownMode === 'costperbox' ? 'active' : '', onclick: () => { carrierBreakdownMode = 'costperbox'; render(); } }, ['Cost/Box']),
        ]),
      ]),
    ]);
    carrierKeys.forEach(carrier => {
      const carrierAllRows = filtered.filter(r => r.carrier === carrier);
      const carrierDrillRows = withBlankGroupLabel(applyGenericDrillFilter(carrierAllRows, fs.drillPath), level);
      // Use this carrier's own market boxes as denominator for the subcategory breakdown.
      const cGetBoxes = (groupKey, w) => DataStore.boxCount(carrierMarketMap[carrier] || markets, [w]);
      const cMatrix = buildWeekGroupMatrix(carrierDrillRows, level, weeks, markets, { getBoxes: cGetBoxes });
      const cKeys = orderGroupsByImpact(cMatrix, weeks);
      const carrierErrorCount = carrierAllRows.length;
      const carrierComp = carrierAllRows.reduce((s, r) => s + r.compensation, 0);

      const card = el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', { class: 'card-title' }, [`${carrier}  |  ${fmtInt(carrierErrorCount)} errors  |  ${fmtEur(carrierComp)} compensation`]),
        ]),
      ]);
      const cHooks = carrierBreakdownHooksFor(carrier);
      card.appendChild(PivotTable({
        rowLabel: levelLabel,
        weeks,
        rows: cKeys.map(k => ({
          key: k,
          cells: weeks.reduce((acc, w) => {
            const c = cMatrix[k][w];
            acc[w] = carrierBreakdownMode === 'absolute' ? c.errorCount : carrierBreakdownMode === 'costperbox' ? c.compPerBox : c.errorPct;
            return acc;
          }, {}),
        })),
        cellFormatter: (v) => {
          if (carrierBreakdownMode === 'absolute') return { display: fmtInt(v), cls: '' };
          if (carrierBreakdownMode === 'costperbox') return { display: fmtEurPrecise(v), cls: '' };
          return { display: fmtPct(v), cls: '' };
        },
        onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
        commentsFor: cHooks.commentsFor,
        onCellClick: cHooks.onCellClick,
        totalsRow: {
          cells: weeks.reduce((acc, w) => {
            if (carrierBreakdownMode === 'costperbox') {
              const totalComp = cKeys.reduce((s, k) => s + cMatrix[k][w].compensationTotal, 0);
              const carrierBoxes = DataStore.boxCount(carrierMarketMap[carrier] || markets, [w]);
              acc[w] = carrierBoxes > 0 ? totalComp / carrierBoxes : 0;
            } else if (carrierBreakdownMode === 'absolute') {
              acc[w] = cKeys.reduce((s, k) => s + cMatrix[k][w].errorCount, 0);
            } else {
              acc[w] = cKeys.reduce((s, k) => s + cMatrix[k][w].errorPct, 0);
            }
            return acc;
          }, {}),
          cellFormatter: (v) => {
            if (carrierBreakdownMode === 'absolute') return { display: fmtInt(v) };
            if (carrierBreakdownMode === 'costperbox') return { display: fmtEurPrecise(v) };
            return { display: fmtPct(v) };
          },
        },
      }));
      carrierGroup.appendChild(card);
    });
    container.appendChild(carrierGroup);

    // ---- Section 5: delivery status composition chart, Percentage/Absolute toggle ----
    const statusMatrix = buildWeekGroupMatrix(filtered, 'delivery_status', weeks, markets);
    const statusKeys = orderGroupsByImpact(statusMatrix, weeks);
    const statusTotalsByWeek = {};
    weeks.forEach(w => { statusTotalsByWeek[w] = statusKeys.reduce((s, k) => s + statusMatrix[k][w].errorCount, 0); });
    const statusValueByWeek = {};
    statusKeys.forEach(k => {
      statusValueByWeek[k] = {};
      weeks.forEach(w => {
        const count = statusMatrix[k][w].errorCount;
        statusValueByWeek[k][w] = statusMode === 'pct' ? (statusTotalsByWeek[w] > 0 ? (count / statusTotalsByWeek[w]) * 100 : 0) : count;
      });
    });

    const chart3Card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, ['Delivery Status by Week']), el('div', { class: 'card-desc' }, [statusMode === 'pct' ? '% share of that week\'s logistics errors' : 'Raw error counts'])]),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: statusMode === 'pct' ? 'active' : '', onclick: () => { statusMode = 'pct'; render(); } }, ['Percentage']),
          el('button', { class: statusMode === 'absolute' ? 'active' : '', onclick: () => { statusMode = 'absolute'; render(); } }, ['Absolute']),
        ]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chart3Card);
    renderCompositionChart(chart3Card.querySelector('canvas'), weeks, statusKeys, statusValueByWeek, statusMode);

    // ---- Section 6: compensation per week per carrier, Total/Per-Box/Per-Error toggle ----
    const compCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', { class: 'card-title' }, ['Compensation per Week per Carrier']),
        el('div', { class: 'toggle-pill' }, [
          el('button', { class: compensationMode === 'total' ? 'active' : '', onclick: () => { compensationMode = 'total'; render(); } }, ['Total']),
          el('button', { class: compensationMode === 'perbox' ? 'active' : '', onclick: () => { compensationMode = 'perbox'; render(); } }, ['Per Box']),
          el('button', { class: compensationMode === 'pererror' ? 'active' : '', onclick: () => { compensationMode = 'pererror'; render(); } }, ['Per Error']),
        ]),
      ]),
    ]);
    function compValueFor(c) {
      if (compensationMode === 'total') return c.compensationTotal;
      if (compensationMode === 'perbox') return c.compPerBox;
      return c.errorCount > 0 ? c.compensationTotal / c.errorCount : 0;
    }
    compCard.appendChild(PivotTable({
      rowLabel: 'Carrier',
      weeks,
      rows: carrierKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = compValueFor(carrierMatrix[k][w]); return acc; }, {}) })),
      cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v), cls: '' }),
      commentsFor: compLogisticsHooks.commentsFor,
      onCellClick: compLogisticsHooks.onCellClick,
      totalsRow: {
        cells: weeks.reduce((acc, w) => {
          const totalComp = carrierKeys.reduce((s, k) => s + carrierMatrix[k][w].compensationTotal, 0);
          const totalErrors = carrierKeys.reduce((s, k) => s + carrierMatrix[k][w].errorCount, 0);
          const boxes = DataStore.boxCount(markets, [w]);
          acc[w] = compensationMode === 'total' ? totalComp : compensationMode === 'perbox' ? (boxes > 0 ? totalComp / boxes : 0) : (totalErrors > 0 ? totalComp / totalErrors : 0);
          return acc;
        }, {}),
        cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v) }),
      },
    }));
    container.appendChild(compCard);
  }
  render();
}

// ---- Page: Comments overview -----------------------------------------------------

function PageComments(container, fs) {
  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Comments', 'Every comment across the dashboard, oldest week first');

    if (!CommentsStore.loaded) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [
        el('div', { class: 'icon' }, ['—']),
        CommentsStore.loadError ? `Comments unavailable: ${CommentsStore.loadError}` : 'Loading comments…',
      ])]));
      return;
    }

    if (!CommentsStore.comments.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [
        el('div', { class: 'icon' }, ['—']),
        'No comments yet. Click any value cell (or a point on the carrier line chart) in the other tabs to add one.',
      ])]));
      return;
    }

    const sorted = [...CommentsStore.comments].sort((a, b) => weekSortKey(a.week) - weekSortKey(b.week) || new Date(a.createdAt) - new Date(b.createdAt));
    const rows = sorted.map(c => ({
      ...c,
      marketDisplay: c.market.replace('FA-', ''),
      valueDisplay: fmtCommentValue(c.value, c.valueType),
      whenDisplay: new Date(c.createdAt).toLocaleString(),
    }));

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`All Comments (${rows.length})`]), el('div', { class: 'card-desc' }, ['Sorted by week, oldest to newest · click a column header to re-sort'])]),
      ]),
    ]);
    card.appendChild(DataTable({
      columns: [
        { key: 'week', label: 'Week' },
        { key: 'scopeLabel', label: 'Where' },
        { key: 'entity', label: 'Entity' },
        { key: 'marketDisplay', label: 'Market' },
        { key: 'valueDisplay', label: 'Value', numeric: true },
        { key: 'text', label: 'Comment' },
        { key: 'author', label: 'Author' },
        { key: 'whenDisplay', label: 'When' },
      ],
      rows,
    }));
    container.appendChild(card);
  }
  render();
}
