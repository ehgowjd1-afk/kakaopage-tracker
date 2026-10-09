/* 리디 트래커의 '작품 분석법'(리뷰 분석 엔진 rabsa v8)을 카카오 회차 댓글에 쓰는 어댑터.
 *
 * 리디 리뷰는 '작품 평가'라서 엔진이 요소 없는 감정 표현도 '작품 전체' 평가로 센다.
 * 카카오 회차 댓글은 대부분 그 화를 보며 하는 작중 얘기라 그대로 쓰면
 * "백사헌 입장에서 김솔음 개최악사이코패스같음" 이 '작품 전체 아쉬움'이 된다(2026-10-09 실측).
 * 그래서 엔진은 그대로 두고, 판정을 이렇게 거른다 (opts.keep 훅):
 *   - 작품 전체: 작품을 가리키는 말(작가·작품·전개·이번 화…)이 있거나 '인생작·노잼' 같은 작품 평가어일 때만
 *   - 캐릭터 비판: '매력 없다·캐붕·평면적' 같은 작품 평가이거나 작품을 가리키는 말이 있을 때만,
 *                 아니면 과몰입(캐릭터에게 화냄)으로 따로 센다
 *   - 웃음·눈물·설렘: 몰입 반응 쪽(kreact)에서 세므로 '개그·감정선·로맨스' 같은 작품 평가어일 때만
 *   - 제목에 든 감성어('그 쓰레기가 나였어요'의 쓰레기)와 '유치원·며느리' 같은 낱말은 미리 가린다
 * 결과 = 리디와 같은 '독자들의 공통 의견' 문장 + 요소별 [호평, 아쉬움, 무난, 강한 호평, 강한 불만].
 */
const fs = require('fs');
const path = require('path');
const RABSA = require('./rabsa.cjs');
const KREACT = require('./kreact.cjs');

const ADAPTER_V = '1';   // 걸러내기 규칙을 바꾸면 올릴 것 (수집기가 다시 계산)
const VERSION = `${RABSA.VERSION}k${ADAPTER_V}`;

// 작품을 직접 가리키는 말 ('무협소설·순정만화'처럼 장르를 말할 때의 소설·만화는 빼려고 앞에 한글이 붙으면 제외)
const WORK_REF = /작가|작품|(?<![가-힣])(웹툰|소설|만화)|이번\s?화|이번\s?편|이번\s?회차|매\s?화|전개|스토리|내용|연재|분량|설정|작화|그림|필력|문장|캐붕|결말|완결|원작|각색|정주행|하차|별점|떡밥|개연성|빌드업|서사|연출|채색|대사/;
// '다음 화가 없어서 속상하다'처럼 더 보고 싶어서 하는 투정은 불만이 아니라 애정
const WANT_MORE = /다음\s?화|다음화|다음\s?편|담편|빨리\s?(보고|올려|다음)|기다리|기다려/;
// 오타 지적은 '많다·거슬린다' 같은 불평일 때만 (그냥 "오타 있어요" 제보·팬 공지의 '오타 있을 수 있음'은 뺀다)
const TYPO_COMPLAINT = /많|너무|자꾸|신경|거슬|검수|투성|심하|좀\s?고쳐/;
// 요소 없이 써도 작품 평가인 말
const WHOLE_WORK = /인생작|명작|갓작|띵작|수작|대작|걸작|졸작|망작|양산형|노잼|꿀잼|존잼|핵잼|재미없|재미가\s?없|하차|믿고\s?보는|최애\s?작/;
// 캐릭터 비판이 작품 평가인 경우
const CHAR_EVAL = /매력\s?(이\s?)?(없|0|제로|떨어)|무매력|평면적|입체적|캐붕|캐릭터\s?(붕괴|설정)|(작가|글)[이가]?\s?(캐릭|인물)/;
// 몰입 반응과 겹치는 요소는 이 말일 때만 작품 평가로 센다
const EVAL_KW = {
  humor: /개그|유머|드립|말장난|병맛|코믹|코미디/,
  emotion: /감정선|분위기|감성|여운|신파|잔잔|담백|울림/,
  romance: /로맨스|러브|연애|썸|순애/,
};
// 감성어를 품은 보통 낱말 ('내구도'의 구도, '번역하면'의 역하, 'lv별로'의 별로, '오타쿠'의 오타…)
const COMPOUND_MASK = /유치원|며느리|비웃|내구도|번역하|오타쿠|고대\s?비문|무서운|무서워|무서웠|(?<=[A-Za-z0-9가-힣])별로/g;
// 스토리 요소 낱말 중 작중 상황에도 늘 쓰는 말: 작품을 가리키는 말이 같이 있어야 전개 평가로 본다
// ("르벨린 머리채 잡고 잘 사는 거 답답하다" = 작중 분노, "요즘 전개 고구마" = 전개 평가)
const STORY_REACTION_KW = /^(답답|고구마|속터|급발진|삽질|질질|사이다|속시원)/;
// 등장인물이 지루해하는 장면 묘사
const NARRATED_BORED = /지루해\s?하|지루하다고|지루하대|지루했대/;

