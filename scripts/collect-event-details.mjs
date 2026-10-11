// What each event in the 이벤트 tab actually contains — which works take part
// and, for HTML events, the official start/end — so promotion periods come from
// the events themselves for every participating work (not only the daily-TOP
// works whose 소식 tab the scraper visits).
//
// data/events/details.json: { key: { kind, ver, title, works: [[id, title, cat]],
//                                     open, close, fetched, err? } }
//   'h:<hash>'  POST bff /api/web/event/render
//               v2 = a stack of images; a tap on one opens a work (scheme series_id)
//               v3 = an HTML page; works listed as "series":"<id>" / data-series,
//                    the schedule as 'open' : 'YYYY-MM-DD HH:mm', 'close' : …
//   'l:<id>'    GET bff /api/gateway/view/v1/landing/series/list (paged)
//   's:<id>'    a banner straight to one work (no request)
// v3 pages carry their period as open/close stamps or, on many, only as printed
// text ('기간: 10/7(수) 정오 ~ 10/31(토) 24시' → period: 'text'); elsewhere the
// period is the event's run in the 이벤트 tab (firstSeen~lastSeen), which matched
// the official dates within a day in spot checks (events open ~22:00 the night
// before) — but long events often leave the tab well before they end.
//
// Only new events, still-running ones every 3 days (pages gain works), and one
// last pass after an event ends are fetched. Run standalone:
//   node scripts/collect-event-details.mjs [--all]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { eventKey, decodeEntities } from './lib/promo.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA_DIR, 'events', 'details.json');
const TABS = ['all', 'webnovel', 'webtoon'];
const REFRESH_DAYS = 3;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HEADERS = { Origin: 'https://page.kakao.com', Referer: 'https://page.kakao.com/', 'User-Agent': UA };
const BFF = 'https://bff-page.kakao.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

