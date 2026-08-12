"use strict";

// EV github-sync 단위 테스트 (fetchImpl 주입 — 네트워크 없음)
// Jail dashboard/test/github-sync.test.js의 extras 케이스를 이식 + 기본 경로 포함.

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGitHubSyncService, resolveGitHubConfig } = require("../lib/github-sync.js");

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body || {}) };
}
function logger() {
  const sink = { log() {}, warn() {}, error() {} };
  return sink;
}

test("resolveGitHubConfig: GH_SYNC_EXTRA_REPOS 콤마 파싱 + 형식 필터", () => {
  const config = resolveGitHubConfig({
    GH_PAT_SYNC: "pat",
    GITHUB_REPOSITORY: "owner/repo",
    GH_SYNC_EXTRA_REPOS: "owner/roster_hub, bad-format, owner/x ",
  });
  assert.deepEqual(config.extraRepositories, ["owner/roster_hub", "owner/x"]);
  assert.equal(config.repository, "owner/repo");
  assert.equal(config.tokenSource, "GH_PAT_SYNC");
});

test("본 레포 세션 저장 + dispatch 성공", async () => {
  const calls = [];
  const responses = [
    response(200, { key: "pk-main", key_id: "k1" }),
    response(204),
    response(204),
  ];
  const service = createGitHubSyncService({
    env: { GH_PAT_SYNC: "pat", GITHUB_REPOSITORY: "owner/repo" },
    fetchImpl: async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); },
    encryptSecret: async (value, key) => `sealed:${key}`,
    logger: logger(),
  });

  const result = await service.syncSession("session-id");
  assert.equal(result.success, true);
  assert.equal(result.workflowTriggered, true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /repos\/owner\/repo\/actions\/secrets\/public-key$/);
  assert.equal(JSON.parse(calls[1].options.body).encrypted_value, "sealed:pk-main");
  assert.match(calls[2].url, /repos\/owner\/repo\/actions\/workflows\/collect\.yml\/dispatches$/);
});

test("GH_SYNC_EXTRA_REPOS 지정 시 본 레포 성공 후 추가 레포에도 세션 저장+dispatch한다", async () => {
  const calls = [];
  const responses = [
    response(200, { key: "pk-main", key_id: "k1" }), // 본 레포 secret
    response(204),
    response(204),                                   // 본 레포 dispatch
    response(200, { key: "pk-hub", key_id: "k2" }),  // 허브 secret
    response(204),
    response(204),                                   // 허브 dispatch
  ];
  const service = createGitHubSyncService({
    env: {
      GH_PAT_SYNC: "pat",
      GITHUB_REPOSITORY: "owner/repo",
      GH_SYNC_EXTRA_REPOS: "owner/roster_hub, bad-format",
    },
    fetchImpl: async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); },
    encryptSecret: async (value, key) => `sealed:${key}`,
    logger: logger(),
  });

  const result = await service.syncSession("session-id");
  assert.equal(result.success, true);
  assert.equal(calls.length, 6);
  assert.match(calls[3].url, /repos\/owner\/roster_hub\/actions\/secrets\/public-key$/);
  assert.deepEqual(JSON.parse(calls[4].options.body), { encrypted_value: "sealed:pk-hub", key_id: "k2" });
  assert.match(calls[5].url, /repos\/owner\/roster_hub\/actions\/workflows\/collect\.yml\/dispatches$/);
  assert.deepEqual(result.extraSyncs, [
    { repo: "owner/roster_hub", secretUploaded: true, dispatched: true, error: null },
  ]);
});

test("추가 레포 동기화 실패는 경고로만 남기고 본 레포 결과는 그대로 성공이다", async () => {
  const responses = [
    response(200, { key: "pk-main", key_id: "k1" }),
    response(204),
    response(204),
    response(403, { message: "Resource not accessible" }), // 허브 공개키 거부
  ];
  const service = createGitHubSyncService({
    env: { GH_PAT_SYNC: "pat", GITHUB_REPOSITORY: "owner/repo", GH_SYNC_EXTRA_REPOS: "owner/roster_hub" },
    fetchImpl: async () => responses.shift(),
    encryptSecret: async () => "sealed",
    logger: logger(),
  });

  const result = await service.syncSession("session-id");
  assert.equal(result.success, true);
  assert.equal(result.workflowTriggered, true);
  assert.deepEqual(result.extraSyncs, [
    { repo: "owner/roster_hub", secretUploaded: false, dispatched: false, error: "공개키 조회 실패: 403 Resource not accessible" },
  ]);
});
