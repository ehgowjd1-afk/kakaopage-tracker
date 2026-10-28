// 표지 채우기 — 19금 작품 표지 (2026-10-28, 사용자 요청)
//
// 카카오 화면은 성인 인증을 안 한 방문자에게 19금 작품 표지를 숨긴다. 그래서 순위·신작 목록을 화면에서
// 읽는 매일 수집(scrape.mjs)에선 19금 작품의 thumbnail이 비어 온다(2026-10-28 기준 약 2,600작품).
// 작품 정보 API(content/overview — bff-detail.mjs·collect-metrics.mjs가 이미 쓰는 것, 로그인 없음)는
// 19금판도 자기 표지 id(content.thumbnail)를 그대로 준다. 표지가 빠진 작품만 골라 받아 둔다.
//
// 매일 수집과 따로 도는 새 작업이다(.github/workflows/covers.yml). 이 스크립트는 아래 파일 하나만 쓴다.
// 사용자 규칙: 카카오 요청 사이 2초 이상, '너무 많음(429)·잠시 불가(503)·거절(403)'이 2번 연속이면 멈춘다.
// 그 밖의 실패가 5번 연속이어도 멈춘다. 실패한 작품은 '표지 없음'으로 적지 않고 다음 실행에 다시 본다.
//
// docs/data/covers.json — { c: { 작품id: 표지 id }, x: { 작품id: 'YYYY-MM-DD' 표지를 못 받은 날(14일 뒤 다시 시도) } }
//   표지 주소 = https://dn-img-page.kakao.com/download/resource?kid={표지 id}&filename=th3 (목록 표지와 같은 꼴)
//   사이트(app.js setCover)는 목록에서 받은 표지가 비어 있을 때만 이 표지를 쓴다.
// 대상: works.json·검색 목록(순위에 든 적 있는 작품)·최근 신작 목록에 있는 작품 중
//   검색 목록에도 신작 목록에도 표지가 없고, covers.json에도 아직 없는 작품.
// 실행: node scripts/collect-covers.mjs [--minutes 120] [--limit N] [--ids 1,2] [--dry]
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA, 'covers.json');
const BFF = 'https://bff-page.kakao.com/api/gateway/api/v1/content/overview?series_id=';
const HEADERS = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
};
const GAP_MS = 2000;
const RETRY_MISS_DAYS = 14;   // 표지를 못 받은 작품(내려간 작품 등)은 2주 뒤에 다시 본다
const KID_RE = /^[A-Za-z0-9_\-/.]+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const arg = (name, fb) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fb; };

