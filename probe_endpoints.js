"use strict";
/* 프로브 라운드 6 — 지정 멤버(PROBE_MBR_ID)의 evlDetail 시도이력 검증.
 * 목적: searchList에 없는 "요청 단계 거절/취소" txn이 evlDetail에는 있는지 확인.
 *
 * 참고: 검증 대상 ID는 data/*.json에 이미 공개된 식별자와 동일한 성질이며,
 *       이 스크립트는 검증 후 삭제 예정. Actions 로그엔 이름/ID가 마스킹됨.
 */

const API_BASE = "https://api.usr.codyssey.kr/";
const SESSION_RAW = process.env.CODYSSEY_SESSION || "";
if (!SESSION_RAW) { console.error("CODYSSEY_SESSION 필요"); process.exit(2); }
const SESSION = SESSION_RAW.includes("=") ? SESSION_RAW : `JSESSIONID=${SESSION_RAW}`;
const TARGET = process.env.PROBE_MBR_ID || "1000271067"; // 세션 소유자(검증 협조자) — env로 교체 가능
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Cookie: SESSION,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(ep, params) {
  await sleep(400);
  const res = await fetch(API_BASE + ep, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  let j = null; try { j = JSON.parse(await res.text()); } catch (_) {}
  return { http: res.status, j };
}
const arrOf = (j) => {
  const r = j && j.result;
  return Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : [];
};
const ym = (s) => String(s || "").slice(0, 7) || "?";

(async () => {
  console.log("▶ 라운드 6 — 지정 멤버 시도이력 정밀 검증");
  const base = { instCd: "00021", orderBy: "DESC" };

  // 1) searchList 전페이지 + 행별 요약
  const rows = [];
  for (let p = 1; p <= 5; p++) {
    const { j } = await post("ev/request/mbrSearch/searchList", { mbrId: TARGET, ...base, page: String(p), pagePerRows: "50" });
    const rs = arrOf(j);
    rows.push(...rs);
    if (rs.length < 50) break;
  }
  console.log(`searchList ${rows.length}건:`);
  for (const r of rows) {
    console.log(`  ${String(r.evlNo).slice(0, 3)}…|d${r.evlDegr} st=${r.evlStusCd} uqstn=${String(r.uqstnNm || "").replace(/[0-9]/g, "0")} 기간=${String(r.evlBgngDt || "").slice(0, 10)}~${String(r.evlEndDt || "").slice(0, 10)}`);
  }
  const listKeys = new Set(rows.map((r) => `${r.evlNo}|${r.evlDegr}`));

  // 2) 콤보 × lrnTmcnt 전수 → evlDetail txn
  const combos = new Map();
  for (const r of rows) {
    const ck = `${r.projectNo}|${r.lcorsNo}|${r.uqstnNo}`;
    if (!combos.has(ck)) combos.set(ck, r);
  }
  console.log(`\n콤보 ${combos.size}개 × lrnTmcnt 시도:`);
  let onlyDetail = 0, inList = 0, cx = 0;
  for (const [, pick] of combos) {
    const tag = String(pick.uqstnNm || "").replace(/[가-힣]/g, "ㅋ").replace(/\d/g, "0").slice(0, 24);
    const txAll = new Map();
    for (const tm of [1, 2, 3, 4, 0]) {
      const { http, j } = await post("ev/request/mbrSearch/evlDetail", {
        projectNo: String(pick.projectNo), lcorsNo: String(pick.lcorsNo), uqstnNo: String(pick.uqstnNo),
        instCd: pick.instCd || "00021", mbrId: TARGET, lrnTmcnt: String(tm),
      });
      const r = j && j.result;
      const tx = (j && j.code === 200 && r && Array.isArray(r.mtlEvlDataTxnDtoList)) ? r.mtlEvlDataTxnDtoList : [];
      console.log(`  [${tag}] tm=${tm}: http=${http} code=${j && j.code} txn=${tx.length}`);
      for (const t of tx) txAll.set(`${tm}|${t.mtlEvlSn}`, t);
    }
    if (!txAll.size) continue;
    for (const [k, t] of txAll) {
      const listed = listKeys.has(`${t.evlNo}|${t.evlDegr}`);
      if (listed) inList++; else onlyDetail++;
      if (["00004", "00005"].includes(String(t.mtlEvlStusCd))) cx++;
      console.log(`  [${tag}] txn(${k.split("|")[0]}) st=${t.mtlEvlStusCd} @${ym(t.mtlEvlPamBgngDt)} reg=${ym(t.regDt)} mod=${ym(t.mdfcnDt)} ${listed ? "" : "★searchList없음"}`);
    }
  }
  console.log(`\n합계: 목록존재 ${inList} / ★evlDetail에만 ${onlyDetail} / 취소·거절코드 ${cx}`);
  console.log(onlyDetail > 0
    ? "★★ 요청 단계 거절이 evlDetail 경유로 수집 가능 → 수집기 통합 가치 있음"
    : "→ 이 멤버에선 숨은 거절 확인 안 됨 (없거나, evlDetail도 못 보여주거나)");
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
