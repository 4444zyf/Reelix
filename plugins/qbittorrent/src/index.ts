import { type Call, type Outcome, OperationError, OutcomeError, type Transfer, type TransferFile, Type, definePlugin } from "@reelix/plugin";
import { QbClient, QbError, type QbTorrent, magnetHash, torrentHash } from "./client.ts";

const SEAM = "reelix:downloader@1";
const MARK = /^[a-z0-9-]+$/;
/** qBittorrent's "no estimate". */
const ETA_UNKNOWN = 8_640_000;

const CHECKING = new Set(["checkingUP", "checkingDL", "checkingResumeData", "moving"]);
const FAILED = new Set(["error", "missingFiles"]);
const NO_METADATA = new Set(["metaDL", "forcedMetaDL"]);

/** qBittorrent's states in the seam's words (docs/plugins.md §7.5). */
function stateOf(s: string): Transfer["state"] {
	if (FAILED.has(s)) return "error";
	if (CHECKING.has(s)) return "checking";
	if (s.startsWith("paused") || s.startsWith("stopped")) return "stopped";
	if (s.startsWith("queued")) return "queued";
	if (s === "uploading" || s === "stalledUP" || s === "forcedUP") return "seeding";
	return "downloading";
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function toTransfer(t: QbTorrent): Transfer {
	const state = stateOf(t.state);
	const hasMetadata = !NO_METADATA.has(t.state) && (t.total_size ?? t.size) > 0;
	const left = hasMetadata ? Math.max(0, t.amount_left) : 0;
	const progress = Math.min(1, Math.max(0, t.progress));
	return {
		id: t.hash.toLowerCase(),
		name: t.name,
		state,
		hasMetadata,
		done: hasMetadata && left === 0 && progress >= 1 && state !== "checking" && state !== "error" && t.state !== "allocating",
		progress,
		size: hasMetadata ? Math.max(0, t.size) : 0,
		left,
		folder: t.save_path,
		contentPath: t.content_path || undefined,
		marks: String(t.tags ?? "").split(",").map((x) => x.trim()).filter(Boolean),
		addedAt: iso(t.added_on),
		completedAt: t.completion_on > 0 ? iso(t.completion_on) : undefined,
		downSpeed: count(t.dlspeed),
		upSpeed: count(t.upspeed),
		etaSeconds: t.eta >= 0 && t.eta < ETA_UNKNOWN ? t.eta : undefined,
		peersSending: count(t.num_seeds),
		ratio: t.ratio >= 0 && t.ratio < 9999 ? t.ratio : undefined,
		seedingSeconds: count(t.seeding_time),
		problem: FAILED.has(t.state) ? { kind: "local", message: t.state === "missingFiles" ? "qBittorrent cannot find the files" : "qBittorrent reports an error with this torrent" } : undefined,
	};
}

const expected = (e: unknown) => e instanceof QbError || /^network/.test(String((e as { code?: unknown } | null)?.code ?? ""));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outcomeOf = (e: unknown): Outcome => (e instanceof QbError && e.kind === "auth" ? { outcome: "needs_auth" } : { outcome: "unavailable", message: message(e) });

/** qBittorrent being away or refusing is an outcome, not a broken plugin (docs/plugins.md §7). */
async function answering<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (expected(e)) throw new OutcomeError(outcomeOf(e));
		throw e;
	}
}

const notSetUp = () => new OperationError("not_configured", "qBittorrent is not set up: give its address in Settings → Plugins → qbittorrent (plugins.qbittorrent.url).");

