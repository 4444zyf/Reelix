/**
 * The contributor's commands (docs/plugins.md §14.2): `reelix plugin new`, `check` and `dev`.
 * None of them needs a running Reelix; `dev` starts one of its own.
 */
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CORE_OPERATIONS, Reelix, errorMessage } from "@reelix/core";
import { CHECK_FILE, checkPluginFolder, settingsCopy } from "@reelix/plugin-testing";

const REPO = resolve(import.meta.dirname, "../../..");
const TEMPLATES = join(REPO, "packages/cli/templates");
const ID = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

/**
 * What `reelix plugin new` can write. A kind with `from` is generated from that reference plugin, with the
 * test in `templates/<kind>`; the others are whole plugins in `templates/<kind>`.
 */
export const PLUGIN_KINDS: Record<string, { label: string; from?: string }> = {
	"subtitle-source": { label: "subtitle source: finds and downloads subtitles from a site (seam reelix:subtitle.source@1)" },
	indexer: { label: "indexer: searches a tracker for releases (seam reelix:indexer@1)" },
	notifier: { label: "notifier: sends Reelix's notices to a service (seam reelix:notifier@1)" },
	filter: { label: "hook release.filter: hides releases, with a reason", from: "plugins/examples/block-words" },
	rank: { label: "hook release.rank: puts releases in another order", from: "plugins/examples/prefer-freeleech" },
	name: { label: "hook organise.name: changes the names of filed files", from: "plugins/examples/name-with-resolution" },
	notice: { label: "hook notify.before: changes the wording of notices", from: "plugins/examples/short-notices" },
	skills: { label: "skill pack: instructions and scripts for the agent, no code", from: "plugins/examples/seeding-report" },
};

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

/** Ids a new plugin cannot take: the first words of Reelix's operations and the built-in plugins' ids. */
function takenIds(): Set<string> {
	const taken = new Set(CORE_OPERATIONS.map((o) => o.name.split(".")[0]!));
	for (const root of [join(REPO, "plugins"), join(REPO, "plugins/examples")])
		for (const name of readdirSync(root)) if (existsSync(join(root, name, "package.json"))) taken.add(readJson(join(root, name, "package.json")).reelix?.id);
	return taken;
}

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Write a working plugin of this kind with this id into `dir`, which must not exist or be empty. Returns the files written. */
export function writePlugin(kind: string, id: string, dir: string): string[] {
	const k = PLUGIN_KINDS[kind];
	if (!k) throw new Error(`There is no kind "${kind}". Kinds: ${Object.keys(PLUGIN_KINDS).join(", ")}.`);
	if (!ID.test(id)) throw new Error(`"${id}" is not a valid plugin id: use 2 to 40 lowercase letters, digits and hyphens, starting with a letter.`);
	if (takenIds().has(id)) throw new Error(`The id "${id}" is taken by Reelix itself or one of its plugins; choose another.`);
	if (dir === REPO || dir.startsWith(REPO + sep)) throw new Error(`${dir} is inside Reelix's own folder. A plugin of yours lives outside it: name a folder elsewhere, such as ~/reelix-plugins/${id}.`);
	if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty.`);

	const template = join(TEMPLATES, kind);
	const source = k.from ? join(REPO, k.from) : template;
	const oldId = readJson(join(source, "package.json")).reelix.id as string;
	mkdirSync(dir, { recursive: true });
	const copy = (from: string, skip: string[]) => {
		for (const name of readdirSync(from)) if (!skip.includes(name)) cpSync(join(from, name), join(dir, name), { recursive: true });
	};
	// A reference plugin's own tests use Reelix's internals; the template's test uses only @reelix/plugin-testing.
	copy(source, k.from ? ["test", "node_modules"] : ["node_modules"]);
	if (k.from) copy(template, []);

	const pkg = readJson(join(dir, "package.json"));
	const manifest = {
		name: pkg.name,
		version: "0.1.0",
		description: String(pkg.description ?? "").replace(/^Reference (plugin|skill pack): (\w)/, (_m, _what, first: string) => first.toUpperCase()),
		type: "module",
		license: "MIT",
		keywords: pkg.keywords,
		scripts: { test: "node --test 'test/**/*.test.ts'" },
		...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
		reelix: pkg.reelix,
	};
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	// The id, in every file and every path.
	for (const file of files(dir)) {
		const text = readFileSync(file, "utf8");
		if (text.includes(oldId)) writeFileSync(file, text.replaceAll(oldId, id));
	}
	const rename = (d: string) => {
		for (const name of readdirSync(d)) {
			let path = join(d, name);
			if (name.includes(oldId)) renameSync(path, (path = join(d, name.replaceAll(oldId, id))));
			if (statSync(path).isDirectory()) rename(path);
		}
	};
	rename(dir);

	const fill = (text: string) => text.replaceAll("{{id}}", id).replaceAll("{{kind}}", k.label).replaceAll("{{from}}", k.from ? `\`${k.from}\` in Reelix` : "a template of Reelix").replaceAll("{{reelix}}", REPO);
	writeFileSync(join(dir, "README.md"), fill(readFileSync(join(TEMPLATES, "README.md"), "utf8")));
	writeFileSync(join(dir, "AGENTS.md"), fill(readFileSync(join(TEMPLATES, "AGENTS.md"), "utf8")));
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");

	// Until the packages are published (docs/plugins.md §13.5), the tests reach them in this Reelix.
	for (const name of ["plugin", "plugin-testing"]) {
		const link = join(dir, "node_modules", "@reelix", name);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(join(REPO, "packages", name), link, "dir");
	}
	return files(dir).map((f) => relative(dir, f)).sort();
}

