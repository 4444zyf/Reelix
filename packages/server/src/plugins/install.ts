import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type PluginReview, type PluginSource, type PluginUpdates, ReelixError, declarationDiff, errorMessage, nowIso } from "@reelix/core";
import { type Manifest, declarations, incompatibility, readManifest } from "./manifest.ts";
import { changelog, parseSource, run, sourceOf } from "./sources.ts";

/**
 * Installing, updating and removing plugins in `<data>/plugins` (docs/plugins.md §13). Each installed
 * plugin is `<id>/` with its dependencies in `<id>/node_modules`, and a record in `.installs/<id>.json`
 * holding where it came from and the hash of everything installed. Only folders with a record are ever
 * loaded. Work happens in `.staging/`; a staged update waits in `.pending/<id>/`.
 */

/** What Reelix knows about one installed plugin. It lives in the data folder (§11.3: the agent's shell can write there). */
export type InstallRecord = {
	id: string;
	source: PluginSource;
	version: string;
	installedAt: string;
	/** Of everything installed: files, skills, scripts and the whole dependency folder. */
	hash: string;
	nativeFound: string[];
	scriptsNotRun: string[];
	/** Set when the owner approved; the plugin is loaded only while its files still have this hash. */
	approved?: { hash: string; at: string; by: string };
	/** A newer version staged in `.pending/<id>/`, waiting for the owner. */
	update?: { source: PluginSource; version: string; hash: string; nativeFound: string[]; scriptsNotRun: string[]; changelog?: string };
};

/**
 * The hash of a folder: every file's path, kind and content, symbolic links by their target.
 * `skip` leaves out folders by name (to compare a source folder with its installed copy).
 */
