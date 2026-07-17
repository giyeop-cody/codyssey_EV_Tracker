"use strict";
/* 프로브 라운드 5b — evlDetail이 "searchList에 안 뜨는 시도(거절 등)"를 보여주는가.
 *
 * 설계:
 *  1) 전 길드 스캔 → searchList 행수 상위 6명 선정 (개별 ID 미출력)
 *  2) 각 상위 멤버: searchList 전페이지 → 고유 (projectNo,lcorsNo,uqstnNo) 콤보
 *  3) 콤보 × lrnTmcnt 후보(행값,1,2,3,0) 전부 시도 → evlDetail.mtlEvlDataTxnDtoList 합산(mtlEvlSn dedupe)
 *  4) txn (evlNo,evlDegr) 집합 vs searchList 집합 비교
 *     → evlDetail에만 있는 건이 있고 상태=취소/거절류이면 "전 멤버 거절 수집 가능" 확정
 *
 * 출력: 상태코드(열거형)는 원형, 이름/식별자는 마스킹.
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
  let j = null; try { j = JSON.parse(await res.text()); } catch (_) {}
  return { http: res.status, j };
}
const arrOf = (j) => {
  const r = j && j.result;
  return Array.isArray(r) ? r : (r && Array.isArray(r.list)) ? r.list : [];
};

(async () => {
  console.log("▶ 라운드 5b — evlDetail 시도이력 vs searchList (활동 상위 멤버)");
  const base = { instCd: "00021", orderBy: "DESC" };

  // 1) 전 길드 스캔 (행수 기준 상위 6명)
  const members = [];
  let scanned = 0;
  for (const gid of [3, 4, 5, 6]) {
    let ids = [];
    try {
      const res = await fetch(API_BASE + `guild/${gid}/detail?guildSeasonId=5&weekNo=9`, { headers: HEADERS });
      ids = (((await res.json()).result || {}).members || []).map((m) => String(m.mbrId));
    } catch (e) { console.log("명부 실패:", e.message); continue; }
    await sleep(400);
    for (const id of ids) {
      scanned++;
      const { j } = await post("ev/request/mbrSearch/searchList", { mbrId: id, ...base, page: "1", pagePerRows: "50" });
      const rows = arrOf(j);
      members.push({ id, n: rows.length });
    }
    console.log(`  길드 #${gid} 스캔 완료 (누적 ${scanned}명)`);
  }
  members.sort((a, b) => b.n - a.n);
  const top = members.slice(0, 6).filter((m) => m.n > 0);
  console.log(`  스캔 ${scanned}명, 상위 6명 rows: [${top.map((m) => m.n).join(", ")}]`);

  // 2) 상위 멤버별 콤보×회차 evlDetail 비교
  for (let mi = 0; mi < top.length; mi++) {
    const f = top[mi];
    console.log(`\n## 멤버 #${mi + 1} (rows ${f.n})`);
    // 전페이지 목록
    const allRows = [];
    for (let p = 1; p <= 5; p++) {
      const { j } = await post("ev/request/mbrSearch/searchList", { mbrId: f.id, ...base, page: String(p), pagePerRows: "50" });
      const rows = arrOf(j);
      allRows.push(...rows);
      if (rows.length < 50) break;
    }
    const listKeys = new Set(allRows.map((r) => `${r.evlNo}|${r.evlDegr}`));
    const combos = new Map();
    for (const r of allRows) {
      const ck = `${r.projectNo}|${r.lcorsNo}|${r.uqstnNo}`;
      if (!combos.has(ck)) combos.set(ck, r);
    }
    console.log(`  searchList ${allRows.length}건 / 콤보 ${combos.size}개`);
    let totalTx = 0, inList = 0, onlyDetail = 0, cx = 0;
    for (const [, pick] of combos) {
      const txAll = new Map();
      for (const tm of [pick.lrnTmcnt, 1, 2, 3, 0].filter((x, i, a) => x != null && a.indexOf(x) === i)) {
        const { j } = await post("ev/request/mbrSearch/evlDetail", {
          projectNo: String(pick.projectNo), lcorsNo: String(pick.lcorsNo), uqstnNo: String(pick.uqstnNo),
          instCd: pick.instCd || "00021", mbrId: f.id, lrnTmcnt: String(tm),
        });
        const r = j && j.result;
        if (!(j && j.code === 200) || !r) continue;
        for (const t of (r.mtlEvlDataTxnDtoList || [])) txAll.set(String(t.mtlEvlSn), t);
      }
      if (!txAll.size) continue;
      const seqs = [];
      for (const t of txAll.values()) {
        totalTx++;
        const listed = listKeys.has(`${t.evlNo}|${t.evlDegr}`);
        if (listed) inList++; else onlyDetail++;
        if (/(거절|취소)/.test(String(t.mtlEvlStusNm || "")) || ["00004", "00005"].includes(String(t.mtlEvlStusCd))) cx++;
        seqs.push(`${t.mtlEvlStusCd}@${String(t.mtlEvlPamBgngDt || "").slice(0, 7) || "?"}${listed ? "" : "★"}`);
      }
      console.log(`  콤보 ※: txn ${txAll.size}건 → ${seqs.join(" ")}`);
    }
    console.log(`  합계 txn ${totalTx}: 목록 존재 ${inList} / ★evlDetail에만 ${onlyDetail} / 취소·거절 코드 ${cx}`);
  }
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
