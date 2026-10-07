// Daily EXACT metrics for every known work via Kakao's BFF overview API
// (series_id based, so it works regardless of ranking — covers works that fell
// out of the TOP 300 and brand-new titles too). Stores 1-unit-precise numbers
// that the page only ever shows rounded ("4.6억"):
//   docs/data/metrics/{YYYY-MM-DD}.json = { [id]: { v, rc, rs, cc } }
//     v = view_count, rc = rating_count, rs = rating_sum, cc = comment_count
// Run: node scripts/collect-metrics.mjs   (add --ids a,b,c to limit)
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const OUT_DIR = path.join(DATA_DIR, 'metrics');
const BFF = 'https://bff-page.kakao.com/api/gateway/api/v1/content/overview?series_id=';
const HEADERS = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};
const CONCURRENCY = 10;

function kstToday() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const m = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchMetrics(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // timeout: a hung request must never stall the daily job (it has a hard time limit)
      const r = await fetch(BFF + id, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { if (attempt) return null; await sleep(500); continue; }
      const j = await r.json();
      const sp = j?.result?.content?.service_property;
      if (!sp) return null;
      return {
        v: sp.view_count ?? null,
        rc: sp.rating_count ?? null,
        rs: sp.rating_sum ?? null,
        cc: sp.comment_count ?? null,
      };
    } catch { if (attempt) return null; await sleep(500); }
  }
  return null;
}

export async function collectAllMetrics() {
  const idsArg = (process.argv.find((a) => a.startsWith('--ids=')) || '').slice('--ids='.length);
  let ids;
  if (idsArg) ids = idsArg.split(',').map((s) => s.trim()).filter(Boolean);
  else ids = Object.keys(JSON.parse(fssync.readFileSync(path.join(DATA_DIR, 'works.json'), 'utf8')));

  const today = kstToday();
  const out = {};
  let done = 0;
  let ok = 0;
  // simple concurrency pool with a small politeness gap per request
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const m = await fetchMetrics(id);
      if (m) { out[id] = m; ok += 1; }
      done += 1;
      if (done % 500 === 0) console.log(`  ...${done}/${ids.length} (ok ${ok})`);
      await sleep(120 + Math.random() * 120);
    }
  }
  console.log(`Collecting exact metrics for ${ids.length} works via BFF...`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await fs.mkdir(OUT_DIR, { recursive: true });
  const body = JSON.stringify(out);
  await fs.writeFile(path.join(OUT_DIR, `${today}.json`), body, 'utf8');
  await fs.writeFile(path.join(OUT_DIR, 'latest.json'), body, 'utf8');
  console.log(`metrics ${today}: ${ok}/${ids.length} works captured.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectAllMetrics().catch((e) => { console.error(e); process.exit(1); });
}
export { fetchMetrics };
