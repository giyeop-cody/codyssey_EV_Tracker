/* Codyssey 동료평가 트래커 — 바닐라 JS (외부 의존 없음) */
"use strict";

/* ================= KST 유틸 ================= */
const KST_FMT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
function kstToday() {
  const parts = KST_FMT.formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { year: +g("year"), month: +g("month"), day: +g("day") };
}
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (dt) => (dt ? String(dt).slice(0, 10) : "");
const timeStr = (dt) => (dt && dt.length >= 16 ? dt.slice(11, 16) : "--:--");

/* ================= 상태 ================= */
const state = {
  year: kstToday().year,
  month: kstToday().month,
  data: null,
  everHadReal: false, // 한 번이라도 실데이터를 봤으면 이후 빈 달은 MOCK 대신 빈 달 표시
  sortKey: "given",
  sortAsc: false,
  heatFilter: "ALL",
};

const $ = (sel) => document.querySelector(sel);
let lastStats = null; // refresh()에서 갱신 — 검색/모달이 공유하는 최신 집계

/* ================= MOCK 데이터 (데이터 파일 없을 때) ================= */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function mockMonth(year, month) {
  const rnd = seeded(year * 100 + month);
  const last = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "서", "신"];
  const first = ["민준", "서연", "지우", "현우", "수빈", "예은", "도현", "지민", "하준", "유진", "태현", "소연", "준혁", "채원", "성민", "다은", "영훈", "가연", "동현", "혜진"];
  const projects = ["libft", "get_next_line", "ft_printf", "born2beroot", "push_swap", "minitalk", "so_long"];
  const members = [];
  for (let i = 0; i < 22; i++) {
    members.push({
      mbrId: "M" + String(1000 + i),
      name: last[(rnd() * last.length) | 0] + first[(rnd() * first.length) | 0],
      level: 1 + ((rnd() * 6) | 0),
      guild: 3 + ((rnd() * 4) | 0) + "",
    });
  }
  const events = [];
  let seq = 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = kstToday();
  for (let d = 1; d <= daysInMonth; d++) {
    if (year === today.year && month === today.month && d > today.day) break;
    const n = (rnd() * 9) | 0;
    for (let k = 0; k < n; k++) {
      const a = members[(rnd() * members.length) | 0];
      let b = members[(rnd() * members.length) | 0];
      if (a.mbrId === b.mbrId) b = members[(members.indexOf(a) + 7) % members.length];
      // 평가는 14~23시에 몰리게
      const hour = 14 + Math.min(9, Math.floor(Math.abs(rnd() - 0.25) * 18));
      const minute = [0, 30][(rnd() * 2) | 0];
      const cancelled = rnd() < 0.14;
      const ev = {
        evalId: "MOCK-" + year + pad(month) + "-" + seq++,
        regDateTime: `${year}-${pad(month)}-${pad(d)}T${pad(Math.max(0, hour - 1))}:${pad(minute)}:00+09:00`,
        slotDateTime: `${year}-${pad(month)}-${pad(d)}T${pad(hour)}:${pad(minute)}:00+09:00`,
        evaluatorId: a.mbrId,
        evaluateeId: b.mbrId,
        projectName: projects[(rnd() * projects.length) | 0],
        status: cancelled ? "CANCELLED" : "COMPLETED",
      };
      if (cancelled) {
        const byEvaluator = rnd() < 0.5;
        ev.cancel = {
          by: byEvaluator ? "EVALUATOR" : "EVALUATEE",
          byId: byEvaluator ? a.mbrId : b.mbrId,
          at: ev.regDateTime,
          reason: "",
        };
      } else if (rnd() < 0.7) {
        ev.detail = {
          score: 60 + ((rnd() * 40) | 0),
          comment: ["성실하게 코드를 설명했습니다.", "예외 처리가 좋았습니다.", "아쉬운 부분이 있지만 통과했습니다.", "리팩터링이 필요해 보입니다."][(rnd() * 4) | 0],
          items: [
            { label: "코드 품질", score: 3 + ((rnd() * 3) | 0) },
            { label: "설명 능력", score: 3 + ((rnd() * 3) | 0) },
          ],
        };
      }
      events.push(ev);
    }
  }
  return {
    meta: { generatedAt: new Date().toISOString(), year, month, mock: true },
    members,
    events,
  };
}

