// One-off / catch-up: fill works.json entries whose page detail came back empty
// (19+ adult gate, or a failed load) from Kakao's BFF API (lib/bff-detail.mjs),
// then rewrite works-lite.json and search-index.json. The daily scrape does the
// same for the works it visits (withBffFallback in scrape.mjs).
//   node scripts/fill-bff-details.mjs [--missing] [--limit N]
// --missing also creates entries for works that have been ranked (search-index)
// but never got a works.json entry at all — they'd otherwise also be skipped by
// the daily metrics, which only cover works.json.
import fs from 'node:fs';
import path from 'node:path';
import { fetchBffDetail, isGated, fillGaps } from './lib/bff-detail.mjs';
import { writeWorksLite } from './lib/works-lite.mjs';
import { buildSearchIndex } from './build-search-index.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const CACHE = path.join(DATA_DIR, 'works.json');
const i = process.argv.indexOf('--limit');
const limit = i > 0 ? Number(process.argv[i + 1]) : Infinity;
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
const list = todo.slice(0, limit);
console.log(`works to fill: ${list.length} (${titles.size} without any entry yet)`);
let ok = 0;
let failed = 0;
for (const id of list) {
  try {
    const bff = await fetchBffDetail(id);
    const prev = cache[id] || { title: titles.get(id) || null, lastChecked: new Date().toISOString() };
    cache[id] = { ...fillGaps(prev, bff), workId: id };
    ok += 1;
  } catch (e) {
    failed += 1;
    console.log(`  ! ${id}: ${e.message}`);
  }
  if ((ok + failed) % 100 === 0) { save(cache); console.log(`  ...${ok + failed}/${list.length}`); }
  await sleep(400 + Math.random() * 300);
}
save(cache);
await writeWorksLite(cache, DATA_DIR);
fs.writeFileSync(path.join(DATA_DIR, 'search-index.json'), JSON.stringify(buildSearchIndex()), 'utf8');
console.log(`filled ${ok}, failed ${failed}`);
