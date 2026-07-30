/* ============================================================
   PAGES
   Each page is a function(container, fs) that renders itself.
   Shared helpers below avoid duplicating the "team breakdown"
   and "drill-down" logic across pages.
   ============================================================ */

function uniqueSorted(rows, field) {
  return Array.from(new Set(rows.map(r => r[field]).filter(Boolean))).sort();
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

    container.appendChild(Breadcrumb(title, fs, render));
    container.appendChild(WeekRangePicker(fs, render));
    container.appendChild(MarketPillRow(fs, render));

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

    // ---- Table 1: per week per group (breakdown), colored vs EACH ROW'S OWN target in % mode ----
    const breakdownCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('div', { class: 'card-title' }, [`Breakdown by ${levelLabel} — ${breakdownMode === 'pct' ? 'Error % per Week' : 'Absolute Errors per Week'}`]),
          el('div', { class: 'card-desc' }, [breakdownMode === 'pct' ? (canDrillFurther ? 'Click a row to drill in · red = above that row\'s own target' : 'Red = above target') : (canDrillFurther ? 'Click a row to drill in · raw error counts, no target formatting' : 'Raw error counts, no target formatting')]),
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
    }));
    container.appendChild(breakdownCard);

    // ---- Table 2: Compensation per week per group, with Total/Per-Box toggle ----
    const compCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, ['Compensation per Week']), el('div', { class: 'card-desc' }, [canDrillFurther ? 'Click a row to drill in' : ''])]),
        (function () {
          return el('div', { class: 'toggle-pill' }, [
            el('button', { class: compensationMode === 'total' ? 'active' : '', onclick: () => { compensationMode = 'total'; render(); } }, ['Total']),
            el('button', { class: compensationMode === 'perbox' ? 'active' : '', onclick: () => { compensationMode = 'perbox'; render(); } }, ['Per Box']),
          ]);
        })(),
      ]),
    ]);
    compCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { const c = cellOrZero(matrix, k, w); acc[w] = compensationMode === 'total' ? c.compensationTotal : c.compPerBox; return acc; }, {}) })),
      cellFormatter: (v) => ({ display: compensationMode === 'total' ? fmtEur(v) : fmtEurPrecise(v), cls: '' }),
      onRowClick: canDrillFurther ? (key) => { fs.pushDrill(level, key); render(); } : null,
    }));
    container.appendChild(compCard);
  }

  render();
}

// ---- Page 1: General Operational Error Rates ---------------------------------

