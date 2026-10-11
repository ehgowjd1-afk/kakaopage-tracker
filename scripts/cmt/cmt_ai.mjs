import { cut } from "./kakao_cmt.mjs";

/* 카카오페이지 회차 댓글 분석 — Claude API 부분 (리디 트래커 scripts/cmt/cmt_ai.mjs 2판을 옮김)
 *
 * 카카오는 별점 리뷰가 없어 작품 전체 반응도 회차 댓글에서 뽑는다: 표본은 초반 + 중간 + 최근 회차.
 * 바꾼 것은 플랫폼 이름과 표본 설명뿐 — 분류 원칙(속뜻·불호 기준)은 리디에서 사람이 재검토한 그대로.
 *
 * 1단계(Sonnet): 작품마다 댓글 표본을 읽고 '독자들이 반복해서 하는 말' 묶음(좋다는 말 / 많이 하는 말 / 불호)을 정한다.
 * 2단계(Haiku): 댓글 하나마다 어느 묶음에 해당하는지(th) + 속뜻(tn) + 직접 드러난 니즈(nd)만 붙인다. 개수는 프로그램이 센다.
 * 3단계(Sonnet): 참고용 니즈 맵.
 * 원문 인용 대신 댓글 번호(refs)로 근거를 단다 — 결과 파일에 댓글 원문이 들어가지 않게.
 *
 * 1판(12칸 분류 + 해석형 종합)은 사람 재검토에서 34%가 속뜻과 달랐다(2026-10-10, 612개):
 * '불만형' 105개 중 99개가 실제로는 연재 아쉬움·캐릭터 과몰입·애정 투정이었고, 니즈는 43%만 맞았다.
 * 아래 규칙은 그 재검토에서 나온 것이다.
 */

// 속뜻: 겉말이 불평이어도 속뜻이 애정이면 불만이 아니다 (사용자 지적, 2026-10-10)
export const TONES = { praise: "칭찬·환호", char: "캐릭터 과몰입", tease: "애정 투정·반어", miss: "연재 아쉬움", nudge: "애정 섞인 지적·진도 투정", critic: "진짜 작품 불만", theory: "추리·예측", fan: "독자끼리·작품 외", other: "단순·기타" };
export const BUCKETS = { like: "좋다는 말", talk: "많이 하는 말", dislike: "불호" };
export const AXES = { hero: "주인공", romance: "로맨스", fantasy: "판타지", relation: "관계·조연", craft: "작화·연출", ops: "연재 운영", orig: "원작 비교", etc: "기타" };
export const NEEDS = {
  hero_revenge: "응징·사이다", hero_status: "인정·위상 역전", hero_growth: "성장·노력의 보상", hero_agency: "주체성", hero_heal: "상처와 치유", hero_tension: "긴장감·대가",
  rom_progress: "관계 진전", rom_mutual: "쌍방 확인", rom_power: "관계의 힘 구도", rom_jealous: "질투·독점", rom_conflict: "갈등의 종류", rom_salvation: "구원", rom_sub: "서브 캐릭터",
  fan_reveal: "세계관·비밀 공개", fan_system: "능력 체계의 일관성", fan_action: "전투·액션 쾌감", fan_strategy: "두뇌전·전략", fan_regress: "회귀·빙의 정보 우위", fan_scale: "스케일 확장",
  rel_family: "가족 서사", rel_friend: "동료·우정", rel_villain: "악역 서사"
};
export const NEED_AXIS = (code) => ({ hero: "hero", rom: "romance", fan: "fantasy", rel: "relation" })[code.split("_")[0]] || "etc";
export const STATES = { met: "충족", lack: "결핍", ask: "요구", split: "호불호 갈림", none: "해당 없음" };
export const ACTIONS = { pay: "결제·전환", stay: "기다림·유지", share: "추천·전파", churn: "이탈 경고", none: "없음" };
export const CONFS = { hi: "높음", mid: "중간", lo: "낮음" };

const E = (o) => Object.keys(o);
const list = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ");
const REFS = { type: "array", items: { type: "integer" } };

// ---------------- 1단계: 반복되는 반응 찾기 (Sonnet) ----------------
export const THEME_SCHEMA = {
  type: "object", additionalProperties: false, required: ["themes"],
  properties: {
    themes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["bucket", "label", "def", "refs"],
        properties: { bucket: { type: "string", enum: E(BUCKETS) }, label: { type: "string" }, def: { type: "string" }, refs: REFS }
      }
    }
  }
};

