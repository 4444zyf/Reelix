import { type Outcome, type PluginCheck, SETTINGS, type PluginContext, Type, definePlugin } from "@reelix/plugin";
import { type FetchRef, JackettError, jackettClient } from "./client.ts";

const SEAM = "reelix:indexer@1";
/** Each server has its own key, declared per entry of `servers` (docs/plugins.md §12.2). */
const keyName = (i: number) => `servers.${i}.api_key`;

const isExpected = (e: unknown) => e instanceof JackettError || /^network/.test(String((e as { code?: unknown } | null)?.code ?? ""));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function answering<T>(fn: () => Promise<T>): Promise<T | Outcome> {
	try {
		return await fn();
	} catch (e) {
		if (isExpected(e)) return { outcome: "unavailable", message: message(e) };
		throw e;
	}
}

type Server = { id: string; label: string; url: string; keyName: string };

function clientFor(ctx: PluginContext, s: Server) {
	return ctx.secret.get(s.keyName).then((key) => (key ? jackettClient(ctx, s.url, key) : undefined));
}

export default definePlugin({
	config: Type.Object({
		servers: Type.Array(Type.Object({ url: Type.Optional(Type.String({ [SETTINGS.required]: true })) }), { default: [], maxItems: 3, [SETTINGS.required]: true }),
	}),
	async activate(ctx, settings) {
		const servers: Server[] = settings.servers.flatMap((s, i) =>
			s.url ? [{ id: i === 0 ? "jackett" : `jackett-${i + 1}`, label: i === 0 ? "Jackett" : `Jackett ${i + 1}`, url: s.url, keyName: keyName(i) }] : [],
		);

		for (const s of servers) {
			await ctx.provide(SEAM, {
				id: s.id,
				label: s.label,
				kinds: ["movie", "show", "anime"],
				sites: (call) =>
					answering(async () => {
						const client = await clientFor(ctx, s);
						if (!client) return { outcome: "needs_auth" } as const;
						return (await client.sites(call.signal)).map(({ id, name, private: p }) => ({ id, name, private: p }));
					}),
				async search(q, call) {
					const client = await clientFor(ctx, s);
					const ids = q.sites ?? [];
					if (!client) return { hits: [], sites: ids.map((site) => ({ site, ok: false, count: 0, ms: 0, outcome: { outcome: "needs_auth" as const } })) };
					return client.searchEach(ids, q.queries, q.kind, call);
				},
				fetch: (ref, call) =>
					answering(async () => {
						const { link, magnet } = JSON.parse(ref) as FetchRef;
						const client = await clientFor(ctx, s);
						if (link && client) {
							try {
								return await client.fetchLink(link, call.signal);
							} catch (e) {
								if (!magnet || !isExpected(e)) throw e;
							}
						}
						if (magnet) return { magnet };
						return { outcome: "unavailable", message: "This release has no download link left." } as const;
					}),
			});
		}

		/** Each server's last test of its indexers, until the plugin restarts: the quick check shows it (docs/settings.md, Indexers). */
		const lastHealth = new Map<string, { indexer: string; ok: boolean; ms: number; error?: string }[]>();

		/** Every server's indexers, with a test search when asked; a server's trouble stays on its line. */
		async function survey(test: boolean, limitMs: number) {
			const signal = AbortSignal.timeout(limitMs);
			const deadline = Date.now() + limitMs;
			return Promise.all(
				servers.map(async (s) => {
					try {
						const client = await clientFor(ctx, s);
						if (!client) return { server: s.id, error: `API key missing (secret plugins.jackett.${s.keyName})`, missingKey: s.keyName, indexers: [] };
						const indexers = await client.sites(signal);
						const health = test ? (await client.searchEach(indexers.map((i) => i.id), ["test"], undefined, { signal, deadline })).sites.map((r) => ({ indexer: r.site, ok: r.ok, ms: r.ms, error: r.outcome?.outcome === "unavailable" ? r.outcome.message : undefined })) : undefined;
						if (health) lastHealth.set(s.id, health);
						return { server: s.id, indexers, health };
					} catch (e) {
						if (!isExpected(e)) throw e;
						return { server: s.id, error: message(e), indexers: [] };
					}
				}),
			);
		}

		await ctx.operation({
			name: "indexers",
			summary: "Jackett's configured indexers; with test=true, a health check of each",
			effect: "read",
			input: Type.Object({ test: Type.Optional(Type.Boolean()) }),
			async run({ test }) {
				const found = await survey(!!test, 60_000);
				return { servers: found, note: servers.length ? undefined : "No Jackett server is set up (plugins.jackett.servers)." };
			},
			toText: (o: { note?: string; servers: Awaited<ReturnType<typeof survey>> }) =>
				o.note ??
				o.servers
					.map((s) => [`${s.server}${s.error ? `: ${s.error}` : ""}`, ...s.indexers.map((x) => { const h = s.health?.find((y) => y.indexer === x.id); return `${x.id} | ${x.name} | ${x.type ?? ""}${h ? ` | ${h.ok ? `ok ${(h.ms / 1000).toFixed(1)}s` : `ERROR ${h.error}`}` : ""}`; })].join("\n"))
					.join("\n"),
		});

		await ctx.check("jackett", async ({ quick }) => {
			if (!servers.length)
				return { state: "failed", cause: { key: "checks.not_set_up" }, impact: { key: "checks.no_search" }, action: { label: { key: "checks.add_server" }, setting: "servers" }, cli: "reelix config set plugins.jackett.servers '[{\"url\":\"http://host:9117\"}]'", raw: "not configured", cause_id: "setup" };
			const found = await survey(!quick, 25_000);
			const test = { label: { key: "checks.test_each" }, operation: "indexers", input: { test: true } };
			const results = found.map((s): PluginCheck => {
				const server = servers.find((x) => x.id === s.server)?.label ?? s.server;
				if (s.missingKey) return { state: "failed", cause: { key: "checks.no_key", values: { server } }, impact: { key: "checks.no_search" }, action: { label: { key: "checks.add_key" }, secret: s.missingKey }, raw: `${s.server}: ${s.error}` };
				if (s.error) return { state: "failed", cause: { key: "checks.unreachable", values: { server } }, impact: { key: "checks.no_search" }, action: { label: { key: "checks.add_server" }, setting: "servers" }, raw: `${s.server}: ${s.error}` };
				if (!s.indexers.length) return { state: "failed", cause: { key: "checks.no_indexers", values: { server } }, impact: { key: "checks.no_search" }, raw: `${s.server}: no indexers configured in Jackett` };
				const health = s.health ?? lastHealth.get(s.server);
				if (!health) return { state: "not_tested", cause: { key: "checks.not_tested", values: { count: s.indexers.length } }, action: test, raw: `${s.indexers.length} indexers: ${s.indexers.map((i) => i.name).join(", ")}` };
				const name = (id: string) => s.indexers.find((i) => i.id === id)?.name ?? id;
				const raw = health.map((h) => `${name(h.indexer)}: ${h.ok ? `ok ${(h.ms / 1000).toFixed(1)}s` : `ERROR ${h.error}`}`).join("; ");
				const failed = health.filter((h) => !h.ok).length;
				if (!failed) return { state: "passed", cause: { key: "checks.all_answer", values: { count: health.length } }, raw };
				if (failed < health.length) return { state: "degraded", cause: { key: "checks.some_fail", values: { failed, count: health.length } }, impact: { key: "checks.some_fail_impact" }, action: test, raw };
				return { state: "failed", cause: { key: "checks.none_answer" }, impact: { key: "checks.no_search" }, action: test, raw };
			});
			// One result for every server: the worst of them, with every server's details.
			const rank = ["passed", "not_tested", "degraded", "failed"];
			const worst = results.reduce((a, b) => (rank.indexOf(b.state) > rank.indexOf(a.state) ? b : a));
			return { ...worst, raw: results.map((r) => r.raw).join("; ") };
		});
	},
});
