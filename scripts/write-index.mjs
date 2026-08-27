// Regenerate docs/data/index.json deterministically from whatever snapshot
// files are on disk. index.json is fully derived from the data files, so on a
// merge/rebase conflict the workflow rebuilds it from the union of both sides
// instead of trying to text-merge it.  Run: node scripts/write-index.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, PERIODS, GENRES } from './lib/kakao.mjs';

const DATA_DIR = path.join(process.cwd(), 'docs', 'data');

async function listDates(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort();
}

async function main() {
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
  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  console.log('index.json regenerated.');
}

main().catch((e) => { console.error(e); process.exit(1); });
