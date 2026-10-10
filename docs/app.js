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
let promoPeriodsCache = null;

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

// Lightweight work metadata (author/keywords/classification/viewCount…) WITHOUT
// the heavy synopsis + comment fields. Used by every broad view (ranking list,
// keyword analysis, search, memos) so they don't pull the ~48MB full works.json
// (~12MB gzipped) just to show an author name. Falls back to the full file.
let worksLiteCache = null;
async function getWorksLite() {
  if (worksLiteCache) return worksLiteCache;
  const lite = await fetchJson('data/works-lite.json').catch(() => null);
  worksLiteCache = lite || (await getWorksCache());
  return worksLiteCache;
}

// Promotion periods per work (scripts/build-promo-periods.mjs):
//   { first, last, banners: {uid: [title, link, family, reach]},
//     works: {workId: [[uid, start, end, flags]]} }
// flags: 1 = may have started earlier, 2 = still running, 4 = may have run longer
// (the work was outside the daily TOP 300 on that side, so nobody checked).
async function getPromoPeriods() {
  if (!promoPeriodsCache) promoPeriodsCache = await fetchJson('data/promo-periods.json').catch(() => ({ banners: {}, works: {} }));
  return promoPeriodsCache;
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
  if (parts[0] === 'publisher' && parts[1]) {
    return { view: 'publisher', pub: decodeURIComponent(parts.slice(1).join('/')) };
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
  if (parts[0] === 'memos') {
    return { view: 'memos' };
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
  memos: '#/memos',
};

function updateNavActive(route) {
  const map = { list: 'ranking', highlights: 'ranking', work: 'ranking', new: 'new', keywords: 'keywords', events: 'events', memos: 'memos' };
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
  } else if (route.view === 'publisher') {
    await renderPublisherView(route.pub);
  } else if (route.view === 'new') {
    await renderNewReleasesView(route.cat);
  } else if (route.view === 'highlights') {
    await renderHighlightsView(route.cat, route.period, route.type);
  } else if (route.view === 'keywords') {
    await renderKeywordsView(route.cat);
  } else if (route.view === 'events') {
    await renderEventsView(route.cat);
  } else if (route.view === 'memos') {
    await renderMemosView();
  } else {
    await renderListView(route.cat, route.period, route.genre);
  }
}

// ---- Memo store: cloud (Vercel KV via /api/memos) first, localStorage as offline cache ----
let memoStore = null;      // { works: {id:{text,title,cat}}, events: {uid:{text}} }
let memoRemoteOk = false;  // true once the cloud store answered (i.e. setup done)

function readLocalMemos() {
  const works = {};
  const events = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('kp_memo_')) {
        const id = k.slice('kp_memo_'.length);
        let o;
        try { o = JSON.parse(localStorage.getItem(k)); } catch { o = { text: localStorage.getItem(k) }; }
        if (o && o.text) works[id] = { text: o.text, title: o.title || null, cat: o.cat || null };
      } else if (k && k.startsWith('kp_evmemo_')) {
        const t = localStorage.getItem(k);
        if (t) events[k.slice('kp_evmemo_'.length)] = { text: t };
      }
    }
  } catch { /* ignore */ }
  return { works, events };
}

async function loadMemoStore() {
  // Only trust a cached store that actually came from the cloud. If a previous
  // call fell back to local (cloud briefly unreachable, e.g. during a deploy),
  // retry the cloud on the next call instead of showing an empty view forever.
  if (memoStore && memoRemoteOk) return memoStore;
  const local = readLocalMemos();
  // A transient failure (cold start / mid-deploy) shouldn't wipe the view, so
  // try the cloud a few times before falling back to browser-only storage.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('api/memos', { cache: 'no-store' });
      if (r.ok) {
        const remote = await r.json();
        memoRemoteOk = true;
        memoStore = { works: remote.works || {}, events: remote.events || {} };
        // First time after cloud setup: push up any memos that only exist locally.
        const migrate = { works: {}, events: {} };
        for (const [id, v] of Object.entries(local.works)) if (!memoStore.works[id]) { memoStore.works[id] = v; migrate.works[id] = v; }
        for (const [id, v] of Object.entries(local.events)) if (!memoStore.events[id]) { memoStore.events[id] = v; migrate.events[id] = v; }
        if (Object.keys(migrate.works).length || Object.keys(migrate.events).length) {
          fetch('api/memos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ migrate }) }).catch(() => {});
        }
        return memoStore;
      }
      // 503 = storage not configured yet; no point retrying, use local.
      if (r.status === 503) break;
    } catch { /* network hiccup — retry */ }
    await new Promise((res) => setTimeout(res, 400));
  }
  memoRemoteOk = false;
  memoStore = local; // cloud unreachable/not set up → browser-only (will retry next call)
  return memoStore;
}

