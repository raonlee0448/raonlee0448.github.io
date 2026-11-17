import { CONFIG } from "../config.js";
import { createAlbum, renameAlbum, upsertAlbum, selectAlbum, isImageFile } from "./albums.js";
import {
  loadSession, clearSession, githubReady, loadRemoteConfig, startWebLogin, completeWebLogin,
  startDeviceLogin, pollDeviceLogin, signOut,
} from "./auth.js";
import { detectMode, githubStore, localStore } from "./storage.js";

const UI_KEY = "raonlee-images-ui-v1";

const state = {
  mode: "github",
  store: githubStore,
  session: null,
  catalog: { version: 1, selectedAlbumId: null, albums: [] },
  images: [],
  pending: [],
  collapsed: {},
  busy: false,
  error: "",
  device: null,
};

function loadUi() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    state.collapsed = raw.collapsed && typeof raw.collapsed === "object" ? raw.collapsed : {};
  } catch { state.collapsed = {}; }
}

function saveUi() {
  localStorage.setItem(UI_KEY, JSON.stringify({ collapsed: state.collapsed }));
}

function $(sel) { return document.querySelector(sel); }
function el(id) { return document.getElementById(id); }

function selectedAlbum() {
  return state.catalog.albums.find((a) => a.id === state.catalog.selectedAlbumId) || null;
}

function isCollapsed(id) {
  return Boolean(state.collapsed[id]);
}

function toast(msg, kind = "info") {
  const box = el("toast");
  box.textContent = msg;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.hidden = true; }, 4000);
}

