#!/usr/bin/env node
/**
 * Codyssey 동료평가 이력 수집기 v2 (2026-07-17 개편)
 *
 * 수집 경로:
 *   1) 길드 detail API → 멤버 명부 (또는 --members 직접 지정)
 *   2) 오픈 슬롯: schedule/scheduleAllList/ — ⚠️ mbrId 무시(세션 소유자 슬롯만) 임의 1회 호출
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
 *   INST_CD         (선택, 기본 00021) / SELF_MBR_ID (선택, 슬롯 귀속)
 */

const fs = require("fs");
const path = require("path");

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

/* ---------------- 2) 멤버별 스케줄 → 평가 이벤트(부분) ---------------- */
function toPartial(row, owner) {
  if (row.scdlGubunCd !== "EV") return null;
  const detail = String(row.reqDetail || "");
  let role = null; // owner 입장에서의 역할
  if (detail.startsWith("R||")) role = "EVALUATEE";   // owner가 평가 요청(피평가)
  else if (detail.startsWith("A||")) role = "EVALUATOR"; // owner가 평가 수락(평가자)
  if (!role) return null;

  const d = String(row.bgngYmd || "").replace(/\D/g, "");
  const tm = /^\d{2}:\d{2}$/.test(row.bgngTm || "") ? row.bgngTm : "00:00";
  if (d.length !== 8) return null;

  return {
    scdlId: String(row.scdlId),
    slotDateTime: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${tm}:00+09:00`,
    endTime: typeof row.endTm === "string" ? row.endTm : null,
    projectName: row.title || "",
    trackName: row.divNm || "",
    fixedCd: String(row.fixedCd || ""),
    fixedNm: row.fixedNm || "",
    rtrcnRsnCd: row.evlDmndRtrcnRsnCd || null,
    ownerId: owner.mbrId,
    role,
    // A행에서 scdlReqUsr = 상대(피평가자) 이름 / R행에서 scdlReqUsr = 상대(평가자) 이름
    counterpartName: row.scdlReqUsr || null,
  };
}

/**
 * 멤버 스케줄 1회 호출로 평가 이벤트(reqList) + 오픈 슬롯(timeList)을 함께 추출.
 * timeList = 해당 멤버가 "평가 가능"으로 열어둔 슬롯 (reqYn==="Y" 이면 평가와 매칭된 슬롯)
 */
async function fetchMemberSchedule(member, fromYmd, toYmd, cfg) {
  const q = new URLSearchParams({
    mbrId: member.mbrId,
    instCd: CONF.instCd,
    bgngYmd: fromYmd,
    endYmd: toYmd,
    scheduleType: CONF.scheduleType,
  });
  const result = await fetchJson(`${API_BASE}schedule/scheduleAllList/?${q.toString()}`, { body: "null" });
  const evalPartials = ((result && result.reqList) || [])
    .map((r) => toPartial(r, member))
    .filter(Boolean);
  const slots = ((result && result.timeList) || [])
    .map((row) => {
      // evlPsblYmdTm: "2026-07-16 14:00" 우선, 없으면 bgngYmd + fixedNm("14:00 ~ 14:30")
      let d = null, t = null;
      if (row.evlPsblYmdTm) {
        d = String(row.evlPsblYmdTm).slice(0, 10);
        t = String(row.evlPsblYmdTm).slice(11, 16);
      } else if (row.bgngYmd) {
        const digits = String(row.bgngYmd).replace(/\D/g, "");
        if (digits.length === 8) d = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        t = String(row.fixedNm || "").split("~")[0].trim();
      }
      if (!d || !/^\d{2}:\d{2}$/.test(t || "")) return null;
      return {
        d, t,
        m: member.mbrId,
        id: row.scdlId ?? null,
        matched: row.reqYn === "Y", // 이미 평가와 매칭된 슬롯 여부
      };
    })
    .filter(Boolean);
  return { evalPartials, slots };
}

/* ---------------- 3) scdlId 병합 → 최종 이벤트 ---------------- */
function buildFinalEvents(partials, roster) {
  const nameOf = new Map(roster.map((m) => [m.mbrId, m.name]));
  const uniqueNameToId = new Map();
  {
    const count = new Map();
    for (const m of roster) count.set(m.name, (count.get(m.name) || 0) + 1);
    for (const m of roster) if (count.get(m.name) === 1) uniqueNameToId.set(m.name, m.mbrId);
  }

  const byScdl = new Map();
  for (const p of partials) {
    if (!byScdl.has(p.scdlId)) byScdl.set(p.scdlId, []);
    byScdl.get(p.scdlId).push(p);
  }

  const events = [];
  for (const [scdlId, list] of byScdl) {
    const a = list.find((x) => x.role === "EVALUATOR") || null;   // 평가자 소유 행
    const r = list.find((x) => x.role === "EVALUATEE") || null;   // 피평가자 소유 행
    const base = a || r;

    let evaluatorId = a ? a.ownerId : null;
    let evaluateeId = r ? r.ownerId : (a && a.counterpartName ? uniqueNameToId.get(a.counterpartName) || null : null);
    // R행만 있는 경우: scdlReqUsr(상대=평가자) 이름으로 평가자 보강
    if (!evaluatorId && r && r.counterpartName) {
      evaluatorId = uniqueNameToId.get(r.counterpartName) || null;
    }
    const evaluatorName = evaluatorId
      ? (nameOf.get(evaluatorId) || null)
      : (r && r.counterpartName) || null;
    const evaluateeName = evaluateeId
      ? (nameOf.get(evaluateeId) || null)
      : (a && a.counterpartName) || null;

    const status = CONF.status[base.fixedCd] || "REQUESTED";
    const ev = {
      evalId: scdlId,
      slotDateTime: base.slotDateTime,
      endTime: base.endTime,
      evaluatorId, evaluatorName,
      evaluateeId, evaluateeName,
      projectName: base.projectName,
      trackName: base.trackName,
      fixedCd: base.fixedCd,
      status,
      detail: null,
    };
    if (status === "CANCELLED") {
      const by = CONF.cancelRole[base.fixedCd] || null;
      ev.cancel = {
        by,
        byId: by === "EVALUATOR" ? evaluatorId : by === "EVALUATEE" ? evaluateeId : null,
        byName: by === "EVALUATOR" ? evaluatorName : by === "EVALUATEE" ? evaluateeName : null,
        reasonCd: base.rtrcnRsnCd,
        reasonNm: base.fixedNm, // "평가거절" / "평가요청취소"
        at: null,               // 이 API는 취소 시각을 제공하지 않음
      };
      // selfOnly 모드에서 취소 주체가 이름 없는 세션 소유자인 경우 표기
      if (ev.cancel.byId == null && ev.cancel.byName == null) ev.cancel.byName = "세션 소유자";
    }
    events.push(ev);
  }
  return events;
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

  // 기존 데이터 로드 (증분 수집 + 병합용)
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const outFile = path.join(cfg.outDir, `${outY}-${pad(outM)}.json`);
  let existing = { events: [], members: [], slots: [] };
  try { existing = JSON.parse(fs.readFileSync(outFile, "utf-8")); } catch (_) {}
  // v1(scheduleAllList 기반, src 없음) 이벤트는 v2(mbrSearch 기반, src 있음)로 대체 — 중복 방지
  existing.events = (existing.events || []).filter((e) => e && e.src);
  // 기존 세션-뷰 슬롯(타인 귀속 오염 가능분) 제거 — 슬롯 소유자는 세션 소유자뿐
  {
    const selfKey = String(cfg.selfId || null);
    existing.slots = (existing.slots || []).filter((s) => String(s.m) === selfKey || String(s.m) === "null");
  }

  // 2단계: 오픈 슬롯 — scheduleAllList는 mbrId를 무시하므로 세션 소유자 1회만
  console.log("▶ 2단계: 오픈 슬롯 수집 (세션 소유자 — API가 타인 슬롯 미제공)");
  const slotList = [];
  try {
    const probe = await fetchMemberSchedule(roster[0],
      dotYmd(fromDate.getFullYear(), fromDate.getMonth() + 1, fromDate.getDate()),
      dotYmd(toDate.getFullYear(), toDate.getMonth() + 1, toDate.getDate()), cfg);
    const selfId = cfg.selfId || null;
    for (const sRow of probe.slots) slotList.push({ ...sRow, m: selfId });
    console.log(`  슬롯 ${slotList.length}개 (매칭 ${slotList.filter((x) => x.matched).length})`);
  } catch (e) {
    if (e.sessionExpired) { console.error("❌ 세션 만료. CODYSSEY_SESSION 갱신 필요"); process.exit(3); }
    console.warn(`  ⚠️ 슬롯 수집 실패: ${e.message}`);
  }

  // 3단계: 멤버별 평가 목록 (mbrSearch — mbrId 반영 실측 확정)
  console.log(`▶ 3단계: 멤버별 평가 목록 (mbrSearch, ${roster.length}명)`);
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

  // 4단계: 상세 수집 — 신규이거나 상태(stusCd)가 바뀐 평가만 (증분)
  const storedStus = new Map();
  for (const ev of (existing.events || [])) {
    if (!ev.evlNo) continue;
    const k = `${ev.evlNo}|${ev.evlDegr}`;
    if (!storedStus.has(k)) storedStus.set(k, new Set());
    storedStus.get(k).add(String(ev.stusCd || ""));
  }
  const targets = [...uniq.values()].filter(({ row }) => {
    const st = storedStus.get(`${row.evlNo}|${row.evlDegr}`);
    return !st || !st.has(String(row.evlStusCd));
  });
  console.log(`▶ 4단계: 평가 상세 수집 (대상 ${targets.length}건 / 전체 ${uniq.size}건)`);
  const newEvents = [];
  let done = 0;
  for (const { member, row } of targets) {
    let txs = [];
    try {
      txs = await fetchEvalDetail(row.evlNo, row.evlDegr);
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

  // 5단계: 병합 (기간 밖 이벤트 제외 — 기본값은 해당 월 ± 없음)
  console.log("▶ 5단계: 병합 및 저장");
  const merged = new Map((existing.events || []).map((e) => [String(e.evalId), e]));
  let droppedOut = 0;
  for (const ev of newEvents) {
    if (ev.slotDateTime && !inRange(ev.slotDateTime)) { droppedOut++; continue; }
    merged.set(String(ev.evalId), ev);
  }
  const slotMerged = new Map((existing.slots || []).map((x) => [`${x.d}|${x.t}|${x.m}`, x]));
  for (const x of slotList) slotMerged.set(`${x.d}|${x.t}|${x.m}`, x);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      year: outY,
      month: outM,
      mock: false,
      eventCount: merged.size,
      slotCount: slotMerged.size,
      roster: roster.length,
      selfOnlyWarning: false,          // mbrSearch로 타인 평가 수집 성공 (2026-07-17 확정)
      source: "mbrSearch+pkList",
      slotsSource: "scheduleAllList(세션 소유자 슬롯만)",
      feedbackCollected: feedbackOn,
      droppedOutOfRange: droppedOut,
    },
    members: roster.map((m) => ({ mbrId: m.mbrId, name: m.name, level: m.level, guild: m.guild })),
    events: [...merged.values()].sort((a, b) => String(a.slotDateTime).localeCompare(String(b.slotDateTime))),
    slots: [...slotMerged.values()].sort((a, b) => `${a.d}T${a.t}`.localeCompare(`${b.d}T${b.t}`)),
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
