/* ============================================================
   COMPONENTS
   Small factory functions returning DOM nodes. No page below
   should build a KPI card / filter / table / chart from scratch.
   ============================================================ */

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
const fmtPct = n => {
  const decimals = Math.abs(n) < 0.01 ? 4 : Math.abs(n) < 1 ? 3 : 2;
  return n.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + '%';
};

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
    const btn = el('button', {
      class: 'filter-btn' + (selected.length ? ' active' : ''),
      onclick: (e) => {
        e.stopPropagation();
        document.querySelectorAll('.filter-panel.open').forEach(p => { if (p !== panel) p.classList.remove('open'); });
        panel.classList.toggle('open');
      },
    }, [f.label, selected.length ? el('span', { class: 'count' }, [String(selected.length)]) : null]);

    const panel = el('div', { class: 'filter-panel' });
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

  document.addEventListener('click', () => {
    document.querySelectorAll('.filter-panel.open').forEach(p => p.classList.remove('open'));
  }, { once: true });

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
  const palette = ['#141414', '#18849F', '#C79C00', '#75C26D', '#FF585D', '#61DFFF', '#206B19', '#9B2629'];

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: displayValues,
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
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

// ---- Sortable, drill-down table --------------------------------------------------

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
