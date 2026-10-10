// "Was this rank during a promotion?" — promotion periods per work.
//
// The daily scrape records which promotion banners sit on each daily-TOP-300
// work's 소식(notice) tab, but promotions.json only ever holds today. This keeps
// one compact snapshot per day in data/promotions/{date}.json and rebuilds
// data/promo-periods.json from all of them (the site reads only that file):
//   { first, last,
//     banners: { uid: [title, link, family, reach] },
//     works:   { workId: [[uid, start, end, flags], ...] } }
// A period runs from the first to the last day the banner was seen on that work.
// Days the work wasn't checked (outside the daily TOP 300, or no collection that
// day) are bridged; a day it was checked without the banner ends the period.
// flags: 1 = may have started earlier (the work wasn't checked the day before),
//        2 = still running on the latest day,
//        4 = may have run longer (the work wasn't checked the day after).
// family / reach: see lib/promo-family.mjs.
//
// Run standalone: node scripts/build-promo-periods.mjs
// One-time backfill from full promotions.json copies named {date}.json:
//   node scripts/build-promo-periods.mjs --backfill <dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promoFamily } from './lib/promo-family.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const SNAP_DIR = path.join(DATA_DIR, 'promotions');
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function shiftDay(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// promotions.json shape ({workId: [{bannerUid, title, link}]}, one key per work
// checked that day, [] when it had none) → compact {b: {uid: [title, link]}, w: {workId: [uid]}}.
// Works with no banner stay in w as [] — they mark "checked, nothing running".
export function compactSnapshot(promotionsByWork) {
  const b = {};
  const w = {};
  for (const id of Object.keys(promotionsByWork).sort()) {
    const uids = [];
    for (const p of promotionsByWork[id] || []) {
      if (!p || !p.bannerUid) continue;
      const uid = String(p.bannerUid);
      if (uids.includes(uid)) continue;
      uids.push(uid);
      b[uid] = [p.title || null, p.link || null];
    }
    w[id] = uids;
  }
  return { b, w };
}

export function writePromoSnapshot(date, promotionsByWork) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(path.join(SNAP_DIR, `${date}.json`), JSON.stringify(compactSnapshot(promotionsByWork)), 'utf8');
}

export function buildPromoPeriods() {
  const dates = (fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR) : [])
    .map((f) => (f.match(DATE_FILE) || [])[1]).filter(Boolean).sort();
  if (!dates.length) return null;
  const snaps = dates.map((d) => JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `${d}.json`), 'utf8')));
  const last = dates[dates.length - 1];

  // banner meta (latest title/link wins) + reach = most works carrying it on one day
  const banners = {};
  const reach = {};
  snaps.forEach((s) => {
    const perDay = {};
    for (const uids of Object.values(s.w)) for (const u of uids) perDay[u] = (perDay[u] || 0) + 1;
    for (const [u, n] of Object.entries(perDay)) reach[u] = Math.max(reach[u] || 0, n);
    for (const [u, [t, l]] of Object.entries(s.b)) banners[u] = [t, l];
  });

  // per work: the days it was checked, oldest first
  const obsByWork = new Map();
  snaps.forEach((s, i) => {
    for (const [id, uids] of Object.entries(s.w)) {
      if (!obsByWork.has(id)) obsByWork.set(id, []);
      obsByWork.get(id).push([dates[i], uids]);
    }
  });

  const works = {};
  for (const [id, obsAll] of [...obsByWork.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // A checked day with NO banners between two days that share a banner is a
    // failed page load (6 of ~11k cases in the first 59 days), not a real gap.
    const obs = obsAll.filter(([, uids], i) => {
      if (uids.length || i === 0 || i === obsAll.length - 1) return true;
      const before = obsAll[i - 1][1];
      return !obsAll[i + 1][1].some((u) => before.includes(u));
    });
    const checked = new Set(obs.map(([d]) => d));
    const open = new Map();
    const periods = [];
    for (const [d, uids] of obs) {
      for (const [u, p] of open) if (!uids.includes(u)) { periods.push(p); open.delete(u); }
      for (const u of uids) {
        if (open.has(u)) open.get(u).e = d;
        else open.set(u, { u, s: d, e: d });
      }
    }
    periods.push(...open.values());
    if (!periods.length) continue;
    works[id] = periods
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.u < b.u ? -1 : 1))
      .map((p) => {
        let flags = 0;
        if (!checked.has(shiftDay(p.s, -1))) flags |= 1;
        if (p.e === last) flags |= 2;
        else if (!checked.has(shiftDay(p.e, 1))) flags |= 4;
        return [p.u, p.s, p.e, flags];
      });
  }

  const used = new Set();
  for (const ps of Object.values(works)) for (const p of ps) used.add(p[0]);
  const bannerOut = {};
  for (const u of [...used].sort()) {
    const [t, l] = banners[u] || [null, null];
    bannerOut[u] = [t, l, promoFamily(t, reach[u] || 1), reach[u] || 1];
  }
  const out = { first: dates[0], last, banners: bannerOut, works };
  fs.writeFileSync(path.join(DATA_DIR, 'promo-periods.json'), JSON.stringify(out), 'utf8');
  const nPeriods = Object.values(works).reduce((n, ps) => n + ps.length, 0);
  console.log(`promo-periods.json: ${dates.length} days (${dates[0]}~${last}), ${Object.keys(works).length} works, ${nPeriods} periods, ${used.size} banners`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--backfill');
  if (i > 0) {
    const dir = process.argv[i + 1];
    for (const f of fs.readdirSync(dir).sort()) {
      const m = f.match(DATE_FILE);
      if (!m) continue;
      if (fs.existsSync(path.join(SNAP_DIR, f))) continue; // never overwrite a real daily snapshot
      writePromoSnapshot(m[1], JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
  }
  buildPromoPeriods();
}