function setError(msg) {
  state.error = msg || "";
  const box = el("banner-error");
  if (!state.error) { box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = state.error;
}

async function refreshImages() {
  const album = selectedAlbum();
  if (!album) { state.images = []; return; }
  state.images = await state.store.listImages(album);
}

function render() {
  const album = selectedAlbum();
  const local = state.mode === "local";
  el("mode-pill").textContent = local ? "Local demo" : (state.session ? `Signed in as ${state.session.login}` : "GitHub (not signed in)");
  el("mode-pill").dataset.mode = local ? "local" : (state.session ? "in" : "out");
  el("auth-actions").innerHTML = local
    ? `<span class="muted">This demo stays on this computer. Live GitHub links need the one-time setup.</span>`
    : (state.session
      ? `<button class="btn ghost" type="button" id="btn-signout">Sign out</button>`
      : `<button class="btn" type="button" id="btn-signin" ${githubReady() ? "" : "disabled"}>${CONFIG.authMode === "device" ? "Sign in with a GitHub code" : "Sign in with GitHub"}</button>
         ${githubReady() ? "" : `<a class="btn ghost" href="setup/index.html">Set up sign-in</a>`}`);

  el("banner-local").hidden = !local;
  el("banner-setup").hidden = local || githubReady() || Boolean(state.session);
  el("github-blocked").hidden = local || Boolean(state.session);

  const list = el("album-list");
  if (!state.catalog.albums.length) {
    list.innerHTML = `<p class="empty-albums">No albums yet. Name one to start tracking a set of images.</p>`;
  } else {
    list.innerHTML = state.catalog.albums.map((a) => `
      <button type="button" class="album-chip ${a.id === state.catalog.selectedAlbumId ? "is-selected" : ""}" data-album="${a.id}">
        <span class="album-name">${escapeHtml(a.name)}</span>
        <span class="album-slug">/${escapeHtml(a.slug)}</span>
      </button>
    `).join("");
  }

  const hasAlbum = Boolean(album);
  el("album-stage").hidden = !hasAlbum;
  el("empty-stage").hidden = hasAlbum;
  if (album) {
    el("album-title").textContent = album.name;
    el("album-slug-line").textContent = `Folder: uploads/${album.slug}/  ·  Display name stays “${album.name}”`;
    const collapsed = isCollapsed(album.id);
    el("btn-collapse").textContent = collapsed ? "Show album" : "Hide album";
    el("btn-collapse").setAttribute("aria-expanded", String(!collapsed));
    el("album-body").hidden = collapsed;
    const canUpload = local || Boolean(state.session);
    el("dropzone").classList.toggle("is-disabled", !canUpload);
    el("file-input").disabled = !canUpload;
    el("drop-hint").textContent = canUpload
      ? "New images go into this album."
      : "Sign in to upload into this album.";
  }

  renderGrid();
}

function renderGrid() {
  const grid = el("grid");
  const combined = [...state.pending, ...state.images.filter((img) => !state.pending.some((p) => p.url === img.url || p.fileName === img.name))];
  if (!combined.length) {
    grid.innerHTML = `<p class="empty-grid">Nothing in this album yet. Add images when you are ready.</p>`;
    return;
  }
  grid.innerHTML = combined.map(cardHtml).join("");
}

function cardHtml(item) {
  const status = item.status || (item.live === false ? "waiting-pages" : "live");
  const canCopy = status === "live" && item.url;
  const pct = Math.round((item.progress || 0) * 100);
  const thumb = item.thumb || item.url || "";
  const label = statusLabel(item, status, pct);
  return `
    <article class="card status-${status}" data-id="${escapeHtml(item.localId || item.name || item.fileName)}">
      <div class="thumb">${thumb ? `<img src="${escapeHtml(thumb)}" alt="">` : `<div class="thumb-ph"></div>`}</div>
      <div class="card-body">
        <div class="file-name">${escapeHtml(item.fileName || item.name || "image")}</div>
        <div class="status-line">${escapeHtml(label)}</div>
        ${status === "uploading" || status === "encoding" ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ""}
        <button type="button" class="btn slim copy" data-copy="${escapeHtml(item.url || "")}" ${canCopy ? "" : "disabled"}>
          ${canCopy ? "Copy direct link" : "Link waits until it is live"}
        </button>
      </div>
    </article>
  `;
}

function statusLabel(item, status, pct) {
  if (status === "encoding") return "Preparing…";
  if (status === "uploading") return `Uploading ${pct}%`;
  if (status === "committed") return "Saved. Waiting for the public link…";
  if (status === "waiting-pages") {
    const sec = Math.round((item.elapsedMs || 0) / 1000);
    const pages = item.pagesStatus ? ` GitHub Pages: ${item.pagesStatus}.` : "";
    return `Waiting for the site to publish${sec ? ` (${sec}s)` : ""}…${pages}`;
  }
  if (status === "live") return item.host === "local" ? "Live on this computer (not GitHub Pages)" : "Live on your site";
  if (status === "failed") return item.error || "Upload failed";
  if (status === "timeout") return "Still not on the public site. The file is saved; try Refresh in a minute.";
  return status;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function persistCatalog() {
  await state.store.saveCatalog(state.catalog);
}

async function onCreateAlbum(ev) {
  ev.preventDefault();
  const input = el("new-album-name");
  try {
    const album = createAlbum(input.value, state.catalog.albums);
    state.catalog = upsertAlbum(state.catalog, album, true);
    await persistCatalog();
    input.value = "";
    await refreshImages();
    setError("");
    render();
    toast(`Album “${album.name}” is ready. Uploads will go here.`);
  } catch (err) {
    setError(err.message);
  }
}

async function onSelectAlbum(id) {
  try {
    state.catalog = selectAlbum(state.catalog, id);
    await persistCatalog();
    await refreshImages();
    setError("");
    render();
  } catch (err) {
    setError(err.message);
  }
}

async function onRename() {
  const album = selectedAlbum();
  if (!album) return;
  const next = prompt("Rename this album. The folder and existing links stay the same.", album.name);
  if (next == null) return;
  try {
    const renamed = renameAlbum(album, next);
    state.catalog = upsertAlbum(state.catalog, renamed, true);
    await persistCatalog();
    render();
  } catch (err) {
    setError(err.message);
  }
}

function toggleCollapse() {
  const album = selectedAlbum();
  if (!album) return;
  state.collapsed[album.id] = !isCollapsed(album.id);
  saveUi();
  render();
}

function addFiles(fileList) {
  const album = selectedAlbum();
  if (!album) {
    setError("Create or select an album first. Uploads always go into the album you have selected.");
    return;
  }
  if (state.mode === "github" && !state.session) {
    setError("Sign in with GitHub before uploading to your site.");
    return;
  }
  const files = [...fileList].filter(isImageFile);
  if (!files.length) {
    setError("Choose image files only.");
    return;
  }
  setError("");
  for (const file of files) {
    const localId = "p_" + crypto.randomUUID();
    const thumb = URL.createObjectURL(file);
    state.pending.unshift({
      localId,
      fileName: file.name,
      thumb,
      status: "encoding",
      progress: 0,
      url: "",
      file,
    });
  }
  render();
  pumpUploads();
}

async function pumpUploads() {
  const album = selectedAlbum();
  if (!album || state.busy) return;
  const next = state.pending.find((p) => p.status === "encoding" && p.file);
  if (!next) return;
  state.busy = true;
  next.status = "uploading";
  render();
  try {
    const saved = await state.store.upload(album, next.file, (p) => {
      next.progress = p;
      next.status = "uploading";
      const bar = document.querySelector(`[data-id="${next.localId}"] .bar span`);
      const line = document.querySelector(`[data-id="${next.localId}"] .status-line`);
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      if (line) line.textContent = statusLabel(next, "uploading", Math.round(p * 100));
    });
    next.fileName = saved.fileName;
    next.url = saved.url;
    next.host = saved.host;
    next.status = "committed";
    next.progress = 1;
    next.file = null;
    render();
    const live = await state.store.confirmLive(next, (s) => {
      next.status = "waiting-pages";
      next.elapsedMs = s.elapsedMs;
      next.pagesStatus = s.pagesStatus;
      const line = document.querySelector(`[data-id="${next.localId}"] .status-line`);
      if (line) line.textContent = statusLabel(next, "waiting-pages", 100);
    });
    if (live.live) {
      next.status = "live";
      next.live = true;
    } else {
      next.status = "timeout";
      next.live = false;
    }
  } catch (err) {
    next.status = "failed";
    next.error = err.message;
  }
  render();
  state.busy = false;
  pumpUploads();
}

async function onSignIn() {
  try {
    setError("");
    if (CONFIG.authMode === "device") {
      const device = await startDeviceLogin();
      state.device = device;
      el("device-panel").hidden = false;
      el("device-code").textContent = device.user_code;
      el("device-link").href = device.verification_uri || "https://github.com/login/device";
      el("device-link").textContent = device.verification_uri || "https://github.com/login/device";
      state.session = await pollDeviceLogin(device);
      state.device = null;
      el("device-panel").hidden = true;
    } else {
      startWebLogin();
      return;
    }
    await afterSignIn();
  } catch (err) {
    setError(err.message);
  }
}

async function afterSignIn() {
  state.catalog = await state.store.loadCatalog();
  await refreshImages();
  render();
  toast("Signed in. Your albums can sync across devices once they are saved.");
}

async function init() {
  loadUi();
  state.mode = await detectMode();
  state.store = state.mode === "local" ? localStore : githubStore;
  if (state.mode === "github") {
    try { await loadRemoteConfig(); }
    catch { /* setup status is optional until the app exists */ }
  }
  state.session = loadSession();

  const params = new URLSearchParams(location.search);
  if (params.get("code") && params.get("state") && state.mode === "github") {
    try {
      state.session = await completeWebLogin({ code: params.get("code"), state: params.get("state") });
      history.replaceState({}, "", location.pathname);
      await afterSignIn();
    } catch (err) {
      history.replaceState({}, "", location.pathname);
      setError(err.message);
    }
  }

  try {
    if (state.mode === "local" || state.session) {
      state.catalog = await state.store.loadCatalog();
      await refreshImages();
    }
  } catch (err) {
    setError(err.message);
  }
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  el("new-album-form").addEventListener("submit", onCreateAlbum);
  el("album-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-album]");
    if (btn) onSelectAlbum(btn.dataset.album);
  });
  el("btn-collapse").addEventListener("click", toggleCollapse);
  el("btn-rename").addEventListener("click", onRename);
  el("auth-actions").addEventListener("click", (ev) => {
    if (ev.target.id === "btn-signin") onSignIn();
    if (ev.target.id === "btn-signout") { signOut(); state.session = null; clearSession(); render(); }
  });
  el("file-input").addEventListener("change", (ev) => {
    addFiles(ev.target.files);
    ev.target.value = "";
  });
  const zone = el("dropzone");
  zone.addEventListener("dragover", (ev) => { ev.preventDefault(); zone.classList.add("is-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zone.classList.remove("is-over");
    addFiles(ev.dataTransfer.files);
  });
  el("grid").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-copy]");
    if (!btn || btn.disabled) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast("Direct link copied.");
    } catch {
      prompt("Copy this link:", btn.dataset.copy);
    }
  });
  init();
});