const blank = (s) => ' '.repeat(s.length);

// 엔진에 넣기 전 댓글 손질: 부정의 부정('질질 안 끌고', '쿠키가 아깝지 않았음')과 겹치는 낱말을 지운다
function prepText(text, titleRe) {
  let s = (text || '').replace(KREACT.NEGATED, blank).replace(COMPOUND_MASK, blank);
  if (titleRe) s = s.replace(titleRe, blank);
  return s;
}

function keepFor() {
  return function keep(pairs, text) {
    if (KREACT.DEFEND.test(text || '')) return [];   // 불평하는 다른 독자를 나무라는 댓글: 작품 평가가 아님
    const out = [];
    for (const p of pairs) {
      const a = p[0];
      const clause = p[2] || '';
      if (a === '_over') { out.push(p); continue; }
      const ref = WORK_REF.test(clause);
      if (p[1] < 0 && WANT_MORE.test(clause)) continue;
      if (p[1] < 0 && /^(오타|오탈자)/.test(p[3] || '') && !TYPO_COMPLAINT.test(clause)) continue;
      if (a === 'overall') { if (ref || WHOLE_WORK.test(clause)) out.push(p); continue; }
      if ((a === 'character' || a === 'chemistry') && p[1] < 0) {
        out.push(ref || CHAR_EVAL.test(clause) ? p : ['_over', 1, clause, p[3], p[4], 'pos']);
        continue;
      }
      if (a === 'story' && p[1] < 0 && STORY_REACTION_KW.test(p[3] || '') && !/질질\s?(끌|끄)/.test(clause)) {
        if (ref) out.push(p);           // 작중 상황에 답답한 건 몰입 반응(kreact 과몰입)에서 센다
        continue;
      }
      if (a === 'immersion' && p[1] < 0 && NARRATED_BORED.test(clause)) continue;
      if (EVAL_KW[a]) { if (EVAL_KW[a].test(p[3] || '') || ref) out.push(p); continue; }
      out.push(p);
    }
    return out;
  };
}

// ---- 작품 정보 (리디 scripts/review_opts.js 와 같은 방식) ----
const STEM_RE = /(?:^|[^가-힣])([가-힣]{2,5})(?:은|는|이|가|의|와|과|에게|을|를|랑|이와|에게서|한테|이는|이가|이의|이를)(?=[^가-힣]|$)/g;
const NOT_NAME_END = /(하|되|스러|로|에서|으로|처럼|까지|부터|에게|하고|했|었|았|겠|들|님|씨|적|게|기|함|음|다|에|라|내|보|며|고|과|와)$/;
function nameStems(desc) {
  const out = new Set();
  let m;
  STEM_RE.lastIndex = 0;
  while ((m = STEM_RE.exec(desc || ''))) {
    out.add(m[1]);
    if (m[1].length >= 3 && /이$/.test(m[1])) out.add(m[1].slice(0, -1));
  }
  return out;
}
const normTitle = (t) => (t || '').replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)/g, ' ').replace(/(완전판|개정판|외전|[0-9]+\s?(권|부|화))/g, ' ').replace(/\s+/g, '').trim();
const splitAuthors = (a) => String(a || '').split(/[,/]/).map((s) => s.trim()).filter(Boolean);

