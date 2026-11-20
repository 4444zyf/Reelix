/** The website's one page, as a function of a language's strings (website/locales/<lang>.json). */
import en from "../locales/en.json" with { type: "json" };

export type Strings = typeof en;
export const LANGS = ["en", "zh", "fr", "ru"] as const;
export type Lang = (typeof LANGS)[number];

const LANG_NAMES: Record<Lang, string> = { en: "English", zh: "简体中文", fr: "Français", ru: "Русский" };
const HTML_LANG: Record<Lang, string> = { en: "en", zh: "zh-Hans", fr: "fr", ru: "ru" };
const REPO = "https://github.com/4444zyf/Reelix";
const doc = (name: string) => `${REPO}/blob/main/docs/${name}`;

/** Not translated: these are names. */
const WORKS_WITH = ["pi", "qBittorrent", "Jackett", "Jellyfin", "TMDB", "Bangumi", "Douban", "Telegram", "Web Push", "Infuse", "magpie"];
/** The releases in the hero illustration: the ones the demo's fake indexers return (packages/server/src/demo.ts). */
const RELEASES = [
	{ name: "Sintel.2010.1080p.BluRay.x264-GRP", tags: ["1080p", "BluRay", "x264"], size: "1.2 GB", seeders: 40, picked: true },
	{ name: "Sintel.2010.2160p.WEB-DL.x265-OTHER", tags: ["2160p", "WEB-DL", "x265"], size: "4.0 GB", seeders: 12 },
	{ name: "Sintel.2010.1080p.CAM.x264-NOPE", tags: ["1080p", "CAM"], size: "668 MB", seeders: 300, skipped: true },
];

const e = (s: string | number) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A shell block: lines of [command, comment?]. The copy button takes the commands only. */
function shell(lines: [string, string?][], t: Strings): string {
	const text = lines.map(([c]) => c).join("\n");
	return `<div class="term">
	<button class="copy" type="button" data-copy="${e(text)}" data-done="${e(t.start.copied)}">${e(t.start.copy)}</button>
	<pre><code>${lines.map(([c, note]) => `<span class="p">$</span> ${e(c)}${note ? `  <span class="c"># ${e(note)}</span>` : ""}`).join("\n")}</code></pre>
</div>`;
}

const ICONS = {
	check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
	arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
	theme: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4v16" /><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/></svg>`,
	replay: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 108-8H7M10 1L7 4l3 3"/></svg>`,
	github: `<svg viewBox="0 0 24 24" aria-hidden="true" class="solid"><path d="M12 2a10 10 0 00-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.600-1.100-4.600-5a3.900 3.900 0 011-2.700c-.1-.3-.4-1.300.1-2.600 0 0 .8-.3 2.800 1a9.500 9.500 0 015 0c1.900-1.300 2.700-1 2.700-1 .6 1.300.2 2.300.1 2.600a3.900 3.900 0 011 2.700c0 3.900-2.300 4.700-4.600 5 .4.300.7.900.7 1.900v2.800c0 .300.200.600.700.500A10 10 0 0012 2z"/></svg>`,
};

