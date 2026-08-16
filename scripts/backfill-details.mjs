// One-time (resumable) catch-up: fetch detail for EVERY work that appears in
// any ranking list (daily/weekly/monthly + every genre, both categories) but
// doesn't have detail yet. Saves works.json incrementally so it can be stopped
// and resumed. Skips comments (the daily run backfills those); fetches launch
// date when missing. Run: `node scripts/backfill-details.mjs`
import { chromium, devices } from 'playwright';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { scrapeWorkDetail, scrapeLaunchDate, sleep } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');
const CACHE = path.join(DATA_DIR, 'works.json');
const LAUNCH_RETRY_MS = 14 * 24 * 60 * 60 * 1000;

function readJson(f, fb) { try { return JSON.parse(fssync.readFileSync(f, 'utf8')); } catch { return fb; } }

function collectWorkIds() {
  const ids = new Set();
  const add = (f) => { for (const x of readJson(f, [])) if (x.workId) ids.add(String(x.workId)); };
  for (const cat of ['webnovel', 'webtoon']) {
    for (const p of ['daily', 'weekly', 'monthly']) add(path.join(DATA_DIR, cat, p, 'latest.json'));
    const gdir = path.join(DATA_DIR, cat, 'genres');
    if (fssync.existsSync(gdir)) {
      for (const g of fssync.readdirSync(gdir))
        for (const p of ['daily', 'weekly', 'monthly']) add(path.join(DATA_DIR, cat, 'genres', g, p, 'latest.json'));
    }
  }
  return [...ids];
}

async function main() {
  const cache = readJson(CACHE, {});
  const now = Date.now();
  const allIds = collectWorkIds();
  // Work to do: no detail yet (no author), or missing a launch date we haven't
  // tried recently. Fully-populated works are skipped, so reruns resume.
  const todo = allIds.filter((id) => {
    const e = cache[id];
    if (!e || !e.author) return true;
    if (!e.launchDate) {
      const tried = e.launchDateTriedAt ? new Date(e.launchDateTriedAt).getTime() : 0;
      return now - tried > LAUNCH_RETRY_MS;
    }
    return false;
  });
  console.log(`Total ranked works: ${allIds.length}. Need detail/launch-date: ${todo.length}.`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  const page = await context.newPage();

  let done = 0;
  for (const id of todo) {
    const existing = cache[id] || {};
    let detail = null;
    if (!existing.author) {
      detail = await scrapeWorkDetail(page, id, { log: () => {} });
      await sleep(1200 + Math.random() * 900);
    }
    let launchDate = existing.launchDate ?? (detail ? null : existing.launchDate);
    let triedAt = existing.launchDateTriedAt;
    if (!launchDate) {
      launchDate = await scrapeLaunchDate(page, id, { log: () => {} });
      triedAt = new Date().toISOString();
      await sleep(900 + Math.random() * 700);
    }
    if (detail || launchDate || triedAt) {
      cache[id] = {
        ...existing,
        ...(detail || {}),
        workId: id,
        launchDate: launchDate ?? existing.launchDate ?? null,
        launchDateTriedAt: triedAt ?? existing.launchDateTriedAt,
        lastChecked: new Date().toISOString(),
      };
    }
    done += 1;
    if (done % 20 === 0) {
      await fs.writeFile(CACHE, JSON.stringify(cache, null, 2), 'utf8');
      console.log(`  ...${done}/${todo.length} done (saved)`);
    }
  }
  await fs.writeFile(CACHE, JSON.stringify(cache, null, 2), 'utf8');
  await browser.close();
  const withAuthor = allIds.filter((id) => cache[id]?.author).length;
  console.log(`=== Done. ${done} processed. Ranked works with detail now: ${withAuthor}/${allIds.length} ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
