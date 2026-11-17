import { CONFIG } from "../config.js";

const form = document.getElementById("manifest-form");
const input = document.getElementById("manifest");
const worker = String(CONFIG.authProxyUrl || "").replace(/\/+$/, "");

async function loadManifest() {
  const res = await fetch("manifest.json", { cache: "no-store" });
  const manifest = await res.json();
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    manifest.redirect_url = location.origin + location.pathname;
    if (!manifest.callback_urls.includes(location.origin + "/")) {
      manifest.callback_urls.push(location.origin + "/");
    }
  }
  input.value = JSON.stringify(manifest);
  const state = crypto.randomUUID();
  sessionStorage.setItem("raonlee-images-manifest-state", state);
  form.action = "https://github.com/settings/apps/new?state=" + encodeURIComponent(state);
}

function show(id, text) {
  const box = document.getElementById("result");
  box.hidden = false;
  if (text) document.getElementById("result-msg").textContent = text;
  document.getElementById(id)?.removeAttribute("hidden");
}

async function maybeConvert() {
  const params = new URLSearchParams(location.search);
  if (params.get("installed") === "1") {
    show("go-uploader", "The app is installed. You can go to the uploader and sign in.");
    history.replaceState({}, "", location.pathname);
    return;
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code) return;
  const expected = sessionStorage.getItem("raonlee-images-manifest-state");
  if (state && expected && state !== expected) {
    show("result-msg", "The setup session did not match. Open this page again and press the button once more.");
    return;
  }
  document.getElementById("result").hidden = false;
  document.getElementById("result-msg").textContent = "Finishing setup…";
  const res = await fetch(worker + "/setup/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await res.json().catch(() => ({}));
  history.replaceState({}, "", location.pathname);
  if (!res.ok || !data.ok) {
    document.getElementById("result-msg").textContent = data.error || "Could not finish setup. Open this page and try the button again.";
    return;
  }
  document.getElementById("result-msg").textContent = "The uploader app is created. One last GitHub step: install it on your website repo only.";
  const a = document.getElementById("install-app");
  a.hidden = false;
  if (data.install_url) a.href = data.install_url;
}

loadManifest();
maybeConvert();
