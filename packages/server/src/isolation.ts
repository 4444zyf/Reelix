import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DataPaths } from "@reelix/core";

/**
 * The agent's shell and plugins in a process of their own as other system users (docs/plugins.md §11.3, D2;
 * docs/deployment.md "Users and files"). The image's entrypoint starts Reelix as the owner's PUID with the
 * capabilities to change user (and to signal what it started), and names the two users here. Outside the
 * image these variables are not set, nothing changes user and nothing here runs.
 */
export type Isolation = {
	/** The user, and group of the same number, the agent's shell runs as (`reelix-agent`). */
	agent: number;
	/** The user, and group, of plugins in a process of their own (`reelix-plugin`). */
	plugin: number;
};

export function isolationOf(env: Record<string, string | undefined>): Isolation | undefined {
	const agent = Number(env.REELIX_AGENT_ID);
	const plugin = Number(env.REELIX_PLUGIN_ID);
	return Number.isInteger(agent) && agent > 0 && Number.isInteger(plugin) && plugin > 0 ? { agent, plugin } : undefined;
}

export const ISOLATION = isolationOf(process.env);

/**
 * The command that runs what follows it as `user`, with `groups` as its other groups: no capabilities left
 * (none inherited, none ambient), and no way to gain any (`no_new_privs`, so no set-user-ID program helps).
 */
export function runAs(user: number, groups: number[]): string[] {
	return ["/usr/bin/setpriv", `--reuid=${user}`, `--regid=${user}`, groups.length ? `--groups=${groups.join(",")}` : "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--"];
}

/** The agent's shell: its own user, plus Reelix's group so it reads and writes the media folder as before. */
export const agentCommand = (iso: Isolation): string[] => runAs(iso.agent, [process.getgid!()]);

/** A plugin's process: its own user and nothing else. */
export const pluginCommand = (iso: Isolation): string[] => runAs(iso.plugin, []);

/** Where the agent's shell keeps its dotfiles: Reelix's own HOME (`<data>/home`) is closed to it. */
export const agentHome = (paths: DataPaths): string => join(paths.workspace, ".home");

/** The folders of the data folder the agent works in, with the server: notes, its skills, themes, its workspace. */
export const agentFolders = (paths: DataPaths): string[] => [paths.workspace, paths.notes, paths.skills, paths.themes];

const mine = (p: string) => lstatSync(p).uid === process.getuid!();

/** `dir` and what Reelix's user owns in it: group `gid`, which may read and write; new entries keep the group. */
function share(dir: string, gid: number): void {
	const walk = (p: string) => {
		const s = lstatSync(p);
		if (s.isSymbolicLink() || s.uid !== process.getuid!()) return;
		if (s.gid !== gid) chownSync(p, -1, gid);
		if (s.isDirectory()) {
			chmodSync(p, (s.mode & 0o7777) | 0o2070);
			for (const e of readdirSync(p)) walk(join(p, e));
		} else chmodSync(p, (s.mode & 0o7777) | 0o060);
	};
	walk(dir);
}

/**
 * Modes and groups of the data folder at start, before anything runs as another user. Only what is listed is
 * open, so a file a later version adds is closed until a document says otherwise:
 * - the folder itself: the others may pass through, not list it;
 * - `agentFolders`: shared with the agent's group, read and write;
 * - `plugins/`: readable (the agent runs skill scripts, a plugin's process reads its code), written only by Reelix;
 * - `plugin-data/`: passable for the plugins' group only; each plugin's folder closed until its process opens it;
 * - everything else (secrets.yaml, owner.token, reelix.db, config, pi, sessions, backups, cache, home …): Reelix's user only.
 */
export function isolateData(paths: DataPaths, iso: Isolation): void {
	const open = new Set([...agentFolders(paths), paths.plugins, paths.pluginData, paths.agentSocket]);
	for (const d of [...agentFolders(paths), paths.plugins, paths.pluginData]) mkdirSync(d, { recursive: true });
	chmodSync(paths.root, (lstatSync(paths.root).mode & 0o2000) | 0o711);
	for (const name of readdirSync(paths.root)) {
		const p = join(paths.root, name);
		if (open.has(p) || lstatSync(p).isSymbolicLink() || !mine(p)) continue;
		chmodSync(p, lstatSync(p).mode & 0o7770);
	}
	mkdirSync(agentHome(paths), { recursive: true });
	for (const d of [...agentFolders(paths), agentHome(paths)]) {
		share(d, iso.agent);
		chmodSync(d, 0o2770);
	}
	chmodSync(paths.plugins, (lstatSync(paths.plugins).mode & 0o2000) | 0o755);
	chownSync(paths.pluginData, -1, iso.plugin);
	chmodSync(paths.pluginData, 0o2710);
	for (const e of readdirSync(paths.pluginData)) pluginFolderAccess(join(paths.pluginData, e), iso, false);
}

/**
 * A plugin's data folder as it starts: shared with the plugins' group for a process of its own, closed to
 * everyone else otherwise (a plugin inside Reelix reads it as Reelix).
 */
export function pluginFolderAccess(dir: string, iso: Isolation, ownProcess: boolean): void {
	if (!existsSync(dir) || !mine(dir)) return;
	if (ownProcess) share(dir, iso.plugin);
	chmodSync(dir, ownProcess ? 0o2770 : 0o2700);
}
