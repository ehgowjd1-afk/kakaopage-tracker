/* 회차 요약 + 작품 분석 + 독자 분석 (AI) — 손으로만 도는 작업 (.github/workflows/ep-ai.yml)
 *
 * 대상: 월간 순위 웹툰·웹소설 각각 상위 N작품(--top, 기본 20) 또는 --ids.
 * ① 회차 고르기: --scope sample = 초반 3화 + 화제가 된 회차(앞뒤보다 댓글 1.5배↑, 최대 5) + 댓글이 크게 준 지점(최대 3) + 최근 10화
 *                --scope all    = 화 번호가 있는 모든 회차
 *    회차별 댓글 수는 트래커가 이미 센 표(data/comments/ep, 없으면 data/epcounts)를 쓴다.
 * ② 회차마다 공감 많은 댓글 30개(요청 1번, 2초 간격) — 작가 인사·내용 없는 댓글('웅장', '수고하셨습니다' …)은 뺀다.
 * ③ 1단계 AI(Haiku, 일괄): 회차마다 '댓글로 짐작한 이 화 내용'·독자 반응·분위기·예시 댓글 번호
 * ④ 2단계 AI(Sonnet, 일괄): 작품마다 작품 분석·독자 분석 (회차 요약 + 댓글 수 흐름 + 코드가 센 독자 통계)
 * ⑤ docs/data/epai/{id}.json + index.json — 요약·분석 글, 예시 베스트 댓글 2~3개(원문 150자까지, 사용자 결정), 숫자.
 *    닉네임은 받지 않는다. 이 달 AI 사용액은 state/ai_state.json에 더한다(카카오 월 한도 $30).
 *
 *   node scripts/cmt/ep_ai.mjs --top 20 --scope sample [--ids 1,2] [--cap-usd 5] [--limit-usd 30] [--wait-min 100] [--stop-utc HH:MM] [--refresh] [--summary FILE]
 *   이미 요약한 회차는 그대로 두고(다시 받지 않음) 새 회차만 더한다 — --refresh 면 다시 요약.
 *   --stop-utc: 이 시각(UTC)이 되면 댓글 받기를 멈추고 그때까지 받은 회차만 요약한다(나머지는 다음 실행에서 이어서).
 *   CMT_MOCK=1 이면 AI 대신 가짜 답.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fetchWork, fetchTopLiked, KakaoBlocked, cut } from "./kakao_cmt.mjs";
import * as K from "./kakao_cmt.mjs";
import { isFiller } from "../lib/cmt-filter.mjs";
import * as P from "./ep_ai_prompts.mjs";
import { createBatcher, costOf as rawCost } from "./batch.mjs";

const STATE = "state/ai_state.json";
const OUT = "docs/data/epai";
const HAIKU = { model: "claude-haiku-5-5", effort: "low" };
const SONNET = { model: "claude-sonnet-5-5", effort: "medium" };
const EST_EP = 0.0006, EST_WORK = 0.06;   // 예상(일괄, 여유 있게)
const TOP_N = 30, TEXT_MAX = 200, EX_MAX = 150;
const MOCK = !!process.env.CMT_MOCK;

const args = { top: 20, ids: null, scope: "sample", capUsd: 5, limitUsd: 30, waitMin: 100, stopUtc: null, refresh: false, summary: null };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = () => process.argv[++i];
  if (k === "--top") args.top = Number(v());
  else if (k === "--ids") args.ids = v().split(",").map((s) => s.trim()).filter(Boolean);
  else if (k === "--scope") args.scope = v();
  else if (k === "--cap-usd") args.capUsd = Number(v());
  else if (k === "--limit-usd") args.limitUsd = Number(v());
  else if (k === "--wait-min") args.waitMin = Number(v());
  else if (k === "--summary") args.summary = v();
  else if (k === "--stop-utc") args.stopUtc = v();
  else if (k === "--refresh") args.refresh = true;
  else throw new Error("모르는 옵션: " + k);
}
if (!["sample", "all"].includes(args.scope)) throw new Error("--scope 는 sample 또는 all");
if (args.ids && args.ids.some((x) => !/^\d{5,12}$/.test(x))) throw new Error("--ids 는 작품 번호");
for (const k of ["top", "capUsd", "limitUsd", "waitMin"]) if (!Number.isFinite(args[k]) || args[k] <= 0) throw new Error(`${k} 값이 숫자가 아닙니다`);
if (args.stopUtc && !/^\d{1,2}:\d{2}$/.test(args.stopUtc)) throw new Error("--stop-utc 는 HH:MM");
let STOP_AT = Infinity;
if (args.stopUtc) {
  const [h, m] = args.stopUtc.split(":").map(Number);
  const d = new Date(); d.setUTCHours(h, m, 0, 0);
  if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  STOP_AT = d.getTime();
}
const MONTH = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const log = (...a) => console.log(...a);
const readJson = (f, fb) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fb; } };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ---------------- 대상 작품 ----------------
function targets() {
  const out = [], rankOf = new Map();
  for (const [dir, name] of [["webtoon", "웹툰"], ["webnovel", "웹소설"]]) {
    for (const x of readJson(`docs/data/${dir}/monthly/latest.json`, [])) {
      if (!rankOf.has(String(x.workId))) rankOf.set(String(x.workId), `${name} 월간 ${x.rank}위`);
      if (!args.ids && x.rank <= args.top) out.push({ id: String(x.workId), rank: `${name} 월간 ${x.rank}위` });
    }
  }
  return args.ids ? args.ids.map((id) => ({ id, rank: rankOf.get(id) || null })) : out;
}

// 회차별 댓글 수: 반응 표(comments/ep) → 없으면 epcounts. 화 번호 → 댓글 수
function knownCounts(id) {
  const m = new Map();
  const ep = readJson(`docs/data/comments/ep/${id}.json`, null);
  if (ep && ep.episodes) for (const r of Object.values(ep.episodes)) { const n = String(r[1]).match(/^(\d+)화/); if (n) m.set(Number(n[1]), r[2]); }
  if (!m.size) {
    const ec = readJson(`docs/data/epcounts/${id}.json`, null);
    if (ec && ec.c) ec.c.forEach((c, i) => { if (ec.no[i] != null) m.set(ec.no[i], c); });
  }
  return m;
}

function chooseEpisodes(eps, counts) {
  const num = eps.filter((e) => e.no != null);
  const pick = new Map();
  const add = (e, why) => { if (e && !pick.has(e.id)) pick.set(e.id, { ...e, why }); };
  num.slice(0, 3).forEach((e) => add(e, "초반"));
  const cs = num.map((e) => counts.get(e.no) ?? null);
  const spikes = [], drops = [];
  num.forEach((e, i) => {
    if (cs[i] == null) return;
    const prev = med(cs.slice(Math.max(0, i - 5), i).filter((x) => x != null)), next = med(cs.slice(i + 1, i + 6).filter((x) => x != null));
    if (prev && next && cs[i] / Math.max(prev, next) >= 1.5) spikes.push({ e, r: cs[i] / Math.max(prev, next) });
    if (i >= 3 && i < num.length - 8) {
      const before = med(cs.slice(i - 3, i + 1).filter((x) => x != null)), after = med(cs.slice(i + 1, i + 5).filter((x) => x != null));
      if (before >= 20 && after / before <= 0.6) drops.push({ e, r: after / before });
    }
  });
  spikes.sort((a, b) => b.r - a.r).slice(0, 5).forEach(({ e, r }) => add({ ...e, ratio: Math.round(r * 10) / 10 }, "화제"));
  drops.sort((a, b) => a.r - b.r).slice(0, 3).forEach(({ e }) => add(e, "급감"));
  num.slice(-10).forEach((e) => add(e, "최근"));
  if (args.scope === "all") return num.map((e) => pick.get(e.id) || e);
  return [...pick.values()].sort((a, b) => a.no - b.no);
}

// 코드가 세는 독자 통계 (회차마다 공감 상위 댓글 기준)
function readerStats(eps) {
  let n = 0, live = 0, late = 0, sp = 0, rc = 0, pay = 0, drop = 0;
  for (const e of eps) for (const c of e.top || []) {
    n++;
    const d = (Date.parse(String(c.at).replace(" ", "T")) - Date.parse(String(e.reg).replace(" ", "T"))) / 86400e3;
    if (d >= 0 && d <= 1) live++;
    if (d > 365) late++;
    if (c.sp) sp++;
    rc += c.rc;
    if (/소장|결제|캐시|구매|돈\s?내|쿠키/.test(c.text)) pay++;
    if (/하차|접습니다|접을게|접어요|그만\s?볼|안\s?볼래|안\s?봄/.test(c.text)) drop++;
  }
  const pct = (x) => (n ? Math.round((100 * x) / n) : 0);
  return { n, livePct: pct(live), latePct: pct(late), spoilerPct: pct(sp), replyAvg: n ? Math.round((rc / n) * 10) / 10 : 0, payMentions: pay, dropMentions: drop };
}

// ---------------- 실행 ----------------
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.spend ||= {};
const report = { batches: {}, cost: {}, notes: [] };
function charge(usd, label) {
  if (MOCK) return;
  state.spend[MONTH] = (state.spend[MONTH] || 0) + usd;
  mkdirSync("state", { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  log(`  ${label} 비용 $${usd.toFixed(4)} → 이 달 합계 $${state.spend[MONTH].toFixed(2)}`);
}
function mockAnswer(cid) {
  if (cid.startsWith("e")) return { sum: "가짜 요약: 주인공이 결투에서 이김", react: "가짜 반응: 통쾌하다는 반응", mood: ["cheer", "shock"], ex: [1, 2], hot: "" };
  return { work: { overview: "가짜 개요", strengths: [{ point: "가짜 강점", eps: ["1화"] }], weaknesses: [], turning: [{ point: "가짜 전환점", eps: ["2화"] }], drops: [] },
    reader: { traits: [{ point: "가짜 특징", eps: ["1화"] }], live: "가짜", source: "가짜", money: "가짜", community: "가짜" } };
}
let stage = null;
const costOf = (model, u) => (MOCK ? 0 : rawCost(model, u));

const works = [];
const lines = [];
let stoppedAt = null;
try {
  for (const t of targets()) {
    if (Date.now() > STOP_AT) { stoppedAt ||= t.id; break; }
    const w = await fetchWork(t.id);
    const counts = knownCounts(t.id);
    const old = args.refresh ? null : readJson(path.join(OUT, `${t.id}.json`), null);
    const eps = chooseEpisodes(w.episodes, counts).map((e) => ({ ...e, label: `${e.no}화`, total: counts.get(e.no) ?? null }));
    for (const e of eps) {
      // 이미 요약한 회차는 그대로 쓴다 (댓글을 다시 받지 않음)
      const prev = old && old.eps && old.eps[e.label];
      if (prev && prev.s) { e.keep = prev; e.top = []; continue; }
      if (Date.now() > STOP_AT) { e.top = []; e.skipped = true; stoppedAt ||= t.id; continue; }
      try {
        const r = await fetchTopLiked(t.id, e.id, TOP_N + 10, w.authors);
        e.total ??= r.total;
        // 작가 인사·내용 없는 댓글은 분석에서 뺀다 (댓글 수에는 그대로)
        e.top = r.list.filter((c) => c.text && !isFiller(c.text)).slice(0, TOP_N);
      } catch (err) {
        if (err instanceof KakaoBlocked) throw err;
        e.top = [];
        report.notes.push(`${w.title} ${e.label} 댓글을 못 받음`);
      }
    }
    works.push({ ...w, rank: t.rank, eps });
    log(`■ ${w.title}${t.rank ? ` (${t.rank})` : ""} — 회차 ${eps.length}개 (${[...new Set(eps.map((e) => e.why).filter(Boolean))].join("·") || "전체"})`);
  }
  const nEp = works.reduce((t, w) => t + w.eps.filter((e) => e.top.length >= 3).length, 0);
  if (stoppedAt) report.notes.push(`--stop-utc ${args.stopUtc} 에 댓글 받기를 멈춤 — 남은 회차는 다음 실행에서 이어서`);
  ({ stage } = createBatcher({ mock: MOCK, mockAnswer, waitMin: args.waitMin, tStart: Date.now(), charge, report, log }));
  const est = nEp * EST_EP + works.length * EST_WORK;
  const spent0 = state.spend[MONTH] || 0;
  log(`작품 ${works.length}개, 회차 ${nEp}개, 카카오 요청 ${K.requests}번 — 예상 $${est.toFixed(2)} (상한 $${args.capUsd}) / 이 달 사용 $${spent0.toFixed(2)} (한도 $${args.limitUsd})`);
  if (est > args.capUsd) throw new Error("예상 비용이 상한을 넘어 보내지 않습니다");
  if (spent0 + est > args.limitUsd) throw new Error("이 달 한도를 넘을 것 같아 보내지 않습니다");

  // ③ 회차 요약
  const reqs = [];
  works.forEach((w, wi) => w.eps.forEach((e, ei) => {
    if (e.top.length < 3) return;
    reqs.push({ custom_id: `e${wi}-${ei}`, params: P.buildEpParams(HAIKU, { title: w.title, webtoon: w.webtoon, genre: w.genre, desc: w.desc }, e, e.top, TEXT_MAX) });
  }));
  if (reqs.length) await stage("1단계(Haiku) 회차 요약", reqs, nEp * EST_EP, "ep", (out) => {
    let usd = 0;
    for (const [cid, res] of out) {
      const [wi, ei] = cid.slice(1).split("-").map(Number);
      const e = works[wi] && works[wi].eps[ei];
      if (!e || res.type !== "succeeded") { report.notes.push(`회차 요약 실패 ${cid}`); continue; }
      usd += costOf(HAIKU.model, res.message.usage || {});
      try {
        const j = JSON.parse((res.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""));
        const ex = [...new Set(j.ex || [])].map((k) => e.top[k - 1]).filter((c) => c && !c.sp).slice(0, 3);
        e.ai = { s: cut(j.sum, 140), r: cut(j.react, 140), m: (j.mood || []).filter((m) => P.MOODS[m]).slice(0, 3), h: cut(j.hot || "", 90),
          ex: ex.map((c) => [cut(c.text, EX_MAX), c.like]) };
      } catch { report.notes.push(`회차 요약 해석 실패 ${cid}`); }
    }
    return usd;
  });

  // ④ 작품·독자 분석
  for (const w of works) for (const e of w.eps) if (!e.ai && e.keep) e.ai = { s: e.keep.s, r: e.keep.r, m: e.keep.m || [], h: e.keep.h || "", ex: e.keep.ex || [] };
  const MAX_LINES = 450;
  const wreqs = works.map((w, wi) => {
    let done = w.eps.filter((e) => e.ai);
    if (!done.length) return null;
    if (done.length > MAX_LINES) {
      const tagged = done.filter((e) => e.why), rest = done.filter((e) => !e.why);
      const step = rest.length / Math.max(1, MAX_LINES - tagged.length);
      const spaced = rest.filter((_, i) => Math.floor(i / step) !== Math.floor((i - 1) / step));
      done = [...tagged, ...spaced].sort((a, b) => a.no - b.no);
    }
    const fresh = readerStats(w.eps);
    const oldStats = (readJson(path.join(OUT, `${w.id}.json`), {}) || {}).stats;
    w.stats = fresh.n >= ((oldStats && oldStats.n) || 0) ? fresh : oldStats;
    const text = [`[작품] ${w.title} / ${w.webtoon ? "웹툰" : "웹소설"}${w.genre ? " / " + w.genre : ""}${w.rank ? ` / ${w.rank}` : ""}`, `[작품 소개] ${w.desc || "-"}`,
      `[독자 통계] 회차마다 공감 상위 댓글 ${w.stats.n}개 기준: 공개 하루 안에 단 댓글 ${w.stats.livePct}%, 공개 1년 뒤 단 댓글 ${w.stats.latePct}%, 스포일러 표시 ${w.stats.spoilerPct}%, 댓글당 답글 평균 ${w.stats.replyAvg}개, 결제·소장 언급 ${w.stats.payMentions}개, 하차 언급 ${w.stats.dropMentions}개`,
      `[전체 회차] ${w.episodes.length}개 (아래는 그중 요약이 있는 ${done.length}개)`, "", "[회차별] 회차 (공개일 · 댓글 수 · 고른 이유) 내용 / 반응 / 분위기"];
    for (const e of done) text.push(`${e.label} (${String(e.reg).slice(0, 10)} · ${e.total ?? "-"}개${e.ratio ? ` · 앞뒤의 ${e.ratio}배` : ""} · ${e.why || ""}) ${e.ai.s} / ${e.ai.r} / ${e.ai.m.map((m) => P.MOODS[m]).join(",")}${e.ai.h ? " / 화제: " + e.ai.h : ""}`);
    return { custom_id: `w${wi}`, params: P.buildWorkParams(SONNET, text.join("\n")) };
  }).filter(Boolean);
  if (wreqs.length) {
    const runSoFar = (state.spend[MONTH] || 0) - spent0;
    if (!MOCK && runSoFar + wreqs.length * EST_WORK > args.capUsd) throw new Error("2단계: 상한을 넘을 것 같아 보내지 않습니다");
    await stage("2단계(Sonnet) 작품·독자 분석", wreqs, wreqs.length * EST_WORK, "work", (out) => {
      let usd = 0;
      for (const [cid, res] of out) {
        const w = works[Number(cid.slice(1))];
        if (!w || res.type !== "succeeded") { report.notes.push(`작품 분석 실패 ${cid}`); continue; }
        usd += costOf(SONNET.model, res.message.usage || {});
        try { w.analysis = JSON.parse((res.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")); }
        catch { report.notes.push(`작품 분석 해석 실패 ${w.title}`); }
      }
      return usd;
    });
  }
} catch (e) {
  report.error = e instanceof KakaoBlocked ? "카카오가 요청을 막아 멈췄습니다" : e.message;
  console.error("오류:", e.message);
  process.exitCode = 1;
} finally {
  // ⑤ 저장: 요약이 하나라도 있는 작품만
  mkdirSync(OUT, { recursive: true });
  const index = readJson(path.join(OUT, "index.json"), { ids: {} });
  let saved = 0;
  for (const w of works) {
    for (const e of w.eps) if (!e.ai && e.keep) e.ai = { s: e.keep.s, r: e.keep.r, m: e.keep.m || [], h: e.keep.h || "", ex: e.keep.ex || [] };
    const eps = w.eps.filter((e) => e.ai);
    if (!eps.length) continue;
    const old = readJson(path.join(OUT, `${w.id}.json`), null) || {};
    writeFileSync(path.join(OUT, `${w.id}.json`), JSON.stringify({
      v: 1, at: TODAY, scope: args.scope, rank: w.rank || old.rank || null, model: { ep: HAIKU.model, work: SONNET.model },
      eps: Object.fromEntries(eps.map((e) => [e.label, { at: String(e.reg).slice(0, 10), n: e.total, why: e.why || "", ...e.ai }])),
      stats: w.stats || old.stats || null, work: w.analysis ? w.analysis.work : old.work || null, reader: w.analysis ? w.analysis.reader : old.reader || null,
    }));
    index.ids[w.id] = TODAY;
    saved++;
  }
  writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index));
  lines.push(`## 회차 요약·작품 분석 (AI)`, `- 작품 ${works.length}개 중 저장 ${saved}개, 회차 요약 ${works.reduce((t, w) => t + w.eps.filter((e) => e.ai).length, 0)}개(이번에 새로 ${works.reduce((t, w) => t + w.eps.filter((e) => e.ai && !e.keep).length, 0)}개), 작품 분석 ${works.filter((w) => w.analysis).length}개`,
    `- 아직 못 받은 회차 ${works.reduce((t, w) => t + w.eps.filter((e) => e.skipped).length, 0)}개${stoppedAt ? " (시간이 되어 멈춤 — 다음 실행에서 이어서)" : ""}`,
    `- 카카오 요청 ${K.requests}번`, `- AI 비용 회차 $${(report.cost.ep || 0).toFixed(3)} + 작품 $${(report.cost.work || 0).toFixed(3)} / 이 달 합계 $${(state.spend[MONTH] || 0).toFixed(2)}`,
    ...report.notes.slice(0, 20).map((n) => "- " + n), ...(report.error ? ["- 오류: " + report.error] : []));
  log(lines.join("\n"));
  if (args.summary) appendFileSync(args.summary, lines.join("\n") + "\n");
}