function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

// 한 번 만들어 여러 작품에 쓴다: 소개글 낱말 빈도(흔한 말은 이름이 아님), 작가별 작품 목록
function makeEvaluator(dataDir) {
  const lite = readJson(path.join(dataDir, 'works-lite.json'), {});
  const search = readJson(path.join(dataDir, 'search-index.json'), []);
  const detailDir = path.join(dataDir, 'detail');
  const synopsis = (id) => (readJson(path.join(detailDir, `${id}.json`), {}) || {}).synopsis || '';
  const df = {};
  for (const f of (fs.existsSync(detailDir) ? fs.readdirSync(detailDir) : [])) {
    if (!f.endsWith('.json')) continue;
    for (const w of nameStems((readJson(path.join(detailDir, f), {}) || {}).synopsis)) df[w] = (df[w] || 0) + 1;
  }
  const byAuthor = {};
  const titleOf = {};
  for (const it of search) {
    titleOf[it.workId] = it.title || '';
    for (const a of splitAuthors(it.author)) (byAuthor[a] = byAuthor[a] || []).push(it);
  }

  function optsFor(id, texts) {
    const L = lite[id] || {};
    const cls = L.classification || '';
    const authors = splitAuthors(L.author).filter((n) => n.replace(/\s/g, '').length >= 2);
    const webtoon = /웹툰/.test(cls);
    let names = [...nameStems(synopsis(id))].filter((w) => (df[w] || 0) <= 6 && !NOT_NAME_END.test(w) && !RABSA.isLexicon(w) && !authors.includes(w));
    const min = Math.max(3, Math.round(texts.length * 0.002));
    names = names.filter((n) => { let c = 0; for (const t of texts) if (t.includes(n) && ++c >= min) return true; return false; }).slice(0, 15);
    const me = normTitle(titleOf[id]);
    const others = [];
    for (const a of authors) {
      for (const it of byAuthor[a] || []) {
        const ot = normTitle(it.title);
        if (it.workId === id || ot.length < 3 || !me || ot.includes(me) || me.includes(ot) || others.includes(ot)) continue;
        others.push(ot);
      }
    }
    return {
      webtoon,
      bl: /BL/i.test(cls),
      orig: webtoon && (L.sameWorkVersions || []).some((v) => v.category === '웹소설'),
      authors, names, others: others.slice(0, 20),
      keep: keepFor(),
    };
  }

  // 제목에 든 감성어는 그 작품 댓글에서 가린다 ('그 쓰레기가 나였어요' → 쓰레기)
  function titleMask(id) {
    const words = (titleOf[id] || '').split(/[^가-힣]+/).map((w) => w.replace(/(이|가|은|는|을|를|의|에|도|로|와|과)$/, '')).filter((w) => w.length >= 2 && RABSA.isLexicon(w));
    return words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  }

  // comments: [{text, likes, at}] (작가 댓글은 이미 뺀 것)
  function evaluate(id, comments, { examplesPer = 2, opinions = [6, 3, 4] } = {}) {
    const mask = titleMask(id);
    const texts = comments.map((c) => prepText(c.text, mask));
    const opts = optsFor(id, texts);
    const agg = RABSA.newAgg();
    comments.forEach((c, i) => RABSA.addReview(agg, { content: texts[i], likes: c.likes, at: c.at || '' }, opts));
    return pack(agg, { examplesPer, opinions });
  }

  // 회차 하나의 댓글에서 '작품을 칭찬한 댓글 수 / 아쉬워한 댓글 수'
  function countEval(id, comments) {
    const mask = titleMask(id);
    const texts = comments.map((c) => prepText(c.text, mask));
    const opts = optsFor(id, texts);
    let pos = 0, neg = 0;
    for (const t of texts) {
      const items = opts.keep(RABSA.analyzeReview(t, opts), t).filter((p) => p[0] !== '_over' && p[5] !== 'mild');
      if (items.some((p) => p[1] > 0)) pos++;
      if (items.some((p) => p[1] < 0)) neg++;
    }
    return [pos, neg];
  }

  return { VERSION, evaluate, countEval, optsFor, prep: (id, text) => prepText(text, titleMask(id)) };
}