async function fetchJson(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// 'YYYY-MM-DD HH:mm' → { date, time }; '24:00' means the end of that date
function parseStamp(s) {
  const m = String(s || '').match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}` : null;
}

// Many HTML events have no 'open'/'close' stamps and print the period only as
// text — '이벤트 기간: 10/7(수) 정오 ~ 10/31(토) 24시', '기간 10월 9일(금) 18시 ~
// 10월 16일(금)', '기간 : 26.10.3~10.9'. Read that into the same 'YYYY-MM-DD[ HH:mm]'
// form. The year (when not printed) is the one whose weekday matches the printed
// '(수)', else the one closest to the fetch date — so a reused page still showing
// last year's dates reads as last year; prize announcement / payout /
// coupon-validity periods are skipped; '~ 종료 시까지' leaves the end open.
// Bump PERIOD_V when this changes so pages get re-read once.
const PERIOD_V = 1;
const DATE_RE = String.raw`(?:(\d{2}|20\d{2})\s*[.\/년]\s*)?(\d{1,2})\s*(?:[.\/]|월)\s*(\d{1,2})\s*일?\s*(?:\(\s*([월화수목금토일])\s*\))?`;
const TIME_RE = String.raw`\s*(?:(오전|오후)\s*)?(?:(정오|자정)(?:\s*\d{1,2}\s*시)?|(\d{1,2})\s*(?::\s*(\d{2})|시(?:\s*(\d{1,2})\s*분)?))?`;
const PERIOD_RE = new RegExp(String.raw`(이벤트|참여|진행|응모|감상)?\s*기간\s*[:：]?\s*${DATE_RE}${TIME_RE}\s*[~∼～\-–]\s*(?:${DATE_RE}${TIME_RE}|(종료\s*시?\s*까지))`, 'g');
const pad = (n) => String(n).padStart(2, '0');
const DOW = '일월화수목금토';

// year for a month/day without one: weekday match first, then closest to base,
// never before `min` (an end date can't precede its start)
function pickYear(m, d, dow, base, min) {
  const b = Date.parse(`${base}T00:00:00Z`);
  const by = new Date(b).getUTCFullYear();
  const ys = [by - 1, by, by + 1].filter((y) => !min || Date.UTC(y, m - 1, d) >= min);
  const near = (x, y) => Math.abs(Date.UTC(x, m - 1, d) - b) - Math.abs(Date.UTC(y, m - 1, d) - b);
  const hit = dow ? ys.filter((y) => DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] === dow) : [];
  return (hit.length ? hit : ys).sort(near)[0];
}

function periodStamp([y, mo, d, dow, ap, named, h, mi, mi2], base, min, isEnd) {
  const M = Number(mo), D = Number(d);
  if (!(M >= 1 && M <= 12 && D >= 1 && D <= 31)) return null;
  const Y = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : pickYear(M, D, dow, base, min);
  if (!Y) return null;
  let time = null;
  if (named === '정오') time = '12:00';
  else if (named === '자정') time = isEnd ? '24:00' : '00:00';
  else if (h != null) {
    let H = Number(h);
    if (ap === '오후' && H < 12) H += 12;
    if (ap === '오전' && H === 12) H = 0;
    if (H > 24) return null;
    time = `${pad(H)}:${pad(mi ?? mi2 ?? 0)}`;
  }
  return { Y, M, D, s: `${Y}-${pad(M)}-${pad(D)}${time ? ` ${time}` : ''}` };
}

export function textPeriod(text, base) {
  const found = [];
  for (const m of String(text || '').matchAll(PERIOD_RE)) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (!m[1] && /(발표|지급|사용|유효|구매|이용권|쿠폰)\s*$/.test(before)) continue;
    const g = m.slice(2);
    const start = periodStamp(g.slice(0, 9), base, null, false);
    if (!start) continue;
    let end = null;
    if (!g[18]) {
      // an end date without a year sits on or after the start (across New Year too)
      const startDay = Date.UTC(start.Y, start.M - 1, start.D);
      end = periodStamp(g.slice(9, 18), new Date(startDay).toISOString().slice(0, 10), startDay, true);
      if (!end) continue;
      const span = (Date.UTC(end.Y, end.M - 1, end.D) - Date.UTC(start.Y, start.M - 1, start.D)) / 86400000;
      if (span < 0 || span > 400) continue;
    }
    found.push({ labelled: !!m[1], open: start.s, close: end ? end.s : null });
  }
  const best = found.find((f) => f.labelled) || found[0];
  return best ? { open: best.open, close: best.close } : null;
}

async function fetchEvent(hash, today) {
  const j = await fetchJson(`${BFF}/api/web/event/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `hashedeventId=${hash}`,
  });
  const ids = new Set();
  for (const it of j.content_info_list || []) {
    for (const v of [it.scheme_web, it.scheme_ios, it.scheme_android]) {
      const m = String(v || '').match(/series_id=(\d+)/);
      if (m) ids.add(m[1]);
    }
    if (it.destination_type_ios === 'DN04' && /^\d+$/.test(it.destination_info_web || '')) ids.add(it.destination_info_web);
  }
  const body = String(j.body || '');
  for (const m of body.matchAll(/"series"\s*:\s*"(\d{5,})"|data-series="(\d{5,})"|series_id=(\d{5,})|\/content\/(\d{5,})/g)) {
    ids.add(m[1] || m[2] || m[3] || m[4]);
  }
  // HTML events schedule their buttons with 'open' : '…', 'close' : '…' (several
  // phases possible) — the event runs from the first open to the last close.
  const opens = [...body.matchAll(/['"]open['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => parseStamp(m[1])).filter(Boolean).sort();
  const closes = [...body.matchAll(/['"]close['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => parseStamp(m[1])).filter(Boolean).sort();
  const text = htmlText(body);
  const tp = !opens.length && !closes.length ? textPeriod(text, today) : null;
  return {
    kind: 'event',
    ver: String(j.event_version || ''),
    title: decodeEntities(j.event_title),
    works: [...ids].map((id) => [id, null, null]),
    open: opens[0] || (tp && tp.open) || null,
    close: closes[closes.length - 1] || (tp && tp.close) || null,
    // 'text' = read from the page's printed period, not its schedule stamps
    ...(tp ? { period: 'text' } : {}),
    pv: PERIOD_V,
    rewards: rewardPhrases(text),
    // image events keep their period and rewards inside the pictures; the ids
    // let them be read later (data/events/image-reads.json). Work cover cards skipped.
    imgs: (j.content_info_list || [])
      .filter((it) => it.destination_type_ios !== 'DN04' && it.resource_url)
      .sort((a, b) => Number(a.item_order) - Number(b.item_order))
      .map((it) => it.resource_url),
  };
}

// Visible text of an HTML event page (scripts/styles dropped)
function htmlText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ');
}

// Reward lines worth keeping from an event page: free episodes, wait-free
// changes, cash, tickets, discounts. Short and deduplicated.
const REWARD_RE = /(최대\s*[\d,.]+\s*(?:천|만)?\s*캐시|[\d,.]+\s*(?:천|만)?\s*캐시\s*(?:지급|선물|증정|적립|페이백)?|전원\s*캐시|\d+\s*~\s*\d+\s*화\s*무료|\d+\s*화\s*(?:까지\s*)?무료|무료\s*(?:증량|UP|회차\s*\d+\s*화)|\d+\s*시간\s*마다\s*무료|[0-9]\s*다무|기다무|대여권\s*\d+\s*장|이용권\s*\d+\s*장|\d+\s*%\s*할인|단행본\s*할인|한시한편)/gi;
function rewardPhrases(text) {
  const out = [];
  for (const m of String(text || '').matchAll(REWARD_RE)) {
    const p = m[1].replace(/\s+/g, ' ').trim();
    if (!out.some((o) => o.replace(/\s/g, '') === p.replace(/\s/g, ''))) out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}

async function fetchLanding(id) {
  const works = [];
  let title = null;
  let topImage = null;
  for (let page = 0; page < 20; page++) {
    const j = await fetchJson(`${BFF}/api/gateway/view/v1/landing/series/list?page=${page}&size=100&theme_keyword_uid=&reference=${encodeURIComponent(`page/landing/${id}`)}`);
    const res = j.result || {};
    if (title == null) title = res.title || null;
    if (topImage == null) topImage = res.top_image || null; // the banner with period + rewards
    // [id, title, cat, free episodes now, wait-free minutes now (180 = 3다무)]
    // — a snapshot from when the page was fetched, i.e. during the event for
    // ones caught while running.
    for (const s of res.list || []) {
      if (!s.series_id) continue;
      works.push([
        String(s.series_id), s.title || null,
        s.category === '웹툰' ? 'webtoon' : s.category === '웹소설' ? 'webnovel' : null,
        Number.isFinite(s.free_slide_count) ? s.free_slide_count : null,
        s.is_waitfree && Number.isFinite(s.waitfree_period_by_minute) ? s.waitfree_period_by_minute : null,
      ]);
    }
    if (res.is_end !== false || !(res.list || []).length) break;
    await sleep(300);
  }
  return { kind: 'landing', ver: null, title: decodeEntities(title), works, open: null, close: null, imgs: topImage ? [topImage] : [] };
}

// Every event the 이벤트 tab has listed, merged across its three sub-tabs.
export function listedEvents() {
  const byKey = new Map();
  let latest = '';
  for (const tab of TABS) {
    for (const e of readJson(path.join(DATA_DIR, 'events', tab, 'history.json'), [])) {
      const key = eventKey(e.link);
      if (!key) continue;
      const cur = byKey.get(key) || { key, uids: [], tabs: [], title: e.title, subtitle: e.subtitle, link: e.link, firstSeen: e.firstSeen, lastSeen: e.lastSeen };
      if (e.bannerUid && !cur.uids.includes(String(e.bannerUid))) cur.uids.push(String(e.bannerUid));
      if (!cur.tabs.includes(tab)) cur.tabs.push(tab);
      if (e.firstSeen && (!cur.firstSeen || e.firstSeen < cur.firstSeen)) cur.firstSeen = e.firstSeen;
      if (e.lastSeen && (!cur.lastSeen || e.lastSeen >= cur.lastSeen)) {
        cur.lastSeen = e.lastSeen;
        cur.title = e.title;
        cur.subtitle = e.subtitle;
        cur.link = e.link;
      }
      byKey.set(key, cur);
      if (e.lastSeen && e.lastSeen > latest) latest = e.lastSeen;
    }
  }
  return { events: [...byKey.values()], latest };
}

export async function collectEventDetails({ all = false } = {}) {
  const details = readJson(OUT, {});
  const { events, latest } = listedEvents();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // KST
  const full = (e) => {
    const d = details[e.key];
    if (all || !d || d.err) return true;
    const ongoing = e.lastSeen === latest;
    if (ongoing) return daysBetween(d.fetched, today) >= REFRESH_DAYS;
    return d.fetched < e.lastSeen; // one last look after it ended
  };
  // HTML events fetched before the printed period was read: re-read once for the
  // period only (works and the refresh schedule stay as they are)
  const periodOnly = (e) => {
    const d = details[e.key];
    return e.key.startsWith('h:') && d.ver === '3' && !d.open && !d.close && (d.pv || 0) < PERIOD_V;
  };
  const todo = events.filter((e) => full(e) || periodOnly(e));
  console.log(`event details: ${events.length} listed events, ${todo.length} to fetch`);
  let done = 0;
  let failed = 0;
  for (const e of todo) {
    const [kind, id] = [e.key.slice(0, 1), e.key.slice(2)];
    try {
      if (!full(e)) {
        const d = await fetchEvent(id, details[e.key].fetched || today);
        details[e.key] = { ...details[e.key], open: d.open, close: d.close, ...(d.period ? { period: d.period } : {}), pv: PERIOD_V };
      } else {
        const d = kind === 'h' ? await fetchEvent(id, today)
          : kind === 'l' ? await fetchLanding(id)
          : { kind: 'series', ver: null, title: null, works: [[id, null, null]], open: null, close: null };
        details[e.key] = { ...d, fetched: today };
      }
    } catch (err) {
      failed += 1;
      details[e.key] = { ...(details[e.key] || {}), err: String(err.message || err).slice(0, 80), fetched: today };
    }
    done += 1;
    if (done % 50 === 0) {
      fs.writeFileSync(OUT, JSON.stringify(details), 'utf8');
      console.log(`  ...${done}/${todo.length}`);
    }
    if (kind !== 's') await sleep(350 + Math.random() * 300);
  }
  fs.writeFileSync(OUT, JSON.stringify(details), 'utf8');
  console.log(`event details: fetched ${done - failed}, failed ${failed}`);
  return details;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectEventDetails({ all: process.argv.includes('--all') }).catch((e) => { console.error(e); process.exit(1); });
}
