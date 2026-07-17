"use strict";
/* 프로브 라운드 5 — evlDetail이 "searchList에 안 뜨는 요청 단계 거절"까지 보여주는가 검증.
 *
 * 방법: 거절/취소 이력이 있는 멤버를 명부에서 찾고(개별 ID 출력 없음),
 *  그 멤버의 searchList 행들 → 고유 (projectNo,lcorsNo,uqstnNo) 조합별로
 *  mbrSearch/evlDetail 호출 → mtlEvlDataTxnDtoList의 (evlNo,evlDegr) 집합과
 *  searchList의 (evlNo,evlDegr) 집합을 비교.
 *   - evlDetail에만 있는 txn이 있고, 그게 거절/취소 코드면 → "모든 멤버의 요청거절 수집 가능" 확정
 *
 * 출력: 상태코드/날짜-월 같은 열거형 값은 원형, 이름/식별자는 마스킹 (Actions 로그 공개).
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
const stusOfRow = (r) => String(r.evlStusNm || "");
const keyOf = (r) => `${r.evlNo}|${r.evlDegr}`;
const ymdLen = (s) => (s ? String(s).slice(0, 7) : "null"); // 연-월만 (구조 확인용)

(async () => {
  console.log("▶ 라운드 5 — evlDetail 시도이력 vs searchList 비교");

  // 1) 전 길드 명부 순회: 거절/취소 포함 멤버 탐색 (최대 2명)
  const base = { instCd: "00021", page: "1", pagePerRows: "50", orderBy: "DESC" };
  const found = [];
  let scanned = 0;
  outer:
  for (const gid of [3, 4, 5, 6]) {
    let ids = [];
    try {
      const res = await fetch(API_BASE + `guild/${gid}/detail?guildSeasonId=5&weekNo=9`, { headers: HEADERS });
      ids = (((await res.json()).result || {}).members || []).map((m) => String(m.mbrId));
    } catch (e) { console.log("명부 실패:", e.message); continue; }
    for (const id of ids) {
      scanned++;
      const { j } = await post("ev/request/mbrSearch/searchList", { mbrId: id, ...base });
      const rows = arrOf(j);
      if (rows.some((r) => /거절|취소/.test(stusOfRow(r)))) {
        found.push({ id, rows });
        console.log(`  거절/취소 보유 멤버 발견 #${found.length} (rows=${rows.length}, scan ${scanned}명째)`);
        if (found.length >= 2) break outer;
      }
    }
  }
  if (!found.length) { console.log("대상 멤버 없음 — 중단"); return; }

  // 2) 멤버별: 고유 과제키별 evlDetail → txn vs searchList 비교
  for (const f of found) {
    console.log(`\n## 멤버 #${found.indexOf(f) + 1} 분석`);
    const listKeys = new Set(f.rows.map(keyOf));
    console.log(`  searchList: ${f.rows.length}건, 고유 (evlNo,evlDegr) ${listKeys.size}개`);
    console.log("  상태 분포:", JSON.stringify(f.rows.reduce((o, r) => {
      const k = `${r.evlStusCd}(len${stusOfRow(r).length})`; o[k] = (o[k] || 0) + 1; return o;
    }, {})));
    const combos = new Map();
    for (const r of f.rows) {
      const ck = `${r.projectNo}|${r.lcorsNo}|${r.uqstnNo}`;
      if (!combos.has(ck)) combos.set(ck, r);
    }
    console.log(`  고유 (project,lcors,uqstn) 조합 ${combos.size}개`);
    let totalTx = 0, inList = 0, onlyDetail = 0;
    for (const [ck, pick] of combos) {
      let detail = null, usedTm = null;
      for (const tm of [pick.lrnTmcnt, 1, 2, 0].filter((x, i, a) => x != null && a.indexOf(x) === i)) {
        const { j } = await post("ev/request/mbrSearch/evlDetail", {
          projectNo: String(pick.projectNo), lcorsNo: String(pick.lcorsNo), uqstnNo: String(pick.uqstnNo),
          instCd: pick.instCd || "00021", mbrId: f.id, lrnTmcnt: String(tm),
        });
        const r = j && j.result;
        const tx = r && Array.isArray(r.mtlEvlDataTxnDtoList) ? r.mtlEvlDataTxnDtoList : [];
        if (j && j.code === 200 && tx.length) { detail = r; usedTm = tm; break; }
      }
      if (!detail) { console.log(`  조합 ※: txn 없음 (어떤 lrnTmcnt로도)`); continue; }
      const tx = detail.mtlEvlDataTxnDtoList;
      const seqs = [];
      for (const t of tx) {
        totalTx++;
        const k = keyOf(t);
        const listed = listKeys.has(k);
        if (listed) inList++; else { onlyDetail++; }
        seqs.push(`${t.mtlEvlStusCd}${/거절|취소/.test(String(t.mtlEvlStusNm || "")) ? "✕" : ""}@${ymdLen(t.mtlEvlPamBgngDt)}${listed ? "" : " ★비목록"}`);
      }
      console.log(`  조합 ※ (lrnTmcnt=${usedTm}): txn ${tx.length}건 → ${seqs.join(" ")}`);
    }
    console.log(`  합계: txn ${totalTx}건 중 searchList에 존재 ${inList}, evlDetail에만 존재 ${onlyDetail}`);
    if (onlyDetail > 0) console.log("  ★★ searchList에 안 뜨는 시도가 evlDetail에는 있음 → 전 멤버 거절 이력 수집 가능!");
  }

  // 3) 부록: 기간 파라미터 포맷 실험
  console.log("\n## 부록: 기간 파라미터 포맷");
  {
    const f0 = found[0];
    for (const fmt of { dot: "2026.01.01", dash: "2026-01-01", compact: "20260101", dotTime: "2026.01.01 00:00:00" }) {
      const { j } = await post("ev/request/mbrSearch/searchList", {
        mbrId: f0.id, ...base, evlBgngDt: fmt, evlEndDt: fmt.replace("01.01", "12.31").replace("01-01", "12-31").replace(/0101$/, "1231").replace(/01\.01/, "12.31"),
      });
      console.log(`  fmt=${JSON.stringify(fmt)}: rows=${arrOf(j).length}`);
    }
  }
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
