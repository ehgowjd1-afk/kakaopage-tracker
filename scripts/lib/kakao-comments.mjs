// Kakao Page comment + episode-list API helpers (BFF, works from Node — no browser).
// Reverse-engineered 2026-10-07; see memory note kakao-page-bff-api for the gotchas:
//   - comment list is POST form-urlencoded with `seriesid` / `singleid` / `sort_opt`
//   - `size` must be sent or the server ignores `page` (always returns the first 25)
//   - per-episode (`singleid`) lists only advance via the like/uid cursor, and the
//     server caches by page number without the cursor -> use a fresh page number
//     on every cursor request.
const BFF = 'https://bff-page.kakao.com/api/gateway';
const HEADERS = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); } catch (e) { if (attempt === 2) throw e; await sleep(800 * (attempt + 1)); }
  }
  return null;
}

async function postComments(params) {
  return withRetry(async () => {
    const r = await fetch(`${BFF}/api/v8/store/community/list/comment`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`comment HTTP ${r.status}`);
    const j = await r.json();
    if (j.result_code !== 0) throw new Error(`comment code ${j.result_code} ${j.message}`);
    return j;
  });
}

// Normalise one raw comment to a compact record.
function slim(c) {
  return {
    uid: c.comment_uid,
    user: c.user_name || '',   // there's no author flag; compare with the work's author name
    text: c.comment || '',
    likes: c.like_count || 0,
    replies: c.reply_count || 0,
    productId: c.single_id || null,
    episodeTitle: c.title || '',
    at: c.create_dt || '',
    best: !!c.is_best,
    spoiler: !!(c.is_spoiler || c.spoiler === 'Y'),
  };
}

// Most-liked comments (whole series, or one episode with `singleid`).
// The server ignores `page` for paging — page 0, 1, 2 all return the first page
// (re-checked 2026-10-07) — and only advances with the like/uid cursor of the
// last comment. It also caches responses by page number WITHOUT the cursor, so
// every request gets a never-used page number (also keeps counts fresh).
let bust = (Date.now() % 1e6) * 10;
async function topComments(base, max, gap) {
  const out = [];
  let total = null;
  let last = null;
  const seen = new Set();
  while (out.length < max) {
    const size = Math.min(100, max - out.length);
    const params = { ...base, sort_opt: 'like', size: String(size), page: String(++bust) };
    if (last) {
      params.last_comment_uid = String(last.comment_uid);
      params.last_like_count = String(last.like_count);
    }
    const j = await postComments(params);
    total = j.total_count ?? total;
    const list = (j.comment_list || []).filter((c) => !seen.has(c.comment_uid));
    list.forEach((c) => seen.add(c.comment_uid));
    out.push(...list.map(slim));
    if (!list.length || j.is_end) break;
    last = list[list.length - 1];
    await sleep(gap);
  }
  return { total, comments: out };
}
export const seriesTopComments = (seriesId, max = 100, { gap = 250 } = {}) =>
  topComments({ seriesid: String(seriesId) }, max, gap);
export const episodeTopComments = (seriesId, productId, max = 10, { gap = 250 } = {}) =>
  topComments({ seriesid: String(seriesId), singleid: String(productId) }, max, gap);

// Every episode of a series, in reading order (1화 first).
// product/list walks newest-first (NEXT cursor from 0; INIT misbehaves), and the
// cursor index counts from the newest, so order by the item's `order_value`
// (= the episode's position, e.g. 407 for 407화).
export async function listEpisodes(seriesId, { gap = 250 } = {}) {
  const eps = [];
  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams({ series_id: String(seriesId), cursor_index: String(cursor), cursor_direction: 'NEXT', window_size: '100' });
    const j = await withRetry(async () => {
      const r = await fetch(`${BFF}/api/v2/content/product/list?${q}`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`product/list HTTP ${r.status}`);
      return r.json();
    });
    const list = (j && j.result && j.result.list) || [];
    for (const x of list) {
      const it = x.item || {};
      if (!it.product_id || seen.has(it.product_id)) continue;
      seen.add(it.product_id);
      eps.push({ productId: it.product_id, order: it.order_value ?? null, title: it.title || '', free: !!it.is_free, at: it.start_sale_dt || '', ci: x.cursor_index });
    }
    if (!list.length || !(j.result && j.result.has_next)) break;
    cursor = list[list.length - 1].cursor_index;
    await sleep(gap);
  }
  // reading order; fall back to the (newest-first) cursor index if order_value is missing
  const byOrder = eps.every((e) => e.order != null);
  eps.sort((a, b) => (byOrder ? a.order - b.order : b.ci - a.ci));
  return eps.map(({ ci, ...e }, i) => ({ ...e, order: byOrder ? e.order : i + 1 }));
}

// "괴담에 … 208화(1부 완결)" -> "208화(1부 완결)"; falls back to the raw title.
// Spacing differs between series and episode titles ("달빛조각사" vs "달빛 조각사 (1187): 48권"),
// so the series-title prefix is matched ignoring whitespace.
// Episode titles of "[19세 완전판]" editions omit that suffix, so the bare title is tried too.
export function episodeLabel(episodeTitle, seriesTitle) {
  const t = (episodeTitle || '').trim();
  if (!t) return '';
  const full = seriesTitle || '';
  for (const cand of [full, full.replace(/\s*\[[^\]]*\]\s*$/, '')]) {
    const s = cand.replace(/\s+/g, '');
    if (!s) continue;
    let i = 0;
    let j = 0;
    while (i < t.length && j < s.length) {
      if (/\s/.test(t[i])) { i++; continue; }
      if (t[i] !== s[j]) break;
      i++; j++;
    }
    if (j === s.length) {
      const rest = t.slice(i).replace(/^[\s:：\-–—]+/, '').trim();
      // old e-book style "(1187): 48권" -> "1187화 · 48권"
      const vol = rest.match(/^\((\d+)\)\s*:?\s*(.*)$/);
      if (vol) return vol[2] ? `${vol[1]}화 · ${vol[2]}` : `${vol[1]}화`;
      if (rest) return rest;
    }
  }
  const m = t.match(/(\d+\s*화.*|외전.*|프롤로그.*|에필로그.*|특별.*)$/);
  return m ? m[1].trim() : t;
}
