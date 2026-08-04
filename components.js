/* ============================================================
   COMPONENTS
   Small factory functions returning DOM nodes. No page below
   should build a KPI card / filter / table / chart from scratch.
   ============================================================ */

// ---- Scroll preservation ------------------------------------------------------

// Clearing/rebuilding a page's content (as every filter/toggle interaction does)
// temporarily collapses its height, which makes the browser clamp scroll
// position back to 0 before the content grows back. This restores it.
function preserveScroll(renderFn) {
  const y = window.scrollY;
  renderFn();
  window.scrollTo(0, y);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

const fmtInt = n => Math.round(n).toLocaleString('en-GB');
const fmtEur = n => '€' + n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtEurPrecise = n => '€' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Team/group color palette — deliberately excludes Carbon/black (reserved
// for UI chrome, not data series) and generates lightened tints of the same
// hues if there are more groups than base colors, rather than ever repeating
// a color outright.
const GROUP_COLOR_BASE = ['#18849F', '#FF585D', '#75C26D', '#C79C00', '#9B2629', '#61DFFF', '#206B19', '#6B6A63', '#8B5CF6', '#E8590C'];

function withAlpha(color, alpha) {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const m = color.match(/rgb\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return color;
}

function lightenHex(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function colorForIndex(i) {
  const pass = Math.floor(i / GROUP_COLOR_BASE.length);
  const base = GROUP_COLOR_BASE[i % GROUP_COLOR_BASE.length];
  return pass === 0 ? base : lightenHex(base, Math.min(0.55, pass * 0.28));
}

const fmtPct = n => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';

// ---- KPI card ---------------------------------------------------------------

function KpiCard({ label, value, sub, badge, onClick }) {
  const card = el('div', { class: 'kpi-card' + (onClick ? ' clickable' : ''), onclick: onClick || null }, [
    el('div', { class: 'kpi-label' }, [label]),
    el('div', { class: 'kpi-value' }, [value]),
    sub ? el('div', { class: 'kpi-sub' }, [
      badge ? el('span', { class: 'badge ' + badge.type }, [badge.text]) : null,
      sub,
    ]) : null,
  ]);
  return card;
}

// ---- Filter bar ---------------------------------------------------------------

// spec: array of { key, label, type:'multiselect'|'toggle3', options:[{value,label}] }
function FilterBar(fs, spec, onAnyChange) {
  const bar = el('div', { class: 'filter-bar' });

  spec.forEach(f => {
    if (f.type === 'toggle3') {
      const pill = el('div', { class: 'toggle-pill' });
      f.options.forEach(opt => {
        const btn = el('button', {
          class: fs.state[f.key] === opt.value ? 'active' : '',
          onclick: () => { fs.set(f.key, opt.value); onAnyChange(); },
        }, [opt.label]);
        pill.appendChild(btn);
      });
      bar.appendChild(pill);
      return;
    }

    const group = el('div', { class: 'filter-group' });
    const selected = fs.state[f.key] || [];
    const isOpen = fs.openFilterKey === f.key;
    const btn = el('button', {
      class: 'filter-btn' + (selected.length ? ' active' : ''),
      onclick: (e) => {
        e.stopPropagation();
        fs.openFilterKey = isOpen ? null : f.key;
        onAnyChange();
      },
    }, [f.label, selected.length ? el('span', { class: 'count' }, [String(selected.length)]) : null]);

    const panel = el('div', { class: 'filter-panel' + (isOpen ? ' open' : '') });
    const clearBtn = el('button', { class: 'filter-clear', onclick: () => { fs.clear(f.key); onAnyChange(); } }, ['Clear']);
    panel.appendChild(clearBtn);
    f.options.forEach(opt => {
      const checked = selected.includes(opt.value);
      const row = el('label', { class: 'filter-option' }, [
        el('input', {
          type: 'checkbox', ...(checked ? { checked: 'checked' } : {}),
          onchange: () => {
            if (f.exclusiveValue) {
              const arr = fs.state[f.key];
              if (opt.value === f.exclusiveValue) {
                fs.state[f.key] = arr.includes(f.exclusiveValue) ? [] : [f.exclusiveValue];
              } else {
                const next = arr.filter(v => v !== f.exclusiveValue);
                const idx = next.indexOf(opt.value);
                if (idx >= 0) next.splice(idx, 1); else next.push(opt.value);
                fs.state[f.key] = next;
              }
              onAnyChange();
            } else {
              fs.toggleInArray(f.key, opt.value); onAnyChange();
            }
          },
        }),
        el('span', {}, [opt.label]),
      ]);
      panel.appendChild(row);
    });

    group.appendChild(btn);
    group.appendChild(panel);
    bar.appendChild(group);
  });

  return bar;
}

// ---- Breadcrumb (drill-through) ------------------------------------------------

function Breadcrumb(rootLabel, fs, onNavigate) {
  const wrap = el('div', { class: 'breadcrumb' });
  const isRoot = fs.drillPath.length === 0;
  wrap.appendChild(el('span', { class: 'crumb' + (isRoot ? ' current' : ''), onclick: () => { fs.resetDrill(); onNavigate(); } }, [rootLabel]));
  fs.drillPath.forEach((crumb, i) => {
    wrap.appendChild(el('span', { class: 'crumb-sep' }, ['›']));
    const isLast = i === fs.drillPath.length - 1;
    wrap.appendChild(el('span', {
      class: 'crumb' + (isLast ? ' current' : ''),
      onclick: () => { if (!isLast) { fs.popDrillTo(i); onNavigate(); } },
    }, [crumb.label]));
  });
  return wrap;
}

// ---- Chart with adaptive outlier handling --------------------------------------

// Draws small triangle markers above any bar that got visually clipped, and
// shows the true value in the tooltip / label regardless of the clip.
const clipMarkerPlugin = {
  id: 'clipMarkerPlugin',
  afterDatasetsDraw(chart, args, pluginOpts) {
    const clipped = pluginOpts && pluginOpts.indices;
    if (!clipped || !clipped.size) return;
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    clipped.forEach(idx => {
      const bar = meta.data[idx];
      if (!bar) return;
      ctx.save();
      ctx.fillStyle = '#9B2629';
      ctx.beginPath();
      ctx.moveTo(bar.x - 5, bar.y + 2);
      ctx.lineTo(bar.x + 5, bar.y + 2);
      ctx.lineTo(bar.x, bar.y - 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  },
};

// Target band plugin: soft grey band behind the chart up to the target line.
const targetBandPlugin = {
  id: 'targetBandPlugin',
  beforeDraw(chart, args, pluginOpts) {
    const target = pluginOpts && pluginOpts.value;
    if (target === undefined || target === null) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(target);
    ctx.save();
    ctx.fillStyle = 'rgba(20,20,20,0.045)';
    ctx.fillRect(chartArea.left, y, chartArea.right - chartArea.left, chartArea.bottom - y);
    ctx.strokeStyle = 'rgba(20,20,20,0.22)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  },
};

function computeAxisCap(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 1;
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const max = sorted[sorted.length - 1];
  const cap = Math.max(p90 * 1.4, sorted[0] || 0.1);
  return max > cap * 1.15 ? cap : max * 1.15 || 1;
}

function renderWeeklyChart(canvas, weeks, series, targetPct) {
  const values = series.map(s => s.value);
  const cap = computeAxisCap(values);
  const clippedIndices = new Set();
  const displayValues = values.map((v, i) => {
    if (v > cap) { clippedIndices.add(i); return cap; }
    return v;
  });

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: weeks,
      datasets: [{
        data: displayValues,
        borderColor: '#141414',
        backgroundColor: 'rgba(20,20,20,0.06)',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#FFC800',
        pointHoverBorderColor: '#141414',
        tension: 0.35,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141414',
          padding: 12,
          cornerRadius: 10,
          titleFont: { family: 'Plus Jakarta Sans', weight: '600' },
          bodyFont: { family: 'IBM Plex Sans' },
          callbacks: {
            label: (ctx) => {
              const real = values[ctx.dataIndex];
              return ` ${real.toFixed(2)}%${real > cap ? '  (off-scale)' : ''}`;
            },
          },
        },
        clipMarkerPlugin: { indices: clippedIndices },
        targetBandPlugin: { value: targetPct },
      },
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: cap,
          ticks: { callback: v => v + '%', font: { family: 'IBM Plex Sans', size: 11 } },
          grid: { color: 'rgba(20,20,20,0.06)' },
        },
        x: { ticks: { font: { family: 'IBM Plex Sans', size: 11 } }, grid: { display: false } },
      },
    },
    plugins: [clipMarkerPlugin, targetBandPlugin],
  });
  return chart;
}

function renderBarChart(canvas, labels, values, opts = {}) {
  const cap = computeAxisCap(values);
  const clippedIndices = new Set();
  const displayValues = values.map((v, i) => {
    if (v > cap) { clippedIndices.add(i); return cap; }
    return v;
  });
  const backgroundColor = labels.map((_, i) => colorForIndex(i));

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: displayValues,
        backgroundColor,
        borderRadius: 8,
        maxBarThickness: 46,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141414', padding: 12, cornerRadius: 10,
          callbacks: {
            label: (ctx) => {
              const real = values[ctx.dataIndex];
              return ` ${real.toFixed(2)}%${real > cap ? '  (off-scale)' : ''}`;
            },
          },
        },
        clipMarkerPlugin: { indices: clippedIndices },
        targetBandPlugin: { value: opts.targetPct },
      },
      scales: {
        y: { beginAtZero: true, suggestedMax: cap, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(20,20,20,0.06)' } },
        x: { grid: { display: false }, ticks: { font: { size: 11.5 } } },
      },
      onClick: opts.onBarClick ? (evt, elements) => {
        if (elements.length) opts.onBarClick(labels[elements[0].index]);
      } : undefined,
    },
    plugins: [clipMarkerPlugin, targetBandPlugin],
  });
  return chart;
}

