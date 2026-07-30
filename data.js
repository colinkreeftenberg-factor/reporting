/* ============================================================
   DATA LAYER
   Fetches the two published-CSV sheets, normalizes rows, and
   exposes pure business-logic functions used by every page.
   ============================================================ */

// ---- Static reference data -----------------------------------------------

// Countries the filter UI shows. Internally we map "FA-xx" (brief's naming)
// to the real values used in the sheet's `country` column ("FC-xx").
// ASSUMPTION: confirm this mapping matches your source data if new markets
// are added (e.g. France) — the FA_TO_FC map is the single place to extend.
const FA_TO_FC = {
  'FA-NL': 'FC-NL',
  'FA-BE': 'FC-BE',
  'FA-SE': 'FC-SE',
  'FA-DK': 'FC-DK',
  'FA-DE': 'FC-DE',
};
const ALL_MARKETS = ['FA-NL', 'FA-BE', 'FA-SE', 'FA-DK', 'FA-DE'];
// UI-facing list: FA-EU is a selectable "all markets combined" option, mutually
// exclusive with picking individual markets (handled in the FilterBar component).
const MARKET_FILTER_OPTIONS = ['FA-EU', 'FA-NL', 'FA-BE', 'FA-SE', 'FA-DK', 'FA-DE'];

// Operational teams = the teams that have a defined target (used to scope
// Page 1 "General Operational Error Rates" vs Page 3 "All Errors").
const OPERATIONAL_TEAMS = [
  'Production - Warehousing',
  'Production - Pick & Pack',
  'Production - Cooking',
  'Packaging',
  'Last Mile',
  'Strategic Procurement',
  'Food Safety',
];

// TEAM x market weekly error-rate targets (% of boxes).
const TARGETS = {
  'Production - Warehousing': { EU: 0.50, NL: 0.50, BE: 0.50, SE: 0.50, DK: 0.50, DE: 0.50 },
  'Production - Pick & Pack': { EU: 0.50, NL: 0.50, BE: 0.50, SE: 0.50, DK: 0.50, DE: 0.50 },
  'Production - Cooking':     { EU: 0.50, NL: 0.50, BE: 0.50, SE: 0.50, DK: 0.50, DE: 0.50 },
  'Packaging':                { EU: 0.10, NL: 0.10, BE: 0.10, SE: 0.10, DK: 0.10, DE: 0.10 },
  'Last Mile':                { EU: 1.50, NL: 0.60, BE: 0.60, SE: 2.50, DK: 2.50, DE: 2.50 },
  'Strategic Procurement':    { EU: 0.50, NL: 1.00, BE: 1.00, SE: 1.00, DK: 1.00, DE: 1.00 },
  'Food Safety':              { EU: 0.50, NL: 0.20, BE: 0.20, SE: 0.20, DK: 0.20, DE: 1.00 },
};

// GrowthModel market codes we need to resolve to actual column headers at
// parse time (see _processGrowthModel) — done flexibly rather than by exact
// header string, since small naming differences (casing, "FC-" prefix, etc.)
// would otherwise silently zero out a market's box count.
const GROWTHMODEL_MARKET_CODES = { 'FA-NL': 'nl', 'FA-BE': 'be', 'FA-SE': 'se', 'FA-DK': 'dk', 'FA-DE': 'de' };

// ---- Utilities -------------------------------------------------------------

function toNumber(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

// Normalizes a variety of plausible week formats to "YYYY-Www" so the EU
// sheet and the GrowthModel sheet can be joined reliably even if their
// week columns are formatted slightly differently.
function normalizeWeek(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-?W(\d{1,2})$/i);
  if (m) return `${m[1]}-W${m[2].padStart(2, '0')}`;
  m = s.match(/^W(\d{1,2})[\s-]+(\d{4})$/i);
  if (m) return `${m[2]}-W${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-W${m[2].padStart(2, '0')}`;
  return s; // fall back to raw string; still usable as a grouping key
}