function memoWorkGet(id) { const o = memoStore && memoStore.works[id]; return o ? (o.text || '') : ''; }
function memoWorkSet(id, text, title, cat) {
  if (!memoStore) memoStore = { works: {}, events: {} };
  if (text && text.trim()) memoStore.works[id] = { text, title: title || null, cat: cat || null };
  else delete memoStore.works[id];
  try {
    if (text && text.trim()) localStorage.setItem('kp_memo_' + id, JSON.stringify({ text, title: title || null, cat: cat || null }));
    else localStorage.removeItem('kp_memo_' + id);
  } catch { /* ignore */ }
  if (memoRemoteOk) {
    fetch('api/memos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'work', id, text, title, cat }) }).catch(() => {});
  }
}
// Event notes hold a start date, an end date, and a free memo. They are packed
// into the single stored `text` field as JSON so the backend stays unchanged.
// Legacy plain-text notes (written before dates existed) become the memo.
function memoEventGet(id) {
  const o = memoStore && memoStore.events[id];
  const raw = o ? (o.text || '') : '';
  if (raw.startsWith('{')) {
    try { const d = JSON.parse(raw); return { start: d.start || '', end: d.end || '', memo: d.memo || '' }; } catch { /* fall through */ }
  }
  return { start: '', end: '', memo: raw };
}
function memoEventSet(id, data) {
  if (!memoStore) memoStore = { works: {}, events: {} };
  const start = (data.start || '').trim();
  const end = (data.end || '').trim();
  const memo = (data.memo || '').trim();
  const empty = !start && !end && !memo;
  const text = empty ? '' : JSON.stringify({ start, end, memo });
  if (!empty) memoStore.events[id] = { text };
  else delete memoStore.events[id];
  try {
    if (!empty) localStorage.setItem('kp_evmemo_' + id, text);
    else localStorage.removeItem('kp_evmemo_' + id);
  } catch { /* ignore */ }
  if (memoRemoteOk) {
    fetch('api/memos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'event', id, text }) }).catch(() => {});
  }
}
function allMemos() {
  const store = memoStore || { works: {} };
  return Object.entries(store.works).map(([workId, o]) => ({ workId, text: o.text, title: o.title || null, cat: o.cat || null }));
}

async function renderMemosView() {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  await loadMemoStore();
  app.innerHTML = '';
  const title = document.createElement('h2');
  title.style.cssText = 'font-size:18px;margin:8px 0 4px;';
  title.textContent = '내 메모';
  app.appendChild(title);
  const hint = document.createElement('div');
  hint.className = 'updated-note';
  hint.textContent = memoRemoteOk
    ? '작품 상세페이지에서 남긴 메모예요. ☁️ 클라우드에 저장돼서 어느 기기·브라우저에서도 똑같이 보여요.'
    : '작품 상세페이지에서 남긴 메모예요. ⚠️ 아직 클라우드 저장소가 연결되지 않아 이 브라우저에만 저장돼요.';
  app.appendChild(hint);

  const memos = allMemos();
  if (memos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '아직 메모가 없어요. 작품 상세페이지에서 메모를 남겨보세요.';
    app.appendChild(empty);
    return;
  }

  const works = await getWorksLite();
  const list = document.createElement('div');
  for (const m of memos) {
    const meta = works[m.workId] || {};
    const card = document.createElement('div');
    card.className = 'panel';
    card.style.cursor = 'pointer';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:6px;';
    head.textContent = m.title || meta.title || (meta.author ? `${meta.author} 작품` : `작품 ${m.workId}`);
    const txt = document.createElement('div');
    txt.style.cssText = 'white-space:pre-wrap;font-size:13px;color:var(--text-dim);';
    txt.textContent = m.text;
    card.appendChild(head);
    card.appendChild(txt);
    const cat = m.cat || (meta.classification && meta.classification.includes('웹툰') ? 'webtoon' : 'webnovel');
    card.addEventListener('click', () => navigate(`#/work/${cat}/daily/${m.workId}`));
    list.appendChild(card);
  }
  app.appendChild(list);
}

// ── 프로모션 기간 ──
// 작품 소식 탭에 걸린 배너를 일간 TOP 300에 든 날마다 확인해 이은 기간이다.
// 'platform'(스탬프 투어 같은 참여형)은 수십 작품이 한 달 내내 같이 걸려 있어
// 순위 차이를 설명하지 못하므로 목록 표시·그래프 색칠에서 빼고 카드에만 적는다.
const PROMO_FAMILY = {
  benefit: { label: '무료·혜택', tip: '무료 회차·기다무·캐시 같은 혜택 이벤트' },
  event: { label: '작품 이벤트', tip: '론칭·완결·연참·기념처럼 이 작품을 내세운 이벤트 (작품 이름을 단 2주짜리 이벤트 페이지 포함)' },
  curation: { label: '기획전·추천', tip: '여러 작품을 묶은 기획전·추천 자리에 노출' },
  platform: { label: '플랫폼 참여 이벤트', tip: '스탬프 투어처럼 여러 작품이 함께 들어간 참여형 이벤트' },
};
const PROMO_SHADED = ['benefit', 'event', 'curation'];

function promosOfWork(pp, workId) {
  return ((pp && pp.works && pp.works[workId]) || []).map(([uid, s, e, flags]) => {
    const [title, link, family, reach] = pp.banners[uid] || [];
    return { uid, title: title || '(제목 없음)', link: link || null, family: family || 'event', reach: reach || 1, s, e, flags };
  });
}

/** "2026-09-14" → "9/14" */
function mdDay(s) {
  return `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
}

/** '9/1~9/15' · '9/14 하루' · '9/28~ 진행 중' */
function promoWhen(p) {
  if (p.flags & 2) return `${mdDay(p.s)}~ 진행 중`;
  return p.s === p.e ? `${mdDay(p.s)} 하루` : `${mdDay(p.s)}~${mdDay(p.e)}`;
}

/** 순위 목록 줄에 붙이는 작은 표시: 그날 걸려 있던 프로모션. ended면 그날이 아니라
 *  직전 3일 안에 끝난 것도 '끝난 직후'로 보여준다(급하락·이탈 확인용). 없으면 null.
 *  끝 날짜가 불확실한 기간(flags 4: 그 뒤로 순위권 밖이라 못 봄)은 '끝남'으로 치지 않는다. */
function buildPromoChip(pp, workId, date, { ended = false } = {}) {
  const all = promosOfWork(pp, workId).filter((p) => PROMO_SHADED.includes(p.family));
  let list = all.filter((p) => p.s <= date && date <= p.e);
  let state = 'on';
  if (!list.length && ended) {
    const from = shiftDateStr(date, -3);
    list = all.filter((p) => !(p.flags & 6) && p.e < date && p.e >= from);
    state = 'ended';
  }
  if (!list.length) return null;
  list.sort((a, b) => PROMO_SHADED.indexOf(a.family) - PROMO_SHADED.indexOf(b.family));
  const chip = document.createElement('span');
  chip.className = `promo-chip fam-${list[0].family}${state === 'ended' ? ' ended' : ''}`;
  chip.textContent = state === 'ended'
    ? '이벤트 끝난 직후'
    : PROMO_FAMILY[list[0].family].label + (list.length > 1 ? ` +${list.length - 1}` : '');
  chip.title = list.map((p) => `${PROMO_FAMILY[p.family].label} · ${promoWhen(p)} · ${p.title}`).join('\n');
  return chip;
}

/** 프로모션 시작 전 7일 · 기간 중 · 끝난 뒤 7일의 일간 순위 평균.
 *  collected = 일간 순위를 수집한 날짜들. 그 구간에서 순위권 밖인 날이 절반을
 *  넘으면 { out: true }. 수집한 날이 없으면 null. */
function promoRankWindows(dailySeries, collected, p, firstDay) {
  const rankOf = new Map(dailySeries.filter((x) => !x.estimated && x.rank != null).map((x) => [x.date, x.rank]));
  const win = (from, to) => {
    const days = collected.filter((d) => d >= from && d <= to);
    if (!days.length) return null;
    const ranks = days.map((d) => rankOf.get(d)).filter((r) => r != null);
    if (ranks.length * 2 < days.length) return { out: true, n: days.length };
    return { avg: Math.round(ranks.reduce((a, r) => a + r, 0) / ranks.length), n: days.length };
  };
  return {
    // 수집 첫날부터 걸려 있던 건 언제 시작했는지 몰라서 '시작 전'과 비교하지 않는다
    before: (p.flags & 1) && p.s === firstDay ? null : win(shiftDateStr(p.s, -7), shiftDateStr(p.s, -1)),
    during: win(p.s, p.e),
    after: p.flags & 2 ? null : win(shiftDateStr(p.e, 1), shiftDateStr(p.e, 7)),
  };
}

/** '일간 순위: 시작 전 45위 → 기간 중 23위 ▲22 → 끝난 뒤 40위' */
function buildPromoEffect(w) {
  if (!w.during) return null;
  const word = (x) => (x.out ? '순위권 밖' : `${x.avg}위`);
  const div = document.createElement('div');
  div.className = 'promo-effect';
  const add = (text, cls) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    div.appendChild(s);
  };
  add('일간 순위: ');
  if (w.before) add(`시작 전 ${word(w.before)} → `);
  add(`기간 중 ${word(w.during)}`);
  if (w.before && !w.during.out) {
    if (w.before.out) add(' 순위권 진입', 'd up');
    else if (w.before.avg !== w.during.avg) {
      const d = w.before.avg - w.during.avg;
      add(d > 0 ? ` ▲${d}` : ` ▼${-d}`, d > 0 ? 'd up' : 'd down');
    }
  }
  if (w.after) add(w.after.n >= 3 ? ` → 끝난 뒤 ${word(w.after)}` : ' → 끝난 뒤는 자료 모으는 중');
  div.title = '시작 전 7일 · 기간 중 · 끝난 뒤 7일의 일간 순위 평균 (순위권 밖인 날이 절반 넘으면 \'순위권 밖\')';
  return div;
}

function buildPromoRow(p, pp, effect) {
  const row = document.createElement('div');
  row.className = 'promo-row';
  const sw = document.createElement('span');
  sw.className = `promo-sw fam-${p.family}`;
  row.appendChild(sw);
  const body = document.createElement('div');
  const t = document.createElement(p.link ? 'a' : 'span');
  t.className = 'promo-title';
  t.textContent = p.title;
  if (p.link) { t.href = p.link; t.target = '_blank'; t.rel = 'noopener noreferrer'; }
  body.appendChild(t);
  const meta = document.createElement('div');
  meta.className = 'promo-meta';
  const fam = document.createElement('span');
  fam.textContent = PROMO_FAMILY[p.family].label;
  fam.title = PROMO_FAMILY[p.family].tip;
  meta.appendChild(fam);
  const when = document.createElement('span');
  when.textContent = promoWhen(p);
  if (p.flags & 2) when.className = 'live';
  meta.appendChild(when);
  if (p.reach > 1) {
    const r = document.createElement('span');
    r.textContent = `${p.reach}작품 함께`;
    meta.appendChild(r);
  }
  if (p.flags & 1) {
    const f = document.createElement('span');
    f.textContent = p.s === pp.first ? `수집 시작(${mdDay(pp.first)}) 전부터` : '시작은 더 이를 수 있음';
    f.title = '그 전날엔 이 작품이 일간 TOP 300 밖이라 확인하지 못했어요.';
    meta.appendChild(f);
  }
  if (p.flags & 4) {
    const f = document.createElement('span');
    f.textContent = '더 길었을 수 있음';
    f.title = '다음 날엔 이 작품이 일간 TOP 300 밖이라 확인하지 못했어요.';
    meta.appendChild(f);
  }
  body.appendChild(meta);
  if (effect) body.appendChild(effect);
  row.appendChild(body);
  return row;
}

/** 상세 화면: 이 작품에 걸렸던 프로모션 목록 + 전·중·후 일간 순위 */
function buildPromoCard(promos, pp, dailySeries, collected) {
  const box = document.createElement('div');
  box.className = 'panel promo-card';
  box.id = 'promo-card';
  const head = document.createElement('div');
  head.className = 'promo-head';
  head.textContent = '🎁 프로모션 기간';
  const range = document.createElement('span');
  range.className = 'promo-range';
  range.textContent = `${mdDay(pp.first)}~${mdDay(pp.last)} 기록`;
  head.appendChild(range);
  box.appendChild(head);

  // 진행 중인 것 먼저, 그다음 최근에 끝난 순
  const byRecent = (a, b) => (b.flags & 2) - (a.flags & 2) || (a.e < b.e ? 1 : a.e > b.e ? -1 : a.s < b.s ? 1 : -1);
  const shaded = promos.filter((p) => PROMO_SHADED.includes(p.family)).sort(byRecent);
  const platform = promos.filter((p) => !PROMO_SHADED.includes(p.family)).sort(byRecent);
  for (const p of shaded) {
    box.appendChild(buildPromoRow(p, pp, buildPromoEffect(promoRankWindows(dailySeries, collected, p, pp.first))));
  }
  if (!shaded.length) {
    const none = document.createElement('div');
    none.className = 'promo-meta';
    none.textContent = '이 작품만의 이벤트·혜택·기획전 기록은 없어요.';
    box.appendChild(none);
  }
  if (platform.length) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = `플랫폼 참여 이벤트 ${platform.length}건 (스탬프 투어 등 · 그래프엔 칠하지 않아요)`;
    det.appendChild(sum);
    for (const p of platform) det.appendChild(buildPromoRow(p, pp, null));
    box.appendChild(det);
  }
  const hint = document.createElement('div');
  hint.className = 'promo-hint';
  hint.textContent = '작품 소식 탭에 걸린 배너를 일간 TOP 300에 든 날마다 확인한 기록이에요. 순위권 밖이던 날은 확인하지 못해 실제 기간과 조금 다를 수 있어요. '
    + '순위가 바뀐 게 프로모션 때문이라고 단정할 수는 없어요. 같은 시기 새 회차나 다른 노출도 영향을 줘요.';
  box.appendChild(hint);
  return box;
}

/** 그래프 아래 색 견본: 이 작품 그래프에 칠해진 계열만 */
function buildPromoLegend(bands) {
  const fams = PROMO_SHADED.filter((f) => bands.some((b) => b.family === f));
  if (!fams.length) return null;
  const div = document.createElement('div');
  div.className = 'promo-legend';
  div.appendChild(document.createTextNode('색 구간 = 프로모션 기간:'));
  for (const f of fams) {
    const item = document.createElement('span');
    const sw = document.createElement('span');
    sw.className = `promo-sw fam-${f}`;
    item.appendChild(sw);
    item.appendChild(document.createTextNode(PROMO_FAMILY[f].label));
    div.appendChild(item);
  }
  return div;
}

function buildMemoBox(workId, title, cat) {
  const box = document.createElement('div');
  box.className = 'panel';
  const label = document.createElement('div');
  label.style.cssText = 'font-size:13px;font-weight:700;margin-bottom:6px;';
  label.textContent = '📝 내 메모';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
  hint.textContent = memoRemoteOk ? '☁️ 클라우드에 자동 저장 (모든 기기에서 보임).' : '자동 저장 (이 브라우저).';
  const ta = document.createElement('textarea');
  ta.value = memoWorkGet(workId);
  ta.placeholder = '이 작품에 대한 메모를 남겨보세요...';
  ta.style.cssText =
    'width:100%;min-height:80px;resize:vertical;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;';
  let saveTimer = null;
  const savedMark = document.createElement('span');
  savedMark.style.cssText = 'font-size:11px;color:var(--text-dim);margin-left:8px;';
  ta.addEventListener('input', () => {
    clearTimeout(saveTimer);
    savedMark.textContent = '저장 중...';
    saveTimer = setTimeout(() => {
      memoWorkSet(workId, ta.value, title, cat);
      savedMark.textContent = '✓ 저장됨';
      setTimeout(() => { savedMark.textContent = ''; }, 1500);
    }, 400);
  });
  label.appendChild(savedMark);
  box.appendChild(label);
  box.appendChild(hint);
  box.appendChild(ta);
  return box;
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

function kwYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function kwMD(dateStr) {
  return `${parseInt(dateStr.slice(5, 7), 10)}/${parseInt(dateStr.slice(8, 10), 10)}`;
}
// Monday (week start) of the calendar week containing dateStr.
function kwMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay: 0=Sun → shift so Mon=0
  return d;
}
// Build {value,label} snapshot options for the keyword date picker, newest first.
// Kakao's weekly/monthly rankings are trailing aggregates, so to see a full
// Mon–Sun week we use that week's Sunday snapshot (the latest day in the week);
// for a month we use that month's last available snapshot.
function buildKeywordDateOptions(dates, period) {
  const sorted = [...dates].sort();
  if (period === 'daily') return sorted.map((d) => ({ value: d, label: d })).reverse();
  const groups = new Map(); // group key → representative (latest, ascending overwrite) date
  for (const d of sorted) {
    const key = period === 'weekly' ? kwYmd(kwMondayOf(d)) : d.slice(0, 7); // Monday date or YYYY-MM
    groups.set(key, d);
  }
  return [...groups.entries()].reverse().map(([key, rep]) => {
    if (period === 'weekly') {
      const mon = new Date(key + 'T00:00:00');
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      const wk = Math.ceil(mon.getDate() / 7);
      const sunStr = kwYmd(sun);
      const note = rep === sunStr ? '' : ` · ${kwMD(rep)}까지`;
      return { value: rep, label: `${mon.getMonth() + 1}월 ${wk}주 (${kwMD(kwYmd(mon))}~${kwMD(sunStr)})${note}` };
    }
    return { value: rep, label: `${parseInt(key.slice(5, 7), 10)}월 (${kwMD(rep)} 기준)` };
  });
}

async function renderKeywordsView(cat) {
  app.innerHTML = '';
  app.appendChild(buildCatTabs(cat, '#/keywords'));

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  const [works, index] = await Promise.all([getWorksLite(), getIndex()]);

  let curGenre = 'all';
  let curPeriod = 'daily';
  let curScope = 300;
  let curDate = null; // selected snapshot date; null = latest

  // cache of loaded ranking lists keyed by "genre/period/date"
  const listCache = {};
  async function getList(genre, period, date) {
    const key = `${genre}/${period}/${date || 'latest'}`;
    if (!listCache[key]) {
      const base = genre === 'all' ? `${cat}/${period}` : `${cat}/genres/${genre}/${period}`;
      const file = date ? `${date}.json` : 'latest.json';
      listCache[key] = await fetchJson(`data/${base}/${file}`).catch(() => []);
    }
    return listCache[key];
  }
  function datesFor(genre, period) {
    return genre === 'all'
      ? ((index[cat] || {})[period] || [])
      : ((((index.genres || {})[cat] || {})[genre] || {})[period] || []);
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
    btn.addEventListener('click', () => { curGenre = g.key; refreshDateOptions(); recompute(); });
    genreGroup.appendChild(btn);
  }
  const genreNav = document.createElement('nav');
  genreNav.className = 'tabs';
  genreNav.appendChild(genreGroup);
  body.appendChild(genreNav);

  // Period + date + scope controls
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:14px;';

  const periodGroup = document.createElement('div');
  periodGroup.className = 'tabgroup';
  for (const p of PERIODS) {
    const btn = document.createElement('button');
    btn.textContent = `${p.label}순위`;
    btn.dataset.p = p.key;
    btn.addEventListener('click', () => { curPeriod = p.key; refreshDateOptions(); recompute(); });
    periodGroup.appendChild(btn);
  }

  // Date/period selector — labels adapt: 일간=날짜, 주간=N월 M째주, 월간=N월
  const dateWrap = document.createElement('div');
  dateWrap.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-dim);';
  const dateLabelEl = document.createElement('span');
  dateLabelEl.textContent = '시점';
  const dateSelect = document.createElement('select');
  dateSelect.style.cssText =
    'padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none;max-width:210px;';
  dateSelect.addEventListener('change', () => { curDate = dateSelect.value || null; recompute(); });
  function refreshDateOptions() {
    const opts = buildKeywordDateOptions(datesFor(curGenre, curPeriod), curPeriod);
    if (curDate && !opts.some((o) => o.value === curDate)) curDate = null;
    dateSelect.innerHTML = '';
    const latest = document.createElement('option');
    latest.value = '';
    latest.textContent = '최신';
    dateSelect.appendChild(latest);
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o.value;
      el.textContent = o.label;
      dateSelect.appendChild(el);
    }
    dateSelect.value = curDate || '';
  }
  dateWrap.appendChild(dateLabelEl);
  dateWrap.appendChild(dateSelect);

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

  const excelBtn = document.createElement('button');
  excelBtn.textContent = '⬇ 엑셀 다운로드';
  excelBtn.style.cssText =
    'padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:var(--card-bg);color:var(--text);font-size:13px;cursor:pointer;';
  excelBtn.addEventListener('click', downloadKeywordExcel);

  controls.appendChild(periodGroup);
  controls.appendChild(dateWrap);
  controls.appendChild(scopeWrap);
  controls.appendChild(excelBtn);
  body.appendChild(controls);

  // Keyword combination search + rank-distribution analysis
  const searchSection = document.createElement('div');
  searchSection.className = 'chart-box';
  searchSection.style.marginBottom = '18px';
  const searchTitle = document.createElement('h3');
  searchTitle.style.cssText = 'font-size:14px;margin:0 0 8px;';
  searchTitle.textContent = '키워드 조합 검색 · 분포 분석';
  const searchHint = document.createElement('div');
  searchHint.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:10px;';
  searchHint.textContent = '키워드를 띄어쓰기로 조합해 입력하세요 (예: 능력녀 집착남). 모두 가진 작품과, 그 작품들이 현재 순위에서 상위 몇 %에 분포하는지 보여줘요.';
  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = '예: 능력녀 집착남';
  searchInput.style.cssText =
    'flex:1;min-width:180px;padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:13px;outline:none;';
  const searchBtn = document.createElement('button');
  searchBtn.textContent = '검색';
  searchBtn.style.cssText =
    'padding:8px 18px;border-radius:999px;border:none;background:var(--accent);color:var(--on-accent);font-size:13px;cursor:pointer;font-weight:600;';
  const searchResult = document.createElement('div');
  const doSearch = () => runComboSearch(searchInput.value);
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  searchRow.appendChild(searchInput);
  searchRow.appendChild(searchBtn);
  searchSection.appendChild(searchTitle);
  searchSection.appendChild(searchHint);
  searchSection.appendChild(searchRow);
  searchSection.appendChild(searchResult);
  body.appendChild(searchSection);

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
  let currentFullList = [];
  let analyzedWorks = [];
  let curGenreLabel = '전체';
  let curPeriodLabel = '일간';

  async function recompute() {
    genreGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.g === curGenre));
    periodGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.p === curPeriod));

    const fullList = await getList(curGenre, curPeriod, curDate);
    currentFullList = fullList;
    const list = fullList.slice(0, curScope);
    kwCount = new Map();
    coCount = new Map();
    analyzed = 0;
    analyzedWorks = [];
    for (const item of list) {
      const w = works[item.workId];
      if (!w || !w.keywords || !w.keywords.length) continue;
      analyzed += 1;
      const kws = [...new Set(w.keywords)];
      analyzedWorks.push({ rank: item.rank, title: item.title || w.title || item.workId, author: w.author || '', workId: item.workId, keywords: kws });
      for (const k of kws) kwCount.set(k, (kwCount.get(k) || 0) + 1);
      for (let i = 0; i < kws.length; i++) {
        for (let j = i + 1; j < kws.length; j++) {
          const key = [kws[i], kws[j]].sort().join('||');
          coCount.set(key, (coCount.get(key) || 0) + 1);
        }
      }
    }

    curPeriodLabel = PERIODS.find((p) => p.key === curPeriod).label;
    curGenreLabel = genreOptions.find((g) => g.key === curGenre).label;
    const when = curDate || '최신';
    note.textContent = `${curGenreLabel} · ${curPeriodLabel}순위(${when}) TOP ${curScope} 중 키워드 보유 ${analyzed}개 작품 기준 · 고유 키워드 ${kwCount.size}종`;

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
      bar.style.cssText = `width:${(count / maxCount) * 100}%;background:var(--spark);height:100%;`;
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

  // Combo search: works holding ALL typed keywords, and where they sit in the ranking.
  function runComboSearch(raw) {
    const terms = (raw || '').split(/[\s,+#]+/).map((t) => t.trim()).filter(Boolean);
    searchResult.innerHTML = '';
    if (!terms.length) { searchResult.innerHTML = '<div class="hc-empty">키워드를 입력하세요.</div>'; return; }
    const listFull = currentFullList;
    const total = listFull.length;
    if (!total) { searchResult.innerHTML = '<div class="hc-empty">이 시점 데이터가 없습니다.</div>'; return; }
    const matches = [];
    listFull.forEach((item, idx) => {
      const w = works[item.workId];
      if (!w || !w.keywords) return;
      const kset = new Set(w.keywords);
      if (terms.every((t) => kset.has(t))) {
        const rank = item.rank || idx + 1;
        matches.push({ rank, title: item.title || w.title || item.workId, workId: item.workId, pct: (rank / total) * 100 });
      }
    });
    matches.sort((a, b) => a.rank - b.rank);
    if (!matches.length) {
      searchResult.innerHTML = `<div class="hc-empty">‘${terms.map((t) => '#' + t).join(' ')}’ 를 모두 가진 작품이 이 범위(TOP ${total})에 없어요.</div>`;
      return;
    }
    const inTop = (p) => matches.filter((m) => m.rank <= total * p).length;
    const avgRank = Math.round(matches.reduce((s, m) => s + m.rank, 0) / matches.length);
    const avgPct = (matches.reduce((s, m) => s + m.pct, 0) / matches.length).toFixed(1);
    const head = document.createElement('div');
    head.style.cssText = 'font-size:13px;line-height:1.7;margin-bottom:10px;';
    head.innerHTML =
      `<b>${terms.map((t) => '#' + t).join(' ')}</b> 조합: <b>${matches.length}개</b> 작품 ` +
      `(전체 TOP ${total}의 ${((matches.length / total) * 100).toFixed(1)}%)<br>` +
      `분포 → 상위 10% 내 <b>${inTop(0.1)}</b>개 · 상위 25% 내 <b>${inTop(0.25)}</b>개 · 상위 50% 내 <b>${inTop(0.5)}</b>개<br>` +
      `평균 순위 <b>${avgRank}위</b> (상위 ${avgPct}%)`;
    searchResult.appendChild(head);
    const listEl = document.createElement('div');
    for (const m of matches.slice(0, 60)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;font-size:13px;padding:5px 0;border-top:1px solid var(--border);cursor:pointer;';
      row.addEventListener('click', () => navigate(`#/work/${cat}/${curPeriod}/${m.workId}`));
      const r = document.createElement('span');
      r.style.cssText = 'width:56px;flex-shrink:0;color:var(--text-dim);';
      r.textContent = `${m.rank}위`;
      const t = document.createElement('span');
      t.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      t.textContent = m.title;
      const pc = document.createElement('span');
      pc.style.cssText = 'width:70px;flex-shrink:0;text-align:right;color:var(--text-dim);';
      pc.textContent = `상위 ${m.pct.toFixed(0)}%`;
      row.appendChild(r); row.appendChild(t); row.appendChild(pc);
      listEl.appendChild(row);
    }
    if (matches.length > 60) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:12px;color:var(--text-dim);padding-top:6px;';
      more.textContent = `…외 ${matches.length - 60}개 더`;
      listEl.appendChild(more);
    }
    searchResult.appendChild(listEl);
  }

  // Excel export: full keyword ratios + co-occurrence + per-work keywords (more than the screen shows).
  function downloadKeywordExcel() {
    if (typeof XLSX === 'undefined') { alert('엑셀 라이브러리를 불러오지 못했어요.'); return; }
    if (!analyzed) { alert('내보낼 키워드 데이터가 없어요.'); return; }
    const wb = XLSX.utils.book_new();
    const kwRows = [['키워드', '작품수', '비율(%)']];
    [...kwCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, c]) => kwRows.push([k, c, +((c / analyzed) * 100).toFixed(2)]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kwRows), '키워드비중');
    const coRows = [['키워드A', '키워드B', '함께등장(작품수)']];
    [...coCount.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).forEach(([key, c]) => { const [a, b] = key.split('||'); coRows.push([a, b, c]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(coRows), '동시출현');
    const workRows = [['순위', '작품명', '작가', '키워드']];
    analyzedWorks.forEach((w) => workRows.push([w.rank, w.title, w.author, (w.keywords || []).join(', ')]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(workRows), '작품별키워드');
    const when = curDate || '최신';
    XLSX.writeFile(wb, `키워드분석_${cat}_${curGenreLabel}_${curPeriodLabel}_${when}.xlsx`);
  }

  refreshDateOptions();
  recompute();
}

// Convert a Kakao event link to a browser-openable web URL. Banners expose an
// app-only deep link like:
//   kakaopage://open/landing/series/list?reference=page%2Flanding%2F18461
// whose web equivalent is:
//   https://page.kakao.com/landing/series/list/page/landing/18461/
function eventWebLink(link) {
  if (!link) return null;
  if (link.startsWith('http')) return link;
  if (link.startsWith('kakaopage://')) {
    const hash = link.match(/hash_uid=([a-f0-9]+)/);
    if (hash) return `https://page.kakao.com/open/webview/event/?hash_uid=${hash[1]}`;
    const ref = link.match(/reference=([^&]+)/);
    if (ref) {
      const decoded = decodeURIComponent(ref[1]); // e.g. page/landing/18461
      const pathMatch = link.match(/^kakaopage:\/\/open\/([^?]+)/);
      const path = pathMatch ? pathMatch[1].replace(/\/+$/, '') : 'landing/series/list';
      return `https://page.kakao.com/${path}/${decoded}/`;
    }
  }
  return link;
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

  // 진행중/완료 sub-filter
  const statusRow = document.createElement('nav');
  statusRow.className = 'tabs';
  const statusGroup = document.createElement('div');
  statusGroup.className = 'tabgroup';
  statusRow.appendChild(statusGroup);
  app.appendChild(statusRow);

  const body = document.createElement('div');
  body.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  app.appendChild(body);

  await loadMemoStore();
  // Prefer accumulating history (knows 진행중 vs 완료); fall back to latest.
  let history = await fetchJson(`data/events/${tab}/history.json`).catch(() => null);
  if (!history) {
    const latest = await fetchJson(`data/events/${tab}/latest.json`).catch(() => []);
    history = latest.map((e) => ({ ...e, firstSeen: null, lastSeen: null }));
  }
  if (!history.length) {
    statusRow.remove();
    body.innerHTML = '<div class="empty-note">아직 수집된 이벤트가 없습니다.</div>';
    return;
  }

  const latestDate = history.reduce((m, e) => (e.lastSeen && e.lastSeen > m ? e.lastSeen : m), '');
  const isOngoing = (e) => !latestDate || e.lastSeen === latestDate;
  const ongoing = history.filter(isOngoing);
  const ended = history.filter((e) => !isOngoing(e));

  let curStatus = 'ongoing';
  const statusOptions = [
    { key: 'ongoing', label: `진행 중 (${ongoing.length})` },
    { key: 'ended', label: `종료됨 (${ended.length})` },
  ];
  for (const s of statusOptions) {
    const btn = document.createElement('button');
    btn.textContent = s.label;
    btn.dataset.st = s.key;
    btn.addEventListener('click', () => { curStatus = s.key; renderGrid(); });
    statusGroup.appendChild(btn);
  }

  const note = document.createElement('div');
  note.className = 'updated-note';
  body.appendChild(note);

  const grid = document.createElement('div');
  grid.className = 'event-grid';
  body.appendChild(grid);

  function renderGrid() {
    statusGroup.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.st === curStatus));
    const list = curStatus === 'ongoing' ? ongoing : ended;
    note.textContent =
      curStatus === 'ongoing'
        ? `진행 중인 이벤트 · ${list.length}개`
        : `종료된 이벤트 (수집 기간 중 사라진 것) · ${list.length}개`;
    grid.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = curStatus === 'ended' ? '아직 종료된 이벤트가 없어요. 수집이 며칠 쌓이면 여기 모여요.' : '진행 중인 이벤트가 없어요.';
      grid.appendChild(empty);
      return;
    }
    for (const ev of list) {
      const card = document.createElement('div');
      card.className = 'event-card';
      if (curStatus === 'ended') card.classList.add('event-ended');

      // clickable part (thumb + title) opens the Kakao event page.
      // Older data stored app-only kakaopage:// deep links; convert to a web URL.
      const webLink = eventWebLink(ev.link);
      const linkPart = document.createElement(webLink ? 'a' : 'div');
      if (webLink) { linkPart.href = webLink; linkPart.target = '_blank'; linkPart.rel = 'noopener noreferrer'; }
      const thumbWrap = document.createElement('div');
      thumbWrap.style.position = 'relative';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = ev.thumbnail || '';
      img.alt = '';
      thumbWrap.appendChild(img);
      if (curStatus === 'ended') {
        const badge = document.createElement('span');
        badge.className = 'event-badge';
        badge.textContent = '종료';
        thumbWrap.appendChild(badge);
      }
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
      if (ev.firstSeen) {
        const seen = document.createElement('div');
        seen.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:4px;';
        seen.textContent =
          curStatus === 'ended'
            ? `${ev.firstSeen} ~ ${ev.lastSeen} 확인됨`
            : `${ev.firstSeen}부터 확인됨`;
        meta.appendChild(seen);
      }
      linkPart.appendChild(thumbWrap);
      linkPart.appendChild(meta);
      card.appendChild(linkPart);

      // editable memo (start/end date, notes) — saved only in this browser
      if (ev.bannerUid) card.appendChild(buildEventMemoField(ev.bannerUid));

      grid.appendChild(card);
    }
  }
  renderGrid();
}