/** `reelix plugin new [<folder>] [--kind <kind>] [--id <id>]`; asks for what is missing when `ask` is given. */
export async function pluginNew(args: string[], ask?: (question: string) => Promise<string>): Promise<void> {
	const flag = (name: string) => {
		const i = args.indexOf(`--${name}`);
		return i >= 0 ? args.splice(i, 2)[1] : undefined;
	};
	let kind = flag("kind");
	let id = flag("id");
	const folder = args.find((a) => !a.startsWith("--"));
	const names = Object.keys(PLUGIN_KINDS);
	if ((!kind || !id) && !ask) throw new Error(`Not at a terminal: give --kind (${names.join(", ")}) and --id.`);
	if (!kind) {
		console.log("What kind of plugin?");
		names.forEach((n, i) => console.log(`  ${i + 1}. ${PLUGIN_KINDS[n]!.label}`));
		const answer = (await ask!(`Number or name [1-${names.length}]: `)).trim();
		kind = names[Number(answer) - 1] ?? answer;
	}
	if (!PLUGIN_KINDS[kind]) throw new Error(`There is no kind "${kind}". Kinds: ${names.join(", ")}.`);
	id ??= (await ask!("Its id (lowercase letters, digits and hyphens, such as my-indexer): ")).trim();
	const dir = resolve(folder ?? id);
	const written = writePlugin(kind, id, dir);
	console.log(`Wrote the ${kind} plugin "${id}" to ${dir}:`);
	for (const f of written) console.log(`  ${f}`);
	console.log(`node_modules/@reelix links to this Reelix's @reelix/plugin and @reelix/plugin-testing.`);
	console.log(`\nNext, in ${dir}:\n  npm test               its own tests\n  reelix plugin check .  the checks Reelix runs on it\n  reelix plugin dev .    try it in a Reelix with fake services\nREADME.md says what to change; ${join(REPO, "docs/plugin-guide.md")} explains every part.`);
}

