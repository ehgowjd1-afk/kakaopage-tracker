export const CATEGORIES = {
  webnovel: {
    id: 11,
    label: '웹소설',
  },
  webtoon: {
    id: 10,
    label: '웹툰',
  },
};

export const PERIODS = ['daily', 'weekly', 'monthly'];

export const GENRES = {
  webnovel: {
    fantasy: { id: 86, label: '판타지' },
    hyunpan: { id: 120, label: '현판' },
    romance: { id: 89, label: '로맨스' },
    romfantasy: { id: 117, label: '로판' },
    wuxia: { id: 87, label: '무협' },
    bl: { id: 123, label: 'BL' },
  },
  webtoon: {
    fantasy: { id: 115, label: '판타지' },
    drama: { id: 116, label: '드라마' },
    romance: { id: 121, label: '로맨스' },
    romfantasy: { id: 69, label: '로판' },
    wuxia: { id: 112, label: '무협' },
    action: { id: 122, label: '액션' },
    bl: { id: 119, label: 'BL' },
  },
};

export const NEW_RELEASES_SCREENS = {
  webnovel: 101,
  webtoon: 53,
};

export function buildNewReleasesUrl(categoryKey) {
  const catId = CATEGORIES[categoryKey].id === 11 ? 10011 : 10010;
  return `https://page.kakao.com/menu/${catId}/screen/${NEW_RELEASES_SCREENS[categoryKey]}/`;
}

// event landing sub-tabs: 0 = 전체(all), 11 = webnovel, 10 = webtoon
export const EVENT_TABS = { all: 0, webnovel: 11, webtoon: 10 };

export function buildEventsUrl(eventTab) {
  return `https://page.kakao.com/landing/event/${EVENT_TABS[eventTab]}/`;
}

// Convert a Kakao banner's app-only deep link into a browser-openable web URL.
//   kakaopage://open/landing/series/list?reference=page%2Flanding%2F18461
//     -> https://page.kakao.com/landing/series/list/page/landing/18461/
//   kakaopage://open/webview/event/...?hash_uid=abcd
//     -> https://page.kakao.com/open/webview/event/?hash_uid=abcd
export function toEventWebLink(link) {
  if (!link) return null;
  if (link.startsWith('http')) return link;
  if (link.startsWith('kakaopage://')) {
    const hash = link.match(/hash_uid=([a-f0-9]+)/);
    if (hash) return `https://page.kakao.com/open/webview/event/?hash_uid=${hash[1]}`;
    const ref = link.match(/reference=([^&]+)/);
    if (ref) {
      const decoded = decodeURIComponent(ref[1]); // e.g. page/landing/18461
      const pathMatch = link.match(/^kakaopage:\/\/open\/([^?]+)/);
      const path = pathMatch ? pathMatch[1].replace(/\/+$/, '') : 'landing/series/list';
      return `https://page.kakao.com/${path}/${decoded}/`;
    }
  }
  return link;
}

// Merge today's scraped events into an accumulating history keyed by bannerUid.
// Each entry keeps firstSeen/lastSeen so the frontend can tell 진행중 (lastSeen == today)
// from 완료 (disappeared from the listing on an earlier day).
export function mergeEventHistory(history, events, today) {
  const byId = new Map(history.map((e) => [e.bannerUid, e]));
  for (const ev of events) {
    if (!ev.bannerUid) continue;
    const existing = byId.get(ev.bannerUid);
    if (existing) {
      existing.lastSeen = today;
      existing.title = ev.title;
      existing.subtitle = ev.subtitle;
      existing.thumbnail = ev.thumbnail;
      existing.link = ev.link;
    } else {
      byId.set(ev.bannerUid, { ...ev, firstSeen: today, lastSeen: today });
    }
  }
  return [...byId.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || (b.firstSeen || '').localeCompare(a.firstSeen || ''));
}

