// 전 작품 회차별 댓글 수 — 작품 상세의 '회차별 댓글 수' 막대그래프용 (2026-10-11, 사용자 요청)
//
// 매일 도는 수집과 따로 도는 새 작업이다(.github/workflows/epcounts.yml, 새벽 01시 KST, 06:30 전에 멈춤).
// 사용자 규칙: 새 작업은 카카오 요청 사이 2초 이상, '너무 많음(429)·잠시 불가(503)'가 2번 연속이면 멈춘다.
//
// docs/data/epcounts/{id}.json — 숫자와 회차 이름만(댓글 원문·닉네임 없음):
//   { v, at: 'YYYY-MM-DD' 마지막으로 센 날, full: 전 회차를 센 날, cc: 그때 작품 전체 댓글 수,
//     c: [회차별 댓글 수 (답글 제외 — 카카오 total_count)], d: [공개일 'YYMMDD'], no: [화 번호, 없으면 null],
//     x: { 순번: '외전 1화' … 화 번호가 없는 회차의 이름 }, g: 같은 날 함께 공개된 회차 수(2 이상인 회차만 {순번: 수}),
//     h1/h3/h7: [공개 후 24시간·72시간·7일 안에 달린 댓글 수] — '같은 시점 비교'용(요청서: 오래된 회차는 댓글이 오래 쌓여 유리하므로).
//       작품 댓글을 처음부터 끝까지 넘기며 세는 작품(S)만 작성 시각으로 계산된다. 회차마다 따로 세는 큰 작품(E)은 없음.
//       공개된 지 그 기간이 안 지난 회차는 null(아직 쌓이는 중). }
//   '지금 무료' 같은 오늘 기준 상태는 저장하지 않는다(과거 회차 판정에 쓰면 틀림 — 요청서).
//   순번은 읽는 순서(1화 쪽이 0). 작가 인사·내용 없는 댓글도 한 개로 센다(분석에서만 뺌).
// docs/data/epcounts/state.json — 진행 기록(마지막 실행, 채운 작품 수, 남은 작품 수, 요청 수).
//
// 세는 방법 (작품마다 더 싼 쪽)
//   E: 회차마다 댓글 목록을 1개만 요청해 total_count를 읽는다 (회차 수만큼 요청).
//   S: 작품 댓글을 최신순으로 100개씩 끝까지 넘기며 회차별로 센다 (댓글 수÷100번 요청) —
//      작은 작품에만 쓰고, 합이 작품 전체 수와 맞지 않으면 E로 다시 센다.
// 순서
//   ① 갱신: 이미 센 작품은 일주일에 한 번(작품마다 요일을 나눔), 댓글이 늘었을 때만 최근 60일 회차와 새 회차를 다시 센다.
//      4주에 한 번은 전 회차를 다시 센다(옛 회차에 늦게 달린 댓글·삭제 반영).
//   ② 백필: 아직 없는 작품 — 지금 순위권 → 순위(TOP 300)에 든 적 있는 작품 → 나머지, 같은 층에선 댓글 많은 순.
//      일간 TOP 100 작품은 댓글 분석 작업(collect-comments.mjs)이 회차 표(data/comments/ep)를 이미 만들므로 건너뛴다.
// 실행: node scripts/collect-episode-counts.mjs [--minutes 290] [--stop-utc 21:30] [--ids 1,2] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { episodeLabel } from './lib/kakao-comments.mjs';

const DATA = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA, 'epcounts');
const STATE = path.join(OUT, 'state.json');
const BFF = 'https://bff-page.kakao.com/api/gateway';
const HEADERS = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
};
const GAP_MS = 2000;
const RECENT_DAYS = 60;        // 갱신 때 다시 세는 최근 회차 범위
const FULL_EVERY_DAYS = 28;    // 전 회차 다시 세기 주기
const S_MAX_COMMENTS = 50000;
const WINDOWS = [['h1', 1], ['h3', 3], ['h7', 7]];   // 공개 후 며칠 안에 달린 댓글을 셀지  // S(최신순 넘기기)는 댓글이 이만큼 이하이고 쪽수가 회차 수보다 적은 작품만 (최대 500쪽)
const V = 2;   // 2: 공개 후 1·3·7일 댓글 수, 같은 날 공개 수, 오늘 기준 무료 표시 뺌

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const ymd = (s) => { const m = String(s || '').match(/^(\d{2})(\d{2})-(\d{2})-(\d{2})/); return m ? m[2] + m[3] + m[4] : ''; };

