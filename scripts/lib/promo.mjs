// Shared helpers for promotion periods (collect-event-details / build-promo-periods).

// One key per Kakao event page, whatever link form points at it:
//   page.kakao.com/open/webview/event/?hash_uid=H · page.kakao.com/event/H → 'h:H'
//   …/landing/series/{list|poster|card}/page/landing/N/ · /page/landing/N  → 'l:N'
//   kakaopage://open/viewer?series_id=S (a banner straight to one work)   → 's:S'
// The 소식-tab banner and the 이벤트-tab banner for the same event have different
// banner_uids but the same page, so this key is what joins them.
export function eventKey(link) {
  let l = String(link || '');
  try { l = decodeURIComponent(l); } catch { /* keep as is */ }
  let m = l.match(/hash_uid=([a-f0-9]{8,})/) || l.match(/\/event\/([a-f0-9]{16,})/);
  if (m) return `h:${m[1]}`;
  m = l.match(/landing\/(\d+)/);
  if (m) return `l:${m[1]}`;
  m = l.match(/series_id=(\d+)/);
  if (m) return `s:${m[1]}`;
  return null;
}

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}

// Four families, from the event's title + subtitle (the 이벤트-tab subtitle is
// usually the benefit: '3다무+캐시!', '최종 완결 기념!', '인생 무협 추천!').
//   benefit  = 무료·혜택      free episodes, 기다무/3다무, cash, discounts, boosting
//   event    = 작품 이벤트    launch / completion / season / 연참 / milestones
//   curation = 기획전·추천    themed collections, recommendation slots (exposure)
//   platform = 플랫폼 참여    site-wide games many works share (스탬프 투어 …);
//                             listed but not shaded, since every participant gets it
// Order matters: a launch event that pays cash for reading counts as 혜택.
const PLATFORM = /스탬프|퀘스트|퀴즈|랜덤 ?플레이|하드모드|여의주|웹덕이|한글왕|행운 필요|하트를 받|월초팩|한복핏|공모전|가챠|키우기|출석|룰렛|\d분 안에/;
const BENEFIT = /무료|다무|캐시|이용권|증량|보너스|장학금|선물|\d+\s*시간만|쿠폰|할인|페이백|대여권|열람권|포인트|적립|한시한편|부스팅|딜$|딜!/;
const EVENT = /론칭|런칭|오픈런|오픈|완결|외전|시즌|연참|복귀|컴백|돌아옴|돌아왔|애니|방영|드라마|영화|억\s*뷰|만\s*뷰|밀페|달성|돌파|기념|특전|단행본|표지|이벤트|EVENT|NEW RELEASE|TIMETABLE|공개|휴재/i;
const CURATION = /기획전|셀렉트|모음|추천|명작|초신작|신작|루키|ZONE|작가전|몰아보기|정주행|어때요|취향|급상승|Top-Tier|PICK|픽|유니버스|zip|컬렉션|DAYS|스테디|인기|열차|볼까|찾아드림|필독|모아|특집|계정/i;

export function promoFamily(text, reach = 1) {
  const t = String(text || '');
  if (PLATFORM.test(t)) return 'platform';
  if (BENEFIT.test(t)) return 'benefit';
  if (EVENT.test(t)) return 'event';
  if (CURATION.test(t)) return 'curation';
  // No keyword: a page only this work (or its other format) is on is almost
  // always its own 2-week event page titled with the work name.
  return reach <= 3 ? 'event' : 'curation';
}
