// "Was this rank during a promotion?" — promotion periods per work, built from
// the events in the 이벤트 tab, plus what each event did to its works' ranks.
//
// Sources
//  1. 이벤트 tab (data/events/*/history.json): every event banner with the days it
//     was listed (firstSeen~lastSeen) + data/events/details.json
//     (collect-event-details.mjs): the works on each event page, reward lines, and
//     for HTML events the official open/close.
//  2. 소식 tab of the daily-TOP works: one compact snapshot per day in
//     data/promotions/{date}.json (promotions.json only ever holds today). It
//     catches works an event page doesn't link, and the few banners that never
//     reached the 이벤트 tab (for those, the days seen on the work are the period).
//
// Outputs
//  data/promo-periods.json   (ranking list + work page)
//    { first, last,
//      ev:    { key: [title, subtitle, link, family, tags, nWorks, start, end, src, flags, uids, open, close] },
//      works: { workId: [[key, start, end, flags, before, during, after, scope]] } }
//  data/event-analysis.json  (이벤트 tab)
//    { first, last, baseline, groups: [...],
//      events: { key: { w: [[workId, title, cat, before, during, after, scope]], st, tg: tags, f: family } } }
// src: 'o' official open/close · 'l' days listed in the 이벤트 tab · 'n' days seen on the work
// flags: 1 = may have started before records began, 2 = still running,
//        4 = may have run longer (소식-tab only: the work left the daily TOP 300)
// before/during/after = average daily rank over the 7 days before, the period, and
// the 7 days after; 0 = mostly outside the ranking; null = no data (yet).
// scope: 'o' overall daily TOP 300, 'g' the work's genre daily TOP 300 (used when
// the work isn't in the overall ranking around the event).
//
// Run standalone: node scripts/build-promo-periods.mjs
// One-time backfill of 소식-tab snapshots from promotions.json copies named {date}.json:
//   node scripts/build-promo-periods.mjs --backfill <dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventKey, promoFamily } from './lib/promo.mjs';
import { listedEvents } from './collect-event-details.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const SNAP_DIR = path.join(DATA_DIR, 'promotions');
const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const CATS = ['webnovel', 'webtoon'];

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const datesIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => (f.match(DATE_FILE) || [])[1]).filter(Boolean).sort();

function shiftDay(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// Dates read off an event image are trusted only when they fit when the event
// was listed: it starts within 3 days of first appearing (or before records
// began), and doesn't end well before it was last listed.
function plausibleImagePeriod(ir, e, first, latest) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ir.start || '') || (ir.end && !/^\d{4}-\d{2}-\d{2}$/.test(ir.end))) return false;
  if (ir.end && ir.end < ir.start) return false;
  // a second, independent reading already confirmed dates that looked off
  // (e.g. listed late, or dropped from the listing before it ended)
  if (ir.rechecked) return true;
  if (e.firstSeen && e.firstSeen !== first && Math.abs(dayDiff(ir.start, e.firstSeen)) > 3) return false;
  if (e.firstSeen === first && dayDiff(ir.start, e.firstSeen) < -3) return false;
  if (ir.end && e.lastSeen && dayDiff(ir.end, e.lastSeen) > 3) return false;
  if (ir.end && e.lastSeen && e.lastSeen !== latest && dayDiff(e.lastSeen, ir.end) > 3) return false;
  return true;
}

// ── 소식-tab snapshots ──

// promotions.json shape ({workId: [{bannerUid, title, link}]}, one key per work
// checked that day, [] when it had none) → compact {b: {uid: [title, link]}, w: {workId: [uid]}}.
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

