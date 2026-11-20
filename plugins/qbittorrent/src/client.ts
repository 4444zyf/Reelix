import { createHash } from "node:crypto";
import type { PluginContext } from "@reelix/plugin";

/** What qBittorrent's Web API answers about a torrent (`torrents/info`, and the patches of `sync/maindata`). */
export type QbTorrent = {
	hash: string;
	name: string;
	state: string;
	progress: number;
	size: number;
	total_size?: number;
	amount_left: number;
	save_path: string;
	content_path?: string;
	tags: string;
	category: string;
	added_on: number;
	completion_on: number;
	dlspeed: number;
	upspeed: number;
	num_seeds: number;
	eta: number;
	ratio: number;
	seeding_time?: number;
	[k: string]: unknown;
};

export type QbFile = { index?: number; name: string; size: number; progress: number; priority: number };
export type QbTracker = { url: string; status: number; msg: string };
export type QbMaindata = { rid: number; full_update?: boolean; torrents?: Record<string, Partial<QbTorrent>>; torrents_removed?: string[]; server_state?: Record<string, unknown> };

/** An answer of qBittorrent that is expected now and then: a refused login, a ban, a refusal. */
export class QbError extends Error {
	kind: "auth" | "banned" | "refused";
	constructor(kind: QbError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

type Fetch = PluginContext["http"]["fetch"];
type Request = { form?: Record<string, string>; multipart?: Multipart; query?: Record<string, string>; signal?: AbortSignal };
type Multipart = ({ name: string; filename: string; type: string; bytes: Uint8Array } | [string, string])[];

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** A multipart/form-data body: fields and files. */
function multipart(parts: Multipart): { body: Uint8Array; type: string } {
	const boundary = `----reelix${createHash("sha1").update(String(Math.random())).digest("hex").slice(0, 24)}`;
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const p of parts) {
		if (Array.isArray(p)) chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p[0]}"\r\n\r\n${p[1]}\r\n`));
		else {
			chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`), p.bytes, enc.encode("\r\n"));
		}
	}
	chunks.push(enc.encode(`--${boundary}--\r\n`));
	const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		body.set(c, at);
		at += c.length;
	}
	return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/** qBittorrent's Web API v2, through Reelix's fetch. Works with qBittorrent 4.x and 5.x. */
export class QbClient {
	readonly url: string;
	private fetch: Fetch;
	private username: string;
	private password: string;
	private sid?: string;
	private versions?: { app: string; api: string; major: number };

	constructor(fetch: Fetch, opts: { url: string; username: string; password: string }) {
		this.fetch = fetch;
		this.url = opts.url.replace(/\/+$/, "");
		this.username = opts.username;
		this.password = opts.password;
	}

	private async login(signal?: AbortSignal): Promise<void> {
		const res = await this.fetch(`${this.url}/api/v2/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", referer: this.url, origin: this.url },
			body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
			timeoutMs: 10_000,
			signal,
		});
		const answer = text(res.bytes).trim();
		if (res.status === 403) throw new QbError("banned", "qBittorrent has banned this address after failed logins; wait, or restart qBittorrent.");
		const sid = res.cookies.map((c) => /^(SID|QBT_SID_\d+)=([^;]*)/.exec(c)?.[0]).find(Boolean);
		if (sid) this.sid = sid;
		else if (answer === "Ok.") this.sid = ""; // qBittorrent lets this address in without a login
		else throw new QbError("auth", `qBittorrent refused the login (${answer || res.status}). Check the username and the password.`);
	}

	private async req(path: string, r: Request = {}, retry = true): Promise<Uint8Array> {
		if (this.sid === undefined) await this.login(r.signal);
		const qs = r.query && Object.keys(r.query).length ? `?${new URLSearchParams(r.query).toString()}` : "";
		const headers: Record<string, string> = { referer: this.url, origin: this.url };
		if (this.sid) headers.cookie = this.sid;
		let body: string | Uint8Array | undefined;
		if (r.form) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = new URLSearchParams(r.form).toString();
		} else if (r.multipart) {
			const m = multipart(r.multipart);
			headers["content-type"] = m.type;
			body = m.body;
		}
		const res = await this.fetch(`${this.url}/api/v2/${path}${qs}`, { method: body === undefined ? "GET" : "POST", headers, body, timeoutMs: 20_000, signal: r.signal });
		if ((res.status === 403 || res.status === 401) && retry) {
			this.sid = undefined;
			return this.req(path, r, false);
		}
		if (!res.ok) throw new QbError("refused", `qBittorrent ${path}: HTTP ${res.status} ${text(res.bytes).trim().slice(0, 200)}`);
		return res.bytes;
	}

	private async json<T>(path: string, r: Request = {}): Promise<T> {
		return JSON.parse(text(await this.req(path, r))) as T;
	}

	async version(signal?: AbortSignal): Promise<{ app: string; api: string; major: number }> {
		if (!this.versions) {
			const app = text(await this.req("app/version", { signal })).trim();
			const api = text(await this.req("app/webapiVersion", { signal })).trim();
			this.versions = { app, api, major: Number(/v?(\d+)/.exec(app)?.[1] ?? 4) };
		}
		return this.versions;
	}

	preferences(signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.json("app/preferences", { signal });
	}

	async setPreferences(prefs: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
		await this.req("app/setPreferences", { form: { json: JSON.stringify(prefs) }, signal });
	}

	async defaultSavePath(signal?: AbortSignal): Promise<string> {
		return text(await this.req("app/defaultSavePath", { signal })).trim();
	}

	/** `hashes` must not be empty: qBittorrent reads a missing list as "every torrent". */
	torrents(filter: { hashes?: string[]; tag?: string } = {}, signal?: AbortSignal): Promise<QbTorrent[]> {
		const query: Record<string, string> = {};
		if (filter.hashes) query.hashes = filter.hashes.join("|");
		if (filter.tag !== undefined) query.tag = filter.tag;
		return this.json("torrents/info", { query, signal });
	}

	files(hash: string, signal?: AbortSignal): Promise<QbFile[]> {
		return this.json("torrents/files", { query: { hash }, signal });
	}

	trackers(hash: string, signal?: AbortSignal): Promise<QbTracker[]> {
		return this.json("torrents/trackers", { query: { hash }, signal });
	}

	/** Add a .torrent file or a magnet link, stopped or not, with tags and a save path (as qBittorrent names it). */
	async add(src: { torrent: Uint8Array; filename: string } | { magnet: string }, o: { stopped: boolean; tags: string[]; savePath?: string }, signal?: AbortSignal): Promise<void> {
		const parts: Multipart = ["torrent" in src ? { name: "torrents", filename: src.filename, type: "application/x-bittorrent", bytes: src.torrent } : ["urls", src.magnet]];
		// 4.x reads `paused`, 5.x reads `stopped`.
		if (o.stopped) parts.push(["paused", "true"], ["stopped", "true"]);
		if (o.tags.length) parts.push(["tags", o.tags.join(",")]);
		if (o.savePath) parts.push(["savepath", o.savePath]);
		const answer = text(await this.req("torrents/add", { multipart: parts, signal })).trim();
		if (answer && answer !== "Ok." && !answer.startsWith("{")) throw new QbError("refused", `qBittorrent did not accept the ${"torrent" in src ? "torrent" : "magnet link"}: ${answer}`);
	}

	async start(hashes: string[], signal?: AbortSignal): Promise<void> {
		const { major } = await this.version(signal);
		await this.req(major >= 5 ? "torrents/start" : "torrents/resume", { form: { hashes: hashes.join("|") }, signal });
	}

	async stop(hashes: string[], signal?: AbortSignal): Promise<void> {
		const { major } = await this.version(signal);
		await this.req(major >= 5 ? "torrents/stop" : "torrents/pause", { form: { hashes: hashes.join("|") }, signal });
	}

	async delete(hashes: string[], deleteFiles: boolean, signal?: AbortSignal): Promise<void> {
		await this.req("torrents/delete", { form: { hashes: hashes.join("|"), deleteFiles: String(deleteFiles) }, signal });
	}

	/** Adds to the tags a torrent has; the others stay. */
	async addTags(hashes: string[], tags: string[], signal?: AbortSignal): Promise<void> {
		await this.req("torrents/addTags", { form: { hashes: hashes.join("|"), tags: tags.join(",") }, signal });
	}

	async setFilePriority(hash: string, indexes: number[], priority: number, signal?: AbortSignal): Promise<void> {
		await this.req("torrents/filePrio", { form: { hash, id: indexes.join("|"), priority: String(priority) }, signal });
	}

	maindata(rid: number, signal?: AbortSignal): Promise<QbMaindata> {
		return this.json("sync/maindata", { query: { rid: String(rid) }, signal });
	}
}

