// Merge readings of event images into data/events/image-reads.json, then rebuild
// the promotion periods / event analysis.
//   node scripts/apply-image-reads.mjs <results.json>
// results.json: { events: [ { key, readable, start, start_time, end, end_time,
//   occasion, rewards: [{kind, text, cash_max, free_eps, wait_hours, winners,
//   condition}], works_named, note } ] }  (the shape scripts/read-event-images.md
//   asks for; kind ∈ wait_free · free_episodes · cash_all · cash_lottery · discount · ticket · other)
//
// image-reads.json: { key: { …that entry, read: 'YYYY-MM-DD', img: <hash> } }.
// `img` fingerprints the event's image list at reading time, so an event whose
// images later change shows up as pending again. An unreadable entry is kept
// too (so it isn't fetched every day) but contributes nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildPromoPeriods } from './build-promo-periods.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA_DIR, 'events', 'image-reads.json');
const KEEP = ['readable', 'start', 'start_time', 'end', 'end_time', 'occasion', 'rewards', 'works_named', 'note', 'rechecked'];
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

export function imgFingerprint(imgs) {
  return crypto.createHash('md5').update((imgs || []).join('|')).digest('hex').slice(0, 10);
}

export function mergeImageReads(results) {
  const reads = readJson(OUT, {});
  const details = readJson(path.join(DATA_DIR, 'events', 'details.json'), {});
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // KST
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
    if (details[e.key]) o.img = imgFingerprint(details[e.key].imgs);
    reads[e.key] = o;
    n += 1;
  }
  const sorted = Object.fromEntries(Object.entries(reads).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  fs.writeFileSync(OUT, JSON.stringify(sorted), 'utf8');
  console.log(`image-reads.json: ${n} entries merged, ${Object.keys(sorted).length} total`);
  buildPromoPeriods();
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/apply-image-reads.mjs <results.json>'); process.exit(1); }
  mergeImageReads(JSON.parse(fs.readFileSync(file, 'utf8')));
}