// Per work: [{key, title, link, s, e, flags}] — first..last day a banner was seen on
// the work. Unchecked days are bridged; a checked day without it ends the period.
function noticePeriods() {
  const dates = datesIn(SNAP_DIR);
  if (!dates.length) return new Map();
  const snaps = dates.map((d) => readJson(path.join(SNAP_DIR, `${d}.json`), { b: {}, w: {} }));
  const last = dates[dates.length - 1];
  const meta = {};
  snaps.forEach((s) => { for (const [u, [t, l]] of Object.entries(s.b)) meta[u] = [t, l]; });
  const keyOf = (u) => eventKey((meta[u] || [])[1]) || `b:${u}`;
  const obsByWork = new Map();
  snaps.forEach((s, i) => {
    for (const [id, uids] of Object.entries(s.w)) {
      if (!obsByWork.has(id)) obsByWork.set(id, []);
      obsByWork.get(id).push([dates[i], uids]);
    }
  });
  const out = new Map();
  for (const [id, obsAll] of obsByWork) {
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
    out.set(id, periods.map((p) => {
      let flags = 0;
      if (!checked.has(shiftDay(p.s, -1))) flags |= 1;
      if (p.e === last) flags |= 2;
      else if (!checked.has(shiftDay(p.e, 1))) flags |= 4;
      const [t, l] = meta[p.u] || [null, null];
      return { key: keyOf(p.u), title: t, link: l, s: p.s, e: p.e, flags };
    }));
  }
  return out;
}

// ── reward / occasion tags ──
// Reward = what a reader gets; occasion = why the event exists. Read only from
// what the event says (listing title + subtitle + page title + reward lines on
// HTML pages). A landing page's wait-free time isn't used: a work can be 3다무
// all the time, so it doesn't show the event gave it.
function eventTags(text) {
  const t = String(text || '');
  const tags = [];
  const n = t.match(/(\d+)\s*다무/);
  if (n) tags.push(`${n[1]}다무`);
  if (/기다무|기다리면\s*무료/.test(t) && !n) tags.push('기다무');
  if (/한시한편/.test(t)) tags.push('한시한편');
  if (/무료|증량/.test(t.replace(/기다리면\s*무료|\d+\s*시간마다\s*무료/g, ''))) tags.push('무료 회차');
  if (/캐시/.test(t)) tags.push('캐시');
  if (/할인/.test(t)) tags.push('할인');
  if (/이용권|대여권|선물함/.test(t)) tags.push('이용권');
  if (/론칭|런칭|오픈런|NEW RELEASE/i.test(t)) tags.push('론칭');
  if (/완결/.test(t)) tags.push('완결');
  if (/시즌|외전|연참|\d부\b/.test(t)) tags.push('시즌·외전·연참');
  if (/복귀|컴백|돌아옴|돌아왔/.test(t)) tags.push('복귀');
  return tags;
}
export const REWARD_TAGS = ['3다무', '기다무', '한시한편', '무료 회차', '캐시', '캐시 전원 지급', '캐시 추첨', '할인', '이용권', '기타 혜택'];

