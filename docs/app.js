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

/* 재예약 신호 판정:
 * 취소자가 취소한 슬롯과 같은 날 ±2시간 내, "다른 상대"와 확정된 평가가 있으면 true.
 * 주의: API가 취소 시각/요청 시각을 주지 않아 시간 순서는 알 수 없고,
 *       슬롯 시각 근접성으로 근사한다. 재예약 상대가 원래 그 사람이면(재시도 성공) 제외.
 */
const REBOOK_WINDOW_MS = 2 * 60 * 60 * 1000;
function isRebookedCancel(confirmedEvts, ev) {
  const t = Date.parse(ev.slotDateTime || "");
  if (isNaN(t)) return false;
  const c = ev.cancel || {};
  if (!c.byId && !c.byName) return false;
  const day = dayKey(ev.slotDateTime);
  const isMe = (id, name) => (c.byId && id === c.byId) || (c.byName && name === c.byName);
  const otherSides = [{ id: ev.evaluatorId, name: ev.evaluatorName }, { id: ev.evaluateeId, name: ev.evaluateeName }]
    .filter((s) => !(c.byId && s.id === c.byId) && !(c.byName && s.name === c.byName));
  for (const o of confirmedEvts) {
    if (o.evalId === ev.evalId) continue;
    const ot = Date.parse(o.slotDateTime || "");
    if (isNaN(ot) || Math.abs(ot - t) > REBOOK_WINDOW_MS || dayKey(o.slotDateTime) !== day) continue;
    const meAsEvaluator = isMe(o.evaluatorId, o.evaluatorName);
    const meAsEvaluatee = isMe(o.evaluateeId, o.evaluateeName);
    if (!meAsEvaluator && !meAsEvaluatee) continue;
    const other = meAsEvaluator
      ? { id: o.evaluateeId, name: o.evaluateeName }
      : { id: o.evaluatorId, name: o.evaluatorName };
    // 취소 건의 상대방과 같은 사람이면 "재시도 성공"이므로 기피 신호 아님
    const sameCounter = otherSides.some(
      (s) => (s.id && s.id === other.id) || (s.name && s.name === other.name)
    );
    if (!sameCounter) return true;
  }
  return false;
}

function computeStats(data) {
  const mm = memberMap(data);
  const per = new Map(); // mbrId → 집계 (식별 가능한 멤버만)
  const ensure = (id) => {
    if (!per.has(id)) {
      per.set(id, {
        mbrId: id, name: nameOf(mm, id),
        given: 0, received: 0, cancelledByMe: 0, cancelledOnMe: 0, involved: 0,
      });
    }
    return per.get(id);
  };
  const byDay = new Map();
  const total = { requested: 0, completed: 0, cancelled: 0 };
  // 페어 취소: 식별자가 없으면 이름 기준으로라도 집계
  const pairs = new Map(); // key → {count, rebooked, byId, byName, counterId, counterName, role}

  // 재예약 신호 판정용: 확정(비취소) 이벤트만 따로 모아둠
  const confirmedEvts = (data.events || []).filter((e) => e.status !== "CANCELLED");

  for (const ev of data.events) {
    const dk = dayKey(ev.slotDateTime || ev.regDateTime);
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(ev);

    total.requested++;
    const a = ev.evaluatorId ? ensure(ev.evaluatorId) : null;
    const b = ev.evaluateeId ? ensure(ev.evaluateeId) : null;
    if (a) a.involved++;
    if (b) b.involved++;

    if (ev.status === "CANCELLED") {
      total.cancelled++;
      const c = ev.cancel || {};
      const byId = c.byId || null;
      const byName = c.byName || (byId ? nameOf(mm, byId) : null);
      const counterId = byId && byId === ev.evaluatorId ? ev.evaluateeId
        : byId && byId === ev.evaluateeId ? ev.evaluatorId : null;
      const counterName = counterId ? nameOf(mm, counterId)
        : (c.by === "EVALUATOR" ? ev.evaluateeName : c.by === "EVALUATEE" ? ev.evaluatorName : null);

      if (byId) ensure(byId).cancelledByMe++;
      if (counterId) ensure(counterId).cancelledOnMe++;

      const role = c.by === "EVALUATOR" ? "평가자로서 취소" : c.by === "EVALUATEE" ? "피평가자로서 취소" : "기타 취소";
      const pairKey = `${byId || byName || "?"}|${counterId || counterName || "?"}|${role}`;
      if (!pairs.has(pairKey)) {
        pairs.set(pairKey, { count: 0, rebooked: 0, byId, byName, counterId, counterName, role });
      }
      pairs.get(pairKey).count++;
      // 재예약 신호: 같은 날 ±2시간 내 "다른 상대"와 확정 평가가 잡혀 있으면 기피 패턴 후보
      if (isRebookedCancel(confirmedEvts, ev)) pairs.get(pairKey).rebooked++;
    } else if (ev.status === "COMPLETED") {
      total.completed++;
      if (a) a.given++;
      if (b) b.received++;
    }
  }
  return { mm, per, byDay, total, pairs };
}