// ---------------------------------------------------------------- info-hashes, without trusting the client

/** The end of the bencoded value that starts at `i`. */
function skip(b: Uint8Array, i: number): number {
	const c = b[i];
	if (c === 0x69) {
		const end = b.indexOf(0x65, i);
		if (end < 0) throw new Error("not a torrent file");
		return end + 1;
	}
	if (c === 0x6c || c === 0x64) {
		let at = i + 1;
		while (b[at] !== 0x65) {
			if (at >= b.length) throw new Error("not a torrent file");
			at = skip(b, at);
		}
		return at + 1;
	}
	const colon = b.indexOf(0x3a, i);
	const length = Number(text(b.subarray(i, colon)));
	if (colon < 0 || !Number.isInteger(length) || length < 0) throw new Error("not a torrent file");
	return colon + 1 + length;
}

/** The v1 info-hash of a .torrent file: SHA-1 of its bencoded `info` dictionary. */
export function torrentHash(b: Uint8Array): string {
	if (b[0] !== 0x64) throw new Error("not a torrent file");
	let at = 1;
	while (at < b.length && b[at] !== 0x65) {
		const keyEnd = skip(b, at);
		const key = text(b.subarray(b.indexOf(0x3a, at) + 1, keyEnd));
		const valueEnd = skip(b, keyEnd);
		if (key === "info") return createHash("sha1").update(b.subarray(keyEnd, valueEnd)).digest("hex");
		at = valueEnd;
	}
	throw new Error("the torrent file has no info dictionary");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The v1 info-hash of a magnet link, hex or base32. */
export function magnetHash(magnet: string): string | undefined {
	const v = /xt=urn:btih:([0-9a-z]+)/i.exec(magnet)?.[1];
	if (!v) return undefined;
	if (/^[0-9a-f]{40}$/i.test(v)) return v.toLowerCase();
	if (v.length !== 32) return undefined;
	let bits = "";
	for (const ch of v.toUpperCase()) {
		const n = BASE32.indexOf(ch);
		if (n < 0) return undefined;
		bits += n.toString(2).padStart(5, "0");
	}
	return bits.match(/.{4}/g)!.map((x) => Number.parseInt(x, 2).toString(16)).join("");
}
