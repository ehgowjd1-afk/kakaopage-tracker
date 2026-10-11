/* 회차 요약·작품 분석·독자 분석 — AI에 주는 지시문과 답 형식 (ep_ai.mjs가 쓴다)
 *
 * 회차 본문은 읽지 않는다(대부분 유료·저작권). 그 회차의 공감 많은 댓글만 읽고 '댓글로 짐작한 이 화 내용'을 쓴다.
 * 결과는 사이트에 공개된다: 요약·분석 글 + 요약을 뒷받침하는 베스트 댓글 2~3개(원문, 사용자 결정 2026-10-11).
 * 닉네임은 어디에도 넣지 않는다.
 */
import { cut } from "./kakao_cmt.mjs";

export const MOODS = { laugh: "웃음", touch: "감동·눈물", flutter: "설렘", anger: "인물에게 분노", chill: "소름·긴장", shock: "충격·반전", cheer: "응원", theory: "추리", complain: "작품·연재 불만", wait: "기다림·아쉬움" };
const E = (o) => Object.keys(o);
const list = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ");

export const EP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["sum", "react", "mood", "ex", "hot"],
  properties: {
    sum: { type: "string" },
    react: { type: "string" },
    mood: { type: "array", items: { type: "string", enum: E(MOODS) } },
    ex: { type: "array", items: { type: "integer" } },
    hot: { type: "string" }
  }
};

export const EP_SYSTEM = `당신은 카카오페이지 웹툰·웹소설 한 회차의 '공감 많은 댓글'을 읽고, 그 회차에 무슨 일이 있었는지와 독자 반응을 짧게 정리합니다. 회차 본문은 볼 수 없으니 댓글로 짐작합니다.

칸:
- sum: 댓글로 짐작한 이 화의 주요 사건·장면, 45자 안팎. 인물 이름을 써도 된다. 원작 독자가 미리 말한 '앞으로의 전개'(스포일러)는 이 화 내용으로 쓰지 않는다. 댓글이 사건을 말하지 않으면 무엇에 대한 화인지 알 수 있는 만큼만 쓰고, 정말 모르면 "댓글로는 내용을 알기 어려움".
- react: 독자 반응의 핵심, 45자 안팎 — 무엇에 어떻게 반응했나(예: 반전에 놀람, 악역에게 분노, 작화 감탄, 휴재 아쉬움).
- mood: 많이 보인 반응 1~3개 — ${list(MOODS)}. 인물에게 화내는 것은 anger(작품 불만 아님), 작품·연재 운영을 진지하게 탓하는 것만 complain.
- ex: sum·react를 가장 잘 보여 주는 댓글 번호 2~3개. 스포일러 표시가 있거나 앞 전개를 미리 말하는 댓글은 고르지 않는다.
- hot: 이 화가 특별히 화제였던 이유가 댓글에 드러나면 한 줄(30자 안팎), 아니면 "".
규칙: sum·react·hot에 댓글 문장을 그대로 옮기지 않는다(자기 말로 요약). 지어내지 않는다. 쉬운 한국어.`;

