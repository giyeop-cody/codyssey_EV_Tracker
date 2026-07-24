#!/usr/bin/env node
/**
 * 평가 이벤트 과제명/과정명 라이브 교정기 (2026-07-25, 1회성 배경)
 *
 * 배경: 2026-07-24 사이트 배포로 과제 13종 명칭이 서버에서 전면 개명됐다.
 *   collect_eval.js는 증분 병합 방식이라 과거 이벤트의 projectName/trackName은
 *   재수집필로도 갱신되지 않는다 (스윕 재조회조차 기존 명칭 유지 설계).
 *   이 스크립트는 수강생별 평가 목록(searchList)을 다시 읽어
 *   (evlNo, evlDegr) 매칭으로 과거 이벤트의 명칭 두 필드만 라이브 값으로 교정한다.
 *   — 명칭 매핑 추정이 아니라 평가 단위 실측 확정 방식.
 *
 * 안전성:
 *   - 읽기 전용 API만 호출 (searchList). 쓰기는 docs/data JSON 파일뿐.
 *   - 세션 만료 감지 시 아무 파일도 쓰지 않고 종료(exit 3).
 *   - 재실행 안전(idempotent): 이미 일치하는 이벤트는 건드리지 않는다.
 *   - 목록에서 사라진 평가는 기존 명칭 유지 + missing으로 집계한다 (추측 교정 금지).
 *
 * 사용법:
 *   CODYSSEY_SESSION="JSESSIONID=xxxx" node refresh_names.js
 *   node refresh_names.js --months 2026-06,2026-07 --dry-run   # 계획만 보고
 *   node refresh_names.js --map-file map.json                  # API 대신 사전 맵 사용 (테스트/수동)
 *
 * map-file 형식: { "<evlNo>|<evlDegr>": { "uqstnNm": "...", "lcorsNm": "..." } }
 */

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.usr.codyssey.kr/";

