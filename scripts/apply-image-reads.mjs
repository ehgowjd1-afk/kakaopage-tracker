// Merge readings of event images into data/events/image-reads.json, then rebuild
// the promotion periods / event analysis.
//   node scripts/apply-image-reads.mjs <results.json>
// results.json: { events: [ { key, readable, start, start_time, end, end_time,
//   occasion, rewards: [{kind, text, cash_max, free_eps, wait_hours, winners,
//   condition}], works_named, note } ] }  (the shape the reading prompt returns;
//   kind ∈ wait_free · free_episodes · cash_all · cash_lottery · discount · ticket · other)
//
// image-reads.json: { key: { …that entry, read: 'YYYY-MM-DD' } }. An unreadable
// entry is kept too (so it isn't fetched again) but contributes nothing.
import fs from 'node:fs';
import path from 'node:path';
import { buildPromoPeriods } from './build-promo-periods.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA_DIR, 'events', 'image-reads.json');
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/apply-image-reads.mjs <results.json>'); process.exit(1); }
const results = JSON.parse(fs.readFileSync(file, 'utf8'));
const reads = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return {}; } })();
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // KST
const KEEP = ['readable', 'start', 'start_time', 'end', 'end_time', 'occasion', 'rewards', 'works_named', 'note', 'rechecked'];
let n = 0;
for (const e of results.events || []) {
  if (!e || !e.key) continue;
  const o = {};
  for (const k of KEEP) if (e[k] !== undefined && e[k] !== null && !(Array.isArray(e[k]) && !e[k].length)) o[k] = e[k];
  o.rewards = (e.rewards || []).map((r) => {
    const x = {};
    for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined && v !== '') x[k] = v;
    return x;
  });
  o.read = today;
  reads[e.key] = o;
  n += 1;
}
const sorted = Object.fromEntries(Object.entries(reads).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
fs.writeFileSync(OUT, JSON.stringify(sorted), 'utf8');
console.log(`image-reads.json: ${n} entries merged, ${Object.keys(sorted).length} total`);
buildPromoPeriods();