// ---- Week range slider ---------------------------------------------------------

// Selecting one week is done by dragging both handles together; a range is
// just dragging them apart. An empty fs.state.weeks means "all weeks".
function weeksToRange(selectedWeeks, allWeeks) {
  if (!selectedWeeks || !selectedWeeks.length) return [0, allWeeks.length - 1];
  const idxs = selectedWeeks.map(w => allWeeks.indexOf(w)).filter(i => i >= 0);
  if (!idxs.length) return [0, allWeeks.length - 1];
  return [Math.min(...idxs), Math.max(...idxs)];
}

function WeekRangePicker(fs, onAnyChange) {
  const weeks = fs.weeksList || DataStore.weeks;
  const n = weeks.length;
  let [startIdx, endIdx] = weeksToRange(fs.state.weeks, weeks);

  const wrap = el('div', { class: 'week-range-picker' });

  const fromSelect = el('select', { class: 'week-select' });
  const toSelect = el('select', { class: 'week-select' });
  weeks.forEach((w, i) => {
    fromSelect.appendChild(el('option', { value: String(i) }, [w]));
    toSelect.appendChild(el('option', { value: String(i) }, [w]));
  });
  fromSelect.value = String(startIdx);
  toSelect.value = String(endIdx);

  function commit() {
    let s = parseInt(fromSelect.value, 10);
    let e = parseInt(toSelect.value, 10);
    if (s > e) { const tmp = s; s = e; e = tmp; } // auto-correct if From/To end up swapped
    fs.state.weeks = (s === 0 && e === n - 1) ? [] : weeks.slice(s, e + 1);
    onAnyChange();
  }
  fromSelect.addEventListener('change', commit);
  toSelect.addEventListener('change', commit);

  const quick = el('div', { class: 'week-range-quick' }, [
    el('button', { onclick: () => { fromSelect.value = '0'; toSelect.value = String(n - 1); commit(); } }, ['All weeks']),
    el('button', { onclick: () => { fromSelect.value = String(n - 1); toSelect.value = String(n - 1); commit(); } }, ['Latest week only']),
  ]);

  wrap.appendChild(el('div', { class: 'week-range-row' }, [
    el('span', { class: 'week-range-title' }, ['Week']),
    fromSelect,
    el('span', { class: 'week-range-arrow' }, ['→']),
    toSelect,
    quick,
  ]));
  return wrap;
}

