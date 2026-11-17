import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import type { DataPaths } from "./config.ts";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLock(paths: DataPaths): { pid: number; who: string } | undefined {
	try {
		const [pid, who] = readFileSync(paths.lock, "utf8").trim().split(" ");
		return { pid: Number(pid), who: who ?? "?" };
	} catch {
		return undefined;
	}
}

/** Whether a live server holds the lock. */
export function serverAlive(paths: DataPaths): boolean {
	const l = readLock(paths);
	return !!l && l.who === "server" && pidAlive(l.pid);
}

/**
 * Take the lock on /data ("one writer", §3.3). Returns a release function, or undefined if a
 * live process holds it. A stale lock from a dead process is taken over.
 */
export function acquireLock(paths: DataPaths, who: "server" | "cli"): (() => void) | undefined {
	mkdirSync(paths.root, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(paths.lock, "wx", 0o600);
			writeSync(fd, `${process.pid} ${who}\n`);
			closeSync(fd);
			const release = () => {
				const l = readLock(paths);
				if (l?.pid === process.pid && existsSync(paths.lock)) unlinkSync(paths.lock);
			};
			process.once("exit", release);
			return release;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const l = readLock(paths);
			if (l && pidAlive(l.pid) && l.pid !== process.pid) return undefined;
			try {
				unlinkSync(paths.lock);
			} catch {}
		}
	}
	return undefined;
}