export function hashTree(dir: string, skip: string[] = []): string {
	const h = createHash("sha256");
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const rel = relative(dir, p).split(sep).join("/");
			const st = lstatSync(p);
			if (st.isSymbolicLink()) h.update(`l ${rel} ${readlinkSync(p)}\n`);
			else if (st.isDirectory()) {
				if (skip.includes(name)) continue;
				h.update(`d ${rel}\n`);
				walk(p);
			} else if (st.isFile()) h.update(`f ${rel} ${st.mode & 0o111 ? "x" : "-"} ${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
			else h.update(`o ${rel}\n`);
		}
	};
	walk(dir);
	return h.digest("hex");
}

/** Symbolic links in the package's own files would let it reach outside its folder. */
export function refuseLinks(dir: string): void {
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isSymbolicLink()) throw new ReelixError("refused", `The package contains a symbolic link (${relative(dir, p)}); Reelix does not install those.`);
			if (e.isDirectory() && e.name !== "node_modules") walk(p);
		}
	};
	walk(dir);
}

type LockEntry = { version?: string; resolved?: string; integrity?: string; link?: boolean; dev?: boolean; peer?: boolean; devOptional?: boolean };

/**
 * The plugin's dependencies, exactly as its lock file names them, each with an integrity hash, and no
 * install script run (docs/plugins.md §13.1). npm works in a folder of its own holding only
 * package.json and the lock file, so nothing else in the package (an .npmrc) can steer it.
 */
async function installDependencies(pkgDir: string, scratch: string, npmCache: string): Promise<void> {
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, any>;
	const deps = { ...pkg.dependencies, ...pkg.optionalDependencies } as Record<string, string>;
	if ("@reelix/plugin" in deps) throw new ReelixError("refused", "@reelix/plugin is Reelix's own: list it under peerDependencies, not dependencies.");
	// Whatever the package shipped as node_modules is not what its lock file says: it goes.
	rmSync(join(pkgDir, "node_modules"), { recursive: true, force: true });
	if (!Object.keys(deps).length) return;
	const lockName = ["npm-shrinkwrap.json", "package-lock.json"].find((f) => existsSync(join(pkgDir, f)));
	if (!lockName) throw new ReelixError("refused", "The package has dependencies but no lock file (npm-shrinkwrap.json or package-lock.json); Reelix installs dependencies only from a lock file with integrity hashes.");
	const lock = JSON.parse(readFileSync(join(pkgDir, lockName), "utf8")) as { lockfileVersion?: number; packages?: Record<string, LockEntry> };
	if (!lock.packages || (lock.lockfileVersion ?? 0) < 2) throw new ReelixError("refused", `${lockName} is from an old npm (lockfileVersion ${lock.lockfileVersion ?? "?"}); write it again with npm 7 or newer.`);
	for (const [path, e] of Object.entries(lock.packages)) {
		if (path === "" || e.dev || e.peer) continue;
		const name = path.slice(path.lastIndexOf("node_modules/") + 13);
		if (e.link) throw new ReelixError("refused", `${lockName}: ${name} is a link to a folder, not a package with an integrity hash.`);
		if (!e.resolved || !/^https?:\/\//.test(e.resolved)) throw new ReelixError("refused", `${lockName}: ${name} does not come from a registry (${e.resolved ?? "no resolved address"}); git and folder dependencies have no integrity hash.`);
		if (!e.integrity || !/^sha(256|384|512)-/.test(e.integrity)) throw new ReelixError("refused", `${lockName}: ${name} has no integrity hash.`);
	}
	const work = mkdtempSync(join(scratch, "deps-"));
	writeFileSync(join(work, "package.json"), readFileSync(join(pkgDir, "package.json")));
	writeFileSync(join(work, lockName), readFileSync(join(pkgDir, lockName)));
	// Peers are Reelix's own packages, which Reelix maps to its copies: npm leaves them alone.
	await run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--omit=peer", "--legacy-peer-deps", "--no-audit", "--no-fund", "--cache", npmCache], { cwd: work, env: { npm_config_ignore_scripts: "true" } });
	if (existsSync(join(work, "node_modules"))) renameSync(join(work, "node_modules"), join(pkgDir, "node_modules"));
}

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/**
 * Compiled code among the dependencies (docs/plugins.md §13.2). One that would have to be built here
 * (binding.gyp) and ships no binary for this platform is refused; so is compiled code the manifest does
 * not declare with `uses.native`. Also lists the install scripts that were not run.
 */
function inspectDependencies(pkgDir: string, manifest: Manifest): { nativeFound: string[]; scriptsNotRun: string[] } {
	const own = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
	const scriptsNotRun = [...INSTALL_SCRIPTS, "prepare"].filter((s) => own.scripts?.[s]).map((s) => `${manifest.id} (${s})`);
	const nativeFound: string[] = [];
	const platform = `${process.platform}-${process.arch}`;
	const hasNodeFile = (d: string): boolean =>
		readdirSync(d, { withFileTypes: true }).some((e) => (e.isFile() && e.name.endsWith(".node")) || (e.isDirectory() && e.name !== "node_modules" && hasNodeFile(join(d, e.name))));
	const visit = (dir: string) => {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; scripts?: Record<string, string>; gypfile?: boolean };
		const name = pkg.name ?? relative(pkgDir, dir);
		for (const s of INSTALL_SCRIPTS) if (pkg.scripts?.[s]) scriptsNotRun.push(`${name} (${s})`);
		const gyp = existsSync(join(dir, "binding.gyp")) || pkg.gypfile === true;
		const prebuilt = existsSync(join(dir, "prebuilds")) && readdirSync(join(dir, "prebuilds")).some((d) => d.startsWith(platform));
		const binary = prebuilt || hasNodeFile(dir);
		if (gyp && !binary) throw new ReelixError("refused", `The dependency ${name} would have to be compiled on this machine and ships no ready-made binary for ${platform}. Reelix compiles nothing.`);
		if (gyp || binary) nativeFound.push(name);
	};
	const walk = (modules: string) => {
		if (!existsSync(modules)) return;
		for (const e of readdirSync(modules, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name.startsWith(".")) continue;
			const dirs = e.name.startsWith("@") ? readdirSync(join(modules, e.name)).map((n) => join(modules, e.name, n)) : [join(modules, e.name)];
			for (const d of dirs) {
				if (!existsSync(join(d, "package.json"))) continue;
				visit(d);
				walk(join(d, "node_modules"));
			}
		}
	};
	walk(join(pkgDir, "node_modules"));
	if (nativeFound.length && !manifest.uses.native) throw new ReelixError("refused", `It contains compiled code (${nativeFound.join(", ")}) but does not declare it with reelix.uses.native.`);
	return { nativeFound, scriptsNotRun };
}

type Fetched = { dir: string; manifest: Manifest; hash: string; nativeFound: string[]; scriptsNotRun: string[] };

export class Installer {
	readonly root: string;
	private npmCache: string;
	private reservedWords: () => ReadonlySet<string>;

	constructor(o: { root: string; npmCache: string; reservedWords: () => ReadonlySet<string> }) {
		this.root = o.root;
		this.npmCache = o.npmCache;
		this.reservedWords = o.reservedWords;
	}

	private get records(): string {
		return join(this.root, ".installs");
	}

	dirOf(id: string): string {
		return join(this.root, id);
	}

	private pendingOf(id: string): string {
		return join(this.root, ".pending", id);
	}

	list(): InstallRecord[] {
		if (!existsSync(this.records)) return [];
		return readdirSync(this.records)
			.filter((f) => f.endsWith(".json"))
			.sort()
			.flatMap((f) => {
				try {
					return [JSON.parse(readFileSync(join(this.records, f), "utf8")) as InstallRecord];
				} catch {
					return [];
				}
			});
	}

	get(id: string): InstallRecord | undefined {
		const file = join(this.records, `${id}.json`);
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as InstallRecord) : undefined;
	}

	/** Written whole and renamed into place, so a record is never half written. */
	private write(r: InstallRecord): void {
		mkdirSync(this.records, { recursive: true });
		const tmp = join(this.records, `.${r.id}.json.tmp`);
		writeFileSync(tmp, JSON.stringify(r, null, 1));
		renameSync(tmp, join(this.records, `${r.id}.json`));
	}

	private scratch(): string {
		mkdirSync(join(this.root, ".staging"), { recursive: true });
		return mkdtempSync(join(this.root, ".staging", "x-"));
	}

	/** The files of a source in a staged folder, checked and with dependencies; nothing of it has run. */
	private async fetch(spec: PluginSource, scratch: string): Promise<Fetched> {
		const dir = join(scratch, "package");
		const source = sourceOf(spec.kind);
		await source.fetch(spec, dir, { npmCache: this.npmCache, hashFiles: (d) => hashTree(d, ["node_modules"]) });
		refuseLinks(dir);
		const why = incompatibility(dir);
		if (why) throw new ReelixError("incompatible", `It cannot run on this Reelix: ${why}.`);
		const manifest = readManifest(dir, this.reservedWords());
		await installDependencies(dir, scratch, this.npmCache);
		const facts = inspectDependencies(dir, manifest);
		return { dir, manifest, hash: hashTree(dir), ...facts };
	}

	/**
	 * A transaction: on any failure nothing is left behind (docs/plugins.md §13.3). `recordAs`: the source to
	 * record when the files come from a copy of it (a proposed plugin, installed from its copy).
	 */
	async install(text: string, taken: (id: string) => boolean, recordAs?: PluginSource): Promise<InstallRecord> {
		const { spec } = parseSource(text);
		const scratch = this.scratch();
		let placed: string | undefined;
		try {
			const f = await this.fetch(spec, scratch);
			const id = f.manifest.id;
			if (taken(id) || this.get(id)) throw new ReelixError("exists", `A plugin with the id "${id}" is already here; update it with plugin.update.`);
			const target = this.dirOf(id);
			if (existsSync(target)) throw new ReelixError("exists", `${target} exists but Reelix did not install it; move it away first.`);
			renameSync(f.dir, target);
			placed = target;
			const record: InstallRecord = { id, source: recordAs ?? spec, version: f.manifest.version, installedAt: nowIso(), hash: f.hash, nativeFound: f.nativeFound, scriptsNotRun: f.scriptsNotRun };
			this.write(record);
			return record;
		} catch (e) {
			if (placed) rmSync(placed, { recursive: true, force: true });
			throw e;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	/** Fetch and stage a newer version in `.pending/<id>/`; the running one is untouched. */
	async stageUpdate(id: string, to: string | undefined): Promise<InstallRecord> {
		const record = this.need(id);
		const spec = sourceOf(record.source.kind).at(record.source, to);
		const scratch = this.scratch();
		try {
			const f = await this.fetch(spec, scratch);
			if (f.manifest.id !== id) throw new ReelixError("refused", `That version's id is "${f.manifest.id}", not "${id}".`);
			const pending = this.pendingOf(id);
			rmSync(pending, { recursive: true, force: true });
			mkdirSync(join(this.root, ".pending"), { recursive: true });
			renameSync(f.dir, pending);
			const updated: InstallRecord = { ...record, update: { source: spec, version: f.manifest.version, hash: f.hash, nativeFound: f.nativeFound, scriptsNotRun: f.scriptsNotRun, changelog: changelog(pending) } };
			try {
				this.write(updated);
			} catch (e) {
				rmSync(pending, { recursive: true, force: true });
				throw e;
			}
			return updated;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}

	async newer(id: string): Promise<PluginUpdates> {
		const r = this.need(id);
		const base = { id, version: r.version, source: r.source };
		try {
			return { ...base, available: await sourceOf(r.source.kind).newer(r.source, r.version, this.dirOf(id), { npmCache: this.npmCache, hashFiles: (d) => hashTree(d, ["node_modules"]) }) };
		} catch (e) {
			return { ...base, available: [], error: errorMessage(e) };
		}
	}

	/** The approval screen, from the manifest and the facts found at install (docs/plugins.md §11.1). */
	review(id: string, state: "installed" | "changed" | "other"): Omit<PluginReview, "requirements"> {
		const r = this.need(id);
		const live = this.dirOf(id);
		const current = readManifest(live, this.reservedWords());
		if (r.update && existsSync(this.pendingOf(id))) {
			const pending = this.pendingOf(id);
			const next = readManifest(pending, this.reservedWords());
			const to = declarations(pending, next);
			return { id, what: "update", hash: hashTree(pending), source: r.update.source, declarations: to, nativeFound: r.update.nativeFound, scriptsNotRun: r.update.scriptsNotRun, from: { version: r.version, source: r.source }, diff: declarationDiff(declarations(live, current), to), changelog: r.update.changelog };
		}
		if (state === "other") throw new ReelixError("nothing_to_approve", `${id} is approved and has no staged update.`);
		return { id, what: state === "changed" ? "changed" : "install", hash: hashTree(live), source: r.source, declarations: declarations(live, current), nativeFound: r.nativeFound, scriptsNotRun: r.scriptsNotRun };
	}

	/**
	 * The owner approves what they saw (`hash`). A staged update replaces the installed version as a
	 * transaction: the old files come back on any failure.
	 */
	approve(id: string, hash: string, by: string): "update" | "files" {
		const r = this.need(id);
		const live = this.dirOf(id);
		const pending = this.pendingOf(id);
		const approved = { hash, at: nowIso(), by };
		if (r.update && existsSync(pending)) {
			if (hashTree(pending) !== hash || r.update.hash !== hash) throw new ReelixError("changed", "The staged update is not what was shown; look at it again.");
			mkdirSync(join(this.root, ".trash"), { recursive: true });
			const backup = join(this.root, ".trash", `${id}@${Date.now()}`);
			renameSync(live, backup);
			try {
				renameSync(pending, live);
				this.write({ ...r, source: r.update.source, version: r.update.version, hash, nativeFound: r.update.nativeFound, scriptsNotRun: r.update.scriptsNotRun, installedAt: nowIso(), approved, update: undefined });
			} catch (e) {
				if (existsSync(live)) renameSync(live, pending);
				renameSync(backup, live);
				this.write(r);
				throw e;
			}
			rmSync(backup, { recursive: true, force: true });
			return "update";
		}
		if (hashTree(live) !== hash) throw new ReelixError("changed", "Its files are not what was shown; look at them again.");
		this.write({ ...r, hash, approved });
		return "files";
	}

	/** Whether the installed files are exactly what the owner approved. */
	intact(id: string): boolean {
		const r = this.get(id);
		return !!r?.approved && existsSync(this.dirOf(id)) && hashTree(this.dirOf(id)) === r.approved.hash;
	}

	remove(id: string): void {
		this.need(id);
		mkdirSync(join(this.root, ".trash"), { recursive: true });
		const trash = join(this.root, ".trash", `${id}@${Date.now()}`);
		if (existsSync(this.dirOf(id))) renameSync(this.dirOf(id), trash);
		rmSync(join(this.records, `${id}.json`), { force: true });
		rmSync(this.pendingOf(id), { recursive: true, force: true });
		rmSync(trash, { recursive: true, force: true });
	}

	/**
	 * At start, what an install or update cut off by a crash left: an installed folder moved aside and
	 * not yet replaced comes back; staged files, never loaded, are removed.
	 */
	clearScratch(): void {
		const trash = join(this.root, ".trash");
		for (const r of this.list()) {
			const aside = existsSync(trash) ? readdirSync(trash).filter((n) => n.startsWith(`${r.id}@`)).sort().pop() : undefined;
			if (aside && !existsSync(this.dirOf(r.id))) renameSync(join(trash, aside), this.dirOf(r.id));
		}
		for (const d of [".staging", ".trash"]) rmSync(join(this.root, d), { recursive: true, force: true });
		for (const r of this.list()) if (!r.update) rmSync(this.pendingOf(r.id), { recursive: true, force: true });
	}

	private need(id: string): InstallRecord {
		const r = this.get(id);
		if (!r) throw new ReelixError("not_installed", `${id} was not installed by the owner (built-in plugins are switched off instead).`);
		return r;
	}
}