// ---- Market pill row (one-click country buttons, in addition to the dropdown) --

function MarketPillRow(fs, onAnyChange) {
  const wrap = el('div', { class: 'market-pill-row' });
  MARKET_FILTER_OPTIONS.forEach(opt => {
    const active = fs.state.markets.includes(opt);
    const btn = el('button', {
      class: 'market-pill' + (active ? ' active' : ''),
      onclick: () => {
        if (opt === 'FA-EU') {
          fs.state.markets = fs.state.markets.includes('FA-EU') ? [] : ['FA-EU'];
        } else {
          const next = fs.state.markets.filter(v => v !== 'FA-EU');
          const idx = next.indexOf(opt);
          if (idx >= 0) next.splice(idx, 1); else next.push(opt);
          fs.state.markets = next;
        }
        onAnyChange();
      },
    }, [opt === 'FA-EU' ? 'All (EU)' : opt.replace('FA-', '')]);
    wrap.appendChild(btn);
  });
  return wrap;
}

// ---- Stacked weekly chart (teams/groups stacked per week, total % on top) ------

const totalLabelPlugin = {
  id: 'totalLabelPlugin',
  afterDatasetsDraw(chart, args, pluginOpts) {
    const totals = pluginOpts && pluginOpts.totals;
    if (!totals) return;
    const formatter = (pluginOpts && pluginOpts.formatter) || (v => v.toFixed(2) + '%');
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = '#141414';
    ctx.font = "700 12px 'Plus Jakarta Sans', sans-serif";
    ctx.textAlign = 'center';
    totals.forEach((total, i) => {
      const bar = meta.data[i];
      if (!bar) return;
      const yPix = chart.scales.y.getPixelForValue(total);
      ctx.fillText(formatter(total), bar.x, yPix - 8);
    });
    ctx.restore();
  },
};

