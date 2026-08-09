import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scrapeWorkDetail, scrapeComments, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const CATEGORY = 'webnovel';
const TARGET_GENRES = ['romfantasy', 'hyunpan', 'fantasy'];
const PERIODS = ['daily', 'weekly', 'monthly'];

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  const cachePath = path.join(DATA_DIR, 'works.json');
  const cache = await loadJson(cachePath, {});

  const ids = new Set();
  for (const g of TARGET_GENRES) {
    for (const p of PERIODS) {
      const items = await loadJson(path.join(DATA_DIR, CATEGORY, 'genres', g, p, 'latest.json'), []);
      items.forEach((it) => it.workId && ids.add(it.workId));
    }
  }
  const idsToFetch = [...ids].filter((id) => !cache[id]);
  console.log(`Fetching detail info for ${idsToFetch.length} works (${ids.size} unique across target genres)...`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();

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
  await browser.close();
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
