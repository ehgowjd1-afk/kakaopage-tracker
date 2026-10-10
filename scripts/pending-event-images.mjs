// Image events keep their period and rewards inside pictures, which the daily
// GitHub run can't read. This lists the events whose images haven't been read
// yet (details.json has `imgs`, image-reads.json has no entry), downloads the
// images, and writes reading batches for a person / Claude to read:
//   node scripts/pending-event-images.mjs <outDir>
//   → <outDir>/<key>/NN.png and <outDir>/batches/batch-NNN.json
//     (each batch ≤ 14 images / ≤ 10 events: key, kind, page_title,
//      listing_title, listing_subtitle, listing_first, listing_last, images)
// Read results go back in with scripts/apply-image-reads.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { listedEvents } from './collect-event-details.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const out = process.argv[2];
if (!out) { console.error('usage: node scripts/pending-event-images.mjs <outDir>'); process.exit(1); }
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const H = { Origin: 'https://page.kakao.com', Referer: 'https://page.kakao.com/', 'User-Agent': UA };
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const details = readJson(path.join(DATA_DIR, 'events', 'details.json'), {});
const reads = readJson(path.join(DATA_DIR, 'events', 'image-reads.json'), {});
const { events } = listedEvents();
const listing = new Map(events.map((e) => [e.key, e]));
const pending = Object.entries(details).filter(([k, d]) => (d.imgs || []).length && !reads[k]);
console.log(`image events not read yet: ${pending.length}`);

const entries = [];
for (const [key, d] of pending) {
  const dir = path.join(out, key.replace(':', '_'));
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let n = 0; n < d.imgs.length; n++) {
    const f = path.join(dir, `${String(n).padStart(2, '0')}.png`);
    if (!fs.existsSync(f)) {
      const r = await fetch(`https://dn-img-page.kakao.com/download/resource?kid=${d.imgs[n]}`, { headers: H });
      if (!r.ok) { console.log(`  ! ${key} image ${n}: HTTP ${r.status}`); continue; }
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      await sleep(200);
    }
    files.push(f.replace(/\\/g, '/'));
  }
  const l = listing.get(key) || {};
  entries.push({
    key, kind: d.kind === 'landing' ? '작품 모음(랜딩) 페이지 대표 이미지' : '이미지형 이벤트 페이지',
    page_title: d.title || null, listing_title: l.title || null, listing_subtitle: l.subtitle || null,
    listing_first: l.firstSeen || null, listing_last: l.lastSeen || null, images: files,
  });
}
const bdir = path.join(out, 'batches');
fs.mkdirSync(bdir, { recursive: true });
let batch = [];
let imgs = 0;
let nb = 0;
const flush = () => { if (batch.length) fs.writeFileSync(path.join(bdir, `batch-${String(nb++).padStart(3, '0')}.json`), JSON.stringify(batch, null, 1)); batch = []; imgs = 0; };
for (const e of entries) {
  if (batch.length && (imgs + e.images.length > 14 || batch.length >= 10)) flush();
  batch.push(e);
  imgs += e.images.length;
}
flush();
console.log(`wrote ${nb} batch file(s) to ${bdir}`);
