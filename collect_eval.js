#!/usr/bin/env node
/**
 * Codyssey 동료평가 이력 수집기 v2 (2026-07-17 개편)
 *
 * 수집 경로 (2026-07-17 슬롯 수집 폐기판 — 세션 소유자 단독 데이터 비대칭 이슈로 제거):
 *   1) 길드 detail API → 멤버 명부 (또는 --members 직접 지정)
 *   3) 평가 목록: ev/request/mbrSearch/searchList — ✅ mbrId 반영 (타인 평가 목록 수집 가능)
 *   4) 평가 상세: ev/request/mtlEvlTxnDtoByPkList (evlNo+evlDegr) — 평가자 mbrId/실명,
 *      상태, 점수, 취소 사유, 요청 시각(regDt) 포함. 신규/상태변경 건에만 증분 호출
 *   5) docs/data/YYYY-MM.json 병합 저장
 *
 * 사용법:
 *   CODYSSEY_SESSION="JSESSIONID=xxxx" node collect_eval.js --month 7
 *   node collect_eval.js --members 1000271067,1000275060 --dry-run   # 소수 테스트
 *   COLLECT_FEEDBACK=1  # 피드백 본문까지 수집 (기본 OFF — 민감정보)
 *
 * 필요 환경변수:
 *   CODYSSEY_SESSION (필수)  "JSESSIONID=xxx" 또는 값만
 *   INST_CD         (선택, 기본 00021)
 */

const fs = require("fs");
const path = require("path");
const evalPlan = require("./lib/eval-plan");

const API_BASE = "https://api.usr.codyssey.kr/";

/* ---------------- 확정된 실측 설정 (2026-07-16 확인) ---------------- */
const CONF = {
  // 평가 상태 코드 (fixedCd)
  status: { "00006": "COMPLETED", "00005": "CANCELLED", "00004": "CANCELLED" },
  // 취소 주체: 00005(평가요청취소)=피평가자, 00004(평가거절)=평가자
  cancelRole: { "00005": "EVALUATEE", "00004": "EVALUATOR" },
  instCd: process.env.INST_CD || "00021",
  guildSeasonId: parseInt(process.env.GUILD_SEASON || "5", 10),
  weekNo: parseInt(process.env.GUILD_WEEK || "9", 10),
  scheduleType: "request",
};
/* ------------------------------------------------------------------ */

function parseArgs() {
  const now = new Date();
  const cfg = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    days: 0,
    members: null,      // "id1,id2" → 명부 없이 직접 지정
    rosterFile: null,   // JSON 파일 [{mbrId,name,level,guild}]
    rosterCache: null,  // 네트워크 명부 조회 후 저장할 캐시 경로 (Actions cache와 연동)
    guilds: (process.env.GUILDS || "3,4,5,6").split(",").map((s) => parseInt(s, 10)).filter(Boolean),
    outDir: path.join(__dirname, "docs", "data"),
    delay: 300,
    dryRun: false,
    selfId: process.env.SELF_MBR_ID || null, // 세션 소유자 mbrId (selfOnly 모드 귀속용)
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--year": cfg.year = parseInt(args[++i], 10); break;
      case "--month": cfg.month = parseInt(args[++i], 10); break;
      case "--days": cfg.days = parseInt(args[++i], 10); break;
      case "--members": cfg.members = args[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--roster-file": cfg.rosterFile = args[++i]; break;
      case "--roster-cache": cfg.rosterCache = args[++i]; break;
      case "--guilds": cfg.guilds = args[++i].split(",").map((s) => parseInt(s, 10)).filter(Boolean); break;
      case "--season": CONF.guildSeasonId = parseInt(args[++i], 10); break;
      case "--week": CONF.weekNo = parseInt(args[++i], 10); break;
      case "--inst": CONF.instCd = args[++i]; break;
      case "--out": cfg.outDir = args[++i]; break;
      case "--delay": cfg.delay = parseInt(args[++i], 10); break;
      case "--self": cfg.selfId = String(args[++i]); break;
      case "--dry-run": cfg.dryRun = true; break;
      case "-h": case "--help":
        console.log("사용법: CODYSSEY_SESSION=... node collect_eval.js [--month M] [--members ids] [--guilds 3,4,5,6] [--dry-run]");
        process.exit(0);
    }
  }
  return cfg;
}