// How much: the most free episodes and the biggest cash prize mentioned, in the
// event's text and (when read) its images.
function rewardSize(text, ir) {
  const t = String(text || '');
  const eps = [...t.matchAll(/(\d+)\s*화\s*(?:까지\s*)?무료|무료\s*회차\s*(\d+)\s*화/g)].map((m) => Number(m[1] || m[2])).filter((n) => n > 0 && n < 1000);
  const cash = [...t.matchAll(/최대\s*([\d,.]+)\s*(천|만)?\s*캐시/g)].map((m) => {
    const n = parseFloat(m[1].replace(/,/g, ''));
    return m[2] === '만' ? n * 10000 : m[2] === '천' ? n * 1000 : n;
  }).filter((n) => n > 0);
  for (const r of (ir && ir.rewards) || []) {
    if (r.free_eps > 0 && r.free_eps < 1000) eps.push(r.free_eps);
    if (r.cash_max > 0 && (r.kind === 'cash_all' || r.kind === 'cash_lottery')) cash.push(r.cash_max);
  }
  return { eps: eps.length ? Math.max(...eps) : null, cash: cash.length ? Math.max(...cash) : null };
}
// shown on the site: '25화 무료', '최대 5천 캐시'
function rewardAmounts({ eps, cash }) {
  const out = [];
  if (eps) out.push(`${eps}화 무료`);
  if (cash) out.push(`최대 ${cash >= 10000 ? `${cash / 10000}만` : cash >= 1000 ? `${cash / 1000}천` : cash} 캐시`);
  return out;
}
// Tags from rewards read off the event images (data/events/image-reads.json).
// Lottery cash (뽑기권·추첨) and cash everyone gets are told apart — the images
// say which, the subtitles rarely do.
const IMAGE_OCCASION = { 론칭: '론칭', 완결: '완결', '시즌·외전': '시즌·외전·연참', 연참: '시즌·외전·연참', 복귀: '복귀' };
function imageTags(ir) {
  const tags = [];
  for (const r of (ir && ir.rewards) || []) {
    // '1시간마다 1편 무료' is what Kakao calls 한시한편
    if (r.kind === 'wait_free') tags.push(r.wait_hours === 1 ? '한시한편' : r.wait_hours && r.wait_hours < 12 ? `${r.wait_hours}다무` : '기다무');
    else if (r.kind === 'free_episodes') tags.push('무료 회차');
    else if (r.kind === 'cash_all') tags.push('캐시', '캐시 전원 지급');
    else if (r.kind === 'cash_lottery') tags.push('캐시', '캐시 추첨');
    else if (r.kind === 'discount') tags.push('할인');
    else if (r.kind === 'ticket') tags.push('이용권');
    else if (r.kind === 'other') tags.push('기타 혜택');
  }
  if (ir && IMAGE_OCCASION[ir.occasion]) tags.push(IMAGE_OCCASION[ir.occasion]);
  return tags;
}
// Colour family once the rewards are known. Nearly every event runs a cash draw
// (1,129 of 1,131 cash rewards read off images are 뽑기권), so cash alone says
// little; what separates events is whether reading got cheaper.
//   benefit  = 무료·할인 혜택   wait-free shortened, free episodes, discount, tickets
//   event    = 캐시·작품 이벤트  no reading benefit: cash draws, launch/completion events
//   curation = 기획전·추천      no reading benefit, 4+ works bundled
//   platform = 플랫폼 참여      site-wide games (from the text rules)
const READING_BENEFIT = /^(\d+다무|기다무|한시한편|무료 회차|할인|이용권)$/;
function eventFamily(textFamily, tags, n) {
  if (textFamily === 'platform') return 'platform';
  if (tags.some((t) => READING_BENEFIT.test(t))) return 'benefit';
  return n >= 4 ? 'curation' : 'event';
}

// grouped in the analysis: coarse size buckets so each has enough works
function rewardSizeGroups({ eps, cash }) {
  const out = [];
  if (cash) out.push(cash <= 2000 ? '캐시 최대 2천 이하' : cash < 5000 ? '캐시 최대 3~4천' : '캐시 최대 5천 이상');
  if (eps) out.push(eps < 20 ? '무료 20화 미만' : '무료 20화 이상');
  return out;
}
const isReward = (tag) => REWARD_TAGS.includes(tag) || /^\d+다무$/.test(tag);

// ── daily ranks ──
function loadRanks() {
  const overall = new Map(); // id -> Map(date -> rank)
  const genreBy = new Map(); // id -> genre -> Map(date -> rank)
  const dates = new Set();
  const cats = new Map();    // id -> cat (first ranking it was seen in)
  const add = (m, id, date, rank) => { if (!m.has(id)) m.set(id, new Map()); m.get(id).set(date, rank); };
  for (const cat of CATS) {
    const dir = path.join(DATA_DIR, cat, 'daily');
    for (const d of datesIn(dir)) {
      dates.add(d);
      for (const it of readJson(path.join(dir, `${d}.json`), [])) {
        if (!it.workId || it.rank == null) continue;
        add(overall, String(it.workId), d, it.rank);
        if (!cats.has(String(it.workId))) cats.set(String(it.workId), cat);
      }
    }
    const gdir = path.join(DATA_DIR, cat, 'genres');
    for (const g of fs.existsSync(gdir) ? fs.readdirSync(gdir) : []) {
      const dir2 = path.join(gdir, g, 'daily');
      for (const d of datesIn(dir2)) {
        for (const it of readJson(path.join(dir2, `${d}.json`), [])) {
          if (!it.workId || it.rank == null) continue;
          const id = String(it.workId);
          if (!genreBy.has(id)) genreBy.set(id, new Map());
          add(genreBy.get(id), `${cat}/${g}`, d, it.rank);
          if (!cats.has(id)) cats.set(id, cat);
        }
      }
    }
  }
  // a work in several genre lists: use the one it appears in most
  const genre = new Map();
  for (const [id, byG] of genreBy) {
    let best = null;
    for (const m of byG.values()) if (!best || m.size > best.size) best = m;
    genre.set(id, best);
  }
  const launch = new Map();
  for (const [id, w] of Object.entries(readJson(path.join(DATA_DIR, 'works-lite.json'), {}))) {
    if (w.launchDate) launch.set(id, w.launchDate);
  }
  return { overall, genre, dates: [...dates].sort(), cats, launch };
}

