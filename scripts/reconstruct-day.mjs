// Reconstruct a MISSING day's ranking snapshots from the NEXT day's snapshots,
// using Kakao's per-work "change" field (▲/▼/－ vs the previous day).
//   node scripts/reconstruct-day.mjs 2026-08-27 2026-08-28
// Recovers every work present in both days; works that dropped out of the
// ranking on the source day can't be seen and are therefore not recoverable.
// Reconstructed rows are flagged { reconstructed: true } for honesty.
import fs from 'node:fs';
import path from 'node:path';

const [target, source] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(target || '') || !/^\d{4}-\d{2}-\d{2}$/.test(source || '')) {
  console.error('usage: node scripts/reconstruct-day.mjs <targetDate> <sourceDate>');
  process.exit(1);
}
const DATA = path.join(process.cwd(), 'docs', 'data');
const CATS = ['webnovel', 'webtoon'];
const PERIODS = ['daily', 'weekly', 'monthly'];

// Rank the work held on the day BEFORE the source snapshot.
function prevRank(item) {
  const c = item.change;
  if (!c || c.type === 'same') return item.rank;
  if (c.type === 'up') return item.rank + (c.amount || 0);
  if (c.type === 'down') return item.rank - (c.amount || 0);
  return null; // 'new' → wasn't ranked the previous day
}

function reconstructDir(dir) {
  const srcFile = path.join(dir, `${source}.json`);
  if (!fs.existsSync(srcFile)) return 0;
  const list = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  const out = [];
  for (const it of list) {
    const pr = prevRank(it);
    if (pr == null || pr < 1) continue;
    out.push({ ...it, rank: pr, change: null, reconstructed: true });
  }
  out.sort((a, b) => a.rank - b.rank);
  fs.writeFileSync(path.join(dir, `${target}.json`), JSON.stringify(out, null, 2), 'utf8');
  // keep latest.json untouched — this is a historical backfill, not the newest
  return out.length;
}

const dirs = [];
for (const cat of CATS) {
  for (const p of PERIODS) dirs.push(path.join(DATA, cat, p));
  const gdir = path.join(DATA, cat, 'genres');
  if (fs.existsSync(gdir)) {
    for (const g of fs.readdirSync(gdir)) for (const p of PERIODS) dirs.push(path.join(DATA, cat, 'genres', g, p));
  }
}
let files = 0;
let rows = 0;
for (const d of dirs) {
  const n = reconstructDir(d);
  if (n) { files += 1; rows += n; }
}
console.log(`Reconstructed ${target} from ${source}: ${files} files, ${rows} rows.`);

// Add the target date to the ranking lists in index.json (where source exists).
const idxPath = path.join(DATA, 'index.json');
const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
const addDate = (arr) => {
  if (Array.isArray(arr) && arr.includes(source) && !arr.includes(target)) { arr.push(target); arr.sort(); }
};
for (const cat of CATS) {
  for (const p of PERIODS) addDate(idx[cat] && idx[cat][p]);
  const g = idx.genres && idx.genres[cat];
  if (g) for (const gk of Object.keys(g)) for (const p of PERIODS) addDate(g[gk] && g[gk][p]);
}
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2), 'utf8');
console.log('index.json updated.');
