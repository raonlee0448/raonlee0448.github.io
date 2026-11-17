/** Client-side watermark. Bakes marks into pixels before any upload. */
import { CONFIG } from "../config.js";

export const WATERMARK = {
  opacity: CONFIG.watermark?.opacity ?? 0.3,
  credit: CONFIG.watermark?.credit ?? "© RaonLee",
  notice: CONFIG.watermark?.notice ?? "AI generated image",
  logoUrl: new URL("../assets/raonlee-logo.svg", import.meta.url).href,
};

export class WatermarkError extends Error {
  constructor(message, code = "watermark") {
    super(message);
    this.name = "WatermarkError";
    this.code = code;
  }
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CARD_KEYS = new Set(["chara", "ccv3", "ccv2", "chara_card_v2", "character", "characterbook"]);
const META_KEYS = new Set([
  ...CARD_KEYS,
  "generation_data",
  "prompt",
  "parameters",
  "comment",
  "description",
  "software",
  "source",
  "title",
  "author",
  "copyright",
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function startsWith(bytes, sig, at = 0) {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[at + i] !== sig[i]) return false;
  return true;
}

export function isPng(bytes) {
  return startsWith(bytes, PNG_SIG);
}

export function parsePngChunks(bytes) {
  if (!isPng(bytes)) return [];
  const chunks = [];
  let i = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const start = i + 8;
    const end = start + length;
    if (end + 4 > bytes.length) break;
    chunks.push({ type, data: bytes.subarray(start, end) });
    i = end + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

function pngTextKey(chunk) {
  if (chunk.type !== "tEXt" && chunk.type !== "zTXt" && chunk.type !== "iTXt") return "";
  let end = 0;
  while (end < chunk.data.length && chunk.data[end] !== 0) end++;
  return new TextDecoder("latin1").decode(chunk.data.subarray(0, end));
}

export function pngTextKeys(bytes) {
  return parsePngChunks(bytes)
    .filter((c) => c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt")
    .map((c) => ({ type: c.type, key: pngTextKey(c), length: c.data.length }));
}

export function pngHasAnimation(bytes) {
  return parsePngChunks(bytes).some((c) => c.type === "acTL");
}

export function isGif(bytes) {
  return bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
}

export function gifIsAnimated(bytes) {
  if (!isGif(bytes) || bytes.length < 13) return false;
  let i = 13;
  if (bytes[10] & 0x80) i += 3 * (2 ** ((bytes[10] & 7) + 1));
  let frames = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x3b) break;
    if (b === 0x21) {
      i += 2;
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i];
      i += 1;
      continue;
    }
    if (b === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      if (i + 10 >= bytes.length) break;
      const packed = bytes[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 * (2 ** ((packed & 7) + 1));
      i += 1;
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i];
      i += 1;
      continue;
    }
    i += 1;
  }
  return frames > 1;
}

export function isWebp(bytes) {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

export function webpIsAnimated(bytes) {
  if (!isWebp(bytes)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = view.getUint32(i + 4, true);
    if (type === "ANIM" || type === "ANMF") return true;
    i += 8 + size + (size % 2);
  }
  return false;
}

export function isJpeg(bytes) {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

export function detectUnsupportedAnimation(bytes, type = "") {
  const mime = String(type || "").toLowerCase();
  if (isGif(bytes) && gifIsAnimated(bytes)) return "gif";
  if (isWebp(bytes) && webpIsAnimated(bytes)) return "webp";
  if (isPng(bytes) && pngHasAnimation(bytes)) return "apng";
  if (mime.includes("gif") && gifIsAnimated(bytes)) return "gif";
  return "";
}

const ANIM_MESSAGE = {
  gif: "Animated GIFs cannot be watermarked without flattening the animation, so this file was not uploaded.",
  webp: "Animated WebP files cannot be watermarked without flattening the animation, so this file was not uploaded.",
  apng: "Animated PNGs cannot be watermarked without flattening the animation, so this file was not uploaded.",
};

function pngColorType(bytes) {
  if (!isPng(bytes) || bytes.length < 26) return -1;
  return bytes[25];
}

function pngHasAlpha(bytes) {
  const ct = pngColorType(bytes);
  if (ct === 4 || ct === 6) return true;
  if (ct === 3) return parsePngChunks(bytes).some((c) => c.type === "tRNS");
  return parsePngChunks(bytes).some((c) => c.type === "tRNS");
}

function buildPng(chunks) {
  let total = 8;
  for (const c of chunks) total += 12 + c.data.length;
  const out = new Uint8Array(total);
  out.set(PNG_SIG, 0);
  const view = new DataView(out.buffer);
  let i = 8;
  for (const c of chunks) {
    view.setUint32(i, c.data.length);
    out[i + 4] = c.type.charCodeAt(0);
    out[i + 5] = c.type.charCodeAt(1);
    out[i + 6] = c.type.charCodeAt(2);
    out[i + 7] = c.type.charCodeAt(3);
    out.set(c.data, i + 8);
    const slice = out.subarray(i + 4, i + 8 + c.data.length);
    view.setUint32(i + 8 + c.data.length, crc32(slice));
    i += 12 + c.data.length;
  }
  return out;
}

export function insertPngTextChunks(pngBytes, sourceBytes) {
  const source = parsePngChunks(sourceBytes).filter(
    (c) => c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt"
  );
  if (!source.length) return { bytes: pngBytes, preserved: [], missing: [] };
  const dest = parsePngChunks(pngBytes);
  if (!dest.length) return { bytes: pngBytes, preserved: [], missing: source.map((c) => pngTextKey(c)) };
  const existingKeys = new Set(
    dest.filter((c) => c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt").map(pngTextKey)
  );
  const toInsert = source.filter((c) => !existingKeys.has(pngTextKey(c)));
  const idat = dest.findIndex((c) => c.type === "IDAT");
  const at = idat >= 0 ? idat : Math.max(1, dest.length - 1);
  dest.splice(at, 0, ...toInsert);
  const next = buildPng(dest);
  const keysNow = new Set(pngTextKeys(next).map((k) => k.key));
  const preserved = source.map(pngTextKey).filter((k) => keysNow.has(k));
  const missing = source.map(pngTextKey).filter((k) => !keysNow.has(k));
  return { bytes: next, preserved, missing };
}

function replaceExt(name, ext) {
  const base = String(name || "image").replace(/[/\\]+/g, "_");
  const stem = base.replace(/\.[^.]+$/, "") || "image";
  return `${stem}.${ext}`;
}

function outputName(originalName, mime) {
  if (mime === "image/jpeg") return replaceExt(originalName, "jpg");
  if (mime === "image/webp") return replaceExt(originalName, "webp");
  return replaceExt(originalName, "png");
}

let logoPromise = null;

async function loadLogo() {
  if (logoPromise) return logoPromise;
  logoPromise = (async () => {
    const img = new Image();
    img.decoding = "async";
    img.src = WATERMARK.logoUrl;
    await img.decode();
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, size, size);
    return canvas;
  })();
  return logoPromise;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeStamp(logo, minSide) {
  const logoSize = Math.round(clamp(minSide * 0.11, 56, 160));
  const fontSize = Math.round(clamp(logoSize * 0.22, 13, 28));
  const pad = Math.round(logoSize * 0.16);
  const gap = Math.round(logoSize * 0.1);
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `600 ${fontSize}px "Segoe UI", "Helvetica Neue", sans-serif`;
  const textW = Math.ceil(
    Math.max(measure.measureText(WATERMARK.credit).width, measure.measureText(WATERMARK.notice).width)
  );
  const lineGap = Math.round(fontSize * 0.28);
  const textH = fontSize * 2 + lineGap;
  const width = Math.ceil(pad + logoSize + gap + textW + pad);
  const height = Math.ceil(pad + Math.max(logoSize, textH) + pad);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const logoX = pad;
  const logoY = Math.round((height - logoSize) / 2);
  const textX = pad + logoSize + gap;
  const textY = Math.round((height - textH) / 2);
  ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
  ctx.font = `600 ${fontSize}px "Segoe UI", "Helvetica Neue", sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(2.5, fontSize * 0.18);
  ctx.strokeStyle = "#140308";
  ctx.fillStyle = "#fff8f4";
  ctx.strokeText(WATERMARK.credit, textX, textY);
  ctx.fillText(WATERMARK.credit, textX, textY);
  ctx.strokeText(WATERMARK.notice, textX, textY + fontSize + lineGap);
  ctx.fillText(WATERMARK.notice, textX, textY + fontSize + lineGap);
  return { canvas, width, height, logoSize, fontSize };
}

function paintPattern(ctx, stamp, width, height) {
  const stepX = stamp.width * 1.85;
  const stepY = stamp.height * 2.35;
  const angle = (-28 * Math.PI) / 180;
  const pad = Math.ceil(Math.hypot(width, height));
  ctx.save();
  ctx.globalAlpha = WATERMARK.opacity;
  ctx.translate(width / 2, height / 2);
  ctx.rotate(angle);
  ctx.translate(-width / 2, -height / 2);
  for (let y = -pad; y < height + pad; y += stepY) {
    for (let x = -pad; x < width + pad; x += stepX) {
      ctx.drawImage(stamp.canvas, x, y);
    }
  }
  ctx.restore();
}

async function decodeBitmap(file, bytes) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to Image */
      }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const orient = isJpeg(bytes) ? jpegOrientation(bytes) : 1;
    const swap = orient >= 5 && orient <= 8;
    const w = swap ? img.naturalHeight : img.naturalWidth;
    const h = swap ? img.naturalWidth : img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    applyOrientation(ctx, img.naturalWidth, img.naturalHeight, orient);
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function jpegOrientation(bytes) {
  if (!isJpeg(bytes)) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const size = view.getUint16(offset + 2);
    if (marker === 0xe1 && offset + 4 + size <= bytes.length + 2) {
      const start = offset + 4;
      if (
        bytes[start] === 0x45 && bytes[start + 1] === 0x78 &&
        bytes[start + 2] === 0x69 && bytes[start + 3] === 0x66 &&
        bytes[start + 4] === 0 && bytes[start + 5] === 0
      ) {
        return readExifOrientation(bytes, start + 6);
      }
    }
    if (marker === 0xda) break;
    offset += 2 + size;
  }
  return 1;
}

function readExifOrientation(bytes, tiff) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const u16 = (o) => (little ? view.getUint16(o, true) : view.getUint16(o, false));
  const u32 = (o) => (little ? view.getUint32(o, true) : view.getUint32(o, false));
  if (u16(tiff + 2) !== 0x002a) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > bytes.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    if (u16(e) === 0x0112) return u16(e + 8) || 1;
  }
  return 1;
}

function applyOrientation(ctx, w, h, orient) {
  switch (orient) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
}

function chooseMime(file, bytes, hasMeta) {
  if (hasMeta || isPng(bytes) || pngHasAlpha(bytes)) return "image/png";
  const type = String(file.type || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg") || isJpeg(bytes)) return "image/jpeg";
  if (type.includes("webp") || isWebp(bytes)) return "image/webp";
  if (type.includes("gif") && isGif(bytes)) return "image/png";
  return "image/png";
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new WatermarkError("Could not write the watermarked image.", "encode"));
      else resolve(blob);
    }, mime, quality);
  });
}

function describeMetadata(keys) {
  const lower = keys.map((k) => k.toLowerCase());
  const card = lower.filter((k) => CARD_KEYS.has(k));
  const interesting = keys.filter((k) => META_KEYS.has(k.toLowerCase()) || CARD_KEYS.has(k.toLowerCase()));
  const label = interesting.length ? interesting.join(", ") : keys.join(", ");
  if (card.length) {
    return `This PNG looks like a character card (${label}). That embedded metadata is kept in the watermarked PNG.`;
  }
  if (interesting.length) {
    return `This PNG has embedded metadata (${label}). It is kept in the watermarked file.`;
  }
  if (keys.length) {
    return `Embedded PNG text metadata (${label}) is kept in the watermarked file.`;
  }
  return "";
}

/**
 * Bake the Keyhole Heart watermark plus credit lines into a new File.
 * Never returns the original bytes. Throws WatermarkError for animated / failed cases.
 */
export async function watermarkFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const animated = detectUnsupportedAnimation(bytes, file.type);
  if (animated) throw new WatermarkError(ANIM_MESSAGE[animated] || ANIM_MESSAGE.gif, "animated");

  const textMeta = isPng(bytes) ? parsePngChunks(bytes).filter((c) => c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt") : [];
  const keys = textMeta.map(pngTextKey);
  const hasMeta = textMeta.length > 0;

  let bitmap;
  try {
    bitmap = await decodeBitmap(file, bytes);
  } catch (err) {
    throw new WatermarkError(
      "This image could not be read in this browser, so it was not uploaded.",
      "undecodable"
    );
  }

  const width = bitmap.width;
  const height = bitmap.height;
  if (!width || !height) {
    if (bitmap.close) bitmap.close();
    throw new WatermarkError("This image has no readable size, so it was not uploaded.", "undecodable");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    if (bitmap.close) bitmap.close();
    throw new WatermarkError("Could not prepare a canvas for watermarking.", "encode");
  }
  ctx.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();

  const logo = await loadLogo();
  const stamp = makeStamp(logo, Math.min(width, height));
  paintPattern(ctx, stamp, width, height);

  const mime = chooseMime(file, bytes, hasMeta);
  const quality = mime === "image/png" ? undefined : 0.95;
  let blob = await canvasToBlob(canvas, mime, quality);
  let outBytes = new Uint8Array(await blob.arrayBuffer());
  let preserved = [];
  let note = "";

  if (hasMeta) {
    if (blob.type !== "image/png") {
      throw new WatermarkError(
        "This PNG has embedded metadata that would be lost in another format, so it was not uploaded.",
        "metadata"
      );
    }
    const merged = insertPngTextChunks(outBytes, bytes);
    if (merged.missing.length) {
      throw new WatermarkError(
        "This PNG has embedded metadata (character card or generation data) that could not be kept, so it was not uploaded.",
        "metadata"
      );
    }
    preserved = merged.preserved;
    outBytes = merged.bytes;
    blob = new Blob([outBytes], { type: "image/png" });
    note = describeMetadata(preserved);
  }

  const maxBytes = CONFIG.maxBytes || 25 * 1024 * 1024;
  if (blob.size > maxBytes) {
    throw new WatermarkError(
      `The watermarked image is over ${Math.round(maxBytes / 1024 / 1024)} MB, so it was not uploaded.`,
      "too-large"
    );
  }

  const name = outputName(file.name, blob.type);
  const outFile = new File([blob], name, { type: blob.type, lastModified: Date.now() });
  const previewUrl = URL.createObjectURL(outFile);
  return {
    file: outFile,
    previewUrl,
    width,
    height,
    type: blob.type,
    opacity: WATERMARK.opacity,
    preservedKeys: preserved,
    note,
    stamp: { width: stamp.width, height: stamp.height, logoSize: stamp.logoSize },
  };
}