// average rank over the collected days in [from, to]; 0 = outside the ranking on
// most of them; null = no collected day in range (or fewer than minDays)
function windowRank(map, dates, from, to, minDays = 1) {
  const days = dates.filter((d) => d >= from && d <= to);
  if (days.length < minDays || !days.length) return null;
  const ranks = days.map((d) => (map ? map.get(d) : undefined)).filter((r) => r != null);
  if (ranks.length * 2 < days.length) return 0;
  return Math.round(ranks.reduce((a, r) => a + r, 0) / ranks.length);
}

function effect(R, id, s, e, { startUnknown, ongoing }) {
  // a work launched in the week before (or during) the event has no 'before' —
  // counting it as 'outside the ranking' would make every launch look like a jump
  const launch = R.launch.get(id);
  const noBefore = startUnknown || (launch && launch > shiftDay(s, -7));
  const calc = (map) => [
    noBefore ? null : windowRank(map, R.dates, shiftDay(s, -7), shiftDay(s, -1), 3),
    windowRank(map, R.dates, s, e),
    ongoing ? null : windowRank(map, R.dates, shiftDay(e, 1), shiftDay(e, 7), 3),
  ];
  let r = calc(R.overall.get(id));
  let scope = 'o';
  if (!(r[0] > 0 || r[1] > 0) && R.genre.has(id)) {
    const g = calc(R.genre.get(id));
    if (g[0] > 0 || g[1] > 0) { r = g; scope = 'g'; }
  }
  return [...r, scope];
}

// ±5% of the before-rank counts as unchanged
function classify(b, d) {
  if (!(b > 0)) return d > 0 ? 'ent' : null;
  if (!(d > 0)) return 'out';
  if (d < b * 0.95) return 'up';
  if (d > b * 1.05) return 'down';
  return 'flat';
}
function stats(pairs) {
  const st = { n: 0, up: 0, down: 0, flat: 0, ent: 0, out: 0, med: null };
  const pct = [];
  for (const [b, d] of pairs) {
    const c = classify(b, d);
    if (!c) continue;
    st[c] += 1;
    if (c === 'up' || c === 'down' || c === 'flat') { st.n += 1; pct.push((b - d) / b); }
  }
  if (pct.length) { pct.sort((x, y) => x - y); st.med = Math.round(pct[Math.floor(pct.length / 2)] * 100); }
  return st;
}