export default definePlugin({
	config: Type.Object({
		url: Type.Optional(Type.String()),
		username: Type.String({ default: "admin" }),
	}),
	async activate(ctx, settings) {
		const url = settings.url;
		let client: QbClient | undefined;
		const qb = async () => (client ??= new QbClient(ctx.http.fetch, { url: url!, username: settings.username, password: (await ctx.secret.get("password")) ?? "" }));

		if (url) {
			const list = async (o: { ids?: string[]; mark?: string }, signal: AbortSignal) => {
				// An empty list never reaches qBittorrent, which reads it as "every torrent" (§7.5).
				if (o.ids && !o.ids.length) return [];
				const ids = o.ids?.map((h) => h.toLowerCase());
				const found = (await (await qb()).torrents({ hashes: ids, tag: o.mark }, signal)).map(toTransfer);
				return found.filter((t) => (!ids || ids.includes(t.id)) && (!o.mark || t.marks.includes(o.mark)));
			};
			const get = async (id: string, signal: AbortSignal): Promise<Transfer | undefined> => {
				const [t] = await list({ ids: [id] }, signal);
				if (!t || t.problem) return t;
				// A tracker's message is a problem; the state stays as it is.
				const failing = (await (await qb()).trackers(t.id, signal)).find((x) => x.status === 4 && !x.url.startsWith("** ["));
				return failing ? { ...t, problem: { kind: "tracker", message: failing.msg || "the tracker does not answer" } } : t;
			};
			const waitFor = async (id: string, call: Call) => {
				const until = Math.min(Date.now() + 15_000, call.deadline - 1_000);
				for (;;) {
					const [t] = await list({ ids: [id] }, call.signal);
					if (t || Date.now() > until) return t;
					await new Promise((r) => setTimeout(r, 250));
				}
			};
			// The change feed: qBittorrent's `sync/maindata` sends only what changed since a response id.
			let rid = 0;
			let known = new Map<string, QbTorrent>();

			await ctx.provide(SEAM, {
				id: "qbittorrent",
				label: "qBittorrent",
				async add(src, o, call) {
					if (!MARK.test(o.mark)) throw new Error(`mark "${o.mark}" must be lowercase letters, digits and hyphens`);
					try {
						const id = "torrent" in src ? torrentHash(src.torrent) : magnetHash(src.magnet);
						if (!id) return { outcome: "unavailable", message: "The magnet link has no info-hash." };
						// qBittorrent ignores the options for a torrent it already has.
						if ((await list({ ids: [id] }, call.signal)).length) return { id, duplicate: true };
						await (await qb()).add("torrent" in src ? { torrent: src.torrent, filename: `${id}.torrent` } : { magnet: src.magnet }, { stopped: o.paused, tags: [o.mark], savePath: o.folder }, call.signal);
						if (!(await waitFor(id, call))) return { outcome: "unavailable", message: "qBittorrent accepted the torrent, but it did not appear." };
						return { id, duplicate: false };
					} catch (e) {
						if (expected(e)) return outcomeOf(e);
						throw e;
					}
				},
				get: (id, call) => answering(() => get(id, call.signal)),
				list: (o, call) => answering(() => list(o, call.signal)),
				changes: (cursor, call) =>
					answering(async () => {
						// Only our own last response id is usable; anything else starts again with a full answer.
						const asked = cursor !== undefined && cursor === String(rid) ? rid : 0;
						const data = await (await qb()).maindata(asked, call.signal);
						const full = asked === 0 || !!data.full_update;
						if (full) known = new Map();
						const patched = Object.keys(data.torrents ?? {});
						for (const h of patched) known.set(h, { ...known.get(h), ...data.torrents![h], hash: h } as QbTorrent);
						const removed = full ? [] : (data.torrents_removed ?? []).map((h) => h.toLowerCase());
						for (const h of data.torrents_removed ?? []) known.delete(h);
						rid = data.rid;
						const changed = (full ? [...known.keys()] : patched).flatMap((h) => (known.has(h) ? [toTransfer(known.get(h)!)] : []));
						return { cursor: String(rid), full, changed, removed };
					}),
				files: (id, call) =>
					answering(async () => {
						const [t] = await list({ ids: [id] }, call.signal);
						if (!t?.hasMetadata) return [];
						const files = await (await qb()).files(t.id, call.signal);
						return files
							.map((f, i): TransferFile => ({ index: f.index ?? i, path: f.name.replace(/\\/g, "/"), size: f.size, progress: Math.min(1, Math.max(0, f.progress)), wanted: f.priority > 0 }))
							.sort((a, b) => a.index - b.index);
					}),
				setWanted: (id, indexes, wanted, call) =>
					answering(async () => {
						if (indexes.length) await (await qb()).setFilePriority(id.toLowerCase(), indexes, wanted ? 1 : 0, call.signal);
					}),
				start: (ids, call) =>
					answering(async () => {
						if (ids.length) await (await qb()).start(ids, call.signal);
					}),
				stop: (ids, call) =>
					answering(async () => {
						if (ids.length) await (await qb()).stop(ids, call.signal);
					}),
				remove: (ids, o, call) =>
					answering(async () => {
						if (ids.length) await (await qb()).delete(ids, o.deleteFiles, call.signal);
					}),
				addMark: (ids, mark, call) =>
					answering(async () => {
						if (!MARK.test(mark)) throw new Error(`mark "${mark}" must be lowercase letters, digits and hyphens`);
						if (ids.length) await (await qb()).addTags(ids, [mark], call.signal);
					}),
				freeSpace: (call) => answering(async () => count((await (await qb()).maindata(0, call.signal)).server_state?.free_space_on_disk)),
				defaultFolder: (call) => answering(async () => (await qb()).defaultSavePath(call.signal)),
			});
		}

		/** For operations: qBittorrent's own refusal reaches the caller as it is. */
		const operating = async <T>(fn: (c: QbClient) => Promise<T>): Promise<T> => {
			if (!url) throw notSetUp();
			try {
				return await fn(await qb());
			} catch (e) {
				if (expected(e)) throw new OperationError(e instanceof QbError && e.kind === "auth" ? "needs_auth" : "unavailable", message(e));
				throw e;
			}
		};

		await ctx.operation({
			name: "prefs",
			summary: "Read qBittorrent preferences (save folders, completion behaviour, …)",
			effect: "read",
			input: Type.Object({ keys: Type.Optional(Type.Array(Type.String())) }),
			async run(i) {
				const p = await operating((c) => c.preferences(ctx.signal));
				const keys = i.keys?.length ? i.keys : ["save_path", "temp_path_enabled", "temp_path", "auto_tmm_enabled", "torrent_changed_tmm_enabled", "max_ratio_enabled", "max_ratio", "max_ratio_act", "add_stopped_enabled", "start_paused_enabled", "preallocate_all", "incomplete_files_ext"];
				return Object.fromEntries(keys.filter((k) => k in p).map((k) => [k, p[k]]));
			},
			toText: (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n"),
		});

		await ctx.operation({
			name: "set_prefs",
			summary: "Change qBittorrent preferences (JSON object)",
			effect: "admin",
			agentMay: true,
			input: Type.Object({ prefs: Type.Record(Type.String(), Type.Unknown()) }),
			async run(i) {
				await operating((c) => c.setPreferences(i.prefs, ctx.signal));
				return { changed: Object.keys(i.prefs) };
			},
			toText: (o: { changed: string[] }) => `qBittorrent preferences changed: ${o.changed.join(", ")}`,
		});

		await ctx.operation({
			name: "torrents",
			summary: "All torrents in qBittorrent (not only Reelix's), for adoption and diagnosis",
			effect: "read",
			input: Type.Object({ filter: Type.Optional(Type.String({ description: "substring of the name" })), limit: Type.Optional(Type.Integer({ default: 50 })) }),
			async run(i) {
				let all = await operating((c) => c.torrents({}, ctx.signal));
				if (i.filter) all = all.filter((x) => x.name.toLowerCase().includes(i.filter!.toLowerCase()));
				return { total: all.length, torrents: all.slice(0, i.limit).map((x) => ({ hash: x.hash, name: x.name, state: x.state, progress: x.progress, size: x.size, tags: x.tags, category: x.category, content_path: x.content_path })) };
			},
			toText: (o: { total: number; torrents: { hash: string; state: string; progress: number; size: number; tags: string; name: string }[] }) =>
				`${o.total} torrents\n${o.torrents.map((x) => `${x.hash.slice(0, 10)} | ${x.state} | ${Math.round(x.progress * 100)}% | ${(x.size / 1e9).toFixed(1)} GB | ${x.tags || "-"} | ${x.name}`).join("\n")}`,
		});

		await ctx.check("qbittorrent", async () => {
			if (!url) return { ok: false, detail: "not configured", fix: "reelix config set plugins.qbittorrent.url http://host:8080" };
			try {
				const c = await qb();
				const v = await c.version(ctx.signal);
				const save = await c.defaultSavePath(ctx.signal);
				const prefs = await c.preferences(ctx.signal);
				const temp = prefs.temp_path_enabled ? `; incomplete folder ${String(prefs.temp_path)} (files move on completion)` : "";
				return { ok: true, detail: `qBittorrent ${v.app} (API ${v.api}); saves to ${save}${temp}` };
			} catch (e) {
				if (!expected(e)) throw e;
				return { ok: false, detail: message(e) };
			}
		});
	},
});
