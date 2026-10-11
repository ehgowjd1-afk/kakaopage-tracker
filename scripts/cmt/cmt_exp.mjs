/* 카카오 회차 댓글 분석 — 정밀도 시험 실행기 (손으로만 돈다, 매일 수집과 무관)
 *
 * 시범 때 고른 댓글 목록(state/cmt/{이름}.json — 댓글 번호·uid·시각·좋아요·고정한 묶음만, 원문 없음)을
 * 카카오에서 uid로 다시 받아, 같은 댓글에 여러 방식(변형)을 '한 번의 일괄'로 돌린다.
 * 1단계 묶음은 목록에 고정된 것을 쓰므로 2단계(댓글 표시) 방식끼리만 비교된다.
 * 결과(댓글 번호별 표시 — 원문 없음)는 하루 보관 실행 결과물로 올리고, 채점은 내 컴퓨터에서 원문과 맞춰 한다.
 *
 *   node scripts/cmt/cmt_exp.mjs --spec state/cmt/pilot1.json --variants base,base,K,KC,KCF --out cmt_exp_out.json
 *        [--cap-usd 1.5] [--limit-usd 30] [--wait-min 100] [--summary FILE]
 * 변형 이름: base = 1차 시범 그대로 / K = 대상·측면 칸 + 카카오판 속뜻 규칙 / C = 공짜 맥락(휴재·원작·작성 시점) /
 *            F = 헷갈리는 짝 예시. 뒤에 @low·@high 를 붙이면 Haiku 생각량을 바꾼다(기본 medium, 예: KCF@low).
 * CMT_MOCK=1 이면 AI 대신 가짜 답 (돈 안 듦).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fetchWork, fetchEpisodeComments, KakaoBlocked, cut } from "./kakao_cmt.mjs";
import * as K from "./kakao_cmt.mjs";
import { CFG } from "./cmt_config.mjs";
import * as AI from "./cmt_ai.mjs";
import { complaintOf } from "./cmt_ai.mjs";
import { episodeContext, episodeLine, versionLine, commentWhen } from "./cmt_ctx.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const STATE = "state/ai_state.json";
const HAIKU = "claude-haiku-5-5";
const EST_PER_COMMENT = 0.00008;   // 변형 1개 × 댓글 1개 예상(일괄, 여유 있게 — 1차 실측 $0.000039)
const MOCK = !!process.env.CMT_MOCK;

const args = { spec: null, variants: [], limitUsd: 30, capUsd: 1.5, waitMin: 100, out: "cmt_exp_out.json", summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--spec") args.spec = v();
  else if (k === "--variants") args.variants = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["limitUsd", "capUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (!args.spec || !/^state\/cmt\/[\w-]+\.json$/.test(args.spec) || !existsSync(args.spec)) throw new Error("--spec 은 state/cmt/ 안의 표본 목록 파일");
// 변형 이름 해석: 글자 = 켜는 것, @ 뒤 = 생각량
const VARIANTS = args.variants.map((name) => {
  const m = name.match(/^(base|K[CF]*)(?:@(low|medium|high))?$/);
  if (!m) throw new Error("모르는 변형: " + name + " (base, K, KC, KF, KCF … 뒤에 @low·@high)");
  const letters = m[1];
  return { name, base: letters === "base", ctx: letters.includes("C"), examples: letters.includes("F"), effort: m[2] || "medium" };
});
if (!VARIANTS.length || VARIANTS.length > 8) throw new Error("--variants 는 1~8개");
const T_START = Date.now();
const MONTH = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const log = (...a) => console.log(...a);

// ---------------- 원문 다시 받기 ----------------
const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const report = { version: 1, kind: "cmt-exp", spec: args.spec, generated_at: new Date().toISOString(), variants: VARIANTS, cfg: { textMax: CFG.textMax, chunk: CFG.chunk },
  works: [], usage: {}, cost: {}, batches: {}, notes: [], requests: 0 };
const works = [];

async function load(sw) {
  const live = await fetchWork(sw.id);
  const textByUid = new Map();
  for (const e of sw.episodes) {
    try {
      const r = await fetchEpisodeComments(sw.id, e.id, [], CFG.poolPages);
      for (const c of [...r.likeList, ...r.pool]) textByUid.set(String(c.cid), c.text);
    } catch (err) {
      if (err instanceof KakaoBlocked) throw err;   // 막혔으면 바로 멈춤
      report.notes.push(`${sw.title} ${e.no}화 댓글을 다시 받지 못함: ${String(err.message).slice(0, 80)} — 그 회차는 모든 변형에서 뺌`);
    }
  }
  const sample = [];
  let missing = 0;
  for (const c of sw.comments) {
    const text = textByUid.get(String(c.cid));
    if (text == null || !text.trim()) { missing++; continue; }
    sample.push({ ...c, text });
  }
  if (missing) report.notes.push(`${sw.title}: 다시 받을 때 못 찾은 댓글 ${missing}개(삭제·밀려남) — 모든 변형에서 뺌`);
  const ec = episodeContext(live.episodes);
  log(`■ ${sw.title} — 댓글 ${sample.length}개 다시 받음 (못 찾음 ${missing})`);
  return { ...sw, desc: live.desc, sample, ec };
}

// ---------------- 요청 만들기 ----------------
const themesOf = (w) => w.themes;
const chunkNs = new Map();   // custom_id → 그 요청에 넣은 댓글 번호들
function requestsFor(v, vi) {
  const reqs = [];
  works.forEach((w, wi) => {
    const workBlock = { title: w.title, webtoon: w.webtoon, bl: w.bl, desc: w.desc, genre: w.genre };
    for (const e of w.episodes) {
      const cs = w.sample.filter((c) => c.ep === e.id);
      const ec = w.ec.get(String(e.id));
      const ctx = v.ctx ? { work: versionLine(w), ep: episodeLine(ec), when: (c) => commentWhen(c.at, e, ec) } : null;
      for (let k = 0; k < cs.length; k += CFG.chunk) {
        const part = cs.slice(k, k + CFG.chunk);
        const cfg = { model: HAIKU, effort: v.effort };
        const params = v.base
          ? AI.buildClassifyParams(cfg, workBlock, e, part, CFG.textMax, themesOf(w))
          : AI.buildClassifyParamsK(cfg, workBlock, e, part, CFG.textMax, themesOf(w), { examples: v.examples, ctx });
        const custom_id = `v${vi}-h-${wi}-${e.id}-${k / CFG.chunk}`;
        chunkNs.set(custom_id, new Set(part.map((c) => c.n)));
        reqs.push({ custom_id, params });
      }
    }
  });
  return reqs;
}

// AI가 쓴 짧은 글(nn)이 댓글 원문과 12자 넘게 겹치면 가린다 (결과 파일에 원문이 실리지 않게)
function scrubberFor(w) {
  const norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const c of w.sample) { const t = norm(c.text); for (let i = 0; i + 12 <= t.length; i++) grams.add(t.slice(i, i + 12)); }
  return (s) => { const t = norm(s); for (let i = 0; i + 12 <= t.length; i++) if (grams.has(t.slice(i, i + 12))) return "(가림)"; return s; };
}

function applyAll(out) {
  let usd = 0;
  const labels = VARIANTS.map(() => works.map(() => ({})));
  const failed = VARIANTS.map(() => 0);
  for (const [cid, res] of out) {
    const m = cid.match(/^v(\d+)-h-(\d+)-/);
    if (!m) continue;
    const vi = Number(m[1]), wi = Number(m[2]);
    const w = works[wi], v = VARIANTS[vi];
    if (!w || !v || res.type !== "succeeded") { if (v) failed[vi]++; continue; }
    const u = res.message.usage || {};
    const c$ = MOCK ? 0 : rawCost(HAIKU, u);
    usd += c$;
    const U = (report.usage[v.name + "#" + vi] ||= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });
    U.in += u.input_tokens || 0; U.out += u.output_tokens || 0; U.cacheRead += u.cache_read_input_tokens || 0; U.cacheWrite += u.cache_creation_input_tokens || 0; U.usd += c$;
    let parsed;
    try { parsed = AI.parseJson(res.message); } catch { failed[vi]++; continue; }
    const themeOf = new Map(w.themes.map((t) => [t.id, t]));
    // 그 요청에 넣은 댓글 번호만, 처음 나온 것만 받는다 (번호를 잘못 단 답이 다른 묶음의 표시를 덮어쓰지 않게)
    const valid = new Set(chunkNs.get(cid) || []);
    const sc = scrubberFor(w);
    for (const it of parsed.comments || []) {
      if (!valid.has(it.n)) continue;
      valid.delete(it.n);
      const th0 = [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 2);
      const lab = { tn: it.tn, th0, cf: it.cf, ac: it.ac, nd: [...new Set(it.nd || [])].slice(0, 3), st: it.st, nn: sc(cut(it.nn, 20)) };
      if (!v.base) { lab.tg = it.tg; lab.cw = it.cw; }
      lab.cx = complaintOf(lab);
      // '불호' 묶음엔 진짜 불만만: 1차 방식은 critic·확신 낮지 않음, 카카오판은 코드 판정(작품·운영·가격)
      lab.th = th0.filter((id) => themeOf.get(id).bucket !== "dislike" || (v.base ? lab.tn === "critic" && lab.cf !== "lo" : ["work", "ops", "price"].includes(lab.cx)));
      labels[vi][wi][it.n] = lab;
    }
  }
  return { usd, labels, failed };
}

// ---------------- 돈 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  mkdirSync("state", { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
function mockAnswer(customId, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  const vi = Number(customId.match(/^v(\d+)/)[1]);
  const base = VARIANTS[vi].base;
  return { comments: ns.map((n, i) => ({ n, th: [["T1"], ["T2"], ["T3", "T4"], [], ["T1"]][i % 5], tn: ["praise", "char", "critic", "critic", "other"][(i + vi) % 5],
    nd: [], st: "none", nn: "", ac: ["none", "stay", "later", "none"][i % 4].replace("later", base ? "none" : "later"), cf: ["hi", "mid", "lo"][i % 3],
    ...(base ? {} : { tg: ["story", "craft", "ops", "story", "reader"][i % 5], cw: ["none", "pace", "ops", "none", "none"][i % 5] }) })) };
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

function save(labels) {
  report.requests = K.requests;
  report.works = works.map((w, wi) => ({
    id: w.id, title: w.title, ns: w.sample.map((c) => c.n),
    labels: labels ? VARIANTS.map((_, vi) => labels[vi][wi]) : null,
  }));
  writeFileSync(args.out, JSON.stringify(report));
}

let result = null;
try {
  for (const sw of spec.works) works.push(await load(sw));
  const nC = works.reduce((t, w) => t + w.sample.length, 0);
  if (!nC) throw new Error("다시 받은 댓글이 없어 AI를 부르지 않습니다");
  const est = nC * VARIANTS.length * EST_PER_COMMENT;
  const spent0 = state.spend[MONTH] || 0;
  log(`댓글 ${nC}개 × 변형 ${VARIANTS.length}개(${VARIANTS.map((v) => v.name).join(", ")}) — 예상 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용 $${spent0.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 이번 상한을 넘어 보내지 않습니다");
  if (spent0 + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");
  const reqs = VARIANTS.flatMap((v, vi) => requestsFor(v, vi));
  await stage(`2단계 변형 ${VARIANTS.length}개(Haiku)`, reqs, est, "variants", (out) => {
    result = applyAll(out);
    result.failed.forEach((f, vi) => { if (f) report.notes.push(`${VARIANTS[vi].name}: 실패한 요청 ${f}개`); });
    return result.usd;
  });
} catch (e) {
  report.error = e instanceof KakaoBlocked ? "카카오가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  save(result && result.labels);
  const lines = [`## 회차 댓글 정밀도 시험`, `- 표본: ${args.spec} (${works.map((w) => `${w.title} ${w.sample ? w.sample.length : 0}개`).join(", ")})`,
    `- 변형: ${VARIANTS.map((v) => v.name).join(", ")}`, `- 카카오 요청 ${K.requests}번`,
    ...(result ? VARIANTS.map((v, vi) => {
      const all = works.flatMap((_, wi) => Object.values(result.labels[vi][wi]));
      const cnt = (k) => all.filter((l) => l.cx === k).length;
      const u = report.usage[v.name + "#" + vi] || { usd: 0 };
      return `- ${v.name}: 표시 ${all.length}개 · 작품 불만 ${cnt("work")} · 운영 ${cnt("ops")} · 가격 ${cnt("price")} · 대상이 작중·독자라 뺀 것 ${cnt("down")} · $${u.usd.toFixed(3)}`;
    }) : []),
    ...report.notes.map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : []),
    `- 이 달 AI 사용 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
