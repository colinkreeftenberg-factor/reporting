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
  'Last Mile':                { EU: 1.50, NL: 0.60, BE: 0.60, SE: 1.50, DK: 1.50, DE: 1.50 },
  'Strategic Procurement':    { EU: 0.50, NL: 1.00, BE: 1.00, SE: 1.00, DK: 1.00, DE: 1.00 },
  'Food Safety':              { EU: 0.50, NL: 0.20, BE: 0.20, SE: 0.20, DK: 0.20, DE: 1.00 },
};

// GrowthModel market codes we need to resolve to actual column headers at
// parse time (see _processGrowthModel) — done flexibly rather than by exact
// header string, since small naming differences (casing, "FC-" prefix, etc.)
// would otherwise silently zero out a market's box count.
const GROWTHMODEL_MARKET_CODES = { 'FA-NL': 'nl', 'FA-BE': 'be', 'FA-SE': 'se', 'FA-DK': 'dk', 'FA-DE': 'de' };

// Logistics uses the same per-market targets as the "Last Mile" team, since
// that's the existing target set for logistics/delivery error rates per market.
const LOGISTICS_TARGET_TEAM = 'Last Mile';

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
  logisticsRows: [],     // normalized Logistics sheet rows (separate source, has carrier)
  logisticsWeeks: [],    // separate, wider week list than DataStore.weeks (Logistics has more history)
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
      const fetches = [fetchCsv(CONFIG.EU_CSV_URL), fetchCsv(CONFIG.GROWTHMODEL_CSV_URL)];
      const hasLogistics = CONFIG.LOGISTICS_CSV_URL && !CONFIG.LOGISTICS_CSV_URL.startsWith('PASTE_');
      if (hasLogistics) fetches.push(fetchCsv(CONFIG.LOGISTICS_CSV_URL));
      const [euCsv, gmCsv, logCsv] = await Promise.all(fetches);
      this._processEu(euCsv);
      this._processGrowthModel(gmCsv);
      if (hasLogistics) this._processLogistics(logCsv);
      this._computeWeeks();
      if (hasLogistics) this._computeLogisticsWeeks();
      this.loaded = true;
    } catch (e) {
      console.error(e);
      this.loadError = e.message || 'FETCH_FAILED';
    }
  },

  _processEu(parsed) {
    this.rawRows = parsed.data
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
    this.rawRows.forEach(r => { r.isAgent = isAgentRow(r); });
  },

  // Values of "-1" or literal "NaN" mean "no detail" in this sheet — normalized
  // to '' so every page can treat blank consistently instead of showing "-1".
  _blankAware(v) {
    const s = (v === null || v === undefined) ? '' : String(v).trim();
    return (s === '-1' || s.toLowerCase() === 'nan') ? '' : s;
  },

  _processLogistics(parsed) {
    this.logisticsRows = parsed.data
      .filter(r => r.created_at || r.week)
      .map(r => ({
        created_at: r.created_at,
        week: normalizeWeek(r.week),
        country: (r.country || '').trim(),
        agent: r.agent,
        custId: r.CustID,
        boxId: r.BoxID,
        error_subcategory: this._blankAware(r.error_subcategory),
        complaint: this._blankAware(r.complaint),
        mapped_detail_1: this._blankAware(r.mapped_detail_1),
        mapped_detail_2: this._blankAware(r.mapped_detail_2),
        compensation: toNumber(r.compensation_amount_eur),
        override_reason: r.override_reason || '',
        comment: r.comment || '',
        delivery_status: this._blankAware(r.delivery_status),
        carrier: this._blankAware(r.carrier),
      }));
    this.logisticsRows.forEach(r => { r.isAgent = isAgentRow(r); });
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

    this.growthModelColumnMap = { weekKey, resolvedCols, totalKey, allHeaders: headerKeys };

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

  // The Logistics sheet has its own, much larger history than the EU sheet —
  // using DataStore.weeks (EU-sheet-derived) would silently hide those older
  // weeks even though real Logistics data exists for them.
  _computeLogisticsWeeks() {
    const set = new Set(this.logisticsRows.map(r => r.week).filter(Boolean));
    const sorted = Array.from(set).sort((a, b) => weekSortKey(a) - weekSortKey(b));
    this.logisticsWeeks = sorted.slice(1); // same "exclude oldest" convention as the EU sheet
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
    if (f.carrier && f.carrier.length && !f.carrier.includes(r.carrier)) return false;
    if (f.deliveryStatus && f.deliveryStatus.length && !f.deliveryStatus.includes(r.delivery_status)) return false;
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
// opts.getBoxes(groupKey, week) — optional override for the box denominator so
// carrier views can use each carrier's own market boxes rather than the combined total.
function buildWeekGroupMatrix(rows, groupField, weeks, markets, opts) {
  const getBoxes = opts && opts.getBoxes;
  const groupKeys = Array.from(new Set(rows.map(r => r[groupField]).filter(Boolean)));
  const defaultBoxesByWeek = {};
  weeks.forEach(w => { defaultBoxesByWeek[w] = DataStore.boxCount(markets, [w]); });

  const matrix = {};
  groupKeys.forEach(k => {
    matrix[k] = {};
    weeks.forEach(w => {
      const wRows = rows.filter(r => r.week === w && r[groupField] === k);
      const errorCount = wRows.length;
      const compensationTotal = wRows.reduce((s, r) => s + r.compensation, 0);
      const boxes = getBoxes ? getBoxes(k, w) : defaultBoxesByWeek[w];
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

// Maps each carrier to the FA-market codes it covers, derived from ALL logistics
// rows so the denominator is stable regardless of the current error filter.
// Intersected with effectiveMarkets so selecting SE only limits PostNord's boxes
// to SE, while FA-EU gives PostNord its full SE+DK box count.
function buildCarrierMarketMap(allLogisticsRows, effectiveMarkets) {
  const coverageByCarrier = {};
  allLogisticsRows.forEach(r => {
    if (!r.carrier || !r.country) return;
    if (!coverageByCarrier[r.carrier]) coverageByCarrier[r.carrier] = new Set();
    coverageByCarrier[r.carrier].add(r.country);
  });
  const result = {};
  Object.entries(coverageByCarrier).forEach(([carrier, fcSet]) => {
    const faMarkets = ALL_MARKETS.filter(fa => fcSet.has(FA_TO_FC[fa]));
    const intersected = faMarkets.filter(fa => effectiveMarkets.includes(fa));
    result[carrier] = intersected.length > 0 ? intersected : effectiveMarkets;
  });
  return result;
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

// Drill chain for the Logistics page: subcategory → complaint → detail.
// Unlike issueTypeKey (a flattened composite string), this lets the page
// start broad and progressively expand — a flat 3-level table is unreadable
// once there are more than a handful of combinations.
const LOGISTICS_DRILL_CHAIN = ['error_subcategory', 'complaint', 'mapped_detail_1'];

// Drill chain for the Error Category Drill Down page.
const CATEGORY_DRILL_CHAIN = ['error_category', 'error_subcategory', 'complaint', 'mapped_detail_1'];

// Blank subcategory/complaint/detail values would otherwise be silently
// dropped by buildWeekGroupMatrix's truthy filter — this keeps them visible
// as their own "(none)" group instead of disappearing.
function withBlankGroupLabel(rows, field) {
  return rows.map(r => Object.assign({}, r, { [field]: r[field] || '(none)' }));
}

// Filters rows down to whatever drill path has been pushed so far, where
// each crumb's level is directly a row field name (e.g. 'error_subcategory').
function applyGenericDrillFilter(rows, drillPath) {
  if (!drillPath.length) return rows;
  return rows.filter(r => drillPath.every(c => r[c.level] === c.value));
}

// For comparing all 5 markets side by side once drilled into a specific
// category/subcategory/complaint — deliberately ignores the country filter,
// since the whole point is to see every market's number at once.
function buildMarketComparisonMatrix(rows, weeks) {
  const matrix = {};
  ALL_MARKETS.forEach(m => {
    matrix[m] = {};
    const fc = FA_TO_FC[m];
    weeks.forEach(w => {
      const wRows = rows.filter(r => r.week === w && r.country === fc);
      const errorCount = wRows.length;
      const compensationTotal = wRows.reduce((s, r) => s + r.compensation, 0);
      const boxes = DataStore.boxCount([m], [w]);
      matrix[m][w] = {
        errorCount, compensationTotal,
        errorPct: boxes > 0 ? (errorCount / boxes) * 100 : 0,
        compPerBox: boxes > 0 ? compensationTotal / boxes : 0,
      };
    });
  });
  return matrix;
}

// Composite "issue type" key combining subcategory/complaint/detail into one
// grouping dimension, since the Logistics sheet doesn't have team/category
// levels to drill through — blank detail values display as "—" not "-1".
function issueTypeKey(r) {
  const parts = [r.error_subcategory, r.complaint, r.mapped_detail_1].filter(Boolean);
  return parts.length ? parts.join(' → ') : '(uncategorized)';
}

// Sums a matrix's values for a given metric across every group, per week —
// the basis for "Totals" rows in pivot tables.
function totalsAcrossGroups(matrix, groupKeys, weeks, metric) {
  const totals = {};
  weeks.forEach(w => {
    totals[w] = groupKeys.reduce((s, k) => s + ((matrix[k] && matrix[k][w]) ? matrix[k][w][metric] : 0), 0);
  });
  return totals;
}

// Target for exactly ONE team — this is what each row in a per-team
// breakdown table must be compared against, never the combined/summed
// target of every team stacked together.
function teamTarget(team, markets, weeks) {
  return blendedTarget([team], markets, weeks);
}

// Blended "Last Mile" target — reused as the Logistics per-market target,
// per the existing target set already defined for logistics/delivery errors.
function logisticsTarget(markets, weeks) {
  return blendedTarget([LOGISTICS_TARGET_TEAM], markets, weeks);
}
