// 회차 분량(웹툰 회차 이미지 장 수) — 일주일에 한 번 (사용자 요청 2026-10-19 "회차분량은 크롤링하자, 매주").
//
// 카카오 회차 목록(product/list)이 회차마다 주는 page_count(웹툰 = 그 회차 이미지 장 수)와 size(MB)를 모은다.
// 웹소설은 page_count가 늘 1이고 size는 글꼴·삽화가 섞인 파일 크기라 글 길이가 아니다(2026-10-19 확인:
// 작품 안에서 358~360KB로 거의 같거나, 삽화 때문에 0.6~17MB로 튐) → 웹툰만 모은다.
//
// 대상(works.json의 웹툰): 지금 순위권 → 연재 중 → 아직 안 받은 완결작 순.
//   이미 받은 작품은 최신 회차부터 받아 아는 회차에 닿으면 멈춘다(연재 중 작품은 대개 요청 1번).
//   완결작은 한 번 다 받으면 다시 받지 않는다. 이번 주(6일 안)에 받은 작품은 건너뛴다(이어 돌릴 때).
// 카카오 요청 사이 2초, 실패(429·503·끊김)가 3번 연속이면 멈춘다. 시간 상한 안에서 한 것만 저장.
// 매일 수집·댓글 수집과 따로 돈다(파일도 따로: docs/data/eplen/).
//
// 출력 docs/data/eplen/{id}.json = { v: 1, at: 'YYYY-MM-DD', total, e: [[order_value, 회차 이름, 장 수, KB, 'YYMMDD', product_id], …] }
//   (읽는 순서. 회차 이름은 댓글 표와 같은 episodeLabel — 사이트가 이름으로 맞춘다)
//      docs/data/eplen/index.json = { at, ids: { id: 회차 수 } }
//
// node scripts/collect-episode-length.mjs [--minutes 300] [--stop-utc 15:30] [--ids a,b] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { episodeLabel, sleep } from './lib/kakao-comments.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = path.join(ROOT, 'docs', 'data');
const OUT = path.join(DATA, 'eplen');
const BFF = 'https://bff-page.kakao.com/api/gateway/api/v2/content/product/list';
const HEADERS = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
};
const GAP_MS = 2000;
const MAX_FAILS = 3;
const FRESH_DAYS = 6;
const V = 1;

const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const yymmdd = (s) => (s ? s.slice(2, 10).replace(/-/g, '') : '');