// groupErrorPctByWeek: { group: { week: errorPct } }, groups already ordered
// groupErrorPctByWeek: selected (current toggle) values. remainderByWeek: the
// portion excluded by the current Agent/Cert-vs-Bulk toggle (optional) — drawn
// as a dimmed continuation of the same segment so the bar's total height, and
// therefore the Y-axis scale, stays constant while toggling between All/Agent/Bulk.
// fixedMax, if given, pins suggestedMax so only non-toggle filters (team, week,
// market, category) can change the scale.
function renderStackedWeeklyChart(canvas, weeks, groups, groupErrorPctByWeek, targetPct, opts = {}) {
  const mode = opts.mode || 'pct'; // 'pct' | 'absolute'
  const remainderByWeek = mode === 'pct' ? (opts.remainderByWeek || null) : null;
  const datasets = [];
  groups.forEach((g, i) => {
    const color = colorForIndex(i);
    datasets.push({
      label: g,
      data: weeks.map(w => groupErrorPctByWeek[g][w] || 0),
      backgroundColor: color,
      stack: 'errors',
      borderRadius: 4,
      maxBarThickness: 64,
    });
    if (remainderByWeek) {
      datasets.push({
        label: g + ' — excluded by current toggle',
        data: weeks.map(w => (remainderByWeek[g] && remainderByWeek[g][w]) || 0),
        backgroundColor: withAlpha(color, 0.25),
        stack: 'errors',
        borderRadius: 4,
        maxBarThickness: 64,
        _isRemainder: true,
      });
    }
  });

  const selectedTotals = weeks.map(w => groups.reduce((s, g) => s + (groupErrorPctByWeek[g][w] || 0), 0));
  const fullTotals = weeks.map((w, i) => selectedTotals[i] + (remainderByWeek ? groups.reduce((s, g) => s + ((remainderByWeek[g] && remainderByWeek[g][w]) || 0), 0) : 0));
  const maxTotal = opts.fixedMax !== undefined ? opts.fixedMax : Math.max(...fullTotals, 0.01);
  const fmtVal = (v) => mode === 'pct' ? v.toFixed(2) + '%' : fmtInt(v);

  return new Chart(canvas, {
    type: 'bar',
    data: { labels: weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      layout: { padding: { top: 26 } },
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: {
            boxWidth: 12, boxHeight: 12, padding: 14, font: { family: 'IBM Plex Sans', size: 11.5 }, usePointStyle: false,
            filter: (item, data) => !data.datasets[item.datasetIndex]._isRemainder,
          },
        },
        tooltip: {
          backgroundColor: '#141414', padding: 12, cornerRadius: 10,
          callbacks: {
            label: (ctx) => ctx.dataset._isRemainder
              ? ` ${ctx.dataset.label.replace(' — excluded by current toggle', '')}: +${fmtVal(ctx.raw)} excluded by toggle`
              : ` ${ctx.dataset.label}: ${fmtVal(ctx.raw)}`,
          },
        },
        totalLabelPlugin: { totals: fullTotals, formatter: fmtVal },
        targetBandPlugin: { value: mode === 'pct' ? targetPct : null },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, suggestedMax: maxTotal * 1.18, ticks: { callback: v => mode === 'pct' ? v + '%' : v }, grid: { color: 'rgba(20,20,20,0.06)' } },
      },
    },
    plugins: [targetBandPlugin, totalLabelPlugin],
  });
}

