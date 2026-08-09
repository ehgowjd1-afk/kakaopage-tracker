const CATEGORIES = [
  { key: 'webnovel', label: '웹소설' },
  { key: 'webtoon', label: '웹툰' },
];
const PERIODS = [
  { key: 'realtime', label: '실시간' },
  { key: 'daily', label: '일간' },
  { key: 'weekly', label: '주간' },
  { key: 'monthly', label: '월간' },
];
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
  const cat = parts[1] || 'webnovel';
  const period = parts[2] || 'realtime';
  return { view: 'list', cat, period };
}

function navigate(hash) {
  location.hash = hash;
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('site-title').addEventListener('click', () => navigate('#/list/webnovel/realtime'));
  render();
  setupSearch();
});

async function render() {
  const route = parseHash();
  if (route.view === 'work') {
    await renderWorkView(route.cat, route.period, route.workId);
  } else {
    await renderListView(route.cat, route.period);
  }
}

function renderTabs(activeCat, activePeriod) {
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
    btn.addEventListener('click', () => navigate(`#/list/${activeCat}/${p.key}`));
    periodGroup.appendChild(btn);
  }

  nav.appendChild(catGroup);
  nav.appendChild(periodGroup);
  return nav;
}

async function renderListView(cat, period) {
  app.innerHTML = '';
  app.appendChild(renderTabs(cat, period));

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const [index, works] = await Promise.all([getIndex(), getWorksCache()]);
  const dates = (index[cat] && index[cat][period]) || [];
  if (dates.length === 0) {
    body.innerHTML = '<div class="empty-note">아직 수집된 데이터가 없습니다.</div>';
    return;
  }
  const latestDate = dates[dates.length - 1];
  const prevDate = dates.length > 1 ? dates[dates.length - 2] : null;

  const [latest, prev] = await Promise.all([
    fetchJson(`data/${cat}/${period}/${latestDate}.json`),
    prevDate ? fetchJson(`data/${cat}/${period}/${prevDate}.json`) : Promise.resolve([]),
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

  body.innerHTML = '';

  const note = document.createElement('div');
  note.className = 'updated-note';
  note.textContent = `${latestDate} 기준 · 총 ${latest.length}개` + (prevDate ? ` · 직전 수집일: ${prevDate}` : '');
  body.appendChild(note);

  const highlightRow = document.createElement('div');
  highlightRow.className = 'highlight-row';
  highlightRow.appendChild(buildHighlightCard('신규 진입', newEntries, (it) => `${it.rank}위`));
  highlightRow.appendChild(buildHighlightCard('순위권 이탈', droppedOut, () => '이탈'));
  highlightRow.appendChild(buildHighlightCard('최고 급상승', risers, (it) => `▲${it.riseAmount}`));
  body.appendChild(highlightRow);

  const list = document.createElement('ol');
  list.className = 'rank-list';
  for (const item of latest) {
    list.appendChild(buildRankRow(item, cat, period, works[item.workId]));
  }
  body.appendChild(list);
}

function buildHighlightCard(title, items, rightTextFn) {
  const card = document.createElement('div');
  card.className = 'highlight-card';
  const h3 = document.createElement('h3');
  h3.textContent = title;
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

async function renderWorkView(cat, period, workId) {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';

  const [index, works] = await Promise.all([getIndex(), getWorksCache()]);
  const meta = works[workId] || {};
  const dates = (index[cat] && index[cat][period]) || [];

  const series = [];
  let latestItem = null;
  for (const date of dates) {
    const dayList = await fetchJson(`data/${cat}/${period}/${date}.json`).catch(() => []);
    const found = dayList.find((it) => it.workId === workId);
    series.push({ date, rank: found ? found.rank : null });
    if (found) latestItem = found;
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
    link.href = `#/work/webnovel/realtime/${novelSource.workId}`;
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

  const controls = document.createElement('div');
  controls.className = 'chart-controls';
  const tabgroup = document.createElement('div');
  tabgroup.className = 'tabgroup';
  const granularities = [
    { key: 'daily', label: '일간' },
    { key: 'weekly', label: '주간' },
    { key: 'monthly', label: '월간' },
    { key: 'yearly', label: '연간' },
  ];
  let currentGran = 'daily';
  const chartBox = document.createElement('div');
  chartBox.className = 'chart-box';

  function redraw() {
    tabgroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.g === currentGran));
    chartBox.innerHTML = '';
    const agg = aggregateSeries(series, currentGran);
    chartBox.appendChild(buildChart(agg));
  }

  for (const g of granularities) {
    const btn = document.createElement('button');
    btn.textContent = g.label;
    btn.dataset.g = g.key;
    btn.addEventListener('click', () => { currentGran = g.key; redraw(); });
    tabgroup.appendChild(btn);
  }

  const dlBtn = document.createElement('button');
  dlBtn.className = 'dl-btn';
  dlBtn.textContent = '엑셀 다운로드 (.xlsx)';
  dlBtn.addEventListener('click', () => downloadExcel(series, (latestItem && latestItem.title) || workId, cat, period));

  controls.appendChild(tabgroup);
  controls.appendChild(dlBtn);
  app.appendChild(controls);
  app.appendChild(chartBox);
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

function aggregateSeries(series, granularity) {
  if (granularity === 'daily') return series;
  const buckets = new Map();
  for (const pt of series) {
    if (pt.rank == null) continue;
    const d = new Date(pt.date);
    let key;
    if (granularity === 'weekly') key = isoWeekKey(d);
    else if (granularity === 'monthly') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    else key = `${d.getFullYear()}`;
    const cur = buckets.get(key);
    if (!cur || pt.rank < cur.rank) buckets.set(key, { date: pt.date, rank: pt.rank });
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildChart(series) {
  const points = series.filter((p) => p.rank != null);
  if (points.length === 0) {
    const div = document.createElement('div');
    div.className = 'empty-note';
    div.textContent = '표시할 순위 기록이 없습니다.';
    return div;
  }
  const width = 800;
  const height = 280;
  const padL = 44;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const ranks = points.map((p) => p.rank);
  let minRank = Math.min(...ranks);
  let maxRank = Math.max(...ranks);
  if (minRank === maxRank) { minRank = Math.max(1, minRank - 1); maxRank = maxRank + 1; }

  const n = series.length;
  const xFor = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (rank) => padT + ((rank - minRank) / (maxRank - minRank)) * plotH;

  let pathD = '';
  let started = false;
  const dots = [];
  series.forEach((pt, i) => {
    if (pt.rank == null) { started = false; return; }
    const x = xFor(i);
    const y = yFor(pt.rank);
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

  [minRank, maxRank].forEach((r) => {
    const y = yFor(r);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', 4);
    text.setAttribute('y', y + 4);
    text.setAttribute('font-size', '11');
    text.setAttribute('fill', 'var(--text-dim)');
    text.textContent = `${r}위`;
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

  for (const d of dots) {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', d.x);
    c.setAttribute('cy', d.y);
    c.setAttribute('r', 3);
    c.setAttribute('fill', 'var(--accent)');
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${d.pt.date}: ${d.pt.rank}위`;
    c.appendChild(title);
    svg.appendChild(c);
  }

  return svg;
}

function downloadExcel(series, title, cat, period) {
  const rows = [['날짜', '순위']];
  for (const pt of series) rows.push([pt.date, pt.rank ?? '']);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  const sheetName = `${period}랭킹`.slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  XLSX.writeFile(wb, `${safeTitle}_${cat}_${period}_순위추이.xlsx`);
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
