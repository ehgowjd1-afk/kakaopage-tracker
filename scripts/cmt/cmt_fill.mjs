/* 카카오 회차 댓글 분석 — 1-2단계: 빠진 반복 반응 채우기 (cmt_pilot.mjs·cmt_exp1.mjs 가 같이 씀)
 *
 * 1단계 묶음은 실행마다 구성이 흔들린다(같은 작품을 두 번 돌리면 한쪽은 큰 반응 묶음을 통째로 빠뜨림 — 2026-10-12 검토).
 * 그래서 2단계(댓글마다 묶음 표시) 뒤에
 *   ㉠ Sonnet: '어느 묶음에도 안 들어간 댓글'(내용 있는 것, 회차별로 고르게)을 읽고 되풀이되는 반응을 새 묶음으로 보태거나,
 *      회차·장면에 너무 좁게 묶인 기존 묶음의 기준을 넓힌다.
 *   ㉡ Haiku: 묶음이 없던 댓글만 보완된 목록으로 묶음 번호를 다시 붙인다.
 * 확신 '낮음'으로 붙은 묶음은 검토에서 절반 넘게 틀려 2단계에서 떼고(pilot/exp1 쪽), 여기서 한 번 더 본다.
 */
import { cut } from "./kakao_cmt.mjs";
import * as AI from "./cmt_ai.mjs";
import { isFiller } from "../lib/cmt-filter.mjs";
import { versionLine } from "./cmt_ctx.mjs";

export const FILL = { maxComments: 320, maxChars: 42000, textMax: 150, minLen: 6, labelChunk: 40, maxNew: 6, maxWiden: 4 };

// 묶음 없는 댓글 가운데 내용 있는 것 — labelOf(c) 가 그 댓글의 표시(lab)를 돌려준다
export function unbundled(sample, labelOf) {
  return sample.filter((c) => {
    const l = labelOf(c);
    return l && !(l.th || []).length && c.text && !isFiller(c.text) && c.text.replace(/\s+/g, "").length >= FILL.minLen;
  });
}

// ㉠ 입력: 이미 있는 묶음(붙은 수) + 묶음 없는 댓글(회차별로 고르게, 좋아요 많은 것 먼저)
export function fillText(w, themes, countOf, cands) {
  const byEp = new Map();
  for (const c of [...cands].sort((a, b) => b.like - a.like)) {
    if (!byEp.has(c.no)) byEp.set(c.no, []);
    byEp.get(c.no).push(c);
  }
  const eps = [...byEp.keys()].sort((a, b) => a - b);
  const picked = [];
  let chars = 0;
  for (let i = 0; picked.length < FILL.maxComments; i++) {
    let any = false;
    for (const no of eps) {
      const c = byEp.get(no)[i];
      if (!c) continue;
      any = true;
      const len = Math.min(c.text.length, FILL.textMax) + 24;
      if (chars + len > FILL.maxChars) continue;
      picked.push(c);
      chars += len;
      if (picked.length >= FILL.maxComments) break;
    }
    if (!any) break;
  }
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.genre ? " / " + w.genre : ""}`];
  const vl = versionLine(w);
  if (vl) lines.push(`[작품 사실] ${vl}`);
  lines.push("", "[이미 있는 묶음] 번호 (분류) 이름 — 기준 · 붙은 댓글 수");
  for (const t of themes) lines.push(`${t.id} (${AI.BUCKETS[t.bucket]}) ${t.label} — 기준: ${t.def} · ${countOf(t.id)}개`);
  lines.push("", `[묶음 없는 댓글] 전체 ${cands.length}개 가운데 ${picked.length}개 (회차별로 고르게, 좋아요 많은 것 먼저). 번호 [좋아요·속뜻] 본문`);
  const pickedByEp = new Map();
  for (const c of picked) { if (!pickedByEp.has(c.no)) pickedByEp.set(c.no, []); pickedByEp.get(c.no).push(c); }
  for (const no of [...pickedByEp.keys()].sort((a, b) => a - b)) {
    lines.push(`== ${no}화 ==`);
    for (const c of pickedByEp.get(no)) lines.push(`#${c.n} [${c.like}·${AI.TONES[c.tn] || "-"}] ${cut(c.text.trim().replace(/\s+/g, " "), FILL.textMax)}`);
  }
  return { text: lines.join("\n"), picked: picked.length };
}

// ㉠ 답 반영: 넓힌 기준은 바꿔 끼우고, 새 묶음은 뒤에 번호를 이어 붙인다 (불호 안전장치 rebucket 그대로)
export function mergeFill(themes, parsed, validNs, webtoon) {
  const out = themes.map((t) => ({ ...t }));
  const byId = new Map(out.map((t) => [t.id, t]));
  let widened = 0;
  for (const x of (parsed.widen || []).slice(0, FILL.maxWiden)) {
    const t = byId.get(String(x.id || "").trim().toUpperCase());
    if (!t || !x.def) continue;
    t.label = cut(x.label || t.label, 60);
    t.def = cut(x.def, 160);
    t.widened = true;
    widened++;
  }
  const maxId = Math.max(0, ...out.map((t) => Number(String(t.id).slice(1)) || 0));
  const added = (parsed.themes || []).slice(0, FILL.maxNew).map((t, i) => AI.rebucket({
    id: "T" + (maxId + i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
    seed: [...new Set((t.refs || []).filter((n) => validNs.has(n)))].slice(0, 5), added: true
  }, webtoon));
  return { themes: [...out, ...added], added: added.length, widened };
}

// ㉡ 다시 표시할 묶음 나누기
export function fillLabelChunks(cands) {
  const out = [];
  for (let k = 0; k < cands.length; k += FILL.labelChunk) out.push(cands.slice(k, k + FILL.labelChunk));
  return out;
}

// ㉡ 답 반영: 묶음이 없던 댓글에만, 불호 묶음은 작품 불만(cx=work)일 때만
export function applyFillLabels(parsed, validNs, themes, labelOfN) {
  const themeOf = new Map(themes.map((t) => [t.id, t]));
  let tagged = 0;
  for (const it of parsed.comments || []) {
    if (!validNs.has(it.n)) continue;
    validNs.delete(it.n);
    const lab = labelOfN(it.n);
    if (!lab || (lab.th || []).length) continue;
    const th = [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))]
      .filter((id) => themeOf.get(id).bucket !== "dislike" || lab.cx === "work").slice(0, 2);
    if (!th.length) continue;
    lab.th = th;
    lab.fill = 1;
    tagged++;
  }
  return tagged;
}
