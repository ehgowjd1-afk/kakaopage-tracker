// Detail fields for one series from Kakao Page's own BFF API, in the same shape
// scrapeWorkDetail() returns. Used for 19+ works: their page shows publisher,
// keywords, classification and status only after an adult-verified login, but
// content/overview + content/about answer anonymously with the 19+ edition's
// own values (checked 2026-10-10: same publisher/keywords/classification/launch
// format the page shows for ordinary works). No login, no gate bypass.
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HEADERS = { Origin: 'https://page.kakao.com', Referer: 'https://page.kakao.com/', 'User-Agent': UA };
const BASE = 'https://bff-page.kakao.com/api/gateway/api/v1/content';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Kakao-style rounded count as the page shows it: 1,676.7만 · 4.6억 · 8,812
function kakaoCount(n) {
  if (!Number.isFinite(n)) return null;
  const one = (x) => (Math.floor(x * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (n >= 1e8) return `${one(n / 1e8)}억`;
  if (n >= 1e4) return `${one(n / 1e4)}만`;
  return n.toLocaleString('en-US');
}

export async function fetchBffDetail(seriesId) {
  const ov = await getJson(`${BASE}/overview?series_id=${seriesId}`);
  await sleep(300);
  const ab = await getJson(`${BASE}/about?series_id=${seriesId}`);
  const c = (ov.result && ov.result.content) || {};
  const a = ab.result || {};
  const det = a.detail || {};
  const sp = c.service_property || {};
  const onIssue = c.on_issue === 'Y' ? true : c.on_issue === 'N' ? false : null;
  return {
    author: c.authors || (a.author_list || []).map((x) => x.name).join(',') || null,
    publisher: [det.publisher_name, det.publisher_operation_label].filter(Boolean).join(' / ') || null,
    ageRatingDetail: c.age_grade === 0 ? '전체이용가' : Number.isFinite(c.age_grade) ? `${c.age_grade}세이용가` : null,
    price: det.retail_price || null,
    classification: (det.category_list || []).length ? det.category_list.join(' / ') : [c.category, c.sub_category].filter(Boolean).join(' / ') || null,
    serialStatus: onIssue === false ? '완결' : onIssue ? (c.pub_period ? `${c.pub_period} 연재` : '연재중') : null,
    isCompleted: onIssue === null ? null : !onIssue,
    synopsis: a.description || c.description || null,
    keywords: (a.theme_keyword_list || []).map((k) => k.title).filter(Boolean),
    viewCount: kakaoCount(sp.view_count),
    rating: sp.rating_count ? (sp.rating_sum / sp.rating_count).toFixed(1) : null,
    totalCommentText: Number.isFinite(sp.comment_count) ? sp.comment_count.toLocaleString('en-US') : null,
    launchDate: c.start_sale_dt ? String(c.start_sale_dt).slice(0, 10) : null,
    sameWorkVersions: (a.same_series_list || []).map((s) => ({
      workId: String(s.series_id), title: s.title || null, category: s.category || null, subCategory: s.sub_category || null,
    })),
    detailSource: 'bff',
  };
}

// The page came back without its detail block (adult gate, or a failed load).
export function isGated(detail) {
  return !detail || (!detail.publisher && !(detail.keywords || []).length && !detail.classification);
}

// Keep what the page gave; fill only what's missing.
export function fillGaps(detail, bff) {
  const out = { ...(detail || {}) };
  for (const [k, v] of Object.entries(bff)) {
    const cur = out[k];
    const empty = cur === undefined || cur === null || cur === '' || (Array.isArray(cur) && !cur.length);
    if (empty && v !== null && v !== undefined && !(Array.isArray(v) && !v.length)) out[k] = v;
  }
  return out;
}
