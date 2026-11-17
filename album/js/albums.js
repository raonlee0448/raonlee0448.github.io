/** Album names stay as the owner typed them. Folders use a separate safe unique slug. */

export function makeId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "a_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function slugFromName(name) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "album";
}

export function uniqueSlug(name, existing, reserved = new Set()) {
  const taken = new Set(
    [...existing.map((a) => a.slug), ...reserved].filter(Boolean)
  );
  const base = slugFromName(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${makeId().slice(2, 8)}`;
}

export function createAlbum(name, existing = []) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Give the album a name first.");
  if (trimmed.length > 80) throw new Error("Keep the album name under 80 characters.");
  const now = new Date().toISOString();
  return {
    id: makeId(),
    name: trimmed,
    slug: uniqueSlug(trimmed, existing),
    createdAt: now,
    updatedAt: now,
  };
}

export function renameAlbum(album, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Give the album a name first.");
  if (trimmed.length > 80) throw new Error("Keep the album name under 80 characters.");
  // Keep the slug so already-uploaded links stay valid.
  return { ...album, name: trimmed, updatedAt: new Date().toISOString() };
}

export function emptyCatalog() {
  return { version: 1, selectedAlbumId: null, albums: [] };
}

export function normalizeCatalog(raw) {
  const cat = emptyCatalog();
  if (!raw || typeof raw !== "object") return cat;
  cat.version = 1;
  const albums = Array.isArray(raw.albums) ? raw.albums : [];
  const seenSlugs = new Set();
  for (const item of albums) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").trim();
    if (!name) continue;
    let slug = String(item.slug || slugFromName(name));
    if (seenSlugs.has(slug)) slug = uniqueSlug(name, [...seenSlugs].map((s) => ({ slug: s })));
    seenSlugs.add(slug);
    cat.albums.push({
      id: String(item.id || makeId()),
      name,
      slug,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    });
  }
  const ids = new Set(cat.albums.map((a) => a.id));
  cat.selectedAlbumId = ids.has(raw.selectedAlbumId) ? raw.selectedAlbumId : (cat.albums[0]?.id || null);
  return cat;
}

export function selectAlbum(catalog, id) {
  const found = catalog.albums.find((a) => a.id === id);
  if (!found) throw new Error("That album is not in your list.");
  return { ...catalog, selectedAlbumId: id };
}

export function upsertAlbum(catalog, album, select = true) {
  const albums = catalog.albums.filter((a) => a.id !== album.id).concat(album);
  albums.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    ...catalog,
    albums,
    selectedAlbumId: select ? album.id : catalog.selectedAlbumId,
  };
}

export function safeFileName(original) {
  const raw = String(original || "image");
  const dot = raw.lastIndexOf(".");
  const ext = (dot >= 0 ? raw.slice(dot) : "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const stem = (dot >= 0 ? raw.slice(0, dot) : raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = makeId().slice(2, 6);
  return `${stamp}-${rand}-${stem}${ext || ".img"}`;
}

export function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(file.name || "");
}