function loadSession() {
  let raw = process.env.CODYSSEY_SESSION;
  if (!raw) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, ".session-cookies.json"), "utf-8"));
      if (j.cookies && j.cookies.JSESSIONID) raw = "JSESSIONID=" + j.cookies.JSESSIONID;
      else if (j.session) raw = j.session;
    } catch (_) { /* ignore */ }
  }
  if (!raw) { console.error("❌ CODYSSEY_SESSION 이 없습니다."); process.exit(2); }
  return raw.includes("=") ? raw : `JSESSIONID=${raw}`;
}

let SESSION = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const dotYmd = (y, m, d) => `${y}.${pad(m)}.${pad(d)}`;

async function fetchJson(url, { body, method = "POST" } = {}) {
  // 레퍼런스(codyssey_Jail_Tracker)와 동일한 헤더 구성: 브라우저 UA + ko Accept-Language
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: SESSION,
  };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: body === undefined ? "null" : body }),
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`SESSION_EXPIRED(${res.status})`);
    err.sessionExpired = true;
    throw err;
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 아래 에러에서 진단 로그 */ }
  if (!json || json.code !== 200) {
    throw new Error(`${url} → code=${json && json.code} (HTTP ${res.status}) body[:200]=${text.slice(0, 200)}`);
  }
  return json.result;
}

/* form-urlencoded POST 버전 (mbrSearch/PkList 계열용) */
async function fetchFormJson(endpoint, params) {
  const res = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: SESSION,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`SESSION_EXPIRED(${res.status})`);
    err.sessionExpired = true;
    throw err;
  }
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 200) throw new Error(`${endpoint} → code=${json && json.code} (HTTP ${res.status})`);
  return json.result;
}

/* ---------------- 1) 멤버 명부 ---------------- */
async function fetchRoster(cfg) {
  if (cfg.rosterFile) {
    console.log(`  로스터 캐시 사용 (${cfg.rosterFile}) — 길드 API 생략`);
    const list = JSON.parse(fs.readFileSync(cfg.rosterFile, "utf-8"));
    return list.map((m) => ({ mbrId: String(m.mbrId), name: m.name || m.mbrNm || "", level: m.level ?? null, guild: m.guild || m.guildNm || null }));
  }
  if (cfg.members) {
    return cfg.members.map((id) => ({ mbrId: id, name: id, level: null, guild: null }));
  }

  const roster = new Map();
  for (const gid of cfg.guilds) {
    const url = `${API_BASE}guild/${gid}/detail?guildSeasonId=${CONF.guildSeasonId}&weekNo=${CONF.weekNo}`;
    try {
      const result = await fetchJson(url, { method: "GET" });
      const guildNm = result && result.guildInfo && result.guildInfo.guildNm;
      const members = (result && result.members) || [];
      for (const m of members) {
        if (!m.mbrId) continue;
        roster.set(String(m.mbrId), {
          mbrId: String(m.mbrId),
          name: m.mbrNm || String(m.mbrId),
          level: m.level ?? null,
          guild: guildNm || String(gid),
        });
      }
      console.log(`  길드 #${gid} "${guildNm}" → 멤버 ${members.length}명`);
    } catch (err) {
      console.warn(`  ⚠️ 길드 #${gid} 명부 실패: ${err.message}`);
    }
    await sleep(cfg.delay);
  }
  if (roster.size === 0) {
    console.error("❌ 길드 명부를 얻지 못했습니다. --guilds/--season/--week 또는 --members 확인");
    process.exit(2);
  }
  return [...roster.values()];
}

