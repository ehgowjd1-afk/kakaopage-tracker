const CATEGORIES = [
  { key: 'webnovel', label: '웹소설' },
  { key: 'webtoon', label: '웹툰' },
];
const PERIODS = [
  { key: 'daily', label: '일간' },
  { key: 'weekly', label: '주간' },
  { key: 'monthly', label: '월간' },
];
const GENRES = {
  webnovel: [
    { key: 'fantasy', label: '판타지' },
    { key: 'hyunpan', label: '현판' },
    { key: 'romance', label: '로맨스' },
    { key: 'romfantasy', label: '로판' },
    { key: 'wuxia', label: '무협' },
    { key: 'bl', label: 'BL' },
  ],
  webtoon: [
    { key: 'fantasy', label: '판타지' },
    { key: 'drama', label: '드라마' },
    { key: 'romance', label: '로맨스' },
    { key: 'romfantasy', label: '로판' },
    { key: 'wuxia', label: '무협' },
    { key: 'action', label: '액션' },
    { key: 'bl', label: 'BL' },
  ],
};
const CHANGE_LABEL = { up: '▲', down: '▼', same: '－', new: 'NEW' };

const app = document.getElementById('app');
const searchBox = document.getElementById('search-box');
const searchResults = document.getElementById('search-results');