export const THEME_SYSTEM = `당신은 웹툰·웹소설 회차 댓글에서 '독자들이 반복해서 하는 말'을 찾는 분석가입니다. 숨은 뜻을 해석하지 말고, 독자들이 실제로 되풀이하는 말을 있는 그대로 묶되, 결과에는 댓글 원문을 옮겨 적지 않습니다(결과가 공개되므로 근거는 refs 번호로만). 결과는 기획자가 "이런 반응이 반복된다, 이런 말이 많다, 이런 불호가 있다"를 보는 데 쓰입니다.

## 할 일
초반·중간·최근 회차 댓글 표본을 읽고, 여러 댓글에서 되풀이되는 말을 15~22개 묶음으로 정리합니다. 초반 화 댓글에는 첫인상·진입 장벽이, 최근 화 댓글에는 지금의 반응이 있습니다(초반 화 댓글은 나중에 정주행한 독자의 말일 수도 있음). 목표는 '무언가 구체적인 말을 하는 댓글'의 대부분이 어느 한 묶음에 들어가게 하는 것입니다.
- 먼저 작품 전체에 걸쳐 여러 회차에 나오는 반응을 찾습니다(예: 작화가 화보 같다, 공의 미모 감탄, 수의 성격 매력, 공의 질투·집착이 웃기고 좋다, 원작 장면 재현 만족, 다음 화·휴재 기다림). 이런 묶음의 label·def에는 회차를 붙이지 않습니다.
- 그다음 특정 회차 장면에 몰린 반응(예: 27화 포토부스 키스 환호)은 정말 그 회차(와 바로 다음 화)에만 몰릴 때만 따로 묶고, label 앞에 회차를 붙입니다('27화: …'). 같은 반응이 다른 회차에도 나오면 회차 없는 작품 전체 묶음으로 만듭니다.
- 이런 반응을 빠뜨리지 않았는지 확인합니다: 인물별 외모 매력, 인물별 성격·관계 매력, 커플 케미, 질투·집착, 수위·씬, 작화·연출, 원작 재현·원작 비교, 명장면 기대(원작 독자가 기다리는 장면), 캐릭터에게 화내기·놀리기(인물별), 악역·방해꾼 미워하기, 연재 기다림·절단 투정, 추리·예측.
- 각 묶음:
  · bucket: like(좋다는 말) / talk(많이 하는 말) / dislike(불호)
  · label: 여러 댓글이 공통으로 하는 말을 25자 안팎으로, 독자 말투에 가깝게 자기 말로 요약. 특정 댓글 문장을 그대로 옮기지 않는다(예: '신루가 미모로 유혹하는 게 좋다', '휴재·시즌 완결이 너무 아쉽다', '헌터에게 마음 인정하라고 다그침')
  · def: 다른 AI가 댓글 하나하나를 이 묶음에 넣을지 판단할 기준. 60자 안팎. 헷갈리는 이웃 묶음과 어떻게 다른지도 짧게. def에도 댓글 문장을 옮기지 않고 특징을 설명한다.
  · refs: 근거 댓글 번호 2~5개

## bucket 기준 (가장 중요)
- like: 작품·장면·인물·작화·연출을 좋다고 하는 말. 인물의 외모·성격·매력 칭찬('렉스 존잘'), 장면 환호('드디어 키스!', '최고의 추석 선물')는 부탁이 섞여도 like다. 반어·밈으로 한 칭찬도 like다:
  'X 얘기 좀 그만해요'라면서 문장 사이사이에 X를 끼워 넣음(= X가 좋다), '외모가 반칙·흉기', '적당히 더 하세요', '몇백 원에 이걸 봐도 되나', '몸 보느라 대사를 못 읽음', '웹툰이에요 화보예요?'
- talk: 좋다·싫다로 가르기 애매하거나 화제인 말:
  · 캐릭터에게 하는 말 — 화내기·욕·놀림·서운함·타박·훈수·명령('예쁘면 다냐', '정작 본인은 멀쩡한데 내가 서운함', '빨리 마음 인정해 바보야', 악역 미워하기)
  · 연재 아쉬움 — 휴재·시즌 완결·분량·기다림('규탄한다 보장하라', '이제 무슨 낙으로 살아', '벌써 끝?'), 절단 투정('왜 여기서 끊어요ㅠ')
  · 추리·예측·상상, 수위·씬 조르기, 원작 비교·원작 회차 질문, 다음 전개 기대
  · 애정 섞인 지적이나 진도 투정('재밌는데 팔이 짧아 보여요, 그것만 부탁', '진도 너무 느려어어', '이 에피소드를 4화나 끈다고? 너무하네')
- dislike: 작품을 만든 방식(전개·개연성·캐붕·작화·연출·과한 수위)이나 작가를 분명하고 진지하게 비판하는 말, 진지한 하차 선언, 결제가 아깝다는 말만.
  · 웃음·ㅠ·애칭·과장이 섞인 투정, 정중한 부탁형 지적, 캐릭터의 행동에 화내는 말, 휴재·완결 아쉬움은 dislike가 아니라 talk다.
  · 상위 작품은 진짜 불호가 매우 드물다(재검토에서 612개 중 5개). 분명한 근거가 여러 개 없으면 dislike 묶음을 만들지 않는다. 0개여도 된다.

## 주의
- 묶음끼리 겹치지 않게. '재밌다'처럼 너무 넓은 묶음은 만들지 않는다 — 무엇이 좋은지, 무슨 말인지 구체적으로.
- 한 묶음 = 한 가지 반응. 같은 회차라는 이유만으로 서로 다른 반응(예: 사진 이야기 + 조연 미움)을 한 묶음에 섞지 않는다.
- '재밌어요', '1등', 'ㅋㅋㅋ'뿐인 댓글은 묶지 않아도 된다(분류에서 '해당 없음'으로 남음).
- 지어내지 않는다. 표본에 실제로 여러 번 나온 말만.`;

// ---------------- 1단계 카카오판 (B, 정밀도 개선 시험 2026-10-12) ----------------
// 1차 시범 검토에서: 같은 반응이 장면별로 4~6개 묶음으로 쪼개짐, 반복된 진짜 불만(원작 대비 변경·초반 주인공 비호감)이
// '애정 섞인 지적'에 묻힘, 작중 논쟁 묶음 이름에 '불편함'이 붙어 불만처럼 읽힘, 휴재 투정과 복귀 환호가 섞임,
// 원작 팬의 웹툰화 반응·명대사 인용·피폐 수위 경고·완결 후 몰아보기 같은 반복 반응이 빠짐.
// 사용자 원칙(요청서)은 그대로: 불호 = 서사·캐릭터·(웹툰) 작화만, 정중한 지적·진도 투정 = 많이 하는 말, 불호를 억지로 만들지 않음.
export const THEME_SYSTEM_K = `당신은 카카오페이지 웹툰·웹소설 회차 댓글에서 '독자들이 반복해서 하는 말'을 찾는 분석가입니다. 숨은 뜻을 해석하지 말고, 독자들이 실제로 되풀이하는 말을 있는 그대로 묶되, 결과에는 댓글 원문을 옮겨 적지 않습니다(결과가 공개되므로 근거는 refs 번호로만). 결과는 기획자가 "이런 반응이 반복된다, 이런 말이 많다, 이런 불호가 있다"를 보는 데 쓰입니다.

## 할 일
초반·중간·최근 회차 댓글 표본을 읽고, 여러 댓글에서 되풀이되는 말을 15~22개 묶음으로 정리합니다. 초반 화 댓글에는 첫인상·진입 장벽이(나중에 몰아 본 독자의 말일 수도 있음), 최근 화 댓글에는 지금의 반응이 있습니다. 목표는 '무언가 구체적인 말을 하는 댓글'의 대부분이 어느 한 묶음에 들어가게 하는 것입니다.

## 묶음 단위 — 장면이 아니라 '요소'
- 묶음 하나 = 하나의 대상(인물·커플·관계·세계관·전개·작화/문장·각색·연재 운영 등)에 대한 한 가지 반응. 같은 대상에 대한 같은 종류의 반응은 여러 회차·장면에 나와도 한 묶음으로 합치고, 장면은 def 안에 예시로 적는다(예: 여러 화에 걸친 '조연 집단이 귀엽다·웃기다'는 장면별로 나누지 않고 한 묶음).
- 특정 회차 장면에만 몰린 반응은 정말 그 회차(와 바로 다음 화)에만 나올 때만 따로 묶고 label 앞에 회차를 붙인다('27화: …'). 이런 회차 전용 묶음은 3~4개까지.
- 한 묶음 = 한 가지 반응. 같은 회차라는 이유로 서로 다른 반응을 섞지 않는다.

## 빠뜨리지 않았는지 점검 (표본에 실제로 여러 번 나온 것만 묶음으로)
인물별 외모·성격 매력, 커플 케미·질투·집착, 조연·악역 미워하기, 캐릭터에게 화내기·놀리기(인물별), 세계관·설정 이야기, 추리·예측, 수위·씬, 작화·연출(웹툰)·문장(웹소설), 원작 비교·원작 장면 재현(원작이 있으면), 원작 팬의 웹툰화 환영·걱정, 명대사·원작 문장 인용, 명장면 기대, 전개 속도·반복에 대한 말, 피폐·수위가 세다는 경고, 연재 기다림·절단 투정, 휴재에 대한 말과 복귀 반응(휴재 전·중과 복귀 뒤는 다른 묶음), 완결 뒤 몰아보기, 가격·소장권 이야기.

## bucket 기준 (가장 중요 — 사용자 원칙)
- like: 작품·장면·인물·작화·연출을 좋다고 하는 말. 반어·밈으로 한 칭찬('외모가 반칙', '몇백 원에 이걸 봐도 되나', 'X 얘기 그만해'를 X 범벅으로)도 like. 명대사 인용도 like.
- talk: 좋다·싫다로 가르기 애매하거나 화제인 말 — 캐릭터에게 화내기·욕·놀림·훈수·악역 미워하기(과몰입), 작중 선악·종교·정치 논쟁, 추리·예측, 연재 기다림·휴재·완결·분량·절단 투정(비꼬거나 화를 내도), 정중한 지적·진도 투정('재밌는데 이것만 부탁', '진도 좀 빼주세요ㅠ'), 원작 비교·원작 회차 질문, 휴재·지각·연재 주기·분량·가격·문장·오탈자에 대한 불만(아무리 진지해도 — 불호가 아님).
- dislike(불호): 서사·캐릭터(웹툰은 작화까지)를 분명하고 진지하게 싫다고 하는 말만 — 전개 늘어짐·고구마·반복·개연성·설정·결말·과한 수위, 캐릭터 성격이 이상하다·매력 없다·캐붕, 원작에서 바뀐 서사·캐릭터에 대한 진지한 불만, 웹툰은 작화 붕괴·그림체 변화·인체 비율·연출 퀄리티, 그래서 하차·실망했다. 앞에 칭찬이 있어도 결론이 하차·실망이면 불호.
  · 근거 댓글이 여러 개 있을 때만. 상위 작품은 진짜 불호가 원래 드물다 — 억지로 만들지 않는다. 0개여도 된다.
  · 같은 대상의 가벼운 투정과 진지한 불만이 둘 다 많으면, 투정은 talk 묶음, 진지한 불만은 dislike 묶음으로 나누고 label로 차이를 분명히 한다(예: '진도 좀 빼달라는 투정' vs '같은 장면 반복에 진지하게 실망').

## label·def
- label: 여러 댓글이 공통으로 하는 말을 25자 안팎으로, 독자 말투에 가깝게 자기 말로 요약. 특정 댓글 문장을 그대로 옮기지 않는다.
- 작중 인물·사건에 대한 반응 묶음(talk·like)의 label에는 '불편·비판·불만·문제' 같은 말을 쓰지 않고 반응 그대로 쓴다(예: '○○의 광기에 경악', '○○에게 화내기'). '불만'이라는 말은 dislike 묶음에만.
- def: 다른 AI가 댓글 하나하나를 이 묶음에 넣을지 판단할 기준, 60자 안팎. 헷갈리는 이웃 묶음과 어떻게 다른지도 짧게. 장면 예시를 적어도 된다. 댓글 문장을 옮기지 않는다.
- refs: 근거 댓글 번호 2~5개.

## 주의
- 묶음끼리 겹치지 않게. '재밌다'처럼 너무 넓은 묶음은 만들지 않는다.
- '재밌어요', '1등', 'ㅋㅋㅋ'뿐인 댓글은 묶지 않아도 된다.
- 지어내지 않는다. 표본에 실제로 여러 번 나온 말만.
- 입력의 [작품 사실]·[회차 사실](원작 유무, 휴재·복귀 회차)은 묶음 경계를 정하는 데 참고한다.`;

