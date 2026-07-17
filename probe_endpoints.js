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
  console.log("\u25b6 2\ub77c\uc6b4\ub4dc \ud504\ub85c\ube0c (\uac12 \ub9c8\uc2a4\ud0b9 \uc801\uc6a9)");

  // 길드 3 명부에서 멤버 mbrId 2개 확보 (비교용, 이름은 출력 안 함)
  let ids = [];
  try {
    const res = await fetch(API_BASE + "guild/3/detail?guildSeasonId=5&weekNo=9", { headers: HEADERS });
    const j = await res.json();
    ids = ((j.result && j.result.members) || []).slice(0, 3).map((m) => String(m.mbrId));
  } catch (e) { console.log("명부 실패:", e.message); }
  console.log("비교 멤버 수:", ids.length);

  const sha = (x) => require("crypto").createHash("sha256").update(x).digest("hex").slice(0, 12);
  const evlSig = (arr) => (arr || []).map((r) => String(r.evlNo) + ":" + String(r.evlDegr) + ":" + String(r.evlStusCd)).sort().join(",");

  // 1) mbrSearch/searchList — mbrId를 바꿔가며 응답이 달라지는지 (교차 조회 결정적 검증)
  const sigs = {};
  for (const id of ids.slice(0, 2)) {
    await sleep(400);
    const res = await fetch(API_BASE + "ev/request/mbrSearch/searchList", {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ mbrId: id, instCd: "00021", page: "1", pagePerRows: "50", orderBy: "DESC" }).toString(),
    });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    let arr = null, total = null;
    if (j) {
      if (Array.isArray(j.result)) arr = j.result;
      else if (j.result && Array.isArray(j.result.list)) { arr = j.result.list; total = j.result.totalCnt; }
    }
    if (arr) sigs[id] = sha(evlSig(arr));
    console.log(`\nmbrSearch mbrId=\u203b\u203b\u203b | HTTP ${res.status} | code=${j && j.code} | rows=${arr ? arr.length : "-"} | total=${total} | sig=${sigs[id] || "-"}`);
    if (!arr && j) console.log("  result shape:", typeof j.result, JSON.stringify(mask(j.result || j)).slice(0, 160));
    if (arr && arr.length) {
      console.log("  rowKeys:", Object.keys(arr[0]).join(","));
      console.log("  sample:", JSON.stringify(mask(arr[0])).replace(/\n/g, " ").slice(0, 500));
    }
  }
  if (Object.keys(sigs).length >= 2) {
    const same = new Set(Object.values(sigs)).size === 1;
    console.log("\n\u25b6 \uacb0\ud310: mbrSearch\uac00 mbrId\ub97c", same ? "\ubb34\uc2dc\ud569\ub2c8\ub2e4 (\ubaa8\ub450 \ub3d9\uc77c \uc751\ub2f5)" : "\ubc18\uc601\ud569\ub2c8\ub2e4 \u2605 \uad50\ucc28 \uc870\ud68c \uac00\ub2a5");
  }

  // 2) 참여 검색 — 화면과 동일하게 전부 빈 문자열
  await probe("\ucc38\uc5ec \uac80\uc0c9(\ud654\uba74 \uae30\ubcf8)", "ev/participation/seachParticipationList", {
    params: { projectNm: "", reqMbrNm: "", mtlEvlStusCd: "", mtlEvlPamBgngDt: "", mtlEvlPamBgngDted: "", evlStdtFirst: "", evlStdtLast: "", mtlEvlResltCd: "", evlMbrId: "", evlInstCd: "", page: "1", pagePerRows: "20" },
  });
  // 3) 참여 검색 — 기간 지정(20260501 ~ 20260731)
  await probe("\ucc38\uc5ec \uac80\uc0c9(\uae30\uac04 \uc9c0\uc815)", "ev/participation/seachParticipationList", {
    params: { mtlEvlPamBgngDt: "20260501", mtlEvlPamBgngDted: "20260731", page: "1", pagePerRows: "20" },
  });
})().catch((e) => { console.error("\uc2e4\ud328:", e.message); process.exit(1); });