let indexCache = null;
let worksCache = null;
let allLatestCache = null;

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch failed: ${url}`);
  return res.json();
}

async function getIndex() {
  if (!indexCache) indexCache = await fetchJson('data/index.json');
  return indexCache;
}

async function getWorksCache() {
  if (!worksCache) worksCache = await fetchJson('data/works.json').catch(() => ({}));
  return worksCache;
}

async function getAllLatest() {
  if (allLatestCache) return allLatestCache;
  const results = {};
  for (const cat of CATEGORIES) {
    for (const period of PERIODS) {
      const key = `${cat.key}/${period.key}`;
      results[key] = await fetchJson(`data/${key}/latest.json`).catch(() => []);
    }
  }
  allLatestCache = results;
  return results;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'work' && parts[1] && parts[2] && parts[3]) {
    return { view: 'work', cat: parts[1], period: parts[2], workId: parts[3] };
  }
  if (parts[0] === 'new') {
    return { view: 'new', cat: parts[1] || 'webnovel' };
  }
  if (parts[0] === 'highlights' && parts[1] && parts[2] && parts[3]) {
    return { view: 'highlights', cat: parts[1], period: parts[2], type: parts[3] };
  }
  if (parts[0] === 'keywords') {
    return { view: 'keywords', cat: parts[1] || 'webnovel' };
  }
  if (parts[0] === 'events') {
    return { view: 'events', cat: parts[1] || 'all' };
  }
  const cat = parts[1] || 'webnovel';
  const period = parts[2] || 'daily';
  const genre = parts[3] || 'all';
  return { view: 'list', cat, period, genre };
}

function navigate(hash) {
  location.hash = hash;
}

const NAV_TARGETS = {
  ranking: '#/list/webnovel/daily',
  new: '#/new/webnovel',
  keywords: '#/keywords/webnovel',
  events: '#/events/all',
};

function updateNavActive(route) {
  const map = { list: 'ranking', highlights: 'ranking', work: 'ranking', new: 'new', keywords: 'keywords', events: 'events' };
  const activeNav = map[route.view];
  document.querySelectorAll('#site-nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === activeNav);
  });
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('site-title').addEventListener('click', () => navigate('#/list/webnovel/daily'));
  document.querySelectorAll('#site-nav button').forEach((b) => {
    b.addEventListener('click', () => navigate(NAV_TARGETS[b.dataset.nav]));
  });
  render();
  setupSearch();
});

async function render() {
  const route = parseHash();
  updateNavActive(route);
  if (route.view === 'work') {
    await renderWorkView(route.cat, route.period, route.workId);
  } else if (route.view === 'new') {
    await renderNewReleasesView(route.cat);
  } else if (route.view === 'highlights') {
    await renderHighlightsView(route.cat, route.period, route.type);
  } else if (route.view === 'keywords') {
    await renderKeywordsView(route.cat);
  } else if (route.view === 'events') {
    await renderEventsView(route.cat);
  } else {
    await renderListView(route.cat, route.period, route.genre);
  }
}

function buildCatTabs(activeCat, hashPrefix) {
  const nav = document.createElement('nav');
  nav.className = 'tabs';
  const group = document.createElement('div');
  group.className = 'tabgroup';
  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.textContent = c.label;
    if (c.key === activeCat) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`${hashPrefix}/${c.key}`));
    group.appendChild(btn);
  }
  nav.appendChild(group);
  return nav;
}

async function renderKeywordsView(cat) {
  app.innerHTML = '';
  app.appendChild(buildCatTabs(cat, '#/keywords'));

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const works = await getWorksCache();

  let curGenre = 'all';
  let curPeriod = 'daily';
  let curScope = 300;

  // cache of loaded ranking lists keyed by "genre/period"
  const listCache = {};
  async function getList(genre, period) {
    const key = `${genre}/${period}`;
    if (!listCache[key]) {
      const path = genre === 'all' ? `${cat}/${period}` : `${cat}/genres/${genre}/${period}`;
      listCache[key] = await fetchJson(`data/${path}/latest.json`).catch(() => []);
    }
    return listCache[key];
  }

  body.innerHTML = '';

  // Genre selector
  const genreGroup = document.createElement('div');
  genreGroup.className = 'tabgroup';
  const genreOptions = [{ key: 'all', label: '전체' }, ...(GENRES[cat] || [])];
  for (const g of genreOptions) {
    const btn = document.createElement('button');
    btn.textContent = g.label;
    btn.dataset.g = g.key;
    btn.addEventListener('click', () => { curGenre = g.key; recompute(); });
    genreGroup.appendChild(btn);
  }
  const genreNav = document.createElement('nav');
  genreNav.className = 'tabs';
  genreNav.appendChild(genreGroup);
  body.appendChild(genreNav);

  // Period + scope controls
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:14px;';

  const periodGroup = document.createElement('div');
  periodGroup.className = 'tabgroup';
  for (const p of PERIODS) {
    const btn = document.createElement('button');
    btn.textContent = `${p.label}순위`;
    btn.dataset.p = p.key;
    btn.addEventListener('click', () => { curPeriod = p.key; recompute(); });
    periodGroup.appendChild(btn);
  }

  const scopeWrap = document.createElement('div');
  scopeWrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);';
  const scopeLabel = document.createElement('span');
  scopeLabel.textContent = 'TOP';
  const scopeInput = document.createElement('input');
  scopeInput.type = 'number';
  scopeInput.min = '1';
  scopeInput.max = '300';
  scopeInput.value = String(curScope);
  scopeInput.style.cssText =
    'width:74px;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none;';
  const applyScope = () => {
    let v = parseInt(scopeInput.value, 10);
    if (Number.isNaN(v)) v = 300;
    v = Math.max(1, Math.min(300, v));
    scopeInput.value = String(v);
    curScope = v;
    recompute();
  };
  scopeInput.addEventListener('change', applyScope);
  scopeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyScope(); });
  const scopeHint = document.createElement('span');
  scopeHint.textContent = '위까지 (1~300)';
  scopeWrap.appendChild(scopeLabel);
  scopeWrap.appendChild(scopeInput);
  scopeWrap.appendChild(scopeHint);

  controls.appendChild(periodGroup);
  controls.appendChild(scopeWrap);
  body.appendChild(controls);

  const note = document.createElement('div');
  note.className = 'updated-note';
  body.appendChild(note);

  const shareBox = document.createElement('div');
  shareBox.className = 'chart-box';
  shareBox.style.marginBottom = '18px';
  body.appendChild(shareBox);

  const coSection = document.createElement('div');
  coSection.className = 'chart-box';
  body.appendChild(coSection);

  let kwCount = new Map();
  let coCount = new Map();
  let analyzed = 0;
  let selectedKw = null;

  async function recompute() {
    genreGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.g === curGenre));
    periodGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.p === curPeriod));

    const fullList = await getList(curGenre, curPeriod);
    const list = fullList.slice(0, curScope);
    kwCount = new Map();
    coCount = new Map();
    analyzed = 0;
    for (const item of list) {
      const w = works[item.workId];
      if (!w || !w.keywords || !w.keywords.length) continue;
      analyzed += 1;
      const kws = [...new Set(w.keywords)];
      for (const k of kws) kwCount.set(k, (kwCount.get(k) || 0) + 1);
      for (let i = 0; i < kws.length; i++) {
        for (let j = i + 1; j < kws.length; j++) {
          const key = [kws[i], kws[j]].sort().join('||');
          coCount.set(key, (coCount.get(key) || 0) + 1);
        }
      }
    }

    const periodLabel = PERIODS.find((p) => p.key === curPeriod).label;
    const genreLabel = genreOptions.find((g) => g.key === curGenre).label;
    note.textContent = `${genreLabel} · ${periodLabel}순위 TOP ${curScope} 중 키워드 보유 ${analyzed}개 작품 기준 · 고유 키워드 ${kwCount.size}종`;

    const ranked = [...kwCount.entries()].sort((a, b) => b[1] - a[1]);
    shareBox.innerHTML = '';
    const h3 = document.createElement('h3');
    h3.style.cssText = 'font-size:14px;margin:0 0 12px;';
    h3.textContent = `키워드 비중 (상위 25종)`;
    shareBox.appendChild(h3);

    if (ranked.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hc-empty';
      empty.textContent = '이 범위에는 키워드 데이터가 없습니다.';
      shareBox.appendChild(empty);
      coSection.innerHTML = '';
      return;
    }

    if (!selectedKw || !kwCount.has(selectedKw)) selectedKw = ranked[0][0];
    const maxCount = ranked[0][1];
    for (const [kw, count] of ranked.slice(0, 25)) {
      const pct = ((count / analyzed) * 100).toFixed(1);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;cursor:pointer;';
      row.addEventListener('click', () => { selectedKw = kw; renderCoSection(); });
      const label = document.createElement('div');
      label.style.cssText = 'width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      label.textContent = `#${kw}`;
      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'flex:1;background:var(--bg);border-radius:6px;overflow:hidden;height:18px;';
      const bar = document.createElement('div');
      bar.style.cssText = `width:${(count / maxCount) * 100}%;background:var(--accent);height:100%;`;
      barWrap.appendChild(bar);
      const val = document.createElement('div');
      val.style.cssText = 'width:90px;flex-shrink:0;text-align:right;color:var(--text-dim);';
      val.textContent = `${count}개 (${pct}%)`;
      row.appendChild(label);
      row.appendChild(barWrap);
      row.appendChild(val);
      shareBox.appendChild(row);
    }
    renderCoSection();
  }

  function renderCoSection() {
    coSection.innerHTML = '';
    const title = document.createElement('h3');
    title.style.cssText = 'font-size:14px;margin:0 0 4px;';
    title.textContent = `#${selectedKw} 와(과) 함께 붙는 키워드`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:12px;';
    sub.textContent = `위 목록에서 다른 키워드를 누르면 그 키워드 기준으로 바뀝니다. (#${selectedKw} 포함 ${kwCount.get(selectedKw)}개 작품)`;
    coSection.appendChild(title);
    coSection.appendChild(sub);

    const partners = [];
    for (const [key, c] of coCount.entries()) {
      const [a, b] = key.split('||');
      if (a === selectedKw) partners.push([b, c]);
      else if (b === selectedKw) partners.push([a, c]);
    }
    partners.sort((x, y) => y[1] - x[1]);
    if (partners.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hc-empty';
      empty.textContent = '함께 나타나는 키워드가 없습니다.';
      coSection.appendChild(empty);
      return;
    }
    const base = kwCount.get(selectedKw);
    for (const [kw, c] of partners.slice(0, 15)) {
      const pct = ((c / base) * 100).toFixed(0);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;';
      const label = document.createElement('div');
      label.style.cssText = 'width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      label.textContent = `#${kw}`;
      const barWrap = document.createElement('div');
      barWrap.style.cssText = 'flex:1;background:var(--bg);border-radius:6px;overflow:hidden;height:18px;';
      const bar = document.createElement('div');
      bar.style.cssText = `width:${(c / partners[0][1]) * 100}%;background:var(--up);height:100%;`;
      barWrap.appendChild(bar);
      const val = document.createElement('div');
      val.style.cssText = 'width:110px;flex-shrink:0;text-align:right;color:var(--text-dim);';
      val.textContent = `${c}개 함께 (${pct}%)`;
      row.appendChild(label);
      row.appendChild(barWrap);
      row.appendChild(val);
      coSection.appendChild(row);
    }
  }

  recompute();
}