export async function scrapeEvents(page, url, { log = () => {} } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  let lastH = 0;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) stable += 1;
    else stable = 0;
    lastH = h;
    if (stable >= 5) break;
  }

  const events = await page.evaluate(() => {
    const banners = Array.from(document.querySelectorAll('[data-t-obj*="banner_uid"]'));
    const results = [];
    const seen = new Set();
    for (const b of banners) {
      let link = null;
      let bannerUid = null;
      try {
        const obj = JSON.parse(b.getAttribute('data-t-obj'));
        link = obj.eventMeta && obj.eventMeta.id;
        bannerUid = obj.customProps && obj.customProps.banner_uid;
      } catch {
        // ignore
      }
      if (bannerUid && seen.has(bannerUid)) continue;
      if (bannerUid) seen.add(bannerUid);

      const img = b.querySelector('img[alt="썸네일"]');
      const titleEl = b.querySelector('[class*="line-clamp-3"]');
      const subEl = b.querySelector('.line-clamp-1');

      // keep the raw link here; normalize to a web URL in Node scope below
      // (this callback runs in the browser, where toEventWebLink doesn't exist)
      results.push({
        bannerUid,
        title: titleEl ? titleEl.textContent.trim() : (b.getAttribute('aria-label') || null),
        subtitle: subEl ? subEl.textContent.trim() : null,
        thumbnail: img ? img.src : null,
        link,
      });
    }
    return results;
  });

  for (const e of events) e.link = toEventWebLink(e.link);
  log(`  → loaded ${events.length} events`);
  return events;
}

export function buildListUrl(categoryKey, period, genreId) {
  const cat = CATEGORIES[categoryKey];
  const genrePath = genreId ? `/${genreId}` : '';
  return `https://page.kakao.com/landing/ranking/${cat.id}${genrePath}/?ranking_type=${period}`;
}

export function buildDetailUrl(workId) {
  return `https://page.kakao.com/content/${workId}/?tab_type=about`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeRankingList(page, url, { targetCount = 300, log = () => {} } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  let prevMax = -1;
  let stableRounds = 0;
  for (let i = 0; i < 150; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);
    const curMax = await page.evaluate(() => {
      const nums = Array.from(document.querySelectorAll('.font-small2-bold.flex-1'))
        .map((el) => parseInt(el.textContent.trim(), 10))
        .filter((n) => !Number.isNaN(n));
      return nums.length ? Math.max(...nums) : 0;
    });
    if (curMax === prevMax) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }
    prevMax = curMax;
    if (stableRounds >= 4 || curMax >= targetCount) break;
  }
  log(`  → loaded ${prevMax} items`);

  const items = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a[href^="/content/"]'));
    const results = [];
    for (const a of cards) {
      const badgeDiv = a.querySelector('.font-small2-bold.flex-1');
      if (!badgeDiv) continue;
      const rank = parseInt(badgeDiv.textContent.trim(), 10);
      if (Number.isNaN(rank)) continue;

      const workIdMatch = a.getAttribute('href').match(/\/content\/(\d+)/);
      const workId = workIdMatch ? workIdMatch[1] : null;

      const thumbEl = a.querySelector('img[alt="썸네일"]');
      const thumbnail = thumbEl ? thumbEl.src : null;

      const badgeWrap = badgeDiv.closest('.flex.w-68pxr');
      const changeImg = badgeWrap ? badgeWrap.querySelector('img') : null;
      const changeAmountEl = badgeWrap ? badgeWrap.querySelector('div:last-child') : null;
      const changeAlt = changeImg ? changeImg.alt : null;
      let changeType = 'same';
      if (changeAlt === '위 화살표') changeType = 'up';
      else if (changeAlt === '아래 화살표') changeType = 'down';
      else if (changeAlt === 'NEW') changeType = 'new';
      const changeAmountText = changeAmountEl ? changeAmountEl.textContent.trim() : '';
      const changeAmount = changeAmountText ? parseInt(changeAmountText, 10) : null;

      const waitFreeImg = a.querySelector('img[alt="기다무 뱃지"], img[alt="3다무 뱃지"]');
      const waitFree = !!waitFreeImg;
      const waitFreeType = waitFreeImg ? waitFreeImg.alt.replace(' 뱃지', '') : null;

      const ageImg = a.querySelector('img[alt$="세 뱃지"]');
      const ageRating = ageImg ? ageImg.alt.replace(' 뱃지', '') : null;

      const isNewRelease = !!a.querySelector('img[alt="신작 뱃지"]');
      const hasNewEpisode = !!a.querySelector('img[alt="새 회차 뱃지"]');

      let title = null;
      let category = null;
      let subCategory = null;
      const metaEl = a.querySelector('div[aria-label^="작품,"][data-t-obj]');
      if (metaEl) {
        try {
          const obj = JSON.parse(metaEl.getAttribute('data-t-obj'));
          title = obj.eventMeta?.name ?? null;
          category = obj.eventMeta?.category ?? null;
          subCategory = obj.eventMeta?.subcategory ?? null;
        } catch {
          // ignore malformed json
        }
      }
      if (!title) {
        const titleEl = a.querySelector('.line-clamp-2, .line-clamp-1');
        title = titleEl ? titleEl.textContent.trim() : null;
      }

      results.push({
        rank,
        workId,
        title,
        thumbnail,
        category,
        subCategory,
        waitFree,
        waitFreeType,
        ageRating,
        isNewRelease,
        hasNewEpisode,
        change: { type: changeType, amount: changeAmount },
      });
    }
    results.sort((a, b) => a.rank - b.rank);
    return results;
  });

  return items;
}

