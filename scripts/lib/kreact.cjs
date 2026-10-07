/* 카카오페이지 회차 댓글 '반응' 분석 엔진 (KREACT)
 *
 * 수집기(scripts/collect-comments.mjs)가 쓰고, 사이트는 저장된 결과만 읽는다.
 * 반응 키·이름을 바꾸면 docs/app.js 의 REACTIONS(이름·색)도 같이 고칠 것.
 * 사전·규칙을 고치면 VERSION 을 올릴 것 — 수집기가 버전이 다른 작품을 다시 계산한다.
 *
 * 왜 따로 만드나:
 *   리디 리뷰 엔진(rabsa)은 '작품 평가'(그림·스토리·필력…)를 읽는다. 그런데 카카오 회차 댓글은
 *   평가가 아니라 그 화를 보며 쏟아내는 실시간 반응("솔음아 넌 어버이날에 카네이션 이자헌 드려라")이라
 *   rabsa 로는 100개 중 3개만 잡혔고, 잡힌 것도 '오타쿠'→오타(필력 부정), '유쾌연구소'(지명)→유머
 *   같은 오탐이 대부분이었다(2026-10 실측). 그래서 '어떤 감정으로 반응했나'를 읽는다.
 *   한 댓글이 여러 반응을 가질 수 있다 (ㅋㅋㅋ 울면서 웃음 = 웃음 + 감동).
 *
 * 집계 형태 (사이트에 저장되는 값과 같다):
 *   { total, used, reactions: {키: [댓글수, 공감합]}, examples: {키: [[발췌, 공감, 회차]]}, words: [[말, 수]] }
 */
