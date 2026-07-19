"use strict";

// 수집 대상 선정(Trigger A/B)과 병합 정리의 순수 로직 모음.
//
// 배경 (2026-07-19 버그):
// - 목록(searchList)의 evlStusCd는 "base" 코드 체계, 상세 트랜잭션의 mtlEvlStusCd는
//   "txn" 코드 체계로 서로 다른 도메인이다 (예: base 00003 = 완료, txn 00003 = 진행중).
// - 이 둘을 한 Set에 섞어 "변화 없음"을 판정하면 코드 충돌로 갱신을 영구 스킵한다.
//   (txn 진행중 코드 00003이 저장돼 있어 완료된 base 00003을 변화로 인식 못 함)
// - 따라서 base 코드는 마지막 상세 조회 시점 기준으로 평가 단위당 1개(meta.evalStatus)로
//   추적하고, 목록이 회복해주지 않는 비종결 평가는 스윕으로 상세를 직접 다시 본다.

const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "REQUESTED"]);

function evalKey(evlNo, evlDegr) {
  return `${evlNo}|${evlDegr}`;
}

// Trigger A (base-diff): 목록의 base 코드가 마지막으로 기록된 값과 다르면 상세 재조회 대상.
// - evalStatus에 기록이 없으면(초기 실행) 대상으로 본다.
// - 목록 행의 코드가 비어 있으면 변화로 오판하지 않도록 걸러낸다.
function isBaseChanged(row, evalStatus) {
  if (!row || row.evlNo == null) return false;
  const key = evalKey(row.evlNo, row.evlDegr);
  const stored = evalStatus ? evalStatus[key] : null;
  if (!stored || !stored.baseCd) return true;
  const next = String(row.evlStusCd || "");
  return !!next && next !== String(stored.baseCd);
}

// 상세 조회 후 base 코드를 기록해 다음 실행의 Trigger A 판정 기준으로 삼는다.
function recordBaseCd(evalStatus, key, baseCd, atIso) {
  const next = String(baseCd || "");
  if (!next) return false;
  evalStatus[key] = { baseCd: next, detailAt: atIso || new Date().toISOString() };
  return true;
}

// "01:00" 같은 HH:MM 종료 시각과 시작 ISO로 지속시간(ms)을 추정한다.
// 시작 시각 문자열에 포함된 타임존 오프셋(+09:00)을 그대로 이어받아
// 프로세스 로컬 시간대(Actions 러너는 UTC)에 영향을 받지 않게 한다.
// 자정을 넘기는 세션(23:30 시작, 00:30 종료)도 처리한다.
function durationMs(slotIso, endTime, fallbackMs) {
  const start = new Date(slotIso);
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(endTime || "").trim());
  const isoMatch = /^(\d{4}-\d{2}-\d{2})T.*([+-]\d{2}:\d{2}|Z)$/.exec(String(slotIso || ""));
  if (!timeMatch || !isoMatch || !Number.isFinite(start.getTime())) return fallbackMs;
  const [, datePart, offset] = isoMatch;
  const endIso = `${datePart}T${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}:00${offset === "Z" ? "Z" : offset}`;
  let end = new Date(endIso).getTime();
  if (!Number.isFinite(end)) return fallbackMs;
  if (end < start.getTime()) end += 24 * 3600 * 1000; // 자정 넘김
  return Math.max(60 * 1000, end - start.getTime());
}

// Trigger B (비종결 스윕): 목록 변화 감지가 회복해주지 못하는 평가를 직접 다시 본다.
// 대상: 비종결(IN_PROGRESS/REQUESTED) 이벤트 중
//   - 슬롯 종료 + graceMinutes 경과 (끝났는데 상태가 안 바뀐 것)
//   - REQUESTED 슬롯이 futureHours 이내 시작 (시작/취소 변화를 빠르게 반영)
// 평가 단위(evlNo|evlDegr)로 중복 제거하고, 가장 오래 끝난 것부터 cap개만 반환한다.
function planStaleSweep(events, nowMs = Date.now(), opts = {}) {
  const graceMs = (opts.graceMinutes !== undefined ? opts.graceMinutes : 60) * 60 * 1000;
  const futureMs = (opts.futureHours !== undefined ? opts.futureHours : 48) * 3600 * 1000;
  const cap = opts.cap !== undefined ? opts.cap : 20;
  const slotDurMs = (opts.slotMinutes !== undefined ? opts.slotMinutes : 40) * 60 * 1000;

  const byKey = new Map();
  for (const ev of events || []) {
    if (!ev || !ACTIVE_STATUSES.has(ev.status)) continue;
    if (!ev.slotDateTime || !ev.evlNo) continue;
    const startMs = new Date(ev.slotDateTime).getTime();
    if (!Number.isFinite(startMs)) continue;
    const durMs = durationMs(ev.slotDateTime, ev.endTime, slotDurMs);
    const endMs = startMs + durMs;

    const isOverdue = endMs + graceMs <= nowMs;
    const isSoonRequested = ev.status === "REQUESTED"
      && startMs - futureMs <= nowMs && nowMs < endMs + graceMs;
    if (!isOverdue && !isSoonRequested) continue;

    const key = evalKey(ev.evlNo, ev.evlDegr);
    const prev = byKey.get(key);
    if (!prev || endMs < prev.oldestEndMs) {
      byKey.set(key, { key, representative: ev, oldestEndMs: endMs });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.oldestEndMs - b.oldestEndMs)
    .slice(0, cap);
}

// 같은 평가에 txn 상세가 있으면 평가자 미상의 summary(목록 잔재 1차 정보)는 제거한다.
// 상세가 한 번도 도착하지 않은 평가의 summary는 그대로 둔다.
function dropRedundantSummaries(events) {
  const keysWithTxn = new Set();
  for (const ev of events || []) {
    if (ev && ev.src === "txn") keysWithTxn.add(evalKey(ev.evlNo, ev.evlDegr));
  }
  let dropped = 0;
  const kept = (events || []).filter((ev) => {
    if (ev && ev.src === "summary" && keysWithTxn.has(evalKey(ev.evlNo, ev.evlDegr))) {
      dropped++;
      return false;
    }
    return true;
  });
  return { kept, dropped };
}

module.exports = {
  ACTIVE_STATUSES,
  evalKey,
  isBaseChanged,
  recordBaseCd,
  durationMs,
  planStaleSweep,
  dropRedundantSummaries
};
