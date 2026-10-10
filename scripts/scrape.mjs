import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildSearchIndex } from './build-search-index.mjs';
import { collectAllMetrics } from './collect-metrics.mjs';
import { buildWorkDetails } from './build-work-details.mjs';
import { writePromoSnapshot, buildPromoPeriods } from './build-promo-periods.mjs';
import { collectEventDetails } from './collect-event-details.mjs';
import {
  CATEGORIES,
  PERIODS,
  GENRES,
  buildListUrl,
  buildNewReleasesUrl,
  buildEventsUrl,
  scrapeRankingList,
  scrapeWorkDetail,
  scrapeComments,
  scrapeNewReleases,
  scrapeLaunchDate,
  scrapeEvents,
  scrapePromotions,
  mergeEventHistory,
  sleep,
} from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const DETAIL_REFRESH_DAYS = 30;
const MAX_DETAIL_FETCHES_PER_RUN = 100;
// Extra launch-date lookups for ranked (daily TOP) works that don't have one
// yet. Bounded to stay gentle; works that never expose a date aren't retried
// more than once per LAUNCH_RETRY_DAYS.
const MAX_LAUNCHDATE_FETCHES_PER_RUN = 120;
const LAUNCH_RETRY_DAYS = 14;
// Fill in comments for ranked (daily TOP) works that don't have any yet, so a
// newly-entered work gets its comments within a run or two. Bounded per run.
const MAX_COMMENT_FETCHES_PER_RUN = 120;
// Keep tracking the cumulative view count of works that have DROPPED OUT of
// every ranking. They're no longer in today's lists, so the loops above never
// touch them and their viewCount would freeze at its last-ranked value. Each
// run refreshes a bounded batch, oldest-first, so the whole dropped-work
// backlog rotates through over time and the publisher ranking / search stay
// current. Bounded to stay gentle on Kakao.
const MAX_DROPPED_VIEW_REFRESH_PER_RUN = 200;

function getKstDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Slim companion of works.json for the front-end's broad views (ranking list,
// keyword analysis, search, memos). Drops the huge synopsis/comment fields
// (~90% of the size) and is minified, so those views transfer ~0.4MB instead of
// ~12MB. The full works.json is only fetched on a single work's detail page.
const WORKS_LITE_FIELDS = [
  'title', 'author', 'classification', 'keywords', 'viewCount', 'rating',
  'launchDate', 'serialStatus', 'isCompleted', 'publisher', 'ageRatingDetail',
  'sameWorkVersions', 'totalCommentText',
];
async function writeWorksLite(cache) {
  const lite = {};
  for (const [id, o] of Object.entries(cache)) {
    const s = {};
    for (const k of WORKS_LITE_FIELDS) if (o[k] !== undefined && o[k] !== null) s[k] = o[k];
    lite[id] = s;
  }
  await fs.writeFile(path.join(DATA_DIR, 'works-lite.json'), JSON.stringify(lite), 'utf-8');
}

async function loadJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function listDates(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort();
}

async function writeIndex() {
  const index = { genres: {}, viewcounts: {} };
  for (const categoryKey of Object.keys(CATEGORIES)) {
    index[categoryKey] = {};
    for (const period of PERIODS) {
      index[categoryKey][period] = await listDates(path.join(DATA_DIR, categoryKey, period));
    }
    index.genres[categoryKey] = {};
    for (const genreKey of Object.keys(GENRES[categoryKey])) {
      index.genres[categoryKey][genreKey] = {};
      for (const period of PERIODS) {
        index.genres[categoryKey][genreKey][period] = await listDates(
          path.join(DATA_DIR, categoryKey, 'genres', genreKey, period)
        );
      }
    }
    index.viewcounts[categoryKey] = await listDates(path.join(DATA_DIR, categoryKey, 'viewcounts'));
    index.newReleases = index.newReleases || {};
    index.newReleases[categoryKey] = await listDates(path.join(DATA_DIR, categoryKey, 'new-releases'));
  }
  index.events = {};
  for (const eventTab of ['all', 'webnovel', 'webtoon']) {
    index.events[eventTab] = await listDates(path.join(DATA_DIR, 'events', eventTab));
  }
  await saveJson(path.join(DATA_DIR, 'index.json'), index);
}

