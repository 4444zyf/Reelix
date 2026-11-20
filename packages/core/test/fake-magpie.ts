import { createServer, type Server } from "node:http";
import { tempApp } from "./helpers.ts";

export const USE = "sk-magpie-key-aaaaaaaaaaaaaaaaba6c9c";
export const ADMIN = "sk-magpie-key-bbbbbbbbbbbbbbbb32133d";

/** A small stand-in for magpie's gateway and management API, shaped like v0.1.4405's answers. */
export function fakeMagpie() {
	const state = {
		providers: [
			{ id: "qwen", name: "Qwen", off: false, models: [{ id: "flash", on: true }, { id: "plus", on: true }], keyList: [{ id: "k1" }] },
			{ id: "deepseek", name: "DeepSeek", off: false, models: [{ id: "v4", on: true }], keyList: [{ id: "k2" }] },
		],
		groups: [] as any[],
		keys: [
			{ id: "use1", name: "Reelix", masked: "sk-magpie-key-…ba6c9c", limit: { period: "day", cost: 1 } },
			{ id: "adm1", name: "Reelix admin", masked: "sk-magpie-key-…32133d", admin: "local" },
			{ id: "other", name: "StardewPilot", masked: "sk-magpie-key-…ffffff" },
		] as any[],
		failing: new Set<string>(),
		calls: [] as string[],
	};
	const models = () => [
		...state.providers.filter((p) => !p.off).flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`)),
		...state.groups.map((g) => g.ref ?? `group/${g.id}`),
	];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : {};
			const send = (status: number, o: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(o));
			};
			const auth = req.headers.authorization?.replace(/^Bearer /, "");
			const url = req.url!;
			state.calls.push(`${req.method} ${url}`);
			if (url.startsWith("/v1/magpie/admin/")) {
				if (req.headers.origin || req.headers["sec-fetch-mode"] || req.headers["sec-fetch-site"]) return send(403, { error: { code: "admin_browser_refused", message: "for scripts, not web pages" } });
				if (!auth) return send(401, { error: { message: "admin key required" } });
				if (auth !== ADMIN) return send(403, { error: { code: "gateway_key_not_admin", message: "this gateway key may not manage magpie" } });
				const path = url.slice("/v1/magpie/admin/".length);
				if (path === "providers") return send(200, { providers: state.providers });
				if (path === "gateway-keys") return send(200, { keys: state.keys });
				if (path === "routing-groups") return send(200, { groups: state.groups });
				if (path === "routing-groups/create") {
					const id = body.id ?? String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
					state.groups.push({ id, name: body.name, members: body.members, routing: body.routing, affinity: body.affinity, ready: true, ref: `group/${id}` });
					return send(200, { groups: state.groups });
				}
				if (path === "routing-groups/update") {
					const g = state.groups.find((x) => x.id === body.id);
					if (!g) return send(404, { error: `magpie has no routing group "${body.id}"` });
					Object.assign(g, body);
					return send(200, { groups: state.groups });
				}
				if (path === "routing-groups/delete") {
					state.groups = state.groups.filter((x) => x.id !== body.id);
					return send(200, { groups: state.groups });
				}
				if (path === "provider/on" || path === "provider/off") {
					const p = state.providers.find((x) => x.id === body.id)!;
					p.off = path.endsWith("off");
					return send(200, { providers: state.providers });
				}
				if (path === "gateway-keys/limit-key") {
					const k = state.keys.find((x) => x.id === body.key)!;
					// v0.1.4405: the first limit is "limit", the rest "moreLimits"; index adds or sets one
					const all = [...(k.limit ? [k.limit] : []), ...(k.moreLimits ?? [])];
					const next = body.index === undefined ? (body.limit ? [body.limit] : []) : Object.assign([...all], { [body.index]: body.limit }).filter(Boolean);
					delete k.limit;
					delete k.moreLimits;
					if (next[0]) k.limit = next[0];
					if (next.length > 1) k.moreLimits = next.slice(1);
					return send(200, { keys: state.keys });
				}
				return send(404, { error: "not found" });
			}
			if (url === "/v1/models") return send(200, { data: models().map((id) => ({ id })) });
			if (url === "/v1/magpie/limit") return send(auth === USE ? 200 : 401, { key: "Reelix", limits: [{ period: "day", cost: 0.4, costLimit: 1, reset: "2026-11-19T00:00:00Z" }] });
			if (url === "/v1/chat/completions") {
				const m = String(body.model);
				const g = state.groups.find((x) => (x.ref ?? `group/${x.id}`) === m);
				const members: string[] = g ? g.members : [m];
				const ok = members.some((x) => models().includes(x) && !state.failing.has(x));
				return ok ? send(200, { choices: [{ message: { content: "OK" } }] }) : send(502, { error: { message: `no member of ${m} answered` } });
			}
			send(404, {});
		});
	});
	return { state, server };
}

export async function setupMagpie() {
	const { app } = tempApp();
	const fake = fakeMagpie();
	await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
	const port = (fake.server.address() as any).port;
	app.setConfig("magpie.url", `http://127.0.0.1:${port}`);
	app.setSecret("magpie.api_key", USE);
	app.setSecret("magpie.admin_key", ADMIN);
	return { app, fake, close: () => new Promise<void>((r) => {
			fake.server.closeAllConnections();
			fake.server.close(() => r());
		}) };
}