export function buildThemeParamsK(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: THEME_SYSTEM_K,
    messages: [{ role: "user", content: text + "\n\n위 댓글 표본에서 반복되는 반응 묶음을 JSON으로 정리하세요." }],
    output_config: { format: { type: "json_schema", schema: THEME_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

export function buildThemeParams(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: THEME_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 댓글 표본에서 반복되는 반응 묶음을 JSON으로 정리하세요." }],
    output_config: { format: { type: "json_schema", schema: THEME_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// ---------------- 2단계: 댓글마다 묶음·속뜻·니즈 표시 (Haiku) ----------------
export const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["comments"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["n", "th", "tn", "nd", "st", "nn", "ac", "cf"],
        properties: {
          n: { type: "integer" },
          th: { type: "array", items: { type: "string" } },
          tn: { type: "string", enum: E(TONES) },
          nd: { type: "array", items: { type: "string", enum: E(NEEDS) } },
          st: { type: "string", enum: E(STATES) },
          nn: { type: "string" },
          ac: { type: "string", enum: E(ACTIONS) },
          cf: { type: "string", enum: E(CONFS) }
        }
      }
    }
  }
};

export const CLASSIFY_SYSTEM = `당신은 한국 웹소설·웹툰 플랫폼 카카오페이지의 '회차 댓글'을 하나하나 읽고 표시를 붙이는 분석가입니다. 해석보다 '이 댓글이 무슨 말을 하는지'를 정확히 잡는 것이 목표입니다.

댓글마다 아래 칸을 채웁니다. 값은 반드시 정해진 코드로 씁니다.

- th 반복 반응: 입력의 [반복 반응 목록]에서 이 댓글이 해당하는 묶음 번호(T1, T2 …) 0~2개. 댓글마다 목록 전체를 훑어, 댓글의 주된 말이 어떤 묶음의 기준(def) 범위 안에 들면 넣는다 — 묶음 이름과 표현이 똑같지 않아도, 다른 회차의 같은 반응이어도 넣는다. 회차가 붙은 묶음('27화: …')은 그 장면 이야기일 때만. '재밌어요', 'ㅋㅋㅋ'처럼 구체적인 말이 없거나 맞는 묶음이 정말 없을 때만 []. (불호) 묶음은 tn=critic일 때만 고른다 — 애정 섞인 지적·진도 투정·과몰입·연재 아쉬움은 (많이 하는 말) 묶음에서 고른다.
- tn 속뜻(겉말이 아니라 속뜻 기준 하나): ${list(TONES)}
- nd 니즈 코드(0~3개, 댓글 문장에 직접 나온 것만): ${list(NEEDS)}
- st 니즈 상태: ${list(STATES)}
- nn 목록에 없는 바람의 짧은 이름(댓글 문장을 베끼지 말고 니즈 이름으로. 예: '수위·씬', '원작 명장면 재현', '각색·오리지널 씬', '후회 전개(구르기)'). 없으면 ""
- ac 행동 신호: ${list(ACTIONS)}
- cf 확신도: ${list(CONFS)}

## 속뜻(tn) 정하는 순서
1. 감정이 누구를 향하는지 본다: ① 작중 인물 ② 연재 일정(휴재·완결·분량·끊긴 지점·기다림) ③ 작품을 만든 방식(전개·구성·작화·연출·작가) ④ 다른 독자나 작품 밖.
2. 판별 질문: 작가가 작품 내용·그리는 방식을 고쳐야 한다고 '진지하게' 탓하는가(좋다는 말·부탁·ㅠ·늘인 말끝·투정 없이) → critic. 좋아하면서 부탁하거나 진도·속도를 조르는가 → nudge. 작중 인물에게 하는 말인가 → char. 그냥 빨리 더 보고 싶은 것인가(연재 일정·운영 포함) → miss 또는 tease.
3. 겉말이 불평·욕·항의여도 속뜻이 '좋다' 또는 '더 보고 싶다'면 critic이 아니다.

## 값의 뜻
- praise 칭찬·환호: 작품·장면·작화·인물의 매력을 좋다고 하는 말. 짧은 감탄('미쳤다', '와ㅠㅠ', 'Good'), 복귀 환영, 소장 자랑 포함.
- char 캐릭터 과몰입: 작중 인물에게 화·욕·놀림·서운함·걱정·타박·편들기·명령·훈수, 별명 부르기, 악역 미워하기. 예) "잘생기면 다예요? 하는 짓 좀 보라고ㅋㅋ", "당사자는 태연한데 왜 보는 내가 섭섭하지", "사과해", "언제 철들래". 외모를 욕해도 작화 불만이 아니다.
- tease 애정 투정·반어·밈: 불평처럼 보이지만 속은 좋아하는 말.
  · 절단 투정: '여기서 끊어요?', '끊기 있기 없기', '감질나', '작가님 잔인하시다', 인물에게 '마저 해라'
  · 금지어 끼워 넣기: 'X 얘기 그만해'라며 문장 사이사이에 X를 반복 = X가 좋다. 예) "허벅지 얘기 그만해요 허벅지 진짜 허벅지 지겹다니까요 허벅지"
  · '적당히 (더) 하세요', '그만 좀 설레게 해', 외모·스킨십을 '흉기·반칙·폭력'으로 표현
  · '몸이나 얼굴 보느라 내용이 기억 안 남' = 작화 극찬(내용이 약하다는 불만 아님)
  · 가격 죄책감('몇백 원에 이걸 봐도 되나') = 가성비 극찬
  · 장르 바뀜 드립('호러물인 줄', '스릴러 봤다') = 집착·질투 장면 몰입
  · 수위·씬 조르기('왜 성인 등급인지 다음 화에 증명해 주세요'), 하차 농담('이러다 하차각ㅋㅋ')
  · 양보절('답답하긴 한데 귀여우니 봐준다')은 뒤가 본심
- miss 연재 아쉬움: 휴재·시즌 완결·분량·기다림에 대한 비명 = 더 보고 싶다. 시위 구호('결사반대', '보장하라'), 상실 과장('이제 무슨 낙으로 살아'), 부정('완결이 뭐죠?'), 애원('가지 마요'), 분량('벌써 끝?'), '하 이걸 또 일주일을', 연재일 착각, 스포 구걸, 업데이트 요청. 휴재·지각·공지·분량 같은 연재 운영 이야기는 비꼬거나 화를 내도('공지도 없이 또 휴재?', '오늘도 지각이네요') miss다. 예) "휴재 결사반대!! 독자 생존권 보장하라"
- nudge 애정 섞인 지적·진도 투정: 재밌다·좋다는 말이나 부탁과 함께 하는 작화·전개 지적('재밌게 보고 있어요, 근데 손이 좀 어색해요 그것만 부탁드려요'), 투정 말투의 진도·속도 불평('진도 너무 느려어어', '이 에피소드를 4화나 끈다고? 너무하네', '언제 사귀어요 진도 좀'). 작가에게 하는 말이어도 critic이 아니다.
- critic 진짜 작품 불만: 작품을 만든 방식이나 작가를 향한 진지한 비판만.
  · 전개('산으로 간다', '개연성 없다', '캐붕'), 구성(같은 패턴이 반복돼 지루하다·지친다는 진지한 비판. 화수를 세며 투정하는 말은 nudge)
  · 작화('그림체가 바뀐 것 같다', '비율이 어색하다', 좋아진다는 말 없이 '작화가 점점…ㅠ'), 연출('경기 장면 효과가 약하다')
  · 수위 과잉 진지한 비판('또 벗기냐 스토리는 언제'), 작품이 인물의 잘못을 미화한다는 비판(인물의 행동이 아니라 작품의 그리는 방식을 탓할 때)
  · 진지한 하차 선언, '결제 아깝다'(작품 값어치 탓)
  · 웃음이나 ㅠ 없이 건조하게 쓴 짧은 관찰도 critic 후보로 두되 cf=lo
- theory 추리·예측·망상: 아직 일어나지 않은 구체적 사건을 짐작하거나 상상할 때만. '재밌다 어떻게 되려나', '이 장면만 기다렸다'는 praise.
- fan 독자끼리·작품 밖: 다른 독자(스포·댓글 매너)를 향한 말, 플랫폼·다른 작품 이야기.
- other 단순·중립: 정보 질문(원작 몇 권이에요?), 맥락 없는 답글, 방향을 알 수 없는 반응.
여러 감정이 섞이면 주된 감정으로. 좋다는 말·부탁과 지적이 함께 있으면 nudge. 칭찬·부탁·투정 없이 진지한 비판만 있을 때 critic.

## 니즈(nd): 댓글 문장에 직접 나온 서사만 — 과다 부착 금지
- nd는 댓글이 그 서사 요소(고백·키스·질투·사과·위기 등)를 직접 가리킬 때만 붙인다. 회차 분위기나 '이 화에서 일어난 일'로 짐작해 넣지 않는다. 애매하면 [].
- nd=[]: 감탄만 있는 말('미쳤다', '야하다', '설렌다', '울면서 봤다'), 외모·작화 칭찬, 기다림·분량·휴재 반응(miss는 항상 []), 독자 자신의 이야기('내 도파민 돌아옴'), 별명·애칭 욕 하나뿐인 말.
- rom_mutual: 고백·마음 확인·엇갈림이 언급될 때만(키스·스킨십 환호엔 rom_progress만). rom_progress: 고백·키스·사귐·동거·호칭 변화 같은 관계 단계.
- hero_tension: 주인공 승리의 대가·난이도 이야기만(커플 '텐션', 클리프행어, 무서운 연출엔 쓰지 않음). hero_agency: 주인공이 행동하지 않아 사건이 멈출 때만(로맨스 상대가 마음을 인정 못 해 답답한 건 rom_mutual).
- rom_sub: 서브 캐릭터의 매력. rel_family: 실제 작중 가족 서사만(커플을 '엄마아빠'라 부르는 밈은 rom_progress). hero_heal: 작중 인물의 상처 회복(독자가 위로받았다는 말 아님). fan_reveal: 특정 떡밥·비밀이 궁금할 때(수위 조르기에 쓰지 않음).
- 과몰입 댓글에서 독자가 인물에게 시키는 행동 = 독자가 원하는 전개(st=ask): 마음 인정·고백해라→rom_mutual, 이제 사귀어라·책임져라→rom_progress, 사과해라·굴러라→rom_power + nn '후회 전개(구르기)', 악역에게 꺼져→rel_villain met, 질투하는 인물 놀림→rom_jealous met.
- 수위 감탄·조르기 → nd=[] 또는 그대로 두고 nn '수위·씬'. 원작 장면 구현의 기쁨 → nn '원작 명장면 재현'. 각색 칭찬 → nn '각색·오리지널 씬'.

## 상태(st)·행동(ac)
- st: met=이 화에서 채워져 좋아함 / ask=앞으로 이렇게 되길 바람 / lack=진짜 피로감('지친다', '언제까지 끌어', '또 이 패턴')이 있을 때만 / split=독자끼리 갈림이 드러남 / none=니즈 없음. 절단·기다림 반응엔 met 금지, 놀림·관전엔 lack 금지.
- ac: pay=소장·결제·원작 구매 언급 / stay=다음 화 기다림 / share=영업·주변 사람 언급 / churn=독자 자신이 진지하게 그만 보겠다고 할 때만(char·tease·miss·nudge엔 쓰지 않음) / none. '사랑해요·응원해요'만으로는 붙이지 않는다.

## 출력
입력의 댓글 번호(#n)마다 하나씩, 빠짐없이 JSON으로 답한다. 지어내지 않는다.`;

function workBlock(work, ep, themes) {
  return `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.bl ? " / BL" : ""}\n[작품 소개] ${work.desc || "-"}\n[회차] ${ep.no}화${ep.part ? " (" + ep.part + ")" : ""} (공개 ${String(ep.reg || "").slice(0, 10)})\n\n` +
    `[반복 반응 목록]\n` + themes.map((t) => `${t.id} (${BUCKETS[t.bucket]}) ${t.label} — 기준: ${t.def}`).join("\n");
}

// 댓글 묶음 하나의 요청. comments: [{n, text, like, sp, best}]
export function buildClassifyParams(cfg, work, ep, comments, textMax, themes) {
  const body = workBlock(work, ep, themes) + "\n\n[댓글]\n" +
    comments.map((c) => `#${c.n} [좋아요 ${c.like}${c.best ? "·베스트" : ""}${c.sp ? "·스포" : ""}] ${cut(c.text.trim().replace(/\s+/g, " "), textMax)}`).join("\n") +
    "\n\n위 댓글에 규칙대로 표시를 붙여 JSON으로 답하세요.";
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: [{ type: "text", text: CLASSIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// ---------------- 2단계 카카오판 (정밀도 개선 시험, 2026-10-11) ----------------
// 1차 시범 검토(검토자 4명): '진짜 불만'으로 본 것 중 SSS급 44~46%, 잊혀진 들판 73~77%만 진짜였다.
// 오판 60개 중 35개가 '대상 혼동'(작중 인물·선악 논쟁을 작품 비판으로), 나머지는 인용·설정 질문·독자 반박·칭찬 오독.
// 그래서: ① 무엇을 향한 말인지(tg)·무엇에 대한 것인지(cw)를 속뜻보다 먼저 적게 하고, 진짜 불만 판정은 코드가 한다
// (complaintOf, 아래) ② 카카오 댓글 문화에 맞춘 속뜻 규칙 ③ 헷갈리는 짝 예시 ④ 코드로 계산한 맥락(cmt_ctx.mjs).
// 리디판 규칙에서 '웃음·ㅠ 없는 건조한 짧은 관찰도 critic 후보'와 '휴재에 화내도 miss'는 뺐다(카카오에선 오판·누락의 원인).
export const TARGETS = { story: "작중 인물·사건·설정", craft: "작품을 만든 방식", adapt: "원작 대비 각색", ops: "연재 운영", price: "가격·결제", reader: "다른 독자", other: "그 밖·알 수 없음" };
export const ASPECTS = { pace: "진도·늘어짐", repeat: "재탕·같은 장면 반복", logic: "개연성·설정 구멍", design: "인물 설계·캐붕·장르 기대", art: "작화·그림체", direction: "연출", text: "문장·오타·식자", rating: "수위·피폐 정도", adapt: "원작 대비 변경·생략", ops: "휴재·지각·분량", price: "가격", none: "해당 없음" };
export const ACTIONS_K = { ...ACTIONS, later: "완결 뒤 몰아보기·연재 따라가기 중단" };

export const CLASSIFY_SCHEMA_K = {
  type: "object", additionalProperties: false, required: ["comments"],
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        // 출력 순서 = 판단 순서: 무엇을 향한 말인지 먼저, 속뜻은 그다음
        required: ["n", "tg", "cw", "tn", "th", "nd", "st", "nn", "ac", "cf"],
        properties: {
          n: { type: "integer" },
          tg: { type: "string", enum: E(TARGETS) },
          cw: { type: "string", enum: E(ASPECTS) },
          tn: { type: "string", enum: E(TONES) },
          th: { type: "array", items: { type: "string" } },
          nd: { type: "array", items: { type: "string", enum: E(NEEDS) } },
          st: { type: "string", enum: E(STATES) },
          nn: { type: "string" },
          ac: { type: "string", enum: E(ACTIONS_K) },
          cf: { type: "string", enum: E(CONFS) }
        }
      }
    }
  }
};

const K_HEAD = `당신은 한국 웹소설·웹툰 플랫폼 카카오페이지의 '회차 댓글'을 하나하나 읽고 표시를 붙이는 분석가입니다. 해석보다 '이 댓글이 무엇을 향해 무슨 말을 하는지'를 정확히 잡는 것이 목표입니다.

댓글마다 아래 칸을 이 순서대로 채웁니다. 값은 반드시 정해진 코드로 씁니다.

- tg 대상(하나): 이 댓글의 말·감정이 무엇을 향하는가 — ${list(TARGETS)}
- cw 측면(하나): 작품·운영·가격을 탓하거나 칭찬할 때 그 대상 — ${list(ASPECTS)}. 측면이 없거나 tg가 story·reader·other면 none.
- tn 속뜻(겉말이 아니라 속뜻 기준 하나): ${list(TONES)}
- th 반복 반응: 입력의 [반복 반응 목록]에서 이 댓글이 해당하는 묶음 번호(T1, T2 …) 0~2개. 댓글의 주된 말이 어떤 묶음의 기준(def) 범위 안에 들면 넣는다 — 표현이 똑같지 않아도, 다른 회차의 같은 반응이어도. 회차가 붙은 묶음('27화: …')은 그 장면 이야기일 때만. 구체적인 말이 없거나 맞는 묶음이 정말 없을 때만 []. 묶음 이름의 단어만 보고 넣지 말고, 댓글이 그 기준대로의 말을 하는지 본다. (불호) 묶음은 tn=critic일 때만.
- nd 니즈 코드(0~3개, 댓글 문장에 직접 나온 것만): ${list(NEEDS)}
- st 니즈 상태: ${list(STATES)}
- nn 목록에 없는 바람의 짧은 이름(댓글 문장을 베끼지 말고 니즈 이름으로). 없으면 ""
- ac 행동 신호: ${list(ACTIONS_K)}
- cf 확신도: ${list(CONFS)}`;

const K_TARGET = `
## 1. 대상(tg) 먼저 — 같은 분노라도 무엇을 향했는지에 따라 뜻이 다르다
- story: 작중 인물의 행동·성격, 작중 사건, 작중 세계의 선악·종교·정치·체제를 두고 하는 말. 인물에게 화내기·욕·응원·걱정·훈수, 악역 미워하기, 독자끼리 작중 누가 옳은지 다투기는 아무리 진지하고 논리적이어도 story다.
- craft: 작품을 만든 방식 — 전개·구성·개연성·설정 모순, 인물 설계(주인공·남주·여주를 역할로 부르며 설계를 평가: '주인공 매력이 하나도 없다'), 장르 기대(이 장르라면 있어야 할 전개가 없다), 작화·그림체 변화·연출·문장·오타, 수위·피폐 정도, 작가. 여러 화에 걸친 전개를 탓하거나('N화째', '요즘 전개'), 작가·작품이 인물의 잘못을 미화한다고 할 때도 craft. 작품·장면에 대한 칭찬도 craft.
- adapt: 원작(웹툰이면 원작 소설)과 비교한 각색 — 바뀐 점·생략·추가·순화, 원작 장면 재현. '원작이랑 왜 달라요?', '원작엔 이 장면 없었는데'처럼 질문이어도 바뀐 점을 짚으면 adapt.
- ops: 휴재·지각·분량·공지·연재 주기·시즌·완결 일정.
- price: 가격·결제·소장권·대여·값어치.
- reader: 다른 독자를 향한 말 — 반박·설명·옹호·스포 경고·댓글 매너. 단, 다른 독자에게 '하차했다·비추·수위 주의'를 알리는 말은 작품 이야기다(craft, cw=rating 등).
- other: 그 밖(다른 작품·플랫폼 이야기, 인사, 맥락 없는 말).
- 다른 판(웹툰판·소설판)의 그림·연출·각색 이야기는 이 작품의 만듦새 이야기가 아니다(tg=other). 다만 두 판이 함께 쓰는 줄거리·인물 설계를 탓하면 이 작품 이야기(craft)이고, 각색 작품이 원작과 달라진 점을 짚으면 adapt.`;

const K_RULES = `
## 2. 속뜻(tn)
- 겉말이 불평·욕·항의여도 속뜻이 '좋다' 또는 '더 보고 싶다'면 critic이 아니다.
- critic 진짜 불만: tg가 craft·adapt·ops·price이고, 좋다는 말·부탁·투정 말투 없이 진지하게 탓할 때만. 질문 형태라도 바뀐 점·그림 변화·설정 모순을 탓하는 뜻이면 critic(cf=mid). 비꼬는 짧은 말도 작품을 탓하는 뜻이면 critic. 앞에 칭찬이 있어도 결론이 하차·실망이면 critic. tg가 story·reader·other인데 critic을 고르지 않는다.
  · 휴재·지각·분량(ops), 가격(price), 문장·오탈자(cw=text) 불만은 진지하면 critic으로 두되 tg·cw로 꼭 구분한다 — '불호'(서사·캐릭터·웹툰 작화)와 따로 센다.
- critic 아님(리디 규칙 엔진 오분류 전수 검토에서 나온 것): 인정한 뒤 칭찬('뻔하지만 재밌다', '답답하긴 한데 귀여워서 봐준다' — 뒤가 본심), 남의 반응을 전하는 말('호불호 갈린다던데', '평이 안 좋길래 걱정했는데'), '짧아서·연재 중이라·외전이 없어서 아쉽다'(= 더 보고 싶다, miss), 다른 낱말 속 글자(무서운의 '서운', 호불호의 '불호'), 작중 처지 서술('사이가 안 좋은'), 다른 작품 이야기.
- char 캐릭터 과몰입: tg=story인 화·욕·놀림·걱정·편들기·훈수·작중 선악 논쟁. 외모를 욕해도 작화 불만이 아니다.
- tease 애정 투정·반어·밈: 절단 투정('여기서 끊어요?'), 금지어 끼워 넣기('X 얘기 그만해' 하며 X 반복 = X가 좋다), '적당히 하세요', 외모를 '흉기·반칙'으로, 가격 죄책감('몇백 원에 이걸 봐도 되나' = 가성비 극찬), 하차 농담('하차각ㅋㅋ').
- miss 연재 아쉬움: 휴재·시즌 끝·분량·기다림에 대한 비명·애원·시위 구호('결사반대', '이제 무슨 낙으로 살아', '벌써 끝?'). 휴재·지각을 진지하게 비판하며 책임을 묻는 말(공지 없는 잦은 휴재, 약속을 안 지킴, '무책임하다')은 critic + tg=ops.
- nudge 애정 섞인 지적·진도 투정: 좋다는 말이나 부탁과 함께 하는 지적, 투정 말투의 진도 불평('진도 언제 나가요ㅠㅠ').
- praise 칭찬·환호: 짧은 감탄, 복귀 환영, 소장 자랑, '잘 만든 것 같다·괜찮네 + 계속 볼게', 원작·작중 명대사를 그대로 옮겨 적은 댓글(명대사 인용 = 칭찬).
- theory 추리·예측: 아직 일어나지 않은 구체적 사건을 짐작할 때만.
- fan 독자끼리·작품 밖: tg=reader인 반박·설명·옹호(작가를 옹호하면 praise), 다른 작품 이야기.
- other 단순·중립: 정보 질문, 탓하지 않는 설정 궁금증('왜 하필 그 무기를 골랐을까?'), 오타·맞춤법 제보(cw=text — 탓하는 말이 없으면 critic 아님), 맥락 없는 말.
- 여러 감정이 섞이면 주된 감정으로. 좋다는 말·부탁과 지적이 함께 있으면 nudge.
- ac: later = 끝나면 한꺼번에 보겠다는 식으로 연재를 따라 읽기를 멈추는 말 / churn = 이 작품을 진지하게 그만 보겠다는 말(하차·너무 어둡거나 잔인해서 못 보겠다).`;

// 예시는 시범 표본(SSS급·잊혀진 들판)에 없는 장르·상황으로 지어 썼다 — 채점할 댓글을 베끼면 점수가 부풀기 때문
const K_EXAMPLES = `
## 헷갈리는 짝 (겉은 비슷해도 판정이 다름 — 지어낸 예시)
- 악당 두목에게 '저놈 언제 벌 받냐 열받네' → story / char  ↔  '작가가 악당의 잘못을 자꾸 감싸줘서 보기 불편함' → craft / design / critic
- 독자끼리 '형이 먼저 배신했잖아' '아니 동생이 먼저 속였지' 하며 다툼 → story / char  ↔  '각성 이유가 한 줄도 없이 갑자기 최강이 됨, 앞뒤가 안 맞음' → craft / logic / critic
- 회귀한 주인공에게 '바보야 그쪽 아니라고' → story / char  ↔  '회귀했는데 주인공이 아는 걸 하나도 안 써먹네, 회귀물 맞나' → craft / design / critic
- 신입 사원 주인공에게 '답답해서 내가 출근하고 싶다ㅋㅋ' → story / char  ↔  '주인공 말투가 너무 오글거려서 못 보겠다, 여기서 접음' → craft / design / critic(ac=churn)
- '원작 그 결투를 컬러로 보니 소름' → adapt / praise  ↔  '원작 핵심 대사를 빼버리면 어떡하나' → adapt / adapt / critic
- '원작에선 형이었는데 왜 동생으로 바꿨지?' → adapt / adapt / critic(cf=mid)  ↔  '왜 하필 그 무기를 골랐을까?' → story / none / other
- 작중 대사를 그대로 옮겨 적은 댓글 → story / praise  ↔  '그 설정은 앞에서 이미 설명됐어요' (다른 독자에게) → reader / fan
- '휴재라니 일주일을 어떻게 버텨ㅠ' → ops / miss  ↔  '세 번째 연기인데 사과 한 줄 없네, 독자를 뭘로 보는지' → ops / ops / critic
- '다음 이야기 언제 나와요ㅠㅠ 궁금해 죽겠네' → craft / pace / nudge  ↔  '지난 화를 그대로 다시 보여주고 끝, 돈 내고 회상만 봤다' → craft / repeat / critic
- '몇백 원에 이런 걸 봐도 되나' → price / tease  ↔  '이 분량에 이 가격은 좀…' (진지) → price / price / critic
- '막내 너무 짠하다ㅠ 꼭 살아남아라' → story / char  ↔  '고문 장면이 너무 길고 잔인해서 접어요, 비위 약한 분들 비추' → craft / rating / critic(ac=churn)
- '다 끝나면 한 번에 정주행할게요' → ops / miss(ac=later)  ↔  '다음 주까지 어떻게 기다려ㅠ' → ops / miss(ac=stay)
- '요즘 인물 얼굴이 화마다 달라 보여요' → craft / art / critic(cf=mid)  ↔  '채색 미쳤다 배경화면 감' → craft / art / praise
- 남의 비판에 '그 장면이 있어야 결말이 산다'고 반박 → reader / fan  ↔  남의 비판에 동조해 같은 비판을 덧붙임 → craft / critic`;

// 니즈·상태 규칙은 1차 방식(CLASSIFY_SYSTEM)과 똑같이 — 속뜻 판정만 바꾸고 니즈 표시는 그대로 비교되게
const K_TAIL = "\n\n" + CLASSIFY_SYSTEM.slice(CLASSIFY_SYSTEM.indexOf("## 니즈(nd)"), CLASSIFY_SYSTEM.indexOf("## 상태(st)·행동(ac)")).trim() + `

## 상태(st)·행동(ac)
- st: met=이 화에서 채워져 좋아함 / ask=앞으로 이렇게 되길 바람 / lack=진짜 피로감('지친다', '언제까지 끌어', '또 이 패턴')이 있을 때만 / split=독자끼리 갈림이 드러남 / none=니즈 없음. 절단·기다림 반응엔 met 금지, 놀림·관전엔 lack 금지.
- ac: pay=소장·결제·원작 구매 언급 / stay=다음 화 기다림 / share=영업·주변 사람 언급 / later·churn은 위 기준 / none. '사랑해요·응원해요'만으로는 붙이지 않는다.

## 출력
입력의 댓글 번호(#n)마다 하나씩, 빠짐없이 JSON으로 답한다. 지어내지 않는다.`;

// opts.examples: 헷갈리는 짝 예시를 넣을지 (시험에서 따로 켜고 끈다)
export function classifySystemK(opts = {}) {
  return K_HEAD + K_TARGET + K_RULES + (opts.examples ? K_EXAMPLES : "") + K_TAIL;
}

// 카카오판 요청. opts: { examples, ctx: { work: '한 줄', ep: '한 줄', when: (c) => '작성 시점' } }
export function buildClassifyParamsK(cfg, work, ep, comments, textMax, themes, opts = {}) {
  const ctx = opts.ctx || null;
  const head = `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.bl ? " / BL" : ""}${work.genre ? " / " + work.genre : ""}\n` +
    (ctx && ctx.work ? `[작품 사실] ${ctx.work}\n` : "") +
    `[작품 소개] ${work.desc || "-"}\n[회차] ${ep.no}화${ep.part ? " (" + ep.part + ")" : ""} (공개 ${String(ep.reg || "").slice(0, 10)})` +
    (ctx && ctx.ep ? `\n[회차 사실] ${ctx.ep}` : "") + "\n\n" +
    `[반복 반응 목록]\n` + themes.map((t) => `${t.id} (${BUCKETS[t.bucket]}) ${t.label} — 기준: ${t.def}`).join("\n");
  const line = (c) => {
    const tags = [`좋아요 ${c.like}`, c.best ? "베스트" : "", c.sp ? "스포" : "", ctx && ctx.when ? ctx.when(c) : ""].filter(Boolean).join("·");
    return `#${c.n} [${tags}] ${cut(c.text.trim().replace(/\s+/g, " "), textMax)}`;
  };
  const body = head + "\n\n[댓글]\n" + comments.map(line).join("\n") + "\n\n위 댓글에 규칙대로 표시를 붙여 JSON으로 답하세요.";
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: [{ type: "text", text: classifySystemK(opts), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: CLASSIFY_SCHEMA_K } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// 진짜 불만 판정은 코드가 한다: 속뜻 critic이면서 작품(만듦새·각색)·운영·가격을 향한 것만.
//   work  = 서사·캐릭터·(웹툰) 작화·각색 — '불호' 묶음에 들어갈 수 있는 것은 이것뿐(사용자 원칙)
//   ops / price / text = 휴재·지각·분량 / 가격 / 문장·오탈자 — 진지해도 불호가 아니라 따로 세는 불만('많이 하는 말')
//   down = 작중 인물·다른 독자를 향한 critic — 세지 않고 남긴다(재확인 대상)
export function complaintOf(lab) {
  if (!lab) return null;
  if (!lab.tg) return lab.tn === "critic" ? "work" : null;   // 1차 방식(base)
  if (lab.tn !== "critic") return null;
  if (lab.tg === "ops" || lab.cw === "ops") return "ops";
  if (lab.tg === "price" || lab.cw === "price") return "price";
  if (lab.tg === "craft" || lab.tg === "adapt") return lab.cw === "text" ? "text" : "work";
  return "down";
}

// 불호 묶음 안전장치 (리디 rev_core.mjs rebucket 과 같은 기준, 사용자 결정 2026-10-11):
// 불호는 서사·캐릭터(웹툰은 작화까지)를 싫다는 말만. AI가 휴재·가격·문장 같은 불만을 불호로 묶었으면
// 이름에 서사·캐릭터 말이 없을 때 '많이 하는 말'로 옮긴다 (지시문이 먼저, 이건 놓친 것만).
const HIATUS_RE = /휴재|지각|연재\s*(주기|속도|일정)|업데이트|업뎃|공지/;
const NON_STORY_RE = /분량|가격|비싸|돈|결제|소장가|포인트|이벤트|소개\s*문구|작품\s*소개|뷰어|플랫폼|오류|오타|오탈자|교정|맞춤법|번역/;
const ART_RE = /작화|그림|채색|인체|작붕|연출|컷/;
const STORY_RE = /서사|전개|스토리|내용|이야기|설정|세계관|결말|개연성|고구마|반복|늘어|지루|캐릭터|인물|성격|주인공|남주|여주|공이|수가|악역|조연|관계|감정선|캐붕|수위|고어|피폐|불행|원작|각색|장르|늘리기|질질|흥미|재미|재탕|복붙/;
export function rebucket(t, webtoon) {
  if (t.bucket !== "dislike") return t;
  const label = t.label || "";
  const content = (x) => STORY_RE.test(x) || (webtoon && ART_RE.test(x));
  const other = (x) => NON_STORY_RE.test(x) || (!webtoon && ART_RE.test(x));
  if (HIATUS_RE.test(label)) return { ...t, bucket: "talk", moved: true };
  if (other(label) && !content(label)) return { ...t, bucket: "talk", moved: true };
  return t;
}

// ---------------- 2단계 뒤 재확인 (정밀도 개선 시험) ----------------
// 1차 시험: 확신도 '높음'으로 잡힌 불만은 90~98%가 진짜, '중간·낮음'은 절반 정도만 진짜였다.
// 그래서 확신 높음은 그대로 두고, 나머지 불만 후보만 더 꼼꼼한 모델이 한 번 더 판정한다(정답표 기준서와 같은 기준).
export const RECHECK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["n", "target", "complaint", "kind", "aspect"],
        properties: {
          n: { type: "integer" },
          target: { type: "string", enum: E(TARGETS) },
          complaint: { type: "string", enum: ["yes", "no", "border"] },
          kind: { type: "string", enum: ["work", "ops", "price", "none"] },
          aspect: { type: "string", enum: E(ASPECTS) }
        }
      }
    }
  }
};

export const RECHECK_SYSTEM = `당신은 카카오페이지 회차 댓글 가운데 '작품·운영·가격 불만 후보'로 잡힌 것을 다시 판정하는 검토자입니다. 기획 보고서에 '불만'으로 셀지를 정합니다. 너무 많이 세도(인물에게 화낸 말, 작중 논쟁을 불만으로) 안 되고, 너무 적게 세도(인물 이야기·질문·다른 독자에게 하는 경고 형태로 쓴 진짜 불만을 빼서) 안 됩니다.

댓글마다:
- target: 말이 향하는 곳 — ${list(TARGETS)}
- complaint: yes / no / border
- kind: yes·border면 work(작품·각색) / ops(운영) / price(가격), no면 none
- aspect: ${list(ASPECTS)}

## yes
- 작품을 만든 방식(전개·구성·개연성·인물 설계·장르 기대·작화·연출·문장·수위나 피폐 정도), 원작 대비 각색, 연재 운영(휴재·지각·분량·공지), 가격을 진지하게 탓함 — 좋다는 말·부탁·ㅠ·투정 말투 없이. 비꼬는 반어도 탓하는 뜻이면 yes.
- 질문 형태라도 탓하는 뜻이면 yes(원작과 바뀐 점을 따지는 질문, 그림이 달라졌다며 묻는 질문).
- 인물 이야기 형태라도 yes: 역할(주인공·남주·여주)로 인물 설계·장르 기대를 탓함, 여러 화에 걸친 전개를 탓함('N화째', '요즘 전개'), 작가·작품이 인물 잘못을 미화한다고 함.
- 다른 독자에게 하차·비추·수위 주의를 알림, 진지한 하차 선언. 앞에 칭찬이 있어도 결론이 하차·실망이면 yes.
- 휴재·지각을 진지하게 비판하며 책임을 물음. '결제가 아깝다', '이 분량에 이 가격'(진지).
## no
- 작중 인물에게 화·욕·훈수, 악역 미워하기, 작중 선악·종교·정치 논쟁, 작중 전개 예측·걱정 (아무리 진지해도).
- 인정한 뒤 칭찬('뻔하지만 재밌다'), 남의 반응을 전하는 말('호불호 갈린다던데'), '짧아서·연재 중이라·외전이 없어서 아쉽다'(더 보고 싶다).
- 애정 섞인 지적·진도 조르기(좋다는 말·ㅠ·부탁과 함께, 투정 말투). 휴재·완결에 대한 비명·애원.
- 명대사·원작 문장 인용, 칭찬, 작가 옹호, 다른 독자에게 반박·설명.
- 탓하지 않는 설정 궁금증·가벼운 의문, 오타 제보, 추리.
## border
- 둘 다로 읽혀 갈리는 것만(가벼운 말투의 지적, 반어인지 칭찬인지 모호함 등). 남발하지 않는다.

입력의 [회차 사실]은 판단에 참고만 한다. 댓글 번호(#n)마다 하나씩 JSON으로 답한다.`;

// 재확인 요청 하나: 같은 작품의 후보 댓글 여러 개. items: [{n, no, text, like, when, epLine}]
export function buildRecheckParams(cfg, work, items, textMax, versionNote) {
  const body = `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.genre ? " / " + work.genre : ""}` +
    (versionNote ? `\n[작품 사실] ${versionNote}` : "") + `\n[작품 소개] ${work.desc || "-"}\n\n[다시 판정할 댓글]\n` +
    items.map((c) => `#${c.n} [${c.no}화${c.epLine ? " · " + c.epLine : ""}${c.when ? " · " + c.when : ""} · 좋아요 ${c.like}] ${cut(c.text.trim().replace(/\s+/g, " "), textMax)}`).join("\n") +
    "\n\n위 댓글을 기준대로 다시 판정해 JSON으로 답하세요.";
  const req = {
    model: cfg.model,
    max_tokens: 16000,
    system: [{ type: "text", text: RECHECK_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: RECHECK_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

// ---------------- 3단계: 참고용 니즈 맵 (Sonnet) ----------------
export const NEEDS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["needs"],
  properties: {
    needs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["axis", "need", "state", "evidence", "size", "why", "refs"],
        properties: {
          axis: { type: "string", enum: E(AXES) },
          need: { type: "string" },
          state: { type: "string", enum: ["met", "lack", "ask", "split"] },
          evidence: { type: "string" },
          size: { type: "string", enum: ["상", "중", "하"] },
          why: { type: "string" },
          refs: REFS
        }
      }
    }
  }
};

export const NEEDS_SYSTEM = `당신은 웹소설·웹툰 기획자를 돕는 분석가입니다. 한 작품의 초반·중간·최근 회차 댓글(표시가 붙어 있음)과 니즈 통계를 받아 '니즈 맵'을 씁니다. 이 표는 참고용이며, 숫자와 근거가 분명한 것만 씁니다.

## 니즈 맵 한 줄 = (서사 축, 니즈, 상태, 근거 회차·장면, 크기, 크기 판단 이유, 근거 댓글 번호)
- need는 니즈 이름(목록 이름 그대로) 또는 신규 후보 이름.
- 상태: met(충족)/ask(요구 — 아직 안 채워진 바람)/lack(결핍 — 진짜 피로감·작품 불만이 근거일 때만)/split(호불호 갈림).
- 크기(상/중/하): 관련 댓글 수, 관련 댓글 좋아요 합, 여러 회차 반복 여부, 결제 신호 동반(돈이 움직인 니즈가 진짜 니즈)으로 판단하고 why에 숫자로 적는다. 회차별 전체 댓글 수는 공개 시기가 몇 년씩 달라 회차끼리 비교하지 않는다.
- 근거 댓글이 3개 미만인 니즈는 넣지 않는다. 8~12줄 이내.

## 규칙
- 캐릭터에게 화내기·놀리기·서운함(과몰입)은 불만이 아니다. 독자가 인물에게 시키는 행동(고백해라, 사과해라, 이제 사귀어라)은 ask(주문서)로 옮긴다.
- 휴재·완결·분량 아쉬움, 절단 투정은 니즈 결핍(lack)의 근거가 아니다.
- 감탄만 있는 댓글에 붙은 니즈는 과다 부착일 수 있으니 무게를 낮춘다.
- 숫자를 부풀리지 않는다. refs에는 실제로 그 내용을 말한 댓글 번호만.
- evidence·why에 댓글 문장을 옮겨 적지 않는다(따옴표 인용 포함). 회차·장면은 요약해서 쓰고, 근거는 refs 번호로만.
- 모든 문장은 쉬운 한국어로.`;

export function buildNeedsParams(cfg, text) {
  const req = {
    model: cfg.model,
    max_tokens: 32000,
    system: NEEDS_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 자료로 참고용 니즈 맵을 JSON으로 쓰세요." }],
    output_config: { format: { type: "json_schema", schema: NEEDS_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

export function parseJson(msg) {
  if (msg.stop_reason === "refusal") throw new Error("refusal");
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch (e) { throw new Error("JSON 해석 실패 (stop_reason=" + msg.stop_reason + ")"); }
}
