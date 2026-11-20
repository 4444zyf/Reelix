import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { type PluginSource, ReelixError } from "@reelix/core";
import { compareVersions, parseVersion } from "./semver.ts";

/**
 * Where installed plugins come from (docs/plugins.md §13.1). Each kind is one implementation of
 * `Source`, so a later index or signed packages are one more. None of them runs anything from the
 * package: they only put its files in a folder.
 */
export type Source = {
	kind: PluginSource["kind"];
	/** The source this text names, or nothing when it is not this kind. Refuses one of this kind that is not pinned. */
	parse(text: string): PluginSource | undefined;
	/** Put the package's own files (no dependencies) into the folder `into`, which does not exist yet. */
	fetch(source: PluginSource, into: string, env: SourceEnv): Promise<void>;
	/** Newer versions than the installed one, without installing anything. `installed` is the plugin's folder. */
	newer(source: PluginSource, version: string, installed: string, env: SourceEnv): Promise<{ to: string; label: string }[]>;
	/** The source of the version `to` (from `newer`). */
	at(source: PluginSource, to: string | undefined): PluginSource;
};

export type SourceEnv = { npmCache: string; hashFiles: (dir: string) => string };

const MINUTE = 60_000;

/** Run a program without a shell; its error carries what it printed. */
export function run(file: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { cwd: o.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", ...o.env }, timeout: o.timeoutMs ?? 5 * MINUTE, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${basename(file)} ${args[0] ?? ""} failed: ${(stderr || error.message).trim().split("\n").slice(-6).join("\n")}`));
			else resolve(stdout);
		});
	});
}

const notPinned = (what: string) => new ReelixError("not_pinned", what);

// ---------------------------------------------------------------- a local folder

