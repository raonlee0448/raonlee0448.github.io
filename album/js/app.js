import { CONFIG } from "../config.js";
import {
  createAlbum, renameAlbum, upsertAlbum, selectAlbum, isImageFile,
  findAlbumsByNormalizedName, removeAlbumFromCatalog, normalizeName,
} from "./albums.js";
import {
  loadSession, clearSession, githubReady, loadRemoteConfig, startWebLogin, completeWebLogin,
  startDeviceLogin, pollDeviceLogin, signOut,
} from "./auth.js";
import { detectMode, githubStore, localStore } from "./storage.js";
import { watermarkFile } from "./watermark.js";

const UI_KEY = "raonlee-images-ui-v1";

const state = {
  mode: "github",
  store: githubStore,
  session: null,
  catalog: { version: 1, selectedAlbumId: null, albums: [] },
  view: "home",
  images: [],
  imagesAlbumId: null,
  pending: [],
  collapsed: {},
  busy: false,
  creating: false,
  error: "",
  device: null,
  nameWarning: null,
  confirm: null,
};

let imagesGen = 0;

function loadUi() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
    state.collapsed = raw.collapsed && typeof raw.collapsed === "object" ? raw.collapsed : {};
  } catch { state.collapsed = {}; }
}

function saveUi() {
  const selectedAlbumId = state.catalog.selectedAlbumId || null;
  localStorage.setItem(UI_KEY, JSON.stringify({
    collapsed: state.collapsed,
    selectedAlbumId,
    view: state.view,
  }));
}

function $(sel) { return document.querySelector(sel); }
function el(id) { return document.getElementById(id); }

function selectedAlbum() {
  if (state.view !== "album") return null;
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
  const gen = ++imagesGen;
  const albumId = album?.id || null;
  state.images = [];
  state.imagesAlbumId = albumId;
  if (!album) return;
  const items = await state.store.listImages(album);
  if (gen !== imagesGen || state.catalog.selectedAlbumId !== albumId || state.view !== "album") return;
  state.images = items;
  state.imagesAlbumId = albumId;
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

  const createBtn = el("btn-create-album");
  if (createBtn) {
    createBtn.disabled = state.creating;
    createBtn.textContent = state.creating ? "Creating…" : "Create album";
  }

  renderNameWarning();

  const list = el("album-list");
  if (!state.catalog.albums.length) {
    list.innerHTML = `<p class="empty-albums">No albums yet. Name one to start tracking a set of images.</p>`;
  } else {
    list.innerHTML = state.catalog.albums.map((a) => `
      <button type="button" class="album-chip ${state.view === "album" && a.id === state.catalog.selectedAlbumId ? "is-selected" : ""}" data-album="${a.id}">
        <span class="album-name">${escapeHtml(a.name)}</span>
        <span class="album-slug">/${escapeHtml(a.slug)}</span>
      </button>
    `).join("");
  }

  const showAlbum = state.view === "album" && Boolean(album);
  el("album-stage").hidden = !showAlbum;
  el("home-stage").hidden = showAlbum;
  if (showAlbum) {
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
      ? "New images go into this album and are watermarked before upload."
      : "Sign in to upload into this album.";
    renderGrid();
  }

  renderConfirm();
}

