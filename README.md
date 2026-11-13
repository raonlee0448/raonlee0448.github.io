# RaonLee — Official gallery (follower page)

Public home for RaonLee’s character bots. Dark, neon, and a little dangerous — separate from the private Studio.

Live site: [https://raonlee0448.github.io/](https://raonlee0448.github.io/)

Open `index.html` locally, or add `?preview=1` to skip the 18+ gate while you check the layout.

---

## How to update (no code)

You can change the bio, banner, links, Top 3, pinned or hidden bots, and World Books without touching HTML.

### 1. Edit in Studio

1. Open **RaonLee-Studio.html**.
2. In the sidebar, open **More tools → Follower Page**.
3. Fill in the forms. Upload a banner or World Book covers if you want (they’re resized to WebP for you).
4. Watch the live preview on the right.
5. Click **Export site.json + images (zip)**. Your settings are also saved in this browser.

### 2. Put it on the live page

1. Unzip the file. You should see `site.json`, and maybe an `assets` folder (banner and covers).
2. Open [github.com/raonlee0448/raonlee0448.github.io](https://github.com/raonlee0448/raonlee0448.github.io).
3. Click **Add file → Upload files**.
4. Drop `site.json` **and** the `assets` folder (so `assets/creator-banner.webp` and `assets/worlds/…` keep their folders).
5. Click **Commit changes**.

The same link keeps working. The new version is usually live in about a minute. Refresh once if you still see the old bio.

### Or just send it to me

If you’d rather not click around GitHub, send me the zip and I’ll upload it for you.

---

## What’s in this folder

| File | Role |
| --- | --- |
| `index.html` | The public page (catalog and logos are built in). |
| `site.json` | Editable content: bio, banner path, links, Top 3, pinned/hidden bots, World Books. |
| `assets/theme/` | Background, chibis, stickers, cracked-mask emblem. |
| `assets/fonts/` | Neon / flyer / body fonts, so the page still looks right offline. |
| `assets/raonlee-logo.svg` | Keyhole Heart logo (coloured toxic green on the page). |
| `template.html` + `build.py` | Used only if the catalog itself needs a rebuild. |

The page always has a fallback copy of `site.json` inside `index.html`. After a change, it loads the standalone `site.json` so your edits show up without a rebuild.

## Notes

- Only **public** bots are on this page. Private ones never appear, even if someone guesses an id.
- Top 3 defaults to the three highest lead-platform interaction counts (Farm R, Lian Otonashi, Thaelar right now). Leave the Top 3 picker empty in Studio to keep it automatic, or pick three bots yourself.
- World Books listed here are your real series, marked “coming soon” until you add a link. Hollowmere is not included.
- Counts are each platform’s own lifetime total, never a cross-site sum.
- The 18+ gate is remembered in the browser (`raonlee-followers-18`). Bypass it with `?preview=1` or `?shot=1`.
- Motion (fog, neon flicker, glints) turns off when the browser asks for reduced motion.
