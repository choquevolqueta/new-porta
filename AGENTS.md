# AGENTS.md

## Project overview
Static, bilingual (ES/EN) single-page portfolio ("vitrina") for Alexander Cortez — junior development & AI (Python, ML, generative AI). **No build step** — no package.json, bundler, tests, or linting. Verify changes by opening `index.html` in a browser (plain `<script>` tags only, no XHR, so `file://` works) or serving the folder statically.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Single scroll page: hero → about → projects → skills → roadmap → contact. All sections have anchors (`#about`, `#projects`, `#skills`, `#roadmap`, `#contact`). |
| `style.css` | All styling, incl. the ES/EN lang toggle (black/white/red brutalist, `Archivo Black`, uppercase). |
| `i18n.js` | ES/EN dictionary (`translations`) + `setLanguage()` + toggle binding. |
| `app.js` | Scroll-reveal via IntersectionObserver + active-section highlighting in the nav. |

Assets: `assets/portafolio.pdf` (orphaned CV, not linked anywhere — do not delete).

## Editing content (most common task)
- **Every visible string lives in 3 places**: hardcoded Spanish in `index.html` (no-JS default) AND in `i18n.js` `translations` under both `es` and `en`. Updating only one leaves stale copy when the ES/EN toggle is used. Default language is `es` unless `sessionStorage.lang` was set.
- To add a translatable element: put `data-i18n="key"` on the tag with Spanish default text, then add the same key to both `translations.es` and `translations.en`.
- **Projects are placeholder content**: `projects.p1..p4.*` keys in `i18n.js` + hardcoded Spanish in the 4 `.project-card` articles of `index.html`. Replace with real titles, descriptions, tags and give the `.project-link` anchors real `href`s. Grid auto-lays out 1-per-row (mobile) / 2-per-row (desktop) — no layout edits needed to add/remove cards.
- Skills badges and social links are intentionally NOT translated (keywords/brand names) — leave without `data-i18n`.

## Current state & next steps (Aug 2026)
- Site was **rebuilt** as a single-page dev/IA portfolio (previous multi-page photo/video/ads site removed). Changes are in the working tree, **not committed yet**.
- Projects, skills, roadmap, and email are **placeholder content** — see `AVANCES_Y_SUGERENCIAS.txt` for the full pending checklist and suggestions. Do not invent real project links; ask the user for them.
- `.playwright-mcp/` and the `*.png` screenshots are test artifacts; exclude them (`.gitignore`) or delete before committing.

## Manual-testing gotchas
- Language toggle reads `sessionStorage.lang`. Soft reloads keep that state — to reset language, use a fresh tab or incognito.
- Scroll-reveal uses IntersectionObserver: sections start `opacity: 0` until scrolled into view. If a section looks blank in a screenshot, scroll to it first.

## Deployment
No CI in the repo. `main` is the deploy branch — push to `origin` (`git@github.com:choquevolqueta/new-porta.git`) and GitHub Pages redeploys choquevolqueta.github.io (wait for Pages to rebuild). Commit messages in this repo are short and in Spanish (e.g. `modificacion de publicidad`).

## Windows shell gotcha
PowerShell on this machine mangles non-ASCII output: Spanish accents and em-dashes render as `�`/`�` in `Get-Content`/`Select-String` output even though files are valid UTF-8 (no BOM). To read accented content, trust the `read` tool or `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)` — don't "fix" files based on mangled shell output.