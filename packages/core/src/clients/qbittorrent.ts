import { http, expectOk, type HttpResponse } from "../http.ts";
import { ReelixError } from "../util.ts";

export type QbTorrent = {
	hash: string;
	name: string;
	state: string;
	progress: number;
	size: number;
	total_size?: number;
	amount_left: number;
	save_path: string;
	content_path: string;
	tags: string;
	category: string;
	added_on: number;
	completion_on: number;
	dlspeed: number;
	upspeed: number;
	num_seeds: number;
	num_leechs: number;
	eta: number;
	ratio: number;
	[k: string]: unknown;
};

export type QbFile = { index: number; name: string; size: number; progress: number; priority: number };

const NOT_COMPLETE_STATES = new Set(["checkingUP", "checkingDL", "checkingResumeData", "moving", "error", "missingFiles", "metaDL", "forcedMetaDL", "allocating"]);

/** Complete = 100%, nothing left, and not checking/moving/erroring (§5.3). Stopped-on-completion counts. */
export function isComplete(t: Pick<QbTorrent, "progress" | "amount_left" | "state">): boolean {
	return t.progress >= 1 && (t.amount_left ?? 0) === 0 && !NOT_COMPLETE_STATES.has(t.state);
}

export function isStoppedState(state: string): boolean {
	return state.startsWith("paused") || state.startsWith("stopped");
}

export class QbClient {
	url: string;
	username: string;
	password: string;
	private sid?: string;
	private apiVersion?: string;
	private appVersion?: string;

	constructor(opts: { url: string; username?: string; password?: string }) {
		this.url = opts.url.replace(/\/+$/, "");
		this.username = opts.username ?? "admin";
		this.password = opts.password ?? "";
	}