export class Blocked extends Error {}
export class TimeUp extends Error {}
let deadlineAt = Infinity;   // 큰 작품 하나를 세다가도 이 시각이 되면 멈춘다(그 작품은 저장하지 않고 다음에 다시)
let lastAt = 0, strikes = 0;
export let requests = 0;
async function call(url, init = {}) {
  if (Date.now() > deadlineAt) throw new TimeUp('시간이 다 됨');
  for (let tries = 0; ; tries++) {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    requests++;
    let r;
    try { r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (tries < 2) { await sleep(5000); continue; } throw e; }
    if (r.status === 429 || r.status === 503) {
      if (++strikes >= 2) throw new Blocked(`카카오가 요청을 막았습니다 (${r.status})`);
      await sleep(60000);
      continue;
    }
    strikes = 0;
    if (!r.ok) { if (r.status >= 500 && tries < 2) { await sleep(5000); continue; } throw new Error(`HTTP ${r.status}`); }
    return r.json();
  }
}
let bust = (Date.now() % 1e6) * 10;
async function commentPage(params) {
  const j = await call(`${BFF}/api/v8/store/community/list/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, page: String(++bust) }).toString(),
  });
  if (j.result_code !== 0) throw new Error(`comment code ${j.result_code}`);
  // 닉네임·프로필 사진은 받는 즉시 버린다 — 회차 id와 댓글 번호만 남김
  return { total: Number(j.total_count) || 0, end: !!j.is_end, list: (j.comment_list || []).map((c) => ({ uid: c.comment_uid, single: c.single_id, at: c.create_dt || '' })) };
}

// 회차 목록(읽는 순서) — product/list는 최신부터 오므로 order_value로 정렬
export async function episodes(id) {
  const eps = [];
  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    const q = new URLSearchParams({ series_id: String(id), cursor_index: String(cursor), cursor_direction: 'NEXT', window_size: '100' });
    const j = await call(`${BFF}/api/v2/content/product/list?${q}`);
    const list = (j && j.result && j.result.list) || [];
    for (const x of list) {
      const it = x.item || {};
      if (!it.product_id || seen.has(it.product_id)) continue;
      seen.add(it.product_id);
      eps.push({ pid: String(it.product_id), order: it.order_value ?? null, title: it.title || '', free: !!it.is_free, at: it.start_sale_dt || '', ci: x.cursor_index });
    }
    if (!list.length || !(j.result && j.result.has_next)) break;
    cursor = list[list.length - 1].cursor_index;
  }
  const byOrder = eps.every((e) => e.order != null);
  eps.sort((a, b) => (byOrder ? a.order - b.order : b.ci - a.ci));
  return eps;
}

// E: 회차 하나의 댓글 수
const countOne = async (id, pid) => (await commentPage({ seriesid: String(id), singleid: pid, sort_opt: 'like', size: '1' })).total;

// S: 작품 댓글을 최신순으로 끝까지 넘기며 회차별로 센다. 작성 시각으로 공개 후 1·3·7일 안의 수도 센다.
// rel: 회차 id → 공개 시각(ms). 합이 작품 전체 수와 맞지 않으면 null.
const ms = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + (/[zZ+]/.test(String(s)) ? '' : '+09:00')); return Number.isFinite(t) ? t : null; };
async function countBySeries(id, maxPages, rel) {
  const by = new Map();
  const win = Object.fromEntries(WINDOWS.map(([k]) => [k, new Map()]));
  let last = null, total = null, seen = 0, oldest = Infinity;
  for (let p = 0; p < maxPages; p++) {
    const params = { seriesid: String(id), sort_opt: 'latest', size: '100' };
    if (last) params.last_comment_uid = String(last);
    const j = await commentPage(params);
    if (total == null) total = j.total;
    for (const c of j.list) {
      seen++;
      if (!c.single) continue;
      const k = String(c.single);
      by.set(k, (by.get(k) || 0) + 1);
      const r = rel.get(k), a = ms(c.at);
      if (a != null && a < oldest) oldest = a;
      if (r != null && a != null) for (const [w, days] of WINDOWS) if (a - r <= days * 86400e3) win[w].set(k, (win[w].get(k) || 0) + 1);
    }
    if (!j.list.length || j.end) {
      const ok = Math.abs(seen - total) <= Math.max(2, total * 0.01);
      return ok ? { by, total, win, oldest } : null;
    }
    last = j.list[j.list.length - 1].uid;
  }
  return null;
}

const epNo = (title) => {
  const t = String(title || '');
  if (/트레일러|예고|공지|휴재|후기|인사말|외전|번외|특별편/.test(t)) return null;
  const m = t.match(/(\d+)\s*화(?!.*\d+\s*화)/);
  return m ? Number(m[1]) : (/프롤로그/.test(t) ? 0 : null);
};

// 작품 하나를 센다. old가 있으면 최근 회차만(full=false) 또는 전부(full=true).
async function countWork(w, old, full, today) {
  const eps = await episodes(w.id);
  if (!eps.length) return null;
  const prev = new Map();
  if (old && old.c) {
    // 지난번 값은 순번이 아니라 공개일+화 번호로 맞춘다 (중간에 회차가 끼면 순번이 밀리므로)
    old.c.forEach((cnt, i) => prev.set(`${old.d[i]}|${old.no[i] ?? old.x?.[i] ?? ''}`, cnt));
  }
  const key = (e) => `${ymd(e.at)}|${epNo(e.title) ?? episodeLabel(e.title, w.title)}`;
  const counts = new Array(eps.length).fill(null);
  let method = 'E';
  const pages = Math.ceil((w.cc || 0) / 100);
  let win = null;
  if (w.cc <= S_MAX_COMMENTS && pages + 1 < eps.length) {
    const rel = new Map(eps.map((e) => [e.pid, ms(e.at)]));
    const r = await countBySeries(w.id, pages + 20, rel);
    if (r) {
      eps.forEach((e, i) => { counts[i] = r.by.get(e.pid) || 0; });
      method = 'S';
      // 공개된 지 그 기간이 안 지난 회차는 아직 쌓이는 중 → null
      const now = Date.now();
      win = Object.fromEntries(WINDOWS.map(([k, days]) => [k, eps.map((e) => {
        const t = ms(e.at);
        // 댓글 기능이 생기기 전에 공개된 회차(작품의 가장 오래된 댓글보다 이른 회차)는 같은 시점 비교가 안 됨 → null
        if (t == null || t < r.oldest - 86400e3) return null;
        return now - t >= days * 86400e3 ? (r.win[k].get(e.pid) || 0) : null;
      })]));
    }
  }
  if (method === 'E') {
    for (let i = eps.length - 1; i >= 0; i--) {   // 최신 회차부터 — 끊기면 오른쪽(최근)이 먼저 채워진다
      const e = eps[i];
      const recent = e.at && daysBetween(e.at.slice(0, 10), today) <= RECENT_DAYS;
      if (!full && old && !recent && prev.has(key(e))) { counts[i] = prev.get(key(e)); continue; }
      counts[i] = await countOne(w.id, e.pid);
    }
  }
  const x = {};
  const no = eps.map((e, i) => { const n = epNo(e.title); if (n == null) x[i] = episodeLabel(e.title, w.title) || e.title; return n; });
  const d = eps.map((e) => ymd(e.at));
  const sameDay = {};
  d.forEach((day, i) => { const k = d.filter((y) => y === day).length; if (day && k > 1) sameDay[i] = k; });
  return {
    v: V, at: today, full: method === 'S' || full || !old ? today : old.full, cc: w.cc, m: method,
    c: counts, d, no, ...(Object.keys(x).length ? { x } : {}), ...(Object.keys(sameDay).length ? { g: sameDay } : {}),
    ...(win || {}),
  };
}

// 순위 층: 지금 순위권(일간·주간·월간 최신) → 순위에 든 적 있는 작품 → 나머지
function tiers() {
  const now = new Set(), ever = new Set();
  for (const cat of ['webtoon', 'webnovel']) for (const per of ['daily', 'weekly', 'monthly']) {
    const dir = path.join(DATA, cat, per);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const list = readJson(path.join(dir, f), []);
      for (const x of Array.isArray(list) ? list : []) { ever.add(String(x.workId)); if (f === 'latest.json') now.add(String(x.workId)); }
    }
  }
  return { now, ever };
}

export async function run({ minutes = 290, stopUtc = null, ids = null, dry = false } = {}) {
  const t0 = Date.now();
  let deadline = t0 + minutes * 60e3;
  if (stopUtc) {
    const [h, m] = stopUtc.split(':').map(Number);
    const d = new Date(); d.setUTCHours(h, m, 0, 0);
    if (d.getTime() < t0) d.setUTCDate(d.getUTCDate() + 1);
    deadline = Math.min(deadline, d.getTime());
  }
  deadlineAt = deadline;
  const today = kstToday();
  fs.mkdirSync(OUT, { recursive: true });
  const lite = readJson(path.join(DATA, 'works-lite.json'), {});
  const metrics = readJson(path.join(DATA, 'metrics', 'latest.json'), {});
  const deepDir = path.join(DATA, 'comments', 'ep');
  const deep = new Set(fs.existsSync(deepDir) ? fs.readdirSync(deepDir).map((f) => f.replace('.json', '')) : []);
  const { now, ever } = tiers();
  const dayIdx = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400e3);
  const all = Object.keys(lite).map((id) => ({ id, title: lite[id].title, cc: (metrics[id] && metrics[id].cc) || 0 }))
    .filter((w) => !ids || ids.includes(w.id));

  // ① 갱신 대상: 이미 센 작품 중 오늘이 그 작품의 요일이고 댓글이 늘었거나 전체 다시 세기 때가 된 것
  const refresh = [], backfill = [];
  for (const w of all) {
    if (!w.cc) continue;
    const f = path.join(OUT, `${w.id}.json`);
    const old = fs.existsSync(f) ? readJson(f, null) : null;
    if (old) {
      const slot = ids || (Number(w.id) + dayIdx) % 7 === 0;
      const dueFull = !old.full || daysBetween(old.full, today) >= FULL_EVERY_DAYS;
      // 저장 형식이 바뀐 파일(옛 버전)은 요일과 상관없이 전부 다시 센다
      if (old.v !== V) refresh.push({ w, old: null, full: true });
      else if (slot && (w.cc !== old.cc || dueFull)) refresh.push({ w, old, full: dueFull });
    } else if (ids || !deep.has(w.id)) backfill.push(w);
  }
  const tier = (w) => (now.has(w.id) ? 0 : ever.has(w.id) ? 1 : 2);
  backfill.sort((a, b) => tier(a) - tier(b) || b.cc - a.cc);
  console.log(`episode counts: refresh ${refresh.length}, backfill ${backfill.length} (now ${backfill.filter((w) => tier(w) === 0).length}, ever ranked ${backfill.filter((w) => tier(w) === 1).length}), stop at ${new Date(deadline).toISOString()}`);
  if (dry) return;

  let done = 0, failed = 0, stopped = null;
  const queue = [...refresh.map((r) => ({ ...r, kind: 'refresh' })), ...backfill.map((w) => ({ w, old: null, full: true, kind: 'backfill' }))];
  for (const job of queue) {
    // 작품 하나가 끝날 때까지 걸릴 시간을 대략 남겨 둔다 (큰 작품은 회차 수 × 2초)
    if (Date.now() + 10 * 60e3 > deadline) { stopped = 'time'; break; }
    try {
      const r = await countWork(job.w, job.old, job.full, today);
      if (r) fs.writeFileSync(path.join(OUT, `${job.w.id}.json`), JSON.stringify(r));
      done++;
      if (done % 25 === 0) console.log(`  ...${done} works, ${requests} requests, ${Math.round((Date.now() - t0) / 60e3)} min`);
    } catch (e) {
      if (e instanceof Blocked) { stopped = 'blocked'; console.error(e.message); break; }
      if (e instanceof TimeUp) { stopped = 'time'; break; }
      failed++;
      console.error(`  ${job.w.id} ${job.w.title}: ${e.message}`);
    }
  }
  const remaining = backfill.length - Math.max(0, done - refresh.length);
  const state = { lastRun: today, minutes: Math.round((Date.now() - t0) / 60e3), done, failed, requests, stopped, refresh: refresh.length, backfillLeft: Math.max(0, remaining),
    files: fs.readdirSync(OUT).filter((f) => f !== 'state.json').length };
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(`episode counts: ${JSON.stringify(state)}`);
  if (stopped === 'blocked') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  run({
    minutes: Number(opt('--minutes') || 290),
    stopUtc: opt('--stop-utc'),
    ids: opt('--ids') ? opt('--ids').split(',') : null,
    dry: a.includes('--dry'),
  }).catch((e) => { console.error(e); process.exit(1); });
}
