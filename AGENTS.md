# AGENTS.md

## Project overview
Static, bilingual (ES/EN) single-page portfolio ("vitrina") for Alexander Cortez — junior development & AI (Python, ML, generative AI). **No build step** — no package.json, bundler, tests, or linting. Verify changes by opening `index.html` in a browser (plain `<script>` tags only, no XHR, so `file://` works) or serving the folder statically.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Single scroll page: hero → about → projects → skills → roadmap → contact. All sections have anchors (`#about`, `#projects`, `#skills`, `#roadmap`, `#contact`). |
| `style.css` | All styling, incl. the ES/EN lang toggle (black/white/red brutalist, `Archivo Black`, uppercase). |
| `i18n.js` | ES/EN dictionary (`translations`) + `setLanguage()` + toggle binding. |
| `app.js` | Scroll-reveal via IntersectionObserver + active-section highlighting in the nav + video-modal open/close logic. |

Assets: `assets/videos/*.mp4` (demo clips shown in `.video-modal` from project cards p1/p4) and `assets/og-image.png` (1200×630 share thumbnail).

## Editing content (most common task)
- **Every visible string lives in 3 places**: hardcoded Spanish in `index.html` (no-JS default) AND in `i18n.js` `translations` under both `es` and `en`. Updating only one leaves stale copy when the ES/EN toggle is used. Default language is `es` unless `sessionStorage.lang` was set.
- To add a translatable element: put `data-i18n="key"` on the tag with Spanish default text, then add the same key to both `translations.es` and `translations.en`.
- **Projects are placeholder content**: `projects.p1..p4.*` keys in `i18n.js` + hardcoded Spanish in the 4 `.project-card` articles of `index.html`. Replace with real titles, descriptions, tags and give the `.project-link` anchors real `href`s. Grid auto-lays out 1-per-row (mobile) / 2-per-row (desktop) — no layout edits needed to add/remove cards.
- **Modal de video:** project cards p1 (Adelita) and p4 (Goebbels) have a `.project-video-btn[data-videos]` button (video paths separated by `|`) that opens a `.video-modal` lightbox (close via X, backdrop, or Escape). Markup in `index.html`, styles `.video-modal*` in `style.css`, logic in `app.js`.
- Skills badges and social links are intentionally NOT translated (keywords/brand names) — leave without `data-i18n`.

## Current state & next steps (Sep 2026)
- Site rebuilt as a single-page dev/IA portfolio. SEO + Telegram funnel (Fase 1) and the project video modal are **implemented and committed**.
- **History was purged** with `git filter-repo` (old media site, test artifacts `.superpowers/`, `.playwright-mcp/`, `*.png` screenshots, `.claude/`, `assets/portafolio.pdf`, `AVANCES_Y_SUGERENCIAS.txt`, `docs/` were removed). Only the operative site files remain. Repo history is rewritten — **force-push only** (use `git push --force-with-lease`), never a normal `git push`. `.git` is now ~5.6 MB; the pre-purge backup lives at `C:\Users\hp\AppData\Local\Temp\opencode\new-porta-backup-20260901-222144`.
- `.gitignore` (excludes tooling/test artifacts but preserves `assets/og-image.png` via negated rule) and `.gitattributes` (`* text=auto` normalizes LF; binaries marked `binary`) were added — don't remove them.
- Projects, skills, roadmap, and email are **placeholder content** — pending real links (p2 demo on HuggingFace, p4 video). Do not invent real project links; ask the user for them.

## Manual-testing gotchas
- Language toggle reads `sessionStorage.lang`. Soft reloads keep that state — to reset language, use a fresh tab or incognito.
- Scroll-reveal uses IntersectionObserver: sections start `opacity: 0` until scrolled into view. If a section looks blank in a screenshot, scroll to it first.

## Deployment
No CI in the repo. `main` is the deploy branch — push to `origin` (`git@github.com:choquevolqueta/new-porta.git`) and GitHub Pages redeploys choquevolqueta.github.io (wait for Pages to rebuild). Commit messages in this repo are short and in Spanish (e.g. `modificacion de publicidad`).

## Custom domain + Google Search Console (Sep 2026) — DONE
- Site is served as **`https://choquevolqueta.com/`** (apex) via GitHub Pages custom domain. `www.choquevolqueta.com` also resolves (`CNAME www → choquevolqueta.com`). The `CNAME` file in the repo root contains `choquevolqueta.com` — keep it, GitHub Pages won't serve the custom domain without it.
- **DNS is on Cloudflare** (domain purchased there). Required records, all **DNS-only (grey cloud, TTL auto)**:
  - 4 × `A  @ → 185.199.108.153 / 185.199.109.153 / 185.199.110.153 / 185.199.111.153`
  - `CNAME www → choquevolqueta.com`
  - TXT `google-site-verification=...` for Search Console
  - Do NOT enable Cloudflare proxy (orange cloud) on these — GitHub Pages + custom domain needs real GitHub IPs, not e.g. Cloudflare's.
  - If `www` ever loses its SSL cert after a few hours, point `CNAME www → choquevolqueta.github.io` instead, wait, re-enable.
- **SEO wired into `index.html`**: canonical, `og:*`, `twitter:*` point at `https://choquevolqueta.com/...`; Google Fonts is self-hosted locally (`assets/fonts/archivo-black-latin.woff2`, `@font-face` in `style.css`) so the page makes **zero third-party calls**; `sitemap.xml`, `robots.txt` (with `Sitemap:` line) and JSON-LD (Person + Service + `sameAs`) are present.
- **Verified in Google Search Console** (domain property, DNS TXT method). Sitemap `sitemap.xml` submitted OK; `https://choquevolqueta.com/` requested for indexing.
- **Keep-alive**: Search Console warns to add a second verification method so the TXT DNS record remains the single point of failure. If you want to harden it later (default now: DNS TXT is enough), use the HTML-file method — put Google's HTML verification file in the repo root and push; Pages serves it, no DNS dependency.

## Sibling repo — do NOT confuse
- **`porta-publi`** (`git@github.com:choquevolqueta/porta-publi.git`) is the **old media/agency portfolio** kept as a **backup only**. The user does NOT intend to showcase it. It lives at `choquevolqueta.github.io/porta-publi` with **no custom domain** — leave it that way (a custom domain there would compete with the apex SEO). Do not push this repo's branding/material into `new portafolio`; they are separate.
- Primary funnel to test: the dev/IA single-page portfolio on `choquevolqueta.com` → Telegram CTA (`t.me/Choquevolqueta`).

## Windows shell gotcha
PowerShell on this machine mangles non-ASCII output: Spanish accents and em-dashes render as `�`/`�` in `Get-Content`/`Select-String` output even though files are valid UTF-8 (no BOM). To read accented content, trust the `read` tool or `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)` — don't "fix" files based on mangled shell output.