/* ================= 데이터 로드 =================
 * 월별 JSON은 저장소에 영구 커밋된 캐시 — 대시보드는 파일만 읽는다.
 * 파일이 없으면 null 반환 (MOCK 데모는 실데이터를 한 번도 못 본 초기 상태에서만 표시).
 */
async function fetchMonth(year, month) {
  const file = `data/${year}-${pad(month)}.json`;
  try {
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!Array.isArray(data.events)) throw new Error("bad schema");
    return data;
  } catch (_) {
    return null;
  }
}

/* ================= 집계 ================= */
function memberMap(data) {
  const m = new Map();
  (data.members || []).forEach((x) => m.set(String(x.mbrId), x));
  return m;
}
/* ISO(UTC) → 한국시간 표시 (생성시각이 UTC라 그대로 찍으면 9시간 과거로 보임) */
function fmtKst(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).replace("T", " ").slice(0, 19);
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function nameOf(mm, id) {
  const m = id && mm.get(String(id));
  return (m && m.name) || (id ? String(id) : "-");
}
// 이벤트 한쪽(평가자/피평가자)의 표시 이름: mbrId → 명부, 없으면 이벤트의 이름 필드
function sideName(mm, ev, side) {
  const id = ev[side + "Id"];
  const m = id && mm.get(String(id));
  const named = (m && m.name) || ev[side + "Name"] || null;
  if (named) return named;
  // selfOnly(세션 뷰) 데이터에서 이름이 없는 쪽은 세션 소유자 본인
  if (state.data && state.data.meta && state.data.meta.selfOnlyWarning) return "세션 소유자";
  return id ? String(id) : "-";
}

function computeStats(data) {
  const mm = memberMap(data);
  const per = new Map(); // mbrId → 집계 (식별 가능한 멤버만)
  const ensure = (id) => {
    if (!per.has(id)) {
      per.set(id, {
        mbrId: id, name: nameOf(mm, id),
        given: 0, received: 0,
      });
    }
    return per.get(id);
  };
  const byDay = new Map();
  const total = { shown: 0, completed: 0, inProgress: 0 };

  for (const ev of data.events) {
    const dk = dayKey(ev.slotDateTime || ev.regDateTime);
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(ev);

    total.shown++;
    const a = ev.evaluatorId ? ensure(ev.evaluatorId) : null;
    const b = ev.evaluateeId ? ensure(ev.evaluateeId) : null;

    if (ev.status === "IN_PROGRESS") {
      total.inProgress++;
    } else if (ev.status === "COMPLETED") {
      total.completed++;
      if (a) a.given++;
      if (b) b.received++;
    }
  }
  return { mm, per, byDay, total };
}

/* ================= 렌더: 요약 카드 ================= */
function renderSummary(stats, data) {
  const { total, per } = stats;

  // 피크 시간대
  const hourCount = new Array(24).fill(0);
  for (const ev of data.events) {
    const h = Number((ev.slotDateTime || "").slice(11, 13));
    if (Number.isFinite(h)) hourCount[h]++;
  }
  const peakHour = hourCount.indexOf(Math.max(...hourCount));


  const top = (key) => {
    let best = null;
    for (const p of per.values()) if (!best || p[key] > best[key]) best = p;
    return best && best[key] > 0 ? `${best.name} (${best[key]})` : "-";
  };

  const cards = [
    { label: "완료된 평가", value: total.completed, cls: "accent", sub: `${state.year}-${pad(state.month)}` },
    { label: "피크 시간대", value: total.shown ? `${pad(peakHour)}시` : "-", cls: "warn", sub: `누적 ${Math.max(...hourCount)}건` },
    { label: "최다 평가자", value: top("given"), cls: "", sub: "완료 기준" },
    { label: "최다 피평가자", value: top("received"), cls: "good", sub: "완료 기준" },
  ];
  $("#summary").innerHTML = cards.map((c) => `
    <div class="card ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join("");
}

/* ================= 렌더: 캘린더 ================= */
function renderCalendar(stats) {
  const { byDay } = stats;
  const first = new Date(state.year, state.month - 1, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(state.year, state.month, 0).getDate();
  const today = kstToday();
  const cells = [];

  for (let i = 0; i < startDow; i++) cells.push(`<div class="day empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = `${state.year}-${pad(state.month)}-${pad(d)}`;
    const events = byDay.get(dk) || [];
    const ok = events.filter((e) => e.status === "COMPLETED").length;
    const ip = events.filter((e) => e.status === "IN_PROGRESS").length;
    const people = new Set();
    events.forEach((e) => { people.add(nameOf(stats.mm, e.evaluatorId)); people.add(nameOf(stats.mm, e.evaluateeId)); });
    const names = [...people];
    const isToday = today.year === state.year && today.month === state.month && today.day === d;
    cells.push(`
      <div class="day ${isToday ? "today-cell" : ""}" data-day="${dk}">
        <div class="dnum">${d}</div>
        <div class="counts">
          ${ok ? `<span class="ok">✔ ${ok}</span>` : ""}
          ${ip ? `<span class="ip">◔ ${ip}</span>` : ""}
        </div>
        <div class="names">
          ${names.slice(0, 3).join("<br>")}
          ${names.length > 3 ? `<span class="more">외 ${names.length - 3}명</span>` : ""}
        </div>
      </div>`);
  }
  $("#calendar").innerHTML = cells.join("");
  $("#calendar").querySelectorAll(".day[data-day]").forEach((el) => {
    el.addEventListener("click", () => openDayModal(el.dataset.day, stats));
  });
}