function weekSortKey(w) {
  const m = String(w).match(/(\d{4})-W(\d{1,2})/i);
  return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
}

function isAgentRow(row) {
  // Agent/Cert = everything where override_reason isn't the bulk-import marker.
  // Also checked against the 'agent' column itself (values like "bulk/CERT"
  // vs "agent" in the source data), since override_reason isn't always
  // populated consistently for bulk-imported rows.
  const reason = (row.override_reason || '').trim().toLowerCase();
  const agentField = (row.agent || '').trim().toLowerCase();
  const isBulk = reason.includes('bulk import') || agentField.includes('bulk');
  return !isBulk;
}

// ---- Store ------------------------------------------------------------------

const DataStore = {
  rawRows: [],          // normalized EU sheet rows
  growthModel: {},       // { normalizedWeek: { 'FA-NL': n, ... , 'FA-EU': n } }
  weeks: [],             // sorted, oldest-excluded, normalized week list
  loaded: false,
  loadError: null,

  async load() {
    if (CONFIG.EU_CSV_URL.startsWith('PASTE_') || CONFIG.GROWTHMODEL_CSV_URL.startsWith('PASTE_')) {
      this.loadError = 'CONFIG_MISSING';
      return;
    }
    try {
      const [euCsv, gmCsv] = await Promise.all([
        fetchCsv(CONFIG.EU_CSV_URL),
        fetchCsv(CONFIG.GROWTHMODEL_CSV_URL),
      ]);
      this._processEu(euCsv);
      this._processGrowthModel(gmCsv);
      this._computeWeeks();
      this.loaded = true;
    } catch (e) {
      console.error(e);
      this.loadError = e.message || 'FETCH_FAILED';
    }
  },

  rawRowCountBeforeDedup: 0,
  duplicatesRemoved: 0,

  _processEu(parsed) {
    const mapped = parsed.data
      .filter(r => r.created_at || r.week)
      .map(r => ({
        created_at: r.created_at,
        week: normalizeWeek(r.week),
        country: (r.country || '').trim(),          // e.g. "FC-SE"
        agent: r.agent,
        custId: r.CustID,
        boxId: r.BoxID,
        error_category: (r.error_category || '').trim(),
        error_subcategory: (r.error_subcategory || '').trim(),
        complaint: (r.complaint || '').trim(),
        mapped_detail_1: (r.mapped_detail_1 || '').trim(),
        team: (r.TEAM || '').trim(),
        recipe_title: (r.recipe_title || '').trim(),
        slot_number: r.slot_number,
        compensation_type: r.compensation_type,
        compensation: toNumber(r.compensation_amount_eur),
        override_reason: r.override_reason || '',
        comment: r.comment || '',
        delivery_status: r.delivery_status || '',
      }));

    this.rawRowCountBeforeDedup = mapped.length;

    // Guard against exact-duplicate rows — sheets driven by live formulas
    // (QUERY/IMPORTRANGE, or a row-limited log like this one) can sometimes
    // publish the same error row more than once, which would silently
    // inflate a week's error count and its Error %.
    const seen = new Set();
    const deduped = [];
    mapped.forEach(r => {
      const key = [r.created_at, r.boxId, r.error_category, r.error_subcategory, r.complaint, r.compensation].join('||');
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(r);
    });
    this.duplicatesRemoved = mapped.length - deduped.length;

    this.rawRows = deduped;
    this.rawRows.forEach(r => { r.isAgent = isAgentRow(r); });
  },

  _processGrowthModel(parsed) {
    const rows = parsed.data;
    const gm = {};
    if (!rows.length) { this.growthModel = gm; this.growthModelColumnMap = null; return; }

    const headerKeys = Object.keys(rows[0]);
    const normalize = (k) => k.toLowerCase().replace(/[^a-z]/g, '');
    const weekKey = headerKeys.find(k => /week/i.test(k)) || headerKeys[0];

    // Resolve each market's real column name by looking for its 2-letter
    // code anywhere in the normalized header (matches "NL BOXES", "NL Boxes",
    // "FC-NL", "FC-NL Boxes", etc. without needing an exact string match).
    const resolvedCols = {};
    Object.entries(GROWTHMODEL_MARKET_CODES).forEach(([faCode, code2]) => {
      resolvedCols[faCode] = headerKeys.find(k => k !== weekKey && normalize(k).includes(code2)) || null;
    });
    const totalKey = headerKeys.find(k => /total|^fa-?eu$|\beu\b/i.test(k)) || null;

    this.growthModelColumnMap = { weekKey, resolvedCols, totalKey };

    rows.forEach(r => {
      const week = normalizeWeek(r[weekKey]);
      if (!week) return;
      const entry = {};
      let sum = 0;
      Object.entries(resolvedCols).forEach(([faCode, colName]) => {
        const val = colName ? toNumber(r[colName]) : 0;
        entry[faCode] = val;
        sum += val;
      });
      entry['FA-EU'] = totalKey ? toNumber(r[totalKey]) : sum;
      gm[week] = entry;
    });
    this.growthModel = gm;
  },

  _computeWeeks() {
    const set = new Set(this.rawRows.map(r => r.week).filter(Boolean));
    const sorted = Array.from(set).sort((a, b) => weekSortKey(a) - weekSortKey(b));
    // Exclude the oldest week — often incomplete due to source row limits.
    this.weeks = sorted.slice(1);
  },

  // Box count for a set of FA-market codes across a set of weeks.
  boxCount(markets, weeks) {
    let total = 0;
    weeks.forEach(w => {
      const gm = this.growthModel[w];
      if (!gm) return;
      markets.forEach(m => { total += gm[m] || 0; });
    });
    return total;
  },
};

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: resolve,
      error: reject,
    });
  });
}

