/* ============================================================
   FILTER STATE
   Each page gets its own isolated FilterState instance so that
   changing filters on one page never affects another (per spec).
   ============================================================ */

class FilterState {
  constructor(defaults, onChange) {
    this.state = Object.assign({
      weeks: [],       // empty = "all weeks" (excluding oldest, handled in DataStore.weeks)
      markets: [],     // empty = FA-EU (all markets)
      teams: [],
      errorCategory: [],
      errorSubcategory: [],
      complaint: [],
      recipe: [],
      sourceType: 'all', // 'all' | 'agent' | 'bulk'
    }, defaults || {});
    this.onChange = onChange || (() => {});
    this.drillPath = []; // breadcrumb stack for drill-through, e.g. [{level:'team', value:'Packaging'}, ...]
  }

  set(key, value) {
    this.state[key] = value;
    this.onChange();
  }

  toggleInArray(key, value) {
    const arr = this.state[key];
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
    this.onChange();
  }

  clear(key) {
    this.state[key] = Array.isArray(this.state[key]) ? [] : (key === 'sourceType' ? 'all' : null);
    this.onChange();
  }

  clearAll() {
    this.state.weeks = [];
    this.state.markets = [];
    this.state.teams = [];
    this.state.errorCategory = [];
    this.state.errorSubcategory = [];
    this.state.complaint = [];
    this.state.recipe = [];
    this.state.sourceType = 'all';
    this.drillPath = [];
    this.onChange();
  }

  pushDrill(level, value, label) {
    this.drillPath.push({ level, value, label: label || value });
    this.onChange();
  }

  popDrillTo(index) {
    this.drillPath = this.drillPath.slice(0, index + 1);
    this.onChange();
  }

  resetDrill() {
    this.drillPath = [];
    this.onChange();
  }

  // Effective weeks used for aggregation (all-known weeks if none selected)
  effectiveWeeks() {
    return this.state.weeks.length ? this.state.weeks : DataStore.weeks;
  }
  effectiveMarkets() {
    return this.state.markets.length ? this.state.markets : ALL_MARKETS;
  }
}
