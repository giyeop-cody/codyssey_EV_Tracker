"use strict";

// lib/eval-plan.js 단위 테스트 — 2026-07-19 "완료 평가가 진행중으로 고착" 버그의 회귀 방지.
// 핵심 계약:
//  - Trigger A: 목록(base) 코드 변화만 증분 대상으로 한다 (txn 도메인과 절대 섞지 않는다)
//  - Trigger B: 비종결 이벤트는 슬롯 경과 기준으로 직접 상세 재조회한다 (목록 의존 탈피)
//  - txn 상세가 있는 평가의 summary 잔재는 제거한다

const assert = require("node:assert/strict");
const test = require("node:test");
const plan = require("../lib/eval-plan");

const NOW = Date.parse("2026-07-19T10:00:00+09:00"); // KST 기준 시각 가정

function ev(over = {}) {
  return {
    evalId: "x1", evlNo: "1", evlDegr: "1",
    status: "IN_PROGRESS", slotDateTime: "2026-07-19T08:00:00+09:00",
    endTime: null, src: "txn",
    ...over
  };
}

// ── Trigger A: isBaseChanged ──

test("isBaseChanged: 기록이 없으면(첫 실행) 대상", () => {
  const row = { evlNo: 580013, evlDegr: 1, evlStusCd: "00003" };
  assert.equal(plan.isBaseChanged(row, {}), true);
  assert.equal(plan.isBaseChanged(row, null), true);
});

test("isBaseChanged: base 코드가 같으면  건너뜁니고, 다르면 대상이다", () => {
  const status = { "580013|1": { baseCd: "00002", detailAt: "x" } };
  assert.equal(plan.isBaseChanged({ evlNo: 580013, evlDegr: 1, evlStusCd: "00002" }, status), false);
  assert.equal(plan.isBaseChanged({ evlNo: 580013, evlDegr: 1, evlStusCd: "00003" }, status), true);
});

test("isBaseChanged: 2026-07-19 회귀 — base 완료(00003)가 저장돼 있으면 재조회하지 않는다", () => {
  // 버그 시나리오: txn 도메인 진행중 코드와 base 도메인 완료 코드가 모두 "00003".
  // 옛 Set 방식은 충돌로 영구 스킵했지만, baseCd 추적은 도메인이 하나라 충돌이 없다.
  const status = { "580013|1": { baseCd: "00003", detailAt: "x" } };
  assert.equal(plan.isBaseChanged({ evlNo: 580013, evlDegr: 1, evlStusCd: "00003" }, status), false);
  // 반대로 마지막 확인 시점이 진행(00002)이었고 완료(00003)가 됐으면 반드시 대상
  const stale = { "580013|1": { baseCd: "00002", detailAt: "x" } };
  assert.equal(plan.isBaseChanged({ evlNo: 580013, evlDegr: 1, evlStusCd: "00003" }, stale), true);
});

test("isBaseChanged: 목록 코드가 비어 있으면 변화로 오판하지 않는다", () => {
  const status = { "1|1": { baseCd: "00002", detailAt: "x" } };
  assert.equal(plan.isBaseChanged({ evlNo: 1, evlDegr: 1, evlStusCd: "" }, status), false);
});

test("recordBaseCd: 코드가 있을 때만 기록한다", () => {
  const s = {};
  assert.equal(plan.recordBaseCd(s, "1|1", "00003", "2026-07-19T00:00:00Z"), true);
  assert.deepEqual(s["1|1"].baseCd, "00003");
  assert.equal(plan.recordBaseCd(s, "1|1", ""), false);
  assert.equal(s["1|1"].baseCd, "00003", "빈 코드로 덮어쓰지 않음");
});

// ── durationMs (자정 넘김) ──

test("durationMs: 자정을 넘기는 세션의 지속시간을 잡는다", () => {
  assert.equal(plan.durationMs("2026-07-18T23:30:00+09:00", "00:30", 0), 60 * 60 * 1000);
  assert.equal(plan.durationMs("2026-07-19T00:30:00+09:00", "01:00", 0), 30 * 60 * 1000);
  assert.equal(plan.durationMs("2026-07-19T00:30:00+09:00", "잘못된값", 1234), 1234);
});

