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
  console.log("\u25b6 3\ub77c\uc6b4\ub4dc \ud504\ub85c\ube0c (\uac12 \ub9c8\uc2a4\ud0b9 \uc801\uc6a9)");

  // 명부(길드 3) 상위 3명으로 검증
  let ids = [];
  try {
    const res = await fetch(API_BASE + "guild/3/detail?guildSeasonId=5&weekNo=9", { headers: HEADERS });
    const j = await res.json();
    ids = ((j.result && j.result.members) || []).slice(0, 3).map((m) => String(m.mbrId));
  } catch (e) { console.log("\uba85\ubd80 \uc2e4\ud328:", e.message); }

  const post = (ep, params) => fetch(API_BASE + ep, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  }).then(async (r) => { let j = null; try { j = JSON.parse(await r.text()); } catch (_) {} return { http: r.status, j }; });

  // 1) 멤버별 mbrSearch — 행 수/상태코드 분포/최다 보유자
  let best = null; const cdCount = {};
  for (const id of ids) {
    await sleep(400);
    const { http, j } = await post("ev/request/mbrSearch/searchList", { mbrId: id, instCd: "00021", page: "1", pagePerRows: "50", orderBy: "DESC" });
    const arr = j && Array.isArray(j.result) ? j.result : [];
    for (const r of arr) { const k = `${r.evlStusCd}/${r.evlResltCd}`; cdCount[k] = (cdCount[k] || 0) + 1; }
    console.log(`  mbr \u203b\u203b\u203b: rows=${arr.length} (http ${http}, code=${j && j.code})`);
    if (!best || arr.length > best.rows.length) best = { id, rows: arr };
  }
  console.log("\uc0c1\ud0dc/\uacb0\uacfc \ucf54\ub4dc \ubd84\ud3ec (stus/reslt):", JSON.stringify(cdCount));

  // 2) PK 상세: 최다 보유 멤버의 첫 2건
  if (best && best.rows.length) {
    for (const row of best.rows.slice(0, 2)) {
      await sleep(400);
      const { http, j } = await post("ev/request/mtlEvlTxnDtoByPkList", { evlNo: String(row.evlNo), evlDegr: String(row.evlDegr) });
      const r = j && j.result; const arr = Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : null;
      console.log(`\n### mtlEvlTxnDtoByPkList (evlNo/Degr \u203b\u203b\u203b)`);
      console.log(`  http=${http} code=${j && j.code} type=${arr ? `array(${arr.length})` : typeof r}`);
      if (arr && arr.length) {
        console.log("  rowKeys:", Object.keys(arr[0]).join(","));
        console.log("  sample:", JSON.stringify(mask(arr[0])).replace(/\n/g, " ").slice(0, 700));
      } else if (r) {
        console.log("  keys:", Object.keys(r).slice(0, 20).join(","));
        console.log("  sample:", JSON.stringify(mask(r)).replace(/\n/g, " ").slice(0, 700));
      }
    }
    // 3) evlTotList(프로젝트 키 경로)도 1건 실험
    const row = best.rows[0];
    await sleep(400);
    const { http, j } = await post("ev/request/evlTotList", {
      projectNo: String(row.projectNo), lcorsNo: String(row.lcorsNo), uqstnNo: String(row.uqstnNo),
      instCd: row.instCd || "00021", mbrId: best.id, lrnTmcnt: "0",
    });
    const r = j && j.result;
    console.log(`\n### evlTotList (project/uqstn/mbr)`);
    console.log(`  http=${http} code=${j && j.code} type=${Array.isArray(r) ? `array(${r.length})` : typeof r}`);
    if (r) console.log("  sample:", JSON.stringify(mask(r)).replace(/\n/g, " ").slice(0, 700));
  }
})().catch((e) => { console.error("\uc2e4\ud328:", e.message); process.exit(1); });
