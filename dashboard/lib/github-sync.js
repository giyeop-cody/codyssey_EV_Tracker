"use strict";

/**
 * GitHub Actions Secret 등록 + workflow dispatch 서비스.
 *
 * 동작 (레퍼런스 codyssey_Jail_Tracker/dashboard/lib/github-sync.js 와 동일 패턴):
 *   1) GET  /repos/{repo}/actions/secrets/public-key
 *   2) libsodium sealed box로 세션값 암호화
 *   3) PUT  /repos/{repo}/actions/secrets/CODYSSEY_SESSION
 *   4) POST /repos/{repo}/actions/workflows/collect.yml/dispatches  (즉시 수집 실행)
 *
 * 토큰 우선순위: GH_PAT_SYNC (Codespaces Secret) > GITHUB_TOKEN.
 * 저장소는 Codespaces가 자동 주입하는 GITHUB_REPOSITORY를 사용한다.
 */

const sodium = require("libsodium-wrappers");

const SECRET_NAME = "CODYSSEY_SESSION";
const DEFAULT_WORKFLOW = "collect.yml";
const DEFAULT_REF = "main";

function resolveGitHubConfig(env = process.env) {
  const isCodespaces = env.CODESPACES === "true";
  const tokenSource = env.GH_PAT_SYNC
    ? "GH_PAT_SYNC"
    : (env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "none");
  const token = tokenSource === "GH_PAT_SYNC"
    ? env.GH_PAT_SYNC
    : (tokenSource === "GITHUB_TOKEN" ? env.GITHUB_TOKEN : "");

  return {
    isCodespaces,
    tokenSource,
    token,
    repository: env.GITHUB_REPOSITORY || "",
    workflow: env.SYNC_WORKFLOW || DEFAULT_WORKFLOW,
    ref: env.SYNC_REF || DEFAULT_REF,
  };
}

async function sealSecret(value, publicKeyB64) {
  await sodium.ready;
  const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const binarySecret = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(binarySecret, publicKey);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

async function apiError(res) {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text);
    return `${res.status} ${j.message || text}`;
  } catch (_) {
    return `${res.status} ${text || "(empty body)"}`;
  }
}

function createGitHubSyncService({ env = process.env, logger = console } = {}) {
  const config = resolveGitHubConfig(env);
  const state = {
    configured: false,
    lastSync: null,
    lastWorkflowDispatch: null,
    workflowTriggered: false,
    lastError: null,
  };

  function getStatus() {
    return {
      ...state,
      configured: state.configured || !!(config.token && config.repository),
      tokenSource: config.tokenSource,
      repository: config.repository,
      workflow: config.workflow,
    };
  }

  function fail(message) {
    state.lastError = message;
    logger.error("[github-sync] ❌", message);
    return { success: false, error: message, ...getStatus() };
  }

  function headers() {
    return {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "codyssey-eval-tracker",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  async function syncSession(sessionId) {
    state.workflowTriggered = false;

    if (!sessionId) return fail("동기화할 JSESSIONID가 없습니다.");
    if (!config.token || !config.repository) {
      state.configured = false;
      const msg = !config.token && config.isCodespaces
        ? "Codespaces Secret GH_PAT_SYNC가 이 컨테이너에 주입되지 않았습니다. 시크릿 등록 후 Codespace를 Rebuild 하세요."
        : "GH_PAT_SYNC/GITHUB_TOKEN 또는 GITHUB_REPOSITORY가 설정되지 않았습니다.";
      return fail(msg);
    }
    state.configured = true;
    let secretUploaded = false;

    try {
      const repoApi = `https://api.github.com/repos/${config.repository}`;

      // 1) 저장소 Actions Secrets 공개키
      const keyRes = await fetch(`${repoApi}/actions/secrets/public-key`, { headers: headers() });
      if (!keyRes.ok) throw new Error(`공개키 조회 실패: ${await apiError(keyRes)} (Secrets 권한 확인)`);
      const keyData = await keyRes.json();

      // 2) 암호화 후 3) 시크릿 PUT (없으면 생성, 있으면 갱신)
      const encrypted = await sealSecret(sessionId, keyData.key);
      const putRes = await fetch(`${repoApi}/actions/secrets/${SECRET_NAME}`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ encrypted_value: encrypted, key_id: keyData.key_id }),
      });
      if (![201, 204].includes(putRes.status)) {
        throw new Error(`${SECRET_NAME} 저장 실패: ${await apiError(putRes)} (Secrets 권한 확인)`);
      }
      secretUploaded = true;
      state.lastSync = new Date().toISOString();
      logger.log(`[github-sync] ✅ ${SECRET_NAME} 업로드 완료 (${config.repository})`);

      // 4) 수집 워크플로 즉시 실행
      const dispatchRes = await fetch(`${repoApi}/actions/workflows/${config.workflow}/dispatches`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ref: config.ref }),
      });
      if (dispatchRes.status !== 204) {
        throw new Error(`workflow dispatch 실패: ${await apiError(dispatchRes)} (Actions 권한 확인)`);
      }
      state.lastWorkflowDispatch = new Date().toISOString();
      state.workflowTriggered = true;
      state.lastError = null;
      logger.log(`[github-sync] ✅ ${config.workflow} dispatch 완료`);
      return { success: true, error: null, ...getStatus() };
    } catch (err) {
      const msg = secretUploaded
        ? `시크릿 저장은 완료됐지만 워크플로 실행에 실패했습니다: ${err.message}`
        : err.message;
      return fail(msg);
    }
  }

  return { getStatus, syncSession, config: { ...config, token: config.token ? "[configured]" : "" } };
}

module.exports = { createGitHubSyncService, resolveGitHubConfig, sealSecret, SECRET_NAME };
