import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Type } from "typebox";
import type { Reelix } from "./app.ts";
import { MODEL_ROLES, type ModelRole, roleModels } from "./config.ts";
import { json, kvGet, kvSet } from "./db.ts";
import { consumeApproval, hasApproval } from "./approvals.ts";
import { defineOperation } from "./registry.ts";
import { ReelixError, errorMessage, newId, nowIso } from "./util.ts";

/*
 * Configuring a magpie gateway (docs/magpie.md): plan, then apply; checked afterwards and rolled
 * back when it breaks a role. The agent may not change the model it runs on, leave a role with no
 * usable model, or touch Reelix's own keys.
 */

// ---------------------------------------------------------------------------------- HTTP

export type MagpieHttp = (method: string, path: string, opts: { key?: string; body?: unknown; timeoutMs?: number }) => Promise<{ status: number; body: any }>;

/**
 * Plain node:http on purpose: magpie refuses its management API to anything carrying Origin or
 * Sec-Fetch-* headers, and Node's fetch sends Sec-Fetch-Mode.
 */
export function magpieHttp(baseUrl: string): MagpieHttp {
	const base = new URL(baseUrl.replace(/\/+$/, "") + "/");
	return (method, path, { key, body, timeoutMs = 15_000 }) =>
		new Promise((resolve, reject) => {
			const u = new URL(path.replace(/^\//, ""), base);
			const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
			const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
				u,
				{
					method,
					headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
					timeout: timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let parsed: any = text;
						try {
							parsed = text ? JSON.parse(text) : null;
						} catch {}
						resolve({ status: res.statusCode ?? 0, body: parsed });
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error(`magpie did not answer within ${Math.round(timeoutMs / 1000)} s`)));
			req.on("error", reject);
			if (payload) req.write(payload);
			req.end();
		});
}

function errorText(body: any): string {
	if (!body) return "";
	if (typeof body === "string") return body.slice(0, 300);
	const e = body.error;
	return String(typeof e === "string" ? e : (e?.message ?? JSON.stringify(body))).slice(0, 300);
}

type Conn = { url: string; useKey?: string; adminKey?: string; http: MagpieHttp };

/** Tests swap the transport. */
export const magpieTransport: { make: (url: string) => MagpieHttp } = { make: magpieHttp };

function connect(app: Reelix, needAdmin = false): Conn {
	const url = app.config.magpie.url?.replace(/\/+$/, "");
	if (!url) throw new ReelixError("not_configured", "magpie is not set up: set magpie.url under Settings → Models.");
	const adminKey = app.secrets["magpie.admin_key"];
	if (needAdmin && !adminKey)
		throw new ReelixError(
			"not_configured",
			"Changing magpie needs a separate gateway key that may manage magpie: the owner makes one in magpie (`magpie gateway-key add \"Reelix admin\"`, then `magpie gateway-key admin <id> local`, or `any` when magpie runs in another container, as with docker-compose.yml) and enters it as the secret magpie.admin_key.",
		);
	return { url, useKey: app.secrets["magpie.api_key"], adminKey, http: magpieTransport.make(url) };
}

async function admin(c: Conn, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
	const r = await c.http(method, `/v1/magpie/admin/${path}`, { key: c.adminKey, body });
	if (r.status === 401 || r.status === 403) {
		const why = errorText(r.body);
		// From another container, magpie counts Reelix as another machine (docs/deployment.md).
		const hint = /this computer only/i.test(why)
			? " Reelix reaches magpie from another container, which magpie counts as another machine: allow the admin key with `magpie gateway-key admin <id> any` (docker-compose.yml limits magpie to Reelix's network with MAGPIE_ALLOW_IPS)."
			: /not allowed|allowed addresses|MAGPIE_ALLOW_IPS/i.test(why)
				? " magpie does not accept calls from Reelix's address: add Reelix's network to MAGPIE_ALLOW_IPS."
				: "";
		throw new ReelixError("magpie_refused", `magpie refused the admin key (${r.status}): ${why}${hint}`);
	}
	if (r.status < 200 || r.status >= 300) throw new ReelixError("magpie_error", `magpie ${method} ${path}: ${r.status} ${errorText(r.body)}`);
	return r.body;
}

// ---------------------------------------------------------------------------------- state

export type MagpieGroup = { id: string; ref: string; name: string; members: string[]; routing?: string; affinity?: string; raw: Record<string, unknown> };
export type MagpieProvider = { id: string; name: string; off: boolean; models: string[]; keys: number };
export type MagpieKey = { id: string; name: string; masked: string; admin?: string; own?: boolean; limits: Record<string, unknown>[]; used?: Record<string, unknown>[] };
export type MagpieState = {
	url: string;
	models: string[];
	admin: boolean;
	groups: MagpieGroup[];
	providers: MagpieProvider[];
	keys: MagpieKey[];
	limit?: Record<string, any>;
	quotas?: unknown[];
	/** Roles whose list names magpie models. */
	roles: { role: ModelRole; specs: string[] }[];
	has_admin_key: boolean;
	errors: string[];
};

const DERIVED_GROUP_FIELDS = ["memberInfo", "ready", "holds", "offers", "shared", "ref", "routedAt", "patterns", "matched", "placed", "former"];

function toGroup(g: any): MagpieGroup {
	return { id: String(g.id), ref: String(g.ref ?? `group/${g.id}`), name: String(g.name ?? g.id), members: (g.members ?? []).map(String), routing: g.routing || undefined, affinity: g.affinity || undefined, raw: g };
}

export async function readMagpie(app: Reelix, opts: { quotas?: boolean } = {}): Promise<MagpieState> {
	const c = connect(app);
	const st: MagpieState = {
		url: c.url,
		models: [],
		admin: !!c.adminKey,
		has_admin_key: !!c.adminKey,
		groups: [],
		providers: [],
		keys: [],
		roles: MODEL_ROLES.map((role) => ({ role, specs: roleModels(app.config, role).filter((s) => s.startsWith("magpie/")) })).filter((r) => r.specs.length),
		errors: [],
	};
	const m = await c.http("GET", "/v1/models", { key: c.useKey });
	if (m.status !== 200) throw new ReelixError("magpie_error", `magpie /v1/models: ${m.status} ${errorText(m.body)}`);
	st.models = (m.body?.data ?? []).map((x: any) => String(x.id ?? "")).filter(Boolean);
	if (c.useKey) {
		const l = await c.http("GET", "/v1/magpie/limit", { key: c.useKey }).catch(() => undefined);
		if (l?.status === 200) st.limit = l.body;
	}
	if (c.adminKey) {
		try {
			const [g, p, k] = await Promise.all([admin(c, "GET", "routing-groups"), admin(c, "GET", "providers"), admin(c, "GET", "gateway-keys")]);
			st.groups = (g?.groups ?? []).map(toGroup);
			st.providers = (p?.providers ?? []).map((x: any) => ({
				id: String(x.id),
				name: String(x.name ?? x.id),
				off: !!x.off,
				models: (x.models ?? []).filter((mm: any) => mm.on !== false).map((mm: any) => String(mm.id)),
				keys: Array.isArray(x.keyList) ? x.keyList.length : x.key?.set ? 1 : 0,
			}));
			// magpie lists a key's first limit as "limit" and the rest as "moreLimits"
			st.keys = (k?.keys ?? []).map((x: any) => ({ id: String(x.id), name: String(x.name ?? ""), masked: String(x.masked ?? ""), admin: x.admin || undefined, own: sameKey(String(x.masked ?? ""), c.useKey) || sameKey(String(x.masked ?? ""), c.adminKey), limits: x.limits ?? [...(x.limit ? [x.limit] : []), ...(x.moreLimits ?? [])], used: x.usedAll }));
			if (opts.quotas) {
				const q = await c.http("GET", "/v1/magpie/quotas", { key: c.adminKey }).catch(() => undefined);
				if (q?.status === 200) st.quotas = q.body?.data ?? [];
			}
		} catch (e) {
			st.admin = false;
			st.errors.push(app.redact(errorMessage(e)));
		}
	}
	return st;
}

/** A masked key ("sk-magpie-key-…ba6c9c") that is this secret. */
function sameKey(masked: string, secret?: string): boolean {
	if (!secret || !masked.includes("…")) return false;
	const [head, tail] = masked.split("…") as [string, string];
	return secret.startsWith(head) && secret.endsWith(tail) && secret.length > head.length + tail.length;
}

// ---------------------------------------------------------------------------------- changes

export const ROUTINGS = ["smart", "order", "rotate", "usage", "pace", "weight", "free", "fast", "cheap", "drain", "expiring"];
export const STAYS = ["auto", "session", "turn", "off", "strict"];

export type LimitSpec = { period: string; cost?: number; tokens?: number };
export type MagpieChange =
	| { action: "group.create"; name: string; members: string[]; routing?: string; stays?: string }
	| { action: "group.update"; id: string; name?: string; members?: string[]; routing?: string; stays?: string }
	| { action: "group.remove"; id: string }
	| { action: "group.restore"; group: Record<string, unknown> }
	| { action: "provider.on" | "provider.off" | "provider.remove"; id: string }
	| { action: "provider.add"; preset: string }
	| { action: "key.limit"; key: string; limits: LimitSpec[] };

export type Level = "safe" | "approve" | "refused";
const RANK: Record<Level, number> = { safe: 0, approve: 1, refused: 2 };

/** Something of this Reelix running on a model right now (the host fills this in). */
export type ModelUse = { actor: string; spec: string; label: string };

export type MagpiePlan = {
	id: string;
	change: MagpieChange;
	actor: string;
	created_at: string;
	expires_at: string;
	level: Level;
	reasons: string[];
	summary: string;
	roles: { role: ModelRole; affected: string[]; empty_after: boolean }[];
	running: ModelUse[];
	before: unknown;
	fingerprint: string;
};

const isOwner = (actor: string) => actor.startsWith("owner:");
const bare = (member: string) => member.replace(/#.*$/, "").replace(/:[a-z]+$/i, "");
const slug = (name: string) =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "group";

/** A group by its id, its own name for itself (group/<id>, or auto/<model> for one magpie made), or group/<id>. */
function findGroup(st: MagpieState, idOrRef: string): MagpieGroup | undefined {
	const r = bare(idOrRef);
	return st.groups.find((g) => g.id === r || g.ref === r || `group/${g.id}` === r);
}

/** Apply a change to a copy of the state, to see what is left afterwards. */
function simulate(st: MagpieState, ch: MagpieChange): MagpieState {
	const next: MagpieState = { ...st, groups: st.groups.map((g) => ({ ...g, members: [...g.members] })), providers: st.providers.map((p) => ({ ...p })) };
	switch (ch.action) {
		case "group.create":
			next.groups.push({ id: slug(ch.name), ref: `group/${slug(ch.name)}`, name: ch.name, members: ch.members, routing: ch.routing, raw: {} });
			break;
		case "group.restore": {
			const g = toGroup(ch.group);
			next.groups.push(g);
			break;
		}
		case "group.update": {
			const g = next.groups.find((x) => x.id === ch.id);
			if (g && ch.members) g.members = ch.members;
			break;
		}
		case "group.remove":
			next.groups = next.groups.filter((g) => g.id !== ch.id);
			break;
		case "provider.on":
		case "provider.off": {
			const p = next.providers.find((x) => x.id === ch.id);
			if (p) p.off = ch.action === "provider.off";
			break;
		}
		case "provider.remove":
			next.providers = next.providers.filter((p) => p.id !== ch.id);
			break;
	}
	return next;
}

/** Can magpie answer this model id (as /v1/models names it) in this state? */
function usable(st: MagpieState, ref: string, seen = new Set<string>()): boolean {
	ref = bare(ref);
	if (seen.has(ref)) return false;
	seen.add(ref);
	const g = findGroup(st, ref);
	if (g) return g.members.some((m) => usable(st, m, seen));
	if (ref.startsWith("group/")) return !st.admin && st.models.includes(ref);
	if (!st.admin || !st.providers.length) return st.models.includes(ref);
	const [pid, ...rest] = ref.split("/");
	const p = st.providers.find((x) => x.id === pid);
	if (!p || p.off) return false;
	const model = rest.join("/");
	return !p.models.length || p.models.includes(model) || st.models.includes(ref);
}

/** Every magpie model id whose answer the change can alter (the target, and groups that contain it). */
function affectedRefs(st: MagpieState, ch: MagpieChange): { exact: Set<string>; providers: Set<string> } {
	const exact = new Set<string>();
	const providers = new Set<string>();
	switch (ch.action) {
		case "group.update":
		case "group.remove":
			for (const g of [findGroup(st, ch.id)]) if (g) exact.add(g.ref).add(`group/${g.id}`);
			exact.add(`group/${ch.id}`);
			break;
		case "provider.on":
		case "provider.off":
		case "provider.remove":
			providers.add(ch.id);
			break;
	}
	const hits = (m: string) => exact.has(bare(m)) || providers.has(bare(m).split("/")[0]!);
	// groups inside groups: repeat until nothing new
	for (let grew = true; grew; ) {
		grew = false;
		for (const g of st.groups) {
			const ref = g.ref;
			if (!exact.has(ref) && g.members.some(hits)) {
				exact.add(ref).add(`group/${g.id}`);
				grew = true;
			}
		}
	}
	return { exact, providers };
}

function touches(a: { exact: Set<string>; providers: Set<string> }, spec: string): boolean {
	if (!spec.startsWith("magpie/")) return false;
	const ref = bare(spec.slice("magpie/".length));
	return a.exact.has(ref) || (!ref.startsWith("group/") && a.providers.has(ref.split("/")[0]!));
}

function describeChange(ch: MagpieChange, st: MagpieState): string {
	switch (ch.action) {
		case "group.create":
			return `Create routing group "${ch.name}" (group/${slug(ch.name)}): ${ch.members.join(", ")}${ch.routing ? `, routing ${ch.routing}` : ""}${ch.stays ? `, stays ${ch.stays}` : ""}`;
		case "group.restore":
			return `Re-create routing group group/${String(ch.group.id)}: ${((ch.group.members as string[]) ?? []).join(", ")}`;
		case "group.update": {
			const g = st.groups.find((x) => x.id === ch.id);
			const parts = [
				ch.members ? `members ${g?.members.join(", ") || "?"} → ${ch.members.join(", ")}` : "",
				ch.routing ? `routing ${g?.routing ?? "smart"} → ${ch.routing}` : "",
				ch.stays ? `stays ${g?.affinity ?? "auto"} → ${ch.stays}` : "",
				ch.name ? `name ${g?.name} → ${ch.name}` : "",
			].filter(Boolean);
			return `Change group/${ch.id}: ${parts.join("; ") || "nothing"}`;
		}
		case "group.remove":
			return `Remove routing group group/${ch.id}`;
		case "provider.on":
			return `Switch provider ${ch.id} on`;
		case "provider.off":
			return `Switch provider ${ch.id} off`;
		case "provider.remove":
			return `Remove provider ${ch.id} and its keys (cannot be undone)`;
		case "provider.add":
			return `Add provider from preset ${ch.preset}, with the key the owner entered`;
		case "key.limit": {
			const k = st.keys.find((x) => x.id === ch.key || x.name === ch.key);
			return `Set the limits of gateway key "${k?.name ?? ch.key}": ${ch.limits.length ? ch.limits.map((l) => `${l.period}${l.cost !== undefined ? ` $${l.cost}` : ""}${l.tokens !== undefined ? ` ${l.tokens} tokens` : ""}`).join(", ") : "no limit"}`;
		}
	}
}

function snapshot(st: MagpieState, ch: MagpieChange): unknown {
	switch (ch.action) {
		case "group.update":
		case "group.remove": {
			const g = st.groups.find((x) => x.id === ch.id);
			return g ? Object.fromEntries(Object.entries(g.raw).filter(([k]) => !DERIVED_GROUP_FIELDS.includes(k))) : null;
		}
		case "provider.on":
		case "provider.off":
		case "provider.remove": {
			const p = st.providers.find((x) => x.id === ch.id);
			return p ? { id: p.id, off: p.off } : null;
		}
		case "key.limit": {
			const k = st.keys.find((x) => x.id === ch.key || x.name === ch.key);
			return k ? { id: k.id, limits: k.limits } : null;
		}
		case "group.create":
			return st.groups.find((g) => g.id === slug(ch.name)) ?? null;
		default:
			return null;
	}
}

/** Work out what a change would do and whether this actor may make it (docs/magpie.md, Levels). */
export function assessChange(app: Reelix, st: MagpieState, ch: MagpieChange, actor: string, inUse: ModelUse[]): Omit<MagpiePlan, "id" | "created_at" | "expires_at"> {
	const refused: string[] = [];
	const approve: string[] = [];
	const invalid: string[] = [];
	const owner = isOwner(actor);
	if (!st.admin) invalid.push("Reelix has no working admin key for magpie (secret magpie.admin_key)");

	// --- validity
	const memberCheck = (members: string[], selfId?: string) => {
		if (!members.length) invalid.push("a routing group needs at least one member");
		for (const m of members) {
			const b = bare(m);
			if (selfId && b === `group/${selfId}`) invalid.push(`group/${selfId} cannot contain itself`);
			else if (findGroup(st, b) ? false : b.startsWith("group/") || !usable(st, b)) invalid.push(`magpie does not serve "${m}" (see magpie_status for the models it has)`);
		}
	};
	const groupOf = (id: string) => findGroup(st, id);
	switch (ch.action) {
		case "group.create":
			if (!ch.name.trim()) invalid.push("the group needs a name");
			if (groupOf(slug(ch.name))) invalid.push(`group/${slug(ch.name)} already exists: change it instead`);
			memberCheck(ch.members);
			break;
		case "group.restore":
			if (groupOf(String(ch.group.id))) invalid.push(`group/${String(ch.group.id)} already exists`);
			break;
		case "group.update":
			if (!groupOf(ch.id)) invalid.push(`magpie has no routing group "${ch.id}"`);
			else if (ch.members) memberCheck(ch.members, ch.id);
			// a member group that already contains this one would make a loop
			if (ch.members) {
				const holders = affectedRefs(st, { action: "group.update", id: ch.id }).exact;
				for (const m of ch.members.map(bare)) if (m !== `group/${ch.id}` && holders.has(m)) invalid.push(`${m} already contains group/${ch.id}: that would be a loop`);
			}
			break;
		case "group.remove": {
			if (!groupOf(ch.id)) invalid.push(`magpie has no routing group "${ch.id}"`);
			const holders = st.groups.filter((g) => g.members.map(bare).includes(`group/${ch.id}`));
			if (holders.length) invalid.push(`group/${ch.id} is a member of ${holders.map((g) => `group/${g.id}`).join(", ")}: take it out there first`);
			approve.push("removing a group");
			break;
		}
		case "provider.on":
		case "provider.off":
		case "provider.remove":
			if (!st.providers.some((p) => p.id === ch.id)) invalid.push(`magpie has no provider "${ch.id}"`);
			approve.push(ch.action === "provider.remove" ? "removing a provider (its keys are deleted; this cannot be undone)" : "switching a provider");
			break;
		case "provider.add":
			if (!app.secrets["magpie.new_provider_key"]) invalid.push("no key waiting: ask the owner for it with ask kind=secret, secret_key=magpie.new_provider_key, then plan again");
			approve.push("adding a provider");
			break;
		case "key.limit": {
			const k = st.keys.find((x) => x.id === ch.key || x.name === ch.key);
			if (!k) invalid.push(`magpie has no gateway key "${ch.key}"`);
			else if (k.own || sameKey(k.masked, app.secrets["magpie.api_key"]) || sameKey(k.masked, app.secrets["magpie.admin_key"]) || k.admin)
				refused.push(`"${k.name}" is ${k.admin ? "a key that manages magpie" : "Reelix's own key"}: its limits are changed in magpie by the owner, never through Reelix`);
			for (const l of ch.limits) if (!/^(day|week|month|total|\d+[dh])$/.test(l.period)) invalid.push(`unknown limit period "${l.period}" (day, week, month, total, <N>d, <N>h)`);
			approve.push("a gateway key's limit");
			break;
		}
	}
	if (("routing" in ch && ch.routing && !ROUTINGS.includes(ch.routing)) || ("stays" in ch && ch.stays && !STAYS.includes(ch.stays))) invalid.push(`routing is one of ${ROUTINGS.join(", ")}; stays one of ${STAYS.join(", ")}`);

	// --- impact
	const aff = affectedRefs(st, ch);
	const after = simulate(st, ch);
	const roles = MODEL_ROLES.map((role) => {
		const specs = roleModels(app.config, role);
		const affected = specs.filter((s) => touches(aff, s));
		const works = (s: MagpieState) => specs.some((x) => !x.startsWith("magpie/") || usable(s, x.slice(7)));
		const empty_after = specs.length > 0 && works(st) && !works(after);
		return { role, affected, empty_after };
	}).filter((r) => r.affected.length || r.empty_after);
	const running = inUse.filter((u) => touches(aff, u.spec));
	const self = running.filter((u) => u.actor === actor);

	if (self.length) (owner ? approve : refused).push(`this changes ${self[0]!.spec}, the model you are running on right now: ask the owner to do it from Settings or the terminal`);
	for (const r of roles.filter((x) => x.empty_after)) (owner ? approve : refused).push(`role "${r.role}" would have no usable model left`);
	if (roles.length) approve.push(`used by role${roles.length > 1 ? "s" : ""} ${roles.map((r) => r.role).join(", ")}`);
	if (running.length) approve.push(`in use right now by ${running.map((u) => u.label).join(", ")}`);

	const reasons = [...invalid, ...refused, ...approve];
	const level: Level = invalid.length || refused.length ? "refused" : approve.length ? "approve" : "safe";
	const before = snapshot(st, ch);
	return { change: ch, actor, level, reasons, summary: describeChange(ch, st), roles, running, before, fingerprint: JSON.stringify(before) };
}

const PLAN_TTL_MS = 30 * 60_000;

function savePlan(app: Reelix, p: MagpiePlan): void {
	kvSet(app.db, `magpie.plan:${p.id}`, JSON.stringify(p));
}

export function getPlan(app: Reelix, id: string): MagpiePlan | undefined {
	return json<MagpiePlan | undefined>(kvGet(app.db, `magpie.plan:${id}`), undefined);
}

export async function planMagpieChange(app: Reelix, ch: MagpieChange, actor: string): Promise<MagpiePlan> {
	connect(app, true);
	const st = await readMagpie(app);
	if ((ch.action === "group.update" || ch.action === "group.remove") && findGroup(st, ch.id)) ch = { ...ch, id: findGroup(st, ch.id)!.id };
	const a = assessChange(app, st, ch, actor, app.modelsInUse?.() ?? []);
	const now = Date.now();
	const plan: MagpiePlan = { id: newId("mp_"), created_at: new Date(now).toISOString(), expires_at: new Date(now + PLAN_TTL_MS).toISOString(), ...a };
	savePlan(app, plan);
	return plan;
}

const applyInput = (id: string) => ({ plan: id });

/** Does applying this plan, as this actor, need the owner's yes first? */
export function planNeedsApproval(app: Reelix, id: string, actor: string): MagpiePlan | undefined {
	const p = getPlan(app, id);
	if (!p || isOwner(actor) || p.level !== "approve" || hasApproval(app, "magpie.apply", applyInput(id), actor)) return undefined;
	return p;
}

/** The change that puts things back, from the plan and what was there before. */
function inverseOf(plan: MagpiePlan, result: { created?: string; provider?: string }): MagpieChange | null {
	const ch = plan.change;
	const before = plan.before as any;
	switch (ch.action) {
		case "group.create":
			return { action: "group.remove", id: result.created ?? slug(ch.name) };
		case "group.restore":
			return { action: "group.remove", id: String(ch.group.id) };
		case "group.update":
			return before
				? { action: "group.update", id: ch.id, ...(ch.members ? { members: before.members } : {}), ...(ch.routing ? { routing: before.routing || "smart" } : {}), ...(ch.stays ? { stays: before.affinity || "auto" } : {}), ...(ch.name ? { name: before.name } : {}) }
				: null;
		case "group.remove":
			return before ? { action: "group.restore", group: before } : null;
		case "provider.on":
		case "provider.off":
			return before ? { action: before.off ? "provider.off" : "provider.on", id: ch.id } : null;
		case "provider.add":
			return result.provider ? { action: "provider.remove", id: result.provider } : null;
		case "provider.remove":
			return null;
		case "key.limit":
			return before ? { action: "key.limit", key: before.id, limits: before.limits.map((l: any) => ({ period: l.days ? `${l.days}d` : l.hours ? `${l.hours}h` : l.period, cost: l.cost || undefined, tokens: l.tokens || undefined })) } : null;
	}
}

async function execute(app: Reelix, c: Conn, st: MagpieState, ch: MagpieChange): Promise<{ created?: string; provider?: string }> {
	switch (ch.action) {
		case "group.create": {
			const r = await admin(c, "POST", "routing-groups/create", { name: ch.name, members: ch.members, ...(ch.routing ? { routing: ch.routing } : {}), ...(ch.stays ? { affinity: ch.stays } : {}) });
			const made = (r?.groups ?? []).find((g: any) => g.name === ch.name);
			return { created: made?.id ?? slug(ch.name) };
		}
		case "group.restore":
			await admin(c, "POST", "routing-groups/create", ch.group);
			return { created: String(ch.group.id) };
		case "group.update":
			await admin(c, "POST", "routing-groups/update", { id: ch.id, ...(ch.name ? { name: ch.name } : {}), ...(ch.members ? { members: ch.members } : {}), ...(ch.routing ? { routing: ch.routing } : {}), ...(ch.stays ? { affinity: ch.stays } : {}) });
			return {};
		case "group.remove":
			await admin(c, "POST", "routing-groups/delete", { id: ch.id });
			return {};
		case "provider.on":
		case "provider.off":
			await admin(c, "POST", `provider/${ch.action === "provider.on" ? "on" : "off"}`, { id: ch.id });
			return {};
		case "provider.remove":
			await admin(c, "POST", "provider/delete", { id: ch.id });
			return {};
		case "provider.add": {
			const key = app.secrets["magpie.new_provider_key"];
			if (!key) throw new ReelixError("no_key", "The provider key is no longer waiting; ask the owner for it again.");
			const beforeIds = new Set(st.providers.map((p) => p.id));
			const r = await admin(c, "POST", "provider/save", { preset: ch.preset, key });
			app.setSecret("magpie.new_provider_key", undefined);
			const added = (r?.providers ?? []).map((p: any) => String(p.id)).find((id: string) => !beforeIds.has(id));
			return { provider: added };
		}
		case "key.limit": {
			const k = st.keys.find((x) => x.id === ch.key || x.name === ch.key)!;
			const toLimit = (l: LimitSpec) => {
				const m = /^(\d+)([dh])$/.exec(l.period);
				return { period: m ? (m[2] === "d" ? "days" : "hours") : l.period, ...(m ? (m[2] === "d" ? { days: Number(m[1]) } : { hours: Number(m[1]) }) : {}), ...(l.cost !== undefined ? { cost: l.cost } : {}), ...(l.tokens !== undefined ? { tokens: l.tokens } : {}) };
			};
			if (!ch.limits.length) {
				await admin(c, "POST", "gateway-keys/limit-key", { key: k.id });
				return {};
			}
			await admin(c, "POST", "gateway-keys/limit-key", { key: k.id, limit: toLimit(ch.limits[0]!) });
			for (let i = 1; i < ch.limits.length; i++) await admin(c, "POST", "gateway-keys/limit-key", { key: k.id, limit: toLimit(ch.limits[i]!), index: i });
			return {};
		}
	}
}

export type MagpieProbe = (ref: string) => Promise<string | undefined>; // undefined = it answered

/** One tiny request through the gateway with Reelix's own key. */
function probeWith(c: Conn): MagpieProbe {
	return async (ref) => {
		try {
			const r = await c.http("POST", "/v1/chat/completions", { key: c.useKey, timeoutMs: 90_000, body: { model: ref, messages: [{ role: "user", content: "Reply with the word OK." }], max_tokens: 64, stream: false } });
			return r.status === 200 ? undefined : `${r.status} ${errorText(r.body)}`;
		} catch (e) {
			return errorMessage(e);
		}
	};
}

export type ApplyResult = {
	plan: string;
	summary: string;
	applied: boolean;
	before: unknown;
	inverse: MagpieChange | null;
	/** worked_before: it was usable before the change, so a failure now is the change's fault. */
	checks: { ref: string; ok: boolean; error?: string; used_by_role: boolean; worked_before: boolean }[];
	rolled_back?: { ok: boolean; error?: string };
	created?: string;
};

export async function applyMagpiePlan(app: Reelix, id: string, actor: string, probe?: MagpieProbe): Promise<ApplyResult> {
	const plan = getPlan(app, id);
	if (!plan) throw new ReelixError("not_found", `No magpie plan ${id}. Make one with magpie_plan.`);
	if (Date.parse(plan.expires_at) < Date.now()) throw new ReelixError("expired", "That plan is more than 30 minutes old: plan again.");
	if (plan.level === "refused") throw new ReelixError("refused", `This change is refused: ${plan.reasons.join("; ")}`);
	const needsRecord = plan.level === "approve" && !isOwner(actor);
	const unapproved = () => new ReelixError("needs_approval", `This change needs the owner's approval first: ${plan.reasons.join("; ")}`);
	if (needsRecord && !hasApproval(app, "magpie.apply", applyInput(id), actor)) throw unapproved();

	const c = connect(app, true);
	const st = await readMagpie(app);
	const now = assessChange(app, st, plan.change, actor, app.modelsInUse?.() ?? []);
	if (now.fingerprint !== plan.fingerprint) throw new ReelixError("changed", "magpie changed since this plan was made: plan again.");
	if (RANK[now.level] > RANK[plan.level]) throw new ReelixError("changed", `Things changed since the plan and it is now ${now.level}: ${now.reasons.join("; ")}`);

	if (needsRecord && !consumeApproval(app, "magpie.apply", applyInput(id), actor)) throw unapproved();
	const result = await execute(app, c, st, plan.change);
	kvSet(app.db, `magpie.plan:${id}`, JSON.stringify({ ...plan, expires_at: nowIso() })); // one use
	const inverse = inverseOf(plan, result);
	app.emit({ type: "magpie.changed" });

	// --- check what roles use, and a new group
	const roleRefs = new Set(now.roles.flatMap((r) => r.affected).map((s) => s.slice("magpie/".length)));
	const toCheck = new Map<string, boolean>();
	for (const r of roleRefs) toCheck.set(r, true);
	if (result.created && !toCheck.has(`group/${result.created}`)) toCheck.set(`group/${result.created}`, false);
	const after = await readMagpie(app).catch(() => st);
	const predicted = simulate(st, plan.change);
	const ask = probe ?? probeWith(c);
	const checks: ApplyResult["checks"] = [];
	for (const [ref, used] of toCheck) {
		// The plan said this would stop working and the owner accepted that (a removal, a provider off).
		if (!usable(predicted, ref) && !(result.created && ref === `group/${result.created}`)) continue;
		const error = await ask(ref);
		checks.push({ ref, ok: !error, error: error ? app.redact(error) : undefined, used_by_role: used, worked_before: usable(st, ref) });
	}
	const out: ApplyResult = { plan: id, summary: plan.summary, applied: true, before: plan.before, inverse, checks, created: result.created };
	// Put back only what this change broke: a role's model that was usable before and fails now.
	// (Switching a provider on whose key is bad fails its check too, but broke nothing.)
	if (checks.some((x) => !x.ok && x.used_by_role && x.worked_before) && inverse) {
		try {
			await execute(app, c, after, inverse);
			out.rolled_back = { ok: true };
		} catch (e) {
			out.rolled_back = { ok: false, error: app.redact(errorMessage(e)) };
		}
		out.applied = false;
		app.emit({ type: "magpie.changed" });
	}
	return out;
}

/** A plan that reverses an earlier apply, from the ledger. */
export async function planUndo(app: Reelix, actionId: number, actor: string): Promise<MagpiePlan> {
	const row = app.db.prepare("SELECT op, status, output_json FROM actions WHERE id = ?").get(actionId) as { op: string; status: string; output_json: string } | undefined;
	if (!row || row.op !== "magpie.apply") throw new ReelixError("not_found", `Action ${actionId} is not a magpie change.`);
	const out = json<ApplyResult | null>(row.output_json, null);
	if (!out?.applied) throw new ReelixError("nothing_to_undo", "That change was not applied (or was already rolled back).");
	if (!out.inverse) throw new ReelixError("cannot_undo", "That change cannot be undone (a removed provider's keys are gone).");
	return planMagpieChange(app, out.inverse, actor);
}

// ---------------------------------------------------------------------------------- text

function money(x: unknown): string {
	return typeof x === "number" ? `$${x.toFixed(2)}` : "?";
}

export function statusText(st: MagpieState): string {
	const lines = [`magpie at ${st.url}: ${st.models.length} models${st.admin ? ", admin key works" : st.has_admin_key ? ", admin key REFUSED" : ", no admin key (read only)"}`];
	if (st.limit) {
		const ls = (st.limit.limits ?? (st.limit.limit ? [st.limit.limit] : [])) as any[];
		lines.push(
			`Reelix's key "${st.limit.key}": ${ls.length ? ls.map((l) => `${l.period}: ${l.costLimit ? `${money(l.cost)} of ${money(l.costLimit)}` : ""}${l.tokenLimit ? ` ${l.tokens} of ${l.tokenLimit} tokens` : ""}${l.spent ? " SPENT" : ""}, renews ${String(l.reset ?? "").slice(0, 16)}`).join("; ") : "no limit"}`,
		);
	}
	if (st.roles.length) lines.push(`Roles on magpie: ${st.roles.map((r) => `${r.role}=${r.specs.join(" > ")}`).join("; ")}`);
	if (st.groups.length) lines.push("Routing groups:", ...st.groups.map((g) => `- ${g.ref}${g.ref !== `group/${g.id}` ? ` (id ${g.id}, made by magpie)` : ""} "${g.name}": ${g.members.join(", ")} (routing ${g.routing ?? "smart"}${g.affinity ? `, stays ${g.affinity}` : ""})${usable(st, g.ref) ? "" : " NOT USABLE"}`));
	if (st.providers.length) lines.push("Providers:", ...st.providers.map((p) => `- ${p.id} "${p.name}": ${p.off ? "OFF" : "on"}, ${p.keys} key(s), ${p.models.length} models`));
	if (st.keys.length) lines.push("Gateway keys:", ...st.keys.map((k) => `- ${k.id} "${k.name}"${k.own ? " (Reelix's own: change it in magpie)" : ""}${k.admin ? ` (manages magpie: ${k.admin})` : ""}${k.limits.length ? `: limits ${k.limits.map((l: any) => `${l.period}${l.cost ? ` $${l.cost}` : ""}${l.tokens ? ` ${l.tokens}t` : ""}`).join(", ")}` : ""}`));
	if (st.quotas?.length) lines.push("Quotas:", ...(st.quotas as any[]).slice(0, 20).map((q) => `- ${q.provider}: ${q.error ? q.error : (q.windows ?? []).map((w: any) => `${w.name ?? w.window}: ${w.left ?? w.remaining ?? "?"} left`).join(", ")}`));
	if (st.errors.length) lines.push(...st.errors.map((e) => `! ${e}`));
	return lines.join("\n");
}

export function planText(p: MagpiePlan): string {
	return [
		`Plan ${p.id}: ${p.summary}`,
		`Level: ${p.level === "safe" ? "safe (you may apply it)" : p.level === "approve" ? "needs the owner's approval (magpie_apply asks them)" : "REFUSED"}`,
		...p.reasons.map((r) => `- ${r}`),
		...p.roles.map((r) => `Role ${r.role}: affected ${r.affected.join(", ") || "-"}${r.empty_after ? " → NO MODEL LEFT" : ""}`),
		...(p.running.length ? [`Running on it now: ${p.running.map((u) => `${u.label} (${u.spec})`).join(", ")}`] : []),
		`Expires ${p.expires_at.slice(11, 16)} UTC.`,
	].join("\n");
}

export function applyText(r: ApplyResult): string {
	return [
		r.rolled_back ? `NOT kept: ${r.summary}. A check failed, so it was ${r.rolled_back.ok ? "put back as it was" : `NOT put back (${r.rolled_back.error}); fix it in magpie`}.` : `Done: ${r.summary}.`,
		...r.checks.map((c) => `- check ${c.ref}: ${c.ok ? "answers" : `FAILED (${c.error})${!r.rolled_back && !c.worked_before ? "; it was not usable before this change either, so the change was kept" : ""}`}`),
		r.inverse && !r.rolled_back ? "It can be undone with magpie_undo and this action's id." : "",
	]
		.filter(Boolean)
		.join("\n");
}

// ---------------------------------------------------------------------------------- operations

const ChangeInput = Type.Object({
	action: Type.Union(
		["group.create", "group.update", "group.remove", "provider.on", "provider.off", "provider.add", "provider.remove", "key.limit"].map((a) => Type.Literal(a)),
		{ description: "what to change" },
	),
	id: Type.Optional(Type.String({ description: "group id (without group/), provider id, or for key.limit the gateway key id or name" })),
	name: Type.Optional(Type.String({ description: "group.create: the new group's name; group.update: a new name" })),
	members: Type.Optional(Type.Array(Type.String(), { description: "group members in order, as magpie names models: provider/model or group/<id>" })),
	routing: Type.Optional(Type.String({ description: ROUTINGS.join(" | ") })),
	stays: Type.Optional(Type.String({ description: `how long a conversation stays on one account: ${STAYS.join(" | ")}` })),
	preset: Type.Optional(Type.String({ description: "provider.add: magpie's preset id, e.g. deepseek, qwen-token-plan" })),
	limits: Type.Optional(Type.Array(Type.Object({ period: Type.String({ description: "day | week | month | total | <N>d | <N>h" }), cost: Type.Optional(Type.Number({ description: "USD" })), tokens: Type.Optional(Type.Number()) }), { description: "key.limit: every limit the key should have; [] = none" })),
});

function toChange(i: any): MagpieChange {
	const need = (k: string) => {
		if (i[k] === undefined || i[k] === "") throw new ReelixError("invalid_input", `${i.action} needs ${k}`);
		return i[k];
	};
	switch (i.action) {
		case "group.create":
			return { action: "group.create", name: need("name"), members: need("members"), routing: i.routing, stays: i.stays };
		case "group.update":
			return { action: "group.update", id: String(need("id")).replace(/^group\//, ""), name: i.name, members: i.members, routing: i.routing, stays: i.stays };
		case "group.remove":
			return { action: "group.remove", id: String(need("id")).replace(/^group\//, "") };
		case "provider.add":
			return { action: "provider.add", preset: need("preset") };
		case "key.limit":
			return { action: "key.limit", key: need("id"), limits: i.limits ?? [] };
		default:
			return { action: i.action, id: need("id") };
	}
}

defineOperation({
	name: "magpie.status",
	tool: "magpie_status",
	summary: "The magpie gateway: its models, routing groups, providers, gateway keys, Reelix's own limit and what is left, quotas, and which roles use it",
	effect: "read",
	input: Type.Object({ quotas: Type.Optional(Type.Boolean({ description: "also read every plan's quota (slower)" })) }),
	async run(ctx, i) {
		return readMagpie(ctx.app, { quotas: i.quotas });
	},
	toText: (o: MagpieState) => statusText(o),
});

defineOperation({
	name: "magpie.plan",
	tool: "magpie_plan",
	summary: "Plan a change to magpie (routing groups, providers, other gateway keys' limits) and see what it would affect. Nothing changes until magpie_apply",
	description:
		"The plan says what uses the target (roles, conversations and jobs running now), whether every role keeps a usable model, and its level: safe, needs approval, or refused. You may never change the model you are running on, leave a role with no model, or touch Reelix's own keys.",
	effect: "read",
	input: ChangeInput,
	async run(ctx, i) {
		return planMagpieChange(ctx.app, toChange(i), ctx.actor);
	},
	toText: (p: MagpiePlan) => planText(p),
});

defineOperation({
	name: "magpie.apply",
	tool: "magpie_apply",
	summary: "Carry out a magpie plan. It is checked afterwards and put back automatically if a role's model stops answering",
	description: "A plan that needs approval asks the owner first (in chat a yes/no question; in a background job an Inbox item, and the job parks).",
	effect: "write",
	input: Type.Object({ plan: Type.String({ description: "the plan id from magpie_plan" }) }),
	async run(ctx, i) {
		return applyMagpiePlan(ctx.app, i.plan, ctx.actor);
	},
	toText: (r: ApplyResult) => applyText(r),
});

defineOperation({
	name: "magpie.undo",
	tool: "magpie_undo",
	summary: "Plan the reversal of an earlier magpie change (by its action id in the ledger); apply it with magpie_apply",
	effect: "read",
	input: Type.Object({ action_id: Type.Number() }),
	positional: ["action_id"],
	async run(ctx, i) {
		return planUndo(ctx.app, i.action_id, ctx.actor);
	},
	toText: (p: MagpiePlan) => planText(p),
});