/* ---------------- 4) mbrSearch 계열 (타인 mbrId 반영 확정, 2026-07-17) ----------------
 * ev/request/mbrSearch/searchList  : 멤버별 평가 목록 (evlNo/evlDegr/상태/과제/기간)
 * ev/request/mtlEvlTxnDtoByPkList  : 평가 1건의 트랜잭션 행들 — 평가자 mbrId/실명,
 *                                    상태, 점수, 취소 사유, 요청 시각(regDt) 포함
 */
function toIso(dt) {
  const s2 = String(dt || "").trim();
  const m = s2.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00` : null;
}

async function fetchMemberEvals(mbrId, cfg) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const result = await fetchFormJson("ev/request/mbrSearch/searchList", {
      mbrId: String(mbrId),
      instCd: CONF.instCd,
      page: String(page),
      pagePerRows: "50",
      orderBy: "DESC",
    });
    const list = Array.isArray(result) ? result : (result && result.list) || [];
    out.push(...list);
    if (list.length < 50) break;
    await sleep(cfg.delay);
  }
  return out;
}

async function fetchEvalDetail(evlNo, evlDegr) {
  const result = await fetchFormJson("ev/request/mtlEvlTxnDtoByPkList", {
    evlNo: String(evlNo),
    evlDegr: String(evlDegr),
  });
  return Array.isArray(result) ? result : (result && result.list) || [];
}

// 상태 판정은 API가 주는 한글 명(mtlEvlStusNm) 기준 (코드 체계 추정 회피)
function classifyStus(nm) {
  const t = String(nm || "");
  if (t.includes("완료")) return "COMPLETED";
  if (t.includes("취소") || t.includes("거절")) return "CANCELLED";
  if (t.includes("진행")) return "IN_PROGRESS";
  return "REQUESTED";
}
function cancelRoleFromNm(nm) {
  const t = String(nm || "");
  if (t.includes("거절")) return "EVALUATOR";        // 평가거절 → 평가자가 취소
  if (t.includes("취소")) return "EVALUATEE";        // 평가요청취소 → 피평가자(요청자)가 취소
  return null;
}

function txnToEvent(tx, summary, evaluatee, feedbackOn) {
  const planned = toIso(tx.mtlEvlPamBgngDt) || toIso(tx.mtlEvlBgngDt)
    || (summary ? toIso(summary.evlBgngDt) : null);
  const stusNm = tx.mtlEvlStusNm || (summary && summary.evlStusNm) || "";
  const status = classifyStus(stusNm);
  const ev = {
    evalId: String(tx.mtlEvlSn || `x${(summary && summary.evlNo) || tx.evlNo}-${tx.evlMbrId || "?"}`),
    evlNo: String(tx.evlNo || (summary && summary.evlNo) || ""),
    evlDegr: String(tx.evlDegr != null ? tx.evlDegr : (summary && summary.evlDegr) || ""),
    slotDateTime: planned,
    endTime: toIso(tx.mtlEvlPamEndDt || tx.mtlEvlEndDt) ? String(toIso(tx.mtlEvlPamEndDt || tx.mtlEvlEndDt)).slice(11, 16) : null,
    evaluatorId: tx.evlMbrId ? String(tx.evlMbrId) : null,
    evaluatorName: tx.evlMbrNm || null,
    evaluateeId: String(evaluatee.mbrId),
    evaluateeName: evaluatee.name || null,
    projectName: (summary && (summary.uqstnNm || summary.projectNm)) || "",
    trackName: (summary && summary.lcorsNm) || "",
    status,
    stusCd: String(tx.mtlEvlStusCd || ""),
    stusNm,
    score: tx.mtlEvlScr != null ? tx.mtlEvlScr : (summary && summary.evlScr != null ? summary.evlScr : null),
    resultNm: tx.mtlEvlResltNm || (summary && summary.evlResltNm) || null,
    requestedAt: toIso(tx.regDt), // 요청(등록) 시각 — scheduleAllList엔 없던 필드
    src: "txn",
    detail: null,
  };
  if (feedbackOn && tx.evlFdbkCn) ev.feedback = String(tx.evlFdbkCn);
  if (status === "CANCELLED") {
    const role = cancelRoleFromNm(stusNm);
    ev.cancel = {
      by: role,
      byId: role === "EVALUATOR" ? ev.evaluatorId : role === "EVALUATEE" ? ev.evaluateeId : null,
      byName: role === "EVALUATOR" ? ev.evaluatorName : role === "EVALUATEE" ? ev.evaluateeName : null,
      reasonCd: tx.evlDmndRtrcnRsnCd || null,
      reasonNm: tx.evlDmndRtrcnRsnNm || stusNm,
      reason: tx.rjctRsnCn || null, // 취소/거절 사유 본문
      at: toIso(tx.mdfcnDt),        // 수정 시각 ≈ 취소 시각 (근사)
    };
  }
  return ev;
}

// 상세가 비어있는 신규 평가(요청 단계) — 목록 행으로 최소 이벤트 구성 (평가자 미상)
function summaryToEvent(summary, evaluatee) {
  const stusNm = summary.evlStusNm || "";
  return {
    evalId: `s${summary.evlNo}-${summary.evlDegr}`,
    evlNo: String(summary.evlNo), evlDegr: String(summary.evlDegr),
    slotDateTime: toIso(summary.evlBgngDt),
    endTime: null,
    evaluatorId: null, evaluatorName: null,
    evaluateeId: String(evaluatee.mbrId), evaluateeName: evaluatee.name || null,
    projectName: summary.uqstnNm || summary.projectNm || "",
    trackName: summary.lcorsNm || "",
    status: classifyStus(stusNm),
    stusCd: String(summary.evlStusCd || ""), stusNm,
    score: summary.evlScr != null ? summary.evlScr : null,
    resultNm: summary.evlResltNm || null,
    requestedAt: null,
    src: "summary",
    detail: null,
  };
}

/* ---------------- main ---------------- */
async function main() {
  const cfg = parseArgs();
  SESSION = loadSession();
  const feedbackOn = process.env.COLLECT_FEEDBACK === "1";

  let fromDate, toDate, outY, outM;
  if (cfg.days > 0) {
    const end = new Date(); const start = new Date(); start.setDate(start.getDate() - (cfg.days - 1));
    fromDate = start; toDate = end; outY = end.getFullYear(); outM = end.getMonth() + 1;
  } else {
    fromDate = new Date(cfg.year, cfg.month - 1, 1);
    toDate = new Date(cfg.year, cfg.month, 0, 23, 59, 59);
    outY = cfg.year; outM = cfg.month;
  }
  const inRange = (iso) => { if (!iso) return false; const t = new Date(iso); return t >= fromDate && t <= toDate; };

  console.log("▶ 1단계: 멤버 명부 수집");
  const roster = await fetchRoster(cfg);
  console.log(`  명부 ${roster.length}명`);

  // 네트워크에서 새로 얻은 명부만 캐시에 저장한다.
  // (--roster-file/--members 경유는 신선도 스탬프를 오염시키므로 제외)
  // 명부(mbrId·이름·레벨·길드)는 준정적이라 하루 3~4회 갱신이면 충분하다.
  if (cfg.rosterCache && roster.length && !cfg.rosterFile && !cfg.members) {
    try {
      fs.mkdirSync(path.dirname(cfg.rosterCache), { recursive: true });
      fs.writeFileSync(cfg.rosterCache, JSON.stringify(roster));
      fs.writeFileSync(`${cfg.rosterCache}.fetched`, String(Math.floor(Date.now() / 1000)));
      console.log(`  로스터 캐시 저장 (${cfg.rosterCache})`);
    } catch (err) {
      console.warn(`  ⚠️ 로스터 캐시 저장 실패 (무시): ${err.message}`);
    }
  }

  // 기존 데이터 로드 (증분 수집 + 병합용)
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const outFile = path.join(cfg.outDir, `${outY}-${pad(outM)}.json`);
  let existing = { events: [], members: [], slots: [] };
  try { existing = JSON.parse(fs.readFileSync(outFile, "utf-8")); } catch (_) {}
  // v1(scheduleAllList 기반, src 없음) 이벤트는 v2(mbrSearch 기반, src 있음)로 대체 — 중복 방지
  existing.events = (existing.events || []).filter((e) => e && e.src);
  // 평가 단위별 마지막 확인 base 코드 (Trigger A 판정 기준, 첫 실행이면 비어 있어 전체 대상)
  const evalStatus = (existing.meta && existing.meta.evalStatus) || {};

  // 3단계: 멤버별 평가 목록 (mbrSearch — mbrId 반영 실측 확정)
  console.log(`▶ 2단계: 멤버별 평가 목록 (mbrSearch, ${roster.length}명)`);
  const summaries = [];
  for (let i = 0; i < roster.length; i++) {
    const m = roster[i];
    try {
      const rows = await fetchMemberEvals(m.mbrId, cfg);
      for (const r of rows) summaries.push({ member: m, row: r });
    } catch (e) {
      if (e.sessionExpired) { console.error("❌ 세션 만료. CODYSSEY_SESSION 갱신 필요"); process.exit(3); }
      console.warn(`  ⚠️ ${m.name || m.mbrId} 목록 실패: ${e.message}`);
    }
    if ((i + 1) % 10 === 0 || i === roster.length - 1) console.log(`  [${i + 1}/${roster.length}] 누적 ${summaries.length}건`);
    await sleep(cfg.delay);
  }
  const uniq = new Map();
  for (const sm of summaries) {
    const k = `${sm.member.mbrId}|${sm.row.evlNo}|${sm.row.evlDegr}`;
    if (!uniq.has(k)) uniq.set(k, sm);
  }
  console.log(`  고유 평가 ${uniq.size}건 (중복 제거 후)`);

  // 4단계: 상세 수집 — Trigger A(base 코드 변화)만 증분 대상으로 선정한다.
  // 과거 구현은 base/txn 도메인의 stusCd를 한 Set에 섞어 비교해 코드 충돌 시
  // 갱신이 영구 스킵되고, 대부분 평가가 매번 재조회됐다 (2026-07-19 사례, 매 실행 323건).
  const targets = [...uniq.values()].filter(({ row }) => evalPlan.isBaseChanged(row, evalStatus));
  console.log(`▶ 3단계: 평가 상세 수집 (대상 ${targets.length}건 / 전체 ${uniq.size}건)`);
  const newEvents = [];
  const fetchedKeys = new Set(); // 이번 실행에 상세를 본 평가 (스윕 중복 호출 방지)
  let done = 0;
  for (const { member, row } of targets) {
    const key = evalPlan.evalKey(row.evlNo, row.evlDegr);
    fetchedKeys.add(key);
    let txs = [];
    try {
      txs = await fetchEvalDetail(row.evlNo, row.evlDegr);
      // 목록이 알려준 base 코드를 기록해 다음 실행의 판정 기준으로 삼는다.
      // (호출 실패 시 기록하지 않아 다음 실행에 자동 재시도)
      evalPlan.recordBaseCd(evalStatus, key, row.evlStusCd);
    } catch (e) {
      if (e.sessionExpired) { console.error("❌ 세션 만료. CODYSSEY_SESSION 갱신 필요"); process.exit(3); }
      console.warn(`  ⚠️ 상세 실패 (evlNo ${row.evlNo}): ${e.message}`);
    }
    if (txs.length) {
      for (const tx of txs) newEvents.push(txnToEvent(tx, row, member, feedbackOn));
    } else {
      newEvents.push(summaryToEvent(row, member));
    }
    done++;
    if (done % 20 === 0 || done === targets.length) console.log(`  [${done}/${targets.length}]`);
    await sleep(cfg.delay);
  }

  // 3.5단계: 비종결 평가 스윕 — 목록 변화 감지가 회복시켜주지 못하는 평가
  // (완료 후 목록에서 밀려난 경우 등)를 상세 API로 직접 다시 본다.
  // 평가 단위당 1회 호출로 그 평가의 트랜잭션 전체가 갱신된다.
  const sweep = evalPlan.planStaleSweep(existing.events, Date.now(), { cap: 20 })
    .filter((item) => !fetchedKeys.has(item.key));
  if (sweep.length) {
    console.log(`▶ 3.5단계: 비종결 평가 스윕 재조회 (${sweep.length}건, 오래된 종료 순)`);
    const rosterById = new Map(roster.map((m) => [String(m.mbrId), m]));
    for (const item of sweep) {
      const rep = item.representative;
      const memberObj = rosterById.get(String(rep.evaluateeId))
        || { mbrId: rep.evaluateeId, name: rep.evaluateeName || null };
      // 프로젝트/트랙명은 기존 이벤트 값으로 채워 갱신 이벤트가 정보를 잃지 않게 한다.
      const synth = {
        evlNo: rep.evlNo, evlDegr: rep.evlDegr, evlBgngDt: null,
        uqstnNm: rep.projectName, projectNm: rep.projectName, lcorsNm: rep.trackName,
        evlScr: null, evlResltNm: null, evlStusNm: rep.stusNm
      };
      let txs = [];
      try {
        txs = await fetchEvalDetail(rep.evlNo, rep.evlDegr);
      } catch (e) {
        if (e.sessionExpired) { console.error("❌ 세션 만료. CODYSSEY_SESSION 갱신 필요"); process.exit(3); }
        console.warn(`  ⚠️ 스윕 상세 실패 (${item.key}): ${e.message}`);
      }
      if (txs.length) {
        for (const tx of txs) newEvents.push(txnToEvent(tx, synth, memberObj, feedbackOn));
      } else {
        console.log(`  - 스윕: ${item.key} 상세 비어있음 (기존 상태 유지)`);
      }
      await sleep(cfg.delay);
    }
  }

  // 4단계: 병합 (기간 밖 이벤트 제외 — 기본값은 해당 월 ± 없음)
  console.log("▶ 4단계: 병합 및 저장");
  const merged = new Map((existing.events || []).map((e) => [String(e.evalId), e]));
  let droppedOut = 0;
  for (const ev of newEvents) {
    if (ev.slotDateTime && !inRange(ev.slotDateTime)) { droppedOut++; continue; }
    merged.set(String(ev.evalId), ev);
  }

  // 같은 평가에 txn 상세가 있으면 평가자 미상 summary 잔재는 정리한다.
  const dedupe = evalPlan.dropRedundantSummaries([...merged.values()]);
  if (dedupe.dropped) console.log(`  summary 잔재 정리: ${dedupe.dropped}건 제거`);
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      year: outY,
      month: outM,
      mock: false,
      eventCount: dedupe.kept.length,
      roster: roster.length,
      selfOnlyWarning: false,          // mbrSearch로 타인 평가 수집 성공 (2026-07-17 확정)
      source: "mbrSearch+pkList",
      feedbackCollected: feedbackOn,
      droppedOutOfRange: droppedOut,
      sweepTargets: sweep.length,
      dedupedSummaries: dedupe.dropped,
      evalStatus, // 평가 단위별 마지막 확인 base 코드 (Trigger A 판정 기준)
    },
    members: roster.map((m) => ({ mbrId: m.mbrId, name: m.name, level: m.level, guild: m.guild })),
    events: dedupe.kept.sort((a, b) => String(a.slotDateTime).localeCompare(String(b.slotDateTime))),
    slots: [], // 슬롯 오픈 분석 폐기 (2026-07-17) — 세션 소유자 단독 데이터 비대칭 이슈
  };

  if (cfg.dryRun) {
    console.log("▶ dry-run: 저장 생략. 샘플 3건:");
    console.log(JSON.stringify(out.events.slice(0, 3), null, 2));
    console.log(`  (기간 밖 제외 ${droppedOut}건, 총 ${out.events.length}건)`);
    return;
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✅ 저장: ${outFile} (이벤트 ${out.meta.eventCount}건, 신규/갱신 ${newEvents.length}건)`);
}

main().catch((err) => {
  console.error("❌ 수집 실패:", err.message);
  process.exit(1);
});