module.exports = (function () {
  var VERSION = "1";

  // 각 반응: 정규식 목록 (하나라도 맞으면 그 반응). 접두·활용형을 넓게 잡는다.
  var reactions = [
    // 오탐 방지: '폭탄이 터졌' 같은 '터졌' 단독, '비웃' 은 웃음이 아님
    { key: "laugh",   label: "웃음",       re: [/[ㅋ]{3,}/, /[ㅎ]{3,}/, /(?<!비)(웃겨|웃기|웃김)|개웃|존웃|빵터|빵 터|뿜었|웃음벨|웃참|미친ㅋ|킹받|ㅋㅋ+\s*$|🤣|😂|😆/] },
    { key: "sad",     label: "감동·슬픔",  re: [/[ㅠㅜ]{2,}/, /울컥|눈물|울었|울어|울고|오열|먹먹|슬프|슬퍼|슬픈|짠하|짠해|찡하|찡해|마음\s?아프|마음이\s?아파|가슴\s?아프|감동|여운|😭|😢|🥲/] },
    { key: "love",    label: "설렘·애정",  re: [/설레|설렘|심쿵|두근|귀여|귀엽|기여워|졸귀|사랑스|사랑해|사랑한|최애|좋아해|달달|꽁냥|💕|❤|♥|😍|🥰|💘/] },
    // '영화나·만화나·대화나·변화나' 의 '화나' 는 제외
    { key: "anger",   label: "분노·답답",  re: [/열받|열 받|빡치|빡쳐|빡침|개빡|(?<![영만대변전동])화나|화가\s?나|짜증|답답|고구마|속터|혈압|어이없|어이가\s?없|양심\s?없|미친놈|미친년|나쁜놈|쓰레기|😡|🤬/] },
    { key: "chill",   label: "소름·긴장",  re: [/소름|무서|무섭|오싹|섬뜩|으스스|쫄깃|긴장|숨막|숨 막|등골|덜덜|오금|공포|😱|🥶/] },
    { key: "shock",   label: "충격·반전",  re: [/헐+|대박|반전|충격|와\s?씨|미쳤|미친\s|미쳤다|실화|말도\s?안|뭐야|뭐임|뭐지|미친 전개|소리\s?질러|😮|😲|🤯/] },
    // '지켜보다'(관망)·무협의 '무사'(武士)는 제외
    { key: "cheer",   label: "응원·걱정",  re: [/제발|살려|죽지\s?마|죽으면\s?안|죽지\s?말|안\s?돼|지켜\s?(줘|주|야|내|낼|라)|힘내|응원|다치지|무사히|무사하|무사해|무사했|행복하자|행복해라|행복해야|살아\s?남|버텨|부디/] },
    // '조회수' 의 '회수' 는 제외. '그럼/그러니까' 같은 흔한 연결어는 너무 넓어서 뺐다
    { key: "theory",  label: "추리·떡밥",  re: [/떡밥|복선|추측|설마|정체가|정체는|아닐까|인가\?|건가\?|거\s?아냐|거\s?아님|거\s?같은데|것\s?같은데|이유가|(?<!조)회수/] },
    { key: "praise",  label: "칭찬·감탄",  re: [/최고|명작|갓작|레전드|천재|필력|미쳤다|완벽|재밌|재미있|존잼|꿀잼|개잼|작가님\s?(감사|사랑|최고|천재)|감사합니다|👍|👏/] },
  ];

  // 자주 나온 말 후보에서 뺄 흔한 말
  var STOP = {};
  ("그리고 그래서 하지만 그런데 그러나 정말 진짜 너무 아주 완전 조금 약간 다시 계속 이거 저거 그거 여기 저기 거기 " +
   "이건 그건 저건 하나 근데 인데 라고 라는 하는 되는 있는 없는 같은 많은 좋은 보고 이런 저런 어떤 무슨 진심 " +
   "엄청 이렇게 그렇게 저렇게 어떻게 제일 그냥 역시 이제 아직 지금 나중 처음 마지막 다음 이번 우리 제가 저는 " +
   "나는 내가 너무나 그러니까 그럼 아니 아니야 아니고 그게 이게 저게 뭔가 뭔데 왜케 이번화 다음화 오늘 회차 " +
   "작가님 작품 소설 웹툰 댓글 사람 생각 느낌 부분 정도 때문 그래도 하고 해서 했는데 하는데 같아 같은데")
    .split(/\s+/).forEach(function (w) { if (w) STOP[w] = 1; });

  function tokens(text) {
    var seen = {}, out = [];
    (text || "").split(/[^가-힣A-Za-z0-9]+/).forEach(function (raw) {
      var w = raw.trim();
      if (w.length < 2 || w.length > 8) return;
      w = w.replace(/(이었|였|하는|해서|하고|한테|에게|에서|으로|까지|부터|이라|라서|네요|어요|아요|습니다|입니다|는데|지만|면서|다가|이다|하다|이야|이랑|아|야)$/, "");
      w = w.replace(/(은|는|이|가|을|를|의|에|도|만|과|와|랑|께|요|님)$/, "");
      if (w.length < 2 || STOP[w] || /^\d/.test(w) || /^[ㄱ-ㅎㅏ-ㅣ]+$/.test(w)) return;
      if (seen[w]) return;
      seen[w] = 1;
      out.push(w);
    });
    return out;
  }

  // 카카오는 이모티콘 댓글을 본문에 '(이모티콘)'이라는 자리표시로 남긴다 — 분석에서 뺀다
  function clean(text) { return (text || "").replace(/\(이모티콘\)/g, " ").trim(); }

  // 댓글 하나 → 반응 키 목록
  function classify(text) {
    var t = clean(text);
    var out = [];
    reactions.forEach(function (r) {
      for (var i = 0; i < r.re.length; i++) if (r.re[i].test(t)) { out.push(r.key); break; }
    });
    return out;
  }

  function excerpt(text) {
    var c = (text || "").replace(/\s+/g, " ").trim();
    return c.length > 110 ? c.slice(0, 108) + "…" : c;
  }

  // comments: [{text, likes, ep}] → 집계. 반응별 예시는 공감 많은 순 3개.
  function analyze(comments) {
    var agg = { total: 0, used: 0, reactions: {}, examples: {}, kwf: {} };
    (comments || []).forEach(function (c) {
      var text = clean(c.text);
      if (!text) return;                       // 이모티콘만 단 댓글은 읽을 내용이 없다
      agg.total++;
      tokens(text).forEach(function (w) { agg.kwf[w] = (agg.kwf[w] || 0) + 1; });
      var keys = classify(text);
      if (!keys.length) return;
      agg.used++;
      keys.forEach(function (k) {
        var s = agg.reactions[k] || (agg.reactions[k] = [0, 0]);
        s[0]++; s[1] += c.likes || 0;
        var ex = agg.examples[k] || (agg.examples[k] = []);
        ex.push([excerpt(text), c.likes || 0, c.ep || ""]);
        ex.sort(function (a, b) { return b[1] - a[1]; });
        if (ex.length > 3) ex.length = 3;
      });
    });
    return agg;
  }

  function topWords(kwf, n) {
    return Object.keys(kwf || {}).map(function (w) { return [w, kwf[w]]; })
      .filter(function (p) { return p[1] >= 2; })
      .sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); })
      .slice(0, n || 20);
  }

  // 저장용 요약 (kwf 는 상위 단어만 남긴다)
  function pack(agg, nWords) {
    return { total: agg.total, used: agg.used, reactions: agg.reactions, examples: agg.examples, words: topWords(agg.kwf, nWords || 20) };
  }

  return { VERSION: VERSION, reactions: reactions, classify: classify, clean: clean, analyze: analyze, pack: pack, topWords: topWords, tokens: tokens };
})();