export function buildEpParams(cfg, work, ep, comments, textMax) {
  const head = `[작품] ${work.title} / ${work.webtoon ? "웹툰" : "웹소설"}${work.genre ? " / " + work.genre : ""}\n[작품 소개] ${work.desc || "-"}\n` +
    `[회차] ${ep.label} (공개 ${String(ep.reg || "").slice(0, 10)}${ep.total != null ? `, 댓글 ${ep.total}개` : ""}${ep.ratio ? `, 앞뒤 회차의 ${ep.ratio}배` : ""}${ep.free ? ", 무료 회차" : ""})`;
  const body = head + "\n\n[공감 많은 댓글] 번호 [좋아요·스포] 본문\n" +
    comments.map((c, i) => `#${i + 1} [${c.like}${c.sp ? "·스포" : ""}] ${cut(c.text.replace(/\s+/g, " "), textMax)}`).join("\n") +
    "\n\n이 회차를 규칙대로 정리해 JSON으로 답하세요.";
  const req = {
    model: cfg.model, max_tokens: 8000,
    system: [{ type: "text", text: EP_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: body }],
    output_config: { format: { type: "json_schema", schema: EP_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}

const POINT = { type: "object", additionalProperties: false, required: ["point", "eps"], properties: { point: { type: "string" }, eps: { type: "array", items: { type: "string" } } } };
export const WORK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["work", "reader"],
  properties: {
    work: {
      type: "object", additionalProperties: false, required: ["overview", "strengths", "weaknesses", "turning", "drops"],
      properties: {
        overview: { type: "string" },
        strengths: { type: "array", items: POINT },
        weaknesses: { type: "array", items: POINT },
        turning: { type: "array", items: POINT },
        drops: { type: "array", items: POINT }
      }
    },
    reader: {
      type: "object", additionalProperties: false, required: ["traits", "live", "source", "money", "community"],
      properties: {
        traits: { type: "array", items: POINT },
        live: { type: "string" }, source: { type: "string" }, money: { type: "string" }, community: { type: "string" }
      }
    }
  }
};

export const WORK_SYSTEM = `당신은 웹툰·웹소설 기획자를 돕는 분석가입니다. 한 작품의 회차별 댓글 수 흐름, 회차마다 '댓글로 짐작한 내용·독자 반응', 독자 행동 통계를 받아 '작품 분석'과 '독자 분석'을 씁니다. 회차 본문은 읽지 않았으므로 모두 '댓글로 본' 분석입니다.

## 작품 분석 (work)
- overview: 이 작품이 독자에게 어떤 재미로 읽히는지 한두 문장(100자 안팎).
- strengths: 독자가 반복해서 좋아한 요소 2~5개 — point(한 줄)와 근거 회차(eps, 예: "39화").
- weaknesses: 독자가 아쉬워하거나 탓한 요소 0~4개 — 작품·연재 운영에 대한 것만. 인물에게 화낸 것은 약점이 아니다(몰입 신호). 근거가 약하면 비워 둔다.
- turning: 댓글이 크게 늘거나 반응이 바뀐 화제·전환점 회차 2~5개 — point에 무슨 일이었는지.
- drops: 댓글이 크게 줄어든 지점 0~3개 — point에 짐작되는 이유(무료→유료 경계, 휴재, 전개 피로 등). 이유를 모르면 '이유는 댓글로 알기 어려움'.

## 독자 분석 (reader)
- traits: 이 작품 댓글에서 보이는 독자 특징 2~4개(예: 원작 독자가 많아 장면 재현을 비교함, 추리 댓글이 많음, 인물 별명 놀이) — point와 근거 회차.
- live: 실시간으로 따라 읽는 독자와 늦게 몰아 읽는 독자 — 통계(공개 하루 안 댓글 비율 등)를 근거로 한두 문장.
- source: 원작 독자 비중 — 스포일러 비율·원작 언급으로 한두 문장(원작이 없으면 그렇게 씀).
- money: 결제·소장·하차 언급 — 통계와 회차 반응으로 한두 문장.
- community: 댓글 분위기 — 답글 수, 밈·놀이, 독자끼리 토론 정도로 한두 문장.
나이·성별은 알 수 없으므로 쓰지 않는다.

## 규칙
- 숫자는 주어진 통계만 쓴다. 지어내지 않는다. 회차 근거는 입력에 있는 회차만.
- 댓글 문장을 따옴표로 옮겨 적지 않는다. 쉬운 한국어, 짧게.`;

export function buildWorkParams(cfg, text) {
  const req = {
    model: cfg.model, max_tokens: 16000,
    system: WORK_SYSTEM,
    messages: [{ role: "user", content: text + "\n\n위 자료로 작품 분석과 독자 분석을 JSON으로 쓰세요." }],
    output_config: { format: { type: "json_schema", schema: WORK_SCHEMA } }
  };
  if (cfg.effort) req.output_config.effort = cfg.effort;
  return req;
}