/* ================= 렌더: 랭킹 테이블 ================= */
function renderRank(stats) {
  const rows = [...stats.per.values()];
  rows.sort((a, b) => {
    const k = state.sortKey;
    const va = a[k], vb = b[k];
    const cmp = typeof va === "string" ? va.localeCompare(vb, "ko") : va - vb;
    return state.sortAsc ? cmp : -cmp;
  });
  const max = rows.slice(0, 50);
  $("#rankTable tbody").innerHTML = max.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${p.name}</td>
      <td class="num">${p.given}</td>
      <td class="num">${p.received}</td>
    </tr>`).join("") || `<tr><td colspan="4" style="color:var(--muted)">데이터 없음</td></tr>`;
}

/* ================= 렌더: 히트맵 (요일×시간) ================= */
function renderHeatmap(stats, data) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const ev of data.events) {
    if (state.heatFilter !== "ALL" && ev.status !== state.heatFilter) continue;
    const dt = ev.slotDateTime || ev.regDateTime;
    if (!dt) continue;
    const d = new Date(dt.replace("+09:00", ""));
    // KST 기준: 문자열 그대로 파싱 (이미 +09:00 포함)
    const dk = dayKey(dt);
    const dow = new Date(`${dk}T12:00:00+09:00`).getDay();
    const h = Number(dt.slice(11, 13));
    if (Number.isFinite(h)) grid[dow][h]++;
  }
  const maxV = Math.max(1, ...grid.flat());
  const dows = ["일", "월", "화", "수", "목", "금", "토"];
  let html = `<div class="hlabel"></div>`;
  for (let h = 0; h < 24; h++) html += `<div class="haxis">${h % 3 === 0 ? h : ""}</div>`;
  for (let dow = 0; dow < 7; dow++) {
    html += `<div class="hlabel">${dows[dow]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[dow][h];
      const alpha = v ? 0.15 + 0.85 * (v / maxV) : 0;
      const bg = v ? `background:rgba(79,140,255,${alpha.toFixed(2)})` : "";
      html += `<div class="hcell" style="${bg}" title="${dows[dow]}요일 ${h}시: ${v}건"></div>`;
    }
  }
  $("#heatmap").innerHTML = html;
}

/* ================= 모달 ================= */
function openModal(id) { $(id).hidden = false; }
function closeModal(el) { el.closest(".modal-bg").hidden = true; }

/* 종료 추정: endTime이 있으면 그 시각, 없으면 시작+30분 (추정 — 소스 확정값 아님.
 * 7/22 사건 원인④: 끝난 평가도 소스 반영 지연으로 한동안 IN_PROGRESS로 남는 문제의 UI 측 완화) */