// ---- Event memo (per-banner note) — uses the shared cloud memo store ----
function buildEventMemoField(uid) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:8px 10px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:6px;';
  const cur = memoEventGet(uid);

  // Row 1: 시작일 ~ 종료일 (native date pickers)
  const dateRow = document.createElement('div');
  dateRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const inputCss =
    'flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;';
  function mkDate(value, label) {
    const inp = document.createElement('input');
    inp.type = 'date';
    inp.value = value || '';
    inp.setAttribute('aria-label', label);
    inp.title = label;
    inp.style.cssText = inputCss;
    inp.addEventListener('click', (e) => e.stopPropagation());
    return inp;
  }
  const startInp = mkDate(cur.start, '시작일');
  const endInp = mkDate(cur.end, '종료일');
  const sep = document.createElement('span');
  sep.textContent = '~';
  sep.style.cssText = 'color:var(--muted);font-size:12px;flex:0 0 auto;';
  dateRow.appendChild(startInp);
  dateRow.appendChild(sep);
  dateRow.appendChild(endInp);

  // Row 2: free memo
  const ta = document.createElement('textarea');
  ta.value = cur.memo;
  ta.placeholder = '메모…';
  ta.rows = 2;
  ta.style.cssText =
    'width:100%;resize:vertical;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;font-family:inherit;outline:none;box-sizing:border-box;';
  ta.addEventListener('click', (e) => e.stopPropagation());

  // don't let clicks bubble to any parent link; debounce saves
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => memoEventSet(uid, { start: startInp.value, end: endInp.value, memo: ta.value }),
      400
    );
  };
  startInp.addEventListener('change', save);
  endInp.addEventListener('change', save);
  ta.addEventListener('input', save);

  wrap.appendChild(dateRow);
  wrap.appendChild(ta);
  return wrap;
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

  const [index, works, pp] = await Promise.all([getIndex(), getWorksLite(), getPromoPeriods()]);
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
    list.appendChild(buildRankRow(item, cat, period, works[item.workId], buildPromoChip(pp, item.workId, latestDate)));
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
  const [index, pp] = await Promise.all([getIndex(), getPromoPeriods()]);
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
      // 급하락·이탈은 막 끝난 프로모션도 같이 보여준다(끝나서 빠진 건지 보려고)
      const ended = type === 'fallers' || type === 'dropped';
      for (const it of rows) {
        list.appendChild(buildHighlightHistoryRow(it, cat, period, buildPromoChip(pp, it.workId, date, { ended })));
      }
      section.appendChild(list);
    }
    app.appendChild(section);
  }
}

