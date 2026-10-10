// Slim companion of works.json for the front-end's broad views (ranking list,
// keyword analysis, search, memos). Drops the huge synopsis/comment fields
// (~90% of the size) and is minified, so those views transfer ~0.4MB instead of
// ~12MB. The full works.json is only fetched on a single work's detail page.
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKS_LITE_FIELDS = [
  'title', 'author', 'classification', 'keywords', 'viewCount', 'rating',
  'launchDate', 'serialStatus', 'isCompleted', 'publisher', 'ageRatingDetail',
  'sameWorkVersions', 'totalCommentText',
];

export async function writeWorksLite(cache, dataDir) {
  const lite = {};
  for (const [id, o] of Object.entries(cache)) {
    const s = {};
    for (const k of WORKS_LITE_FIELDS) if (o[k] !== undefined && o[k] !== null) s[k] = o[k];
    lite[id] = s;
  }
  await fs.writeFile(path.join(dataDir, 'works-lite.json'), JSON.stringify(lite), 'utf-8');
}