/** Copied as it is, without `node_modules` and `.git`; the copy is what is hashed and approved. */
const folder: Source = {
	kind: "folder",
	parse(text) {
		if (!isAbsolute(text)) return undefined;
		if (!existsSync(text) || !statSync(text).isDirectory()) throw new ReelixError("not_found", `There is no folder ${text}.`);
		return { kind: "folder", location: text };
	},
	async fetch(source, into) {
		cpSync(source.location, into, { recursive: true, verbatimSymlinks: true, filter: (src) => !["node_modules", ".git"].includes(basename(src)) || src === source.location });
	},
	async newer(source, _version, installed, env) {
		if (!existsSync(source.location)) throw new Error(`the folder ${source.location} is gone`);
		const scratch = `${installed}.compare-${process.pid}`;
		try {
			await folder.fetch(source, scratch, env);
			const now = env.hashFiles(scratch);
			return now === env.hashFiles(installed) ? [] : [{ to: "folder", label: "the folder has changed" }];
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	at: (source) => source,
};

// ---------------------------------------------------------------- git, pinned to a commit

const GIT_URL = /^(?:git\+)?((?:https?|ssh|git|file):\/\/[^#\s]+|[\w.-]+@[\w.-]+:[^#\s]+)(?:#(.*))?$/;
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

const git: Source = {
	kind: "git",
	parse(text) {
		const m = GIT_URL.exec(text);
		if (!m) return undefined;
		const ref = m[2] ?? "";
		if (!COMMIT.test(ref)) throw notPinned(`A git source is pinned to a full commit id: ${m[1]}#<40 hex characters>. ${ref ? `"${ref}" looks like a branch or tag, which can move;` : "There is no commit after #;"} use the commit it points to now (git ls-remote ${m[1]}).`);
		return { kind: "git", location: m[1]!, pin: ref };
	},
	async fetch(source, into) {
		const commit = source.pin!;
		mkdirSync(into);
		await run("git", ["init", "-q", into]);
		try {
			await run("git", ["-C", into, "fetch", "-q", "--depth", "1", "--no-tags", "--", source.location, commit]);
		} catch {
			// A server that does not serve single commits: fetch its branches and tags and look for it there.
			await run("git", ["-C", into, "fetch", "-q", "--no-tags", "--", source.location, "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"]);
		}
		await run("git", ["-C", into, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit]).catch(() => {
			throw new ReelixError("not_found", `The commit ${commit} is not in ${source.location}.`);
		});
		const head = (await run("git", ["-C", into, "rev-parse", "HEAD"])).trim();
		if (head !== commit) throw new Error(`git checked out ${head}, not ${commit}`);
		rmSync(join(into, ".git"), { recursive: true, force: true });
	},
	async newer(source) {
		const lines = (await run("git", ["ls-remote", "--", source.location], { timeoutMs: MINUTE })).trim().split("\n").filter(Boolean);
		const refs = new Map<string, string>();
		for (const line of lines) {
			const [sha, ref] = line.split("\t") as [string, string];
			// An annotated tag's own line is followed by the commit it points to (`^{}`), which wins.
			refs.set(ref.replace(/\^\{\}$/, ""), sha);
		}
		const out: { to: string; label: string }[] = [];
		const head = refs.get("HEAD");
		const tags = [...refs].filter(([ref, sha]) => ref.startsWith("refs/tags/") && sha !== source.pin).map(([ref, sha]) => ({ name: ref.slice(10), sha }));
		const atHead = tags.filter((t) => t.sha === head).map((t) => `tag ${t.name}`);
		if (head && head !== source.pin) out.push({ to: head, label: `newest commit ${head.slice(0, 12)}${atHead.length ? ` (${atHead.join(", ")})` : ""}` });
		tags.sort((a, b) => {
			const va = parseVersion(a.name);
			const vb = parseVersion(b.name);
			return va && vb ? compareVersions(vb, va) : va ? -1 : vb ? 1 : b.name.localeCompare(a.name);
		});
		for (const t of tags.filter((t) => t.sha !== head).slice(0, 10)) out.push({ to: t.sha, label: `tag ${t.name} (${t.sha.slice(0, 12)})` });
		return out;
	},
	at: (source, to) => {
		if (!to || !COMMIT.test(to)) throw notPinned("Name the full commit id to update to (plugin.check_updates lists them).");
		return { ...source, pin: to };
	},
};

// ---------------------------------------------------------------- npm, pinned to an exact version

const NPM = /^npm:((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@(.*))?$/i;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const npm: Source = {
	kind: "npm",
	parse(text) {
		const m = NPM.exec(text);
		if (!m) return undefined;
		if (!m[2] || !EXACT.test(m[2])) throw notPinned(`An npm source is pinned to an exact version: npm:${m[1]}@1.2.3${m[2] ? ` ("${m[2]}" is a range or a tag)` : ""}.`);
		return { kind: "npm", location: m[1]!, pin: m[2] };
	},
	async fetch(source, into, env) {
		// npm downloads the tarball and checks it against the registry's integrity hash; nothing in it runs.
		const scratch = `${into}.pack`;
		mkdirSync(join(scratch, "x"), { recursive: true });
		try {
			const out = await run("npm", ["pack", `${source.location}@${source.pin}`, "--json", "--ignore-scripts", "--pack-destination", scratch, "--cache", env.npmCache], { cwd: scratch });
			const [packed] = JSON.parse(out) as { filename: string; name: string; version: string }[];
			if (!packed || packed.name !== source.location || packed.version !== source.pin) throw new Error(`npm returned ${packed?.name}@${packed?.version}, not ${source.location}@${source.pin}`);
			await run("tar", ["-xzf", join(scratch, basename(packed.filename)), "-C", join(scratch, "x"), "--no-same-owner", "--no-same-permissions"]);
			if (!existsSync(join(scratch, "x", "package", "package.json"))) throw new Error("the package has no package/package.json");
			renameSync(join(scratch, "x", "package"), into);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	},
	async newer(source, version, _installed, env) {
		const current = parseVersion(version);
		const raw = JSON.parse(await run("npm", ["view", source.location, "versions", "--json", "--cache", env.npmCache], { timeoutMs: MINUTE })) as string | string[];
		return (Array.isArray(raw) ? raw : [raw])
			.map((v) => ({ v, parsed: parseVersion(v) }))
			.filter((x) => x.parsed && !x.parsed[3] && (!current || compareVersions(x.parsed, current) > 0))
			.sort((a, b) => compareVersions(b.parsed!, a.parsed!))
			.slice(0, 10)
			.map((x) => ({ to: x.v, label: x.v }));
	},
	at: (source, to) => {
		if (!to || !EXACT.test(to)) throw notPinned("Name the exact version to update to (plugin.check_updates lists them).");
		return { ...source, pin: to };
	},
};

const SOURCES: Source[] = [npm, git, folder];

/** The source a typed text names. */
export function parseSource(text: string): { source: Source; spec: PluginSource } {
	const t = text.trim();
	for (const source of SOURCES) {
		const spec = source.parse(t);
		if (spec) return { source, spec };
	}
	throw new ReelixError("bad_source", `"${t}" is not a source Reelix can install from: give a folder's full path, a git URL ending in #<full commit id>, or npm:<name>@<exact version>.`);
}

export const sourceOf = (kind: PluginSource["kind"]): Source => SOURCES.find((s) => s.kind === kind)!;

/** The author's changelog, if the package has one, cut to a readable length. */
export function changelog(dir: string): string | undefined {
	const name = readdirSync(dir).find((f) => /^(changelog|changes|history)(\.md|\.txt)?$/i.test(f));
	return name ? readFileSync(join(dir, name), "utf8").slice(0, 8_000) : undefined;
}