function buildHighlightHistoryRow(item, cat, period, promoChip) {
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
  if (promoChip) sub.appendChild(promoChip);
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
    bar.style.cssText = `width:${pct}%;background:var(--spark);height:100%;`;
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

function buildRankRow(item, cat, period, workMeta, promoChip) {
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
  if (promoChip) sub.appendChild(promoChip);
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

async function buildRankSeries(cat, period, workId, dates, pathPrefix) {
  const prefix = pathPrefix || `${cat}/${period}`;
  const series = [];
  let latestItem = null;
  for (const date of dates) {
    const dayList = await fetchJson(`data/${prefix}/${date}.json`).catch(() => []);
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

// Prepend the estimated previous-day point from the first real point's "change"
// delta (same logic buildRankSeries used), for a precomputed per-work series.
function withEstimatedPrevDay(series) {
  const out = (series || []).slice();
  const firstReal = out.find((p) => p.rank != null);
  if (firstReal && firstReal.change && ['up', 'down', 'same'].includes(firstReal.change.type)) {
    const prevRank =
      firstReal.change.type === 'up'
        ? firstReal.rank + firstReal.change.amount
        : firstReal.change.type === 'down'
          ? firstReal.rank - firstReal.change.amount
          : firstReal.rank;
    if (prevRank >= 1) out.unshift({ date: shiftDateStr(firstReal.date, -1), rank: prevRank, change: null, estimated: true });
  }
  return out;
}

async function renderPublisherView(pub) {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';
  const [index, all] = await Promise.all([getSearchIndex(), getAllLatest()]);

  // "통합순위" = best (lowest) current rank across the overall daily/weekly/monthly lists.
  const bestRank = new Map();
  for (const list of Object.values(all)) {
    for (const it of list) {
      if (it.rank == null) continue;
      const id = String(it.workId);
      const cur = bestRank.get(id);
      if (cur == null || it.rank < cur) bestRank.set(id, it.rank);
    }
  }

  const works = index.filter((it) => it.publisher === pub);
  app.innerHTML = '';

  const back = document.createElement('nav');
  back.className = 'tabs';
  const backBtn = document.createElement('button');
  backBtn.textContent = '← 돌아가기';
  backBtn.style.cssText = 'border:1px solid var(--border);background:var(--card-bg);color:var(--text);padding:6px 12px;border-radius:20px;font-size:13px;cursor:pointer;';
  backBtn.addEventListener('click', () => history.back());
  back.appendChild(backBtn);
  app.appendChild(back);

  const h2 = document.createElement('h2');
  h2.textContent = `📚 ${pub}`;
  app.appendChild(h2);
  const note = document.createElement('div');
  note.className = 'updated-note';
  note.textContent = `작품 ${works.length}개 · 누적조회수 50 : 통합순위 50 종합순`;
  app.appendChild(note);

  if (!works.length) {
    const e = document.createElement('div');
    e.className = 'empty-note';
    e.textContent = '이 출판사의 작품 데이터가 없습니다.';
    app.appendChild(e);
    return;
  }

  // 50:50 rank blend: position in view-count order + position in overall-rank order.
  const byView = [...works].sort((a, b) => (parseCount(b.viewCount) || 0) - (parseCount(a.viewCount) || 0));
  const viewPos = new Map();
  byView.forEach((w, i) => viewPos.set(w.workId, i + 1));
  const byRank = [...works].sort((a, b) => (bestRank.get(a.workId) ?? 100000) - (bestRank.get(b.workId) ?? 100000));
  const rankPos = new Map();
  byRank.forEach((w, i) => rankPos.set(w.workId, i + 1));
  const scored = works.map((w) => ({ w, score: (viewPos.get(w.workId) + rankPos.get(w.workId)) / 2 }));
  scored.sort((a, b) => a.score - b.score);

  const ol = document.createElement('ol');
  ol.className = 'rank-list';
  scored.forEach(({ w }, i) => {
    const li = document.createElement('li');
    li.className = 'rank-row';
    li.addEventListener('click', () => navigate(`#/work/${w.cat}/daily/${w.workId}`));
    const num = document.createElement('div');
    num.className = 'rank-num';
    num.textContent = i + 1;
    const thumb = document.createElement('img');
    thumb.className = 'rank-thumb';
    thumb.loading = 'lazy';
    thumb.src = w.thumbnail || '';
    thumb.alt = '';
    const info = document.createElement('div');
    info.className = 'rank-info';
    const t = document.createElement('div');
    t.className = 'rank-title';
    t.textContent = w.title;
    const sub = document.createElement('div');
    sub.className = 'rank-sub';
    const cr = bestRank.get(w.workId);
    const bits = [(CATEGORIES.find((c) => c.key === w.cat)?.label) || w.cat];
    if (w.viewCount) bits.push(`조회 ${w.viewCount}`);
    bits.push(cr != null ? `통합 ${cr}위` : '순위권 밖');
    sub.textContent = bits.join(' · ');
    info.appendChild(t);
    info.appendChild(sub);
    li.appendChild(num);
    li.appendChild(thumb);
    li.appendChild(info);
    ol.appendChild(li);
  });
  app.appendChild(ol);
}

async function renderWorkView(cat, period, workId) {
  app.innerHTML = '<div class="loading-note">불러오는 중...</div>';

  // One small per-work "detail card" holds everything this page needs (synopsis,
  // comments, rank trend, view trend), so we fetch ONE ~20KB file instead of the
  // ~59MB works.json plus ~220 per-date snapshot requests. Light metadata
  // (author/classification/keywords/rating…) comes from the already-cached lite.
  const [lite, card, pp, , cm, index] = await Promise.all([
    getWorksLite(), fetchJson(`data/detail/${workId}.json`).catch(() => null), getPromoPeriods(), loadMemoStore(),
    fetchJson(`data/comments/${workId}.json`).catch(() => null), getIndex().catch(() => ({})),
  ]);
  // Comment analysis (scripts/collect-comments.mjs). When present it replaces the
  // older scraped "인기 댓글"/"댓글 반응 키워드" (BEST 25 only).
  const hasCm = !!(cm && cm.react && cm.n);   // n = 0: the work has no comments at all
  const liteMeta = lite[workId] || {};
  const meta = {
    ...liteMeta,
    synopsis: card ? card.synopsis : null,
    topComments: card ? card.topComments : [],
    commentKeywords: card ? card.commentKeywords : [],
    title: liteMeta.title || (card && card.title) || workId,
  };
  // Promotion periods: shaded behind every trend chart + listed in their own card.
  const promos = promosOfWork(pp, workId);
  const bands = promos.filter((p) => PROMO_SHADED.includes(p.family)).map((p) => ({ s: p.s, e: p.e, family: p.family, title: p.title }));

  const seriesByPeriod = {};
  for (const p of PERIODS) {
    seriesByPeriod[p.key] = withEstimatedPrevDay((card && card.rankSeries && card.rankSeries[p.key]) || []);
  }
  const latestItem = { title: meta.title, thumbnail: (card && card.thumbnail) || '' };

  // Views over time: historical rounded (viewSeries) merged with exact BFF
  // metrics (metricsSeries.v, going forward). Exact values win on shared dates.
  const metricsSeries = (card && card.metricsSeries) || [];
  const latestM = metricsSeries.length ? metricsSeries[metricsSeries.length - 1] : null;
  const viewByDate = new Map();
  for (const v of (card && card.viewSeries) || []) { const val = parseCount(v.viewCount); if (val != null) viewByDate.set(v.date, val); }
  for (const m of metricsSeries) if (m.v != null) viewByDate.set(m.date, m.v);
  const viewSeries = [...viewByDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));

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
  // Prefer exact BFF numbers (1-unit precise) over the page's rounded display.
  if (latestM && latestM.v != null) infoDiv.appendChild(metaLine(`누적 조회수: ${formatCount(latestM.v)} (${latestM.v.toLocaleString()})`));
  else if (meta.viewCount) infoDiv.appendChild(metaLine(`누적 조회수: ${meta.viewCount}`));
  if (latestM && latestM.rc) infoDiv.appendChild(metaLine(`평점: ${(latestM.rs / latestM.rc).toFixed(2)} (참여 ${latestM.rc.toLocaleString()}명)`));
  else if (meta.rating) infoDiv.appendChild(metaLine(`평점: ${meta.rating}`));
  if (latestM && latestM.cc != null) infoDiv.appendChild(metaLine(`전체 댓글 수: ${latestM.cc.toLocaleString()}`));
  else if (meta.totalCommentText) infoDiv.appendChild(metaLine(`전체 댓글 수: ${meta.totalCommentText}`));

  const novelSource = (meta.sameWorkVersions || []).find((v) => v.category === '웹소설');
  if (novelSource) {
    const line = metaLine('원작: 웹소설 ');
    const link = document.createElement('a');
    link.textContent = novelSource.title;
    link.href = `#/work/webnovel/daily/${novelSource.workId}`;
    link.style.cssText = 'color:var(--accent-ink);text-decoration:underline;';
    line.appendChild(link);
    infoDiv.appendChild(line);
  }
  const otherVersions = (meta.sameWorkVersions || []).filter((v) => v !== novelSource);
  if (otherVersions.length) {
    infoDiv.appendChild(metaLine(`다른 형태로도 있음: ${otherVersions.map((v) => `${v.category} <${v.title}>`).join(', ')}`));
  }

  // "진행 중인 프로모션: 신마대제 외 1개 (자세히 ↓)" (누르면 아래 프로모션 기간 카드로)
  const livePromos = promos.filter((p) => PROMO_SHADED.includes(p.family) && (p.flags & 2));
  if (livePromos.length) {
    const line = metaLine('진행 중인 프로모션: ');
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = `${livePromos[0].title}${livePromos.length > 1 ? ` 외 ${livePromos.length - 1}개` : ''} (자세히 ↓)`;
    a.style.cssText = 'color:var(--accent-ink);text-decoration:underline;';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById('promo-card');
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
    line.appendChild(a);
    infoDiv.appendChild(line);
  }

  // 한 줄 요약: "작품 평가: 호평 60 · 아쉬움 3 · 하차 2 · 👍 캐릭터가 귀엽다 · 👎 …" (누르면 아래 작품 분석으로)
  if (hasCm && cm.ev && cm.ev.used) {
    const link = (text) => {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = text;
      a.style.cssText = 'color:var(--accent-ink);text-decoration:underline;';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById('comment-analysis');
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      });
      return a;
    };
    const [p, n] = evalTotals(cm.ev);
    const op = cm.ev.op || {};
    const parts = [`호평 ${p} · 아쉬움 ${n}`];
    if (cm.ev.drop) parts.push(`하차 ${cm.ev.drop.n}`);
    if (op.pos && op.pos[0]) parts.push(`👍 ${op.pos[0][0]}`);
    if (op.neg && op.neg[0]) parts.push(`👎 ${op.neg[0][0]}`);
    const line = metaLine('작품 평가: ');
    line.appendChild(link(`${parts.join(' · ')} (자세히 ↓)`));
    infoDiv.appendChild(line);
  }

  if (!hasCm && meta.commentKeywords && meta.commentKeywords.length) {
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

  app.appendChild(buildMemoBox(workId, (latestItem && latestItem.title) || meta.title || null, cat));

  if (!hasCm && meta.topComments && meta.topComments.length) {
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
    chartBox.appendChild(buildChart(activeSeries, bands));
    const hasEstimated = activeSeries.some((p) => p.estimated);
    chartNote.textContent = hasEstimated
      ? '※ 맨 왼쪽 점은 수집 시작일의 순위 변동폭으로 역산한 추정치예요.'
      : '';

    viewChartBox.innerHTML = '';
    viewChartBox.appendChild(buildViewCountChart(viewSeries, bands));
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
  const legend = buildPromoLegend(bands);
  if (legend) app.appendChild(legend);
  if (promos.length) {
    app.appendChild(buildPromoCard(promos, pp, seriesByPeriod.daily || [], (index[cat] && index[cat].daily) || []));
  }
  if (viewSeries.some((p) => p.value != null)) {
    const viewLabel = document.createElement('h3');
    viewLabel.style.cssText = 'font-size:13px;color:var(--text-dim);margin:16px 0 8px;';
    viewLabel.textContent = '누적 조회수 추이';
    app.appendChild(viewLabel);
    app.appendChild(viewChartBox);
  }
  // Exact daily trends from BFF metrics (appear once ≥2 days have accumulated).
  const addMetricTrend = (label, series) => {
    if (series.length < 2) return;
    const h = document.createElement('h3');
    h.style.cssText = 'font-size:13px;color:var(--text-dim);margin:16px 0 8px;';
    h.textContent = label;
    const box = document.createElement('div');
    box.className = 'chart-box';
    box.appendChild(buildViewCountChart(series, bands));
    app.appendChild(h);
    app.appendChild(box);
  };
  addMetricTrend('평점 참여 수 추이', metricsSeries.filter((m) => m.rc != null).map((m) => ({ date: m.date, value: m.rc })));
  addMetricTrend('전체 댓글 수 추이', metricsSeries.filter((m) => m.cc != null).map((m) => ({ date: m.date, value: m.cc })));
  redraw();

  if (hasCm) {
    const title = (latestItem && latestItem.title) || meta.title || workId;
    const epHolder = document.createElement('div');
    let epData = null;
    const epPromise = cm.epScanned
      ? fetchJson(`data/comments/ep/${workId}.json`).then((d) => { epData = d; return d; }).catch(() => null)
      : Promise.resolve(null);
    app.appendChild(buildWorkAnalysisBox(cm, () => epPromise.then(() => downloadCommentExcel(title, cm, epData))));
    app.appendChild(epHolder);
    epPromise.then((d) => { if (d && d.episodes) epHolder.appendChild(buildEpisodeBox(cm, d)); });
  }
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

// ---- 댓글 분석 (data/comments/{id}.json · ep/{id}.json, scripts/collect-comments.mjs) ----
// Keys/labels mirror the reaction engine scripts/lib/kreact.cjs.
const REACTIONS = [
  ['laugh', '웃음', '#eab308'], ['sad', '감동·슬픔', '#3b82f6'], ['love', '설렘·애정', '#ec4899'],
  ['anger', '과몰입 분노·답답', '#ef4444'], ['chill', '소름·긴장', '#8b5cf6'], ['shock', '충격·반전', '#f97316'],
  ['cheer', '응원·걱정', '#22c55e'], ['theory', '추리·떡밥', '#14b8a6'], ['praise', '칭찬·감탄', '#b45309'],
  ['complain', '작품 불만', '#64748b'],
];
// In-story reactions (to characters/events) vs. reactions to the work itself
// (praise/complain only appear in files analysed before engine v3).
const ABOUT_WORK = ['praise', 'complain'];
// 작품 평가 = 리디 트래커와 같은 분석법 (scripts/lib/kakao-eval.cjs, 요소 이름은 rabsa 엔진과 같음)
const EVAL_ASPECTS = {
  art: '그림·작화', story: '스토리·전개', character: '캐릭터 매력', chemistry: '케미·관계', romance: '설렘·로맨스',
  immersion: '몰입·재미', writing: '필력·문장', emotion: '분위기·감성', humor: '유머·개그', setting: '세계관·설정',
  spice: '수위', ending: '분량·완결·외전', price: '가격·과금', author: '작가·전작 신뢰', overall: '작품 전체', adapt: '원작 각색',
};
const EV_POS = '#16a34a';
const EV_MID = '#9aa0a8';
const EV_NEG = '#dc2626';
const evalTotals = (ev) => Object.values(ev.asp || {}).reduce((t, s) => [t[0] + s[0], t[1] + s[1], t[2] + (s[2] || 0)], [0, 0, 0]);
function reactionInfo(k) {
  const r = REACTIONS.find((x) => x[0] === k);
  return r ? { label: r[1], color: r[2] } : { label: k, color: 'var(--same)' };
}
function topReactions(cm, n) {
  return Object.entries((cm.react && cm.react.reactions) || {})
    .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1])
    .slice(0, n);
}
function mk(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}
const CM_H3 = 'font-size:13px;color:var(--text-dim);margin:0 0 6px;';
const CM_SUB = 'font-size:12px;color:var(--text-dim);margin:16px 0 6px;font-weight:600;';
const CM_NOTE = 'font-size:11px;color:var(--text-dim);line-height:1.5;';
// Comment body; spoilers stay blurred until tapped (Kakao hides them too).
function commentBody(text, spoiler) {
  const body = mk('div', 'white-space:pre-wrap;word-break:break-all;font-size:13px;', text);
  if (spoiler) {
    body.style.filter = 'blur(5px)';
    body.style.cursor = 'pointer';
    body.title = '스포일러 — 눌러서 보기';
    body.addEventListener('click', () => { body.style.filter = ''; body.style.cursor = ''; body.title = ''; }, { once: true });
  }
  return body;
}
// "웃음 5 · 추리·떡밥 3" from a per-episode {reaction: count} mix
function mixText(mix, n) {
  return Object.entries(mix || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${reactionInfo(k).label} ${v}`).join(' · ');
}
// Sample flags: 's' = spoiler, 'a' = the author's own comment (older files used 1 for spoiler)
function sampleFlags(flags) {
  const f = flags === 1 ? 's' : String(flags || '');
  return { spoiler: f.includes('s'), author: f.includes('a') };
}
function topMixKey(mix) {
  const e = Object.entries(mix || {}).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
}

// ---- 작품 분석 · 댓글로 본 독자 평가 ----
// 리디 트래커와 같은 분석법(cm.ev, scripts/lib/kakao-eval.cjs): 독자들이 좋아한 부분 / 아쉬운 부분 /
// 하차 이유 / 반응 좋았던·아쉬웠던 회차 / 요소별 평가. 작품 속 몰입 반응(웃음·눈물…)은 참고로 한 줄만.
const CM_SEC = 'font-size:14px;font-weight:700;margin:20px 0 6px;';
const CM_ROW = 'padding:7px 0;border-bottom:1px solid var(--border);';

// 댓글 한 줄: '👍공감 · 회차 · 무엇을' + 본문
function quoteRow(likes, ep, tags, text, spoiler) {
  const row = mk('div', CM_ROW);
  const head = [`👍${(likes || 0).toLocaleString()}`];
  if (ep) head.push(ep);
  if (tags && tags.length) head.push(tags.join(' · '));
  row.appendChild(mk('div', 'color:var(--text-dim);font-size:12px;margin-bottom:3px;', head.join(' · ')));
  row.appendChild(commentBody(text, spoiler));
  return row;
}

// 공통 의견 줄: [문장, 건수, 대표 발췌]
function opinionRows(list, sign) {
  const box = mk('div');
  for (const [text, n, quote] of list || []) {
    const row = mk('div', 'padding:4px 0;');
    const top = mk('div', 'display:flex;justify-content:space-between;gap:8px;font-size:13px;');
    top.appendChild(mk('span', `font-weight:600;color:${sign > 0 ? EV_POS : sign < 0 ? EV_NEG : 'var(--text-dim)'};`,
      `${sign > 0 ? '👍' : sign < 0 ? '👎' : '😐'} ${text}`));
    top.appendChild(mk('span', 'flex:none;font-size:12px;color:var(--text-dim);', `${n}건`));
    row.appendChild(top);
    if (quote) row.appendChild(mk('div', 'font-size:12px;color:var(--text-dim);margin-top:2px;word-break:break-all;', `“${quote}”`));
    box.appendChild(row);
  }
  return box;
}

// 요소별 평가 막대 (초록 호평 · 회색 무난 · 빨강 아쉬움), 누르면 예시
function elementBars(ev) {
  const wrap = mk('div');
  const list = Object.entries(ev.asp || {})
    .map(([k, s]) => ({ k, pos: s[0], neg: s[1], mid: s[2] || 0 }))
    .filter((x) => x.pos + x.neg + x.mid > 0)
    .sort((a, b) => (b.pos + b.neg + b.mid) - (a.pos + a.neg + a.mid));
  if (!list.length) return wrap;
  const maxT = Math.max(...list.map((x) => x.pos + x.neg + x.mid));
  for (const x of list) {
    const row = mk('div', 'margin:5px 0;cursor:pointer;');
    const line = mk('div', 'display:flex;align-items:center;gap:8px;font-size:13px;');
    line.appendChild(mk('span', 'width:104px;flex:none;', EVAL_ASPECTS[x.k] || x.k));
    const track = mk('div', 'flex:1;min-width:40px;height:10px;background:var(--accent-soft);border-radius:5px;overflow:hidden;display:flex;');
    for (const [n, color] of [[x.pos, EV_POS], [x.mid, EV_MID], [x.neg, EV_NEG]]) {
      if (n) track.appendChild(mk('div', `height:100%;width:${(n / maxT) * 100}%;background:${color};`));
    }
    line.appendChild(track);
    line.appendChild(mk('span', 'flex:none;min-width:112px;text-align:right;font-size:12px;color:var(--text-dim);',
      `호평 ${x.pos}${x.mid ? ` · 무난 ${x.mid}` : ''} · 아쉬움 ${x.neg}`));
    row.appendChild(line);
    const ex = (ev.ex || {})[x.k];
    if (ex) {
      const exBox = mk('div', 'display:none;margin:6px 0 10px 112px;padding-left:8px;border-left:3px solid var(--border);');
      for (const [side, label, color] of [['p', '호평', EV_POS], ['m', '무난', EV_MID], ['n', '아쉬움', EV_NEG]]) {
        for (const [text, lk] of ex[side] || []) {
          exBox.appendChild(mk('div', `font-size:11px;color:${color};margin-top:6px;`, `${label} · 👍${(lk || 0).toLocaleString()}`));
          exBox.appendChild(commentBody(text));
        }
      }
      row.appendChild(exBox);
      row.addEventListener('click', () => { exBox.style.display = exBox.style.display === 'none' ? 'block' : 'none'; });
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function buildWorkAnalysisBox(cm, onDownload) {
  const ev = cm.ev;
  const box = mk('div');
  box.className = 'chart-box';
  box.id = 'comment-analysis';
  box.style.marginTop = '16px';
  const head = mk('div', 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;');
  head.appendChild(mk('h3', CM_H3, '작품 분석 · 댓글로 본 독자 평가'));
  const dl = mk('button', '', '분석 엑셀 (.xlsx)');
  dl.className = 'dl-btn';
  dl.addEventListener('click', onDownload);
  head.appendChild(dl);
  box.appendChild(head);
  box.appendChild(mk('div', CM_NOTE + 'margin-bottom:8px;',
    `${cm.updated} 기준 · 전체 댓글 ${(cm.total || 0).toLocaleString()}개 중 공감 많은 ${cm.n}개를 읽었어요. ` +
    '리디 트래커와 같은 분석법으로, 작가·전개·작화·이번 화처럼 작품을 두고 한 말만 평가로 셉니다 ' +
    '(작가의 말·다른 작품 얘기·캐릭터에게 화내는 과몰입은 제외).'));
  if (!ev) {
    box.appendChild(mk('div', CM_NOTE, '이 작품은 아직 새 분석 전이에요. 다음 자동 수집 때 채워져요.'));
    return box;
  }

  const [p, n] = evalTotals(ev);
  const chips = mk('div', 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 2px;');
  const chip = (text, color) => chips.appendChild(mk('span',
    `font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;background:var(--accent-soft);color:${color};`, text));
  chip(`호평 ${p}`, EV_POS);
  chip(`아쉬움 ${n}`, EV_NEG);
  if (ev.drop) chip(`하차 선언 ${ev.drop.n}`, EV_NEG);
  chip(`작품을 평가한 댓글 ${ev.used}/${ev.n}`, 'var(--text-dim)');
  box.appendChild(chips);

  // 1) 좋아한 부분 — 공감을 산 부분
  box.appendChild(mk('div', CM_SEC, '👍 독자들이 좋아한 부분 — 공감을 산 부분'));
  const op = ev.op || { pos: [], mid: [], neg: [] };
  if (op.pos.length) box.appendChild(opinionRows(op.pos, 1));
  if (ev.goodTop && ev.goodTop.length) {
    box.appendChild(mk('div', CM_SUB, '공감을 가장 많이 받은 칭찬'));
    ev.goodTop.forEach(([text, likes, ep, said]) => box.appendChild(quoteRow(likes, ep, said, text)));
  }
  if (!op.pos.length && !(ev.goodTop && ev.goodTop.length)) box.appendChild(mk('div', CM_NOTE, '작품을 칭찬한 말이 뚜렷하게 잡히지 않았어요.'));

  // 2) 아쉬운 부분
  box.appendChild(mk('div', CM_SEC, '👎 아쉬운 부분'));
  if (op.neg.length) box.appendChild(opinionRows(op.neg, -1));
  if (op.mid.length) {
    box.appendChild(mk('div', CM_NOTE + 'margin-top:4px;', "무난하다는 평 (칭찬이지만 '그냥 그렇다'에 가까운 말)"));
    box.appendChild(opinionRows(op.mid, 0));
  }
  if (ev.badTop && ev.badTop.length) {
    box.appendChild(mk('div', CM_SUB, '공감을 가장 많이 받은 불만'));
    ev.badTop.forEach(([text, likes, ep, said]) => box.appendChild(quoteRow(likes, ep, said, text)));
  }
  if (!op.neg.length && !(ev.badTop && ev.badTop.length)) box.appendChild(mk('div', CM_NOTE, '반복된 불만은 없어요.'));

  // 3) 하차
  if (ev.drop) {
    box.appendChild(mk('div', CM_SEC, `🚪 하차한 독자들 — 공감 많은 댓글 ${ev.n}개 중 ${ev.drop.n}개가 하차를 말했어요`));
    if (ev.drop.why && ev.drop.why.length) {
      box.appendChild(mk('div', CM_SUB, '하차 이유 (같은 댓글에서 함께 말한 것)'));
      const why = mk('div');
      why.className = 'work-keywords';
      for (const [w, c] of ev.drop.why) why.appendChild(mk('span', '', `${w} ${c}`));
      box.appendChild(why);
    }
    box.appendChild(mk('div', CM_SUB, '공감 많이 받은 하차 댓글'));
    ev.drop.ex.forEach(([text, likes, ep]) => box.appendChild(quoteRow(likes, ep, null, text)));
  }

  // 4) 회차별로 보면 (공감 많은 댓글 기준)
  if ((ev.epGood && ev.epGood.length) || (ev.epBad && ev.epBad.length)) {
    box.appendChild(mk('div', CM_SEC, '📍 회차별로 보면 — 공감 많은 댓글이 칭찬·불만을 남긴 회차'));
    const cols = mk('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;');
    const col = (title, rows, color) => {
      const c = mk('div');
      c.appendChild(mk('div', `font-size:12px;font-weight:700;color:${color};margin-bottom:4px;`, title));
      rows.forEach((r) => c.appendChild(r));
      if (!rows.length) c.appendChild(mk('div', CM_NOTE, '없음'));
      cols.appendChild(c);
    };
    col('반응 좋았던 회차', (ev.epGood || []).map(([label, cnt, , quote, lk]) => {
      const r = mk('div', CM_ROW);
      r.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${label} · 칭찬 ${cnt}건`));
      r.appendChild(mk('div', 'font-size:12px;color:var(--text-dim);word-break:break-all;', `👍${(lk || 0).toLocaleString()} “${quote}”`));
      return r;
    }), EV_POS);
    col('반응 아쉬웠던 회차', (ev.epBad || []).map(([label, cnt, drops, , quote, lk]) => {
      const r = mk('div', CM_ROW);
      r.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${label} · 불만 ${cnt}건${drops ? ` · 하차 ${drops}` : ''}`));
      r.appendChild(mk('div', 'font-size:12px;color:var(--text-dim);word-break:break-all;', `👍${(lk || 0).toLocaleString()} “${quote}”`));
      return r;
    }), EV_NEG);
    box.appendChild(cols);
    if (cm.epScanned) box.appendChild(mk('div', CM_NOTE + 'margin-top:6px;', '모든 회차의 흐름은 아래 「회차별 반응 흐름」에서 볼 수 있어요.'));
  }

  // 5) 요소별 평가
  if (Object.keys(ev.asp || {}).length) {
    box.appendChild(mk('div', CM_SEC, '요소별 평가'));
    box.appendChild(mk('div', CM_NOTE + 'margin-bottom:4px;', '초록 호평 · 회색 무난 · 빨강 아쉬움 — 막대를 누르면 예시 댓글'));
    box.appendChild(elementBars(ev));
  }

  // 6) 참고: 몰입 반응 한 줄 · 자주 나온 말 · 공감 TOP 댓글
  const r = cm.react;
  if (r && r.used) {
    const tops = topReactions(cm, REACTIONS.length).filter(([k]) => !ABOUT_WORK.includes(k)).slice(0, 4)
      .map(([k, [cnt]]) => `${reactionInfo(k).label} ${Math.round((cnt / r.used) * 100)}%`).join(' · ');
    box.appendChild(mk('div', CM_NOTE + 'margin-top:16px;', `참고 · 작품 속 몰입 반응: ${tops}`));
  }
  if (r && r.words && r.words.length) {
    box.appendChild(mk('div', CM_SUB, '자주 나온 말'));
    const kw = mk('div');
    kw.className = 'work-keywords';
    for (const [w, c] of r.words) kw.appendChild(mk('span', '', `${w} ${c}`));
    box.appendChild(kw);
  }
  if (cm.top && cm.top.length) {
    box.appendChild(mk('div', CM_SUB, `공감 TOP ${cm.top.length} 댓글 (전체)`));
    cm.top.forEach(([text, likes, ep, date, flags]) => {
      const { spoiler, author } = sampleFlags(flags);
      box.appendChild(quoteRow(likes, [ep, date].filter(Boolean).join(' · '), author ? ['✍ 작가의 말'] : null, text, spoiler));
    });
  }
  return box;
}

// 회차별 반응 흐름 — r = [order, label, total, scanned, best, mix, releasedAt, engineVersion,
//   [칭찬 댓글, 불만 댓글, 하차 선언], 대표 칭찬, 대표 불만, 무료(1/0)] (칭찬·불만·하차는 회차마다 공감 상위 30개 기준)
function buildEpisodeBox(cm, ep) {
  const rows = Object.values(ep.episodes || {}).sort((a, b) => a[0] - b[0]);
  const box = mk('div');
  box.className = 'chart-box';
  box.style.marginTop = '16px';
  box.appendChild(mk('h3', CM_H3, '회차별 반응 흐름'));
  const total = Math.max(cm.epTotal || 0, rows.length);
  box.appendChild(mk('div', CM_NOTE + 'margin-bottom:10px;',
    `회차 ${rows.length.toLocaleString()}/${total.toLocaleString()}개 분석 · 댓글 수는 그 회차 전체, 칭찬·불만·하차는 회차마다 공감 상위 30개 댓글 기준` +
    (rows.length < total ? ' · 나머지 회차는 매일 조금씩 채워져요' : '')));
  if (!rows.length) return box;

  const evOf = (r) => (Array.isArray(r[8]) ? r[8] : null);
  const IDX = { pos: 0, neg: 1, drop: 2 };
  const modes = [['count', '댓글 수'], ['pos', '작품 칭찬'], ['neg', '작품 불만'], ['drop', '하차 선언']]
    .filter(([k]) => k === 'count' || rows.some((r) => evOf(r) && evOf(r)[IDX[k]]));
  let mode = 'count';
  const val = (r) => (mode === 'count' ? r[2] : ((evOf(r) || [])[IDX[mode]] || 0));
  // 댓글 수 막대 색: 칭찬이 더 많으면 초록, 불만·하차가 더 많으면 빨강
  const tone = (r) => {
    const e = evOf(r);
    if (!e) return 'var(--same)';
    if (e[1] + (e[2] || 0) > e[0]) return EV_NEG;
    if (e[0] > e[1]) return EV_POS;
    return 'var(--same)';
  };

  const tabs = mk('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;');
  tabs.className = 'tabgroup';
  const chartWrap = mk('div');
  const axis = mk('div', 'display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-top:4px;');
  const detail = mk('div', 'margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;');

  function showDetail(r) {
    detail.innerHTML = '';
    detail.appendChild(mk('div', 'font-weight:600;margin-bottom:4px;', `${r[1]}${r[6] ? ` · ${r[6]} 공개` : ''} · 댓글 ${(r[2] || 0).toLocaleString()}개`));
    const e = evOf(r);
    if (e) {
      detail.appendChild(mk('div', 'color:var(--text-dim);font-size:12px;margin-bottom:6px;',
        `작품 평가 (공감 상위 30개 중): 칭찬 ${e[0]} · 불만 ${e[1]}${e.length > 2 ? ` · 하차 ${e[2]}` : ''}`));
    }
    const q = (label, x, color) => {
      if (!x) return;
      detail.appendChild(mk('div', `font-size:11px;color:${color};margin-top:4px;`, `${label}${x[2] ? ` · ${x[2]}` : ''} · 👍${(x[1] || 0).toLocaleString()}`));
      detail.appendChild(commentBody(x[0]));
    };
    q('대표 칭찬', r[9], EV_POS);
    q('대표 불만', r[10], EV_NEG);
    if (r[4]) {
      detail.appendChild(mk('div', 'color:var(--text-dim);font-size:11px;margin-top:4px;', `베스트 댓글 👍${(r[4][1] || 0).toLocaleString()}${r[4][2] ? ' · 스포일러' : ''}`));
      detail.appendChild(commentBody(r[4][0], r[4][2]));
    }
  }

  function drawChart() {
    const NS = 'http://www.w3.org/2000/svg';
    const n = rows.length;
    const W = n * 10;
    const H = 150;
    const vmax = Math.max(1, ...rows.map(val));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.cssText = 'width:100%;height:150px;display:block;cursor:crosshair;';
    rows.forEach((r, i) => {
      const v = val(r);
      if (!v) return;
      const h = Math.max(2, (v / vmax) * (H - 2));
      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('x', i * 10 + 1);
      rect.setAttribute('width', 8);
      rect.setAttribute('y', H - h);
      rect.setAttribute('height', h);
      rect.style.fill = mode === 'count' ? tone(r) : mode === 'pos' ? EV_POS : EV_NEG;
      svg.appendChild(rect);
    });
    const pick = (e) => {
      const b = svg.getBoundingClientRect();
      const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - b.left) / b.width) * n)));
      showDetail(rows[i]);
    };
    svg.addEventListener('mousemove', pick);
    svg.addEventListener('click', pick);
    chartWrap.innerHTML = '';
    chartWrap.appendChild(mk('div', 'font-size:11px;color:var(--text-dim);margin-bottom:2px;',
      `최대 ${vmax.toLocaleString()}개${mode === 'count' ? '' : ' (공감 상위 30개 중)'}`));
    chartWrap.appendChild(svg);
    axis.innerHTML = '';
    axis.appendChild(mk('span', '', rows[0][1]));
    if (n > 2) axis.appendChild(mk('span', '', rows[Math.floor(n / 2)][1]));
    axis.appendChild(mk('span', '', rows[n - 1][1]));
  }
  for (const [k, label] of modes) {
    const b = mk('button', '', label);
    b.dataset.m = k;
    b.addEventListener('click', () => {
      mode = k;
      tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.m === mode));
      drawChart();
    });
    tabs.appendChild(b);
  }
  box.appendChild(tabs);
  box.appendChild(chartWrap);
  box.appendChild(axis);
  box.appendChild(mk('div', CM_NOTE + 'margin-top:4px;', '댓글 수 막대: 초록 = 칭찬이 더 많은 회차, 빨강 = 불만·하차가 더 많은 회차. 차트 위에 마우스를 올리거나 누르면 그 회차를 보여줘요.'));
  box.appendChild(detail);

  // 회차 목록 4가지
  const counts = rows.map((r) => r[2] || 0);
  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const listSec = (title, note, items, render) => {
    if (!items.length) return;
    box.appendChild(mk('div', CM_SEC, title));
    if (note) box.appendChild(mk('div', CM_NOTE + 'margin-bottom:4px;', note));
    items.forEach((it) => {
      const row = mk('div', CM_ROW + 'cursor:pointer;');
      render(it, row);
      row.addEventListener('click', () => { showDetail(it.r); detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
      box.appendChild(row);
    });
  };
  const quoteLine = (row, x, color, label) => {
    if (!x) return;
    row.appendChild(mk('div', `font-size:12px;color:${color};word-break:break-all;`, `${label}${x[2] ? ` (${x[2]})` : ''} 👍${(x[1] || 0).toLocaleString()} “${x[0]}”`));
  };

  // ① 화제가 된 회차: 앞 5화와 뒤 5화 '둘 다'보다 댓글이 1.5배 넘게 달린 회차
  //    (초반 무료 회차는 원래 댓글이 많아서 한쪽만 비교하면 늘 화제처럼 보인다)
  const spikes = rows.map((r, i) => {
    const prev = med(counts.slice(Math.max(0, i - 5), i));
    const next = med(counts.slice(i + 1, i + 6));
    if (!prev || !next) return null;
    return { r, ratio: counts[i] / Math.max(prev, next) };
  }).filter((x) => x && x.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio).slice(0, 6);
  listSec('🔥 화제가 된 회차', '앞뒤 회차보다 댓글이 확 늘어난 곳 — 무슨 장면이었는지는 베스트 댓글로', spikes, ({ r, ratio }, row) => {
    row.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${r[1]} · 댓글 ${(r[2] || 0).toLocaleString()}개 (앞뒤 회차의 ${ratio.toFixed(1)}배)`));
    if (r[4]) row.appendChild(mk('div', 'font-size:12px;color:var(--text-dim);word-break:break-all;', `베스트 👍${(r[4][1] || 0).toLocaleString()} “${r[4][2] ? '(스포일러)' : r[4][0]}”`));
  });
  // ② 칭찬이 많았던 회차
  const good = rows.filter((r) => evOf(r) && evOf(r)[0] > 0).sort((a, b) => evOf(b)[0] - evOf(a)[0] || b[2] - a[2]).slice(0, 6).map((r) => ({ r }));
  listSec('👍 칭찬이 많았던 회차', '공감 상위 30개 댓글 중 작품을 칭찬한 댓글이 많은 회차', good, ({ r }, row) => {
    row.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${r[1]} · 칭찬 ${evOf(r)[0]}건 · 댓글 ${(r[2] || 0).toLocaleString()}개`));
    quoteLine(row, r[9], EV_POS, '대표 칭찬');
  });
  // ③ 불만·하차가 나온 회차
  const bad = rows.filter((r) => evOf(r) && (evOf(r)[1] || evOf(r)[2])).sort((a, b) => (evOf(b)[1] + 2 * (evOf(b)[2] || 0)) - (evOf(a)[1] + 2 * (evOf(a)[2] || 0)) || b[2] - a[2]).slice(0, 6).map((r) => ({ r }));
  listSec('👎 불만·하차가 나온 회차', '공감 상위 30개 댓글 중 작품에 불만을 말하거나 하차를 선언한 댓글이 많은 회차', bad, ({ r }, row) => {
    const e = evOf(r);
    row.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${r[1]} · 불만 ${e[1]}건${e[2] ? ` · 하차 ${e[2]}` : ''}`));
    quoteLine(row, r[10], EV_NEG, '대표 불만');
  });
  // ④ 댓글이 크게 줄어든 지점 (하차 신호): 이 회차까지 4화의 중간값보다 다음 4화가 40% 넘게 적은 곳
  //    (갓 나온 최신 회차는 댓글이 아직 쌓이는 중이라 뺀다)
  const falls = [];
  for (let i = 3; i < rows.length - 8; i++) {
    const before = med(counts.slice(i - 3, i + 1));
    const after = med(counts.slice(i + 1, i + 5));
    if (before >= 20 && after / before <= 0.6) falls.push({ r: rows[i], i, ratio: after / before, paywall: rows[i][11] === 1 && rows[i + 1][11] === 0 });
  }
  const kept = [];
  falls.sort((a, b) => a.ratio - b.ratio).forEach((f) => { if (!kept.some((k) => Math.abs(k.i - f.i) <= 3) && kept.length < 5) kept.push(f); });
  kept.sort((a, b) => a.i - b.i);
  listSec('📉 댓글이 크게 줄어든 지점', '이 회차 이후 댓글이 확 줄었어요 — 독자가 빠졌을 수 있는 곳 (무료→유료 경계면 표시)', kept, ({ r, ratio, paywall }, row) => {
    row.appendChild(mk('div', 'font-size:13px;font-weight:600;', `${r[1]} 이후 댓글 ${Math.round((1 - ratio) * 100)}% 감소${paywall ? ' · 무료→유료 경계' : ''}`));
    quoteLine(row, r[10], EV_NEG, '그 회차 대표 불만');
  });

  tabs.querySelector('button').classList.add('active');
  drawChart();
  showDetail(rows[rows.length - 1]);
  return box;
}