function PageGeneral(container, fs) {
  buildTeamRatesPage(container, fs, {
    title: 'General Operational Error Rates',
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

    container.appendChild(WeekRangePicker(fs, render));
    container.appendChild(MarketPillRow(fs, render));

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

// ---- Diagnostic: Data Check ----------------------------------------------------
// Shows exactly what box-count denominator the app is using per week, straight
// from GrowthModel, next to the raw error count from the EU sheet for that
// week — so a collapsed/missing box count for a given week is immediately
// visible instead of hiding inside a % calculation.

function PageDataCheck(container, fs) {
  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Data Check', 'Raw box counts and error counts per week — for spotting bad denominators');

    const weeks = DataStore.weeks;
    const allRows = DataStore.rawRows;

    if (DataStore.growthModelColumnMap) {
      const { weekKey, resolvedCols, totalKey, allHeaders } = DataStore.growthModelColumnMap;
      const missing = Object.entries(resolvedCols).filter(([, v]) => !v).map(([k]) => k);
      container.appendChild(el('div', { class: missing.length ? 'error-banner' : 'config-banner' }, [
        el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['GrowthModel column mapping']),
        el('div', { style: 'margin-bottom:8px;' }, [`Every column header actually found in your GrowthModel CSV: ${allHeaders.map(h => `"${h}"`).join(', ')}`]),
        `Week column read from "${weekKey}". `,
        Object.entries(resolvedCols).map(([fa, col]) => `${fa} ← ${col ? `"${col}"` : 'NOT FOUND'}`).join('  ·  '),
        `  ·  Total ← ${totalKey ? `"${totalKey}"` : '(summed from the 5 market columns above)'}`,
        missing.length ? ` — ${missing.join(', ')} could not be matched to any column above, so that market's box count is reading as 0.` : '',
      ]));
    }

    // Hard invariant check: a single market's box count can never legitimately
    // exceed the combined total. If it does, or if the 5 markets don't sum to
    // the total column, the column mapping above is wrong — this makes that
    // undeniable instead of inferred from a percentage looking "off".
    const mismatchRows = weeks.map(w => {
      const gm = DataStore.growthModel[w];
      if (!gm) return null;
      const sumOfFive = gm['FA-NL'] + gm['FA-BE'] + gm['FA-SE'] + gm['FA-DK'] + gm['FA-DE'];
      return { week: w, sumOfFive, total: gm['FA-EU'], mismatch: Math.abs(sumOfFive - gm['FA-EU']) > 1 };
    }).filter(Boolean);
    const anyMismatch = mismatchRows.some(r => r.mismatch);
    if (anyMismatch) {
      container.appendChild(el('div', { class: 'error-banner' }, [
        el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['NL+BE+SE+DK+DE does not equal the Total column']),
        'This means the column mapping above is picking up the wrong column(s) for at least one market. Weeks affected: ' +
        mismatchRows.filter(r => r.mismatch).map(r => `${r.week} (sum=${fmtInt(r.sumOfFive)} vs total=${fmtInt(r.total)})`).join(', '),
      ]));
    }

    const rows = weeks.map(w => {
      const gm = DataStore.growthModel[w];
      const wErrors = allRows.filter(r => r.week === w).length;
      const wComp = allRows.filter(r => r.week === w).reduce((s, r) => s + r.compensation, 0);
      return {
        week: w,
        hasGrowthModelRow: !!gm,
        nl: gm ? gm['FA-NL'] : 0, be: gm ? gm['FA-BE'] : 0, se: gm ? gm['FA-SE'] : 0,
        dk: gm ? gm['FA-DK'] : 0, de: gm ? gm['FA-DE'] : 0, total: gm ? gm['FA-EU'] : 0,
        errors: wErrors, compensation: wComp,
        errorPct: gm && gm['FA-EU'] > 0 ? (wErrors / gm['FA-EU']) * 100 : null,
      };
    });

    // Flag weeks whose box total looks suspiciously low relative to the
    // typical week, since that's the failure mode that produces inflated %s.
    const totals = rows.map(r => r.total).filter(t => t > 0).sort((a, b) => a - b);
    const median = totals.length ? totals[Math.floor(totals.length / 2)] : 0;

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, ['Per-Week Data Trace']), el('div', { class: 'card-desc' }, [`Median weekly box total across all markets: ${fmtInt(median)} · rows shaded red are under 20% of that median, or missing from GrowthModel entirely`])]),
      ]),
    ]);

    const headers = ['Week', 'Found in GrowthModel?', 'NL', 'BE', 'SE', 'DK', 'DE', 'Total Boxes', 'Errors (EU sheet)', 'Error %'];
    const table = el('table', { class: 'data-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, headers.map(h => el('th', {}, [h])))]));
    const tbody = el('tbody');
    rows.forEach(r => {
      const suspicious = !r.hasGrowthModelRow || (median > 0 && r.total < median * 0.2);
      const tr = el('tr', suspicious ? { style: 'background:rgba(255,88,93,0.12);' } : {});
      tr.appendChild(el('td', {}, [r.week]));
      tr.appendChild(el('td', {}, [r.hasGrowthModelRow ? 'Yes' : 'NO — missing week']));
      [r.nl, r.be, r.se, r.dk, r.de, r.total].forEach(v => tr.appendChild(el('td', { class: 'cell-num' }, [fmtInt(v)])));
      tr.appendChild(el('td', { class: 'cell-num' }, [fmtInt(r.errors)]));
      tr.appendChild(el('td', { class: 'cell-num' }, [r.errorPct === null ? '—' : fmtPct(r.errorPct)]));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(el('div', { class: 'table-scroll' }, [table]));
    container.appendChild(card);
  }
  render();
}

function PageCategoryDrill(container, fs) {
  const allRows = DataStore.rawRows;
  let breakdownMode = 'pct'; // 'pct' | 'absolute'

  function render() { preserveScroll(renderInner); }

  function renderInner() {
    container.innerHTML = '';
    setPageHeader('Error Category Drill Down', 'Group by subcategory, complaint, and mapped detail within a category');

    container.appendChild(WeekRangePicker(fs, render));
    container.appendChild(MarketPillRow(fs, render));

    const spec = [
      { key: 'markets', label: 'Country', type: 'multiselect', exclusiveValue: 'FA-EU', options: optionsFor(MARKET_FILTER_OPTIONS) },
      { key: 'teams', label: 'Team', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'team')) },
      { key: 'errorCategory', label: 'Error Category', type: 'multiselect', options: optionsFor(uniqueSorted(allRows, 'error_category')) },
    ];
    container.appendChild(FilterBar(fs, spec, render));

    const filter = { weeks: fs.state.weeks, markets: fs.state.markets, teams: fs.state.teams, errorCategory: fs.state.errorCategory };
    const filtered = filterRows(allRows, filter);
    const weeks = fs.effectiveWeeks(); const markets = fs.effectiveMarkets();
    const agg = aggregate(filtered, weeks, markets);
    container.appendChild(kpiRowFor(agg));

    if (!weeks.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    // No category selected yet: stack by category. Once selected: stack by subcategory.
    const groupField = fs.state.errorCategory.length ? 'error_subcategory' : 'error_category';
    const levelLabel = fs.state.errorCategory.length ? 'Subcategory' : 'Error Category';
    const matrix = buildWeekGroupMatrix(filtered, groupField, weeks, markets);
    const groupKeys = orderGroupsByImpact(matrix, weeks);

    if (!groupKeys.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    const groupErrorPctByWeek = {};
    groupKeys.forEach(k => { groupErrorPctByWeek[k] = {}; weeks.forEach(w => { groupErrorPctByWeek[k][w] = matrix[k][w].errorPct; }); });

    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Weekly Error % by ${levelLabel}`]), el('div', { class: 'card-desc' }, [fs.state.errorCategory.length ? 'Select a category above to change what this stacks by' : 'Select a category above to drill into its subcategories'])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chartCard);
    renderStackedWeeklyChart(chartCard.querySelector('canvas'), weeks, groupKeys, groupErrorPctByWeek, undefined);

    const breakdownCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', { class: 'card-title' }, [`${breakdownMode === 'pct' ? 'Error % per Week' : 'Absolute Errors per Week'} by ${levelLabel}`]),
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
    }));
    container.appendChild(breakdownCard);

    const compCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [el('div', { class: 'card-title' }, [`Compensation per Week by ${levelLabel}`])]),
    ]);
    compCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = matrix[k][w].compensationTotal; return acc; }, {}) })),
      cellFormatter: (v) => ({ display: fmtEur(v), cls: '' }),
    }));
    container.appendChild(compCard);

    if (!fs.state.errorCategory.length) return;

    // Granular reference table: subcategory / complaint / mapped_detail_1 combos
    // (kept as an accumulated reference table — this level of detail is too fine-grained
    // for a per-week pivot to stay readable; ask if you'd like this split by week too)
    const map = new Map();
    filtered.forEach(r => {
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
