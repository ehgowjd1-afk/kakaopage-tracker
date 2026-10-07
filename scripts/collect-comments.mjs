// Comment collection + reaction analysis (results only, like the RIDI tracker).
//
// Tier A    — every known work: its 100 most-liked comments (one request) ->
//             reaction mix (KREACT), top comments and the episodes those top
//             comments came from. Refreshed every 14-20 days (jittered per work
//             so the load spreads out). The RIDI review-aspect engine (rabsa) is
//             NOT used: on episode comments it mostly misfires (see kreact.cjs).
// Tier deep — today's daily TOP 100 (webnovel + webtoon): 300 most-liked
//             comments, plus EVERY episode's comment count, best comment and the
//             reaction mix of its top 30. Each run re-reads the newest episodes;
//             older ones are re-read every 21-27 days. Works new to the TOP 100
//             (not in yesterday's) get all their episodes scanned first.
//
// Runs as its own workflow after the daily scrape (comments.yml), so it can never
// delay or break the ranking data. Bounded by request budgets and a time limit.
//
// Output (minified, rewritten only when changed):
//   docs/data/comments/{id}.json      summary
//   docs/data/comments/ep/{id}.json   per-episode table (deep works)
//   docs/data/comments/state.json     last full run (the workflow's once-a-day guard)
//
// Run: node scripts/collect-comments.mjs [--ids=a,b] [--budget-a=N] [--budget-ep=N] [--max-minutes=N]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { seriesTopComments, episodeTopComments, listEpisodes, episodeLabel, sleep } from './lib/kakao-comments.mjs';

const KREACT = createRequire(import.meta.url)('./lib/kreact.cjs');
const DATA = path.join(process.cwd(), 'docs', 'data');
const OUT = path.join(DATA, 'comments');
const OUT_EP = path.join(OUT, 'ep');
const ENGINE_V = `k${KREACT.VERSION}`;

const A_N = 100;              // comments analysed per work (tier A) - a single request
const DEEP_N = 300;           // comments analysed per deep work
const EP_N = 30;              // top comments read per episode - a single request
const A_REFRESH_DAYS = 14;    // + 0..6 jitter
const DEEP_REFRESH_DAYS = 3;  // deep series summary
const EP_REFRESH_DAYS = 21;   // + 0..6 jitter, re-read an already-scanned episode
const LATEST_EPS = 3;         // newest episodes re-read every run (their counts move fastest)
const RECENT_WINDOW = 10;     // unscanned episodes among the newest 10 are read in the first pass
const EP_PER_WORK = 40;       // stale re-reads per work per run (never-read episodes aren't capped)
const A_WORKERS = 4;
const DEEP_WORKERS = 3;
const GAP = 200;              // ms between requests inside one worker

