"use strict";

/**
 * Codespace 세션-싱크 서버
 *
 * 루프:
 *   1) 브라우저 로그인 폼에서 Codyssey ID/PW 입력 (또는 JSESSIONID 직접 입력)
 *   2) 서버가 Codyssey 인증 서버로만 전달해 JSESSIONID 확보 (비밀번호 미저장)
 *   3) JSESSIONID를 저장소 Actions Secret CODYSSEY_SESSION으로 등록/갱신
 *   4) 시크릿 등록/갱신 직후 Collect 워크플로를 workflow_dispatch로 즉시 실행
 *   5) 이후 Actions가 30분 cron으로 반복 수집
 *
 * 실행: npm start (Codespace devcontainer가 postStartCommand로 자동 실행)
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { createGitHubSyncService } = require("./lib/github-sync");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://api.usr.codyssey.kr/";
const AUTH_URL = "https://api.ams.codyssey.kr/authenticate";
const COOKIE_FILE = process.env.SESSION_FILE || path.join(__dirname, ".session-cookies.json");

const githubSync = createGitHubSyncService({ env: process.env });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.redirect("/login.html"));

/* ---------------- 세션 저장소 (간이 쿠키 저장소: 이름→값) ---------------- */
const session = { cookies: {}, userId: null, loggedInAt: null };

function loadSessionFromDisk() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
    if (raw && raw.cookies && raw.cookies.JSESSIONID) {
      session.cookies = raw.cookies;
      session.userId = raw.userId || null;
      session.loggedInAt = raw.loggedInAt || null;
      return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function saveSessionToDisk() {
  try {
    fs.writeFileSync(COOKIE_FILE, JSON.stringify({
      cookies: session.cookies,
      userId: session.userId,
      loggedInAt: session.loggedInAt,
    }, null, 2));
  } catch (_) { /* read-only 환경 무시 */ }
}

function cookieHeader() {
  return Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function applySetCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  let touched = false;
  for (const sc of list) {
    const first = sc.split(";")[0];
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const name = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (value === "" || /^deleted$/i.test(value)) delete session.cookies[name];
    else session.cookies[name] = value;
    if (name === "JSESSIONID") touched = true;
  }
  if (touched) saveSessionToDisk();
}

/* ---------------- Codyssey 호출 ---------------- */
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
  "X-Requested-With": "XMLHttpRequest",
};

async function codysseyPost(endpoint, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") body.append(k, String(v));
  }
  const res = await fetch(API_BASE + endpoint, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(),
    },
    body: body.toString(),
  });
  applySetCookies(res);
  if (res.status === 401 || res.status === 403) return { __unauthenticated: true };
  const json = await res.json().catch(() => null);
  return json || { __invalid: true };
}

// 세션 유효성 프로브: 레퍼런스(codyssey_Jail_Tracker)가 실환경 검증한 길드 조회 API 사용
// (GET /guild/3/detail — 인증 필요 + 응답 가벼움 + code===200 확인 가능)
async function validateSession() {
  if (!session.cookies.JSESSIONID) return false;
  try {
    const res = await fetch(`${API_BASE}guild/3/detail?guildSeasonId=5&weekNo=9`, {
      headers: { ...COMMON_HEADERS, Cookie: cookieHeader() },
    });
    applySetCookies(res);
    if (res.status === 401 || res.status === 403) return false;
    const json = await res.json().catch(() => null);
    return !!(json && json.code === 200 && json.result);
  } catch (_) {
    return false;
  }
}

async function doLogin(userId, password) {
  const body = new URLSearchParams({ userId, password });
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://ams.codyssey.kr",
      Referer: "https://ams.codyssey.kr/",
    },
    body: body.toString(),
    redirect: "manual",
  });
  applySetCookies(res);

  let success = !!session.cookies.JSESSIONID;
  if (!success && res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location") || "";
    if (loc.includes("/main") || loc.includes("usr.codyssey.kr")) success = true;
  }
  if (!success) {
    const text = await res.text().catch(() => "");
    try {
      const j = JSON.parse(text);
      if (j.success || j.code === 200) success = true;
    } catch (_) { /* ignore */ }
  }

  if (success && session.cookies.JSESSIONID) {
    session.userId = userId;
    session.loggedInAt = new Date().toISOString();
    saveSessionToDisk();
    return true;
  }
  return false;
}

/* ---------------- API 라우트 ---------------- */
app.get("/api/status", async (req, res) => {
  const valid = session.cookies.JSESSIONID ? await validateSession() : false;
  res.json({
    loggedIn: !!session.cookies.JSESSIONID,
    valid,
    userId: session.userId,
    loggedInAt: session.loggedInAt,
    github: githubSync.getStatus(),
  });
});

// ID/PW 로그인 → 세션 확보 → Secret 동기화 → 워크플로 실행
app.post("/api/login", async (req, res) => {
  const { userId, password } = req.body || {};
  if (!userId || !password) {
    return res.status(400).json({ success: false, error: "userId/password 필요" });
  }
  try {
    const ok = await doLogin(String(userId), String(password));
    if (!ok) return res.status(401).json({ success: false, error: "Codyssey 로그인 실패" });
    const sync = await githubSync.syncSession(session.cookies.JSESSIONID);
    res.json({ success: true, userId: session.userId, github: sync });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// JSESSIONID 직접 입력 (DevTools에서 복사한 값)
app.post("/api/session-id", async (req, res) => {
  const { jsessionid } = req.body || {};
  if (!jsessionid || !/^[A-Za-z0-9._~-]+$/.test(String(jsessionid))) {
    return res.status(400).json({ success: false, error: "JSESSIONID 형식이 올바르지 않습니다" });
  }
  session.cookies.JSESSIONID = String(jsessionid);
  session.userId = "(직접 입력)";
  session.loggedInAt = new Date().toISOString();
  saveSessionToDisk();

  const valid = await validateSession();
  if (!valid) {
    delete session.cookies.JSESSIONID;
    return res.status(401).json({ success: false, error: "입력한 세션이 유효하지 않거나 만료됐습니다" });
  }
  const sync = await githubSync.syncSession(session.cookies.JSESSIONID);
  res.json({ success: true, valid, github: sync });
});

// 기존 세션으로 Secret 재동기화 + 워크플로 재실행
app.post("/api/resync", async (req, res) => {
  if (!session.cookies.JSESSIONID) {
    return res.status(400).json({ success: false, error: "저장된 세션이 없습니다" });
  }
  const valid = await validateSession();
  if (!valid) return res.status(401).json({ success: false, error: "세션 만료. 다시 로그인하세요." });
  const sync = await githubSync.syncSession(session.cookies.JSESSIONID);
  res.json({ success: true, github: sync });
});

app.post("/api/logout", (req, res) => {
  session.cookies = {};
  session.userId = null;
  session.loggedInAt = null;
  try { if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE); } catch (_) {}
  res.json({ success: true });
});

app.listen(PORT, () => {
  loadSessionFromDisk();
  const gh = githubSync.getStatus();
  console.log(`▶ 세션-싱크 서버 실행: http://localhost:${PORT}`);
  console.log(`▶ GitHub 동기화: repo=${gh.repository || "(미확인)"} token=${gh.tokenSource}`);
});
