"use strict";

// codyssey_Jail_Tracker dashboard/lib/github-sync.js와 동일 구현 (extras 다중 레포 지원).
// 차이점 2개: fetchImpl 기본값(호스트 fetch) 허용, dispatch 로그 문구 중립화.

const sodium = require("libsodium-wrappers");

const DEFAULT_WORKFLOW = "collect.yml";
const DEFAULT_REF = "main";

function resolveGitHubConfig(env = process.env) {
  const isCodespaces = env.CODESPACES === "true";
  const tokenSource = env.GH_PAT_SYNC
    ? "GH_PAT_SYNC"
    : (!isCodespaces && env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "none");
  const token = tokenSource === "GH_PAT_SYNC"
    ? env.GH_PAT_SYNC
    : (tokenSource === "GITHUB_TOKEN" ? env.GITHUB_TOKEN : "");

  return {
    isCodespaces,
    tokenSource,
    token,
    repository: env.GITHUB_REPOSITORY || "",
    // 본 레포 외 세션 동기화 대상 (예: 공유 로스터 허브). "owner/repo"를 콤마로 나열.
    extraRepositories: String(env.GH_SYNC_EXTRA_REPOS || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^[^/]+\/[^/]+$/.test(item)),
  };
}

async function sealSecret(value, publicKey) {
  await sodium.ready;
  const binaryKey = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const binarySecret = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(binarySecret, binaryKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function githubApiError(response) {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    const data = JSON.parse(text);
    return `${response.status} ${data.message || text}`;
  } catch (err) {
    return `${response.status} ${text}`;
  }
}

function createGitHubSyncService({
  fetchImpl = globalThis.fetch,
  env = process.env,
  encryptSecret = sealSecret,
  logger = console,
  workflow = DEFAULT_WORKFLOW,
  ref = DEFAULT_REF,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  const config = resolveGitHubConfig(env);
  const state = {
    enabled: false,
    configured: false,
    tokenSource: config.tokenSource,
    lastSync: null,
    lastWorkflowDispatch: null,
    workflowTriggered: false,
    extraSyncs: [],
    lastError: null,
  };

  function getStatus() {
    return {
      ...state,
      configured: state.configured || !!(config.token && config.repository),
      repository: config.repository,
      extraRepositories: config.extraRepositories,
    };
  }

  function fail(message) {
    state.enabled = false;
    state.lastError = message;
    logger.error("[github-sync] ❌", message);
    return { success: false, error: message, ...getStatus() };
  }

  async function syncSession(sessionId) {
    state.workflowTriggered = false;

    if (!sessionId) return fail("No JSESSIONID to sync");
    if (!config.token || !config.repository) {
      state.configured = false;
      const message = !config.token && config.isCodespaces
        ? "Codespaces Secret GH_PAT_SYNC가 현재 컨테이너에 주입되지 않았습니다. Codespace를 Stop 후 Start하거나 컨테이너를 Rebuild하세요."
        : "GH_PAT_SYNC/GITHUB_TOKEN 또는 GITHUB_REPOSITORY가 설정되지 않았습니다.";
      return fail(message);
    }

    state.configured = true;
    let secretUploaded = false;

    try {
      const repoApi = `https://api.github.com/repos/${config.repository}`;
      const secretApi = `${repoApi}/actions/secrets`;
      const headers = {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "secom-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
      };

      const keyResponse = await fetchImpl(`${secretApi}/public-key`, { headers });
      if (!keyResponse.ok) {
        throw new Error(`Repository Secrets 공개키 조회 실패: ${await githubApiError(keyResponse)}`);
      }
      const keyData = await keyResponse.json();
      const encrypted = await encryptSecret(sessionId, keyData.key);

      const secretResponse = await fetchImpl(`${secretApi}/CODYSSEY_SESSION`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ encrypted_value: encrypted, key_id: keyData.key_id }),
      });
      if (!secretResponse.ok && ![201, 204].includes(secretResponse.status)) {
        throw new Error(`CODYSSEY_SESSION 저장 실패: ${await githubApiError(secretResponse)}`);
      }

      secretUploaded = true;
      state.lastSync = new Date().toISOString();
      logger.log(`[github-sync] ✅ CODYSSEY_SESSION 업로드 완료 (repo: ${config.repository})`);

      const dispatchResponse = await fetchImpl(`${repoApi}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      if (dispatchResponse.status !== 204) {
        throw new Error(`Collect workflow 실행 요청 실패: ${await githubApiError(dispatchResponse)}. PAT의 Actions: Read and write 권한을 확인하세요.`);
      }

      state.lastWorkflowDispatch = new Date().toISOString();
      state.workflowTriggered = true;
      state.enabled = true;
      state.lastError = null;
      logger.log(`[github-sync] ✅ ${workflow} dispatch 요청 완료`);

      // 추가 대상 레포(공유 로스터 허브 등) 동기화 — 본 레포 갱신을 막지 않도록 실패는 경고로만 남긴다.
      state.extraSyncs = [];
      for (const extra of config.extraRepositories) {
        const entry = { repo: extra, secretUploaded: false, dispatched: false, error: null };
        state.extraSyncs.push(entry);
        try {
          const extraApi = `https://api.github.com/repos/${extra}`;
          const extraSecretApi = `${extraApi}/actions/secrets`;
          const extraKeyResponse = await fetchImpl(`${extraSecretApi}/public-key`, { headers });
          if (!extraKeyResponse.ok) {
            throw new Error(`공개키 조회 실패: ${await githubApiError(extraKeyResponse)}`);
          }
          const extraKeyData = await extraKeyResponse.json();
          const extraEncrypted = await encryptSecret(sessionId, extraKeyData.key);
          const extraSecretResponse = await fetchImpl(`${extraSecretApi}/CODYSSEY_SESSION`, {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ encrypted_value: extraEncrypted, key_id: extraKeyData.key_id }),
          });
          if (!extraSecretResponse.ok && ![201, 204].includes(extraSecretResponse.status)) {
            throw new Error(`CODYSSEY_SESSION 저장 실패: ${await githubApiError(extraSecretResponse)}`);
          }
          entry.secretUploaded = true;

          const extraDispatchResponse = await fetchImpl(`${extraApi}/actions/workflows/${workflow}/dispatches`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ ref }),
          });
          if (extraDispatchResponse.status !== 204) {
            throw new Error(`Collect workflow 실행 요청 실패: ${await githubApiError(extraDispatchResponse)}`);
          }
          entry.dispatched = true;
          logger.log(`[github-sync] ✅ ${extra} 세션 동기화 + 수집 실행 요청 완료`);
        } catch (err) {
          entry.error = err.message || String(err);
          logger.warn(`[github-sync] ⚠️ ${extra} 동기화 실패 (본 레포는 정상 완료): ${entry.error}`);
        }
      }

      return { success: true, error: null, ...getStatus() };
    } catch (err) {
      const message = secretUploaded
        ? `CODYSSEY_SESSION 저장은 완료됐지만 Actions 실행에 실패했습니다: ${err.message}`
        : err.message;
      return fail(message);
    }
  }

  return { config: { ...config, token: config.token ? "[configured]" : "" }, getStatus, syncSession };
}

module.exports = {
  DEFAULT_REF,
  DEFAULT_WORKFLOW,
  createGitHubSyncService,
  githubApiError,
  resolveGitHubConfig,
  sealSecret,
};