class Blocked extends Error {}
let lastAt = 0, strikes = 0, requests = 0;
// 작품 정보(content)를 돌려준다. null = 카카오가 제대로 답했는데 작품 정보가 없음(404 포함) → '표지 없음'으로 적는다.
// 막힘(403·429·503이 2번 연속)은 Blocked, 그 밖의 실패(5xx·네트워크·JSON이 아닌 답)는 Error →
// 그 작품은 '표지 없음'으로 적지 않고 다음 실행에 다시 본다.
async function overview(id) {
  for (let tries = 0; ; tries++) {
    const wait = lastAt + GAP_MS + Math.random() * 600 - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    requests++;
    let r;
    try { r = await fetch(BFF + encodeURIComponent(id), { headers: HEADERS, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (tries < 2) { await sleep(5000); continue; } throw e; }
    if (r.status === 429 || r.status === 503 || r.status === 403) {
      if (++strikes >= 2) throw new Blocked(`카카오가 요청을 막았습니다 (${r.status})`);
      await sleep(60000);
      continue;
    }
    strikes = 0;
    if (r.status === 404) return null;
    if (!r.ok) { if (r.status >= 500 && tries < 2) { await sleep(5000); continue; } throw new Error(`HTTP ${r.status}`); }
    const j = await r.json().catch(() => undefined);
    if (j === undefined) throw new Error('JSON이 아닌 답');
    return (j && j.result && j.result.content) || null;
  }
}

// 표지가 이미 있는 작품: 검색 목록(순위·장르 목록에서 마지막으로 본 표지) + 최근 신작 목록
function targets(store, today) {
  const has = new Set();
  const ids = new Set(Object.keys(readJson(path.join(DATA, 'works.json'), {})));
  for (const e of readJson(path.join(DATA, 'search-index.json'), [])) {
    if (!e || !e.workId) continue;
    ids.add(String(e.workId));
    if (e.thumbnail) has.add(String(e.workId));
  }
  for (const cat of ['webtoon', 'webnovel']) {
    for (const it of readJson(path.join(DATA, cat, 'new-releases', 'latest.json'), [])) {
      if (!it || !it.workId) continue;
      ids.add(String(it.workId));
      if (it.thumbnail) has.add(String(it.workId));
    }
  }
  const newest = (id) => -Number(id) || 0;   // 작품 id가 클수록 최근 작품 — 신작부터
  return [...ids]
    .filter((id) => /^\d+$/.test(id) && !has.has(id) && !store.c[id])
    .filter((id) => !store.x[id] || daysBetween(store.x[id], today) >= RETRY_MISS_DAYS)
    .sort((a, b) => newest(a) - newest(b));
}

async function main() {
  const today = kstToday();
  // covers.yml이 135분에 강제로 끊으므로 125분을 넘기지 않는다(그 전에 스스로 멈추고 저장).
  const minutes = Math.min(Number(arg('--minutes', '120')) || 120, 125);
  const limit = Number(arg('--limit', 'Infinity'));
  const dry = process.argv.includes('--dry');
  const deadline = Date.now() + minutes * 60e3;
  const store = readJson(OUT, null) || { c: {}, x: {} };
  store.c = store.c || {};
  store.x = store.x || {};

  let list = arg('--ids', '') ? arg('--ids', '').split(',').map((s) => s.trim()).filter(Boolean) : targets(store, today);
  console.log(`표지가 빠진 작품: ${list.length}개 (이미 받아 둔 표지 ${Object.keys(store.c).length}개)`);
  list = list.slice(0, limit);
  if (dry) { console.log('미리 보기(--dry): 요청하지 않음. 앞 10개:', list.slice(0, 10).join(' ')); return; }

  const save = () => fs.writeFileSync(OUT, JSON.stringify(store), 'utf8');
  process.on('SIGTERM', () => { save(); console.log('강제 종료 — 받은 데까지 저장함'); process.exit(1); });
  let got = 0, miss = 0, failed = 0, inRow = 0, stop = '', blocked = false;
  for (const id of list) {
    if (Date.now() > deadline) { stop = '시간이 다 됨'; break; }
    let c;
    try { c = await overview(id); inRow = 0; }
    catch (e) {
      if (e instanceof Blocked) { stop = e.message; blocked = true; break; }
      failed++;
      if (++inRow >= 5) { stop = `5번 연속 실패 (${e.message})`; blocked = true; break; }
      continue;   // 실패한 작품은 적지 않고 다음 실행에 다시 본다
    }
    const kid = c && typeof c.thumbnail === 'string' ? c.thumbnail.trim() : '';
    if (kid && KID_RE.test(kid)) { store.c[id] = kid; delete store.x[id]; got++; }
    else { store.x[id] = today; miss++; }
    if ((got + miss) % 100 === 0) { save(); console.log(`  ...${got + miss}/${list.length} (표지 ${got}, 없음 ${miss}, 실패 ${failed})`); }
  }
  save();
  console.log(`표지 받음 ${got}개, 표지 없음 ${miss}개, 실패(다음에 다시) ${failed}개, 요청 ${requests}번${stop ? ` — 멈춤: ${stop}` : ''}`);
  console.log(`covers.json: 표지 ${Object.keys(store.c).length}개`);
  if (blocked) process.exitCode = 1;   // 막혔으면 실행 기록을 빨간색으로(저장은 됨)
}

main().catch((e) => { console.error(e); process.exit(1); });