const A_OPTS = { examplesPer: 1, words: 15, top: 5, cut: 140, hot: 5 };
const DEEP_OPTS = { examplesPer: 3, words: 25, top: 10, cut: 160, hot: 10 };

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const m = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function hash(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeIfChanged(f, obj) {
  const s = JSON.stringify(obj);
  try { if (fs.readFileSync(f, 'utf8') === s) return false; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s, 'utf8');
  return true;
}
const cut = (s, n) => { const t = KREACT.clean(s).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const readable = (list) => list.filter((c) => KREACT.clean(c.text));

// [text, likes, episode, date(, 1 = spoiler)]
function sample(c, title, n) {
  const s = [cut(c.text, n), c.likes, episodeLabel(c.episodeTitle, title), (c.at || '').slice(0, 10)];
  if (c.spoiler) s.push(1);
  return s;
}

// Which episodes the given (most-liked) comments came from -> [[label, count, likeSum], ...]
function hotEpisodes(comments, title, n) {
  const m = new Map();
  for (const c of comments) {
    const label = episodeLabel(c.episodeTitle, title);
    if (!label) continue;
    const e = m.get(label) || [label, 0, 0];
    e[1] += 1; e[2] += c.likes;
    m.set(label, e);
  }
  return [...m.values()].sort((a, b) => b[2] - a[2] || b[1] - a[1]).slice(0, n);
}

function analyse(comments, title, opts) {
  const r = KREACT.pack(KREACT.analyze(comments.map((c) => ({ text: c.text, likes: c.likes, ep: episodeLabel(c.episodeTitle, title) }))), opts.words);
  for (const k of Object.keys(r.examples)) r.examples[k] = r.examples[k].slice(0, opts.examplesPer);
  return r;
}

async function seriesSummary(id, title, today, n, opts) {
  const { total, comments } = await seriesTopComments(id, n, { gap: GAP });
  return {
    v: ENGINE_V, updated: today, due: kstDate(A_REFRESH_DAYS + (hash(id) % 7)),
    total, n: comments.length,
    top: readable(comments).slice(0, opts.top).map((c) => sample(c, title, opts.cut)),
    react: analyse(comments, title, opts), epHot: hotEpisodes(comments, title, opts.hot),
  };
}

// ---- deep works ----
async function deepStart(w, today) {
  const old = readJson(path.join(OUT, `${w.id}.json`), null);
  const oldEp = readJson(path.join(OUT_EP, `${w.id}.json`), null);
  const fresh = old && old.tier === 'deep' && old.v === ENGINE_V && old.updated && daysBetween(old.updated, today) < DEEP_REFRESH_DAYS;
  w.summary = fresh && !w.isNew ? old : { tier: 'deep', ...(await seriesSummary(w.id, w.title, today, DEEP_N, DEEP_OPTS)) };
  w.eps = await listEpisodes(w.id, { gap: GAP });
  w.epData = (oldEp && oldEp.episodes) || {};   // productId -> [order, label, total, scanned, best, mix, releasedAt]
  w.scanned = 0;
}

async function scanEpisode(w, e, today) {
  const { total, comments } = await episodeTopComments(w.id, e.productId, EP_N, { gap: GAP });
  const r = KREACT.analyze(comments.map((c) => ({ text: c.text, likes: c.likes })));
  const mix = {};
  for (const [k, v] of Object.entries(r.reactions)) mix[k] = v[0];
  const best = readable(comments)[0];
  w.epData[e.productId] = [e.order, episodeLabel(e.title, w.title), total || 0, today,
    best ? (best.spoiler ? [cut(best.text, 90), best.likes, 1] : [cut(best.text, 90), best.likes]) : null,
    mix, (e.at || '').slice(0, 10)];
  w.scanned += 1;
}

// Stop the whole run if Kakao starts refusing us (many failures in a row)
// instead of hammering it; whatever was collected so far is still saved.
const MAX_FAILS_IN_A_ROW = 40;
function ok(budget) { budget.streak = 0; }
function fail(budget) {
  budget.failed += 1;
  budget.streak = (budget.streak || 0) + 1;
  if (budget.streak === MAX_FAILS_IN_A_ROW) {
    console.log(`  ! ${MAX_FAILS_IN_A_ROW} failures in a row — stopping early to stay gentle`);
    budget.deadline = 0;
  }
}

async function scanList(w, list, budget, today) {
  for (const e of list) {
    if (budget.ep <= 0 || Date.now() > budget.deadline) return;
    budget.ep -= 1;
    try { await scanEpisode(w, e, today); ok(budget); } catch { fail(budget); }
    await sleep(GAP);
  }
}

function saveDeep(w) {
  if (w.eps.length) {   // drop episodes that no longer exist (never prune on an empty list)
    const live = new Set(w.eps.map((e) => String(e.productId)));
    for (const pid of Object.keys(w.epData)) if (!live.has(pid)) delete w.epData[pid];
  }
  const scanned = Object.keys(w.epData).length;
  writeIfChanged(path.join(OUT, `${w.id}.json`), { ...w.summary, epTotal: Math.max(w.eps.length, scanned), epScanned: scanned });
  writeIfChanged(path.join(OUT_EP, `${w.id}.json`), { v: ENGINE_V, episodes: w.epData });
}

async function pool(items, n, budget, fn) {
  let i = 0;
  const run = async () => { while (i < items.length && Date.now() < budget.deadline) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function dailyTop100(cat, which) {
  const dir = path.join(DATA, cat, 'daily');
  const dates = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const f = dates[dates.length - 1 - which];
  return f ? readJson(path.join(dir, f), []).slice(0, 100).filter((it) => it.workId) : [];
}

export async function collectComments() {
  const t0 = Date.now();
  const today = kstDate();
  const budget = {
    a: Number(arg('budget-a', 1500)),
    ep: Number(arg('budget-ep', 8000)),
    deadline: t0 + Number(arg('max-minutes', 100)) * 60000,
    failed: 0,
    streak: 0,
  };
  const titles = {};
  for (const it of readJson(path.join(DATA, 'search-index.json'), [])) if (it.workId) titles[it.workId] = it.title || '';
  const titleOf = (id) => titles[id] || (readJson(path.join(DATA, 'detail', `${id}.json`), null) || {}).title || '';

  const top100 = new Map();
  const prevTop = new Set();
  for (const cat of ['webnovel', 'webtoon']) {
    dailyTop100(cat, 0).forEach((it) => top100.set(String(it.workId), Math.min(it.rank || 999, top100.get(String(it.workId)) || 999)));
    dailyTop100(cat, 1).forEach((it) => prevTop.add(String(it.workId)));
  }
  const ranked = new Set();
  for (const cat of ['webnovel', 'webtoon']) {
    for (const p of ['daily', 'weekly', 'monthly']) readJson(path.join(DATA, cat, p, 'latest.json'), []).forEach((it) => it.workId && ranked.add(String(it.workId)));
  }

  const idsArg = arg('ids', '');
  const lite = readJson(path.join(DATA, 'works-lite.json'), {});
  const all = idsArg ? idsArg.split(',').filter(Boolean) : [...new Set([...Object.keys(lite), ...top100.keys()])];

  // deep: new to the TOP 100 (or never scanned) first, then by rank
  const deep = all.filter((id) => top100.has(id)).map((id) => ({
    id, title: titleOf(id), rank: top100.get(id),
    isNew: !prevTop.has(id) || !fs.existsSync(path.join(OUT_EP, `${id}.json`)),
  })).sort((a, b) => (b.isNew - a.isNew) || (a.rank - b.rank));

  // tier A: due works - never analysed first, then currently ranked ones
  const existing = new Map();
  const aDue = all.filter((id) => !top100.has(id)).filter((id) => {
    const f = readJson(path.join(OUT, `${id}.json`), null);
    existing.set(id, !!f);
    return !f || f.v !== ENGINE_V || !f.due || f.due <= today;
  }).sort((a, b) => (existing.get(a) - existing.get(b)) || (ranked.has(b) - ranked.has(a)));
  const aList = aDue.slice(0, budget.a);

  console.log(`Comments ${today}: deep ${deep.length} works (${deep.filter((w) => w.isNew).length} new to TOP 100), tier A due ${aDue.length} (doing ${aList.length}), episode budget ${budget.ep}`);

  // 1) deep works: series summary + episode list + newest episodes
  const started = [];
  let n1 = 0;
  await pool(deep, DEEP_WORKERS, budget, async (w) => {
    try {
      await deepStart(w, today);
      const latest = new Set(w.eps.slice(-LATEST_EPS).map((e) => String(e.productId)));
      const first = w.eps.slice(-RECENT_WINDOW).filter((e) => latest.has(String(e.productId)) || !w.epData[e.productId]).reverse();
      await scanList(w, first, budget, today);
      saveDeep(w);
      started.push(w);
      n1 += 1;
      if (n1 % 20 === 0) console.log(`  ...deep pass 1: ${n1}/${deep.length}`);
    } catch (e) {
      fail(budget);
      console.log(`  ! deep ${w.id} ${w.title.slice(0, 20)}: ${e.message}`);
    }
  });

  // 2) tier A
  let doneA = 0;
  await pool(aList, A_WORKERS, budget, async (id) => {
    const file = path.join(OUT, `${id}.json`);
    const old = readJson(file, null);
    try {
      const out = { tier: 'A', ...(await seriesSummary(id, titleOf(id), today, A_N, A_OPTS)) };
      if (old && old.epTotal) { out.epTotal = old.epTotal; out.epScanned = old.epScanned; }   // keeps a former TOP 100 work's episode table linked
      writeIfChanged(file, out);
      ok(budget);
      doneA += 1;
      if (doneA % 500 === 0) console.log(`  ...tier A ${doneA}/${aList.length}`);
    } catch {
      fail(budget);
      // retry in 3 days (e.g. adult-only works the API refuses without login)
      if (budget.deadline) writeIfChanged(file, old ? { ...old, due: kstDate(3) } : { v: ENGINE_V, tier: 'A', updated: today, due: kstDate(3), fail: 1 });
    }
    await sleep(GAP);
  });

  // 3) deep backfill with what's left: never-read episodes first (no per-work cap,
  //    new TOP 100 entrants first), then up to EP_PER_WORK stale re-reads per work.
  started.sort((a, b) => (b.isNew - a.isNew) || (a.rank - b.rank));
  await pool(started, DEEP_WORKERS, budget, async (w) => {
    const unscanned = w.eps.filter((e) => !w.epData[e.productId]).reverse();
    const stale = w.eps.filter((e) => {
      const d = w.epData[e.productId];
      return d && daysBetween(d[3], today) >= EP_REFRESH_DAYS + (hash(e.productId) % 7);
    }).sort((a, b) => (w.epData[a.productId][3] < w.epData[b.productId][3] ? -1 : 1));
    const list = [...unscanned, ...stale.slice(0, EP_PER_WORK)];
    if (!list.length) return;
    const before = w.scanned;
    await scanList(w, list, budget, today);
    if (w.scanned > before) saveDeep(w);
  });

  const scannedEps = started.reduce((s, w) => s + w.scanned, 0);
  const backlog = started.reduce((s, w) => s + w.eps.filter((e) => !w.epData[e.productId]).length, 0);
  const minutes = Math.round((Date.now() - t0) / 60000);
  console.log(`Comments done in ${minutes} min: deep ${started.length}/${deep.length}, tier A ${doneA}, episodes read ${scannedEps} (unscanned left ${backlog}), failed ${budget.failed}.`);
  if (!idsArg) {
    writeIfChanged(path.join(OUT, 'state.json'), {
      lastRun: today, minutes, deep: started.length, tierA: doneA, tierADueLeft: aDue.length - doneA,
      episodesRead: scannedEps, episodeBacklog: backlog, failed: budget.failed,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectComments().catch((e) => { console.error(e); process.exit(1); });
}
