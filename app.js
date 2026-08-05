/* ============================================================
   APP SHELL
   Sidebar nav, router, initial data load, loading/error states.
   ============================================================ */

const PAGES = [
  { id: 'general', label: 'Operational Errors', render: PageGeneral },
  { id: 'recipe', label: 'Recipe Deep Dive', render: PageRecipe },
  { id: 'all', label: 'All Errors', render: PageAll },
  { id: 'category', label: 'Error Category Drill Down', render: PageCategoryDrill },
  { id: 'logistics', label: 'Logistics', render: PageLogistics },
  { id: 'datacheck', label: 'Data Check', render: PageDataCheck },
];

const pageFilterStates = {}; // one isolated FilterState per page

let activePageId = PAGES[0].id;

function setPageHeader(title, subtitle) {
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = subtitle;
}

function renderNav() {
  const navList = document.getElementById('navList');
  navList.innerHTML = '';
  PAGES.forEach(p => {
    const item = el('button', {
      class: 'nav-item' + (p.id === activePageId ? ' active' : ''),
      onclick: () => { activePageId = p.id; renderNav(); renderActivePage(); closeMobileSidebar(); },
    }, [el('span', { class: 'dot' }), p.label]);
    navList.appendChild(item);
  });
}

function renderActivePage() {
  const container = document.getElementById('pageContent');
  container.innerHTML = '';
  document.getElementById('floatingBreadcrumb').innerHTML = '';
  const page = PAGES.find(p => p.id === activePageId);
  if (!pageFilterStates[page.id]) {
    pageFilterStates[page.id] = new FilterState({}, () => {});
    if (page.id === 'logistics') pageFilterStates[page.id].weeksList = DataStore.logisticsWeeks;
  }
  window.scrollTo(0, 0);
  page.render(container, pageFilterStates[page.id]);
}

function closeMobileSidebar() {
  document.getElementById('sidebar').classList.remove('open');
}

function showConfigBanner() {
  const container = document.getElementById('pageContent');
  setPageHeader('Setup required', 'Connect your Google Sheet to get started');
  container.innerHTML = '';
  container.appendChild(el('div', { class: 'config-banner' }, [
    el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['Data source not connected yet']),
    'This dashboard reads two CSV feeds. In Google Sheets, open each tab (',
    el('code', {}, ['EU']), ' and ', el('code', {}, ['GrowthModel']),
    '), go to File → Share → Publish to web, choose that single sheet and CSV format, then paste the resulting URLs into ',
    el('code', {}, ['CONFIG.EU_CSV_URL']), ' and ', el('code', {}, ['CONFIG.GROWTHMODEL_CSV_URL']),
    ' at the top of index.html.',
  ]));
}

function showLoadErrorBanner(message) {
  const container = document.getElementById('pageContent');
  setPageHeader('Could not load data', 'There was a problem fetching the sheets');
  container.innerHTML = '';
  container.appendChild(el('div', { class: 'error-banner' }, [
    el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['Failed to load']),
    'Check that both sheets are published to the web (not just "shared"), that the URLs in CONFIG are correct, and that this file is being served over http(s) rather than opened directly as a local file. Details: ' + message,
  ]));
}

async function init() {
  renderNav();

  if (typeof Chart === 'undefined' || typeof Papa === 'undefined') {
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setPageHeader('Library failed to load', 'Chart.js or PapaParse did not load from the CDN');
    document.getElementById('pageContent').appendChild(el('div', { class: 'error-banner' }, [
      el('div', { style: 'font-weight:700; margin-bottom:6px;' }, ['Missing dependency']),
      `${typeof Chart === 'undefined' ? 'Chart.js' : 'PapaParse'} did not load. Check your internet connection, or that the <script> tags at the top of index.html haven't been blocked/modified, then refresh.`,
    ]));
    return;
  }

  await DataStore.load();
  await CommentsStore.load(); // non-fatal if this fails — comments feature just stays disabled

  document.getElementById('loadingOverlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  const statusDot = document.getElementById('dataStatusDot');
  const statusText = document.getElementById('dataStatusText');

  if (DataStore.loadError === 'CONFIG_MISSING') {
    statusDot.className = 'status-dot err'; statusText.textContent = 'Not configured';
    showConfigBanner();
    return;
  }
  if (DataStore.loadError) {
    statusDot.className = 'status-dot err'; statusText.textContent = 'Load failed';
    showLoadErrorBanner(DataStore.loadError);
    return;
  }

  statusDot.className = 'status-dot ok';
  statusText.textContent = `${DataStore.rawRows.length.toLocaleString()} rows · ${DataStore.weeks.length} weeks` + (DataStore.logisticsRows.length ? ` · ${DataStore.logisticsRows.length.toLocaleString()} logistics rows` : '');
  renderActivePage();
}

document.getElementById('menuBtn')?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// Close any open filter panel only when the click is genuinely outside a
// filter group — a single listener for the page's lifetime, so clicking a
// checkbox to select multiple values in one sitting no longer closes it.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.filter-group')) {
    document.querySelectorAll('.filter-panel.open').forEach(p => p.classList.remove('open'));
    Object.values(pageFilterStates).forEach(fs => { fs.openFilterKey = null; });
  }
});

document.getElementById('resetFiltersBtn')?.addEventListener('click', () => {
  const fs = pageFilterStates[activePageId];
  if (fs) fs.resetKeepCountryAndWeeks();
  renderActivePage();
});

init();
