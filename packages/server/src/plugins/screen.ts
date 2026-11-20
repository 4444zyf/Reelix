import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** A screen and everything put inline into it; larger is refused. */
const SCREEN_LIMIT = 1024 * 1024;

/**
 * What a screen may do inside its frame: run its own scripts and styles, show pictures given as data, and
 * nothing else. No request leaves the frame; the page outside talks to it by messages (docs/plugins.md §16, phase 8).
 */
export const SCREEN_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * `window.reelix` inside the frame: `run(operation, input)` runs one of the plugin's own operations (as the
 * plugin) and resolves with `{ output, text }`; `lang`, `theme`, `scheme` and `onContext(fn)` follow the owner's
 * language and theme tokens, which are also set as CSS variables (`--bg`, `--fg`, `--primary`, …).
 *
 * It says `ready` to the page once; the page answers with a message port, and everything after goes over that
 * port. A document the frame navigates to later never has the port (docs/plugins.md §16, phase 8).
 */
const BRIDGE = `(() => {
	const pending = new Map();
	const listeners = new Set();
	const waiting = [];
	const state = { lang: document.documentElement.lang || "en", theme: {}, scheme: "dark" };
	let port;
	let next = 1;
	const send = (m) => (port ? port.postMessage(m) : waiting.push(m));
	const receive = (m) => {
		if (!m || m.reelix !== 1) return;
		if (m.type === "context") {
			Object.assign(state, { lang: m.lang, theme: m.theme, scheme: m.scheme });
			const root = document.documentElement;
			for (const [k, v] of Object.entries(m.theme)) root.style.setProperty(k, v);
			root.lang = m.lang;
			root.style.colorScheme = m.scheme;
			for (const fn of listeners) fn({ lang: state.lang, theme: state.theme, scheme: state.scheme });
		} else if (m.type === "result" || m.type === "error") {
			const p = pending.get(m.id);
			if (!p) return;
			pending.delete(m.id);
			if (m.type === "result") p.resolve({ output: m.output, text: m.text });
			else p.reject(Object.assign(new Error(m.message), { code: m.code }));
		}
	};
	addEventListener("message", (e) => {
		if (port || e.source !== parent || !e.data || e.data.reelix !== 1 || e.data.type !== "connect" || !e.ports[0]) return;
		port = e.ports[0];
		port.onmessage = (ev) => receive(ev.data);
		for (const m of waiting.splice(0)) port.postMessage(m);
	});
	Object.defineProperty(window, "reelix", {
		value: Object.freeze({
			run(operation, input) {
				const id = next++;
				return new Promise((resolve, reject) => {
					pending.set(id, { resolve, reject });
					send({ reelix: 1, type: "run", id, operation, input: input ?? {} });
				});
			},
			get lang() { return state.lang; },
			get theme() { return state.theme; },
			get scheme() { return state.scheme; },
			onContext(fn) { listeners.add(fn); },
		}),
	});
	parent.postMessage({ reelix: 1, type: "ready" }, "*");
})();`;

/** A file the screen names, inside the screen's own folder. */
function own(folder: string, ref: string): string | undefined {
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) return undefined; // another site: the CSP refuses it anyway
	const file = join(folder, ref.split(/[?#]/)[0]!);
	if (!existsSync(file)) return undefined;
	const real = realpathSync(file);
	return real.startsWith(folder + sep) ? real : undefined;
}

/**
 * A plugin's screen as one document for a sandboxed frame: its HTML file, with the scripts and style sheets
 * it names from the screen's folder put inline, and Reelix's CSP and `window.reelix` ahead of everything it wrote.
 */
export function screenDocument(dir: string, entry: string, lang: string): string {
	const root = realpathSync(dir);
	const file = realpathSync(join(root, entry));
	if (!file.startsWith(root + sep)) throw new Error("the screen file is outside the plugin's folder");
	const folder = dirname(file);
	// Each file's size is checked before it is read: what is put inline counts too.
	let total = 0;
	const read = (f: string) => {
		const st = statSync(f);
		if (!st.isFile()) throw new Error(`${f} is not a file`);
		total += st.size;
		if (total > SCREEN_LIMIT) throw new Error(`the screen is larger than ${SCREEN_LIMIT / 1024} KB with what it puts inline`);
		return readFileSync(f, "utf8");
	};
	let html = read(file);
	html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (whole, before: string, ref: string, after: string) => {
		const found = own(folder, ref);
		return found ? `<script${before}${after}>${read(found).replace(/<\/script/gi, "<\\/script")}</script>` : whole;
	});
	html = html.replace(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi, (whole) => {
		const ref = /\bhref\s*=\s*["']([^"']+)["']/i.exec(whole)?.[1];
		const found = ref && own(folder, ref);
		return found ? `<style>${read(found).replace(/<\/style/gi, "<\\/style")}</style>` : whole;
	});
	const head = `<meta http-equiv="Content-Security-Policy" content="${SCREEN_CSP}"><meta charset="utf-8"><script>document.documentElement.lang = ${JSON.stringify(lang)};\n${BRIDGE}</script>`;
	const document = `<!doctype html>${head}${html.replace(/^\s*<!doctype[^>]*>/i, "")}`;
	if (Buffer.byteLength(document) > SCREEN_LIMIT) throw new Error(`the screen is larger than ${SCREEN_LIMIT / 1024} KB with what it puts inline`);
	return document;
}
