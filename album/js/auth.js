import { CONFIG } from "../config.js";

const SESSION_KEY = "raonlee-images-session-v1";

function redact(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 8) return "[redacted]";
  return s.slice(0, 4) + "…" + s.slice(-2);
}

export function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.token || !s?.login) return null;
    if (s.expiresAt && Date.now() > Number(s.expiresAt) - 15000) return null;
    return s;
  } catch {
    return null;
  }
}

export function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function githubReady() {
  return Boolean(CONFIG.clientId && CONFIG.authProxyUrl);
}

export async function loadRemoteConfig() {
  if (!CONFIG.authProxyUrl) return { ready: false };
  try {
    const res = await fetch(proxyUrl("/setup/status"), { headers: { Accept: "application/json" } });
    if (!res.ok) return { ready: false };
    const data = await res.json();
    if (data.client_id) CONFIG.clientId = data.client_id;
    return { ready: Boolean(data.ready && CONFIG.clientId), clientId: data.client_id || "", appSlug: data.app_slug || "" };
  } catch {
    return { ready: false };
  }
}

function oauthRedirect() {
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.pathname = "/";
    return url.toString();
  }
  return CONFIG.oauthRedirect || "https://raonlee0448.github.io/album/";
}

export function proxyUrl(path) {
  const base = String(CONFIG.authProxyUrl || "").replace(/\/+$/, "");
  return base + path;
}

async function proxyPost(path, body) {
  if (!CONFIG.authProxyUrl) {
    throw new Error("The sign-in helper is not set up yet.");
  }
  const res = await fetch(proxyUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.error) {
    const msg = data.error_description || data.error || `Sign-in failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export async function fetchUser(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error("Could not read the GitHub account for this sign-in.");
  return res.json();
}

function assertAllowed(user) {
  const login = String(user?.login || "");
  if (login.toLowerCase() !== String(CONFIG.allowedUser).toLowerCase()) {
    throw new Error(`This uploader only signs in as ${CONFIG.allowedUser}. You signed in as ${login || "unknown"}.`);
  }
}

async function storeFromToken(token, extras = {}) {
  const user = await fetchUser(token);
  assertAllowed(user);
  const session = {
    token,
    login: user.login,
    expiresAt: extras.expires_in ? Date.now() + Number(extras.expires_in) * 1000 : null,
    // refresh token stays in sessionStorage only, never in the repo or logs
    refreshToken: extras.refresh_token || null,
  };
  saveSession(session);
  return session;
}

export function startWebLogin() {
  if (!githubReady()) throw new Error("GitHub sign-in is not configured yet.");
  const state = crypto.randomUUID();
  sessionStorage.setItem("raonlee-images-oauth-state", state);
  const redirect = oauthRedirect();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", CONFIG.clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "offline_access");
  location.assign(url.toString());
}

export async function completeWebLogin(params) {
  const expected = sessionStorage.getItem("raonlee-images-oauth-state");
  sessionStorage.removeItem("raonlee-images-oauth-state");
  if (!params.state || params.state !== expected) {
    throw new Error("Sign-in was interrupted. Please try again.");
  }
  const data = await proxyPost("/login/oauth/access_token", {
    client_id: CONFIG.clientId,
    code: params.code,
    redirect_uri: oauthRedirect(),
    grant_type: "authorization_code",
  });
  if (!data.access_token) throw new Error("GitHub did not return a sign-in token.");
  return storeFromToken(data.access_token, data);
}

export async function startDeviceLogin() {
  if (!githubReady()) throw new Error("GitHub sign-in is not configured yet.");
  const data = await proxyPost("/login/device/code", {
    client_id: CONFIG.clientId,
    scope: "offline_access",
  });
  if (!data.device_code || !data.user_code) {
    throw new Error("GitHub did not start device sign-in.");
  }
  return data;
}

export async function pollDeviceLogin(device, onTick) {
  const started = Date.now();
  const interval = Math.max(5, Number(device.interval) || 5) * 1000;
  const expires = (Number(device.expires_in) || 900) * 1000;
  while (Date.now() - started < expires) {
    await sleep(interval);
    if (onTick) onTick();
    let data;
    try {
      data = await proxyPost("/login/oauth/access_token", {
        client_id: CONFIG.clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch (err) {
      const msg = String(err.message || "");
      if (/authorization_pending|slow_down/i.test(msg)) continue;
      throw err;
    }
    if (data.access_token) return storeFromToken(data.access_token, data);
    if (data.error === "authorization_pending" || data.error === "slow_down") continue;
    if (data.error) throw new Error(data.error_description || data.error);
  }
  throw new Error("The sign-in code expired. Start again.");
}

export function signOut() {
  clearSession();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Keep unused helper referenced so a future debug path does not print tokens by habit.
void redact;