function downloadCommentExcel(title, cm, ep) {
  const wb = XLSX.utils.book_new();
  const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  const ev = cm.ev;
  if (ev) {
    const [p, n] = evalTotals(ev);
    const op = ev.op || { pos: [], mid: [], neg: [] };
    add([['작품', title], ['기준일', cm.updated], ['전체 댓글 수', cm.total], ['분석한 댓글 (공감순)', ev.n], ['작품을 평가한 댓글', ev.used],
      ['호평', p], ['아쉬움', n], ['하차 선언', ev.drop ? ev.drop.n : 0], [],
      ['구분', '공통 의견', '건수', '대표 댓글']]
      .concat(op.pos.map((o) => ['좋은 점', o[0], o[1], o[2] || '']), op.mid.map((o) => ['무난', o[0], o[1], o[2] || '']), op.neg.map((o) => ['아쉬운 점', o[0], o[1], o[2] || ''])), '요약·공통 의견');
    add([['공감', '회차', '무엇을', '댓글']].concat((ev.goodTop || []).map((q) => [q[1], q[2], (q[3] || []).join(', '), q[0]])), '공감 받은 칭찬');
    add([['공감', '회차', '무엇을', '댓글']].concat((ev.badTop || []).map((q) => [q[1], q[2], (q[3] || []).join(', '), q[0]])), '공감 받은 불만');
    if (ev.drop) {
      add([['하차 이유', '댓글 수']].concat(ev.drop.why || [], [[], ['공감', '회차', '하차 댓글']], (ev.drop.ex || []).map((x) => [x[1], x[2], x[0]])), '하차');
    }
    add([['구분', '회차', '건수', '하차', '대표 댓글 공감', '대표 댓글']]
      .concat((ev.epGood || []).map((x) => ['반응 좋았던 회차', x[0], x[1], '', x[4], x[3]]), (ev.epBad || []).map((x) => ['반응 아쉬웠던 회차', x[0], x[1], x[2], x[5], x[4]])), '회차별(공감 댓글 기준)');
    add([['요소', '호평', '무난', '아쉬움', '강한 호평', '강한 불만', '호평 예시', '아쉬움 예시']]
      .concat(Object.entries(ev.asp || {}).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1])).map(([k, s]) => {
        const ex = (ev.ex || {})[k] || {};
        return [EVAL_ASPECTS[k] || k, s[0], s[2] || 0, s[1], s[3] || 0, s[4] || 0, ((ex.p || [])[0] || [])[0] || '', ((ex.n || [])[0] || [])[0] || ''];
      })), '요소별 평가');
  }
  add([['순위', '공감', '회차', '작성일', '스포일러', '작가의 말', '댓글']]
    .concat((cm.top || []).map(([text, likes, epl, date, flags], i) => {
      const { spoiler, author } = sampleFlags(flags);
      return [i + 1, likes, epl, date, spoiler ? 'Y' : '', author ? 'Y' : '', text];
    })), '공감 TOP 댓글');
  if (ep && ep.episodes) {
    const head = ['순서', '회차', '공개일', '무료', '댓글 수', '칭찬 댓글 (상위30 중)', '불만 댓글 (상위30 중)', '하차 선언',
      '대표 칭찬', '대표 칭찬 공감', '대표 불만', '대표 불만 공감', '베스트 댓글', '베스트 공감', '수집일'];
    const body = Object.values(ep.episodes).sort((a, b) => a[0] - b[0]).map((e) => {
      const v = Array.isArray(e[8]) ? e[8] : [];
      return [e[0], e[1], e[6] || '', e[11] === 1 ? 'Y' : '', e[2], v[0] ?? '', v[1] ?? '', v[2] ?? '',
        e[9] ? e[9][0] : '', e[9] ? e[9][1] : '', e[10] ? e[10][0] : '', e[10] ? e[10][1] : '',
        e[4] ? e[4][0] : '', e[4] ? e[4][1] : '', e[3]];
    });
    add([head].concat(body), '회차별');
  }
  XLSX.writeFile(wb, `${String(title).replace(/[\\/:*?"<>|]/g, '_')}_작품분석_${cm.updated}.xlsx`);
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

