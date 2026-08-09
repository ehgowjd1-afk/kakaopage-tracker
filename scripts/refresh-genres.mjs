import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GENRES, PERIODS, buildListUrl, scrapeRankingList, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const CATEGORY = 'webnovel';
const TARGET_GENRES = ['romfantasy', 'hyunpan', 'fantasy'];

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

async function main() {
  const today = getKstDateString();
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();

  for (const genreKey of TARGET_GENRES) {
    const genre = GENRES[CATEGORY][genreKey];
    for (const period of PERIODS) {
      const url = buildListUrl(CATEGORY, period, genre.id);
      console.log(`Scraping ${CATEGORY} / genre:${genreKey} / ${period} (${url})`);
      const items = await scrapeRankingList(page, url, { log: console.log });
      const dir = path.join(DATA_DIR, CATEGORY, 'genres', genreKey, period);
      await saveJson(path.join(dir, `${today}.json`), items);
      await saveJson(path.join(dir, 'latest.json'), items);
      await sleep(2000 + Math.random() * 2000);
    }
  }

  await browser.close();
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
