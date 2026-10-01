// Build docs/data/search-index.json: one entry per work that has EVER appeared
// in any ranking snapshot (daily/weekly/monthly + every genre, both categories),
// so title search can find works that have since dropped out of the rankings.
// The latest occurrence of each workId wins (most current title/thumbnail).
// Run standalone: `node scripts/build-search-index.mjs`
import fs from 'node:fs';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'docs', 'data');
const CATS = ['webnovel', 'webtoon'];
const PERIODS = ['daily', 'weekly', 'monthly'];

export function buildSearchIndex() {
  const byId = new Map(); // workId -> {workId, title, cat, subCategory, thumbnail}
  const dirs = [];
  for (const cat of CATS) {
    for (const p of PERIODS) dirs.push([cat, path.join(DATA, cat, p)]);
    const gd = path.join(DATA, cat, 'genres');
    if (fs.existsSync(gd)) for (const g of fs.readdirSync(gd)) for (const p of PERIODS) dirs.push([cat, path.join(DATA, cat, 'genres', g, p)]);
  }
  for (const [cat, dir] of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); // ascending → later overwrites
    for (const f of files) {
      let list;
      try { list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      for (const it of list) {
        if (!it.workId || !it.title) continue;
        byId.set(String(it.workId), { workId: String(it.workId), title: it.title, cat, subCategory: it.subCategory || null, thumbnail: it.thumbnail || null, author: null, publisher: null, viewCount: null });
      }
    }
  }
  // Join author / publisher / last-known view count from works-lite so search
  // and the publisher ranking need only this one file.
  let lite = {};
  try { lite = JSON.parse(fs.readFileSync(path.join(DATA, 'works-lite.json'), 'utf8')); } catch {}
  for (const e of byId.values()) {
    const w = lite[e.workId];
    if (!w) continue;
    if (w.author) e.author = w.author;
    if (w.publisher) e.publisher = w.publisher;
    if (w.viewCount) e.viewCount = w.viewCount;
  }
  return [...byId.values()];
}

// When run directly, write the file.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('build-search-index.mjs')) {
  const index = buildSearchIndex();
  fs.writeFileSync(path.join(DATA, 'search-index.json'), JSON.stringify(index), 'utf8');
  console.log(`search-index.json: ${index.length} works`);
}