async function renderEventsView(tab) {
  app.innerHTML = '';

  const nav = document.createElement('nav');
  nav.className = 'tabs';
  const group = document.createElement('div');
  group.className = 'tabgroup';
  const eventTabs = [
    { key: 'all', label: '전체' },
    { key: 'webnovel', label: '웹소설' },
    { key: 'webtoon', label: '웹툰' },
  ];
  for (const t of eventTabs) {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    if (t.key === tab) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`#/events/${t.key}`));
    group.appendChild(btn);
  }
  nav.appendChild(group);
  app.appendChild(nav);

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const events = await fetchJson(`data/events/${tab}/latest.json`).catch(() => []);
  body.innerHTML = '';
  if (!events.length) {
    body.innerHTML = '<div class="empty-note">아직 수집된 이벤트가 없습니다.</div>';
    return;
  }

  const note = document.createElement('div');
  note.className = 'updated-note';
  note.textContent = `진행 중인 이벤트/프로모션 · 총 ${events.length}개`;
  body.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'event-grid';
  for (const ev of events) {
    const card = document.createElement('a');
    card.className = 'event-card';
    card.href = ev.link || '#';
    if (ev.link) { card.target = '_blank'; card.rel = 'noopener noreferrer'; }
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = ev.thumbnail || '';
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const t = document.createElement('div');
    t.className = 'event-title';
    t.textContent = ev.title || '(제목 없음)';
    const s = document.createElement('div');
    s.className = 'event-sub';
    s.textContent = ev.subtitle || '';
    meta.appendChild(t);
    meta.appendChild(s);
    card.appendChild(img);
    card.appendChild(meta);
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

function renderTabs(activeCat, activePeriod, activeGenre) {
  const nav = document.createElement('nav');
  nav.className = 'tabs';

  const catGroup = document.createElement('div');
  catGroup.className = 'tabgroup';
  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.textContent = c.label;
    if (c.key === activeCat) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`#/list/${c.key}/${activePeriod}`));
    catGroup.appendChild(btn);
  }

  const periodGroup = document.createElement('div');
  periodGroup.className = 'tabgroup';
  for (const p of PERIODS) {
    const btn = document.createElement('button');
    btn.textContent = p.label;
    if (p.key === activePeriod) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`#/list/${activeCat}/${p.key}/${activeGenre}`));
    periodGroup.appendChild(btn);
  }
  // 신작 sits right next to 월간
  const newBtn = document.createElement('button');
  newBtn.textContent = '신작';
  newBtn.addEventListener('click', () => navigate(`#/new/${activeCat}`));
  periodGroup.appendChild(newBtn);

  nav.appendChild(catGroup);
  nav.appendChild(periodGroup);

  const genreGroup = document.createElement('div');
  genreGroup.className = 'tabgroup';
  const allBtn = document.createElement('button');
  allBtn.textContent = '전체';
  if (activeGenre === 'all') allBtn.classList.add('active');
  allBtn.addEventListener('click', () => navigate(`#/list/${activeCat}/${activePeriod}/all`));
  genreGroup.appendChild(allBtn);
  for (const g of GENRES[activeCat] || []) {
    const btn = document.createElement('button');
    btn.textContent = g.label;
    if (g.key === activeGenre) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`#/list/${activeCat}/${activePeriod}/${g.key}`));
    genreGroup.appendChild(btn);
  }

  const genreNav = document.createElement('nav');
  genreNav.className = 'tabs';
  genreNav.appendChild(genreGroup);

  const wrapper = document.createElement('div');
  wrapper.appendChild(nav);
  wrapper.appendChild(genreNav);
  return wrapper;
}

async function renderListView(cat, period, genre = 'all') {
  app.innerHTML = '';
  app.appendChild(renderTabs(cat, period, genre));

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const isGenre = genre !== 'all';
  const dataPath = isGenre ? `${cat}/genres/${genre}/${period}` : `${cat}/${period}`;

  const [index, works] = await Promise.all([getIndex(), getWorksCache()]);
  const dates = isGenre
    ? (index.genres?.[cat]?.[genre]?.[period]) || []
    : (index[cat] && index[cat][period]) || [];
  if (dates.length === 0) {
    body.innerHTML = '<div class="empty-note">아직 수집된 데이터가 없습니다.</div>';
    return;
  }
  const latestDate = dates[dates.length - 1];
  const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;

  const [latest, prev] = await Promise.all([
    fetchJson(`data/${dataPath}/${latestDate}.json`),
    prevDate ? fetchJson(`data/${dataPath}/${prevDate}.json`) : Promise.resolve([]),
  ]);

  const prevIds = new Set(prev.map((it) => it.workId));
  const latestIds = new Set(latest.map((it) => it.workId));
  const prevRankMap = new Map(prev.map((it) => [it.workId, it.rank]));

  const newEntries = latest.filter((it) => !prevIds.has(it.workId)).slice(0, 5);
  const droppedOut = prev.filter((it) => !latestIds.has(it.workId)).slice(0, 5);
  const risers = latest
    .filter((it) => prevRankMap.has(it.workId) && prevRankMap.get(it.workId) - it.rank > 0)
    .map((it) => ({ ...it, riseAmount: prevRankMap.get(it.workId) - it.rank }))
    .sort((a, b) => b.riseAmount - a.riseAmount)
    .slice(0, 5);
  const fallers = latest
    .filter((it) => prevRankMap.has(it.workId) && it.rank - prevRankMap.get(it.workId) > 0)
    .map((it) => ({ ...it, fallAmount: it.rank - prevRankMap.get(it.workId) }))
    .sort((a, b) => b.fallAmount - a.fallAmount)
    .slice(0, 5);

  body.innerHTML = '';

  const note = document.createElement('div');
  note.className = 'updated-note';
  note.textContent = `${latestDate} 기준 · 총 ${latest.length}개` + (prevDate ? ` · 직전 수집일: ${prevDate}` : '');
  body.appendChild(note);

  if (!isGenre) {
    body.appendChild(buildGenreDistribution(latest));
  }

  const highlightRow = document.createElement('div');
  highlightRow.className = 'highlight-row';
  highlightRow.appendChild(
    buildHighlightCard('신규 진입', newEntries, (it) => `${it.rank}위`, () => navigate(`#/highlights/${cat}/${period}/new`))
  );
  highlightRow.appendChild(
    buildHighlightCard('순위권 이탈', droppedOut, () => '이탈', () => navigate(`#/highlights/${cat}/${period}/dropped`))
  );
  highlightRow.appendChild(
    buildHighlightCard('최고 급상승', risers, (it) => `▲${it.riseAmount}`, () => navigate(`#/highlights/${cat}/${period}/risers`))
  );
  highlightRow.appendChild(
    buildHighlightCard('최고 급하락', fallers, (it) => `▼${it.fallAmount}`, () => navigate(`#/highlights/${cat}/${period}/fallers`))
  );
  body.appendChild(highlightRow);

  const list = document.createElement('ol');
  list.className = 'rank-list';
  for (const item of latest) {
    list.appendChild(buildRankRow(item, cat, period, works[item.workId]));
  }
  body.appendChild(list);
}

