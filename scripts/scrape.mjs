import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, PERIODS, buildListUrl, scrapeRankingList, scrapeWorkDetail, scrapeComments, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const DETAIL_REFRESH_DAYS = 30;

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

async function writeIndex() {
  const index = {};
  for (const categoryKey of Object.keys(CATEGORIES)) {
    index[categoryKey] = {};
    for (const period of PERIODS) {
      const dir = path.join(DATA_DIR, categoryKey, period);
      const files = await fs.readdir(dir).catch(() => []);
      const dates = files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map((f) => f.replace('.json', ''))
        .sort();
      index[categoryKey][period] = dates;
    }
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
  const summary = [];

  for (const categoryKey of Object.keys(CATEGORIES)) {
    for (const period of PERIODS) {
      const url = buildListUrl(categoryKey, period);
      console.log(`Scraping ${categoryKey} / ${period} (${url})`);
      const items = await scrapeRankingList(page, url, { log: console.log });
      items.forEach((it) => it.workId && allWorkIds.add(it.workId));
      await saveJson(path.join(DATA_DIR, categoryKey, period, `${today}.json`), items);
      await saveJson(path.join(DATA_DIR, categoryKey, period, 'latest.json'), items);
      summary.push({ categoryKey, period, count: items.length });
      await sleep(2000 + Math.random() * 2000);
    }
  }

  await writeIndex();

  const cachePath = path.join(DATA_DIR, 'works.json');
  const cache = await loadJson(cachePath, {});
  const refreshMs = DETAIL_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const idsToFetch = [...allWorkIds].filter((id) => {
    const entry = cache[id];
    if (!entry) return true;
    return now - new Date(entry.lastChecked).getTime() > refreshMs;
  });

  console.log(`Fetching detail info for ${idsToFetch.length} works (of ${allWorkIds.size} total in today's lists)...`);
  let done = 0;
  for (const workId of idsToFetch) {
    const detail = await scrapeWorkDetail(page, workId, { log: console.log });
    await sleep(1200 + Math.random() * 1200);
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