export function render(t: Strings, lang: Lang): string {
	const base = lang === "en" ? "./" : "../";
	const href = (l: Lang) => (l === "en" ? base : `${base}${l}/`);
	const [marquee, paper] = t.footer.themes;

	return `<!doctype html>
<html lang="${HTML_LANG[lang]}" data-theme="marquee">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(t.meta.title)}</title>
<meta name="description" content="${e(t.meta.description)}">
<meta property="og:title" content="${e(t.meta.title)}">
<meta property="og:description" content="${e(t.meta.description)}">
<meta property="og:type" content="website">
<meta property="og:image" content="${base}assets/shots/chat.webp">
<meta name="theme-color" content="#0c0a08">
<link rel="icon" href="${base}assets/icon.png" type="image/png">
${LANGS.filter((l) => l !== lang).map((l) => `<link rel="alternate" hreflang="${HTML_LANG[l]}" href="${href(l)}">`).join("\n")}
<link rel="preload" href="${base}fonts/fraunces-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${base}site.css">
<script>try{var m=localStorage.getItem("reelix-site-theme");if(m)document.documentElement.dataset.theme=m}catch(e){}</script>
</head>
<body>
<div class="ambient" aria-hidden="true"></div>

<header class="top">
	<a class="brand" href="${base}">Reelix<i>.</i></a>
	<nav class="links" aria-label="${e(t.nav.start)}">
		<a href="#loop">${e(t.nav.loop)}</a>
		<a href="#agent">${e(t.nav.agent)}</a>
		<a href="#screens">${e(t.nav.screens)}</a>
		<a href="#plugins">${e(t.nav.plugins)}</a>
	</nav>
	<div class="tools">
		<details class="lang">
			<summary aria-label="${e(t.nav.language)}">${LANG_NAMES[lang]}</summary>
			<ul>${LANGS.map((l) => `<li><a href="${href(l)}" lang="${HTML_LANG[l]}"${l === lang ? ' aria-current="true"' : ""}>${LANG_NAMES[l]}</a></li>`).join("")}</ul>
		</details>
		<button class="icon" type="button" id="theme" aria-label="${e(t.nav.theme)}" title="${e(marquee)} / ${e(paper)}">${ICONS.theme}</button>
		<a class="icon" href="${REPO}" aria-label="GitHub">${ICONS.github}</a>
		<a class="btn small" href="#start">${e(t.nav.start)}</a>
	</div>
</header>

<main>
<section class="hero">
	<div class="hero-copy">
		<p class="eyebrow">${e(t.hero.eyebrow)}</p>
		<h1><span>${e(t.hero.line1)}</span> <em>${e(t.hero.line2)}</em></h1>
		<p class="lead">${e(t.hero.lead)}</p>
		<p class="actions">
			<a class="btn" href="#start">${e(t.hero.primary)} ${ICONS.arrow}</a>
			<a class="btn ghost" href="${REPO}">${ICONS.github} ${e(t.hero.secondary)}</a>
		</p>
		<p class="fine">${e(t.hero.note)}</p>
	</div>

	<figure class="demo" id="demo" aria-label="${e(t.demo.label)}">
		<div class="demo-bar"><i></i><i></i><i></i><span>Reelix<b>.</b></span></div>
		<div class="demo-body">
			<p class="bubble" data-step>${e(t.demo.user)}</p>
			<ol class="steps">
				${t.demo.steps.slice(0, 2).map((s) => `<li data-step>${ICONS.check}<span>${e(s)}</span></li>`).join("\n\t\t\t\t")}
			</ol>
			<div class="title-card" data-step>
				<div class="poster" aria-hidden="true"><span>Sintel</span></div>
				<div>
					<h3>Sintel</h3>
					<p class="meta"><span>2010</span><span>${e(t.demo.kind)}</span><span>${e(t.demo.minutes)}</span><span class="star">★ 7.5</span></p>
					<p class="overview">${e(t.demo.overview)}</p>
				</div>
			</div>
			<ul class="releases" data-step>
				${RELEASES.map(
					(r) => `<li class="${r.picked ? "picked" : r.skipped ? "skipped" : ""}">
					<code>${e(r.name)}</code>
					<p>${r.tags.map((x) => `<span class="tag">${x}</span>`).join("")}<span>${r.size}</span><span>↑ ${r.seeders}</span>${
						r.picked ? `<b>${e(t.demo.picked)}</b><span class="why">${e(t.demo.reason)}</span>` : r.skipped ? `<b>${e(t.demo.skipped)}</b><span class="why">${e(t.demo.skipReason)}</span>` : ""
					}</p>
				</li>`,
				).join("\n\t\t\t\t")}
			</ul>
			<ol class="steps">
				${t.demo.steps.slice(2).map((s) => `<li data-step>${ICONS.check}<span>${e(s)}</span></li>`).join("\n\t\t\t\t")}
			</ol>
			<p class="answer" data-step>${e(t.demo.answer)} <span class="badge">${e(t.demo.inLibrary)}</span></p>
		</div>
		<div class="demo-input"><span>${e(t.demo.placeholder)}</span><button type="button" id="replay" aria-label="${e(t.demo.replay)}" title="${e(t.demo.replay)}">${ICONS.replay}</button></div>
		<figcaption>${e(t.demo.label)}</figcaption>
	</figure>
</section>

<div class="ticker" aria-hidden="true"><div>${[0, 1, 2, 3].map(() => t.ticker.map((w) => `<span>${e(w)}</span>`).join("")).join("")}</div></div>

<section id="loop" class="block">
	<header class="head"><h2>${e(t.loop.title)}</h2><p>${e(t.loop.lead)}</p></header>
	<ol class="strip">
		${t.loop.steps.map((s, i) => `<li><span class="n">${String(i + 1).padStart(2, "0")}</span><h3>${e(s.name)}</h3><p>${e(s.text)}</p></li>`).join("\n\t\t")}
	</ol>
</section>

<section id="agent" class="block">
	<header class="head"><h2>${e(t.agent.title)}</h2><p>${e(t.agent.lead)}</p></header>
	<div class="three">
		${t.agent.points.map((p) => `<article class="card"><h3>${e(p.title)}</h3><p>${e(p.text)}</p></article>`).join("\n\t\t")}
	</div>

</section>

<section id="features" class="block">
	<header class="head"><h2>${e(t.features.title)}</h2><p>${e(t.features.lead)}</p></header>
	<div class="grid">
		${t.features.items.map((s) => `<article><h3>${e(s.title)}</h3><p>${e(s.text)}</p></article>`).join("\n\t\t")}
	</div>
</section>

<section id="screens" class="block wide">
	<header class="head"><h2>${e(t.screens.title)}</h2><p>${e(t.screens.lead)}</p></header>
	<div class="tabs center" role="tablist" data-tabs="shot">
		${t.screens.tabs.map((s, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${s.id}">${e(s.name)}</button>`).join("")}
	</div>
	<div class="screen">
		${t.screens.tabs
			.map(
				(s, i) => `<figure data-pane="shot" data-id="${s.id}"${i ? " hidden" : ""}>
			<img src="${base}assets/shots/${s.id}.webp" alt="${e(s.name)}" width="1440" height="900" loading="lazy" decoding="async">
			<figcaption>${e(s.caption)}</figcaption>
		</figure>`,
			)
			.join("\n\t\t")}
	</div>