	private async login(): Promise<void> {
		const res = await http(`${this.url}/api/v2/auth/login`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", referer: this.url, origin: this.url },
			body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
			timeoutMs: 10_000,
		});
		const text = await res.text();
		if (res.status === 403) throw new ReelixError("qb_banned", "qBittorrent has banned this address after failed logins; wait or restart it.");
		const cookie = res.headers.get("set-cookie") ?? "";
		const m = /(?:SID|QBT_SID_\d+)=([^;]+)/.exec(cookie);
		if (m) this.sid = m[0].split(";")[0];
		else if (text.trim() === "Ok.") this.sid = ""; // auth bypass for local network
		else throw new ReelixError("qb_auth", `qBittorrent refused the login (${text.trim() || res.status}). Check the username and password.`);
	}

	private async req(path: string, opts: { method?: string; form?: Record<string, string>; body?: FormData; query?: Record<string, string> } = {}, retry = true): Promise<HttpResponse> {
		if (this.sid === undefined) await this.login();
		const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
		const headers: Record<string, string> = { referer: this.url, origin: this.url };
		if (this.sid) headers.cookie = this.sid;
		let body: string | FormData | undefined;
		if (opts.form) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = new URLSearchParams(opts.form).toString();
		} else if (opts.body) body = opts.body;
		const res = await http(`${this.url}/api/v2/${path}${qs}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, timeoutMs: 20_000 });
		if ((res.status === 403 || res.status === 401) && retry) {
			this.sid = undefined;
			return this.req(path, opts, false);
		}
		return expectOk(res, `qBittorrent ${path}`);
	}

	async version(): Promise<{ app: string; api: string; major: number }> {
		if (!this.appVersion) {
			this.appVersion = (await (await this.req("app/version")).text()).trim();
			this.apiVersion = (await (await this.req("app/webapiVersion")).text()).trim();
		}
		const major = Number(/v?(\d+)/.exec(this.appVersion)?.[1] ?? 4);
		return { app: this.appVersion, api: this.apiVersion!, major };
	}

	async preferences(): Promise<Record<string, unknown>> {
		return (await this.req("app/preferences")).json();
	}

	async setPreferences(prefs: Record<string, unknown>): Promise<void> {
		await this.req("app/setPreferences", { form: { json: JSON.stringify(prefs) } });
	}

	async defaultSavePath(): Promise<string> {
		return (await (await this.req("app/defaultSavePath")).text()).trim();
	}

	async torrents(filter: { hashes?: string[]; tag?: string; category?: string } = {}): Promise<QbTorrent[]> {
		const q: Record<string, string> = {};
		if (filter.hashes) q.hashes = filter.hashes.join("|");
		if (filter.tag) q.tag = filter.tag;
		if (filter.category) q.category = filter.category;
		return (await this.req("torrents/info", { query: q })).json();
	}

	async torrent(hash: string): Promise<QbTorrent | undefined> {
		return (await this.torrents({ hashes: [hash.toLowerCase()] }))[0];
	}

	async files(hash: string): Promise<QbFile[]> {
		const files = await (await this.req("torrents/files", { query: { hash } })).json<QbFile[]>();
		return files.map((f, i) => ({ ...f, index: f.index ?? i }));
	}

	/** Add a .torrent file's bytes. Optionally stopped, with tags and a save path (theirs). */
	async addTorrentFile(bytes: Uint8Array, opts: { stopped?: boolean; tags?: string[]; savePath?: string; category?: string; filename?: string } = {}): Promise<void> {
		const fd = new FormData();
		fd.append("torrents", new Blob([bytes as BlobPart], { type: "application/x-bittorrent" }), opts.filename ?? "release.torrent");
		await this.appendAddOptions(fd, opts);
		const res = await this.req("torrents/add", { body: fd });
		const t = (await res.text()).trim();
		if (t && t !== "Ok." && !/^\{/.test(t)) throw new ReelixError("qb_add", `qBittorrent did not accept the torrent: ${t}`);
	}

	async addMagnet(magnet: string, opts: { stopped?: boolean; tags?: string[]; savePath?: string; category?: string } = {}): Promise<void> {
		const fd = new FormData();
		fd.append("urls", magnet);
		await this.appendAddOptions(fd, opts);
		const res = await this.req("torrents/add", { body: fd });
		const t = (await res.text()).trim();
		if (t && t !== "Ok." && !/^\{/.test(t)) throw new ReelixError("qb_add", `qBittorrent did not accept the magnet link: ${t}`);
	}

	private async appendAddOptions(fd: FormData, opts: { stopped?: boolean; tags?: string[]; savePath?: string; category?: string }) {
		const { major } = await this.version();
		if (opts.stopped) {
			fd.append(major >= 5 ? "stopped" : "paused", "true");
			fd.append("paused", "true");
			fd.append("stopped", "true");
		}
		if (opts.tags?.length) fd.append("tags", opts.tags.join(","));
		if (opts.savePath) fd.append("savepath", opts.savePath);
		if (opts.category) fd.append("category", opts.category);
	}

	async start(hashes: string[]): Promise<void> {
		const { major } = await this.version();
		await this.req(major >= 5 ? "torrents/start" : "torrents/resume", { form: { hashes: hashes.join("|") } });
	}

	async stop(hashes: string[]): Promise<void> {
		const { major } = await this.version();
		await this.req(major >= 5 ? "torrents/stop" : "torrents/pause", { form: { hashes: hashes.join("|") } });
	}

	async delete(hashes: string[], deleteFiles: boolean): Promise<void> {
		await this.req("torrents/delete", { form: { hashes: hashes.join("|"), deleteFiles: String(deleteFiles) } });
	}

	async addTags(hashes: string[], tags: string[]): Promise<void> {
		await this.req("torrents/addTags", { form: { hashes: hashes.join("|"), tags: tags.join(",") } });
	}

	async setFilePriority(hash: string, indexes: number[], priority: number): Promise<void> {
		if (!indexes.length) return;
		await this.req("torrents/filePrio", { form: { hash, id: indexes.join("|"), priority: String(priority) } });
	}

	async recheck(hashes: string[]): Promise<void> {
		await this.req("torrents/recheck", { form: { hashes: hashes.join("|") } });
	}

	async categories(): Promise<Record<string, { name: string; savePath: string }>> {
		return (await this.req("torrents/categories")).json();
	}

	async createCategory(name: string, savePath: string): Promise<void> {
		await this.req("torrents/createCategory", { form: { category: name, savePath } });
	}

	async maindata(rid: number): Promise<{ rid: number; full_update?: boolean; torrents?: Record<string, Partial<QbTorrent>>; torrents_removed?: string[]; server_state?: Record<string, unknown> }> {
		return (await this.req("sync/maindata", { query: { rid: String(rid) } })).json();
	}

	async freeSpace(): Promise<number | undefined> {
		const d = await this.maindata(0);
		return d.server_state?.free_space_on_disk as number | undefined;
	}
}