// ---- Multi-line chart (e.g. ER% per carrier per week) --------------------------

// series: [{ label, dataByWeek: {week: value} }]
function renderMultiLineChart(canvas, weeks, series, opts = {}) {
  const datasets = series.map((s, i) => ({
    label: s.label,
    data: weeks.map(w => s.dataByWeek[w] || 0),
    borderColor: colorForIndex(i),
    backgroundColor: withAlpha(colorForIndex(i), 0.08),
    borderWidth: 2.5,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHoverBackgroundColor: colorForIndex(i),
    tension: 0.3,
    fill: false,
  }));

  return new Chart(canvas, {
    type: 'line',
    data: { labels: weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, padding: 14, font: { family: 'IBM Plex Sans', size: 11.5 } } },
        tooltip: {
          backgroundColor: '#141414', padding: 12, cornerRadius: 10,
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw.toFixed(2)}%` },
        },
        targetBandPlugin: { value: opts.targetPct },
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(20,20,20,0.06)' } },
        x: { grid: { display: false } },
      },
    },
    plugins: [targetBandPlugin],
  });
}

// ---- Composition/absolute stacked chart (e.g. delivery status per week) --------

// groupValueByWeek: { group: { week: value } } — values already in the units
// matching `mode` ('pct' = composition % of that week's total, already computed
// by the caller; 'absolute' = raw counts). This chart doesn't apply a target
// band or a "% of boxes" semantic — it's a composition breakdown, not an error rate.
function renderCompositionChart(canvas, weeks, groups, groupValueByWeek, mode) {
  const datasets = groups.map((g, i) => ({
    label: g || '(blank)',
    data: weeks.map(w => groupValueByWeek[g][w] || 0),
    backgroundColor: colorForIndex(i),
    stack: 'status',
    borderRadius: 4,
    maxBarThickness: 64,
  }));

  return new Chart(canvas, {
    type: 'bar',
    data: { labels: weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, padding: 14, font: { family: 'IBM Plex Sans', size: 11.5 } } },
        tooltip: {
          backgroundColor: '#141414', padding: 12, cornerRadius: 10,
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${mode === 'pct' ? ctx.raw.toFixed(2) + '%' : fmtInt(ctx.raw)}` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { callback: v => mode === 'pct' ? v + '%' : v }, grid: { color: 'rgba(20,20,20,0.06)' } },
      },
    },
  });
}

// ---- Per-week pivot table (rows = group, columns = weeks) ----------------------