const ASSUMED_EVAL_MIN = 30;
function assumedEndMs(ev) {
  if (ev.endTime && ev.slotDateTime) {
    const d = new Date(`${String(ev.slotDateTime).slice(0, 10)}T${ev.endTime}:00+09:00`);
    return isNaN(d) ? null : d.getTime();
  }
  if (ev.slotDateTime) {
    const d = new Date(ev.slotDateTime);
    return isNaN(d) ? null : d.getTime() + ASSUMED_EVAL_MIN * 60000;
  }
  return null;
}

function statusBadge(ev) {
  // 화면에는 완료/진행만 올라온다 (refresh에서 요청·예약·취소·거절 건 필터)
  switch (ev.status) {
    case "COMPLETED": return `<span class="badge ok">완료</span>`;
    case "IN_PROGRESS": {
      // 종료(추정) 시각이 지났는데도 진행중 → 소스의 완료 반영 지연일 가능성이 높음
      const endMs = assumedEndMs(ev);
      if (endMs && Date.now() > endMs)
        return `<span class="badge ip late" title="슬롯 종료(추정) 경과 — 소스가 아직 진행중으로 표시 중. 완료 확정 반영 대기">진행(확정 대기)</span>`;
      return `<span class="badge ip">진행</span>`;
    }
    default: return "";
  }
}

function openDayModal(dk, stats) {
  const events = (stats.byDay.get(dk) || [])
    .slice()
    .sort((a, b) => String(a.slotDateTime).localeCompare(String(b.slotDateTime)));
  $("#dayModalTitle").textContent = `${dk} 평가 ${events.length}건`;
  $("#dayModalBody").innerHTML = events.map((ev) => {
    const a = sideName(stats.mm, ev, "evaluator");
    const b = sideName(stats.mm, ev, "evaluatee");
    return `
    <div class="ev-row" data-eval="${ev.evalId}">
      <span class="time">${timeStr(ev.slotDateTime)}</span>
      <span class="who">
        <b>${a}</b><span class="arr">→</span><b>${b}</b>
        <span class="proj"> · ${ev.projectName || "-"}</span>
      </span>
      <span class="meta">${statusBadge(ev)}</span>
    </div>`;
  }).join("") || `<p style="color:var(--muted)">이 날의 평가가 없습니다.</p>`;

  $("#dayModalBody").querySelectorAll(".ev-row").forEach((row) => {
    row.addEventListener("click", () => {
      const ev = events.find((e) => e.evalId === row.dataset.eval);
      if (ev) openDetailModal(ev, stats);
    });
  });
  openModal("#dayModal");
}

/* ================= 검색 =================
 * 표시 정책과 동일한 집합(완료·진행)을 이름/과제명으로 필터.
 * 이름은 평가한 사람(평가자) 기준만 매칭 — 피평가(받은 평가)는 제외 (2026-08-01 요청).
 * 두 조건 동시 입력 시 AND. "전체 월" 체크 시 data/index.json의 전 월을 스캔한다.
 */
const SEARCH_MAX_ROWS = 200;
const monthCache = new Map(); // "YYYY-MM" → 월 데이터 (이름 검색 세션 내 캐시)
let monthListPromise = null;

async function fetchMonthList() {
  if (!monthListPromise) {
    monthListPromise = (async () => {
      try {
        const r = await fetch("data/index.json", { cache: "no-store" });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length) return arr;
        }
      } catch (_) { /* 폐지 */ }
      // 매니페스트 없으면 첫 수집월(2026-05)부터 이번 달까지 순회 추정
      const t = kstToday(); const out = [];
      for (let y = 2026, m = 5; y < t.year || (y === t.year && m <= t.month);) {
        out.push(`${y}-${pad(m)}`);
        if (++m > 12) { m = 1; y++; }
      }
      return out;
    })();
  }
  return monthListPromise;
}

async function loadAllMonthsData() {
  const list = await fetchMonthList();
  await Promise.all(list.map(async (ym) => {
    if (monthCache.has(ym)) return;
    const [y, m] = ym.split("-").map(Number);
    const d = await fetchMonth(y, m);
    if (d) monthCache.set(ym, d);
  }));
}