async function main() {
  const today = getKstDateString();
  console.log(`=== Kakao Page scrape start (${today} KST) ===`);

  // Use a specific Chromium binary when one is provided (e.g. the cloud backup
  // sandbox pins a different Playwright build than the repo). Falls back to
  // Playwright's own managed browser locally / in CI.
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}
  );
  // ignoreHTTPSErrors lets the browser work behind a TLS-intercepting egress
  // proxy (e.g. the cloud backup sandbox re-terminates HTTPS with its own CA
  // that Chromium doesn't trust). Harmless locally/in CI where certs are valid.
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR', ignoreHTTPSErrors: true });
  const page = await context.newPage();

  const allWorkIds = new Set();
  const dailyTop300ByCategory = {};
  const summary = [];

  for (const categoryKey of Object.keys(CATEGORIES)) {
    for (const period of PERIODS) {
      const url = buildListUrl(categoryKey, period);
      console.log(`Scraping ${categoryKey} / ${period} (${url})`);
      const items = await scrapeRankingList(page, url, { log: console.log });
      items.forEach((it) => it.workId && allWorkIds.add(it.workId));
      if (period === 'daily') dailyTop300ByCategory[categoryKey] = items;
      await saveJson(path.join(DATA_DIR, categoryKey, period, `${today}.json`), items);
      await saveJson(path.join(DATA_DIR, categoryKey, period, 'latest.json'), items);
      summary.push({ categoryKey, period, count: items.length });
      await sleep(2000 + Math.random() * 2000);
    }

    for (const [genreKey, genre] of Object.entries(GENRES[categoryKey])) {
      for (const period of PERIODS) {
        const url = buildListUrl(categoryKey, period, genre.id);
        console.log(`Scraping ${categoryKey} / genre:${genreKey} / ${period} (${url})`);
        const items = await scrapeRankingList(page, url, { log: console.log });
        // Genre works are added to the detail-fetch queue too, but the whole phase
        // is capped at MAX_DETAIL_FETCHES_PER_RUN so it backfills over several days
        // instead of hammering Kakao in one run.
        items.forEach((it) => it.workId && allWorkIds.add(it.workId));
        const dir = path.join(DATA_DIR, categoryKey, 'genres', genreKey, period);
        await saveJson(path.join(dir, `${today}.json`), items);
        await saveJson(path.join(dir, 'latest.json'), items);
        summary.push({ categoryKey, period, genre: genreKey, count: items.length });
        await sleep(2000 + Math.random() * 2000);
      }
    }
  }

  for (const categoryKey of Object.keys(CATEGORIES)) {
    const url = buildNewReleasesUrl(categoryKey);
    console.log(`Scraping ${categoryKey} / new-releases (${url})`);
    const items = await scrapeNewReleases(page, url, today, { log: console.log });
    items.forEach((it) => it.workId && allWorkIds.add(it.workId));
    const dir = path.join(DATA_DIR, categoryKey, 'new-releases');
    await saveJson(path.join(dir, `${today}.json`), items);
    await saveJson(path.join(dir, 'latest.json'), items);
    summary.push({ categoryKey, period: 'new-releases', count: items.length });
    await sleep(2000 + Math.random() * 2000);
  }

  for (const eventTab of ['all', 'webnovel', 'webtoon']) {
    const url = buildEventsUrl(eventTab);
    console.log(`Scraping events:${eventTab} (${url})`);
    const events = await scrapeEvents(page, url, { log: console.log });
    const dir = path.join(DATA_DIR, 'events', eventTab);
    await saveJson(path.join(dir, `${today}.json`), events);
    await saveJson(path.join(dir, 'latest.json'), events);
    const history = await loadJson(path.join(dir, 'history.json'), []);
    await saveJson(path.join(dir, 'history.json'), mergeEventHistory(history, events, today));
    summary.push({ categoryKey: eventTab, period: 'events', count: events.length });
    await sleep(2000 + Math.random() * 2000);
  }

  await writeIndex();

  const cachePath = path.join(DATA_DIR, 'works.json');
  const cache = await loadJson(cachePath, {});

  const freshDetailCache = new Map();
  const promotionsByWork = {}; // workId -> [{bannerUid,title,link}], refreshed daily
  const now = Date.now();
  const nowIso = () => new Date().toISOString();
  const launchRetryMs = LAUNCH_RETRY_DAYS * 24 * 60 * 60 * 1000;
  let launchDateBudget = MAX_LAUNCHDATE_FETCHES_PER_RUN;
  let commentBudget = MAX_COMMENT_FETCHES_PER_RUN;
  for (const categoryKey of Object.keys(CATEGORIES)) {
    const items = dailyTop300ByCategory[categoryKey] || [];
    console.log(`Fetching view counts + details + promotions for ${categoryKey} TOP ${items.length} (daily)...`);
    const snapshot = [];
    let vcDone = 0;
    for (const item of items) {
      if (!item.workId) continue;
      const detail = await scrapeWorkDetail(page, item.workId, { log: console.log });
      if (detail) {
        freshDetailCache.set(item.workId, detail);
        if (detail.viewCount) snapshot.push({ workId: item.workId, viewCount: detail.viewCount });
        // Don't discard the detail we just fetched: cache it so every ranked
        // (daily TOP) work has current author/genre/keywords/etc. Preserve any
        // launchDate/comments already collected (detail doesn't carry them).
        const prev = cache[item.workId] || {};
        cache[item.workId] = { ...prev, ...detail, workId: item.workId, lastChecked: nowIso() };
      }
      await sleep(600 + Math.random() * 600);
      // Backfill launch date for ranked works missing one (bounded; don't retry
      // works that never expose a date more than once per LAUNCH_RETRY_DAYS).
      const cached = cache[item.workId];
      if (cached && !cached.launchDate && launchDateBudget > 0) {
        const triedAt = cached.launchDateTriedAt ? new Date(cached.launchDateTriedAt).getTime() : 0;
        if (now - triedAt > launchRetryMs) {
          cached.launchDate = await scrapeLaunchDate(page, item.workId, { log: console.log });
          cached.launchDateTriedAt = nowIso();
          launchDateBudget -= 1;
          await sleep(600 + Math.random() * 600);
        }
      }
      // Fill in comments for ranked works that don't have any yet (bounded), so
      // newly-entered daily TOP works get comments even though they're marked
      // fresh above and thus skipped by the detail-backfill loop below.
      if (cached && (!cached.topComments || cached.topComments.length === 0) && commentBudget > 0) {
        const comments = await scrapeComments(page, item.workId, { log: console.log });
        if (comments) {
          cached.totalCommentText = comments.totalCommentText ?? cached.totalCommentText ?? null;
          cached.topComments = comments.topComments ?? [];
          cached.commentKeywords = comments.keywords ?? [];
        }
        commentBudget -= 1;
        await sleep(600 + Math.random() * 600);
      }
      const promos = await scrapePromotions(page, item.workId, { log: console.log });
      promotionsByWork[item.workId] = promos;
      vcDone += 1;
      if (vcDone % 25 === 0) console.log(`  ...${vcDone}/${items.length} done`);
      await sleep(600 + Math.random() * 600);
    }
    const vcDir = path.join(DATA_DIR, categoryKey, 'viewcounts');
    await saveJson(path.join(vcDir, `${today}.json`), snapshot);
    await saveJson(path.join(vcDir, 'latest.json'), snapshot);
    await saveJson(cachePath, cache); // persist ranked-work details after each category
  }
  await saveJson(path.join(DATA_DIR, 'promotions.json'), promotionsByWork);
  // Keep today's 소식-tab banners as a dated snapshot (promotions.json only holds
  // today); the promotion periods are rebuilt at the end of the run.
  try { writePromoSnapshot(today, promotionsByWork); } catch (e) { console.error('promo snapshot failed:', e.message); }
  const refreshMs = DETAIL_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  const staleIds = [...allWorkIds].filter((id) => {
    const entry = cache[id];
    if (!entry) return true;
    return now - new Date(entry.lastChecked).getTime() > refreshMs;
  });
  const idsToFetch = staleIds.slice(0, MAX_DETAIL_FETCHES_PER_RUN);
  if (staleIds.length > idsToFetch.length) {
    console.log(
      `  (${staleIds.length - idsToFetch.length} more works need detail info but are deferred to a future run, capped at ${MAX_DETAIL_FETCHES_PER_RUN}/run)`
    );
  }

  console.log(`Fetching detail info for ${idsToFetch.length} works (of ${allWorkIds.size} total in today's lists)...`);
  let done = 0;
  for (const workId of idsToFetch) {
    let detail = freshDetailCache.get(workId);
    if (!detail) {
      detail = await scrapeWorkDetail(page, workId, { log: console.log });
      await sleep(1200 + Math.random() * 1200);
    }
    const comments = await scrapeComments(page, workId, { log: console.log });
    let launchDate = cache[workId]?.launchDate ?? null;
    if (!launchDate) {
      await sleep(800 + Math.random() * 800);
      launchDate = await scrapeLaunchDate(page, workId, { log: console.log });
    }
    if (detail) {
      cache[workId] = {
        ...detail,
        workId,
        launchDate,
        totalCommentText: comments?.totalCommentText ?? null,
        topComments: comments?.topComments ?? [],
        commentKeywords: comments?.keywords ?? [],
        lastChecked: new Date().toISOString(),
      };
    }
    done += 1;
    if (done % 10 === 0) {
      await saveJson(cachePath, cache);
      console.log(`  ...${done}/${idsToFetch.length} works done`);
    }
    await sleep(1500 + Math.random() * 1500);
  }
  await saveJson(cachePath, cache);

  // Dropped-work view-count refresh: works in the cache that are NOT in any of
  // today's lists keep getting their cumulative view count (and author/
  // publisher/keywords/rating, which detail returns for free) refreshed, a
  // bounded batch per run, oldest-refreshed first so the backlog rotates.
  const rankedToday = new Set([...allWorkIds].map((id) => String(id)));
  const droppedIds = Object.keys(cache)
    .filter((id) => !rankedToday.has(String(id)))
    .sort((a, b) => {
      const ta = new Date(cache[a].viewRefreshedAt || cache[a].lastChecked || 0).getTime();
      const tb = new Date(cache[b].viewRefreshedAt || cache[b].lastChecked || 0).getTime();
      return ta - tb; // oldest first
    })
    .slice(0, MAX_DROPPED_VIEW_REFRESH_PER_RUN);
  if (droppedIds.length) {
    console.log(`Refreshing view counts for ${droppedIds.length} dropped-out works (${Object.keys(cache).length - rankedToday.size} tracked, rotating)...`);
    let dvDone = 0;
    for (const workId of droppedIds) {
      const detail = await scrapeWorkDetail(page, workId, { log: console.log });
      if (detail) {
        const prev = cache[workId] || {};
        cache[workId] = { ...prev, ...detail, workId, viewRefreshedAt: new Date().toISOString() };
      } else {
        // Mark it tried so a work that no longer resolves doesn't block rotation.
        cache[workId].viewRefreshedAt = new Date().toISOString();
      }
      dvDone += 1;
      if (dvDone % 25 === 0) {
        await saveJson(cachePath, cache);
        console.log(`  ...${dvDone}/${droppedIds.length} dropped-work views refreshed`);
      }
      await sleep(900 + Math.random() * 900);
    }
    await saveJson(cachePath, cache);
  }

  await writeWorksLite(cache);
  // Title/author search index of every work ever ranked (incl. dropped-out).
  await fs.writeFile(path.join(DATA_DIR, 'search-index.json'), JSON.stringify(buildSearchIndex()), 'utf-8');
  await writeIndex();
  await browser.close();

  // Exact daily metrics (views/rating/comments) for EVERY work via BFF — covers
  // works that dropped out of the ranking and new titles too. Then rebuild the
  // per-work detail cards so the detail page stays a single fast fetch.
  try { await collectAllMetrics(); } catch (e) { console.error('metrics step failed:', e.message); }
  try { await buildWorkDetails(); } catch (e) { console.error('detail-card step failed:', e.message); }
  // Open each event in the 이벤트 tab (new / still running) for its works, reward
  // lines and official dates, then rebuild the per-work promotion periods and the
  // event analysis the site shows.
  try { await collectEventDetails(); } catch (e) { console.error('event-details step failed:', e.message); }
  try { buildPromoPeriods(); } catch (e) { console.error('promo-period step failed:', e.message); }

  console.log('=== Done ===');
  console.table(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
