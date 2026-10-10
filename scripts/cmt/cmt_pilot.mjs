/* 카카오페이지 회차 댓글 '반복되는 반응' 분석 — 시범 실행 (작품 1~3개)
 * 리디 트래커 scripts/cmt/cmt_pilot.mjs(2판, 사람 재검토로 검증)를 카카오에 옮긴 것.
 *
 * ① 수집: 작품의 회차 목록 → 초반·중간·최근 회차를 골라 회차마다 좋아요순 1쪽 + 최신순 몇 쪽.
 *         닉네임은 작가 공지 댓글을 거르는 데만 쓰고 버린다(kakao_cmt.mjs).
 * ② 고르기: 회차마다 '좋아요 상위 30 + 나머지 무작위 70'(설정값).
 * ③ 1단계 AI(Sonnet, 일괄): 작품마다 '반복되는 반응' 묶음(좋다는 말 / 많이 하는 말 / 불호)을 정한다.
 * ④ 2단계 AI(Haiku, 일괄): 댓글마다 해당 묶음 + 속뜻 + 직접 드러난 니즈만 표시. 개수·좋아요·회차는 프로그램이 센다.
 *         불호 묶음엔 속뜻이 '진짜 불만'이고 확신이 낮지 않은 댓글만 들어가게 프로그램이 강제한다.
 * ⑤ 3단계 AI(Sonnet, 일괄): 참고용 니즈 맵.
 * ⑥ 결과 파일: 숫자·표시·묶음만(댓글 원문 없음 — 근거는 댓글 번호와 댓글 uid). 이 달 AI 사용액은 state/ai_state.json 에 더한다.
 *
 *   node scripts/cmt/cmt_pilot.mjs --ids 56243215,66476840 --out cmt_pilot_out.json
 *        [--limit-usd 30] [--cap-usd 2] [--wait-min 100] [--collect-only] [--summary FILE]
 *   이어받기는 없다: 다시 돌리면 댓글을 새로 모아 표본이 바뀌므로, 지난 AI 결과를 붙이면 엉뚱한 댓글에 붙는다.
 *   돈: AI 일괄을 보내는 즉시 예상 비용을 이 달 사용액에 먼저 더하고, 결과를 받으면 실제 금액으로 맞춘다.
 *   CMT_MOCK=1 이면 AI 대신 가짜 답으로 끝까지 돌려 본다 (돈 안 듦, 시험용).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { fetchWork, fetchEpisodeComments, KakaoBlocked, cut } from "./kakao_cmt.mjs";
import * as K from "./kakao_cmt.mjs";
import { CFG } from "./cmt_config.mjs";
import * as AI from "./cmt_ai.mjs";
import { judge } from "./cmt_judge.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const STATE = "state/ai_state.json";   // 카카오 트래커 자기 장부 (리디·네이버와 따로)
const HAIKU = { model: "claude-haiku-5-5", effort: "medium" };
const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_PER_COMMENT = 0.0001;   // 2단계: 댓글 1개당 예상(일괄, 여유 있게)
const EST_THEME_WORK = 0.15;      // 1단계: 작품 1개당 예상(Sonnet 일괄)
const EST_NEEDS_WORK = 0.15;      // 3단계: 작품 1개당 예상(Sonnet 일괄)
const MOCK = !!process.env.CMT_MOCK;

// ---- 명령줄 ----
const args = { ids: [], limitUsd: 30, capUsd: 2, waitMin: 100, out: "cmt_pilot_out.json", collectOnly: false, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--ids") args.ids = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--out") args.out = v();
  else if (k === "--collect-only") args.collectOnly = true;
  else if (k === "--summary") args.summary = v();
  else throw new Error("모르는 옵션: " + k);
}
for (const k of ["limitUsd", "capUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (!args.ids.length || args.ids.length > 3 || args.ids.some((x) => !/^\d{5,12}$/.test(x))) throw new Error("--ids 에 작품 번호 1~3개를 쉼표로 넣어 주세요");
const T_START = Date.now();

const HOUR = 3600e3;
const MONTH = new Date(Date.now() + 9 * HOUR).toISOString().slice(0, 7);
const log = (...a) => console.log(...a);
const PART = { early: "초반", mid: "중간", recent: "최근" };

// 같은 씨앗이면 늘 같은 순서로 섞기 (다시 돌려도 같은 표본)
function shuffle(arr, seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 표본 회차: 초반 earlyEps화 + 중간 midEps화(초반과 최근 사이를 고르게) + 최근 recentEps화
function chooseEpisodes(num) {
  const n = num.length;
  const tag = (e, part) => { e.analyzed = true; e.part = PART[part]; };
  if (n <= CFG.earlyEps + CFG.midEps + CFG.recentEps) { num.forEach((e, i) => tag(e, i < CFG.earlyEps ? "early" : i >= n - CFG.recentEps ? "recent" : "mid")); return; }
  num.slice(0, CFG.earlyEps).forEach((e) => tag(e, "early"));
  num.slice(-CFG.recentEps).forEach((e) => tag(e, "recent"));
  const lo = CFG.earlyEps, hi = n - CFG.recentEps - 1;
  // 고르게 나눈 자리가 겹치면(회차가 적을 때) 다음 빈 자리로 민다
  for (let k = 1; k <= CFG.midEps; k++) {
    let i = Math.round(lo + ((hi - lo) * k) / (CFG.midEps + 1));
    while (i <= hi && num[i].analyzed) i++;
    if (i <= hi) tag(num[i], "mid");
  }
}

// ---------------- ① 수집 ----------------
async function collect(id) {
  const w = await fetchWork(id);
  // 제목에 'N화'가 거의 없는 작품(옛 e북식 제목 등)은 상품 순서를 화 번호로 쓴다
  if (w.episodes.filter((e) => e.no != null).length < w.episodes.length / 2) {
    w.episodes.forEach((e, i) => { e.no = i + 1; });
    report.notes.push(`${w.title}: 제목에 화 번호가 거의 없어 상품 순서를 화 번호로 씀`);
  }
  if (w.truncated) report.notes.push(`${w.title}: 회차가 너무 많아 가장 오래된 회차 일부를 못 받음(초반 화가 실제 1화가 아닐 수 있음)`);
  const num = w.episodes.filter((e) => e.no != null);
  chooseEpisodes(num);
  log(`■ ${w.title} (${id}) — 회차 ${w.episodes.length}개, 분석 ${num.filter((e) => e.analyzed).length}화`);
  for (const e of num.filter((x) => x.analyzed)) {
    try {
      const r = await fetchEpisodeComments(id, e.id, w.authors, CFG.poolPages);
      Object.assign(e, { total: r.total, complete: r.complete, _like: r.likeList, _pool: r.pool });
    } catch (err) {
      if (err instanceof KakaoBlocked) throw err;   // 막혔으면 바로 멈춤
      Object.assign(e, { total: null, error: String(err.message).slice(0, 80), _like: [], _pool: [] });
      report.notes.push(`${w.title} ${e.no}화 댓글을 못 받음: ${e.error}`);
    }
  }
  return w;
}

// ---------------- ② 분류 대상 고르기 ----------------
function pickSample(w) {
  let n = 0;
  w.sample = [];
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    const ok = (c) => c.text.trim();
    const byLike = [...e._like.filter(ok)].sort((a, b) => b.like - a.like || String(a.cid).localeCompare(String(b.cid)));
    const top = byLike.slice(0, CFG.topLiked).map((c) => ({ ...c, pick: "top" }));
    const topIds = new Set(top.map((c) => c.cid));
    const rest = [...byLike.slice(CFG.topLiked), ...e._pool.filter(ok)].filter((c) => !topIds.has(c.cid));
    // 좋아요순은 공감 1개 이상인 댓글만 주므로, 상위 칸이 덜 차면 그만큼 무작위로 더 뽑는다 (회차당 표본 수를 리디와 같게)
    const nRand = CFG.randomRest + (CFG.topLiked - top.length);
    const rnd = shuffle(rest, Number(e.id)).slice(0, nRand).map((c) => ({ ...c, pick: "rand" }));
    e.sampled = top.length + rnd.length;
    for (const c of [...top, ...rnd]) w.sample.push({ ...c, n: ++n, ep: e.id, no: e.no });
  }
}

// ---------------- 일괄 처리: batch.mjs ----------------
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));

// 시험용 가짜 답 (CMT_MOCK=1): 요청 내용에서 번호를 읽어 그럴듯한 JSON을 만든다
function mockAnswer(customId, body) {
  const ns = [...body.matchAll(/#(\d+) \[/g)].map((m) => Number(m[1]));
  if (customId.startsWith("t-")) {
    // 가림 장치 시험: 첫 댓글 문장 일부를 그대로 옮긴 묶음 이름 하나 (결과에서 가려져야 함)
    const first = (body.match(/#\d+ \[\d+\] (.{14,40})/) || [])[1] || "가짜 묶음";
    return { themes: [
      { bucket: "like", label: "작화가 화보 같다", def: "작화·그림 칭찬", refs: ns.slice(0, 3) },
      { bucket: "talk", label: "다음 화 기다림·휴재 아쉬움", def: "기다림·휴재", refs: ns.slice(3, 5) },
      { bucket: "talk", label: "주인공에게 화내기", def: "인물 타박", refs: ns.slice(5, 7) },
      { bucket: "dislike", label: "전개가 늘어진다", def: "전개 속도 진지한 지적", refs: ns.slice(7, 9) },
      { bucket: "talk", label: first, def: "가림 장치 시험", refs: ns.slice(9, 11) }] };
  }
  // 불호 강제 시험: T4(불호)를 과몰입(char)·확신 낮음(lo)에도 붙여 본다 (프로그램이 빼야 함)
  if (customId.startsWith("h-")) return { comments: ns.map((n, i) => ({ n, th: [["T1"], ["T2"], ["T3", "T4"], ["T4"], [], ["T1", "T9"]][i % 6],
    tn: ["praise", "miss", "char", "critic", "other", "tease"][i % 6], nd: i % 3 ? [] : ["rom_progress"], st: i % 3 ? "none" : "met", nn: i % 7 ? "" : "수위·씬",
    ac: ["none", "stay", "churn", "pay"][i % 4], cf: ["hi", "mid", "lo", "lo", "hi", "mid"][i % 6] })) };
  return { needs: [{ axis: "romance", need: "관계 진전", state: "met", evidence: "가짜", size: "중", why: "가짜", refs: ns.slice(0, 3).concat([999999]) }] };
}
const clip = (t, n) => cut(t.trim().replace(/\s+/g, " "), n);
const epHead = (e) => `== ${e.no}화 [${e.part}] (${String(e.reg).slice(0, 10)}) ==`;

// ---------------- ③ 1단계: 반복되는 반응 찾기 ----------------
function themeText(w, perTop = CFG.themeTop, perRest = CFG.themeRest) {
  const an = w.episodes.filter((e) => e.analyzed);
  const cnt = (p) => an.filter((e) => e.part === p).length;
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.genre ? " / " + w.genre : ""}`, `[작품 소개] ${w.desc || "-"}`, "",
    `[댓글 표본] 초반 ${cnt("초반")}화 + 중간 ${cnt("중간")}화 + 최근 ${cnt("최근")}화, 회차마다 좋아요 많은 댓글 ${perTop}개 + 그 밖의 댓글 ${perRest}개. 번호 [좋아요] 본문`];
  for (const e of an) {
    const cs = w.sample.filter((c) => c.ep === e.id);
    const top = cs.filter((c) => c.pick === "top").slice(0, perTop);
    const rest = cs.filter((c) => c.pick !== "top");
    const step = Math.max(1, Math.floor(rest.length / Math.max(1, perRest)));
    const more = rest.filter((_, i) => i % step === 0).slice(0, perRest);
    lines.push(epHead(e));
    for (const c of [...top, ...more]) lines.push(`#${c.n} [${c.like}] ${clip(c.text, CFG.themeTextMax)}`);
  }
  return lines.join("\n");
}
function themeRequests(works) {
  return works.map((w, wi) => {
    if (!w.sample.length) { report.notes.push(`${w.title}: 분석할 댓글이 없어 건너뜀`); return null; }
    let top = CFG.themeTop, rest = CFG.themeRest, t = themeText(w, top, rest);
    while (t.length > CFG.synthMaxChars && top + rest > 12) { top = Math.ceil(top * 0.8); rest = Math.floor(rest * 0.8); t = themeText(w, top, rest); }
    log(`  1단계 자료: ${w.title} ${t.length.toLocaleString()}자`);
    return { custom_id: `t-${wi}`, params: AI.buildThemeParams(SONNET, t) };
  }).filter(Boolean);
}
function applyThemes(works, out) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`1단계 실패: ${w ? w.title : cid} (${res.type})`); continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.map((c) => c.n));
      w.themes = (AI.parseJson(res.message).themes || []).slice(0, CFG.themeMax).map((t, i) => ({
        id: "T" + (i + 1), bucket: AI.BUCKETS[t.bucket] ? t.bucket : "talk", label: cut(t.label, 60), def: cut(t.def, 160),
        seed: [...new Set((t.refs || []).filter((n) => valid.has(n)))].slice(0, 5)
      }));
    } catch (e) { report.notes.push(`1단계 해석 실패: ${w.title} ${e.message}`); }
  }
  return usd;
}

// ---------------- ④ 2단계: 댓글마다 표시 ----------------
function classifyRequests(works) {
  const reqs = [];
  works.forEach((w, wi) => {
    if (!w.themes || !w.themes.length) return;
    const wb = { title: w.title, webtoon: w.webtoon, bl: w.bl, desc: w.desc };
    for (const e of w.episodes.filter((x) => x.analyzed)) {
      const cs = w.sample.filter((c) => c.ep === e.id);
      for (let k = 0; k < cs.length; k += CFG.chunk) {
        reqs.push({ custom_id: `h-${wi}-${e.id}-${k / CFG.chunk}`, params: AI.buildClassifyParams(HAIKU, wb, e, cs.slice(k, k + CFG.chunk), CFG.textMax, w.themes) });
      }
    }
  });
  return reqs;
}
function applyLabels(works, out) {
  let usd = 0, failed = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { failed++; continue; }
    usd += costOf(HAIKU.model, res.message.usage || {});
    let parsed;
    try { parsed = AI.parseJson(res.message); } catch (e) { failed++; continue; }
    const byN = new Map(w.sample.map((c) => [c.n, c]));
    const themeOf = new Map((w.themes || []).map((t) => [t.id, t]));
    for (const it of parsed.comments || []) {
      const c = byN.get(it.n);
      if (!c) continue;
      const b = { th: [...new Set((it.th || []).map((x) => String(x).trim().toUpperCase()).filter((x) => themeOf.has(x)))].slice(0, 2),
        tn: it.tn, nd: [...new Set(it.nd || [])].slice(0, 3), st: it.st, nn: cut(it.nn, 20), ac: it.ac, cf: it.cf };
      // 속뜻과 맞추기: 과몰입·애정 투정·연재 아쉬움엔 이탈 신호 없음, 연재 아쉬움엔 서사 니즈 없음
      if (["char", "tease", "miss", "nudge"].includes(b.tn) && b.ac === "churn") b.ac = "none";
      if (b.tn === "miss") b.nd = [];
      if (!b.nd.length && !b.nn) b.st = "none";
      // '불호' 묶음엔 확신 있는 진짜 작품 불만(critic)만 — 겉말 불평이 불호로 세지지 않게
      const before = b.th.length;
      b.th = b.th.filter((id) => themeOf.get(id).bucket !== "dislike" || (b.tn === "critic" && b.cf !== "lo"));
      if (b.th.length < before) report.dropped++;
      c.lab = b;
    }
  }
  return { usd, failed };
}

// 묶음별 개수·좋아요·회차 (분석한 댓글 안에서 센다)
function themeStats(w) {
  const an = w.episodes.filter((e) => e.analyzed);
  for (const t of w.themes || []) {
    const cs = w.sample.filter((c) => c.lab && c.lab.th.includes(t.id));
    t.count = cs.length;
    t.likes = cs.reduce((s, c) => s + c.like, 0);
    t.eps = {};
    for (const c of cs) t.eps[c.no] = (t.eps[c.no] || 0) + 1;
    t.refs = [...cs].sort((a, b) => b.like - a.like).slice(0, CFG.themeRefs).map((c) => c.n);
    t.tones = cs.reduce((o, c) => ((o[c.lab.tn] = (o[c.lab.tn] || 0) + 1), o), {});
  }
  for (const e of an) {
    e.topThemes = (w.themes || []).map((t) => ({ id: t.id, n: t.eps[e.no] || 0 })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
  }
  w.untagged = w.sample.filter((c) => c.lab && !c.lab.th.length).length;
}

// ---------------- ⑤ 3단계: 참고용 니즈 맵 ----------------
const L = (o, k) => o[k] || k;
function needsText(w, perEp = CFG.needsPerEp) {
  const lines = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.genre ? " / " + w.genre : ""}`, `[작품 소개] ${w.desc || "-"}`, "",
    `[회차별 댓글 수] (지금까지 달린 전체 댓글 수 — 공개 시기가 몇 년씩 달라 회차끼리 비교하지 말 것)`];
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    lines.push(`${e.no}화(${e.part}): 전체 ${e.total ?? "-"}개` + ((e.flags || []).length ? ` / ${e.flags.join(",")}` : "") +
      (e.ai ? ` / 속뜻 ${Object.entries(e.ai.tn || {}).map(([k, v]) => `${L(AI.TONES, k)} ${v}`).join(", ")} / 결제 ${e.ai.pay}` : ""));
  }
  lines.push("", "[반복되는 반응]");
  for (const t of w.themes || []) lines.push(`${t.id} (${AI.BUCKETS[t.bucket]}) ${t.label}: ${t.count}개, 좋아요 ${t.likes}`);
  lines.push("", "[니즈 통계] (충족/결핍/요구/갈림 · 관련 댓글 좋아요 합 · 나온 회차 · 결제 신호)");
  for (const [d, s] of Object.entries(w.needStats || {}).sort((a, b) => (b[1].met + b[1].lack + b[1].ask) - (a[1].met + a[1].lack + a[1].ask))) {
    lines.push(`${AI.NEEDS[d]}(${AI.AXES[AI.NEED_AXIS(d)]}): ${s.met}/${s.lack}/${s.ask}/${s.split} · 좋아요 ${s.likes} · ${s.eps.join(",")}화 · 결제 ${s.pay}`);
  }
  const nn = Object.entries(w.newNeeds || {}).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  if (nn.length) lines.push("", "[목록에 없는 바람] " + nn.map(([k, v]) => `${k} ${v.count}개(좋아요 ${v.likes}, ${v.eps.join(",")}화)`).join(" / "));
  lines.push("", "[니즈가 표시된 댓글] 번호 [좋아요] 속뜻/상태/니즈/신규 | 본문");
  for (const e of w.episodes.filter((x) => x.analyzed)) {
    const cs = w.sample.filter((c) => c.ep === e.id && c.lab && (c.lab.nd.length || c.lab.nn)).sort((a, b) => b.like - a.like).slice(0, perEp).sort((a, b) => a.n - b.n);
    if (!cs.length) continue;
    lines.push(epHead(e));
    for (const c of cs) {
      const b = c.lab;
      lines.push(`#${c.n} [${c.like}] ${L(AI.TONES, b.tn)}/${L(AI.STATES, b.st)}/${b.nd.map((d) => AI.NEEDS[d]).join(",") || "-"}${b.nn ? "/신규:" + b.nn : ""} | ${clip(c.text, 120)}`);
    }
  }
  return lines.join("\n");
}
function needsRequests(works) {
  return works.map((w, wi) => {
    if (!w.sample.some((c) => c.lab)) return null;
    let per = CFG.needsPerEp, t = needsText(w, per);
    while (t.length > CFG.synthMaxChars && per > 8) { per = Math.floor(per * 0.8); t = needsText(w, per); }
    log(`  3단계 자료: ${w.title} ${t.length.toLocaleString()}자`);
    return { custom_id: `s-${wi}`, params: AI.buildNeedsParams(SONNET, t) };
  }).filter(Boolean);
}
function applyNeeds(works, out) {
  let usd = 0;
  for (const [cid, res] of out) {
    const w = works[Number(cid.split("-")[1])];
    if (!w || res.type !== "succeeded") { report.notes.push(`3단계 실패: ${w ? w.title : cid} (${res.type})`); continue; }
    usd += costOf(SONNET.model, res.message.usage || {});
    try {
      const valid = new Set(w.sample.filter((c) => c.lab).map((c) => c.n));
      w.needsMap = (AI.parseJson(res.message).needs || [])
        .map((x) => ({ ...x, refs: [...new Set((x.refs || []).filter((n) => valid.has(n)))].slice(0, 8) })).filter((x) => x.refs.length);
    } catch (e) { report.notes.push(`3단계 해석 실패: ${w.title} ${e.message}`); }
  }
  return usd;
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { version: 1, platform: "kakaopage", generated_at: new Date().toISOString(), cfg: CFG, models: { haiku: HAIKU, sonnet: SONNET },
  cost: { theme: 0, haiku: 0, needs: 0 }, batches: {}, notes: [], dropped: 0, scrubbed: 0 };
let works = [];
// 공개되는 결과에 댓글 원문이 그대로 실리지 않게: AI가 쓴 글이 어떤 댓글과 공백 빼고 12자 넘게 겹치면 가린다
const GRAM = 12;
function scrubber(w) {
  const norm = (s) => String(s || "").replace(/\s+/g, ""), grams = new Set();
  for (const c of w.sample || []) { const t = norm(c.text); for (let i = 0; i + GRAM <= t.length; i++) grams.add(t.slice(i, i + GRAM)); }
  return (s) => {
    const t = norm(s);
    for (let i = 0; i + GRAM <= t.length; i++) if (grams.has(t.slice(i, i + GRAM))) { report.scrubbed++; return "(댓글 원문과 겹쳐 가림)"; }
    return s;
  };
}
function save() {
  report.requests = K.requests;
  report.scrubbed = 0;
  report.works = works.map((w) => {
    const sc = scrubber(w);
    return {
      id: w.id, title: w.title, webtoon: w.webtoon, bl: w.bl, genre: w.genre,
      episodes: w.episodes.filter((e) => e.analyzed).map(({ _like, _pool, ...e }) => e),
      episodeCount: w.episodes.length,
      themes: (w.themes || []).map((t) => ({ ...t, label: sc(t.label), def: sc(t.def) })), untagged: w.untagged ?? null,
      // 원문(text)은 넣지 않는다 — 번호·댓글 uid·시각·좋아요·표시만 (보고서는 내 컴퓨터에서 uid로 원문을 다시 받아 만든다)
      // AI가 쓴 짧은 '목록에 없는 바람'(nn)도 원문과 겹치면 가린다
      comments: (w.sample || []).map(({ text, ...c }) => (c.lab ? { ...c, lab: { ...c.lab, nn: c.lab.nn ? sc(c.lab.nn) : c.lab.nn } } : c)),
      needStats: w.needStats || {}, newNeeds: Object.fromEntries(Object.entries(w.newNeeds || {}).map(([k, v]) => [sc(k), v])),
      needsMap: w.needsMap ? w.needsMap.map((x) => ({ ...x, need: sc(x.need), evidence: sc(x.evidence), why: sc(x.why) })) : null
    };
  });
  writeFileSync(args.out, JSON.stringify(report));
}
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  mkdirSync("state", { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
const { stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: T_START, charge, report, log });

try {
  for (const id of args.ids) works.push(await collect(id));
  for (const w of works) pickSample(w);
  log(`수집 끝: 요청 ${K.requests}번, 분석 대상 ${works.reduce((t, w) => t + w.sample.length, 0)}개`);
  if (args.collectOnly) { save(); log("수집만 하고 끝냅니다 (--collect-only)"); process.exit(0); }

  // 돈 확인
  const live = works.filter((w) => w.sample.length);
  if (!live.length) throw new Error("분석할 댓글을 하나도 받지 못해 AI를 부르지 않습니다");
  const nC = works.reduce((t, w) => t + w.sample.length, 0);
  const est = nC * EST_PER_COMMENT + live.length * (EST_THEME_WORK + EST_NEEDS_WORK);
  const spent0 = state.spend[MONTH] || 0;
  log(`예상 비용 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용 $${spent0.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 시범 상한을 넘어 보내지 않습니다");
  if (spent0 + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");
  // 단계마다 다시 확인: 앞 단계가 예상보다 비쌌으면 남은 단계를 보내지 않는다
  const recheck = (remaining, label) => {
    const runSoFar = (state.spend[MONTH] || 0) - spent0;
    if (runSoFar + remaining > args.capUsd) throw new Error(`${label}: 이번 시범 상한을 넘을 것 같아 보내지 않습니다 (지금까지 $${runSoFar.toFixed(3)})`);
    if ((state.spend[MONTH] || 0) + remaining > args.limitUsd) throw new Error(`${label}: 이 달 한도를 넘을 것 같아 보내지 않습니다`);
  };

  await stage("1단계(Sonnet) 반복 반응 찾기", themeRequests(works), live.length * EST_THEME_WORK, "theme", (out) => applyThemes(works, out));
  save();
  if (!works.some((w) => w.themes && w.themes.length)) throw new Error("반복 반응 묶음을 하나도 받지 못했습니다");

  if (!MOCK) recheck(nC * EST_PER_COMMENT + live.length * EST_NEEDS_WORK, "2단계");
  await stage("2단계(Haiku) 댓글 표시", classifyRequests(works), nC * EST_PER_COMMENT, "haiku", (out) => {
    const a = applyLabels(works, out);
    if (a.failed) report.notes.push(`2단계 실패한 묶음 ${a.failed}개`);
    return a.usd;
  });
  for (const w of works) { judge(w); themeStats(w); }
  save();

  if (!MOCK) recheck(live.length * EST_NEEDS_WORK, "3단계");
  await stage("3단계(Sonnet) 참고용 니즈 맵", needsRequests(works), live.length * EST_NEEDS_WORK, "needs", (out) => applyNeeds(works, out));
} catch (e) {
  report.error = e instanceof KakaoBlocked ? "카카오가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  save();
  const usd = report.cost.theme + report.cost.haiku + report.cost.needs;
  const lines = [`## 카카오 회차 댓글 분석 시범 (반복 반응)`, `- 작품: ${works.map((w) => w.title).join(", ")}`, `- 카카오 요청 ${K.requests}번`,
    `- 표시한 댓글 ${works.reduce((t, w) => t + (w.sample || []).filter((c) => c.lab).length, 0)}개, 반복 반응 묶음 ${works.map((w) => (w.themes || []).length).join("·")}개`,
    `- '불호' 묶음에서 뺀 겉말 불평 ${report.dropped}개, 원문과 겹쳐 가린 글 ${report.scrubbed || 0}개`,
    `- AI 비용 $${usd.toFixed(3)} (묶음 찾기 $${report.cost.theme.toFixed(3)} + 표시 $${report.cost.haiku.toFixed(3)} + 니즈 맵 $${report.cost.needs.toFixed(3)}) / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : [])];
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