function searchMatch(ev, mm, nameQ, projQ) {
  if (nameQ) {
    const a = (sideName(mm, ev, "evaluator") + " " + (ev.evaluatorName || "")).toLowerCase();
    if (!a.includes(nameQ)) return false;
  }
  if (projQ) {
    const p = ((ev.projectName || "") + " " + (ev.trackName || "")).toLowerCase();
    if (!p.includes(projQ)) return false;
  }
  return true;
}

function runSearch() {
  if (!state.data || !lastStats) return;
  const nameQ = ($("#searchName").value || "").trim().toLowerCase();
  const projQ = ($("#searchProj").value || "").trim().toLowerCase();
  const allScope = $("#searchAll").checked;
  $("#searchScope").textContent = allScope ? "· 전체 월" : `· ${state.year}-${pad(state.month)}`;

  if (!nameQ && !projQ) {
    $("#searchInfo").textContent = allScope
      ? "이름(평가자)이나 과제명을 입력하면 전체 월에서 바로 필터됩니다"
      : `${state.year}-${pad(state.month)} 표시 중인 평가 ${state.data.events.length}건 — 이름(평가자)이나 과제명을 입력하면 바로 필터됩니다`;
    $("#searchResults").innerHTML = "";
    return;
  }

  if (allScope) {
    $("#searchInfo").textContent = "전체 월 데이터 불러오는 중...";
    loadAllMonthsData()
      .then(() => renderSearchResults(nameQ, projQ, true))
      .catch(() => { $("#searchInfo").textContent = "전체 월 데이터 로드 실패 — 네트워크를 확인하세요"; });
    return;
  }
  renderSearchResults(nameQ, projQ, false);
}

function renderSearchResults(nameQ, projQ, allScope) {
  const mm = new Map(); // 머지된 명부 (mbrId → 멤버)
  const pool = [];      // {ym, ev}
  if (allScope) {
    for (const [ym, d] of [...monthCache.entries()].sort()) {
      (d.members || []).forEach((x) => mm.set(String(x.mbrId), x));
      for (const ev of (d.events || [])) {
        if (ev.status !== "COMPLETED" && ev.status !== "IN_PROGRESS") continue;
        pool.push({ ym, ev });
      }
    }
  } else {
    lastStats.mm.forEach((v, k) => mm.set(k, v));
    const ym = `${state.year}-${pad(state.month)}`;
    for (const ev of (state.data.events || [])) pool.push({ ym, ev });
  }

  const hits = pool
    .filter(({ ev }) => searchMatch(ev, mm, nameQ, projQ))
    .sort((a, b) => String(b.ev.slotDateTime || "").localeCompare(String(a.ev.slotDateTime || "")));

  $("#searchInfo").textContent = hits.length
    ? `${hits.length}건 일치${allScope ? " · 전체 월" : ""}${hits.length > SEARCH_MAX_ROWS ? ` · 최근 ${SEARCH_MAX_ROWS}건까지 표시` : ""}`
    : "일치하는 평가가 없습니다";

  const counts = {};
  hits.forEach((h) => { counts[h.ym] = (counts[h.ym] || 0) + 1; });
  const showGroups = allScope && Object.keys(counts).length > 1;

  let html = "";
  let curYm = null;
  hits.slice(0, SEARCH_MAX_ROWS).forEach(({ ym, ev }, i) => {
    if (showGroups && ym !== curYm) {
      curYm = ym;
      html += `<div class="group-head">${ym} · ${counts[ym]}건</div>`;
    }
    const a = sideName(mm, ev, "evaluator");
    const b = sideName(mm, ev, "evaluatee");
    const scoreBit = ev.score != null && ev.score !== ""
      ? ` <span class="score-chip">${ev.score}점${ev.resultNm ? ` · ${ev.resultNm}` : ""}</span>` : "";
    const fbBit = ev.feedback ? ` <span class="fb-chip" title="피드백 코멘트 있음">💬</span>` : "";
    html += `
    <div class="ev-row" data-idx="${i}">
      <span class="date">${dayKey(ev.slotDateTime || ev.regDateTime).slice(5)}</span>
      <span class="time">${timeStr(ev.slotDateTime)}</span>
      <span class="who">
        <b>${a}</b><span class="arr">→</span><b>${b}</b>
        <span class="proj"> · ${ev.projectName || "-"}</span>${scoreBit}${fbBit}
      </span>
      <span class="meta">${statusBadge(ev)}</span>
    </div>`;
  });
  $("#searchResults").innerHTML = html;

  $("#searchResults").querySelectorAll(".ev-row").forEach((row) => {
    row.addEventListener("click", () => {
      const h = hits[Number(row.dataset.idx)];
      if (h) openDetailModal(h.ev, { mm });
    });
  });
}

