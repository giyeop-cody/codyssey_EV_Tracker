#!/usr/bin/env node
/**
 * Codyssey 동료평가 이력 수집기 (실측 확정판)
 *
 * 동작:
 *   1) 길드 detail API로 멤버 명부(mbrId/이름/레벨) 수집 (또는 --members 직접 지정)
 *   2) 멤버별 schedule/scheduleAllList/ 호출 (본인 스케줄 조회 API, mbrId 쿼리 파라미터)
 *      - reqList 중 scdlGubunCd === "EV" 만 수집
 *      - reqDetail "R||" = 해당 멤버가 피평가자(요청자), "A||" = 해당 멤버가 평가자
 *   3) scdlId 기준으로 멤버 간 병합 → 평가자/피평가자 양쪽 식별
 *   4) docs/data/YYYY-MM.json 저장
 *
 * 사용법:
 *   CODYSSEY_SESSION="JSESSIONID=xxxx" node collect_eval.js --month 7
 *   node collect_eval.js --month 7 --members 1000271067,1000275060   # 명부 없이 소수만 테스트
 *   node collect_eval.js --month 7 --guilds 3,4,5,6 --season 5 --week 9
 *
 * 필요 환경변수:
 *   CODYSSEY_SESSION (필수)  "JSESSIONID=xxx" 또는 값만
 *   INST_CD         (선택, 기본 00021)
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
    }
    events.push(ev);
  }
  return events;
}

/* ---------------- main ---------------- */
async function main() {
  const cfg = parseArgs();
  SESSION = loadSession();

  let fromYmd, toYmd, outY, outM;
  if (cfg.days > 0) {
    const end = new Date();
    const start = new Date(); start.setDate(start.getDate() - (cfg.days - 1));
    fromYmd = dotYmd(start.getFullYear(), start.getMonth() + 1, start.getDate());
    toYmd = dotYmd(end.getFullYear(), end.getMonth() + 1, end.getDate());
    outY = end.getFullYear(); outM = end.getMonth() + 1;
  } else {
    fromYmd = dotYmd(cfg.year, cfg.month, 1);
    toYmd = dotYmd(cfg.year, cfg.month, new Date(cfg.year, cfg.month, 0).getDate());
    outY = cfg.year; outM = cfg.month;
  }

  console.log(`▶ 1단계: 멤버 명부 수집`);
  const roster = await fetchRoster(cfg);
  console.log(`  명부 ${roster.length}명`);

  console.log(`▶ 2단계: 스케줄 수집 (${fromYmd} ~ ${toYmd}, 멤버 ${roster.length}명)`);
  const partials = [];
  const slotList = [];

  // 먼저 2명 프로브: 두 응답의 서명(scdlId 집합)이 같으면
  // API가 mbrId 파라미터를 무시하고 세션 소유자 스케줄만 반환하는 것 (2026-07-17 실측 확정)
  const sign = (x) =>
    [...x.evalPartials.map((p) => p.scdlId), ...x.slots.map((s) => String(s.id))].sort().join(",");
  const probe1 = await fetchMemberSchedule(roster[0], fromYmd, toYmd, cfg);
  let selfOnly = false;
  if (roster.length > 1) {
    await sleep(cfg.delay);
    const probe2 = await fetchMemberSchedule(roster[1], fromYmd, toYmd, cfg);
    selfOnly = sign(probe1) === sign(probe2);
    if (!selfOnly) {
      for (const p of probe2.evalPartials) partials.push(p);
      for (const s of probe2.slots) slotList.push(s);
    }
  }

  if (selfOnly) {
    console.log("⚠️ scheduleAllList가 mbrId를 무시합니다 — 세션 소유자 스케줄 1회 수집 모드로 전환");
    console.log("   (수집 범위: 세션 소유자가 참여한 평가와 소유자 오픈 슬롯. --self/--SELF_MBR_ID로 소유자 지정 가능)");
    const selfId = cfg.selfId || null;
    for (const p of probe1.evalPartials) partials.push({ ...p, ownerId: selfId });
    for (const s of probe1.slots) slotList.push({ ...s, m: selfId });
  } else {
    for (const p of probe1.evalPartials) partials.push(p);
    for (const s of probe1.slots) slotList.push(s);
    const startIdx = roster.length > 1 ? 2 : 1;
    for (let i = startIdx; i < roster.length; i++) {
      const m = roster[i];
      try {
        const { evalPartials, slots } = await fetchMemberSchedule(m, fromYmd, toYmd, cfg);
        partials.push(...evalPartials);
        slotList.push(...slots);
        if ((i + 1) % 10 === 0 || i === roster.length - 1) {
          console.log(`  [${i + 1}/${roster.length}] 누적 행 ${partials.length}, 슬롯 ${slotList.length}`);
        }
      } catch (err) {
        if (err.sessionExpired) { console.error("❌ 세션 만료. CODYSSEY_SESSION 갱신 필요"); process.exit(3); }
        console.warn(`  ⚠️ ${m.name || m.mbrId} 실패: ${err.message}`);
      }
      await sleep(cfg.delay);
    }
  }

  // 교차 멤버 조회 검증:
  // 정상이라면 같은 scdlId의 R행(피평가자 행)은 요청자 본인 스케줄에서만 1명 owner로 나타난다.
  // API가 mbrId 파라미터를 무시하고 세션 사용자 스케줄만 반환하면
  // 같은 scdlId의 R행 owner가 여러 명으로 찍히므로 이를 감지한다.
  const rOwners = new Map(); // scdlId → Set(ownerId)
  for (const p of partials) {
    if (p.role !== "EVALUATEE") continue;
    if (!rOwners.has(p.scdlId)) rOwners.set(p.scdlId, new Set());
    rOwners.get(p.scdlId).add(p.ownerId);
  }
  const conflicts = [...rOwners.values()].filter((s) => s.size > 1).length;
  const ownershipConflict = rOwners.size > 0 && conflicts / rOwners.size > 0.5;
  const selfOnlyWarning = selfOnly || ownershipConflict;
  if (ownershipConflict && !selfOnly) {
    console.warn("⚠️ R행 소유자가 다수 멤버에서 중복됩니다 — API가 mbrId 파라미터를 받아주지 않고");
    console.warn("   세션 사용자 기준으로만 반환하는 것으로 보입니다.");
  }

  console.log(`▶ 3단계: scdlId 병합`);
  const events = buildFinalEvents(partials, roster);
  const both = events.filter((e) => e.evaluatorId && e.evaluateeId).length;
  const oneSide = events.filter((e) => (e.evaluatorId || e.evaluateeId) && !(e.evaluatorId && e.evaluateeId)).length;
  console.log(`  이벤트 ${events.length}건 (양쪽 식별 ${both}, 한쪽만 ${oneSide}, 이름만 ${events.length - both - oneSide})`);

  // 기존 파일과 병합
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const outFile = path.join(cfg.outDir, `${outY}-${pad(outM)}.json`);
  let existing = { events: [], members: [], slots: [] };
  try { existing = JSON.parse(fs.readFileSync(outFile, "utf-8")); } catch (_) {}
  if (selfOnly) {
    // selfOnly 모드에서는 세션 소유자 귀속 슬롯만 유효 — 과거에 타인으로 잘못 귀속된 슬롯 제거
    const selfKey = String(cfg.selfId || null);
    existing.slots = (existing.slots || []).filter((s) => String(s.m) === selfKey);
  }
  const merged = new Map((existing.events || []).map((e) => [String(e.evalId), e]));
  for (const ev of events) merged.set(String(ev.evalId), ev);
  const slotMerged = new Map((existing.slots || []).map((s) => [`${s.d}|${s.t}|${s.m}`, s]));
  for (const s of slotList) slotMerged.set(`${s.d}|${s.t}|${s.m}`, s);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      year: outY,
      month: outM,
      mock: false,
      eventCount: merged.size,
      slotCount: slotMerged.size,
      roster: roster.length,
      selfOnlyWarning,
    },
    members: roster.map((m) => ({ mbrId: m.mbrId, name: m.name, level: m.level, guild: m.guild })),
    events: [...merged.values()].sort((x, y) => String(x.slotDateTime).localeCompare(String(y.slotDateTime))),
    slots: [...slotMerged.values()].sort((x, y) => `${x.d}T${x.t}`.localeCompare(`${y.d}T${y.t}`)),
  };

  if (cfg.dryRun) {
    console.log("▶ dry-run: 저장 생략. 샘플 3건:");
    console.log(JSON.stringify(out.events.slice(0, 3), null, 2));
    return;
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✅ 저장: ${outFile} (이벤트 ${out.meta.eventCount}건)`);
}

main().catch((err) => {
  console.error("❌ 수집 실패:", err.message);
  process.exit(1);
});
