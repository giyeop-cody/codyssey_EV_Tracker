"use strict";
/* 프로브 라운드 4 — "요청 단계 거절/취소를 mbrId 단위로 수집할 수 있는가" 검증.
 *
 * 가설:
 *  H1) mbrSearch/searchList 기본 호출은 상태 필터 없이도 전부 주는가, 아니면
 *      evlStusCd 필터(00004 거절/00005 요청취소)를 줘야 숨은 건이 나오는가
 *  H2) 기본 호출의 기간 기본값이 있어서 evlBgngDt/evlEndDt 명시 시 더 나오는가
 *  H3) mbrSearch/evlDetail (멤버×과제 상세)이 "시도 전체 이력"(수락 전 거절 포함)을 주는가
 *
 * 출력은 마스킹된 구조만 (Actions 로그 공개).
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

function mask(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 3).map(mask);
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = mask(x);
    return o;
  }
  return String(v).replace(/[가-힣]/g, "ㅋ").replace(/\d/g, "0").slice(0, 40);
}

async function post(ep, params) {
  await sleep(400);
  const res = await fetch(API_BASE + ep, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  let j = null;
  try { j = JSON.parse(await res.text()); } catch (_) {}
  return { http: res.status, j };
}
const arrOf = (j) => {
  const r = j && j.result;
  return Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : [];
};

(async () => {
  console.log("▶ 라운드 4 — 요청 거절 수집 가능성 검증 (값 마스킹)");

  const base = { instCd: "00021", page: "1", pagePerRows: "50", orderBy: "DESC" };
  const search = (mbrId, extra = {}) => post("ev/request/mbrSearch/searchList", { mbrId, ...base, ...extra });

  // 명부에서 세션 소유자 + 데이터 보유 멤버 1명 확보
  let ids = [];
  try {
    const res = await fetch(API_BASE + "guild/3/detail?guildSeasonId=5&weekNo=9", { headers: HEADERS });
    ids = ((await res.json()).result.members || []).map((m) => String(m.mbrId));
  } catch (e) { console.log("명부 실패:", e.message); process.exit(1); }
  // 세션 소유자는 가장 활동 많은 멤버로 추정됨 — 상위 5명 중 rows 최다를 "주 피검자"로
  let main = null;
  for (const id of ids.slice(0, 8)) {
    const { j } = await search(id);
    const rows = arrOf(j);
    console.log(`  mbr ※※※: default rows=${rows.length}`);
    if (!main || rows.length > main.rows.length) main = { id, rows };
  }
  if (!main || !main.rows.length) { console.log("행 보유 멤버 없음 — 중단"); return; }

  // ---- H1: 상태 필터 검증 ----
  console.log("\n## H1: evlStusCd 필터");
  const def = main.rows;
  const defKeys = new Set(def.map((r) => `${r.evlNo}|${r.evlDegr}`));
  const defStus = {};
  for (const r of def) defStus[`${r.evlStusCd}:${r.evlStusNm}`] = (defStus[`${r.evlStusCd}:${r.evlStusNm}`] || 0) + 1;
  console.log("  기본 목록 상태 분포:", JSON.stringify(defStus).replace(/[가-힣]/g, "ㅋ").replace(/\d/g, "0"));
  for (const cd of ["00004", "00005", "00006", "00001", "00002", "00003"]) {
    const { http, j } = await search(main.id, { evlStusCd: cd });
    const rows = arrOf(j);
    const missing = rows.filter((r) => !defKeys.has(`${r.evlNo}|${r.evlDegr}`)).length;
    console.log(`  evlStusCd=${cd}: rows=${rows.length} (기본목록에 없던 건 ${missing}) http=${http} code=${j && j.code}`);
  }

  // ---- H2: 기간 파라미터 ----
  console.log("\n## H2: 기간 명시 vs 기본");
  {
    const { j } = await search(main.id, { evlBgngDt: "2026.01.01", evlEndDt: "2026.12.31" });
    const rows = arrOf(j);
    const missing = rows.filter((r) => !defKeys.has(`${r.evlNo}|${r.evlDegr}`)).length;
    console.log(`  기간(01.01~12.31): rows=${rows.length} (기본 대비 +${rows.length - def.length}, 기본에 없던 ${missing})`);
  }

  // ---- H3: mbrSearch/evlDetail — 멤버×과제 "시도 전체 이력"? ----
  console.log("\n## H3: mbrSearch/evlDetail");
  // 취소/거절 건이 있는 행 우선, 없으면 완료 건
  const pick = def.find((r) => /거절|취소/.test(String(r.evlStusNm || ""))) || def[0];
  console.log("  대상 행 keys:", Object.keys(pick).join(","));
  console.log("  대상 행 sample:", JSON.stringify(mask(pick)).replace(/\n/g, " ").slice(0, 600));
  for (const tm of [pick.lrnTmcnt, 1, 0].filter((x, i, a) => x != null && a.indexOf(x) === i)) {
    const { http, j } = await post("ev/request/mbrSearch/evlDetail", {
      projectNo: String(pick.projectNo), lcorsNo: String(pick.lcorsNo), uqstnNo: String(pick.uqstnNo),
      instCd: pick.instCd || "00021", mbrId: main.id, lrnTmcnt: String(tm),
    });
    const r = j && j.result;
    console.log(`  lrnTmcnt=${tm}: http=${http} code=${j && j.code} type=${Array.isArray(r) ? `array(${r.length})` : typeof r}`);
    if (r && typeof r === "object" && !Array.isArray(r)) {
      console.log("  keys:", Object.keys(r).join(","));
      for (const [k, v] of Object.entries(r)) {
        if (Array.isArray(v) && v.length && typeof v[0] === "object") {
          console.log(`  [${k}] array(${v.length}) rowKeys:`, Object.keys(v[0]).slice(0, 30).join(","));
          const st = v.map((x) => `${x.mtlEvlStusCd || x.evlStusCd || "?"}`).join(",");
          console.log(`  [${k}] 상태코드 시퀀스:`, st.replace(/\d/g, "0"));
          console.log(`  [${k}] sample:`, JSON.stringify(mask(v[0])).replace(/\n/g, " ").slice(0, 500));
        }
      }
    } else if (Array.isArray(r) && r.length) {
      console.log("  rowKeys:", Object.keys(r[0]).join(","));
      console.log("  sample:", JSON.stringify(mask(r[0])).replace(/\n/g, " ").slice(0, 500));
    }
    if (r && (Array.isArray(r) ? r.length : Object.keys(r).length)) break; // 유효 응답이면 lrnTmcnt 추가 시도 중단
  }

  // ---- 별첨: 상태 코드 사전 ----
  console.log("\n## 부록: evlStusCdList");
  for (const g of [undefined, "EVL_STUS", "MTL_STUS", "000"]) {
    const res = await fetch(API_BASE + "ev/request/evlStusCdList" + (g ? `?groupCd=${g}` : ""), { headers: HEADERS });
    let j = null; try { j = JSON.parse(await res.text()); } catch (_) {}
    const rows = arrOf(j);
    console.log(`  groupCd=${g || "(없음)"}: code=${j && j.code} rows=${rows.length}${rows.length ? " " + JSON.stringify(mask(rows.slice(0, 8))).slice(0, 400) : ""}`);
    await sleep(400);
  }
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
