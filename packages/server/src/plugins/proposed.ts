import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { type PluginProposalView, ReelixError, newId, nowIso } from "@reelix/core";
import { hashTree, refuseLinks } from "./install.ts";
import { type Manifest, incompatibility, readManifest } from "./manifest.ts";

/**
 * Plugins the agent wrote and proposed (docs/plugins.md §16, phase 7; §11.1). Each proposal is a copy of the
 * folder as it was when proposed, in `<data>/plugins/.proposed/<id>/`, with a record beside it. Nothing here
 * loads or runs its code, and nothing here installs it: only the owner's approval does, through the installer.
 */
export type ProposalRecord = Omit<PluginProposalView, "files" | "diff"> & {
	/** Of the copy, as the owner is shown it. */
	hash: string;
	inboxId?: string;
};

const DIFF_LIMIT = 200_000;
/** Snapshots kept per plugin: the open one and the one it is compared with. */
const KEPT = 2;

/** Every file under a folder, relative, with `/`. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(relative(dir, p).split(sep).join("/"));
		}
	};
	walk(dir);
	return out.sort();
}

/** `git diff --no-index` of two folders of `root`, paths relative to each. Exit code 1 means "they differ". */
function gitDiff(root: string, before: string, after: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--src-prefix=before/", "--dst-prefix=after/", before, after], { cwd: root, env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", HOME: root }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error && error.code !== 1) return resolve(`(the difference could not be made: ${(stderr || error.message).trim().split("\n")[0]})`);
			// git names each file with its folder: keep only the path inside it.
			const text = stdout.replaceAll(`before/${before}/`, "before/").replaceAll(`before/${after}/`, "before/").replaceAll(`after/${after}/`, "after/");
			resolve(text.length > DIFF_LIMIT ? `${text.slice(0, DIFF_LIMIT)}\n… (cut at ${DIFF_LIMIT} characters)` : text);
		});
	});
}

export class ProposalStore {
	private root: string;
	private reservedWords: () => ReadonlySet<string>;

	constructor(o: { root: string; reservedWords: () => ReadonlySet<string> }) {
		this.root = o.root;
		this.reservedWords = o.reservedWords;
	}

	dirOf(id: string): string {
		return join(this.root, id);
	}

	private recordFile(id: string): string {
		return join(this.root, `${id}.json`);
	}

	get(id: string): ProposalRecord {
		if (!/^pp_[A-Za-z0-9_-]+$/.test(id) || !existsSync(this.recordFile(id))) throw new ReelixError("not_found", `There is no proposed plugin ${id}.`);
		return JSON.parse(readFileSync(this.recordFile(id), "utf8")) as ProposalRecord;
	}

	list(): ProposalRecord[] {
		if (!existsSync(this.root)) return [];
		return readdirSync(this.root)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(this.root, f), "utf8")) as ProposalRecord)
			.sort((a, b) => a.at.localeCompare(b.at));
	}

	save(r: ProposalRecord): void {
		mkdirSync(this.root, { recursive: true });
		const tmp = join(this.root, `.${r.id}.json.tmp`);
		writeFileSync(tmp, JSON.stringify(r, null, 1));
		renameSync(tmp, this.recordFile(r.id));
	}

	/** The copy's manifest, read as on any approval screen: nothing of its code runs. */
	manifest(id: string): Manifest {
		return readManifest(this.dirOf(id), this.reservedWords());
	}

	/**
	 * Copy `folder` as it is now and check it as an install would, without dependencies: a proposed plugin has
	 * none of its own. `taken`: ids Reelix already has. The open proposal of the same plugin is replaced.
	 */
	create(folder: string, by: string, note: string | undefined, taken: (id: string) => boolean): { record: ProposalRecord; replaced?: ProposalRecord } {
		if (!existsSync(join(folder, "package.json"))) throw new ReelixError("not_found", `${folder} has no package.json: name the folder of a plugin (reelix plugin new writes one).`);
		const id = newId("pp_");
		mkdirSync(this.root, { recursive: true });
		const work = join(this.root, `.work-${id}`);
		try {
			cpSync(folder, work, { recursive: true, verbatimSymlinks: true, filter: (src) => src === folder || !["node_modules", ".git"].includes(basename(src)) });
			refuseLinks(work);
			const why = incompatibility(work);
			if (why) throw new ReelixError("incompatible", `It cannot run on this Reelix: ${why}.`);
			const manifest = readManifest(work, this.reservedWords());
			const pkg = JSON.parse(readFileSync(join(work, "package.json"), "utf8")) as { dependencies?: object; optionalDependencies?: object };
			if (Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length) throw new ReelixError("refused", "A proposed plugin has no dependencies of its own (only @reelix/plugin, as a peer). A plugin with dependencies is installed by the owner from git or npm.");
			if (taken(manifest.id)) throw new ReelixError("exists", `Reelix already has a plugin with the id "${manifest.id}": give yours another id (in package.json, reelix.id).`);
			renameSync(work, this.dirOf(id));
			const before = this.list().filter((r) => r.plugin === manifest.id);
			const previous = before.at(-1);
			const replaced = before.find((r) => r.status === "open");
			if (replaced) this.save({ ...replaced, status: "replaced" });
			const record: ProposalRecord = { id, plugin: manifest.id, version: manifest.version, by, at: nowIso(), ...(note?.trim() && { note: note.trim().slice(0, 1_000) }), status: "open", folder, hash: hashTree(this.dirOf(id)), ...(previous && existsSync(this.dirOf(previous.id)) && { diffFrom: previous.id }) };
			this.save(record);
			// Older copies of the same plugin are not compared with any more.
			for (const old of before.slice(0, Math.max(0, before.length - (KEPT - 1)))) rmSync(this.dirOf(old.id), { recursive: true, force: true });
			return { record, replaced };
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}

	/** The record with its files and the difference to the proposal before it. */
	async view(r: ProposalRecord): Promise<PluginProposalView> {
		const dir = this.dirOf(r.id);
		if (!existsSync(dir)) throw new ReelixError("not_found", `The files of ${r.id} are gone.`);
		const old = r.diffFrom && existsSync(this.dirOf(r.diffFrom)) ? this.dirOf(r.diffFrom) : undefined;
		const now = listFiles(dir);
		const then = old ? listFiles(old) : [];
		const same = (f: string) => readFileSync(join(dir, f)).equals(readFileSync(join(old!, f)));
		const files = [
			...now.map((path) => ({ path, size: lstatSync(join(dir, path)).size, change: !then.includes(path) ? ("added" as const) : same(path) ? ("same" as const) : ("changed" as const) })),
			...then.filter((f) => !now.includes(f)).map((path) => ({ path, size: lstatSync(join(old!, path)).size, change: "removed" as const })),
		];
		const empty = join(this.root, `.empty-${r.id}`);
		mkdirSync(empty, { recursive: true });
		try {
			const { hash: _h, inboxId: _i, ...view } = r;
			return { ...view, files, diff: await gitDiff(this.root, basename(old ?? empty), r.id) };
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	}

	/** The hash of the copy now: it must still be what the owner was shown. */
	hashNow(id: string): string {
		return hashTree(this.dirOf(id));
	}

	/** After approval the copy is installed; copies of the plugin's earlier proposals go. */
	forget(plugin: string): void {
		for (const r of this.list().filter((x) => x.plugin === plugin)) rmSync(this.dirOf(r.id), { recursive: true, force: true });
	}
}