// ---- Core aggregation --------------------------------------------------------

// Filters shape: { weeks:[...normalizedWeek], markets:[...FA-xx], teams:[...TEAM],
//                  errorCategory:[...], errorSubcategory:[...], complaint:[...],
//                  recipe:[...], sourceType: 'all'|'agent'|'bulk' }
function filterRows(rows, f) {
  return rows.filter(r => {
    if (f.weeks && f.weeks.length && !f.weeks.includes(r.week)) return false;
    if (f.markets && f.markets.length && !f.markets.includes('FA-EU')) {
      const fcList = f.markets.map(m => FA_TO_FC[m]);
      if (!fcList.includes(r.country)) return false;
    }
    if (f.teams && f.teams.length && !f.teams.includes(r.team)) return false;
    if (f.errorCategory && f.errorCategory.length && !f.errorCategory.includes(r.error_category)) return false;
    if (f.errorSubcategory && f.errorSubcategory.length && !f.errorSubcategory.includes(r.error_subcategory)) return false;
    if (f.complaint && f.complaint.length && !f.complaint.includes(r.complaint)) return false;
    if (f.recipe && f.recipe.length && !f.recipe.includes(r.recipe_title)) return false;
    if (f.sourceType === 'agent' && !r.isAgent) return false;
    if (f.sourceType === 'bulk' && r.isAgent) return false;
    return true;
  });
}

function aggregate(rows, weeks, markets) {
  const boxes = DataStore.boxCount(markets && markets.length ? markets : ALL_MARKETS, weeks && weeks.length ? weeks : DataStore.weeks);
  const errorCount = rows.length;
  const compensationTotal = rows.reduce((s, r) => s + r.compensation, 0);
  const errorPct = boxes > 0 ? (errorCount / boxes) * 100 : 0;
  const compPerBox = boxes > 0 ? compensationTotal / boxes : 0;
  return { errorCount, compensationTotal, boxes, errorPct, compPerBox };
}

