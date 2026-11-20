# Web UI themes

A Reelix theme is a **folder**. Built-in themes and the ones you make use the same format:

```
themes/<id>/            built-in (in this repo, bundled into the web UI)
/data/themes/<id>/      installed ($REELIX_DATA/themes; served by the server; no rebuild)
  theme.json            manifest
  theme.css             token values under [data-theme="<id>"]
  *.woff2 *.png …       optional: fonts and images that theme.css refers to with url(./file)
```

Reelix ships two themes:

- **Marquee** (default): warm and cinematic. Near-black with amber, Fraunces for titles, a soft light behind the app, and pill-shaped controls.
- **Paper**: light and editorial. Off-white paper with ink and one vermilion accent. Newsreader serif for titles and the agent's prose, square corners, and the owner's message set as a quotation.

The owner picks a theme in **Settings → Appearance**, or from the owner menu at the bottom of the sidebar. Installed themes appear next to the built-in ones. "Match device" follows the OS: dark gives Marquee, light gives Paper. The choice is kept in the browser (`localStorage["reelix.theme"]`), and an inline script in `src/pages/index.astro` applies it before the first paint.

## Make a theme (for developers and owners)

```sh
reelix theme new neon-noir --from marquee --name "Neon Noir"   # copies a theme into /data/themes/neon-noir/
$EDITOR /data/themes/neon-noir/theme.css                        # change token values
reelix theme check neon-noir                                    # manifest, selector, tokens, safety
# reload the web UI → Settings → Appearance → Neon Noir
```

The same steps are available as operations (`theme.new`, `theme.check`, `theme.list`) for the agent, which has a `themes` skill. You can simply ask it: "make me a theme like an old cinema ticket".

### theme.json

```json
{
  "id": "neon-noir",
  "name": { "en": "Neon Noir", "zh": "霓虹黑", "fr": "Néon noir", "ru": "Неоновый нуар" },
  "description": { "en": "Black, magenta and cyan." },
  "scheme": "dark",
  "base": "marquee",
  "swatches": ["#07060b", "#ff2e88", "#3df5ff", "#f4f1ff"],
  "author": "you",
  "version": "1.0.0"
}
```

- `id` must equal the folder name: lowercase letters, digits and dashes, 2–40 characters. It can't be `marquee` or `paper`.
- `name` and `description` are either a string or an object keyed by language (`en`, `zh`, `fr`, `ru`). The UI shows the one for its language, falling back to `en`.
- `scheme` (`dark`/`light`) sets the browser's form controls and scrollbars.
- `base` (`marquee`/`paper`): any token your CSS leaves out comes from the base, so a theme can be three lines long. Without a base, every token must be set.

### theme.css

```css
[data-theme="neon-noir"] {
  --bg: #07060b;
  --primary: #ff2e88;
  --primary-fg: #07060b;
  --nav-active: #ff2e88;
  --nav-active-fg: #07060b;
  --display-font: "Neon Display", var(--ui-font);
  --theme-color: #07060b;
}
@font-face { font-family: "Neon Display"; src: url(./neon-display.woff2) format("woff2"); font-display: swap; }
```

The token contract is `themes/tokens.json` (69 tokens); `themes/marquee/theme.css` is the commented reference. The groups are:

| Group | Tokens |
| --- | --- |
| Colours (shadcn names) | `--bg --fg --card --card-fg --popover --popover-fg --primary --primary-fg --secondary --secondary-fg --muted --muted-fg --accent --accent-fg --destructive --destructive-fg --border --input --ring --success --warning --info --rating` |
| Quiet fills | `--surface --surface-hover --line --well --overlay --scrollbar` |
| Navigation and messages | `--nav-active --nav-active-fg --user-bubble --user-bubble-fg --user-radius --user-padding --user-font --user-style --user-size --user-leading --user-quote-open --user-quote-close` |
| Type | `--ui-font --display-font --prose-font --mono-font --prose-size --prose-leading --display-weight --display-tracking` |
| Shape and surfaces | `--radius --radius-control --panel-* --card-bg --card-border --card-shadow --feature-* --raised-* --glow --ambient --theme-color` |

**`theme.check` rejects these, because a theme runs inside your private UI:**
- `@import`, and `url()` pointing at a web address. CSS attribute selectors can leak what you type to whoever serves those URLs, so a theme must be self-contained.
- SVG files: served from Reelix's own origin, an SVG can run script.
- `expression()`, `behavior:` and `-moz-binding`.
- `url()` paths that leave the folder, or point at files that don't exist.
- A `theme.css` over 512 KB.

The server serves only CSS, JSON, fonts, PNG, JPEG and WebP from a theme folder, and a theme that fails the check is not offered in the UI. Ship font files only under a licence that allows it (OFL is the usual one).

### Sharing a theme

A theme is just its folder: zip it, publish it, and the receiver unpacks it into `/data/themes/`. Include a `README` and `LICENSE` if you like; the server never serves them.

## How it fits together (for UI contributors)

| Layer | Where | What |
| --- | --- | --- |
| Values | `themes/<id>/theme.css`, `/data/themes/<id>/theme.css` | Raw custom properties per theme. Built-ins are also selected by `[data-base="<id>"]` so installed themes can inherit; Marquee is also `:root`. |
| Names | `packages/web/src/styles/global.css` `@theme inline` | Tailwind names for the tokens: `bg-background`, `text-primary`, `bg-surface`, `border-line`, `bg-well`, `text-rating`, `bg-nav-active`, `rounded-control`, `font-display`, `font-prose`… |
| Recipes | `global.css` `@layer components` | `.panel`, `.surface-card`, `.raised`, `.feature`, `.user-msg`, `.display`, `.ambient`, plus the `glow` utility. |
| Registry | `packages/web/src/lib/theme.ts` | Built-in manifests and installed ones (from `GET /api/themes`). Injects installed stylesheets; provides `useTheme()`, `setTheme()` and `themeAttrs(id)`. |
| Server | `packages/core/src/themes.ts`, `packages/server/src/http.ts` | `theme.list/new/check`; `GET /api/themes` and `GET /api/themes/:id/:file`. |

Rules for components:
- **Use token classes, never raw colours.** Write `bg-surface`, not `bg-white/[0.03]`.
  - **Exception:** text over a poster image may use `text-white` and `bg-black/60`.
  - **Exception:** captcha images keep `bg-white`.
- **Keep per-theme differences in tokens.** If a component should look different per theme, add a token and read it in a recipe. Do not write `[data-theme="paper"] .x` selectors: a descendant selector also matches previews nested inside another theme (Settings draws every theme's preview inside the current one with `themeAttrs(id)`).
- **Recipes live in `@layer components`,** so utilities on an element still win.
- **When you add a token,** add it to `themes/tokens.json`, to both built-in themes and to this table. Installed themes with a `base` inherit it automatically.

## Fonts

The built-in fonts are self-hosted from `dist/`, all OFL: Inter, Fraunces, Newsreader, JetBrains Mono, Noto Serif (Cyrillic for the serif faces) and Noto Sans/Serif SC. Every family is split by `unicode-range`, so a page fetches only the slices it needs; Chinese and Russian text pull in their own slices on demand.
