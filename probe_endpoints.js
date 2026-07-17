"use strict";
/* 번들(index-B27e0jn1.js)에서 발굴한 후보 엔드포인트 프로브.
 * 목적: 응답 "구조"만 확인 (타인 평가 기록 조회 가능 여부 판단).
 * 개인정보 보호: 이름/ID 등 실제 값은 출력하지 않고 마스킹한다 (Actions 로그는 공개).
 *
 *   CODYSSEY_SESSION="JSESSIONID=..." node probe_endpoints.js
 */

const API_BASE = "https://api.usr.codyssey.kr/";
const SESSION_RAW = process.env.CODYSSEY_SESSION || "";
if (!SESSION_RAW) { console.error("CODYSSEY_SESSION 필요"); process.exit(2); }
const SESSION = SESSION_RAW.includes("=") ? SESSION_RAW : `JSESSIONID=${SESSION_RAW}`;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Cookie: SESSION,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 값 마스킹: 한글 → ㅋ, 숫자 → 0, 구조(필드명/배열 길이)만 유지
function mask(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 2).map(mask);
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = mask(x);
    return o;
  }
  return String(v).replace(/[가-힣]/g, "ㅋ").replace(/\d/g, "0").slice(0, 40);
}

let rowsForDistinct = [];
async function probe(name, ep, { method = "POST", params } = {}) {
  await sleep(400);
  try {
    const isGet = method === "GET";
    const body = isGet ? undefined : new URLSearchParams(params || {}).toString();
    const res = await fetch(API_BASE + ep, {
      method,
      headers: isGet ? HEADERS : { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 아래에서 처리 */ }
    if (!json) {
      console.log(`\n### ${name}\n${ep}\n  HTTP ${res.status} | JSON 아님 | head: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
      return;
    }
    const r = json.result;
    const arr = Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : null;
    const summary = { http: res.status, code: json.code };
    if (arr) {
      summary.type = `array(${arr.length})`;
      summary.rowKeys = arr.length ? Object.keys(arr[0]) : [];
      summary.sample = arr.length ? mask(arr[0]) : null;
      if (arr.length) rowsForDistinct.push(...arr.slice(0, 50));
      if (r && r.totalCnt != null) summary.totalCnt = String(r.totalCnt).length;
    } else if (r && typeof r === "object") {
      summary.type = "object";
      summary.keys = Object.keys(r).slice(0, 15);
      summary.sample = mask(r);
    } else {
      summary.type = String(typeof r);
      summary.raw = mask(r);
    }
    console.log(`\n### ${name}\n${ep}\n  ${JSON.stringify(summary, null, 1).split("\n").join("\n  ")}`);
  } catch (e) {
    console.log(`\n### ${name}\n${ep}\n  예외: ${e.message}`);
  }
}

(async () => {
  console.log("▶ 후보 엔드포인트 프로브 (값 마스킹 적용)");

  // 1) 참여(받은/준 평가) 검색 — 전체/페이징. 타인 기록이 섞여 나오는지가 핵심
  await probe("참여 검색(전체)", "ev/participation/searchParticipationAllList", {
    params: { evlInstCd: "00021" },
  });
  await probe("참여 검색(페이지)", "ev/participation/seachParticipationList", {
    params: { evlInstCd: "00021", page: "1", pagePerRows: "20" },
  });

  // 2) 멤버별 평가 검색 (mbrSearch)
  await probe("멤버 평가 검색", "ev/request/mbrSearch/searchList", {
    params: {
      page: "1", pagePerRows: "20", orderBy: "DESC",
      evlBgngDt: "2026-05-01", evlEndDt: "2026-07-31",
    },
  });

  // 3) ev/request/searchList (내 요청 검색과 비교용)
  await probe("요청 검색", "ev/request/searchList", {
    params: { page: "1", pagePerRows: "20", instCd: "00021" },
  });

  // 4) 최근 평가 목록
  await probe("최근 평가", "ev/request/lastEvList", { method: "GET" });

  // 5) 스케줄 목록(다른 엔드포인트 실험)
  await probe("스케줄 목록", "schedule/scheduleList/", {
    params: { mbrId: "", instCd: "00021", bgngYmd: "2026.07.01", endYmd: "2026.07.31", scheduleType: "request" },
  });

  // 다양성 체크: 수집된 행들에서 mbr 계열 필드의 서로 다른 값 개수(값 자체는 출력 안 함)
  const keys = ["mbrId", "evlMbrId", "reqMbrId", "reqMbrNm", "evlMbrNm", "scdlSn", "mtlEvlSn"];
  const sets = {};
  for (const row of rowsForDistinct) {
    for (const k of keys) {
      if (row[k] != null && row[k] !== "") {
        if (!sets[k]) sets[k] = new Set();
        sets[k].add(String(row[k]));
      }
    }
  }
  console.log("\n▶ 다양성(서로 다른 값 개수 — 타인 데이터면 > 1):",
    Object.fromEntries(Object.entries(sets).map(([k, s]) => [k, s.size])));
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