function buildChart(series, bands) {
  return buildLineChart(series, {
    valueKey: 'rank',
    higherIsBetter: false,
    formatValue: (v) => `${v}위`,
    emptyText: '표시할 순위 기록이 없습니다.',
    bands,
  });
}

function buildViewCountChart(series, bands) {
  return buildLineChart(series, {
    valueKey: 'value',
    higherIsBetter: true,
    formatValue: formatCount,
    emptyText: '표시할 조회수 기록이 없습니다.',
    bands,
  });
}

// bands = [{s, e, family, title}] 프로모션 기간 (없어도 됨)
function buildLineChart(series, { valueKey, higherIsBetter, formatValue, emptyText, bands = [] }) {
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

  // 프로모션 기간: 그 기간에 든 점들 뒤에 옅은 색 띠를 깐다. 계열이 여럿 겹치는
  // 날은 높이를 나눠 계열마다 제 띠에 칠한다(반투명을 포개면 색이 섞여 견본과 안 맞는다).
  // 가로축은 날짜가 아니라 점 순서라, 띠도 그 기간에 든 점들 기준이다.
  const famsAt = series.map((pt) => {
    const at = {};
    for (const b of bands) if (b.s <= pt.date && pt.date <= b.e) (at[b.family] = at[b.family] || []).push(b.title);
    return at;
  });
  const bandKey = (i) => PROMO_SHADED.filter((f) => famsAt[i][f]).map((f) => `${f}:${famsAt[i][f].join('|')}`).join(';');
  const step = n > 1 ? plotW / (n - 1) : plotW;
  for (let i = 0; i < n; ) {
    const k = bandKey(i);
    if (!k) { i += 1; continue; }
    let j = i;
    while (j + 1 < n && bandKey(j + 1) === k) j += 1;
    const fams = PROMO_SHADED.filter((f) => famsAt[i][f]);
    const x0 = Math.max(padL, xFor(i) - step / 2);
    const x1 = Math.min(width - padR, xFor(j) + step / 2);
    const lane = plotH / fams.length;
    fams.forEach((f, li) => {
      const r = document.createElementNS(svgNS, 'rect');
      r.setAttribute('x', x0);
      r.setAttribute('y', padT + li * lane);
      r.setAttribute('width', Math.max(1, x1 - x0));
      r.setAttribute('height', lane);
      r.setAttribute('class', `band fam-${f}`);
      const tt = document.createElementNS(svgNS, 'title');
      tt.textContent = `${PROMO_FAMILY[f].label}: ${famsAt[i][f].join(', ')}`;
      r.appendChild(tt);
      svg.appendChild(r);
    });
    i = j + 1;
  }

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
  path.setAttribute('stroke', 'var(--accent-ink)');
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  const labelEvery = dots.length <= 15 ? 1 : Math.ceil(dots.length / 15);
  dots.forEach((d, idx) => {
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', d.x);
    c.setAttribute('cy', d.y);
    c.setAttribute('r', 3);
    c.setAttribute('fill', 'var(--accent-ink)');
    const title = document.createElementNS(svgNS, 'title');
    const promoTitles = bands.filter((b) => b.s <= d.pt.date && d.pt.date <= b.e).map((b) => b.title);
    title.textContent = `${d.pt.date}: ${formatValue(d.pt[valueKey])}` + (promoTitles.length ? `\n🎁 ${promoTitles.join(', ')}` : '');
    c.appendChild(title);
    svg.appendChild(c);

    if (idx % labelEvery === 0) {
      const above = d.y > padT + 14;
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', d.x);
      label.setAttribute('y', above ? d.y - 8 : d.y + 16);
      label.setAttribute('font-size', '11');
      label.setAttribute('font-weight', '600');
      label.setAttribute('fill', 'var(--accent-ink)');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = formatValue(d.pt[valueKey]);
      svg.appendChild(label);
    }
  });

  return svg;
}

