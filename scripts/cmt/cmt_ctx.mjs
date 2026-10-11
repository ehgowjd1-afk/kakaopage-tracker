/* 회차 댓글 분석 — AI에 붙여 주는 '공짜 맥락' (카카오 요청·AI 비용 없음, 이미 받은 값으로 코드가 계산)
 *
 * - 휴재·복귀: 회차 공개일 간격이 평소의 4배 이상이고 14일 넘으면 휴재로 본다 (예: SSS급 151→152화 386일).
 *   그 회차가 '휴재 뒤 복귀 첫 화'인지, '이 화 뒤로 휴재(시즌 끝)'인지 알려 준다.
 * - 같은 날 여러 화 공개(출시·복귀 몰아 공개)
 * - 다른 판: 트래커의 sameWorkVersions — 웹툰에 웹소설판이 있으면 '원작 소설 있음', 웹소설에 웹툰판이 있으면 '웹툰판 있음'
 * - 댓글 작성 시점: 회차 공개 뒤 얼마 만에 썼는지(공개 직후 / 1주 안 / 1달 안 / 1년 안 / 1년 넘어 = 늦게 정주행),
 *   휴재 중에 쓴 것인지, 복귀 뒤에 쓴 것인지
 * 사실만 넣는다 — 인물 역할·줄거리처럼 AI가 지어낼 수 있는 것은 넣지 않는다.
 */
const DAY = 86400000;
const day = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T')); return Number.isFinite(t) ? t : null; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// 회차 목록(공개일 있음, 화 순서) → 회차 id마다 { gapBefore, gapAfter, hiatusBefore, hiatusAfter, sameDay }
// 화 번호가 있는 회차만 센다(트레일러·공지·외전은 간격을 흐림). 출시 초반의 간격(미리보기 1화 → 몰아 공개)은 휴재로 보지 않는다.
const LAUNCH_EPS = 3;
export function episodeContext(episodes) {
  const eps = episodes.filter((e) => e.no != null && day(e.reg) != null);
  const gaps = [];
  for (let i = 1; i < eps.length; i++) gaps.push((day(eps[i].reg) - day(eps[i - 1].reg)) / DAY);
  const usual = median(gaps.filter((g) => g >= 0.5)) ?? 7;
  const isHiatus = (g, i) => g != null && i >= LAUNCH_EPS && g >= Math.max(14, usual * 4);
  const out = new Map();
  eps.forEach((e, i) => {
    const before = i > 0 ? (day(e.reg) - day(eps[i - 1].reg)) / DAY : null;
    const after = i < eps.length - 1 ? (day(eps[i + 1].reg) - day(e.reg)) / DAY : null;
    const sameDay = eps.filter((x) => String(x.reg).slice(0, 10) === String(e.reg).slice(0, 10)).length;
    out.set(String(e.id), {
      usual: Math.max(1, Math.round(usual)),
      gapBefore: before == null ? null : Math.round(before),
      gapAfter: after == null ? null : Math.round(after),
      hiatusBefore: isHiatus(before, i),
      hiatusAfter: isHiatus(after, i + 1),
      nextReg: i < eps.length - 1 ? eps[i + 1].reg : null,
      sameDay,
    });
  });
  return out;
}

// 회차 머리말에 붙일 한 줄
export function episodeLine(ec) {
  if (!ec) return '';
  const bits = [`평소 연재 간격 약 ${ec.usual}일`];
  if (ec.hiatusBefore) bits.push(`직전 화 뒤 ${ec.gapBefore}일 휴재 후 복귀한 화`);
  if (ec.hiatusAfter) bits.push(`이 화 다음 ${ec.gapAfter}일 휴재(시즌 끝·휴재 직전 화)`);
  if (ec.sameDay > 1) bits.push(`같은 날 회차 ${ec.sameDay}개 함께 공개`);
  return bits.join(' / ');
}

// 작품 머리말에 붙일 한 줄 (트래커 sameWorkVersions)
export function versionLine(work) {
  const vs = (work.versions || []).filter((v) => !/단행본|이용권/.test(v.title || ''));
  const novel = vs.some((v) => v.category === '웹소설');
  const toon = vs.some((v) => v.category === '웹툰');
  if (work.webtoon && novel) return '원작 웹소설 있음(이 웹툰은 각색판 — 원작 대비 지적은 각색 이야기)';
  if (!work.webtoon && toon) return '웹툰판 있음(웹툰판의 그림·연출·각색 이야기는 이 소설의 만듦새 이야기가 아님 — 같은 줄거리·인물 설계를 탓하면 이 작품 이야기)';
  return '';
}

// 댓글 하나의 작성 시점 표시
export function commentWhen(at, ep, ec) {
  const a = day(at), r = day(ep.reg);
  if (a == null || r == null || a < r) return '';
  // 휴재 직전 화: 다음 화가 나올 때가 지나도 안 나온 동안 = 휴재 중, 복귀 뒤 한 달 안 = 복귀 뒤
  if (ec && ec.hiatusAfter && ec.nextReg) {
    const nx = day(ec.nextReg);
    if (a > nx && a - nx <= 31 * DAY) return '복귀 뒤 작성';
    if (a <= nx && a - r > (ec.usual + 1) * DAY) return '휴재 중 작성';
  }
  const d = (a - r) / DAY;
  if (d < 1) return '공개 직후';
  if (d <= 7) return '1주 안';
  if (d <= 31) return '1달 안';
  if (d <= 365) return '1년 안';
  return '1년 넘어(늦게 정주행)';
}
