/* 카카오 회차 댓글 분석 — 1단계(반복 반응 묶음) 시험 실행기 (손으로만, .github/workflows/cmt-exp1.yml)
 *
 * 시범 표본(state/cmt/{이름}.json — 원문 없음)을 카카오에서 uid로 다시 받아
 *   ① 1단계(Sonnet): 새 묶음 규칙(B, THEME_SYSTEM_K)으로 작품마다 묶음을 --reps 번 따로 정한다(흔들림 확인)
 *      입력: 초반·중간·최근이 1/3씩 되게 고른 댓글(내용 없는 댓글 제외) + 원작 유무·휴재/복귀 회차 같은 코드 사실
 *   ② 2단계(Haiku): 그 묶음으로 댓글마다 표시(카카오판 K, 생각량 --effort)
 *   ③ 재확인(Sonnet): 확신 '높음'이 아닌 불만 후보만 다시 판정
 *   ④ 빠진 반응 채우기(cmt_fill.mjs): 묶음 없는 댓글에서 새 묶음 보태기·좁은 기준 넓히기(Sonnet) → 묶음 없던 댓글만 다시 표시(Haiku)
 *      (확신 '낮음'으로 붙은 묶음은 ②에서 뗀다 — 검토에서 절반 넘게 틀림)
 *   --from 이전결과.json 이면 ①~③을 건너뛰고 그 결과(묶음·표시·재확인)에 ④만 돌린다.
 * 결과(묶음 이름·기준 + 댓글 번호별 표시 — 원문 없음, AI 글은 원문과 12자 넘게 겹치면 가림)는 하루 보관 실행 결과물로.
 *
 *   node scripts/cmt/cmt_exp1.mjs --spec state/cmt/pilot1.json --reps 2 [--effort low] [--recheck sonnet@medium]
 *        [--fill on|off] [--from 이전결과.json] [--cap-usd 2] [--limit-usd 30] [--wait-min 100] [--out cmt_exp1_out.json] [--summary FILE]
 *   CMT_MOCK=1 이면 가짜 답.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fetchWork, fetchEpisodeComments, KakaoBlocked, cut } from "./kakao_cmt.mjs";
import * as K from "./kakao_cmt.mjs";
import { CFG } from "./cmt_config.mjs";
import * as AI from "./cmt_ai.mjs";
import { isFiller } from "../lib/cmt-filter.mjs";
import { episodeContext, episodeLine, versionLine, commentWhen } from "./cmt_ctx.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";
import * as FILL from "./cmt_fill.mjs";

const STATE = "state/ai_state.json";
const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const EST = { theme: 0.15, perComment: 0.00006, recheck: { sonnet: 0.0025, haiku: 0.0004 }, fill: 0.05, fillPerComment: 0.00003 };
const THEME_CHARS = 60000, THEME_TEXT = 150, CHUNK = 25, RECHECK_CHUNK = 20;
const MOCK = !!process.env.CMT_MOCK;

const args = { spec: null, reps: 2, effort: "low", themeEffort: "high", recheck: "sonnet@medium", fill: "on", from: null, capUsd: 2, limitUsd: 30, waitMin: 100, out: "cmt_exp1_out.json", summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--spec") args.spec = v();
  else if (k === "--reps") args.reps = Number(v());
  else if (k === "--effort") args.effort = v();
  else if (k === "--theme-effort") args.themeEffort = v();
  else if (k === "--recheck") args.recheck = v();
  else if (k === "--fill") args.fill = v();
  else if (k === "--from") args.from = v();
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
if (!args.spec || !/^state\/cmt\/[\w-]+\.json$/.test(args.spec) || !existsSync(args.spec)) throw new Error("--spec 은 state/cmt/ 안의 표본 목록 파일");
if (!(args.reps >= 1 && args.reps <= 3)) throw new Error("--reps 는 1~3");
if (!["on", "off"].includes(args.fill)) throw new Error("--fill 은 on·off");
if (args.from && (!existsSync(args.from) || args.fill !== "on")) throw new Error("--from 은 있는 결과 파일, --fill on 과 함께");
const PREV = args.from ? JSON.parse(readFileSync(args.from, "utf8")) : null;
if (PREV) args.reps = PREV.runs.length;
if (!["low", "medium", "high"].includes(args.effort) || !["low", "medium", "high"].includes(args.themeEffort)) throw new Error("--effort·--theme-effort 는 low·medium·high");
const RC = args.recheck === "none" ? null : (() => {
  const m = String(args.recheck).match(/^(sonnet|haiku)@(low|medium|high)$/);
  if (!m) throw new Error("--recheck 는 sonnet@medium 같은 형식 또는 none");
  return { key: m[1], model: m[1] === "sonnet" ? SONNET : HAIKU, effort: m[2] };
})();
for (const k of ["capUsd", "limitUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
const MONTH = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const log = (...a) => console.log(...a);

const spec = JSON.parse(readFileSync(args.spec, "utf8"));
const report = { version: 1, kind: "cmt-exp1", spec: args.spec, generated_at: new Date().toISOString(), reps: args.reps, effort: args.effort, recheck: args.recheck, fill: args.fill, from: args.from,
  usage: {}, cost: {}, batches: {}, notes: [], requests: 0, runs: [] };
const works = [];

// ---------------- 원문 다시 받기 ----------------
async function load(sw) {
  // 내 컴퓨터에서만 하는 가짜 답 시험: 카카오에 묻지 않고 로컬 원문 파일(labelled.json)을 쓴다
  if (MOCK && process.env.CMT_LOCAL_TEXT) {
    const { labelled } = JSON.parse(readFileSync(process.env.CMT_LOCAL_TEXT, "utf8"));
    const byN = new Map(labelled.filter((c) => c.work === sw.title).map((c) => [c.n, c.text]));
    const sample = sw.comments.filter((c) => byN.get(c.n)).map((c) => ({ ...c, text: byN.get(c.n) }));
    return { ...sw, desc: "", sample, ec: episodeContext(sw.episodes) };
  }
  const live = await fetchWork(sw.id);
  const textByUid = new Map();
  for (const e of sw.episodes) {
    try {
      const r = await fetchEpisodeComments(sw.id, e.id, [], CFG.poolPages);
      for (const c of [...r.likeList, ...r.pool]) textByUid.set(String(c.cid), c.text);
    } catch (err) {
      if (err instanceof KakaoBlocked) throw err;
      report.notes.push(`${sw.title} ${e.no}화 댓글을 다시 받지 못함 — 그 회차는 뺌`);
    }
  }
  const sample = [];
  for (const c of sw.comments) { const text = textByUid.get(String(c.cid)); if (text && text.trim()) sample.push({ ...c, text }); }
  log(`■ ${sw.title} — 댓글 ${sample.length}/${sw.comments.length}개 다시 받음`);
  return { ...sw, desc: live.desc, sample, ec: episodeContext(live.episodes) };
}

// ---------------- 1단계 입력: 초반·중간·최근 1/3씩 ----------------
function themeText(w) {
  const parts = ["초반", "중간", "최근"];
  const eps = w.episodes;
  const perPartChars = THEME_CHARS / 3;
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.genre ? " / " + w.genre : ""}`];
  const vl = versionLine(w);
  if (vl) lines.push(`[작품 사실] ${vl}`);
  lines.push(`[작품 소개] ${w.desc || "-"}`, "", "[댓글 표본] 초반·중간·최근 회차가 비슷한 양이 되게 고름(내용 없는 댓글 제외). 번호 [좋아요] 본문");
  for (const part of parts) {
    const pe = eps.filter((e) => e.part === part);
    if (!pe.length) continue;
    const perEp = perPartChars / pe.length;
    for (const e of pe) {
      const cs = w.sample.filter((c) => c.ep === e.id && !isFiller(c.text));
      // 좋아요 상위와 그 밖을 번갈아 — 글자 상한 안에서
      const top = cs.filter((c) => c.pick === "top"), rest = cs.filter((c) => c.pick !== "top");
      const mixed = [];
      for (let i = 0; i < Math.max(top.length, rest.length); i++) { if (top[i]) mixed.push(top[i]); if (rest[i]) mixed.push(rest[i]); }
      let used = 0;
      const ecl = episodeLine(w.ec.get(String(e.id)));
      lines.push(`== ${e.no}화 [${part}] (${String(e.reg).slice(0, 10)})${ecl ? " · " + ecl : ""} ==`);
      for (const c of mixed) {
        const l = `#${c.n} [${c.like}] ${cut(c.text.replace(/\s+/g, " "), THEME_TEXT)}`;
        if (used + l.length > perEp) break;
        lines.push(l);
        used += l.length + 1;
      }
    }
  }
  return lines.join("\n");
}

// AI 글이 댓글 원문과 12자 넘게 겹치면 가린다
function scrubberFor(w) {
  const norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const c of w.sample) { const t = norm(c.text); for (let i = 0; i + 12 <= t.length; i++) grams.add(t.slice(i, i + 12)); }
  return (s) => { const t = norm(s); for (let i = 0; i + 12 <= t.length; i++) if (grams.has(t.slice(i, i + 12))) return "(댓글 원문과 겹쳐 가림)"; return s; };
}


// 묶음마다 근거 댓글(1단계 refs)이 나온 회차 — 2단계가 짧은 반응을 회차 맥락으로 읽게
function withHints(themes, sample) {
  const noOf = new Map(sample.map((c) => [c.n, c.no]));
  return themes.map((t) => {
    const eps = [...new Set((t.seed || []).map((n) => noOf.get(n)).filter((x) => x != null))].sort((a, b) => a - b);
    return eps.length ? { ...t, hint: eps.map((x) => `${x}화`).join("·") } : t;
  });
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
const textOf = (msg) => (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
function mockAnswer(cid, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  if (cid.startsWith("t")) return { themes: [
    { bucket: "like", label: "가짜 좋아요 묶음", def: "가짜", refs: ns.slice(0, 3) },
    { bucket: "talk", label: "가짜 휴재 투정", def: "가짜", refs: ns.slice(3, 5) },
    { bucket: "dislike", label: "잦은 휴재·지각 비판", def: "가짜(옮겨져야 함)", refs: ns.slice(5, 7) },
    { bucket: "dislike", label: "같은 장면 반복에 실망", def: "가짜", refs: ns.slice(7, 9) }] };
  if (cid.startsWith("f")) return { themes: [{ bucket: "talk", label: "가짜 보탠 묶음", def: "가짜", refs: ns.slice(0, 3) }, { bucket: "dislike", label: "잦은 휴재 비판", def: "가짜(옮겨져야 함)", refs: ns.slice(3, 5) }],
    widen: [{ id: "T1", label: "가짜 넓힌 묶음", def: "가짜 넓힘" }, { id: "T99", label: "없는 번호", def: "무시돼야 함" }] };
  if (cid.startsWith("g")) return { comments: ns.map((n, i) => ({ n, th: [["T5"], [], ["T6", "T4"], ["T99"], ["T1"]][i % 5], cf: ["hi", "hi", "hi", "hi", "mid"][i % 5] })) };
  if (cid.startsWith("r")) return { items: ns.map((n, i) => ({ n, target: "craft", complaint: ["yes", "no", "border"][i % 3], kind: "work", aspect: "repeat" })) };
  return { comments: ns.map((n, i) => ({ n, tg: ["story", "craft", "ops"][i % 3], cw: ["none", "repeat", "ops"][i % 3], tn: ["char", "critic", "miss"][i % 3],
    th: [["T1"], ["T4"], ["T2"]][i % 3], nd: [], st: "none", nn: "", ac: "none", cf: ["hi", "mid", "lo"][i % 3] })) };
}
let stage = null;
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));
const addUsage = (key, model, u) => {
  const c$ = costOf(model, u);
  const U = (report.usage[key] ||= { in: 0, out: 0, cacheRead: 0, usd: 0 });
  U.in += u.input_tokens || 0; U.out += u.output_tokens || 0; U.cacheRead += u.cache_read_input_tokens || 0; U.usd += c$;
  return c$;
};

let runs = null;
try {
  for (const sw of spec.works) works.push(await load(sw));
  const nC = works.reduce((t, w) => t + w.sample.length, 0);
  const estFill = args.fill === "on" ? args.reps * (works.length * EST.fill + nC * 0.5 * EST.fillPerComment) : 0;
  const est = (PREV ? 0 : args.reps * (works.length * EST.theme + nC * EST.perComment + (RC ? nC * 0.04 * EST.recheck[RC.key] : 0))) + estFill;
  const spent0 = state.spend[MONTH] || 0;
  log(`작품 ${works.length}개, 댓글 ${nC}개, 반복 ${args.reps}번 — 예상 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용 $${spent0.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 상한을 넘어 보내지 않습니다");
  if (spent0 + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");
  ({ stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: Date.now(), charge, report, log }));
  const recheckCap = () => { const run = (state.spend[MONTH] || 0) - spent0; if (!MOCK && run > args.capUsd) throw new Error(`상한을 넘어 멈춤 (지금까지 $${run.toFixed(3)})`); };
  runs = Array.from({ length: args.reps }, () => works.map(() => ({ themes: [], labels: {}, recheck: {} })));
  if (PREV) {
    // 이전 결과를 그대로 불러와 ④만 — 확신 '낮음' 묶음 떼기도 똑같이 적용
    PREV.runs.forEach((rw, r) => works.forEach((w, wi) => {
      const x = rw.find((y) => y.id === w.id);
      if (!x) return;
      for (const lab of Object.values(x.labels)) if (lab.cf === "lo" && lab.th.length) { lab.thLo = lab.th; lab.th = []; }
      runs[r][wi] = { themes: x.themes, labels: x.labels, recheck: x.recheck || {} };
    }));
    log(`이전 결과 ${args.from} 를 불러옴 — ①~③ 건너뜀`);
  }
  if (!PREV) {

  // ① 1단계: 반복 반응 묶음 (반복마다 따로)
  const treqs = [];
  for (let r = 0; r < args.reps; r++) works.forEach((w, wi) => treqs.push({ custom_id: `t${r}-${wi}`, params: AI.buildThemeParamsK({ model: SONNET, effort: args.themeEffort }, themeText(w)) }));
  log(`  1단계 자료: ${works.map((w) => `${w.title} ${themeText(w).length.toLocaleString()}자`).join(", ")}`);
  await stage("1단계(Sonnet) 새 묶음 규칙", treqs, args.reps * works.length * EST.theme, "theme", (out) => {
    let usd = 0;
    for (const [cid, res] of out) {
      const [r, wi] = cid.slice(1).split("-").map(Number);
      const w = works[wi];
      if (!w || res.type !== "succeeded") { report.notes.push(`1단계 실패 ${cid}`); continue; }
      usd += addUsage("theme", SONNET, res.message.usage || {});
      try {
        const valid = new Set(w.sample.map((c) => c.n));
        runs[r][wi].themes = (JSON.parse(textOf(res.message)).themes || []).slice(0, 24).map((t, i) => AI.rebucket({
          id: "T" + (i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
          seed: [...new Set((t.refs || []).filter((n) => valid.has(n)))].slice(0, 5) }, w.webtoon));
        const moved = runs[r][wi].themes.filter((t) => t.moved).length;
        if (moved) report.notes.push(`반복 ${r + 1} ${w.title}: 서사·캐릭터가 아닌 불호 묶음 ${moved}개를 '많이 하는 말'로 옮김`);
      } catch { report.notes.push(`1단계 해석 실패 ${cid}`); }
    }
    return usd;
  });
  recheckCap();

  // ② 2단계: 묶음마다 댓글 표시 (카카오판 K)
  const hreqs = [], chunkNs = new Map();
  for (let r = 0; r < args.reps; r++) works.forEach((w, wi) => {
    const themes = withHints(runs[r][wi].themes, w.sample);
    if (!themes.length) return;
    const wb = { title: w.title, webtoon: w.webtoon, bl: w.bl, desc: w.desc, genre: w.genre };
    for (const e of w.episodes) {
      const cs = w.sample.filter((c) => c.ep === e.id);
      for (let k = 0; k < cs.length; k += CHUNK) {
        const part = cs.slice(k, k + CHUNK), custom_id = `h${r}-${wi}-${e.id}-${k / CHUNK}`;
        chunkNs.set(custom_id, new Set(part.map((c) => c.n)));
        hreqs.push({ custom_id, params: AI.buildClassifyParamsK({ model: HAIKU, effort: args.effort }, wb, e, part, CFG.textMax, themes, {}) });
      }
    }
  });
  await stage(`2단계(Haiku@${args.effort}) 댓글 표시`, hreqs, args.reps * nC * EST.perComment, "haiku", (out) => {
    let usd = 0;
    for (const [cid, res] of out) {
      const m = cid.match(/^h(\d+)-(\d+)-/);
      if (!m || res.type !== "succeeded") { report.notes.push(`2단계 실패 ${cid}`); continue; }
      const r = Number(m[1]), wi = Number(m[2]), run = runs[r][wi];
      usd += addUsage("haiku", HAIKU, res.message.usage || {});
      let parsed; try { parsed = JSON.parse(textOf(res.message)); } catch { report.notes.push(`2단계 해석 실패 ${cid}`); continue; }
      const themeOf = new Map(run.themes.map((t) => [t.id, t]));
      const valid = new Set(chunkNs.get(cid) || []);
      for (const it of parsed.comments || []) {
        if (!valid.has(it.n)) continue;
        valid.delete(it.n);
        const th0 = [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 2);
        const lab = { tg: it.tg, cw: it.cw, tn: it.tn, cf: it.cf, ac: it.ac, th0 };
        lab.cx = AI.complaintOf(lab);
        lab.th = th0.filter((id) => themeOf.get(id).bucket !== "dislike" || lab.cx === "work");
        if (lab.cf === "lo" && lab.th.length) { lab.thLo = lab.th; lab.th = []; }
        run.labels[it.n] = lab;
      }
    }
    return usd;
  });
  recheckCap();

  // ③ 재확인: 확신 높음이 아닌 critic만
  if (RC) {
    const rreqs = [], rNs = new Map();
    for (let r = 0; r < args.reps; r++) works.forEach((w, wi) => {
      const q = w.sample.filter((c) => { const l = runs[r][wi].labels[c.n]; return l && l.tn === "critic" && l.cf !== "hi"; });
      for (let k = 0; k < q.length; k += RECHECK_CHUNK) {
        const items = q.slice(k, k + RECHECK_CHUNK).map((c) => {
          const e = w.episodes.find((x) => x.id === c.ep), ec = w.ec.get(String(c.ep));
          return { n: c.n, no: c.no, like: c.like, text: c.text, epLine: episodeLine(ec), when: e ? commentWhen(c.at, e, ec) : "" };
        });
        const custom_id = `r${r}-${wi}-${k / RECHECK_CHUNK}`;
        rNs.set(custom_id, new Set(items.map((x) => x.n)));
        rreqs.push({ custom_id, params: AI.buildRecheckParams({ model: RC.model, effort: RC.effort }, { title: w.title, webtoon: w.webtoon, genre: w.genre, desc: w.desc }, items, CFG.textMax, versionLine(w)) });
      }
    });
    const nq = [...rNs.values()].reduce((t, s) => t + s.size, 0);
    if (rreqs.length) await stage(`재확인(${args.recheck})`, rreqs, nq * EST.recheck[RC.key], "recheck", (out) => {
      let usd = 0;
      for (const [cid, res] of out) {
        const m = cid.match(/^r(\d+)-(\d+)-/);
        if (!m || res.type !== "succeeded") { report.notes.push(`재확인 실패 ${cid}`); continue; }
        usd += addUsage("recheck", RC.model, res.message.usage || {});
        let parsed; try { parsed = JSON.parse(textOf(res.message)); } catch { continue; }
        const valid = new Set(rNs.get(cid) || []);
        for (const it of parsed.items || []) {
          if (!valid.has(it.n)) continue;
          valid.delete(it.n);
          runs[Number(m[1])][Number(m[2])].recheck[it.n] = { complaint: it.complaint, kind: it.kind, target: it.target, aspect: it.aspect };
        }
      }
      return usd;
    });
  }
  }

  // ④ 빠진 반응 채우기
  if (args.fill === "on") {
    recheckCap();
    const freqs = [], fCands = new Map();
    for (let r = 0; r < args.reps; r++) works.forEach((w, wi) => {
      const run = runs[r][wi];
      if (!run.themes.length) return;
      const cands = FILL.unbundled(w.sample, (c) => run.labels[c.n]).map((c) => ({ ...c, tn: run.labels[c.n].tn }));
      fCands.set(`${r}-${wi}`, cands);
      const cnt = (id) => Object.values(run.labels).filter((l) => l.th.includes(id)).length;
      const { text, picked } = FILL.fillText(w, run.themes, cnt, cands);
      log(`  ④ 자료: 반복 ${r + 1} ${w.title} — 묶음 없는 댓글 ${cands.length}개 중 ${picked}개, ${text.length.toLocaleString()}자`);
      freqs.push({ custom_id: `f${r}-${wi}`, params: AI.buildFillParamsK({ model: SONNET, effort: "medium" }, text) });
    });
    await stage("④ 빠진 반응 찾기(Sonnet)", freqs, freqs.length * EST.fill, "fill", (out) => {
      let usd = 0;
      for (const [cid, res] of out) {
        const [r, wi] = cid.slice(1).split("-").map(Number);
        const w = works[wi], run = runs[r][wi];
        if (!w || res.type !== "succeeded") { report.notes.push(`④ 실패 ${cid}`); continue; }
        usd += addUsage("fill", SONNET, res.message.usage || {});
        try {
          const m = FILL.mergeFill(run.themes, JSON.parse(textOf(res.message)), new Set(w.sample.map((c) => c.n)), w.webtoon);
          run.themes = m.themes;
          run.fillStat = { added: m.added, widened: m.widened, cands: fCands.get(`${r}-${wi}`).length };
        } catch { report.notes.push(`④ 해석 실패 ${cid}`); }
      }
      return usd;
    });
    recheckCap();
    const greqs = [], gNs = new Map();
    for (let r = 0; r < args.reps; r++) works.forEach((w, wi) => {
      const run = runs[r][wi];
      if (!run.fillStat || !(run.fillStat.added + run.fillStat.widened)) return;
      const themes = withHints(run.themes, w.sample);
      FILL.fillLabelChunks(fCands.get(`${r}-${wi}`)).forEach((part, k) => {
        const custom_id = `g${r}-${wi}-${k}`;
        gNs.set(custom_id, new Set(part.map((c) => c.n)));
        greqs.push({ custom_id, params: AI.buildFillLabelParamsK({ model: HAIKU, effort: "medium" }, { title: w.title, webtoon: w.webtoon, genre: w.genre }, part, themes, CFG.textMax) });
      });
    });
    const ng = [...gNs.values()].reduce((t, x) => t + x.size, 0);
    if (greqs.length) await stage("④ 묶음 없던 댓글 다시 표시(Haiku)", greqs, ng * EST.fillPerComment, "fillLabel", (out) => {
      let usd = 0;
      for (const [cid, res] of out) {
        const m = cid.match(/^g(\d+)-(\d+)-/);
        if (!m || res.type !== "succeeded") { report.notes.push(`④ 다시 표시 실패 ${cid}`); continue; }
        const run = runs[Number(m[1])][Number(m[2])];
        usd += addUsage("fillLabel", HAIKU, res.message.usage || {});
        let parsed; try { parsed = JSON.parse(textOf(res.message)); } catch { report.notes.push(`④ 다시 표시 해석 실패 ${cid}`); continue; }
        run.fillStat.tagged = (run.fillStat.tagged || 0) + FILL.applyFillLabels(parsed, new Set(gNs.get(cid) || []), run.themes, (n) => run.labels[n]);
      }
      return usd;
    });
    for (const rw of runs) rw.forEach((run) => {
      if (!run.fillStat) return;
      const p = FILL.pruneSmallAdded(run.themes, Object.values(run.labels));
      run.themes = p.themes;
      run.fillStat.pruned = p.pruned;
    });
  }
} catch (e) {
  report.error = e instanceof KakaoBlocked ? "카카오가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  report.requests = K.requests;
  report.runs = (runs || []).map((rw) => rw.map((run, wi) => {
    const w = works[wi], sc = scrubberFor(w);
    return { id: w.id, title: w.title, ns: w.sample.map((c) => c.n), themes: run.themes.map((t) => ({ ...t, label: sc(t.label), def: sc(t.def) })), labels: run.labels, recheck: run.recheck, fillStat: run.fillStat || null };
  }));
  writeFileSync(args.out, JSON.stringify(report));
  const lines = [`## 1단계 묶음 규칙 시험`, `- 표본 ${args.spec}, 반복 ${args.reps}번, 2단계 생각량 ${args.effort}, 재확인 ${args.recheck}, 빠진 반응 채우기 ${args.fill}${args.from ? ` (이전 결과 ${args.from} 에 이어서)` : ""}`, `- 카카오 요청 ${K.requests}번`,
    ...report.runs.flatMap((rw, r) => rw.map((x) => {
      const b = (k) => x.themes.filter((t) => t.bucket === k).length;
      const f = x.fillStat;
      return `- 반복 ${r + 1} ${x.title}: 묶음 ${x.themes.length}개(좋다 ${b("like")}·많이 ${b("talk")}·불호 ${b("dislike")}), 표시 ${Object.keys(x.labels).length}개, 재확인 ${Object.keys(x.recheck).length}개` +
        (f ? `, ④ 묶음 없던 댓글 ${f.cands}개 → 새 묶음 ${f.added}(작아서 뺌 ${f.pruned || 0})·넓힘 ${f.widened}·다시 붙음 ${f.tagged || 0}개` : "") +
        `, 묶음 없는 댓글 ${Object.values(x.labels).filter((l) => !l.th.length).length}개`;
    })),
    `- AI 비용 ${Object.entries(report.usage).map(([k, u]) => `${k} $${u.usd.toFixed(3)}`).join(" + ")} / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.slice(0, 20).map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