/* ================= 렌더: 요약 카드 ================= */
function renderSummary(stats, data) {
  const { total, per } = stats;
  const rate = total.requested ? Math.round((total.cancelled / total.requested) * 100) : 0;

  // 피크 시간대
  const hourCount = new Array(24).fill(0);
  for (const ev of data.events) {
    const h = Number((ev.slotDateTime || "").slice(11, 13));
    if (Number.isFinite(h)) hourCount[h]++;
  }
  const peakHour = hourCount.indexOf(Math.max(...hourCount));

  // 취소 vs 거절 분해 (거절 = 평가자가 끊은 건)
  const isReject = (e) => e.status === "CANCELLED" && ((e.stusNm || "").includes("거절") || e.stusCd === "00004" || (e.cancel && e.cancel.by === "EVALUATOR"));
  const rejectN = (data.events || []).filter(isReject).length;
  const cancelN = total.cancelled - rejectN;

  const top = (key) => {
    let best = null;
    for (const p of per.values()) if (!best || p[key] > best[key]) best = p;
    return best && best[key] > 0 ? `${best.name} (${best[key]})` : "-";
  };

  const cards = [
    { label: "총 평가 요청", value: total.requested, cls: "accent", sub: `${state.year}-${pad(state.month)}` },
    { label: "완료된 평가", value: total.completed, cls: "good", sub: `완료율 ${total.requested ? Math.round((total.completed / total.requested) * 100) : 0}%` },
    { label: "취소/거절된 평가", value: total.cancelled, cls: "bad", sub: `취소 ${cancelN} · 거절 ${rejectN} (${rate}%)` },
    { label: "피크 시간대", value: total.requested ? `${pad(peakHour)}시` : "-", cls: "warn", sub: `누적 ${Math.max(...hourCount)}건` },
    { label: "최다 평가자", value: top("given"), cls: "", sub: "완료 기준" },
    { label: "최다 피평가자", value: top("received"), cls: "", sub: "완료 기준" },
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
    const cx = events.filter((e) => e.status === "CANCELLED").length;
    const people = new Set();
    events.forEach((e) => { people.add(nameOf(stats.mm, e.evaluatorId)); people.add(nameOf(stats.mm, e.evaluateeId)); });
    const names = [...people];
    const isToday = today.year === state.year && today.month === state.month && today.day === d;
    cells.push(`
      <div class="day ${isToday ? "today-cell" : ""}" data-day="${dk}">
        <div class="dnum">${d}</div>
        <div class="counts">
          ${ok ? `<span class="ok">✔ ${ok}</span>` : ""}
          ${cx ? `<span class="cx">✖ ${cx}</span>` : ""}
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
  const rows = [...stats.per.values()].map((p) => ({
    ...p,
    cancelRate: p.involved ? Math.round(((p.cancelledByMe + p.cancelledOnMe) / p.involved) * 100) : 0,
  }));
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
      <td class="num">${p.cancelledByMe ? `<span class="badge cx">${p.cancelledByMe}</span>` : 0}</td>
      <td class="num">${p.cancelledOnMe ? `<span class="badge cx">${p.cancelledOnMe}</span>` : 0}</td>
      <td class="num">${p.cancelRate}%</td>
    </tr>`).join("") || `<tr><td colspan="7" style="color:var(--muted)">데이터 없음</td></tr>`;
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

/* ================= 렌더: 기피 분석 ================= */
/* 판정 등급: score = 취소횟수×2 + 재예약×1
 *  🚨 반복 — 같은 상대에게 2회 이상 취소
 *  ⚠️ 재예약 — 취소 슬롯 근처(같은 날 ±2시간)에 다른 상대와 확정 평가
 */
function pairVerdict(p) {
  if (p.count >= 2) return { label: "🚨 반복", cls: "verdict-strong" };
  if ((p.rebooked || 0) >= 1) return { label: "⚠️ 재예약", cls: "verdict-warn" };
  return null;
}

function renderAvoidance(stats) {
  const rows = [...stats.pairs.values()]
    .map((p) => ({
      ...p,
      byName: p.byName || (p.byId ? nameOf(stats.mm, p.byId) : "?"),
      counterName: p.counterName || (p.counterId ? nameOf(stats.mm, p.counterId) : "?"),
      score: p.count * 2 + (p.rebooked || 0),
      verdict: pairVerdict(p),
    }))
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 30);

  $("#pairTable tbody").innerHTML = rows.map((r, i) => `
    <tr${r.verdict ? ` class="${r.verdict.cls === "verdict-strong" ? "sus-strong" : "sus-warn"}"` : ""}>
      <td>${i + 1}</td>
      <td>${r.byName}</td>
      <td><span class="badge ${r.role.includes("평가자로") ? "rq" : "ip"}">${r.role}</span></td>
      <td>${r.counterName}</td>
      <td class="num"><b>${r.count}</b></td>
      <td class="num">${r.rebooked ? `<b>${r.rebooked}</b>` : "-"}</td>
      <td>${r.verdict ? `<span class="badge ${r.verdict.cls}">${r.verdict.label}</span>` : `<span class="verdict-none">단순 취소</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="7" style="color:var(--muted)">취소 데이터가 없습니다. (수집기가 cancel 정보를 포함해야 합니다)</td></tr>`;

  // 취소자별 요약 카드: 상위 취소자 + 가장 많이 엮인 상대 top3
  const byCanceler = new Map();
  for (const r of rows) {
    const cid = r.byId || r.byName;
    if (!cid) continue;
    if (!byCanceler.has(cid)) byCanceler.set(cid, { name: r.byName, total: 0, rebooked: 0, targets: [] });
    const c = byCanceler.get(cid);
    c.total += r.count;
    c.rebooked += r.rebooked || 0;
    c.targets.push(r);
  }
  const cards = [...byCanceler.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  $("#avoidanceSummary").innerHTML = cards.map((c) => `
    <div class="avoid-card">
      <div class="who">${c.name} — 취소 ${c.total}회${c.rebooked ? ` (재예약 ${c.rebooked})` : ""}</div>
      <div class="targets">
        ${c.targets.slice(0, 3).map((t) => `${t.counterName} 상대 <b>${t.count}회</b> (${t.role.replace("으로서 취소", "")})${t.verdict ? ` ${t.verdict.label}` : ""}`).join("<br>")}
      </div>
    </div>`).join("");
}

/* ================= 렌더: 슬롯 오픈 분석 ================= */
function renderSlots(stats, data) {
  const panel = $("#slotPanel");
  const slots = Array.isArray(data.slots) ? data.slots : [];
  if (!slots.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const matched = slots.filter((s) => s.matched).length;
  const owners = new Set(slots.map((s) => s.m));
  const openNow = slots.length - matched;
  const conv = slots.length ? Math.round((matched / slots.length) * 100) : 0;

  $("#slotSummary").innerHTML = [
    { label: "총 오픈 슬롯", value: slots.length, cls: "accent", sub: `${owners.size}명이 오픈` },
    { label: "평가로 매칭", value: matched, cls: "good", sub: `전환율 ${conv}%` },
    { label: "매칭 없이 유지", value: openNow, cls: "warn", sub: "수집 시점 기준" },
  ].map((c) => `<div class="card ${c.cls}"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`).join("");

  // 시간대별
  const hours = new Array(24).fill(0);
  for (const s of slots) {
    const h = Number(String(s.t).slice(0, 2));
    if (Number.isFinite(h)) hours[h]++;
  }
  const maxH = Math.max(1, ...hours);
  $("#slotHours").innerHTML = hours.map((v, h) => `
    <div class="bar" style="height:${Math.max(2, Math.round((v / maxH) * 78))}px" title="${h}시: ${v}슬롯"></div>`).join("")
    + `<div style="grid-column:1/-1;display:flex;justify-content:space-between" class="bar-lbl"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>`;

  // 오픈 많은 멤버 (selfOnly 모드: 소유자가 세션 소유자 1명 = null)
  const perMbr = new Map();
  for (const s of slots) perMbr.set(s.m, (perMbr.get(s.m) || 0) + 1);
  const tops = [...perMbr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  $("#slotTop").innerHTML = tops.map(([id, n], i) => `
    <div class="row"><span>${i + 1}. ${id == null ? "세션 소유자" : nameOf(stats.mm, id)}</span><span class="num">${n}</span></div>`).join("");
}

/* ================= 모달 ================= */
function openModal(id) { $(id).hidden = false; }
function closeModal(el) { el.closest(".modal-bg").hidden = true; }

function statusBadge(ev) {
  switch (ev.status) {
    case "COMPLETED": return `<span class="badge ok">완료</span>`;
    case "CANCELLED":
      // stusNm/stusCd 기준으로 평가자 '거절'과 피평가자 '요청취소'를 구분 표시
      if ((ev.stusNm || "").includes("거절") || ev.stusCd === "00004" || (ev.cancel && ev.cancel.by === "EVALUATOR"))
        return `<span class="badge rj">거절</span>`;
      return `<span class="badge cx">취소</span>`;
    case "IN_PROGRESS": return `<span class="badge ip">진행</span>`;
    default: return `<span class="badge rq">요청</span>`;
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
    let cancelInfo = "";
    if (ev.status === "CANCELLED" && ev.cancel && (ev.cancel.byId || ev.cancel.byName || ev.cancel.by)) {
      const who = ev.cancel.byName || (ev.cancel.byId ? nameOf(stats.mm, ev.cancel.byId) : ev.cancel.by);
      cancelInfo = ` · 취소: ${who}${ev.cancel.reasonNm ? `(${ev.cancel.reasonNm})` : ""}`;
    }
    return `
    <div class="ev-row" data-eval="${ev.evalId}">
      <span class="time">${timeStr(ev.slotDateTime)}</span>
      <span class="who">
        <b>${a}</b><span class="arr">→</span><b>${b}</b>
        <span class="proj"> · ${ev.projectName || "-"}${cancelInfo}</span>
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

function openDetailModal(ev, stats) {
  const a = sideName(stats.mm, ev, "evaluator");
  const b = sideName(stats.mm, ev, "evaluatee");
  $("#detailModalTitle").textContent = `평가 상세 — ${ev.evalId}`;
  const d = ev.detail;
  let cancelBlock = "";
  if (ev.status === "CANCELLED" && ev.cancel) {
    cancelBlock = `
      <dt>취소 주체</dt><dd>${ev.cancel.byName || (ev.cancel.byId ? nameOf(stats.mm, ev.cancel.byId) : ev.cancel.by || "-")}${ev.cancel.reasonNm ? ` (${ev.cancel.reasonNm})` : ""}</dd>
      <dt>취소 시각</dt><dd>${ev.cancel.at || "-"}</dd>
      ${ev.cancel.reason ? `<dt>취소 사유</dt><dd>${ev.cancel.reason}</dd>` : ""}`;
  }
  $("#detailModalBody").innerHTML = `
    <dl class="detail-kv">
      <dt>평가자</dt><dd>${a}</dd>
      <dt>피평가자</dt><dd>${b}</dd>
      <dt>과제</dt><dd>${ev.projectName || "-"}${ev.trackName ? ` · ${ev.trackName}` : ""}</dd>
      <dt>슬롯 시각</dt><dd>${(ev.slotDateTime || "").replace("T", " ").slice(0, 16)}${ev.endTime ? ` ~ ${ev.endTime}` : ""}</dd>
      <dt>요청 시각</dt><dd>${(ev.regDateTime || "").replace("T", " ").slice(0, 16)}</dd>
      <dt>상태</dt><dd>${statusBadge(ev)}</dd>
      ${cancelBlock}
      ${d && d.score != null ? `<dt>점수</dt><dd><b>${d.score}</b></dd>` : ""}
      ${d && d.comment ? `<dt>코멘트</dt><dd>${d.comment}</dd>` : ""}
    </dl>
    ${d && Array.isArray(d.items) && d.items.length ? `
      <table class="detail-items">
        <thead><tr><th>항목</th><th>점수</th></tr></thead>
        <tbody>${d.items.map((it) => `<tr><td>${it.label}</td><td>${it.score}</td></tr>`).join("")}</tbody>
      </table>` : ""}
    ${!d ? `<p class="hint" style="margin-top:10px">상세 데이터가 없습니다. 수집기에서 detail 수집을 켜면 점수/코멘트가 표시됩니다.</p>` : ""}
  `;
  openModal("#detailModal");
}

/* ================= 메인 ================= */
async function refresh() {
  $("#statusLine").textContent = "불러오는 중...";
  let data = await fetchMonth(state.year, state.month);
  let emptyMonth = false;
  if (data) {
    state.everHadReal = true;
  } else if (!state.everHadReal) {
    data = mockMonth(state.year, state.month); // 초기 데모 상태
  } else {
    // 과거/미래의 미수집 달: MOCK 대신 빈 달로 표시 (가짜 데이터 혼동 방지)
    emptyMonth = true;
    data = { meta: { generatedAt: null, year: state.year, month: state.month, mock: false }, members: [], events: [], slots: [] };
  }
  state.data = data;
  const stats = computeStats(data);

  $("#mockBanner").hidden = !data.meta.mock;
  $("#statusLine").textContent = emptyMonth
    ? `${state.year}-${pad(state.month)} · 수집된 데이터가 없습니다`
    : data.meta.generatedAt
      ? `마지막 수집: ${data.meta.generatedAt.replace("T", " ").slice(0, 19)} · 이벤트 ${data.events.length}건${data.meta.selfOnlyWarning ? " · 🔒 세션 뷰 (세션 소유자 참여 평가만 — API가 타인 스케줄 조회를 허용하지 않음)" : ""}`
      : "";

  $("#ymInput").value = `${state.year}-${pad(state.month)}`;
  renderSummary(stats, data);
  renderCalendar(stats);
  renderRank(stats);
  renderHeatmap(stats, data);
  renderSlots(stats, data);
  renderAvoidance(stats);
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