// rows: [{ key, cells: { week: number } }]; cellFormatter(value) -> {display, cls}
function PivotTable({ rowLabel, weeks, rows, cellFormatter, onRowClick, totalsRow }) {
  const wrap = el('div', { class: 'table-scroll' });
  const table = el('table', { class: 'data-table' });
  const thead = el('thead');
  thead.appendChild(el('tr', {}, [el('th', {}, [rowLabel]), ...weeks.map(w => el('th', {}, [w]))]));
  table.appendChild(thead);

  const tbody = el('tbody');
  if (!rows.length) {
    tbody.appendChild(el('tr', {}, [el('td', { colspan: String(weeks.length + 1) }, [
      el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.']),
    ])]));
  }
  rows.forEach(row => {
    const tr = el('tr', { onclick: onRowClick ? () => onRowClick(row.key) : null });
    tr.appendChild(el('td', {}, [row.key]));
    weeks.forEach(w => {
      const val = row.cells[w];
      const { display, cls } = cellFormatter(val, w, row.key);
      tr.appendChild(el('td', { class: 'cell-num ' + (cls || '') }, [display]));
    });
    tbody.appendChild(tr);
  });
  if (totalsRow) {
    const tr = el('tr', { class: 'pivot-totals-row' });
    tr.appendChild(el('td', {}, ['Total']));
    weeks.forEach(w => {
      const val = totalsRow.cells[w];
      const { display } = (totalsRow.cellFormatter || cellFormatter)(val, w, '__total__');
      tr.appendChild(el('td', { class: 'cell-num' }, [display]));
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// columns: [{key,label,align,numeric,pct}], rows: array of plain objects
// onRowClick(row) optional -> enables drill-through
function DataTable({ columns, rows, onRowClick, targetPct }) {
  let sortKey = null, sortDir = 1;
  const wrap = el('div', { class: 'table-scroll' });
  const table = el('table', { class: 'data-table' });

  function renderTable() {
    table.innerHTML = '';
    const thead = el('thead');
    const headRow = el('tr');
    columns.forEach(col => {
      const th = el('th', {
        onclick: () => {
          if (sortKey === col.key) sortDir *= -1; else { sortKey = col.key; sortDir = 1; }
          renderTable();
        },
      }, [col.label, sortKey === col.key ? el('span', { class: 'arrow' }, [sortDir === 1 ? '▲' : '▼']) : null]);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    let sorted = rows;
    if (sortKey) {
      sorted = [...rows].sort((a, b) => {
        const va = a[sortKey], vb = b[sortKey];
        if (typeof va === 'number') return (va - vb) * sortDir;
        return String(va).localeCompare(String(vb)) * sortDir;
      });
    }

    const tbody = el('tbody');
    if (!sorted.length) {
      tbody.appendChild(el('tr', {}, [el('td', { colspan: String(columns.length) }, [
        el('div', { class: 'empty-state' }, [el('div', { class: 'icon' }, ['—']), 'No rows match the current filters.']),
      ])]));
    }
    sorted.forEach(row => {
      const tr = el('tr', { onclick: onRowClick ? () => onRowClick(row) : null });
      columns.forEach(col => {
        let display = row[col.key];
        let cls = col.numeric ? 'cell-num' : '';
        if (col.pct && typeof display === 'number') {
          const over = targetPct !== undefined && display > targetPct;
          cls += over ? ' cell-pct-bad' : ' cell-pct-good';
          display = fmtPct(display);
        } else if (col.money && typeof display === 'number') {
          display = fmtEur(display);
        } else if (col.moneyPrecise && typeof display === 'number') {
          display = fmtEurPrecise(display);
        } else if (col.int && typeof display === 'number') {
          display = fmtInt(display);
        }
        tr.appendChild(el('td', { class: cls }, [String(display)]));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  renderTable();
  wrap.appendChild(table);
  return wrap;
}

// ---- Skeleton / empty helpers -------------------------------------------------

function skeletonBlock(height) {
  return el('div', { class: 'skeleton', style: `height:${height}px; width:100%; border-radius:16px;` });
}
