// Popular comments (the BEST comments scraped from each work's page) are kept
// outside works.json: they were 75% of it (36.7MB of 48.7MB on 2026-10-10) and
// pushed that single file past GitHub's 50MB warning. Stored in 100 shards by
// the last two digits of the work id — docs/data/top-comments/NN.json =
// { workId: [comment, …] } — and a shard is only rewritten when it changed, so
// a day's scrape touches a few small files instead of one huge one.
// The site never reads these directly: build-work-details.mjs copies them into
// each work's detail card.
import fs from 'node:fs';
import path from 'node:path';

const shardOf = (id) => String(id).slice(-2).padStart(2, '0');

export function loadTopComments(dataDir) {
  const dir = path.join(dataDir, 'top-comments');
  const map = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d\d\.json$/.test(f)) continue;
      const shard = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const [id, list] of Object.entries(shard)) map.set(id, list);
    }
  }
  return { dir, map, dirty: new Set() };
}

export function hasTopComments(tc, id) {
  const list = tc.map.get(String(id));
  return !!(list && list.length);
}

export function getTopComments(tc, id) {
  return tc.map.get(String(id)) || [];
}

export function setTopComments(tc, id, list) {
  const key = String(id);
  const next = list || [];
  if (JSON.stringify(tc.map.get(key) || []) === JSON.stringify(next)) return;
  if (next.length) tc.map.set(key, next);
  else tc.map.delete(key);
  tc.dirty.add(shardOf(key));
}

/** Write the shards that changed (all of them with { all: true }). */
export function saveTopComments(tc, { all = false } = {}) {
  fs.mkdirSync(tc.dir, { recursive: true });
  const shards = new Map();
  for (const [id, list] of tc.map) {
    const s = shardOf(id);
    if (!all && !tc.dirty.has(s)) continue;
    if (!shards.has(s)) shards.set(s, {});
    shards.get(s)[id] = list;
  }
  const targets = all ? new Set([...shards.keys()]) : tc.dirty;
  for (const s of targets) {
    const obj = shards.get(s) || {};
    const sorted = Object.fromEntries(Object.entries(obj).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    fs.writeFileSync(path.join(tc.dir, `${s}.json`), JSON.stringify(sorted), 'utf8');
  }
  tc.dirty.clear();
}
