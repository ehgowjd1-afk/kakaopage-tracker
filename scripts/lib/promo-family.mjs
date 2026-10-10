// Sort a promotion banner (from a work's 소식 tab) into one of four families,
// from its title and how many works carry it on one day (reach).
//   benefit  = 무료·혜택      free episodes, 기다무/3다무, cash, tickets
//   event    = 작품 이벤트    the work's own event: launch, completion, milestones,
//                             and the many 2-week landing pages named after the work
//   curation = 기획전·추천    themed collections / recommendation slots (exposure)
//   platform = 플랫폼 이벤트  site-wide games many works share (스탬프 투어 …);
//                             listed but not shaded, since every participant gets it
// Order matters: a title can match several lists (e.g. '초신작 보면 캐시선물'
// is a reward for reading, so 혜택 wins over 초신작 curation).
const PLATFORM = /스탬프|퀘스트|퀴즈|랜덤 ?플레이|하드모드|여의주|웹덕이|한글왕|행운 필요|하트를 받|월초팩|한복핏|공모전|가챠|키우기|출석|룰렛/;
const BENEFIT = /무료|다무|캐시|이용권|증량|보너스|장학금|선물|\d+\s*시간만|쿠폰|할인|페이백|대여권|열람권|포인트|적립|딜$|딜!/;
const EVENT = /론칭|오픈런|완결|외전|시즌|연참|복귀|컴백|돌아옴|돌아왔|애니|방영|드라마|영화|억\s*뷰|만\s*뷰|밀페|달성|돌파|기념|특전|이벤트|EVENT|NEW RELEASE|TIMETABLE|공개|휴재/i;
const CURATION = /기획전|셀렉트|모음|추천|명작|초신작|신작|루키|ZONE|작가전|몰아보기|정주행|어때요|취향|급상승|Top-Tier|PICK|픽|유니버스|zip|컬렉션|DAYS|스테디|인기|열차|볼까|찾아드림|필독|모아|특집/i;

export function promoFamily(title, reach = 1) {
  const t = String(title || '');
  if (PLATFORM.test(t)) return 'platform';
  if (BENEFIT.test(t)) return 'benefit';
  if (EVENT.test(t)) return 'event';
  if (CURATION.test(t)) return 'curation';
  // No keyword: a banner only this work (or its other format) carries is almost
  // always its own 2-week event page titled with the work name.
  return reach <= 3 ? 'event' : 'curation';
}