function renderNameWarning() {
  const box = el("name-warning");
  const warning = state.nameWarning;
  if (!warning || !warning.matches?.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const items = warning.matches.map((a) => `
    <button type="button" class="btn ghost" data-open-existing="${escapeHtml(a.id)}">
      Open “${escapeHtml(a.name)}” /${escapeHtml(a.slug)}
    </button>
  `).join("");
  box.hidden = false;
  box.innerHTML = `
    <p>An album named “${escapeHtml(warning.name)}” already exists. Open the existing one instead of creating another copy.</p>
    <div class="row wrap">${items}
      <button type="button" class="btn ghost" id="btn-create-anyway">Create a new album anyway</button>
    </div>
  `;
}

function renderConfirm() {
  const dialog = el("confirm-dialog");
  if (!state.confirm) {
    dialog.hidden = true;
    return;
  }
  el("confirm-title").textContent = state.confirm.title;
  el("confirm-body").textContent = state.confirm.body;
  el("confirm-ok").textContent = state.confirm.okLabel || "Confirm";
  dialog.hidden = false;
}

function renderGrid() {
  const grid = el("grid");
  if (!grid) return;
  const album = selectedAlbum();
  const albumId = album?.id;
  const pending = state.pending.filter((p) => p.albumId === albumId);
  const images = (state.imagesAlbumId === albumId ? state.images : []).filter((img) => {
    return !pending.some((p) => p.url === img.url || p.fileName === img.name);
  });
  const combined = [...pending, ...images];
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
        ${item.watermarked ? `<div class="wm-badge">Watermarked preview · 30%</div>` : ""}
        ${item.metaNote ? `<div class="meta-note">${escapeHtml(item.metaNote)}</div>` : ""}
        ${status === "uploading" || status === "encoding" || status === "watermarking" ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ""}
        <button type="button" class="btn slim copy" data-copy="${escapeHtml(item.url || "")}" ${canCopy ? "" : "disabled"}>
          ${canCopy ? "Copy direct link" : "Link waits until it is live"}
        </button>
      </div>
    </article>
  `;
}

function statusLabel(item, status, pct) {
  if (status === "encoding" || status === "watermarking") return "Adding watermark…";
  if (status === "ready") return "Watermarked preview. Uploading the marked file next…";
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

async function persistCatalog(opts = {}) {
  const saved = await state.store.saveCatalog(state.catalog, opts);
  if (saved && Array.isArray(saved.albums)) {
    const keep = state.catalog.selectedAlbumId;
    state.catalog = {
      ...saved,
      selectedAlbumId: saved.albums.some((a) => a.id === keep) ? keep : (saved.selectedAlbumId || null),
    };
  }
}

async function createAlbumRecord(name, { force = false } = {}) {
  const trimmed = String(name || "").trim();
  if (!force) {
    const matches = findAlbumsByNormalizedName(state.catalog.albums, trimmed);
    if (matches.length) {
      state.nameWarning = { name: trimmed, matches, raw: trimmed };
      render();
      return null;
    }
  }
  const album = createAlbum(trimmed, state.catalog.albums);
  state.catalog = upsertAlbum(state.catalog, album, true);
  await persistCatalog();
  state.nameWarning = null;
  return album;
}

async function onCreateAlbum(ev) {
  ev.preventDefault();
  if (state.creating) return;
  const input = el("new-album-name");
  state.creating = true;
  render();
  try {
    const album = await createAlbumRecord(input.value, { force: false });
    if (!album) return;
    input.value = "";
    await openAlbum(album.id);
    setError("");
    toast(`Album “${album.name}” is ready. Uploads will go here.`);
  } catch (err) {
    setError(err.message);
  } finally {
    state.creating = false;
    render();
  }
}

async function onCreateAnyway() {
  if (state.creating || !state.nameWarning) return;
  const name = state.nameWarning.raw;
  state.creating = true;
  render();
  try {
    const album = await createAlbumRecord(name, { force: true });
    if (!album) return;
    el("new-album-name").value = "";
    await openAlbum(album.id);
    setError("");
    toast(`Created another album named “${album.name}” as /${album.slug}.`);
  } catch (err) {
    setError(err.message);
  } finally {
    state.creating = false;
    render();
  }
}

async function openAlbum(id) {
  // Local UI only — never writes albums.json.
  state.catalog = selectAlbum(state.catalog, id);
  state.view = "album";
  saveUi();
  setError("");
  render();
  try {
    await refreshImages();
  } catch (err) {
    setError(err.message);
  }
  render();
}

function goHome() {
  state.view = "home";
  saveUi();
  setError("");
  render();
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

function onDeleteAsk() {
  const album = selectedAlbum();
  if (!album) return;
  state.confirm = {
    action: "remove-album",
    albumId: album.id,
    title: `Remove “${album.name}” from your album list?`,
    body: `This only removes “${album.name}” (/${album.slug}) from the list in this tool. Files already on your site and their direct links stay as they are. This does not delete the images.`,
    okLabel: "Remove from list",
  };
  render();
}

async function onDeleteConfirm() {
  const confirm = state.confirm;
  if (!confirm || confirm.action !== "remove-album") {
    state.confirm = null;
    render();
    return;
  }
  const id = confirm.albumId;
  const album = state.catalog.albums.find((a) => a.id === id);
  try {
    state.catalog = removeAlbumFromCatalog(state.catalog, id);
    await persistCatalog({ removedIds: [id] });
    state.confirm = null;
    state.view = "home";
    saveUi();
    setError("");
    toast(album
      ? `“${album.name}” is off your list. Existing files and links were left as they are.`
      : "That album is off your list. Existing files and links were left as they are.");
    render();
  } catch (err) {
    setError(err.message);
    state.confirm = null;
    render();
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
    setError("Open an album first. Uploads always go into the album you have open.");
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
      albumId: album.id,
      albumSlug: album.slug,
      albumName: album.name,
    });
  }
  render();
  pumpUploads();
}

function albumForPending(item) {
  return state.catalog.albums.find((a) => a.id === item.albumId) || null;
}

async function pumpUploads() {
  if (state.busy) return;

  const toMark = state.pending.find((p) => p.status === "encoding" && p.file);
  if (toMark) {
    state.busy = true;
    toMark.status = "watermarking";
    render();
    try {
      const prepared = await watermarkFile(toMark.file);
      if (toMark.thumb) URL.revokeObjectURL(toMark.thumb);
      toMark.thumb = prepared.previewUrl;
      toMark.file = prepared.file;
      toMark.fileName = prepared.file.name;
      toMark.watermarked = true;
      toMark.metaNote = prepared.note || "";
      toMark.status = "ready";
    } catch (err) {
      toMark.status = "failed";
      toMark.error = err.message || "Could not watermark this image.";
      toMark.file = null;
    }
    render();
    state.busy = false;
    await new Promise((r) => setTimeout(r, 450));
    pumpUploads();
    return;
  }

  const next = state.pending.find((p) => p.status === "ready" && p.file);
  if (!next) return;
  const album = albumForPending(next);
  if (!album) {
    next.status = "failed";
    next.error = "The album this upload was started in is no longer in your list. The file was not uploaded, and hosted files were left as they are.";
    next.file = null;
    render();
    pumpUploads();
    return;
  }
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
  state.view = "home";
  saveUi();
  render();
  toast("Signed in. Open an album to upload, or create a new one.");
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
    }
  } catch (err) {
    setError(err.message);
  }
  state.view = "home";
  render();
}

document.addEventListener("DOMContentLoaded", () => {
  el("new-album-form").addEventListener("submit", onCreateAlbum);
  el("album-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-album]");
    if (btn) openAlbum(btn.dataset.album);
  });
  el("name-warning").addEventListener("click", (ev) => {
    const open = ev.target.closest("[data-open-existing]");
    if (open) {
      state.nameWarning = null;
      el("new-album-name").value = "";
      openAlbum(open.dataset.openExisting);
      return;
    }
    if (ev.target.id === "btn-create-anyway") onCreateAnyway();
  });
  el("btn-home").addEventListener("click", goHome);
  el("btn-collapse").addEventListener("click", toggleCollapse);
  el("btn-rename").addEventListener("click", onRename);
  el("btn-delete").addEventListener("click", onDeleteAsk);
  el("confirm-cancel").addEventListener("click", () => { state.confirm = null; render(); });
  el("confirm-ok").addEventListener("click", onDeleteConfirm);
  el("confirm-dialog").addEventListener("click", (ev) => {
    if (ev.target.id === "confirm-dialog") { state.confirm = null; render(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.confirm) { state.confirm = null; render(); }
  });
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
