/* 카카오페이지 회차 댓글 표본 수집 (로그인 없이) — 반복 반응 분석(cmt_pilot.mjs)용
 *
 * 작품 정보: bff content/overview (제목·소개·웹툰/웹소설·장르·작가)
 * 회차 목록: bff content/product/list (최신부터 오고 order_value가 화 순서)
 * 댓글:     bff store/community/list/comment (POST form) — 회차(singleid)별 좋아요순·최신순
 *   - 좋아요순은 공감 1개 이상인 댓글만 나오고, 0공감 댓글은 최신순으로만 받을 수 있다
 *   - 페이지는 커서로만 넘어가고, 서버가 커서를 뺀 키로 캐시하므로 요청마다 처음 쓰는 page 번호를 붙인다
 *     (자세한 내용: 메모 kakao-page-bff-api)
 * 개인정보: 닉네임은 작가 본인 공지 댓글을 거르는 데만 쓰고 바로 버린다 — 내용·시각·좋아요만 남김.
 * 사이트 부담: 요청 사이 최소 2초, 429/503이 3번 나오면 멈춘다.
 */
const BFF = 'https://bff-page.kakao.com/api/gateway';
const H = {
  Origin: 'https://page.kakao.com',
  Referer: 'https://page.kakao.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Accept: 'application/json, text/plain, */*',
};
export const GAP_MS = 2000;

export class KakaoBlocked extends Error {}
// 글자 수로 자르기 — 이모지(두 칸짜리 글자)를 반쪽으로 자르면 AI 요청이 거절된다
export const cut = (s, n) => Array.from(String(s ?? '')).slice(0, n).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;
let n429 = 0;
export let requests = 0;

async function call(url, init = {}) {
  for (let tries = 0; ; tries++) {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    requests++;
    let r;
    try { r = await fetch(url, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(30000) }); }
    catch (e) { if (tries < 2) { await sleep(5000); continue; } throw e; }
    if (r.status === 429 || r.status === 503) {
      if (++n429 >= 3) throw new KakaoBlocked('카카오가 요청을 막았습니다 (' + r.status + ')');
      await sleep(30000 * (tries + 1));
      continue;
    }
    if (!r.ok) {
      if (r.status >= 500 && tries < 2) { await sleep(5000); continue; }
      throw new Error(`HTTP ${r.status} ${url}`);
    }
    return r.json();
  }
}

let bust = (Date.now() % 1e6) * 10;
async function commentPage(params) {
  const j = await call(`${BFF}/api/v8/store/community/list/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, page: String(++bust) }).toString(),
  });
  if (j.result_code !== 0) throw new Error(`댓글 응답 오류 ${j.result_code} ${j.message || ''}`);
  return j;
}

// 회차 제목 → 화 번호 ("… 37화" → 37, "프롤로그" → 0). 트레일러·예고·공지·휴재·후기·인사말·외전·번외는 null —
// order_value는 이런 상품도 세므로 정렬에만 쓴다 (예: SSS급 죽어야 사는 헌터는 1번이 '트레일러 영상').
export function epNo(title) {
  const t = String(title || '');
  if (/트레일러|예고|공지|휴재|후기|인사말|외전|번외|특별편/.test(t)) return null;
  const m = t.match(/(\d+)\s*화(?!.*\d+\s*화)/);
  if (m) return Number(m[1]);
  if (/프롤로그/.test(t)) return 0;
  return null;
}

// 작가 본인뿐 아니라 그림·각색 작가·출판사도 다른 닉네임으로 인사를 남긴다 — collect-comments.mjs 와 같은 기준
const AUTHOR_NOTE = /작가입니다|글쓴이\s?\S{1,12}입니다|(작화|각색|글|그림|채색|콘티|선화)\s?(파트|부분)?[을를]?\s?(담당|맡)|맡은\s?\S{1,12}입니다|출간한\s?\S{1,20}입니다|출판사입니다|편집(부|자)입니다|(미디어|출판|스튜디오|에이전시|엔터|컴퍼니|담당자)\S{0,3}입니다/;
// 카카오는 이모티콘을 본문에 '(이모티콘)' 자리표시로 남긴다 — 빼고, 이모티콘만 단 댓글은 빈 글이 되어 표본에서 빠진다
const clean = (s) => String(s || '').replace(/\(이모티콘\)/g, ' ').replace(/\s+/g, ' ').trim();

// 작품 정보 + 회차 목록(1화부터)
export async function fetchWork(id) {
  const ov = await call(`${BFF}/api/v1/content/overview?series_id=${id}`);
  const c = (ov.result && ov.result.content) || {};
  const episodes = [];
  const seen = new Set();
  let cursor = 0;
  let truncated = false;
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams({ series_id: String(id), cursor_index: String(cursor), cursor_direction: 'NEXT', window_size: '100' });
    const j = await call(`${BFF}/api/v2/content/product/list?${q}`);
    const list = (j.result && j.result.list) || [];
    for (const x of list) {
      const it = x.item || {};
      if (!it.product_id || seen.has(it.product_id)) continue;
      seen.add(it.product_id);
      episodes.push({ id: String(it.product_id), order: it.order_value ?? null, no: epNo(it.title), title: it.title || '', reg: it.start_sale_dt || '' });
    }
    if (!list.length || !(j.result && j.result.has_next)) break;
    cursor = list[list.length - 1].cursor_index;
    if (i === 99) truncated = true;   // 최신부터 오므로, 여기서 끊기면 가장 오래된(초반) 회차가 빠진다
  }
  episodes.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    id: String(id),
    title: c.title || String(id),
    webtoon: c.category === '웹툰',
    bl: c.sub_category === 'BL',
    genre: c.sub_category || '',
    desc: cut(String(c.description || '').replace(/\s+/g, ' ').trim(), 400),
    authors: String(c.authors || '').split(/[,/]/).map((s) => s.trim()).filter(Boolean),
    episodes,
    truncated,
  };
}

// 한 회차의 표본 재료: 좋아요순 1쪽(최대 100) + 최신순 몇 쪽(최대 poolPages×100).
// 작가 본인 댓글(닉네임 = 작가 이름)은 빼고, 닉네임은 남기지 않는다.
export async function fetchEpisodeComments(seriesId, productId, authors, poolPages) {
  const base = { seriesid: String(seriesId), singleid: String(productId), size: '100' };
  const isAuthor = (c) => authors.includes(String(c.user_name || '').trim()) || AUTHOR_NOTE.test(c.comment || '');
  const keep = (c) => ({
    cid: c.comment_uid,
    text: clean(c.comment),
    at: c.create_dt || '',
    like: c.like_count | 0,
    best: !!c.is_best,
    sp: !!(c.is_spoiler || c.spoiler === 'Y'),
    rc: c.reply_count | 0,
  });
  const liked = await commentPage({ ...base, sort_opt: 'like' });
  const total = Number(liked.total_count) || 0;
  const likeList = (liked.comment_list || []).filter((c) => !isAuthor(c)).map(keep);
  const pool = [];
  const seen = new Set(likeList.map((c) => c.cid));
  let last = null;
  for (let p = 0; p < poolPages; p++) {
    // 최신순은 마지막 댓글 uid만으로 다음 쪽이 넘어간다 (2026-10-10 확인: last_created_dt에
    // create_dt 원래 값을 넣으면 400, 빼면 정상)
    const params = { ...base, sort_opt: 'latest' };
    if (last) params.last_comment_uid = String(last.comment_uid);
    const j = await commentPage(params);
    const list = j.comment_list || [];
    for (const c of list) if (!seen.has(c.comment_uid) && !isAuthor(c)) { seen.add(c.comment_uid); pool.push(keep(c)); }
    if (!list.length || j.is_end) return { total, likeList, pool, complete: true };
    last = list[list.length - 1];
  }
  return { total, likeList, pool, complete: false };
}
