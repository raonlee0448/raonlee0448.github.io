/** Public runtime config. Never put a client secret, PEM, or token here. */
export const CONFIG = {
  owner: "raonlee0448",
  repo: "raonlee0448.github.io",
  branch: "main",
  allowedUser: "raonlee0448",
  pagesBase: "https://raonlee0448.github.io",
  uploadsPrefix: "uploads",
  metadataPath: "uploads/albums.json",
  // Public client ID is loaded from the Worker after one-time GitHub App setup.
  clientId: "",
  authProxyUrl: "https://raonlee-image-uploader.raonlee0448.workers.dev",
  oauthRedirect: "https://raonlee0448.github.io/album/",
  authMode: "web",
  maxBytes: 25 * 1024 * 1024,
  pagesTimeoutMs: 180000,
  pagesPollMs: 3000,
  watermark: {
    opacity: 0.3,
    credit: "© RaonLee",
    notice: "AI generated image",
  },
};