// Builds { [groupKey]: { [week]: {errorCount, compensationTotal, errorPct, compPerBox} } }
// Every value is computed per-week (never summed across the selected weeks),
// per Colin's requirement that tables/charts show values per week.
function buildWeekGroupMatrix(rows, groupField, weeks, markets) {
  const groupKeys = Array.from(new Set(rows.map(r => r[groupField]).filter(Boolean)));
  const boxesByWeek = {};
  weeks.forEach(w => { boxesByWeek[w] = DataStore.boxCount(markets, [w]); });

  const matrix = {};
  groupKeys.forEach(k => {
    matrix[k] = {};
    weeks.forEach(w => {
      const wRows = rows.filter(r => r.week === w && r[groupField] === k);
      const errorCount = wRows.length;
      const compensationTotal = wRows.reduce((s, r) => s + r.compensation, 0);
      const boxes = boxesByWeek[w];
      matrix[k][w] = {
        errorCount,
        compensationTotal,
        errorPct: boxes > 0 ? (errorCount / boxes) * 100 : 0,
        compPerBox: boxes > 0 ? compensationTotal / boxes : 0,
      };
    });
  });
  return matrix;
}

// Orders group keys by total error volume across the given weeks — used only
// to decide stacking/row order, never displayed as an accumulated figure.
function orderGroupsByImpact(matrix, weeks) {
  return Object.keys(matrix).sort((a, b) => {
    const totalA = weeks.reduce((s, w) => s + (matrix[a][w] ? matrix[a][w].errorCount : 0), 0);
    const totalB = weeks.reduce((s, w) => s + (matrix[b][w] ? matrix[b][w].errorCount : 0), 0);
    return totalB - totalA;
  });
}

// Team-specific ordering: all "Production - X" teams stay grouped together
// (sorted by impact within that group), followed by every other team (also
// sorted by impact). Used anywhere teams are listed/stacked/rowed.
function orderTeamsGrouped(matrix, weeks) {
  const impactOf = (k) => weeks.reduce((s, w) => s + (matrix[k][w] ? matrix[k][w].errorCount : 0), 0);
  const keys = Object.keys(matrix);
  const production = keys.filter(k => k.startsWith('Production -')).sort((a, b) => impactOf(b) - impactOf(a));
  const others = keys.filter(k => !k.startsWith('Production -')).sort((a, b) => impactOf(b) - impactOf(a));
  return [...production, ...others];
}
// each market's box volume over the selected weeks. Multiple teams are
// summed, since each team's target represents an independent error budget
// against the same box denominator. Returns null (not 0) if none of the
// given teams have a defined target — 0 would wrongly flag any error as
// "over target".
function blendedTarget(teams, markets, weeks) {
  const teamList = teams && teams.length ? teams : OPERATIONAL_TEAMS;
  const marketList = markets && markets.length ? markets : ALL_MARKETS;
  const weekList = weeks && weeks.length ? weeks : DataStore.weeks;

  const marketWeights = marketList.map(m => ({ m, boxes: DataStore.boxCount([m], weekList) }));
  const totalBoxes = marketWeights.reduce((s, x) => s + x.boxes, 0);
  if (totalBoxes === 0) return null;

  let blended = 0;
  let anyTeamHasTarget = false;
  teamList.forEach(team => {
    const t = TARGETS[team];
    if (!t) return;
    anyTeamHasTarget = true;
    let teamBlend = 0;
    marketWeights.forEach(({ m, boxes }) => {
      const key = m.replace('FA-', '');
      teamBlend += (t[key] || 0) * (boxes / totalBoxes);
    });
    blended += teamBlend;
  });
  return anyTeamHasTarget ? blended : null;
}

// Target for exactly ONE team — this is what each row in a per-team
// breakdown table must be compared against, never the combined/summed
// target of every team stacked together.
function teamTarget(team, markets, weeks) {
  return blendedTarget([team], markets, weeks);
}
