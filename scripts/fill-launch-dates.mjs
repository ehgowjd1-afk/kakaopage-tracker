import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scrapeLaunchDate, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');

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
  const missingIds = Object.keys(cache).filter((id) => !cache[id].launchDate);
  console.log(`Backfilling launchDate for ${missingIds.length} works...`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();

  let done = 0;
  for (const workId of missingIds) {
    const launchDate = await scrapeLaunchDate(page, workId, { log: console.log });
    if (launchDate) cache[workId].launchDate = launchDate;
    done += 1;
    if (done % 20 === 0) {
      await saveJson(cachePath, cache);
      console.log(`  ...${done}/${missingIds.length} done`);
    }
    await sleep(1200 + Math.random() * 1200);
  }
  await saveJson(cachePath, cache);
  await browser.close();
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