// ── Trigger B: planStaleSweep ──

test("planStaleSweep: 슬롯 종료 + 1시간 지난 진행중만 대상", () => {
  const events = [
    ev({ evlNo: "a", slotDateTime: "2026-07-19T08:00:00+09:00" }), // 종료 ~08:40 → 1h 경과 → 대상
    ev({ evlNo: "b", slotDateTime: "2026-07-19T09:30:00+09:00" }), // 종료 ~10:10 → 제외
    ev({ evlNo: "c", status: "COMPLETED", slotDateTime: "2026-07-19T07:00:00+09:00" }), // 종결 제외
    ev({ evlNo: "d", slotDateTime: null })
  ];
  const sweep = plan.planStaleSweep(events, NOW);
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].key, "a|1");
});

test("planStaleSweep: endTime(HH:MM)이 있으면 그 시각 기준으로 판정 (자정 넘김 포함)", () => {
  const events = [ev({ evlNo: "a", slotDateTime: "2026-07-18T23:30:00+09:00", endTime: "00:30" })];
  // 종료 2026-07-19 00:30 + 1시간 → 훨씬 경과 → 대상
  assert.equal(plan.planStaleSweep(events, NOW).length, 1);
  // 같은 슬롯인데 now가 00:45면 종료 00:30+grace 1h = 01:30 이전 → 제외
  const early = Date.parse("2026-07-19T00:45:00+09:00");
  assert.equal(plan.planStaleSweep(events, early).length, 0);
});

test("planStaleSweep: 48h 이내 시작하는 REQUESTED는 대상, 그 이후는 제외", () => {
  const events = [
    ev({ evlNo: "a", status: "REQUESTED", slotDateTime: "2026-07-20T10:00:00+09:00" }), // 24h 뒤 → 대상
    ev({ evlNo: "b", status: "REQUESTED", slotDateTime: "2026-07-25T10:00:00+09:00" })  // 6일 뒤 → 제외
  ];
  const sweep = plan.planStaleSweep(events, NOW);
  assert.deepEqual(sweep.map((i) => i.key), ["a|1"]);
});

test("planStaleSweep: 같은 평가는 한 번만, 오래 끝난 순 + cap", () => {
  const events = [
    ev({ evlNo: "a", evalId: "1", slotDateTime: "2026-07-19T08:00:00+09:00" }),
    ev({ evlNo: "a", evalId: "2", slotDateTime: "2026-07-19T06:30:00+09:00" }), // 같은 평가, 더 일찍 끝남
    ev({ evlNo: "b", slotDateTime: "2026-07-19T05:40:00+09:00" })               // 가장 오래됨
  ];
  const sweep = plan.planStaleSweep(events, NOW);
  assert.equal(sweep.length, 2);
  assert.deepEqual(sweep.map((i) => i.key), ["b|1", "a|1"], "오래된 종료 순");
  assert.equal(sweep[1].representative.evalId, "2", "평가 단위당 대표는 가장 오래된 이벤트");
  assert.equal(plan.planStaleSweep(events, NOW, { cap: 1 }).length, 1);
});

test("planStaleSweep: 비종결 슬롯이 없으면 빈 배열(추가 호출 0)", () => {
  assert.equal(plan.planStaleSweep(null, NOW).length, 0);
  assert.equal(plan.planStaleSweep([], NOW).length, 0);
});

// ── dropRedundantSummaries ──

test("dropRedundantSummaries: txn 상세가 있는 평가의 summary 잔재만 제거", () => {
  const events = [
    { evalId: "s1-1", evlNo: "1", evlDegr: "1", src: "summary" },
    { evalId: "7001", evlNo: "1", evlDegr: "1", src: "txn" },
    { evalId: "s2-1", evlNo: "2", evlDegr: "1", src: "summary" }, // 상세 미도착 → 유지
    { evalId: "s3-1", evlNo: "3", evlDegr: "1", src: "summary" }
  ];
  const out = plan.dropRedundantSummaries(events);
  assert.equal(out.dropped, 1);
  assert.deepEqual(out.kept.map((e) => e.evalId), ["7001", "s2-1", "s3-1"]);
});