</section>

<section id="plugins" class="block">
	<header class="head"><h2>${e(t.plugins.title)}</h2><p>${e(t.plugins.lead)}</p></header>
	<div class="three plug">
		<article class="card">
			<h3>${e(t.plugins.seamsTitle)}</h3><p>${e(t.plugins.seamsText)}</p>
			<ul class="chips">${t.plugins.seams.map((s) => `<li>${e(s)}</li>`).join("")}</ul>
		</article>
		<article class="card">
			<h3>${e(t.plugins.hooksTitle)}</h3><p>${e(t.plugins.hooksText)}</p>
			<ul class="chips">${t.plugins.hooks.map((s) => `<li>${e(s)}</li>`).join("")}</ul>
		</article>
		<article class="card">
			<h3>${e(t.plugins.moreTitle)}</h3><p>${e(t.plugins.moreText)}</p>
			<p class="fine">${e(t.plugins.ask)} <a href="${doc("plugin-guide.md")}">${e(t.plugins.guide)} →</a></p>
		</article>
	</div>
</section>

<section id="safety" class="block">
	<header class="head"><h2>${e(t.safety.title)}</h2><p>${e(t.safety.lead)}</p></header>
	<div class="grid">
		${t.safety.items.map((s) => `<article><h3>${e(s.title)}</h3><p>${e(s.text)}</p></article>`).join("\n\t\t")}
	</div>
</section>

<section class="works">
	<h2>${e(t.works.title)}</h2>
	<ul>${WORKS_WITH.map((w) => `<li>${w}</li>`).join("")}</ul>
	<p>English · 简体中文 · Français · Русский</p>
</section>

<section id="start" class="block start">
	<header class="head"><h2>${e(t.start.title)}</h2><p>${e(t.start.lead)}</p></header>
	<div class="tabs center" role="tablist" data-tabs="start">
		${t.start.tabs.map((s, i) => `<button type="button" role="tab" aria-selected="${i === 0}" data-tab="${i}">${e(s)}</button>`).join("")}
	</div>
	<div data-pane="start" data-id="0">${shell(
		[
			[`git clone ${REPO}.git && cd Reelix`],
			["sudo bash preflight/reelix-preflight.sh", t.start.comments.preflight],
			["cp .env.example .env", t.start.comments.env],
			["docker compose up -d", t.start.comments.up],
			["docker compose exec reelix pi", t.start.comments.pi],
		],
		t,
	)}</div>
	<div data-pane="start" data-id="1" hidden>${shell(
		[
			["npm install"],
			["npm run web:build", t.start.comments.build],
			["export REELIX_DATA=$PWD/.dev-data"],
			["bin/reelix config set models.roles.chat provider/model-id"],
			["bin/reelix serve", t.start.comments.serve],
		],
		t,
	)}</div>
	<div data-pane="start" data-id="2" hidden>${shell(
		[
			["export REELIX_DATA=/tmp/reelix-try REELIX_PI_DIR=~/.pi/agent"],
			["export REELIX_DEMO_PASSWORD=choose-one REELIX_DEMO_MODEL=provider/model-id"],
			["node --no-warnings --disable-sigusr1 scripts/demo.ts", t.start.comments.demo],
		],
		t,
	)}</div>
	<p class="status">${e(t.start.status)}</p>
</section>
</main>

<footer class="foot">
	<div>
		<a class="brand" href="${base}">Reelix<i>.</i></a>
		<p>${e(t.footer.tagline)}</p>
	</div>
	<nav aria-label="${e(t.footer.docs)}">
		<h2>${e(t.footer.docs)}</h2>
		<a href="${doc("2026-11-17-reelix-design.md")}">${e(t.footer.design)}</a>
		<a href="${doc("deployment.md")}">${e(t.footer.deployment)}</a>
		<a href="${doc("plugin-guide.md")}">${e(t.footer.guide)}</a>
		<a href="${doc("plugin-reference.md")}">${e(t.footer.reference)}</a>
	</nav>
	<nav aria-label="${e(t.footer.project)}">
		<h2>${e(t.footer.project)}</h2>
		<a href="${REPO}">${e(t.footer.source)}</a>
		<a href="${REPO}/blob/main/LICENSE">${e(t.footer.licence)}</a>
	</nav>
</footer>

<script src="${base}site.js" defer></script>
</body>
</html>
`;
}