class Blocked extends Error {}
let fails = 0;
let requests = 0;
async function page(id, cursor) {
  const q = new URLSearchParams({ series_id: String(id), cursor_index: String(cursor), cursor_direction: 'NEXT', window_size: '100' });
  requests++;
  try {
    const r = await fetch(`${BFF}?${q}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (r.status === 429 || r.status === 503) throw new Error(`HTTP ${r.status}`);
    if (!r.ok) { fails = 0; return null; }            // 없는 작품 등 — 막힘은 아님
    const j = await r.json();
    fails = 0;
    return j && j.result ? j.result : null;
  } catch (e) {
    if (++fails >= MAX_FAILS) throw new Blocked(`카카오 요청이 ${MAX_FAILS}번 연속 실패해 멈춥니다 (${e.message})`);
    return null;
  } finally {
    await sleep(GAP_MS);
  }
}

// 최신 회차부터 받아 이미 아는 회차에 닿으면 멈춘다
async function fetchWork(id, old) {
  const known = new Set((old && old.e ? old.e : []).map((x) => x[5]));
  const got = new Map();
  let total = old ? old.total : 0, title = '', cursor = 0, done = false, ok = false;
  for (let i = 0; i < 200 && !done; i++) {
    const res = await page(id, cursor);
    if (!res) break;
    ok = true;
    total = res.total_count ?? total;
    title = (res.series_item && res.series_item.title) || title;
    if (res.series_item && res.series_item.category && res.series_item.category !== '웹툰') return { skip: 'not-webtoon' };
    const list = res.list || [];
    for (const x of list) {
      const it = x.item || {};
      if (!it.product_id) continue;
      if (known.has(it.product_id)) { done = true; continue; }
      got.set(it.product_id, [it.order_value ?? null, episodeLabel(it.title, title), it.page_count ?? null,
        it.size != null ? Math.round(it.size * 1024) : null, yymmdd(it.start_sale_dt), it.product_id]);
    }
    if (!list.length || !res.has_next) break;
    cursor = list[list.length - 1].cursor_index;
  }
  if (!ok) return { failed: true };
  const e = [...(old && old.e ? old.e : []), ...got.values()]
    .filter((x, k, a) => a.findIndex((y) => y[5] === x[5]) === k)
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  return { file: { v: V, at: kstDate(), total, e }, added: got.size };
}

function targets(only) {
  if (only) return only;
  const works = readJson(path.join(DATA, 'works.json'), {});
  const webtoons = Object.keys(works).filter((id) => /^웹툰/.test(works[id].classification || ''));
  const ranked = [];
  for (const period of ['daily', 'weekly', 'monthly']) {
    const f = readJson(path.join(DATA, 'webtoon', period, 'latest.json'), []);
    const items = Array.isArray(f) ? f : f.items || Object.values(f);
    for (const x of items) if (x && x.workId) ranked.push(String(x.workId));
  }
  const rankedSet = new Set(ranked);
  const ongoing = webtoons.filter((id) => !rankedSet.has(id) && !works[id].isCompleted);
  const completed = webtoons.filter((id) => !rankedSet.has(id) && works[id].isCompleted);
  return [...new Set([...ranked, ...ongoing, ...completed])].map((id) => ({ id, completed: !!(works[id] && works[id].isCompleted) }));
}

export async function run({ minutes = 300, stopUtc = null, ids = null, dry = false } = {}) {
  const t0 = Date.now();
  let deadline = t0 + minutes * 60e3;
  if (stopUtc) {
    const [h, m] = stopUtc.split(':').map(Number);
    const d = new Date(); d.setUTCHours(h, m, 0, 0);
    if (d.getTime() <= t0) d.setUTCDate(d.getUTCDate() + 1);
    deadline = Math.min(deadline, d.getTime());
  }
  fs.mkdirSync(OUT, { recursive: true });
  const today = kstDate();
  const list = targets(ids && ids.map((id) => ({ id, completed: false })));
  const stat = { checked: 0, fetched: 0, added: 0, skippedFresh: 0, skippedDone: 0, notWebtoon: 0, failed: 0, stopped: null };
  try {
    for (const { id, completed } of list) {
      if (Date.now() > deadline - 30e3) { stat.stopped = 'time'; break; }
      const f = path.join(OUT, `${id}.json`);
      const old = readJson(f, null);
      if (old && old.v === V && !ids) {
        const age = (Date.parse(today) - Date.parse(old.at)) / 86400e3;
        if (age < FRESH_DAYS) { stat.skippedFresh++; continue; }
        if (completed && old.e.length >= old.total) { stat.skippedDone++; continue; }
      }
      stat.checked++;
      const r = await fetchWork(id, old && old.v === V ? old : null);
      if (r.skip) { stat.notWebtoon++; continue; }
      if (r.failed) { stat.failed++; continue; }
      stat.fetched++;
      stat.added += r.added;
      if (!dry) fs.writeFileSync(f, JSON.stringify(r.file));
    }
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    stat.stopped = e.message;
  }
  if (!dry) {
    const ids2 = {};
    for (const name of fs.readdirSync(OUT)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const j = readJson(path.join(OUT, name), null);
      if (j && j.e) ids2[name.replace('.json', '')] = j.e.length;
    }
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ at: today, ids: ids2 }));
    stat.files = Object.keys(ids2).length;
  }
  console.log(`episode length: ${JSON.stringify({ ...stat, requests, minutes: Math.round((Date.now() - t0) / 60e3), targets: list.length })}`);
  return stat;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const ids = arg('ids', null);
  await run({
    minutes: Number(arg('minutes', 300)),
    stopUtc: arg('stop-utc', null),
    ids: ids ? ids.split(',').map((s) => s.trim()).filter((s) => /^\d{5,12}$/.test(s)) : null,
    dry: process.argv.includes('--dry'),
  });
}