function openSearchModal() {
  openModal("#searchModal");
  runSearch();
  setTimeout(() => $("#searchName").focus(), 0);
}

function openDetailModal(ev, stats) {
  const a = sideName(stats.mm, ev, "evaluator");
  const b = sideName(stats.mm, ev, "evaluatee");
  $("#detailModalTitle").textContent = `평가 상세 — ${ev.evalId}`;
  const d = ev.detail; // 구형/MOCK 스키마 호환 (현 수집기는 최상위 score/resultNm 사용)
  const reqAt = ev.requestedAt || ev.regDateTime;
  $("#detailModalBody").innerHTML = `
    <dl class="detail-kv">
      <dt>평가자</dt><dd>${a}</dd>
      <dt>피평가자</dt><dd>${b}</dd>
      <dt>과제</dt><dd>${ev.projectName || "-"}</dd>
      ${ev.trackName ? `<dt>트랙</dt><dd>${ev.trackName}</dd>` : ""}
      <dt>슬롯 시각</dt><dd>${(ev.slotDateTime || "").replace("T", " ").slice(0, 16)}${ev.endTime ? ` ~ ${ev.endTime}` : ""}</dd>
      ${reqAt ? `<dt>요청 시각</dt><dd>${String(reqAt).replace("T", " ").slice(0, 16)}</dd>` : ""}
      <dt>상태</dt><dd>${statusBadge(ev)}${ev.stusNm ? ` <span class="hint">${ev.stusNm}</span>` : ""}</dd>
      ${ev.score != null && ev.score !== "" ? `<dt>점수</dt><dd><b>${ev.score}</b></dd>` : ""}
      ${ev.resultNm ? `<dt>결과</dt><dd>${ev.resultNm}</dd>` : ""}
      ${d && d.score != null ? `<dt>점수</dt><dd><b>${d.score}</b></dd>` : ""}
      ${d && d.comment ? `<dt>코멘트</dt><dd>${d.comment}</dd>` : ""}
      ${ev.feedback ? `<dt>피드백</dt><dd>${ev.feedback}</dd>` : ""}
    </dl>
    ${d && Array.isArray(d.items) && d.items.length ? `
      <table class="detail-items">
        <thead><tr><th>항목</th><th>점수</th></tr></thead>
        <tbody>${d.items.map((it) => `<tr><td>${it.label}</td><td>${it.score}</td></tr>`).join("")}</tbody>
      </table>` : ""}
  `;
  openModal("#detailModal");
}

