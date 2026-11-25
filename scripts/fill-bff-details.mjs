// One-off / catch-up: fill works.json entries whose page detail came back empty
// (19+ adult gate, or a failed load) from Kakao's BFF API (lib/bff-detail.mjs),
// then rewrite works-lite.json and search-index.json. The daily scrape does the
// same for the works it visits (withBffFallback in scrape.mjs).
//   node scripts/fill-bff-details.mjs [--missing] [--ids-file F] [--gap MS] [--limit N]
// --missing also creates entries for works that have been ranked (search-index)
// but never got a works.json entry at all — they'd otherwise also be skipped by
// the daily metrics, which only cover works.json.
// --ids-file: JSON array of {id, title} (or ids) to create/fill, e.g. works seen
// only in genre or new-release lists. --gap: ms between every request (default
// 300 inside a work + 400-700 between works); stops after 2 blocked answers in a row.
import fs from 'node:fs';
import path from 'node:path';
import { fetchBffDetail, isGated, fillGaps } from './lib/bff-detail.mjs';
import { writeWorksLite } from './lib/works-lite.mjs';
import { buildSearchIndex } from './build-search-index.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const CACHE = path.join(DATA_DIR, 'works.json');
const argVal = (name) => { const k = process.argv.indexOf(name); return k > 0 ? process.argv[k + 1] : null; };
const limit = argVal('--limit') ? Number(argVal('--limit')) : Infinity;
const gap = argVal('--gap') ? Number(argVal('--gap')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (cache) => fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8'); // minified, like scrape.mjs

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const todo = Object.keys(cache).filter((id) => isGated(cache[id]));
const titles = new Map();
if (process.argv.includes('--missing')) {
  for (const e of JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'search-index.json'), 'utf8'))) {
    if (!cache[e.workId]) { todo.push(e.workId); titles.set(e.workId, e.title); }
  }
}
if (argVal('--ids-file')) {
  for (const e of JSON.parse(fs.readFileSync(argVal('--ids-file'), 'utf8'))) {
    const id = String(typeof e === 'object' ? e.id : e);
    if (!cache[id] && !todo.includes(id)) { todo.push(id); if (e.title) titles.set(id, e.title); }
  }
}
const list = todo.slice(0, limit);
console.log(`works to fill: ${list.length} (${titles.size} without any entry yet)`);
let ok = 0;
let failed = 0;
let blocked = 0;
for (const id of list) {
  try {
    const bff = await fetchBffDetail(id, gap ? { gapMs: gap } : undefined);
    const prev = cache[id] || { title: titles.get(id) || null, lastChecked: new Date().toISOString() };
    cache[id] = { ...fillGaps(prev, bff), workId: id };
    ok += 1;
    blocked = 0;
  } catch (e) {
    failed += 1;
    console.log(`  ! ${id}: ${e.message}`);
    if (/HTTP (403|429|503)/.test(e.message) && ++blocked >= 2) { console.log('  stopped: Kakao refused twice in a row'); break; }
  }
  if ((ok + failed) % 100 === 0) { save(cache); console.log(`  ...${ok + failed}/${list.length}`); }
  await sleep(gap ? gap + Math.random() * 400 : 400 + Math.random() * 300);
}
save(cache);
await writeWorksLite(cache, DATA_DIR);
fs.writeFileSync(path.join(DATA_DIR, 'search-index.json'), JSON.stringify(buildSearchIndex()), 'utf8');
console.log(`filled ${ok}, failed ${failed}`);
