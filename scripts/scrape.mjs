import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, PERIODS, GENRES, buildListUrl, scrapeRankingList, scrapeWorkDetail, scrapeComments, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const DETAIL_REFRESH_DAYS = 30;
const MAX_DETAIL_FETCHES_PER_RUN = 500;

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
  }
  await saveJson(path.join(DATA_DIR, 'index.json'), index);
}

async function main() {
  const today = getKstDateString();
  console.log(`=== Kakao Page scrape start (${today} KST) ===`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
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
        // Intentionally NOT added to allWorkIds: genre-only long-tail works don't get
        // detail/comment pages fetched, to keep that phase bounded to the overall TOP 300.
        const dir = path.join(DATA_DIR, categoryKey, 'genres', genreKey, period);
        await saveJson(path.join(dir, `${today}.json`), items);
        await saveJson(path.join(dir, 'latest.json'), items);
        summary.push({ categoryKey, period, genre: genreKey, count: items.length });
        await sleep(2000 + Math.random() * 2000);
      }
    }
  }

  await writeIndex();

  const cachePath = path.join(DATA_DIR, 'works.json');
  const cache = await loadJson(cachePath, {});

  const freshDetailCache = new Map();
  for (const categoryKey of Object.keys(CATEGORIES)) {
    const items = dailyTop300ByCategory[categoryKey] || [];
    console.log(`Fetching view counts for ${categoryKey} TOP ${items.length} (daily)...`);
    const snapshot = [];
    let vcDone = 0;
    for (const item of items) {
      if (!item.workId) continue;
      const detail = await scrapeWorkDetail(page, item.workId, { log: console.log });
      if (detail) {
        freshDetailCache.set(item.workId, detail);
        if (detail.viewCount) snapshot.push({ workId: item.workId, viewCount: detail.viewCount });
      }
      vcDone += 1;
      if (vcDone % 25 === 0) console.log(`  ...${vcDone}/${items.length} view counts done`);
      await sleep(800 + Math.random() * 800);
    }
    const vcDir = path.join(DATA_DIR, categoryKey, 'viewcounts');
    await saveJson(path.join(vcDir, `${today}.json`), snapshot);
    await saveJson(path.join(vcDir, 'latest.json'), snapshot);
  }
  const refreshMs = DETAIL_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
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
    if (detail) {
      cache[workId] = {
        ...detail,
        workId,
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
  await writeIndex();

  await browser.close();
  console.log('=== Done ===');
  console.table(summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