export function buildPromoPeriods() {
  const details = readJson(path.join(DATA_DIR, 'events', 'details.json'), {});
  // period + rewards read off image events' pictures (see image-reads.json header)
  const imageReads = readJson(path.join(DATA_DIR, 'events', 'image-reads.json'), {});
  const { events: listed, latest } = listedEvents();
  const first = listed.reduce((m, e) => (e.firstSeen && (!m || e.firstSeen < m) ? e.firstSeen : m), null);
  const R = loadRanks();
  const index = readJson(path.join(DATA_DIR, 'search-index.json'), []);
  const known = new Map(index.map((w) => [String(w.workId), w]));
  const byTitle = new Map();
  for (const w of index) { if (!byTitle.has(w.title)) byTitle.set(w.title, []); byTitle.get(w.title).push(w); }

  // event key → record + its works
  const ev = new Map();
  const workTitle = new Map();
  const workCat = new Map();
  for (const e of listed) {
    const d = details[e.key] || {};
    const ir = imageReads[e.key] || null;
    // period: HTML page 'open'/'close' > dates printed on the event image > the
    // days the event sat in the 이벤트 tab. An image date far from when the event
    // was actually listed is treated as a misread and ignored.
    let open = d.open || null;
    let close = d.close || null;
    let src = open || close ? 'o' : 'l';
    if (!open && !close && ir && ir.start && plausibleImagePeriod(ir, e, first, latest)) {
      open = `${ir.start}${ir.start_time ? ` ${ir.start_time}` : ''}`;
      close = ir.end ? `${ir.end}${ir.end_time ? ` ${ir.end_time}` : ''}` : null;
      src = 'i';
    }
    // an event that opens in the evening (usually 22:00) counts from the next day
    let s = open ? open.slice(0, 10) : e.firstSeen;
    if (open && Number(open.slice(11, 13)) >= 18) s = shiftDay(s, 1);
    const ongoing = e.lastSeen === latest;
    let end = close ? close.slice(0, 10) : e.lastSeen;
    if (end < s) end = s;
    const works = new Set();
    for (const [id, t, c] of d.works || []) {
      works.add(String(id));
      if (t) workTitle.set(String(id), t);
      if (c) workCat.set(String(id), c);
    }
    const text = [e.title, e.subtitle, d.title, ...(d.rewards || [])].join(' ');
    ev.set(e.key, {
      key: e.key, title: d.title || e.title, sub: e.subtitle || '', link: e.link, text, ir,
      // 1 = images read, 0 = image event not read yet, null = nothing to read
      imgRead: ir ? 1 : (d.imgs || []).length ? 0 : null,
      s, e: end, src,
      flags: (!open && e.firstSeen === first ? 1 : 0) | (ongoing ? 2 : 0),
      uids: e.uids, open, close, tabs: e.tabs, works, firstSeen: e.firstSeen, lastSeen: e.lastSeen,
    });
  }

  // 소식-tab banners: add the work to its event; banners never listed in the
  // 이벤트 tab become their own events with the days seen on the work.
  const own = new Map(); // workId -> [{key, s, e, flags}] for non-listed banners
  for (const [id, ps] of noticePeriods()) {
    for (const p of ps) {
      const x = ev.get(p.key);
      if (x) { x.works.add(id); continue; }
      if (!own.has(id)) own.set(id, []);
      own.get(id).push(p);
      if (!ev.has(`n:${p.key}`)) {
        ev.set(`n:${p.key}`, { key: p.key, title: p.title, sub: '', link: p.link, text: p.title, s: null, e: null, src: 'n', flags: 0, uids: [], open: null, close: null, tabs: [], works: new Set(), noticeOnly: true });
      }
      ev.get(`n:${p.key}`).works.add(id);
    }
  }

  // Event pages that link no work (image-only, or a page with no taps): fall back
  // to an exact title match with a ranked work in the event's category.
  for (const x of ev.values()) {
    if (x.works.size || x.noticeOnly) continue;
    const names = new Set([x.title, ...(String(x.title).match(/<([^>]+)>/g) || []).map((m) => m.slice(1, -1))]);
    for (const name of names) {
      for (const w of byTitle.get(String(name).trim()) || []) {
        if (!x.tabs.length || x.tabs.includes('all') || x.tabs.includes(w.cat)) x.works.add(String(w.workId));
      }
    }
  }

  // records + per-work periods with rank windows
  const evOut = {};
  const works = {};
  const analysis = {};
  const groupPairs = new Map();
  const addGroup = (label, kind, b, d) => {
    const k = `${kind}|${label}`;
    if (!groupPairs.has(k)) groupPairs.set(k, { label, kind, pairs: [] });
    groupPairs.get(k).pairs.push([b, d]);
  };
  for (const [k, x] of ev) {
    if (x.noticeOnly) continue;
    const n = x.works.size;
    const rewardTexts = ((x.ir && x.ir.rewards) || []).map((r) => r.text).filter(Boolean).slice(0, 6);
    const tags = [...new Set([...eventTags(x.text), ...imageTags(x.ir)])];
    const fam = eventFamily(promoFamily(`${x.text} ${rewardTexts.join(' ')}`, n), tags, n);
    const size = rewardSize(x.text, x.ir);
    const shown = [...tags, ...rewardAmounts(size)];
    evOut[x.key] = [x.title, x.sub, x.link, fam, shown, n, x.s, x.e, x.src, x.flags, x.uids, x.open, x.close, rewardTexts, x.imgRead];
    const rows = [];
    const pairs = [];
    for (const id of [...x.works].sort()) {
      const eff = effect(R, id, x.s, x.e, { startUnknown: x.flags & 1, ongoing: x.flags & 2 });
      (works[id] || (works[id] = [])).push([x.key, x.s, x.e, x.flags, ...eff]);
      const kw = known.get(id);
      rows.push([id, (kw && kw.title) || workTitle.get(id) || null, (kw && kw.cat) || workCat.get(id) || R.cats.get(id) || null, ...eff]);
      pairs.push([eff[0], eff[1]]);
      // reward/occasion groups compare like with like, so platform games (one
      // event, dozens of works) are kept out of the reward groups
      if (fam !== 'platform') {
        const rw = tags.filter(isReward);
        for (const t of rw) addGroup(t, 'reward', eff[0], eff[1]);
        if (!rw.length) addGroup('리워드 없음 (노출만)', 'reward', eff[0], eff[1]);
        for (const t of rewardSizeGroups(size)) addGroup(t, 'amount', eff[0], eff[1]);
        for (const t of tags.filter((t) => !isReward(t))) addGroup(t, 'occasion', eff[0], eff[1]);
        addGroup(n >= 4 ? '여러 작품 기획전 (4작품 이상)' : '단독·소수 (1~3작품)', 'size', eff[0], eff[1]);
      }
      addGroup(fam, 'family', eff[0], eff[1]);
    }
    analysis[x.key] = { w: rows, st: stats(pairs), tg: shown, f: fam, rt: rewardTexts, ir: x.imgRead };
  }
  for (const [id, ps] of own) {
    for (const p of ps) {
      const x = ev.get(`n:${p.key}`);
      if (!evOut[p.key]) evOut[p.key] = [x.title, '', x.link, promoFamily(x.text, x.works.size), eventTags(x.text), x.works.size, null, null, 'n', 0, [], null, null, [], null];
      const eff = effect(R, id, p.s, p.e, { startUnknown: p.flags & 1, ongoing: p.flags & 2 });
      (works[id] || (works[id] = [])).push([p.key, p.s, p.e, p.flags, ...eff]);
    }
  }
  for (const ps of Object.values(works)) ps.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1));

  // Baseline: the same before/during comparison for works with no event at all
  // around a 7-day stretch — how often ranks move on their own.
  const promoDays = new Map();
  for (const [id, ps] of Object.entries(works)) promoDays.set(id, ps.map((p) => [p[1], p[2]]));
  const basePairs = [];
  const ids = new Set([...R.overall.keys(), ...R.genre.keys()]);
  for (const id of ids) {
    const ps = promoDays.get(id) || [];
    for (let i = 7; i + 6 < R.dates.length; i += 7) {
      const s = R.dates[i];
      const e = shiftDay(s, 6);
      const from = shiftDay(s, -7);
      const to = shiftDay(s, 13);
      if (ps.some(([a, b]) => a <= to && b >= from)) continue;
      const [b, d] = effect(R, id, s, e, { startUnknown: false, ongoing: true });
      if (b != null && d != null) basePairs.push([b, d]);
    }
  }
  const order = { family: 0, reward: 1, amount: 2, occasion: 3, size: 4 };
  const groups = [...groupPairs.values()]
    .map((g) => ({ label: g.label, kind: g.kind, ...stats(g.pairs) }))
    .filter((g) => g.n + g.ent >= 5)
    .sort((a, b) => order[a.kind] - order[b.kind] || (b.n + b.ent) - (a.n + a.ent));

  fs.writeFileSync(path.join(DATA_DIR, 'promo-periods.json'), JSON.stringify({ first, last: latest, ev: evOut, works }), 'utf8');
  fs.writeFileSync(path.join(DATA_DIR, 'event-analysis.json'), JSON.stringify({ first, last: latest, baseline: stats(basePairs), groups, events: analysis }), 'utf8');
  const nPairs = Object.values(works).reduce((n, ps) => n + ps.length, 0);
  console.log(`promo periods: ${Object.keys(evOut).length} events, ${Object.keys(works).length} works, ${nPairs} work-periods (baseline ${basePairs.length} stretches)`);
  return { evOut, works };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
