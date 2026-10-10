// Build one compact per-work "detail card" per work:  docs/data/detail/{id}.json
// It bundles everything the work-detail page needs so the page fetches ONE small
// file instead of the ~59MB works.json plus ~220 per-date snapshot requests:
//   { synopsis, topComments, commentKeywords,
//     rankSeries: { daily:[{date,rank,change}], weekly:[...], monthly:[...] },
//     viewSeries: [{date, viewCount}] }
// Rebuilding daily is cheap in git terms: files whose data didn't change come out
// byte-identical (minified, stable key order) so git only commits works that moved.
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATEGORIES, PERIODS, GENRES } from './lib/kakao.mjs';
import { loadTopComments, getTopComments } from './lib/top-comments.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const OUT_DIR = path.join(DATA_DIR, 'detail');
const PERIOD_KEYS = PERIODS.map((p) => (typeof p === 'string' ? p : p.key));

function readJson(f, fb) { try { return JSON.parse(fssync.readFileSync(f, 'utf8')); } catch { return fb; } }
function datesIn(dir) {
  try {
    return fssync.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort();
  } catch { return []; }
}
// label (from "웹소설 / 로판") -> genre key, per category
function genreKeyOf(cat, classification) {
  if (!classification) return null;
  const label = classification.split('/').pop().trim();
  const found = Object.entries(GENRES[cat] || {}).find(([, g]) => g.label === label);
  return found ? found[0] : null;
}

export async function buildWorkDetails() {
  const works = readJson(path.join(DATA_DIR, 'works.json'), {});
  const tc = loadTopComments(DATA_DIR); // popular comments live outside works.json
  const cats = Object.keys(CATEGORIES);

  // Accumulators keyed by workId. Overall first, genre as fallback for works
  // that never chart in the overall TOP 300.
  const overall = {};           // id -> { daily:[], weekly:[], monthly:[] }
  const genreSeries = {};        // cat -> genreKey -> { daily:[], weekly:[], monthly:[] } -> id -> []
  const views = {};             // id -> [{date, viewCount}]
  const metaByWork = {};         // id -> { title, thumbnail } (latest date seen wins)
  const ensure = (obj, id) => obj[id] || (obj[id] = { daily: [], weekly: [], monthly: [] });
  const noteMeta = (it) => { if (it.workId && (it.title || it.thumbnail)) metaByWork[it.workId] = { title: it.title ?? (metaByWork[it.workId] || {}).title ?? null, thumbnail: it.thumbnail ?? (metaByWork[it.workId] || {}).thumbnail ?? null }; };

  for (const cat of cats) {
    // overall rankings
    for (const period of PERIOD_KEYS) {
      const dir = path.join(DATA_DIR, cat, period);
      for (const date of datesIn(dir)) {
        for (const it of readJson(path.join(dir, `${date}.json`), [])) {
          if (!it.workId) continue;
          ensure(overall, it.workId)[period].push({ date, rank: it.rank, change: it.change ?? null });
          noteMeta(it);
        }
      }
    }
    // genre rankings (kept separate so a genre-only work can still show a trend)
    const gdir = path.join(DATA_DIR, cat, 'genres');
    const genreKeys = fssync.existsSync(gdir) ? fssync.readdirSync(gdir) : [];
    genreSeries[cat] = {};
    for (const gk of genreKeys) {
      genreSeries[cat][gk] = {};
      for (const period of PERIOD_KEYS) {
        const dir = path.join(gdir, gk, period);
        for (const date of datesIn(dir)) {
          for (const it of readJson(path.join(dir, `${date}.json`), [])) {
            if (!it.workId) continue;
            const slot = genreSeries[cat][gk][it.workId] || (genreSeries[cat][gk][it.workId] = { daily: [], weekly: [], monthly: [] });
            slot[period].push({ date, rank: it.rank, change: it.change ?? null });
            noteMeta(it);
          }
        }
      }
    }
    // view counts
    const vdir = path.join(DATA_DIR, cat, 'viewcounts');
    for (const date of datesIn(vdir)) {
      for (const it of readJson(path.join(vdir, `${date}.json`), [])) {
        if (!it.workId) continue;
        (views[it.workId] || (views[it.workId] = [])).push({ date, viewCount: it.viewCount });
      }
    }
  }

  // Exact daily metrics (views / rating participation / comments) collected via
  // the BFF API — 1-unit precise, covers every work regardless of ranking.
  // Complements the historical rounded viewSeries going forward.
  const metricsByWork = {};
  const mdir = path.join(DATA_DIR, 'metrics');
  for (const date of datesIn(mdir)) {
    const day = readJson(path.join(mdir, `${date}.json`), {});
    for (const [id, m] of Object.entries(day)) {
      (metricsByWork[id] || (metricsByWork[id] = [])).push({ date, v: m.v ?? null, rc: m.rc ?? null, rs: m.rs ?? null, cc: m.cc ?? null });
    }
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  let written = 0;
  for (const [id, w] of Object.entries(works)) {
    const ov = overall[id] || { daily: [], weekly: [], monthly: [] };
    let rankSeries = ov;
    const hasOverall = PERIOD_KEYS.some((p) => ov[p] && ov[p].length);
    if (!hasOverall) {
      // fall back to the work's own genre series
      const cat = (w.classification || '').startsWith('웹툰') ? 'webtoon' : 'webnovel';
      const gk = genreKeyOf(cat, w.classification);
      const gs = gk && genreSeries[cat] && genreSeries[cat][gk] && genreSeries[cat][gk][id];
      if (gs) rankSeries = gs;
    }
    const m = metaByWork[id] || {};
    const card = {
      title: m.title ?? w.title ?? null,
      thumbnail: m.thumbnail ?? null,
      synopsis: w.synopsis ?? null,
      topComments: getTopComments(tc, id),
      commentKeywords: w.commentKeywords ?? [],
      rankSeries,
      viewSeries: views[id] || [],
      metricsSeries: metricsByWork[id] || [],
    };
    const file = path.join(OUT_DIR, `${id}.json`);
    const next = JSON.stringify(card);
    // only write when the bytes actually change (keeps git churn to moved works)
    let prev = null;
    try { prev = fssync.readFileSync(file, 'utf8'); } catch {}
    if (prev !== next) { await fs.writeFile(file, next, 'utf8'); written += 1; }
  }
  console.log(`detail cards: ${Object.keys(works).length} works, ${written} written/changed.`);
}

// Run standalone: `node scripts/build-work-details.mjs`
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildWorkDetails().catch((e) => { console.error(e); process.exit(1); });
}
