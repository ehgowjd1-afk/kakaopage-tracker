import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scrapePromotions, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const LIMIT = parseInt(process.argv[2] || '300', 10);

async function loadJson(fp, fb) { try { return JSON.parse(await fs.readFile(fp, 'utf-8')); } catch { return fb; } }
async function saveJson(fp, d) { await fs.mkdir(path.dirname(fp), { recursive: true }); await fs.writeFile(fp, JSON.stringify(d, null, 2), 'utf-8'); }

async function main() {
  const out = await loadJson(path.join(DATA_DIR, 'promotions.json'), {});
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();
  for (const cat of ['webnovel', 'webtoon']) {
    const list = await loadJson(path.join(DATA_DIR, cat, 'daily', 'latest.json'), []);
    const items = list.slice(0, LIMIT);
    console.log(`${cat}: scraping promotions for ${items.length} works`);
    let done = 0;
    for (const it of items) {
      if (!it.workId) continue;
      out[it.workId] = await scrapePromotions(page, it.workId, { log: console.log });
      done += 1;
      if (done % 25 === 0) { await saveJson(path.join(DATA_DIR, 'promotions.json'), out); console.log(`  ...${done}/${items.length}`); }
      await sleep(900 + Math.random() * 700);
    }
  }
  await saveJson(path.join(DATA_DIR, 'promotions.json'), out);
  await browser.close();
  console.log('=== Done ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