const HIGHLIGHT_TYPES = {
  new: { label: '신규 진입' },
  dropped: { label: '순위권 이탈' },
  risers: { label: '최고 급상승' },
  fallers: { label: '최고 급하락' },
};

async function renderHighlightsView(cat, period, type) {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  const [index] = await Promise.all([getIndex()]);
  const dates = (index[cat] && index[cat][period]) || [];

  app.innerHTML = '';
  const back = document.createElement('nav');
  back.className = 'tabs';
  const backBtn = document.createElement('button');
  backBtn.textContent = '← 목록으로';
  backBtn.style.cssText =
    'border:1px solid var(--border);background:var(--card-bg);color:var(--text);padding:6px 12px;border-radius:20px;font-size:13px;cursor:pointer;';
  backBtn.addEventListener('click', () => navigate(`#/list/${cat}/${period}`));
  back.appendChild(backBtn);
  app.appendChild(back);

  const catLabel = CATEGORIES.find((c) => c.key === cat)?.label || cat;
  const periodLabel = PERIODS.find((p) => p.key === period)?.label || period;
  const typeInfo = HIGHLIGHT_TYPES[type] || { label: type };

  const title = document.createElement('h2');
  title.style.cssText = 'font-size:16px;margin:12px 0;';
  title.textContent = `${catLabel} · ${periodLabel} · ${typeInfo.label} 기록`;
  app.appendChild(title);

  if (dates.length < 2) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '아직 비교할 이전 수집 기록이 없습니다.';
    app.appendChild(empty);
    return;
  }

  const loading = document.createElement('div');
  loading.className = 'loading-note';
  loading.textContent = '기록을 불러오는 중...';
  app.appendChild(loading);

  const lists = await Promise.all(dates.map((d) => fetchJson(`data/${cat}/${period}/${d}.json`).catch(() => [])));
  loading.remove();

  for (let i = dates.length - 1; i >= 1; i--) {
    const latest = lists[i];
    const prev = lists[i - 1];
    const date = dates[i];
    const prevIds = new Set(prev.map((it) => it.workId));
    const latestIds = new Set(latest.map((it) => it.workId));
    const prevRankMap = new Map(prev.map((it) => [it.workId, it.rank]));

    let rows = [];
    if (type === 'new') {
      rows = latest
        .filter((it) => !prevIds.has(it.workId))
        .sort((a, b) => a.rank - b.rank)
        .map((it) => ({ ...it, rightText: `${it.rank}위 진입` }));
    } else if (type === 'dropped') {
      rows = prev
        .filter((it) => !latestIds.has(it.workId))
        .sort((a, b) => a.rank - b.rank)
        .map((it) => ({ ...it, rightText: `${it.rank}위에서 이탈` }));
    } else if (type === 'risers') {
      rows = latest
        .filter((it) => prevRankMap.has(it.workId) && prevRankMap.get(it.workId) - it.rank > 0)
        .map((it) => ({ ...it, amount: prevRankMap.get(it.workId) - it.rank }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 20)
        .map((it) => ({ ...it, rightText: `▲${it.amount} (${it.rank}위)` }));
    } else if (type === 'fallers') {
      rows = latest
        .filter((it) => prevRankMap.has(it.workId) && it.rank - prevRankMap.get(it.workId) > 0)
        .map((it) => ({ ...it, amount: it.rank - prevRankMap.get(it.workId) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 20)
        .map((it) => ({ ...it, rightText: `▼${it.amount} (${it.rank}위)` }));
    }

    const section = document.createElement('div');
    section.style.marginBottom = '16px';
    const h3 = document.createElement('h3');
    h3.style.cssText = 'font-size:13px;color:var(--text-dim);margin:0 0 8px;';
    h3.textContent = `${date} (전날 대비) · ${rows.length}개`;
    section.appendChild(h3);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hc-empty';
      empty.textContent = '해당 없음';
      section.appendChild(empty);
    } else {
      const list = document.createElement('ol');
      list.className = 'rank-list';
      for (const it of rows) {
        list.appendChild(buildHighlightHistoryRow(it, cat, period));
      }
      section.appendChild(list);
    }
    app.appendChild(section);
  }
}

function buildHighlightHistoryRow(item, cat, period) {
  const li = document.createElement('li');
  li.className = 'rank-row';
  li.addEventListener('click', () => navigate(`#/work/${cat}/${period}/${item.workId}`));

  const thumb = document.createElement('img');
  thumb.className = 'rank-thumb';
  thumb.loading = 'lazy';
  thumb.src = item.thumbnail || '';
  thumb.alt = '';

  const info = document.createElement('div');
  info.className = 'rank-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'rank-title';
  titleEl.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'rank-sub';
  sub.textContent = item.subCategory || '';
  info.appendChild(titleEl);
  info.appendChild(sub);

  const right = document.createElement('div');
  right.style.cssText = 'font-size:12px;color:var(--text-dim);flex-shrink:0;white-space:nowrap;';
  right.textContent = item.rightText;

  li.appendChild(thumb);
  li.appendChild(info);
  li.appendChild(right);
  return li;
}

async function renderNewReleasesView(cat) {
  app.innerHTML = '';

  const nav = document.createElement('nav');
  nav.className = 'tabs';
  const catGroup = document.createElement('div');
  catGroup.className = 'tabgroup';
  for (const c of CATEGORIES) {
    const btn = document.createElement('button');
    btn.textContent = c.label;
    if (c.key === cat) btn.classList.add('active');
    btn.addEventListener('click', () => navigate(`#/new/${c.key}`));
    catGroup.appendChild(btn);
  }
  nav.appendChild(catGroup);
  app.appendChild(nav);

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const [items, works] = await Promise.all([
    fetchJson(`data/${cat}/new-releases/latest.json`).catch(() => []),
    getWorksCache(),
  ]);

  body.innerHTML = '';
  if (items.length === 0) {
    body.innerHTML = '<div class="empty-note">아직 수집된 신작 데이터가 없습니다.</div>';
    return;
  }

  const note = document.createElement('div');
  note.className = 'updated-note';
  note.textContent = `최근 30일 신작 · 총 ${items.length}개`;
  body.appendChild(note);

  const byDate = new Map();
  for (const it of items) {
    const key = it.date || '날짜 미상';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(it);
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  for (const date of dates) {
    const section = document.createElement('div');
    section.style.marginBottom = '16px';
    const h3 = document.createElement('h3');
    h3.style.cssText = 'font-size:13px;color:var(--text-dim);margin:0 0 8px;';
    h3.textContent = date;
    section.appendChild(h3);

    const list = document.createElement('ol');
    list.className = 'rank-list';
    for (const it of byDate.get(date)) {
      list.appendChild(buildNewReleaseRow(it, cat, works[it.workId]));
    }
    section.appendChild(list);
    body.appendChild(section);
  }
}

function buildNewReleaseRow(item, cat, workMeta) {
  const li = document.createElement('li');
  li.className = 'rank-row';
  li.addEventListener('click', () => navigate(`#/work/${cat}/daily/${item.workId}`));

  const thumb = document.createElement('img');
  thumb.className = 'rank-thumb';
  thumb.loading = 'lazy';
  thumb.src = item.thumbnail || '';
  thumb.alt = '';

  const info = document.createElement('div');
  info.className = 'rank-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'rank-title';
  titleEl.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'rank-sub';
  const badges = [];
  if (item.subCategory) badges.push(item.subCategory);
  if (workMeta && workMeta.author) badges.push(workMeta.author);
  sub.textContent = badges.join(' · ');
  info.appendChild(titleEl);
  info.appendChild(sub);

  li.appendChild(thumb);
  li.appendChild(info);
  return li;
}

function buildGenreDistribution(items) {
  const counts = new Map();
  for (const it of items) {
    const key = it.subCategory || '기타';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = items.length;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const box = document.createElement('div');
  box.className = 'chart-box';
  box.style.marginBottom = '18px';
  const h3 = document.createElement('h3');
  h3.style.cssText = 'font-size:13px;color:var(--text-dim);margin:0 0 10px;';
  h3.textContent = 'TOP 300 장르 분포';
  box.appendChild(h3);

  for (const [genre, count] of rows) {
    const pct = ((count / total) * 100).toFixed(1);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;';
    const label = document.createElement('div');
    label.style.cssText = 'width:56px;flex-shrink:0;color:var(--text-dim);';
    label.textContent = genre;
    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'flex:1;background:var(--bg);border-radius:6px;overflow:hidden;height:16px;';
    const bar = document.createElement('div');
    bar.style.cssText = `width:${pct}%;background:var(--accent);height:100%;`;
    barWrap.appendChild(bar);
    const value = document.createElement('div');
    value.style.cssText = 'width:84px;flex-shrink:0;text-align:right;color:var(--text-dim);';
    value.textContent = `${count}개 (${pct}%)`;
    row.appendChild(label);
    row.appendChild(barWrap);
    row.appendChild(value);
    box.appendChild(row);
  }
  return box;
}

function buildHighlightCard(title, items, rightTextFn, onClick) {
  const card = document.createElement('div');
  card.className = 'highlight-card';
  if (onClick) card.addEventListener('click', onClick);
  const h3 = document.createElement('h3');
  h3.textContent = onClick ? `${title} ›` : title;
  card.appendChild(h3);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hc-empty';
    empty.textContent = '해당 없음';
    card.appendChild(empty);
  } else {
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'hc-item';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = it.title;
      const r = document.createElement('span');
      r.textContent = rightTextFn(it);
      row.appendChild(t);
      row.appendChild(r);
      card.appendChild(row);
    }
  }
  return card;
}

function buildRankRow(item, cat, period, workMeta) {
  const li = document.createElement('li');
  li.className = 'rank-row';
  li.addEventListener('click', () => navigate(`#/work/${cat}/${period}/${item.workId}`));

  const num = document.createElement('div');
  num.className = 'rank-num';
  num.textContent = item.rank;

  const thumb = document.createElement('img');
  thumb.className = 'rank-thumb';
  thumb.loading = 'lazy';
  thumb.src = item.thumbnail || '';
  thumb.alt = '';

  const info = document.createElement('div');
  info.className = 'rank-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'rank-title';
  titleEl.textContent = item.title;
  const sub = document.createElement('div');
  sub.className = 'rank-sub';
  const badges = [];
  if (item.waitFree) badges.push(item.waitFreeType || '기다무');
  if (item.subCategory) badges.push(item.subCategory);
  if (workMeta && workMeta.author) badges.push(workMeta.author);
  sub.textContent = badges.join(' · ');
  info.appendChild(titleEl);
  info.appendChild(sub);

  const change = document.createElement('div');
  const type = item.change ? item.change.type : 'same';
  change.className = `change ${type}`;
  if (type === 'up' || type === 'down') {
    change.textContent = `${CHANGE_LABEL[type]}${item.change.amount ?? ''}`;
  } else {
    change.textContent = CHANGE_LABEL[type] || '－';
  }

  li.appendChild(num);
  li.appendChild(thumb);
  li.appendChild(info);
  li.appendChild(change);
  return li;
}

function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function buildRankSeries(cat, period, workId, dates) {
  const series = [];
  let latestItem = null;
  for (const date of dates) {
    const dayList = await fetchJson(`data/${cat}/${period}/${date}.json`).catch(() => []);
    const found = dayList.find((it) => it.workId === workId);
    series.push({ date, rank: found ? found.rank : null, change: found ? found.change : null });
    if (found) latestItem = found;
  }

  const firstReal = series.find((p) => p.rank != null);
  if (firstReal && firstReal.change && ['up', 'down', 'same'].includes(firstReal.change.type)) {
    const prevRank =
      firstReal.change.type === 'up'
        ? firstReal.rank + firstReal.change.amount
        : firstReal.change.type === 'down'
          ? firstReal.rank - firstReal.change.amount
          : firstReal.rank;
    if (prevRank >= 1) {
      // Kakao recalculates all three ranking types (daily/weekly/monthly) every
      // day as rolling windows, so "change" always compares to the previous
      // day's snapshot of that same ranking type -- never a week/month back.
      series.unshift({
        date: shiftDateStr(firstReal.date, -1),
        rank: prevRank,
        change: null,
        estimated: true,
      });
    }
  }

  return { series, latestItem };
}

async function renderWorkView(cat, period, workId) {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';

  const [index, works] = await Promise.all([getIndex(), getWorksCache()]);
  const meta = works[workId] || {};

  const seriesByPeriod = {};
  let latestItem = null;
  for (const p of PERIODS) {
    const dates = (index[cat] && index[cat][p.key]) || [];
    const result = await buildRankSeries(cat, p.key, workId, dates);
    seriesByPeriod[p.key] = result.series;
    if (p.key === period && result.latestItem) latestItem = result.latestItem;
    if (!latestItem && result.latestItem) latestItem = result.latestItem;
  }

  const viewDates = (index.viewcounts && index.viewcounts[cat]) || [];
  const viewSeries = [];
  for (const date of viewDates) {
    const dayList = await fetchJson(`data/${cat}/viewcounts/${date}.json`).catch(() => []);
    const found = dayList.find((it) => it.workId === workId);
    viewSeries.push({ date, value: found ? parseCount(found.viewCount) : null });
  }

  app.innerHTML = '';
  const back = document.createElement('nav');
  back.className = 'tabs';
  const backBtn = document.createElement('button');
  backBtn.textContent = '← 목록으로';
  backBtn.style.cssText = 'border:1px solid var(--border);background:var(--card-bg);color:var(--text);padding:6px 12px;border-radius:20px;font-size:13px;cursor:pointer;';
  backBtn.addEventListener('click', () => navigate(`#/list/${cat}/${period}`));
  back.appendChild(backBtn);
  app.appendChild(back);

  const header = document.createElement('div');
  header.className = 'work-header';
  const img = document.createElement('img');
  img.src = (latestItem && latestItem.thumbnail) || '';
  header.appendChild(img);

  const infoDiv = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.textContent = (latestItem && latestItem.title) || meta.title || workId;
  infoDiv.appendChild(h2);

  if (meta.author) infoDiv.appendChild(metaLine(`작가: ${meta.author}`));
  if (meta.launchDate) infoDiv.appendChild(metaLine(`런칭일: ${meta.launchDate}`));
  if (meta.classification) infoDiv.appendChild(metaLine(`분류: ${meta.classification}`));
  if (meta.serialStatus) infoDiv.appendChild(metaLine(`연재 상태: ${meta.serialStatus}`));
  if (meta.publisher) infoDiv.appendChild(metaLine(`발행자: ${meta.publisher}`));
  if (meta.viewCount) infoDiv.appendChild(metaLine(`누적 조회수: ${meta.viewCount}`));
  if (meta.rating) infoDiv.appendChild(metaLine(`평점: ${meta.rating}`));
  if (meta.totalCommentText) infoDiv.appendChild(metaLine(`전체 댓글 수: ${meta.totalCommentText}`));

  const novelSource = (meta.sameWorkVersions || []).find((v) => v.category === '웹소설');
  if (novelSource) {
    const line = metaLine('원작: 웹소설 ');
    const link = document.createElement('a');
    link.textContent = novelSource.title;
    link.href = `#/work/webnovel/daily/${novelSource.workId}`;
    link.style.cssText = 'color:var(--accent);text-decoration:underline;';
    line.appendChild(link);
    infoDiv.appendChild(line);
  }
  const otherVersions = (meta.sameWorkVersions || []).filter((v) => v !== novelSource);
  if (otherVersions.length) {
    infoDiv.appendChild(metaLine(`다른 형태로도 있음: ${otherVersions.map((v) => `${v.category} <${v.title}>`).join(', ')}`));
  }

  if (meta.commentKeywords && meta.commentKeywords.length) {
    const kwDiv = document.createElement('div');
    kwDiv.className = 'work-keywords';
    const label = document.createElement('div');
    label.className = 'work-meta';
    label.textContent = '댓글 반응 키워드:';
    infoDiv.appendChild(label);
    for (const kw of meta.commentKeywords) {
      const span = document.createElement('span');
      span.textContent = `${kw.word} (${kw.count})`;
      kwDiv.appendChild(span);
    }
    infoDiv.appendChild(kwDiv);
  }

  if (meta.keywords && meta.keywords.length) {
    const kwDiv = document.createElement('div');
    kwDiv.className = 'work-keywords';
    for (const kw of meta.keywords) {
      const span = document.createElement('span');
      span.textContent = `#${kw}`;
      kwDiv.appendChild(span);
    }
    infoDiv.appendChild(kwDiv);
  }
  if (meta.synopsis) {
    const syn = document.createElement('div');
    syn.className = 'work-synopsis';
    syn.textContent = meta.synopsis;
    infoDiv.appendChild(syn);
  }

  header.appendChild(infoDiv);
  app.appendChild(header);

  if (meta.topComments && meta.topComments.length) {
    app.appendChild(buildCommentsBox(meta.topComments.slice(0, 5)));
  }

  const rankTypeRow = document.createElement('div');
  rankTypeRow.className = 'tabs';
  const rankTypeGroup = document.createElement('div');
  rankTypeGroup.className = 'tabgroup';
  let currentPeriod = period;

  const rankLabel = document.createElement('h3');
  rankLabel.style.cssText = 'font-size:13px;color:var(--text-dim);margin:16px 0 8px;';
  rankLabel.textContent = '랭킹 순위 추이';

  const currentRankSummary = document.createElement('div');
  currentRankSummary.className = 'rank-summary';
  for (const p of PERIODS) {
    const s = seriesByPeriod[p.key];
    const lastReal = [...s].reverse().find((pt) => pt.rank != null);
    const cell = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'rs-label';
    label.textContent = `${p.label} 랭킹`;
    const value = document.createElement('div');
    value.className = 'rs-value';
    value.textContent = lastReal ? `${lastReal.rank}위` : '순위권 밖';
    cell.appendChild(label);
    cell.appendChild(value);
    currentRankSummary.appendChild(cell);
  }

  const controls = document.createElement('div');
  controls.className = 'chart-controls';
  const chartBox = document.createElement('div');
  chartBox.className = 'chart-box';
  const chartNote = document.createElement('div');
  chartNote.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:6px;';
  const viewChartBox = document.createElement('div');
  viewChartBox.className = 'chart-box';

  function redraw() {
    rankTypeGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.p === currentPeriod));

    const activeSeries = seriesByPeriod[currentPeriod];
    chartBox.innerHTML = '';
    chartBox.appendChild(buildChart(activeSeries));
    const hasEstimated = activeSeries.some((p) => p.estimated);
    chartNote.textContent = hasEstimated
      ? '※ 맨 왼쪽 점은 수집 시작일의 순위 변동폭으로 역산한 추정치예요.'
      : '';

    viewChartBox.innerHTML = '';
    viewChartBox.appendChild(buildViewCountChart(viewSeries));
  }

  for (const p of PERIODS) {
    const btn = document.createElement('button');
    btn.textContent = `${p.label} 추이`;
    btn.dataset.p = p.key;
    btn.addEventListener('click', () => { currentPeriod = p.key; redraw(); });
    rankTypeGroup.appendChild(btn);
  }
  rankTypeRow.appendChild(rankTypeGroup);

  const dlBtn = document.createElement('button');
  dlBtn.className = 'dl-btn';
  dlBtn.textContent = '엑셀 다운로드 (.xlsx)';
  dlBtn.addEventListener('click', () =>
    downloadExcelAllPeriods(seriesByPeriod, (latestItem && latestItem.title) || workId, cat)
  );

  controls.appendChild(dlBtn);
  app.appendChild(rankLabel);
  app.appendChild(currentRankSummary);
  app.appendChild(rankTypeRow);
  app.appendChild(controls);
  app.appendChild(chartBox);
  app.appendChild(chartNote);
  if (viewSeries.some((p) => p.value != null)) {
    const viewLabel = document.createElement('h3');
    viewLabel.style.cssText = 'font-size:13px;color:var(--text-dim);margin:16px 0 8px;';
    viewLabel.textContent = '누적 조회수 추이';
    app.appendChild(viewLabel);
    app.appendChild(viewChartBox);
  }
  redraw();
}

