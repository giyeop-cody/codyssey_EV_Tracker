"use strict";
/* 프로브 라운드 7 (최종 스윕) — 남은 읽기 후보들의 구조만 확인.
 * H: 요청 단계 거절/취소를 멤버 단위로 주는 엔드포인트가 더 있나.
 * 출력 마스킹. CODYSSEY_SESSION="JSESSIONID=..." node probe_endpoints.js
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
const mask = (v) => {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 2).map(mask);
  if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = mask(x); return o; }
  return String(v).replace(/[가-힣]/g, "ㅋ").replace(/\d/g, "0").slice(0, 24);
};
async function hit(name, ep, { method = "POST", params, body } = {}) {
  await sleep(400);
  try {
    const res = await fetch(API_BASE + ep, {
      method,
      headers: method === "GET" ? HEADERS : { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      ...(method === "GET" ? {} : { body: body !== undefined ? body : new URLSearchParams(params || {}).toString() }),
    });
    let j = null; try { j = JSON.parse(await res.text()); } catch (_) {}
    const r = j && j.result;
    const arr = Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : null;
    let desc = `http=${res.status} code=${j && j.code} `;
    if (arr) desc += `array(${arr.length}) keys=${arr.length ? Object.keys(arr[0]).join(",") : "-"}`;
    else if (r && typeof r === "object") desc += `object keys=${Object.keys(r).slice(0, 12).join(",")}`;
    else desc += `type=${typeof r}`;
    console.log(`### ${name}\n  ${desc}`);
    if (arr && arr.length) console.log("  sample:", JSON.stringify(mask(arr[0])).slice(0, 400));
    else if (r && typeof r === "object") console.log("  sample:", JSON.stringify(mask(r)).slice(0, 400));
  } catch (e) { console.log(`### ${name}\n  예외: ${e.message}`); }
}

(async () => {
  console.log("▶ 라운드 7 — 최종 스윕");
  // 세션 기준 "최근 평가" — 거절 포함 여부
  await hit("lastEvList (GET)", "ev/request/lastEvList", { method: "GET" });
  // 평가자 후보 타임라인 계열 — 기존 알려진 스케줄 세션 한정과 동일 계열인지
  await hit("mainScheduleCntList", "schedule/mainScheduleCntList", { params: { bgngYmd: "2026.06.01", endYmd: "2026.06.30" } });
  await hit("selectCase1MbrIdList", "ev/request/selectCase1MbrIdList", { params: { instCd: "00021" } });
  await hit("selectCase2MbrIdList", "ev/request/selectCase2MbrIdList", { params: { instCd: "00021" } });
  await hit("selectScheduleList", "ev/request/selectScheduleList", { params: { projectNo: "0", lcorsNo: "0", instCd: "00021" } });
  // 세션 "내 요청 목록" — 거절 상태로 필터 시 뭐가 나오나 (세션 한정이지만 코드 체계 확인용)
  for (const cd of ["00004", "00005"]) {
    await hit(`searchList(session) evlStusCd=${cd}`, "ev/request/searchList", { params: { instCd: "00021", page: "1", pagePerRows: "50", evlStusCd: cd } });
  }
  // participation(평가자 입장) — 타인 mbrId 테스트
  await hit("seachParticipationList (mbrId 고정)", "ev/participation/seachParticipationList", { params: { mbrId: "1000275117", instCd: "00021", page: "1", pagePerRows: "50" } });
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