// ---- 저장 형태 + '공통 의견' 문장 (리디 docs/app.js commonOpinions 를 수집기 쪽으로 옮김) ----
function pack(agg, { examplesPer, opinions }) {
  const asp = {};
  for (const [k, v] of Object.entries(agg.aspects || {})) if (v[0] + v[1] + (v[2] || 0) > 0) asp[k] = v;
  const ex = {};
  for (const [k, slot] of Object.entries(agg.examples || {})) {
    const o = {};
    for (const side of ['p', 'n', 'm']) if (slot[side] && slot[side].length) o[side] = slot[side].slice(0, examplesPer).map((e) => [e[0], e[1]]);
    if (Object.keys(o).length) ex[k] = o;
  }
  const out = { n: agg.total, used: agg.used, dN: agg.dTotal || 0, dUsed: agg.dUsed || 0, asp, op: commonOpinions(agg, opinions), ex };
  if (agg.over && agg.over[0]) { out.over = agg.over[0]; out.overEx = (agg.overEx || []).map((e) => [e[0], e[1]]); }
  return out;
}

const OPINION_PRED = {
  "좋": "좋다", "최고": "최고다", "예쁘": "예쁘다", "귀엽": "귀엽다", "재밌": "재밌다", "흥미": "흥미롭다",
  "잘생": "잘생겼다", "매력적": "매력적이다", "탄탄": "탄탄하다", "촘촘": "촘촘하다", "깔끔": "깔끔하다",
  "신선": "신선하다", "독특": "독특하다", "참신": "참신하다", "신박": "신박하다", "설레": "설렌다", "설렘": "설렌다",
  "두근": "두근거린다", "달달": "달달하다", "달콤": "달콤하다", "애틋": "애틋하다", "몰입": "몰입된다",
  "흡입력": "흡입력 있다", "흡인력": "흡입력 있다", "술술": "술술 읽힌다", "순삭": "순삭이다", "감동": "감동적이다",
  "여운": "여운이 남는다", "먹먹": "먹먹하다", "울컥": "울컥한다", "웃기": "웃기다", "웃음": "웃음이 난다",
  "유쾌": "유쾌하다", "피식": "피식 웃게 된다", "빵터": "빵 터진다", "사이다": "사이다다", "완벽": "완벽하다",
  "만족": "만족스럽다", "힐링": "힐링된다", "쫄깃": "쫄깃하다", "섹시": "섹시하다", "멋지": "멋지다",
  "아름답": "아름답다", "사랑스럽": "사랑스럽다", "미쳤": "미쳤다(좋은 뜻)", "미친": "미쳤다(좋은 뜻)",
  "대박": "대박이다", "명작": "명작이다", "인생작": "인생작이다", "맛있": "맛있다", "괜찮": "괜찮다",
  "무난": "무난하다", "볼만": "볼만하다", "준수": "준수하다", "짜임새": "짜임새 있다", "입체적": "입체적이다",
  "독보적": "독보적이다", "강추": "강력 추천", "강력추천": "강력 추천", "취저": "취향 저격", "취향저격": "취향 저격",
  "정주행": "정주행하게 된다", "밤새": "밤새 읽게 된다", "재탕": "다시 보게 된다", "재독": "다시 읽게 된다",
  "찰떡": "찰떡이다", "눈호강": "눈호강이다", "유죄": "치명적이다", "꿀잼": "꿀잼이다", "존잼": "존잼이다",
  "아쉽": "아쉽다", "지루": "지루하다", "답답": "답답하다", "별로": "별로다", "실망": "실망스럽다", "루즈": "루즈하다",
  "질질": "질질 끈다", "늘어지": "늘어진다", "고구마": "고구마다", "억지": "억지스럽다", "작위": "작위적이다",
  "유치": "유치하다", "뻔하": "뻔하다", "진부": "진부하다", "전형적": "전형적이다", "양산형": "양산형이다",
  "오글": "오글거린다", "급전개": "급전개다", "급발진": "급발진한다", "급마무리": "급하게 끝난다", "뜬금": "뜬금없다",
  "산만": "산만하다", "어색": "어색하다", "평면적": "평면적이다", "민폐": "민폐다", "찌질": "찌질하다",
  "멍청": "멍청하다", "호구": "호구 같다", "짜증": "짜증 난다", "노잼": "재미없다", "재미없": "재미없다",
  "허무": "허무하다", "허술": "허술하다", "싫": "싫다", "불편": "불편하다", "떨어지": "떨어진다", "애매": "애매하다",
  "허접": "허접하다", "용두사미": "용두사미다", "오타": "오타가 많다", "비싸": "비싸다", "최악": "최악이다",
  "캐붕": "캐릭터가 무너진다", "무매력": "매력이 없다", "매력없": "매력이 없다", "심심": "심심하다", "싱겁": "싱겁다",
  "난해": "난해하다", "비추": "비추천", "하차": "하차했다", "질리": "질린다", "거슬리": "거슬린다",
  "촌스럽": "촌스럽다", "올드": "올드하다", "부자연스럽": "부자연스럽다", "김빠": "김빠진다",
  "지지부진": "지지부진하다", "흐지부지": "흐지부지 끝난다",
  "절절": "절절하다", "순애": "순애다", "몽글몽글": "몽글몽글하다", "믿고보는": "믿고 본다", "훌륭": "훌륭하다",
  "삽질": "삽질한다", "비문": "비문이 많다", "오탈자": "오탈자가 많다", "역하": "역하다", "쓰레기": "쓰레기 같다",
  "불호": "불호다", "바보": "바보 같다", "찐따": "찐따 같다", "안읽히": "안 읽힌다", "간질간질": "간질간질하다",
  "애절": "애절하다", "깜찍": "깜찍하다", "입덕": "입덕하게 된다", "극락": "극락이다", "골때리": "골 때린다",
  "흐뭇": "흐뭇하다", "풋풋": "풋풋하다", "쏠쏠": "쏠쏠하다", "스며들": "스며든다", "스며듭": "스며든다", "스며든": "스며든다",
  "따뜻": "따뜻하다", "행복": "행복하다", "원픽": "원픽이다", "끝내주": "끝내준다", "이입": "이입된다", "걸작": "걸작이다",
  "웰메이드": "웰메이드다", "기특": "기특하다", "묘미": "묘미가 있다", "강약조절": "강약 조절이 좋다", "완급조절": "완급 조절이 좋다",
  "보배": "보배 같다", "시원하": "시원하다", "벤츠": "벤츠다", "고움": "곱다", "고와": "곱다", "고운": "곱다", "소름": "소름 돋는다",
  "적절": "적절하다", "선물": "선물 같다", "단비": "단비 같다", "꼴리": "꼴린다", "꼴려": "꼴린다", "개꼴": "꼴린다", "존꼴": "꼴린다",
  "맛도리": "맛도리다", "레전드": "레전드다", "갓작": "갓작이다", "대작": "대작이다", "수작": "수작이다",
  "밋밋": "밋밋하다", "미숙": "미숙하다", "불친절": "불친절하다", "무의미": "무의미하다", "반감": "반감된다", "갑갑": "갑갑하다",
  "엉망": "엉망이다", "쓸데없": "쓸데없다", "부족": "부족하다", "섭섭": "섭섭하다", "서운": "서운하다", "지치": "지친다",
  "지쳐": "지친다", "역겹": "역겹다", "구린": "구리다", "구려": "구리다", "구림": "구리다", "망했": "망했다", "망함": "망했다",
  "노꼴": "안 꼴린다", "코웃음": "코웃음만 나온다", "헛웃음": "헛웃음이 나온다", "피곤": "피곤하다",
  "꾸역꾸역": "꾸역꾸역 읽게 된다", "흐린눈": "흐린 눈 하게 된다", "작붕": "작화가 무너진다", "속터지": "속 터진다",
  "조건부 추천": "조건부로 추천한다", "쩐다": "쩐다",
};
const OPINION_NOT = {
  "지루": "지루하지 않다", "답답": "답답하지 않다", "고구마": "고구마가 없다", "뻔하": "뻔하지 않다",
  "불편": "불편하지 않다", "질질": "질질 끌지 않다", "늘어지": "늘어지지 않다", "유치": "유치하지 않다",
  "억지": "억지스럽지 않다", "오글": "오글거리지 않다", "산만": "산만하지 않다", "어색": "어색하지 않다",
  "아쉽": "아쉬움이 없다", "루즈": "루즈하지 않다", "진부": "진부하지 않다", "뜬금": "뜬금없지 않다",
  "부족": "부족함이 없다", "쓸데없": "쓸데없는 부분이 없다", "짜치": "짜치지 않다", "거슬리": "거슬리지 않다",
  "캐붕": "캐붕이 없다", "작붕": "작붕이 없다", "실망": "실망시키지 않는다", "올드": "올드하지 않다", "밋밋": "밋밋하지 않다",
  "질리": "질리지 않다", "허술": "허술하지 않다", "별로": "별로가 아니다", "속터지": "속 터지지 않다",
};
function hasBatchim(word) {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0;
}
function opinionText(key) {
  const i = key.indexOf('·');
  const kw = i < 0 ? '' : key.slice(0, i);
  const w = i < 0 ? key : key.slice(i + 1);
  const m = /^(.*?) (없음|아님)$/.exec(w);
  let pred;
  if (m && m[2] === '없음') pred = OPINION_NOT[m[1]] || `${m[1]} 없음`;
  else if (m) pred = OPINION_PRED[m[1]] ? OPINION_PRED[m[1]].replace(/다$/, '지 않다') : `${m[1]} 아님`;
  else if (OPINION_PRED[w]) pred = OPINION_PRED[w];
  else if (/다$/.test(w)) pred = w;
  else if (w.indexOf(' ') >= 0) pred = `${w}다`;
  else pred = w;
  return kw ? kw + (hasBatchim(kw) ? '이 ' : '가 ') + pred : pred;
}
function mergePhraseSide(arr) {
  const by = {};
  const order = [];
  (arr || []).forEach((e) => {
    const k = RABSA.normKey(e[0]);
    if (!by[k]) { by[k] = [k, e[1], e[2], e[3], e[4]]; order.push(k); } else by[k][1] += e[1];
  });
  return order.map((k) => by[k]).sort((a, b) => b[1] - a[1]);
}
// [[문장, 건수, 대표 발췌], ...] — 평가가 잡힌 댓글의 2% 이상(최소 2건) 반복된 말만
function commonOpinions(agg, [nPos, nMid, nNeg]) {
  const phrAll = RABSA.packPhr(agg.phr || {}, 10);
  const pos = [], neg = [], mid = [];
  const minN = Math.max(2, Math.round((agg.dUsed || agg.used || 0) * 0.02));
  for (const key of Object.keys(phrAll)) {
    mergePhraseSide(phrAll[key].p).forEach((e) => pos.push([e[0], e[1], e[2]]));
    mergePhraseSide(phrAll[key].n).forEach((e) => neg.push([e[0], e[1], e[2]]));
    mergePhraseSide(phrAll[key].m).forEach((e) => mid.push([e[0], e[1], e[2]]));
  }
  const top = (arr, n) => {
    const by = {};
    arr.forEach(([k, cnt, ex]) => {
      const t = opinionText(k);
      if (!by[t]) by[t] = [t, 0, ex, 0];
      by[t][1] += cnt;
      if (cnt > by[t][3]) { by[t][2] = ex; by[t][3] = cnt; }
    });
    return Object.values(by).filter((o) => o[1] >= minN).sort((a, b) => b[1] - a[1]).slice(0, n).map((o) => [o[0], o[1], o[2]]);
  };
  return { pos: top(pos, nPos), mid: top(mid, nMid), neg: top(neg, nNeg) };
}

module.exports = { VERSION, makeEvaluator, keepFor, WORK_REF };