function metaLine(text) {
  const div = document.createElement('div');
  div.className = 'work-meta';
  div.textContent = text;
  return div;
}

function buildCommentsBox(comments) {
  const box = document.createElement('div');
  box.className = 'chart-box';
  const title = document.createElement('h3');
  title.style.cssText = 'font-size:13px;color:var(--text-dim);margin:0 0 10px;';
  title.textContent = '인기 댓글';
  box.appendChild(title);
  for (const c of comments) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:13px;';
    const head = document.createElement('div');
    head.style.cssText = 'color:var(--text-dim);font-size:12px;margin-bottom:4px;';
    head.textContent = `${c.author || '익명'} · ${c.episode || ''} · 👍${c.likeCount || 0}`;
    const body = document.createElement('div');
    body.style.whiteSpace = 'pre-wrap';
    body.textContent = c.text || '';
    row.appendChild(head);
    row.appendChild(body);
    box.appendChild(row);
  }
  return box;
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function aggregateSeries(series, granularity, valueKey = 'rank', pickBest = (a, b) => a < b) {
  if (granularity === 'daily') return series;
  const buckets = new Map();
  for (const pt of series) {
    if (pt[valueKey] == null) continue;
    const d = new Date(pt.date);
    let key;
    if (granularity === 'weekly') key = isoWeekKey(d);
    else if (granularity === 'monthly') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    else key = `${d.getFullYear()}`;
    const cur = buckets.get(key);
    if (!cur || pickBest(pt[valueKey], cur[valueKey])) buckets.set(key, { date: pt.date, [valueKey]: pt[valueKey] });
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildChart(series) {
  return buildLineChart(series, {
    valueKey: 'rank',
    higherIsBetter: false,
    formatValue: (v) => `${v}위`,
    emptyText: '표시할 순위 기록이 없습니다.',
  });
}

function buildViewCountChart(series) {
  return buildLineChart(series, {
    valueKey: 'value',
    higherIsBetter: true,
    formatValue: formatCount,
    emptyText: '표시할 조회수 기록이 없습니다.',
  });
}

function buildLineChart(series, { valueKey, higherIsBetter, formatValue, emptyText }) {
  const points = series.filter((p) => p[valueKey] != null);
  if (points.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-note';
    div.textContent = emptyText;
    return div;
  }
  const width = 800;
  const height = 280;
  const padL = 54;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const values = points.map((p) => p[valueKey]);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const flat = lo === hi; // every point has the same value (e.g. always 1위)
  if (flat) {
    // widen symmetrically so the flat line sits in the middle instead of the top edge
    lo = lo - 1;
    hi = hi + 1;
  }

  const n = series.length;
  const xFor = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (v) => {
    const t = (v - lo) / (hi - lo);
    return higherIsBetter ? padT + (1 - t) * plotH : padT + t * plotH;
  };

  let pathD = '';
  let started = false;
  const dots = [];
  series.forEach((pt, i) => {
    if (pt[valueKey] == null) { started = false; return; }
    const x = xFor(i);
    const y = yFor(pt[valueKey]);
    pathD += started ? ` L ${x} ${y}` : `M ${x} ${y}`;
    started = true;
    dots.push({ x, y, pt });
  });

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const axisColor = 'var(--border)';
  const gridline = document.createElementNS(svgNS, 'line');
  gridline.setAttribute('x1', padL); gridline.setAttribute('x2', width - padR);
  gridline.setAttribute('y1', padT); gridline.setAttribute('y2', padT);
  gridline.setAttribute('stroke', axisColor);
  svg.appendChild(gridline);

  const axisTicks = flat ? [points[0][valueKey]] : [lo, hi];
  axisTicks.forEach((v) => {
    const y = yFor(v);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', 4);
    text.setAttribute('y', y + 4);
    text.setAttribute('font-size', '11');
    text.setAttribute('fill', 'var(--text-dim)');
    text.textContent = formatValue(v);
    svg.appendChild(text);
  });

  const firstLast = [series[0], series[series.length - 1]];
  firstLast.forEach((pt, idx) => {
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', idx === 0 ? padL : width - padR);
    text.setAttribute('y', height - 8);
    text.setAttribute('font-size', '11');
    text.setAttribute('fill', 'var(--text-dim)');
    text.setAttribute('text-anchor', idx === 0 ? 'start' : 'end');
    text.textContent = pt.date;
    svg.appendChild(text);
  });

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--accent)');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  const labelEvery = dots.length <= 15 ? 1 : Math.ceil(dots.length / 15);
  dots.forEach((d, idx) => {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', d.x);
    c.setAttribute('cy', d.y);
    c.setAttribute('r', 3);
    c.setAttribute('fill', 'var(--accent)');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${d.pt.date}: ${formatValue(d.pt[valueKey])}`;
    c.appendChild(title);
    svg.appendChild(c);

    if (idx % labelEvery === 0) {
      const above = d.y > padT + 14;
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', d.x);
      label.setAttribute('y', above ? d.y - 8 : d.y + 16);
      label.setAttribute('font-size', '11');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', 'var(--accent)');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = formatValue(d.pt[valueKey]);
      svg.appendChild(label);
    }
  });

  return svg;
}

function parseCount(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '').trim();
  const match = cleaned.match(/^([\d.]+)\s*(억|만|천)?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (Number.isNaN(num)) return null;
  const unit = match[2];
  if (unit === '억') return num * 100000000;
  if (unit === '만') return num * 10000;
  if (unit === '천') return num * 1000;
  return num;
}

function formatCount(n) {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  return `${Math.round(n)}`;
}

function downloadExcelAllPeriods(seriesByPeriod, title, cat) {
  const wb = XLSX.utils.book_new();
  for (const p of PERIODS) {
    const series = seriesByPeriod[p.key] || [];
    const rows = [['날짜', '순위', '비고']];
    for (const pt of series) {
      rows.push([pt.date, pt.rank ?? '', pt.estimated ? '추정치' : '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, `${p.label}추이`.slice(0, 31));
  }
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  XLSX.writeFile(wb, `${safeTitle}_${cat}_순위추이.xlsx`);
}

function setupSearch() {
  let debounceTimer = null;
  searchBox.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchBox.value.trim();
    if (!q) { searchResults.classList.remove('open'); searchResults.innerHTML = ''; return; }
    debounceTimer = setTimeout(() => runSearch(q), 200);
  });
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchBox) {
      searchResults.classList.remove('open');
    }
  });
}

async function runSearch(query) {
  const [all, works] = await Promise.all([getAllLatest(), getWorksCache()]);
  const q = query.toLowerCase();
  const seen = new Map();
  for (const [key, list] of Object.entries(all)) {
    const [cat, period] = key.split('/');
    for (const item of list) {
      if (seen.has(item.workId)) continue;
      const author = (works[item.workId] && works[item.workId].author) || '';
      const title = item.title || '';
      if (title.toLowerCase().includes(q) || author.toLowerCase().includes(q)) {
        seen.set(item.workId, { ...item, cat, period });
      }
    }
    if (seen.size >= 20) break;
  }

  searchResults.innerHTML = '';
  const items = [...seen.values()].slice(0, 20);
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sr-item';
    empty.textContent = '수집된 데이터 안에는 검색 결과가 없습니다.';
    searchResults.appendChild(empty);
  } else {
    for (const it of items) {
      const div = document.createElement('div');
      div.className = 'sr-item';
      const img = document.createElement('img');
      img.src = it.thumbnail || '';
      const meta = document.createElement('div');
      const titleDiv = document.createElement('div');
      titleDiv.textContent = it.title;
      const subDiv = document.createElement('div');
      subDiv.className = 'sr-meta';
      const catLabel = CATEGORIES.find((c) => c.key === it.cat)?.label || it.cat;
      const periodLabel = PERIODS.find((p) => p.key === it.period)?.label || it.period;
      subDiv.textContent = `${catLabel} · ${periodLabel} ${it.rank}위`;
      meta.appendChild(titleDiv);
      meta.appendChild(subDiv);
      div.appendChild(img);
      div.appendChild(meta);
      div.addEventListener('click', () => {
        searchResults.classList.remove('open');
        searchBox.value = '';
        navigate(`#/work/${it.cat}/${it.period}/${it.workId}`);
      });
      searchResults.appendChild(div);
    }
  }

  const kakaoLink = document.createElement('a');
  kakaoLink.className = 'sr-item';
  kakaoLink.href = `https://page.kakao.com/search?query=${encodeURIComponent(query)}`;
  kakaoLink.target = '_blank';
  kakaoLink.rel = 'noopener noreferrer';
  kakaoLink.style.cssText = 'color:var(--accent);justify-content:center;font-weight:600;';
  kakaoLink.textContent = `🔍 카카오페이지에서 "${query}" 검색하기`;
  searchResults.appendChild(kakaoLink);

  searchResults.classList.add('open');
}
