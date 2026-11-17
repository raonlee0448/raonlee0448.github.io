import { CONFIG } from "../config.js";
import { loadSession } from "./auth.js";
import { emptyCatalog, normalizeCatalog, safeFileName } from "./albums.js";

const API = "https://api.github.com";
const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export function isLocalHost() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

export async function detectMode() {
  if (isLocalHost()) {
    try {
      const res = await fetch("/local/health", { cache: "no-store" });
      if (res.ok) return "local";
    } catch {}
  }
  return "github";
}

function authHeaders(token) {
  return { ...HEADERS, Authorization: `Bearer ${token}` };
}

async function api(path, opts = {}) {
  const session = loadSession();
  if (!session?.token) throw new Error("Sign in with GitHub first.");
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...authHeaders(session.token), ...(opts.headers || {}) },
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    const msg = data?.message || `GitHub request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function encodeBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function putWithProgress(url, { headers, body, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.responseType = "text";
    xhr.upload.onprogress = (ev) => {
      if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total);
    };
    xhr.onload = () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = { message: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.send(body);
  });
}

export function pagesUrl(slug, fileName) {
  return `${CONFIG.pagesBase}/${CONFIG.uploadsPrefix}/${encodeURIComponent(slug)}/${encodeURIComponent(fileName)}`;
}

export async function waitUntilLive(url, { timeoutMs = CONFIG.pagesTimeoutMs, intervalMs = CONFIG.pagesPollMs, onStatus } = {}) {
  const started = Date.now();
  // Ground truth: the public Pages URL returns 200. Git commit is not enough.
  while (Date.now() - started < timeoutMs) {
    const elapsed = Date.now() - started;
    if (onStatus) onStatus({ state: "waiting-pages", elapsedMs: elapsed, url });
    try {
      const res = await fetch(url, { method: "HEAD", cache: "no-store", mode: "cors" });
      if (res.status === 200) return { live: true, elapsedMs: elapsed, status: res.status };
    } catch {
      // Keep polling; a temporary network blip is not failure.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { live: false, elapsedMs: Date.now() - started, status: 0 };
}

export async function pagesApiStatus() {
  const session = loadSession();
  if (!session?.token) return null;
  try {
    const data = await api(`/repos/${CONFIG.owner}/${CONFIG.repo}/pages`);
    return data?.status || null;
  } catch {
    return null;
  }
}

export const githubStore = {
  kind: "github",
  label: "GitHub Pages",
  async loadCatalog() {
    const session = loadSession();
    if (!session?.token) return emptyCatalog();
    const path = `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.metadataPath}?ref=${encodeURIComponent(CONFIG.branch)}`;
    try {
      const data = await api(path);
      const json = JSON.parse(atob(data.content.replace(/\n/g, "")));
      const cat = normalizeCatalog(json);
      cat._sha = data.sha;
      return cat;
    } catch (err) {
      if (/not found/i.test(err.message)) return emptyCatalog();
      throw err;
    }
  },
  async saveCatalog(catalog) {
    const session = loadSession();
    if (!session?.token) throw new Error("Sign in with GitHub first.");
    const current = await this.loadCatalog();
    const body = {
      message: "Update image album list",
      content: btoa(unescape(encodeURIComponent(JSON.stringify({
        version: 1,
        selectedAlbumId: catalog.selectedAlbumId,
        albums: catalog.albums,
      }, null, 2)))),
      branch: CONFIG.branch,
    };
    if (current._sha) body.sha = current._sha;
    await api(`/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.metadataPath}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
  async listImages(album) {
    const path = `/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.uploadsPrefix}/${album.slug}?ref=${encodeURIComponent(CONFIG.branch)}`;
    try {
      const data = await api(path);
      const items = Array.isArray(data) ? data : [];
      return items
        .filter((f) => f.type === "file" && f.name !== "albums.json")
        .map((f) => ({
          name: f.name,
          path: f.path,
          url: pagesUrl(album.slug, f.name),
          sha: f.sha,
          size: f.size,
        }));
    } catch (err) {
      if (/not found/i.test(err.message)) return [];
      throw err;
    }
  },
  publicUrl(album, fileName) {
    return pagesUrl(album.slug, fileName);
  },
  async upload(album, file, onProgress) {
    if (file.size > CONFIG.maxBytes) {
      throw new Error(`Each image must be under ${Math.round(CONFIG.maxBytes / 1024 / 1024)} MB.`);
    }
    const session = loadSession();
    if (!session?.token) throw new Error("Sign in with GitHub first.");
    const fileName = safeFileName(file.name);
    const path = `${CONFIG.uploadsPrefix}/${album.slug}/${fileName}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (onProgress) onProgress(0.05);
    const content = encodeBase64(bytes);
    if (onProgress) onProgress(0.15);
    const url = `${API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`;
    const body = JSON.stringify({
      message: `Add ${fileName} to ${album.name}`,
      content,
      branch: CONFIG.branch,
    });
    await putWithProgress(url, {
      headers: { ...authHeaders(session.token), "Content-Type": "application/json" },
      body,
      onProgress: (p) => onProgress && onProgress(0.15 + p * 0.75),
    });
    if (onProgress) onProgress(0.92);
    const urlLive = pagesUrl(album.slug, fileName);
    return { fileName, path, url: urlLive, host: "github" };
  },
  async confirmLive(item, onStatus) {
    const pages = await pagesApiStatus();
    if (onStatus) onStatus({ state: "waiting-pages", pagesStatus: pages, url: item.url, elapsedMs: 0 });
    const result = await waitUntilLive(item.url, {
      onStatus: (s) => onStatus && onStatus({ ...s, pagesStatus: pages }),
    });
    return result;
  },
};

export const localStore = {
  kind: "local",
  label: "Local demo",
  async loadCatalog() {
    const res = await fetch("/local/albums", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not read local albums.");
    return normalizeCatalog(await res.json());
  },
  async saveCatalog(catalog) {
    const res = await fetch("/local/albums", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        selectedAlbumId: catalog.selectedAlbumId,
        albums: catalog.albums,
      }),
    });
    if (!res.ok) throw new Error("Could not save local albums.");
  },
  async listImages(album) {
    const res = await fetch(`/local/albums/${encodeURIComponent(album.id)}/images`, { cache: "no-store" });
    if (!res.ok) throw new Error("Could not list album images.");
    return res.json();
  },
  publicUrl(album, fileName) {
    return `${location.origin}/local/uploads/${encodeURIComponent(album.slug)}/${encodeURIComponent(fileName)}`;
  },
  async upload(album, file, onProgress) {
    if (file.size > CONFIG.maxBytes) {
      throw new Error(`Each image must be under ${Math.round(CONFIG.maxBytes / 1024 / 1024)} MB.`);
    }
    const fileName = safeFileName(file.name);
    const url = `/local/albums/${encodeURIComponent(album.id)}/images?name=${encodeURIComponent(fileName)}`;
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.responseType = "text";
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable) onProgress(ev.loaded / ev.total * 0.9);
      };
      xhr.onload = () => {
        let data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { data = { error: xhr.responseText }; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Network error while uploading."));
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.send(file);
    });
    if (onProgress) onProgress(1);
    return { fileName: result.fileName, path: result.path, url: result.url, host: "local" };
  },
  async confirmLive(item) {
    const res = await fetch(item.url, { method: "HEAD", cache: "no-store" });
    return { live: res.status === 200, elapsedMs: 0, status: res.status };
  },
};
