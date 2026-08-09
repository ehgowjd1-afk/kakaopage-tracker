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

export function buildListUrl(categoryKey, period) {
  const cat = CATEGORIES[categoryKey];
  return `https://page.kakao.com/landing/ranking/${cat.id}/?ranking_type=${period}`;
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

export { sleep };
