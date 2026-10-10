// Daily reading of new event images (scheduled Claude task on the user's PC).
// Runs in a dedicated, detached, sparse worktree so it never touches the main
// checkout: C:\Users\Desktop\.kakaopage-imgreader (git worktree of this repo).
//
//   node scripts/image-reads-sync.mjs prepare <outDir>
//     fetch + reset to origin/master, then download the images of events not
//     read yet into <outDir> and write <outDir>/batches/batch-NNN.json
//   node scripts/image-reads-sync.mjs publish <results.json>
//     merge the readings (scripts/apply-image-reads.mjs), rebuild the promotion
//     data, commit as ehgowjd1-afk and push to master. If the daily scrape pushed
//     in between, start again from the new origin/master and re-merge (the
//     readings file is only ever written here; everything else is rebuilt).
// How to read the batches: scripts/read-event-images.md
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { preparePending } from './pending-event-images.mjs';
import { mergeImageReads } from './apply-image-reads.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FILES = ['docs/data/events/image-reads.json', 'docs/data/promo-periods.json', 'docs/data/event-analysis.json'];

// reset --hard is only safe in the throw-away worktree, which sits on a detached
// HEAD; the main checkout is on a branch, so refuse there.
function assertWorktree() {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'HEAD') {
    console.error('refusing: run this in the detached image-reader worktree (C:\\Users\\Desktop\\.kakaopage-imgreader), not on a branch checkout');
    process.exit(2);
  }
}

function syncToOrigin() {
  git('fetch', '-q', 'origin', 'master');
  git('reset', '-q', '--hard', 'origin/master');
}

const [cmd, arg] = process.argv.slice(2);
assertWorktree();
if (cmd === 'prepare' && arg) {
  syncToOrigin();
  fs.rmSync(arg, { recursive: true, force: true });
  const batches = await preparePending(arg);
  console.log(batches.length ? `BATCHES:\n${batches.join('\n')}` : 'NOTHING TO READ');
} else if (cmd === 'publish' && arg) {
  const results = JSON.parse(fs.readFileSync(arg, 'utf8'));
  const n = (results.events || []).length;
  if (!n) { console.log('no readings in results — nothing to publish'); process.exit(0); }
  const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  for (let attempt = 1; attempt <= 5; attempt++) {
    syncToOrigin();
    mergeImageReads(results);
    git('add', ...FILES);
    if (!git('diff', '--cached', '--name-only')) { console.log('no changes after merge — already published'); process.exit(0); }
    git('-c', 'user.name=ehgowjd1-afk', '-c', 'user.email=ehgowjd1@gmail.com', 'commit', '-q', '-m', `chore: event image readings ${day} (${n} events)`);
    try {
      git('push', '-q', 'origin', 'HEAD:master');
      console.log(`PUBLISHED ${n} event readings (attempt ${attempt})`);
      process.exit(0);
    } catch (e) {
      console.log(`push rejected (attempt ${attempt}), retrying from the new origin/master…`);
    }
  }
  console.error('push failed 5 times');
  process.exit(1);
} else {
  console.error('usage: node scripts/image-reads-sync.mjs prepare <outDir> | publish <results.json>');
  process.exit(1);
}
