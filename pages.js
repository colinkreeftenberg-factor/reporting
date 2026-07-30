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
    KpiCard({ label: 'Total Errors', value: fmtInt(agg.errorCount) }),
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
  const baseFilter = {
    markets: fs.state.markets, errorCategory: fs.state.errorCategory,
    errorSubcategory: fs.state.errorSubcategory, complaint: fs.state.complaint, sourceType: fs.state.sourceType,
    teams: teamScope || [],
  };
  const scopedRows = teamScope ? allRows.filter(r => teamScope.includes(r.team)) : allRows;

  let compensationMode = 'total'; // 'total' | 'perbox'

  function render() {
    container.innerHTML = '';
    setPageHeader(title, subtitle);

    container.appendChild(Breadcrumb(title, fs, render));
    container.appendChild(WeekSlider(fs, render));
    container.appendChild(MarketPillRow(fs, render));

    const spec = standardFilterSpec(fs, scopedRows, { includeTeamFilter: !fs.drillPath.length, teamScope });
    container.appendChild(FilterBar(fs, spec, render));

    const filter = applyDrillToFilter(fs, { ...baseFilter, weeks: fs.state.weeks, teams: fs.state.teams.length ? fs.state.teams : teamScope });
    const weeks = fs.effectiveWeeks();
    const markets = fs.effectiveMarkets();
    const filtered = filterRows(scopedRows, filter);
    const agg = aggregate(filtered, weeks, markets);
    const level = nextDrillLevel(fs);
    const levelLabel = { team: 'Team', error_category: 'Error Category', error_subcategory: 'Subcategory', complaint: 'Complaint', mapped_detail_1: 'Mapped Detail' }[level];
    const groupField = level === 'team' ? 'team' : level;
    const target = blendedTarget(filter.teams && filter.teams.length ? filter.teams : (teamScope || OPERATIONAL_TEAMS), markets, weeks);

    container.appendChild(kpiRowFor(agg));

    const matrix = buildWeekGroupMatrix(filtered, groupField, weeks, markets);
    const groupKeys = orderGroupsByImpact(matrix, weeks);
    const canDrillFurther = DRILL_CHAIN.indexOf(level) < DRILL_CHAIN.length - 1;

    if (!groupKeys.length || !weeks.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.'])]));
      return;
    }

    // ---- Chart 1: stacked weekly Error % by group, with legend + total label ----
    const groupErrorPctByWeek = {};
    groupKeys.forEach(k => { groupErrorPctByWeek[k] = {}; weeks.forEach(w => { groupErrorPctByWeek[k][w] = matrix[k][w].errorPct; }); });

    const chartCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Weekly Error % by ${levelLabel}`]), el('div', { class: 'card-desc' }, ['Stacked by ' + levelLabel.toLowerCase() + ' · shaded band = blended target · total % labeled above each bar'])]),
      ]),
      el('div', { class: 'chart-wrap' }, [el('canvas')]),
    ]);
    container.appendChild(chartCard);
    renderStackedWeeklyChart(chartCard.querySelector('canvas'), weeks, groupKeys, groupErrorPctByWeek, target);

    // ---- Table 1: Error % per week per group (breakdown), colored vs target ----
    const breakdownCard = el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [el('div', { class: 'card-title' }, [`Breakdown by ${levelLabel} — Error % per Week`]), el('div', { class: 'card-desc' }, [canDrillFurther ? 'Click a row to drill in · red = above target' : 'Red = above target'])]),
      ]),
    ]);
    breakdownCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = matrix[k][w].errorPct; return acc; }, {}) })),
      cellFormatter: (v) => ({ display: fmtPct(v), cls: v > target ? 'cell-pct-bad' : 'cell-pct-good' }),
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
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = compensationMode === 'total' ? matrix[k][w].compensationTotal : matrix[k][w].compPerBox; return acc; }, {}) })),
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

  function render() {
    container.innerHTML = '';
    setPageHeader('Recipe Deep Dive', 'Which recipes create the biggest operational impact');

    container.appendChild(WeekSlider(fs, render));
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

    const teams = uniqueSorted(filtered, 'team');
    if (!teams.length) {
      container.appendChild(el('div', { class: 'card' }, [el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No recipe-related errors match the current filters.'])]));
      return;
    }

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

// ---- Page 4: Error Category Drill Down -----------------------------------------

function PageCategoryDrill(container, fs) {
  const allRows = DataStore.rawRows;

  function render() {
    container.innerHTML = '';
    setPageHeader('Error Category Drill Down', 'Group by subcategory, complaint, and mapped detail within a category');

    container.appendChild(WeekSlider(fs, render));
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
      el('div', { class: 'card-header' }, [el('div', { class: 'card-title' }, [`Error % per Week by ${levelLabel}`])]),
    ]);
    breakdownCard.appendChild(PivotTable({
      rowLabel: levelLabel,
      weeks,
      rows: groupKeys.map(k => ({ key: k, cells: weeks.reduce((acc, w) => { acc[w] = matrix[k][w].errorPct; return acc; }, {}) })),
      cellFormatter: (v) => ({ display: fmtPct(v), cls: '' }),
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
