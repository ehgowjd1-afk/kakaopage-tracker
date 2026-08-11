import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EVENT_TABS, buildEventsUrl, scrapeEvents, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');

function getKstDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

async function saveJson(fp, data) {
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf-8');
}

async function main() {
  const today = getKstDateString();
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();
  for (const tab of Object.keys(EVENT_TABS)) {
    const url = buildEventsUrl(tab);
    console.log(`Scraping events:${tab} (${url})`);
    const events = await scrapeEvents(page, url, { log: console.log });
    const dir = path.join(DATA_DIR, 'events', tab);
    await saveJson(path.join(dir, `${today}.json`), events);
    await saveJson(path.join(dir, 'latest.json'), events);
    await sleep(2000);
  }
  await browser.close();
  console.log('=== Done ===');
}
main().catch((e) => { console.error(e); process.exit(1); });