function parseArgs() {
  const cfg = {
    months: (process.env.MONTHS || "2026-05,2026-06,2026-07").split(",").map((s) => s.trim()).filter(Boolean),
    outDir: path.join(__dirname, "docs", "data"),
    delay: 250,
    dryRun: false,
    mapFile: null,
    instCd: process.env.INST_CD || "00021",
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--months": cfg.months = args[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--out": cfg.outDir = args[++i]; break;
      case "--delay": cfg.delay = parseInt(args[++i], 10); break;
      case "--dry-run": cfg.dryRun = true; break;
      case "--map-file": cfg.mapFile = args[++i]; break;
      case "--inst": cfg.instCd = args[++i]; break;
      case "-h": case "--help":
        console.log("사용법: CODYSSEY_SESSION=... node refresh_names.js [--months 2026-06,2026-07] [--dry-run] [--map-file map.json]");
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

/* collect_eval.js와 동일 구현 — form-urlencoded POST + 세션 만료 명시 감지 */
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

/* 멤버 1명의 평가 목록 전수 (최대 10페이지×50건 — collect_eval.js와 동일 규격) */
async function fetchMemberEvals(mbrId, cfg) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const result = await fetchFormJson("ev/request/mbrSearch/searchList", {
      mbrId: String(mbrId),
      instCd: cfg.instCd,
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

const rowName = (row) => row.uqstnNm || row.projectNm || "";

async function main() {
  const cfg = parseArgs();

  // 1. 대상 월 파일 로드 + 이벤트 관여 수강생 집합
  const files = [];
  const evaluatees = new Set();
  for (const m of cfg.months) {
    const file = path.join(cfg.outDir, `${m}.json`);
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { /* 없으면 건 너뜀 */ }
    if (!data || !Array.isArray(data.events)) {
      console.log(`▶ ${m}: 파일 없음/형식 아님 — 건 너뜀 (${file})`);
      continue;
    }
    for (const ev of data.events) if (ev && ev.evaluateeId) evaluatees.add(String(ev.evaluateeId));
    files.push({ month: m, file, data });
    console.log(`▶ ${m}: 이벤트 ${data.events.length}건 로드`);
  }
  if (!files.length) { console.error("❌ 대상 월 파일이 하나도 없습니다."); process.exit(2); }
  console.log(`▶ 이벤트 관여 수강생 ${evaluatees.size}명`);

  // 2. 명칭 맵 구축 (라이브 searchList 또는 --map-file 주입)
  const nameMap = new Map(); // "<evlNo>|<evlDegr>" → {uqstnNm, lcorsNm}
  let conflicts = 0;
  if (cfg.mapFile) {
    const injected = JSON.parse(fs.readFileSync(cfg.mapFile, "utf-8"));
    for (const [k, v] of Object.entries(injected)) {
      if (v && (v.uqstnNm || v.lcorsNm)) nameMap.set(k, { uqstnNm: v.uqstnNm || "", lcorsNm: v.lcorsNm || "" });
    }
    console.log(`▶ 명칭 맵 주입: ${nameMap.size}키 (${cfg.mapFile})`);
  } else {
    SESSION = loadSession();
    console.log("▶ 라이브 searchList 조회 시작");
    let done = 0;
    for (const mbrId of evaluatees) {
      let rows = [];
      try {
        rows = await fetchMemberEvals(mbrId, cfg);
      } catch (err) {
        if (err.sessionExpired) {
          console.error("❌ 세션 만료 — 아무 파일도 쓰지 않고 종료합니다. CODYSSEY_SESSION 갱신 필요");
          process.exit(3);
        }
        console.warn(`  ⚠️ sha1:${require("crypto").createHash("sha1").update(mbrId).digest("hex").slice(0, 8)} 목록 실패: ${err.message}`);
        continue;
      }
      for (const row of rows) {
        if (row.evlNo == null) continue;
        const key = `${row.evlNo}|${row.evlDegr != null ? row.evlDegr : ""}`;
        const val = { uqstnNm: rowName(row), lcorsNm: row.lcorsNm || "" };
        const prev = nameMap.get(key);
        if (prev && prev.uqstnNm && val.uqstnNm && prev.uqstnNm !== val.uqstnNm) { conflicts++; continue; }
        if (!prev) nameMap.set(key, val);
      }
      done++;
      if (done % 25 === 0 || done === evaluatees.size) console.log(`  [${done}/${evaluatees.size}] 누적 키 ${nameMap.size}개`);
      await sleep(cfg.delay);
    }
    if (conflicts) console.log(`  ⚠️ 동일 평가 명칭 충돌 ${conflicts}건 — 첫 값 유지`);
  }

  // 3. 파일별 교정
  let grandChanged = 0;
  for (const { month, file, data } of files) {
    let renamed = 0, unchanged = 0, missing = 0;
    const pairs = new Map(); // "구명칭 → 신명칭" 집계
    for (const ev of data.events) {
      if (!ev || ev.evlNo == null) { missing++; continue; }
      const key = `${ev.evlNo}|${ev.evlDegr != null ? ev.evlDegr : ""}`;
      const live = nameMap.get(key);
      if (!live || !live.uqstnNm) { missing++; continue; }
      const newTrack = live.lcorsNm || ev.trackName;
      if (ev.projectName === live.uqstnNm && ev.trackName === newTrack) { unchanged++; continue; }
      const pk = `${ev.projectName} → ${live.uqstnNm}`;
      pairs.set(pk, (pairs.get(pk) || 0) + 1);
      ev.projectName = live.uqstnNm;
      ev.trackName = newTrack;
      renamed++;
    }
    console.log(`\n▶ ${month}: 교정 ${renamed} / 이미 일치 ${unchanged} / 목록에 없어 유지 ${missing}`);
    for (const [pk, c] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c}건 | ${pk}`);
    if (renamed > 0) {
      grandChanged += renamed;
      // 출처 표기 (대시보드가 모르는 meta 키는 무시되므로 안전)
      data.meta = data.meta || {};
      data.meta.nameRefreshedAt = new Date().toISOString();
      data.meta.nameRefresh = { renamed, unchanged, missing, source: cfg.mapFile ? "map-file" : "mbrSearch" };
      if (!cfg.dryRun) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
        console.log(`  ✅ 저장: ${file}`);
      }
    }
  }

  if (cfg.dryRun) console.log(`\n▶ dry-run: 쓰기 없음. 교정 예정 총 ${grandChanged}건`);
  else console.log(`\n✅ 완료: 총 ${grandChanged}건 교정`);
  if (!grandChanged && !cfg.dryRun) console.log("  (변경 없음 — 커밋 스킵 가능)");
}

main().catch((err) => {
  console.error("❌ 교정 실패:", err.message);
  process.exit(1);
});