function parseCount(text) {
  if (text == null) return null;
  if (typeof text === 'number') return text; // exact integer (BFF) — no rounding
  const cleaned = String(text).replace(/,/g, '').trim();
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

let searchIndexCache = null;
async function getSearchIndex() {
  // Title+author index of every work that has EVER been ranked (incl. works
  // that have since dropped out of the rankings), so search isn't limited to
  // the current TOP lists.
  if (!searchIndexCache) searchIndexCache = await fetchJson('data/search-index.json').catch(() => []);
  return searchIndexCache;
}

async function runSearch(query) {
  const index = await getSearchIndex();
  const q = query.toLowerCase();
  const items = [];
  const pubHits = new Map(); // publisher name -> number of matching works
  for (const it of index) {
    const title = (it.title || '').toLowerCase();
    const author = (it.author || '').toLowerCase();
    const publisher = it.publisher || '';
    if (publisher && publisher.toLowerCase().includes(q)) pubHits.set(publisher, (pubHits.get(publisher) || 0) + 1);
    if ((title.includes(q) || author.includes(q) || publisher.toLowerCase().includes(q)) && items.length < 30) items.push(it);
  }

  searchResults.innerHTML = '';

  // Publisher shortcuts → a 50:50 (cumulative views + overall rank) ranking view.
  const pubs = [...pubHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [pub, cnt] of pubs) {
    const row = document.createElement('div');
    row.className = 'sr-item';
    row.style.cssText = 'font-weight:600;color:var(--accent-ink);';
    row.textContent = `📚 출판사 "${pub}" 작품 ${cnt}개 종합순위`;
    row.addEventListener('click', () => {
      searchResults.classList.remove('open');
      searchBox.value = '';
      navigate(`#/publisher/${encodeURIComponent(pub)}`);
    });
    searchResults.appendChild(row);
  }

  if (items.length === 0 && pubs.length === 0) {
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
      const bits = [catLabel];
      if (it.subCategory) bits.push(it.subCategory);
      if (it.author) bits.push(it.author);
      subDiv.textContent = bits.join(' · ');
      meta.appendChild(titleDiv);
      meta.appendChild(subDiv);
      div.appendChild(img);
      div.appendChild(meta);
      div.addEventListener('click', () => {
        searchResults.classList.remove('open');
        searchBox.value = '';
        navigate(`#/work/${it.cat}/daily/${it.workId}`);
      });
      searchResults.appendChild(div);
    }
  }

  const kakaoLink = document.createElement('a');
  kakaoLink.className = 'sr-item';
  kakaoLink.href = `https://page.kakao.com/search?query=${encodeURIComponent(query)}`;
  kakaoLink.target = '_blank';
  kakaoLink.rel = 'noopener noreferrer';
  kakaoLink.style.cssText = 'color:var(--accent-ink);justify-content:center;font-weight:600;';
  kakaoLink.textContent = `🔍 카카오페이지에서 "${query}" 검색하기`;
  searchResults.appendChild(kakaoLink);

  searchResults.classList.add('open');
}