/** `reelix plugin check <folder> [--write-settings]`. Returns the exit code. */
export async function pluginCheck(args: string[]): Promise<number> {
	const folder = args.find((a) => !a.startsWith("--"));
	if (!folder) throw new Error("Usage: reelix plugin check <folder> [--write-settings]");
	const dir = resolve(folder);
	if (!existsSync(join(dir, "package.json"))) throw new Error(`${dir} has no package.json: name the folder of a plugin.`);
	if (args.includes("--write-settings")) {
		const copy = await settingsCopy(dir);
		if (copy) {
			writeFileSync(copy.file, copy.expected);
			console.log(`Wrote ${relative(dir, copy.file)} from the settings schema in the code.`);
		} else console.log("The plugin has no settings: nothing to write.");
	}
	console.log(`Checking ${dir}${existsSync(join(dir, CHECK_FILE)) ? ` with ${CHECK_FILE}` : ""}`);
	// What Reelix logs while it runs the plugin is shown only when something failed.
	const logged: string[] = [];
	const saved = { log: console.log, warn: console.warn, error: console.error };
	console.log = console.warn = console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
	let r: Awaited<ReturnType<typeof checkPluginFolder>>;
	try {
		r = await checkPluginFolder(dir);
	} finally {
		Object.assign(console, saved);
	}
	for (const p of r.passed) console.log(`  ok    ${p}`);
	for (const w of r.warnings) console.log(`  warn  ${w}`);
	for (const e of r.errors) console.log(`  FAIL  ${e}`);
	if (r.errors.length) {
		if (logged.length) console.log(`\nWhat Reelix logged while it ran the plugin:\n${logged.map((l) => `  ${l}`).join("\n")}`);
		console.log(`\nFailed: ${r.errors.length} problem${r.errors.length === 1 ? "" : "s"}.`);
		return 1;
	}
	console.log(r.warnings.length ? `\nPassed, with ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}.` : "\nPassed.");
	return 0;
}

/** A port nothing listens on now. */
function freePort(): Promise<number> {
	return new Promise((done, fail) => {
		const s = createServer();
		s.once("error", fail);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as { port: number };
			s.close(() => done(port));
		});
	});
}

/**
 * `reelix plugin dev <folder> [--port <n>]`: a Reelix of its own in a temporary folder, with the demo's fake
 * services, the plugin loaded from the folder without an install record or hash, and a banner in the web UI
 * (docs/plugins.md §13.3). The folder can only be named here. Code is read when the plugin starts.
 */
export async function pluginDev(args: string[]): Promise<void> {
	const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--port");
	if (!folder) throw new Error("Usage: reelix plugin dev <folder> [--port <n>]");
	const dir = resolve(folder);
	if (!existsSync(join(dir, "package.json"))) throw new Error(`${dir} has no package.json: name the folder of a plugin.`);
	const portArg = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : undefined;
	if (portArg !== undefined && !(Number.isInteger(portArg) && portArg > 0 && portArg < 65536)) throw new Error("--port must be a port number.");

	const { startDemo } = await import("@reelix/server/demo.ts");
	const { startServer } = await import("@reelix/server/main.ts");
	const base = mkdtempSync(join(tmpdir(), "reelix-plugin-dev-"));
	process.on("exit", () => rmSync(base, { recursive: true, force: true }));
	const root = join(base, "data");
	const password = randomBytes(12).toString("base64url");
	console.log(await startDemo(root, { password, model: process.env.REELIX_DEMO_MODEL }));
	const port = portArg ?? (await freePort());
	const app = new Reelix(root);
	app.setConfig("web", { ...app.config.web, host: "127.0.0.1", port });
	app.close();
	process.env.REELIX_DATA = root;
	try {
		await startServer({ devPlugin: dir });
	} catch (e) {
		throw new Error(`Reelix could not start: ${errorMessage(e)}`);
	}
	console.log(
		[
			"",
			`Plugin development: ${dir} is loaded without approval or file hashes. Restart this command to load changed code.`,
			`Open http://127.0.0.1:${port} and sign in with the password ${password}`,
			`Other commands against this Reelix: REELIX_DATA=${root} reelix plugin list`,
			"Everything here is temporary and is deleted when you stop it (Ctrl-C).",
		].join("\n"),
	);
}
