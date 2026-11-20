import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { DataPaths } from "@reelix/core";
import { agentFolders } from "../isolation.ts";

/** pi's file tools and what each does with its `path`. */
const FILE_TOOLS: Record<string, "read" | "list" | "search" | "write"> = { read: "read", ls: "list", find: "list", grep: "search", write: "write", edit: "write" };

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/**
 * The real path of `p`, or of its nearest existing folder followed by the rest: a new file is judged by where
 * it would land, and a link that leads nowhere yet by where it says.
 */
function realPath(p: string, depth = 0): string {
	let rest = "";
	let at = p;
	for (;;) {
		let link: string | undefined;
		try {
			link = lstatSync(at).isSymbolicLink() ? readlinkSync(at) : undefined;
		} catch {
			if (dirname(at) === at) return p;
			rest = rest ? join(basename(at), rest) : basename(at);
			at = dirname(at);
			continue;
		}
		try {
			return join(realpathSync(at), rest);
		} catch {
			// a link to nothing (yet): follow what it says
			if (link === undefined || depth > 40) return p;
			return realPath(join(resolve(dirname(at), link), rest), depth + 1);
		}
	}
}

/**
 * Why a file tool may not touch this path, or undefined. pi's file tools run inside Reelix's process, as
 * Reelix's user, so the system does not stop them (docs/plugins.md §11.3): they keep to what the agent's
 * shell can reach in the image. In the data folder that is its working folders (`agentFolders`) and, to
 * read, `plugins/`; nothing in /proc (Reelix's own environment and open files); and no search over a
 * folder that holds the data folder.
 */
export function fileToolRefusal(paths: DataPaths, cwd: string, tool: string, input: { path?: unknown }): string | undefined {
	const use = FILE_TOOLS[tool];
	if (!use) return undefined;
	const given = typeof input.path === "string" && input.path ? input.path : ".";
	const real = realPath(resolve(cwd, given.replace(/^~(?=$|\/)/, homedir())));
	const data = realPath(paths.root);
	const refused = `${tool} may not use ${given}: Reelix's own files (secrets, database, settings, sessions) are closed to the agent.`;
	if (inside("/proc", real)) return refused;
	if (use === "search" && (inside(real, data) || real === "/")) return `${tool} may not search ${given}: it holds Reelix's own files. Search a narrower folder.`;
	if (!inside(data, real)) return undefined;
	if (agentFolders(paths).some((f) => inside(realPath(f), real))) return undefined;
	if (use !== "write" && inside(realPath(paths.plugins), real)) return undefined;
	return refused;
}
