---
name: themes
description: Making or changing a web UI theme for the owner (colours, fonts, "make it look like …"). Themes are folders of CSS tokens in /data/themes; no rebuild.
---

# Web UI themes

A theme is a folder `/data/themes/<id>/` holding:
- `theme.json`: `id` (the folder name), `name` (a string, or `{"en": …, "zh": …, "fr": …, "ru": …}`), `description`, `scheme` (`dark` or `light`), `base` (`marquee` or `paper`), `swatches`, `author`, `version`.
- `theme.css`: one block, `[data-theme="<id>"] { --token: value; … }`.
- Optionally, font files (`.woff2`) and images (`.png`, `.jpg`, `.webp`) that `theme.css` refers to with relative `url(...)`.

The web UI picks a new theme up when the page is reloaded (Settings → Appearance).

## Steps
1. Start from the closest built-in theme: `reelix theme new <id> --from marquee|paper --name "…"`. The copy sets every token; with `base` set, you can delete the tokens you don't change.
2. Edit only the token values in `/data/themes/<id>/theme.css`. Each token is described in `themes/tokens.json` in the repository, and docs/ui-themes.md explains them.
   - The main ones are `--bg`, `--fg`, `--primary`/`--primary-fg`, `--muted-fg`, `--border`, `--surface`, `--line`, `--card-bg`, `--raised-bg`, `--nav-active`, `--display-font`, `--radius`, `--radius-control` and `--ambient`. Also set `--theme-color` to the same value as `--bg`.
3. Run `reelix theme check <id>`. Fix every error; check warnings for typos.
4. Tell the owner to pick the theme in Settings → Appearance and reload the page.

## Rules
- **Keep the theme self-contained.** Don't use web URLs, `@import` or SVG files; the check rejects them. Fonts must be files inside the folder, under a licence that allows redistribution (OFL), and the owner should supply them or confirm the source.
- **Keep text readable.** `--fg` on `--bg`, `--primary-fg` on `--primary` and `--muted-fg` on `--bg` each need a contrast of at least 4.5:1. Work the contrast out from the colours; don't guess it.
- **Set `scheme` to match the colours,** so the browser draws scrollbars and form controls to suit.
- **Never edit the built-in themes** (`themes/` in the app). Copy them instead.