/* ================= 메인 ================= */
async function refresh() {
  $("#statusLine").textContent = "불러오는 중...";
  let data = await fetchMonth(state.year, state.month);
  let emptyMonth = false;
  let fallbackNote = null;
  if (data) {
    state.everHadReal = true;
  } else {
    // 월/년 경계 보호: 현재 달 첫 파일이 아직 없으면(수집 지연) 지난달을 자동 표시
    const today = kstToday();
    const isCurrent = state.year === today.year && state.month === today.month;
    if (isCurrent) {
      const prev = state.month === 1 ? { year: state.year - 1, month: 12 } : { year: state.year, month: state.month - 1 };
      const prevData = await fetchMonth(prev.year, prev.month);
      if (prevData) {
        fallbackNote = `${state.year}-${pad(state.month)} 수집 전 → ${prev.year}-${pad(prev.month)} 표시 중`;
        state.year = prev.year; state.month = prev.month;
        data = prevData;
        state.everHadReal = true;
      }
    }
    if (!data) {
      if (!state.everHadReal) {
        data = mockMonth(state.year, state.month); // 초기 데모 상태
      } else {
    // 과거/미래의 미수집 달: MOCK 대신 빈 달로 표시 (가짜 데이터 혼동 방지)
        emptyMonth = true;
        data = { meta: { generatedAt: null, year: state.year, month: state.month, mock: false }, members: [], events: [], slots: [] };
      }
    }
  }
  // 표시 정책: 완료·진행 중인 평가만 노출 (2026-08-01 요청 —
  // 예정된 평가 기능 제거: 요청/예약(REQUESTED)·취소·거절(CANCELLED) 건은 화면에 표시하지 않음)
  // 데이터 자체는 JSON에 그대로 유지한다.
  data.events = (data.events || []).filter((e) => e.status === "COMPLETED" || e.status === "IN_PROGRESS");
  state.data = data;
  const stats = computeStats(data);
  lastStats = stats;

  $("#mockBanner").hidden = !data.meta.mock;
  const notePrefix = fallbackNote ? `${fallbackNote} · ` : "";
  $("#statusLine").textContent = emptyMonth
    ? `${state.year}-${pad(state.month)} · 수집된 데이터가 없습니다`
    : data.meta.generatedAt
      ? `${notePrefix}마지막 수집: ${fmtKst(data.meta.generatedAt)} · 이벤트 ${data.events.length}건${data.meta.selfOnlyWarning ? " · 🔒 세션 뷰 (세션 소유자 참여 평가만 — API가 타인 스케줄 조회를 허용하지 않음)" : ""}`
      : (fallbackNote || "");

  $("#ymInput").value = `${state.year}-${pad(state.month)}`;
  renderSummary(stats, data);
  renderCalendar(stats);
  renderRank(stats);
  renderHeatmap(stats, data);
}

function shiftMonth(delta) {
  let y = state.year, m = state.month + delta;
  if (m < 1) { y--; m = 12; }
  if (m > 12) { y++; m = 1; }
  state.year = y; state.month = m;
  refresh();
}

/* ================= 자동 갱신 (30분 수집 주기 동기화) =================
 * 수집 워크플로가 30분마다 docs/data/*.json 을 갱신하므로,
 * 5분마다 generatedAt을 비교해 새 수집본이 올라왔으면 자동 리렌더한다.
 * (MOCK 모드였다가 첫 실데이터가 도착한 경우도 자동으로 실데이터로 전환됨)
 */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

async function autoRefreshCheck() {
  if (!state.data) return; // 최초 refresh() 이후에만 동작
  try {
    const file = `data/${state.year}-${pad(state.month)}.json`;
    const res = await fetch(file, { cache: "no-store" });
    if (!res.ok) return; // 실데이터가 아직 없으면 그대로
    const fresh = await res.json();
    const gen = fresh && fresh.meta && fresh.meta.generatedAt;
    const cur = state.data.meta && state.data.meta.generatedAt;
    if (gen && gen !== cur) refresh();
  } catch (_) {
    /* 네트워크 오류는 무시하고 다음 주기에 재시도 */
  }
}

setInterval(() => {
  if (!document.hidden) autoRefreshCheck();
}, AUTO_REFRESH_INTERVAL_MS);

// 다른 탭에 있다가 돌아왔을 때도 즉시 확인
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autoRefreshCheck();
});

document.addEventListener("DOMContentLoaded", () => {
  $("#btnSearch").addEventListener("click", openSearchModal);
  $("#searchName").addEventListener("input", runSearch);
  $("#searchProj").addEventListener("input", runSearch);
  $("#searchAll").addEventListener("change", runSearch);
  $("#btnPrev").addEventListener("click", () => shiftMonth(-1));
  $("#btnNext").addEventListener("click", () => shiftMonth(1));
  $("#btnToday").addEventListener("click", () => {
    const t = kstToday();
    state.year = t.year; state.month = t.month;
    refresh();
  });
  $("#ymInput").addEventListener("change", (e) => {
    const [y, m] = e.target.value.split("-").map(Number);
    if (y && m) { state.year = y; state.month = m; refresh(); }
  });
  $("#rankTable").querySelectorAll("th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = false; }
      renderRank(computeStats(state.data));
    });
  });
  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.heatFilter = chip.dataset.filter;
      renderHeatmap(computeStats(state.data), state.data);
    });
  });
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn));
  });
  document.querySelectorAll(".modal-bg").forEach((bg) => {
    bg.addEventListener("click", (e) => { if (e.target === bg) bg.hidden = true; });
  });
  refresh();
});