export async function scrapeWorkDetail(page, workId, { log = () => {} } = {}) {
  const url = buildDetailUrl(workId);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
  } catch (err) {
    log(`  ! failed to load detail for ${workId}: ${err.message}`);
    return null;
  }

  const detail = await page.evaluate(() => {
    function findLabelValue(label) {
      const spans = Array.from(document.querySelectorAll('span'));
      const labelSpan = spans.find((s) => s.textContent.trim() === label && s.className.includes('w-62pxr'));
      if (!labelSpan) return null;
      const row = labelSpan.parentElement;
      const valueParts = Array.from(row.querySelectorAll('span.break-all'));
      if (valueParts.length) return valueParts.map((s) => s.textContent.trim()).join(' / ');
      const clone = row.cloneNode(true);
      clone.removeChild(clone.firstChild);
      return clone.textContent.trim();
    }

    const statusEls = Array.from(document.querySelectorAll('body *')).filter(
      (el) =>
        el.children.length === 0 &&
        /(연재|완결|휴재)/.test(el.textContent.trim()) &&
        el.textContent.trim().length < 15
    );
    const statusText = statusEls.length ? statusEls[0].textContent.trim() : null;

    const synopsisEl = document.querySelector('span.whitespace-pre-wrap');
    const synopsis = synopsisEl ? synopsisEl.textContent.trim() : null;

    const keywordEls = Array.from(document.querySelectorAll('a[href^="/search/themekeyword/"]'));
    const keywords = keywordEls
      .map((el) => {
        try {
          const obj = JSON.parse(el.getAttribute('data-t-obj'));
          return obj.click?.copy ?? null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    let viewCount = null;
    let rating = null;
    const statContainer = document.querySelector('div[class*="all-child:font-small2"]');
    if (statContainer) {
      const parts = Array.from(statContainer.children).map((c) => c.textContent.trim());
      for (const p of parts) {
        if (/[억만천]/.test(p) && /\d/.test(p)) viewCount = p;
        else if (/^\d+(\.\d+)?$/.test(p)) rating = p;
      }
    }

    let sameWorkVersions = [];
    const sameWorkHeader = Array.from(document.querySelectorAll('body *')).find(
      (el) => el.children.length === 0 && el.textContent.trim() === '동일작'
    );
    const sameWorkCard = sameWorkHeader ? sameWorkHeader.closest('.rounded-12pxr') : null;
    if (sameWorkCard) {
      sameWorkVersions = Array.from(sameWorkCard.querySelectorAll('a[href^="/content/"]'))
        .map((a) => {
          const metaEl = a.querySelector('div[aria-label^="작품,"][data-t-obj]');
          if (!metaEl) return null;
          try {
            const obj = JSON.parse(metaEl.getAttribute('data-t-obj'));
            const idMatch = a.getAttribute('href').match(/\/content\/(\d+)/);
            return {
              workId: idMatch ? idMatch[1] : null,
              title: obj.eventMeta?.name ?? null,
              category: obj.eventMeta?.category ?? null,
              subCategory: obj.eventMeta?.subcategory ?? null,
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    return {
      author: findLabelValue('글') || findLabelValue('글/그림') || findLabelValue('원작'),
      publisher: findLabelValue('발행자'),
      ageRatingDetail: findLabelValue('연령등급'),
      price: findLabelValue('전자책 정가'),
      classification: findLabelValue('분류'),
      serialStatus: statusText,
      isCompleted: statusText ? statusText.includes('완결') : null,
      synopsis,
      keywords,
      viewCount,
      rating,
      sameWorkVersions,
    };
  });

  return detail;
}

const STOPWORDS = new Set([
  '그리고', '그런데', '그래서', '하지만', '진짜', '너무', '정말', '그냥', '이건', '저는',
  '이거', '그거', '저거', '이제', '아니', '나는', '우리', '근데', '이렇게', '그렇게',
  '어떻게', '아직', '역시', '이미', '완전', '제발', '이번', '다음', '있는', '없는',
  '같은', '한테', '에서', '으로', '까지', '보다', '한다', '하는', '했다', '되는',
  '되다', '이다', '입니다', '합니다', '했어요', '이에요', '예요', '해요', '네요',
]);

function extractKeywords(texts, topN = 8) {
  const freq = new Map();
  for (const text of texts) {
    if (!text) continue;
    const tokens = text.match(/[가-힣a-zA-Z0-9]{2,}/g) || [];
    for (const token of tokens) {
      if (STOPWORDS.has(token)) continue;
      freq.set(token, (freq.get(token) || 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

export async function scrapeComments(page, workId, { maxScrolls = 5, log = () => {} } = {}) {
  const url = `https://page.kakao.com/content/${workId}/?tab_type=comment`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
  } catch (err) {
    log(`  ! failed to load comments for ${workId}: ${err.message}`);
    return null;
  }

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(350);
  }

  const result = await page.evaluate(() => {
    const totalEl = Array.from(document.querySelectorAll('body *')).find(
      (el) => el.children.length === 0 && /^전체\s*[\d,.]+[만억천]?$/.test(el.textContent.trim())
    );
    const totalText = totalEl ? totalEl.textContent.replace('전체', '').trim() : null;

    const cards = Array.from(document.querySelectorAll('div[data-t-obj*="event_comment_id"]'));
    const comments = cards.map((card) => {
      const author = card.querySelector('.font-small1-bold.line-clamp-1');
      const date = card.querySelector('.font-small2.shrink-0.text-theme-solid-60');
      const text = card.querySelector('.font-medium2.whitespace-pre-wrap');
      const episode = card.querySelector('.font-small2.break-all.text-theme-solid-60.line-clamp-1');
      const likeImg = card.querySelector('img[alt*="좋아요"]');
      const replyImg = card.querySelector('img[alt*="댓글"]');
      const likeText = likeImg ? likeImg.parentElement.querySelector('span')?.textContent.trim() : null;
      const replyText = replyImg ? replyImg.parentElement.querySelector('span')?.textContent.trim() : null;
      return {
        author: author ? author.textContent.trim() : null,
        date: date ? date.textContent.trim() : null,
        text: text ? text.textContent.trim() : null,
        episode: episode ? episode.textContent.trim() : null,
        likeCount: likeText,
        replyCount: replyText,
      };
    });

    return { totalText, comments };
  });

  const keywords = extractKeywords(result.comments.map((c) => c.text));

  return {
    totalCommentText: result.totalText,
    topComments: result.comments.slice(0, 30),
    keywords,
  };
}

function resolveKoreanMonthDay(label, todayKstStr) {
  const today = new Date(`${todayKstStr}T00:00:00Z`);
  if (label === 'TODAY') return todayKstStr;
  const m = label.match(/^(\d{2})월 (\d{2})일$/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  let year = today.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getTime() > today.getTime()) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate.toISOString().slice(0, 10);
}

export async function scrapeNewReleases(page, url, todayKstStr, { log = () => {} } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  let lastH = 0;
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === lastH) stable += 1;
    else stable = 0;
    lastH = h;
    if (stable >= 5) break;
  }

  const raw = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('.font-medium1-bold.text-theme-solid-100, a[href^="/content/"]')
    );
    let currentDateLabel = null;
    const results = [];
    for (const node of nodes) {
      if (node.tagName !== 'A') {
        const t = node.textContent.trim();
        if (t === 'TODAY' || /^\d{2}월 \d{2}일$/.test(t)) currentDateLabel = t;
        continue;
      }
      const metaEl = node.querySelector('[data-t-obj]');
      let title = null;
      let category = null;
      let subCategory = null;
      if (metaEl) {
        try {
          const obj = JSON.parse(metaEl.getAttribute('data-t-obj'));
          title = obj.eventMeta?.name ?? null;
          category = obj.eventMeta?.category ?? null;
          subCategory = obj.eventMeta?.subcategory ?? null;
        } catch {
          // ignore malformed json
        }
      }
      const idMatch = node.getAttribute('href').match(/\/content\/(\d+)/);
      const thumbEl = node.querySelector('img[alt="썸네일"]');
      results.push({
        dateLabel: currentDateLabel,
        workId: idMatch ? idMatch[1] : null,
        title,
        category,
        subCategory,
        thumbnail: thumbEl ? thumbEl.src : null,
      });
    }
    return results;
  });

  log(`  → loaded ${raw.length} new-release items`);

  return raw
    .filter((it) => it.workId)
    .map((it) => ({
      date: resolveKoreanMonthDay(it.dateLabel, todayKstStr),
      workId: it.workId,
      title: it.title,
      category: it.category,
      subCategory: it.subCategory,
      thumbnail: it.thumbnail,
    }));
}

export async function scrapeLaunchDate(page, workId, { log = () => {} } = {}) {
  const url = `https://page.kakao.com/content/${workId}/?tab_type=episode`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
  } catch (err) {
    log(`  ! failed to load episode list for ${workId}: ${err.message}`);
    return null;
  }

  const dateText = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('body *')).find(
      (e) => e.children.length === 0 && /^\d{2}\.\d{2}\.\d{2}$/.test(e.textContent.trim())
    );
    return el ? el.textContent.trim() : null;
  });
  if (!dateText) return null;

  const [yy, mm, dd] = dateText.split('.');
  return `20${yy}-${mm}-${dd}`;
}

// Scrape the promotion banners a work is currently featured in, from its 소식(notice) tab.
// Only banner cards (with banner_uid) are kept; plain notices (연재 안내 등) are ignored.
export async function scrapePromotions(page, workId, { log = () => {} } = {}) {
  const url = `https://page.kakao.com/content/${workId}/?tab_type=notice`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
  } catch (err) {
    log(`  ! failed to load notice tab for ${workId}: ${err.message}`);
    return [];
  }

  const out = await page.evaluate(() => {
    const banners = Array.from(document.querySelectorAll('[data-t-obj*="banner_uid"]'));
    const rows = [];
    const seen = new Set();
    for (const b of banners) {
      let obj = null;
      try {
        obj = JSON.parse(b.getAttribute('data-t-obj'));
      } catch {
        continue;
      }
      const uid = obj?.customProps?.banner_uid || null;
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      const titleEl = b.querySelector('[class*="line-clamp"]');
      // keep the raw link; normalized in Node scope below (browser context here)
      const link = obj?.eventMeta?.id || null;
      rows.push({ bannerUid: uid, title: titleEl ? titleEl.textContent.trim() : null, link });
    }
    return rows;
  });
  return out.map((e) => ({ ...e, link: toEventWebLink(e.link) }));
}

export { sleep };
