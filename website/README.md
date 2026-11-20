# The Reelix website

One static page that introduces Reelix, in the four languages (English at the root, `/zh`, `/fr`, `/ru`). It uses the product's own two themes and fonts, loads nothing from another site, and works without JavaScript.

```sh
npm run site:build                                # writes website/dist
python3 -m http.server -d website/dist 8080       # look at it: http://localhost:8080
```

`website/dist` is plain files: any static host can serve it. Nothing publishes it.

| Path | What |
| --- | --- |
| `build.ts` | Checks that every language has English's keys, then writes the pages and copies fonts and images. |
| `src/page.ts` | The page, as a function of one language's strings. |
| `src/site.css`, `src/site.js` | Styles (Marquee and Paper tokens) and behaviour (theme switch, tabs, copy, the conversation in the hero). |
| `locales/<lang>.json` | Every string on the page. A new string goes into all four. |
| `assets/shots/<lang>/<theme>/` | Screenshots of the real web UI, one set per language and built-in theme; the page shows the set matching its own language and theme, and the project README uses the English ones. |
| `shots.ts` | Retakes one language's screenshots, in both themes, from a fresh demo (`scripts/demo.ts`); its header says how. Poster art is drawn by the script, because the demo's TMDB has no pictures. |

The conversation in the hero is an illustration written in HTML, and is labelled as one. The screens further down are real.
