import type { PluginContext } from "@reelix/plugin";

export type JellyfinUser = { Id: string; Name: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; IsHidden?: boolean } };
export type JellyfinItem = {
	Id: string;
	Name: string;
	Type: string;
	ProductionYear?: number;
	ProviderIds?: Record<string, string>;
	SeriesId?: string;
	SeriesName?: string;
	ParentIndexNumber?: number;
	IndexNumber?: number;
	UserData?: { PlayCount?: number; IsFavorite?: boolean; Played?: boolean; LastPlayedDate?: string };
};

/** An answer of Jellyfin that is expected now and then: a refused key, or a refusal. */
export class JellyfinError extends Error {
	kind: "auth" | "refused";
	constructor(kind: JellyfinError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

type Fetch = PluginContext["http"]["fetch"];
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Jellyfin's API through Reelix's fetch: path updates and scans (§5.6), users and what they watched (docs/trends.md §2.1). */
export class JellyfinClient {
	readonly url: string;
	private fetch: Fetch;
	private apiKey: string;
	constructor(fetch: Fetch, opts: { url: string; apiKey: string }) {
		this.fetch = fetch;
		this.url = opts.url.replace(/\/+$/, "");
		this.apiKey = opts.apiKey;
	}

	private headers(): Record<string, string> {
		// The current sign-in header, not the deprecated X-Emby-Token / api_key forms.
		return {
			authorization: `MediaBrowser Client="Reelix", Device="Reelix", DeviceId="reelix", Version="0.1", Token="${this.apiKey}"`,
			"content-type": "application/json",
		};
	}

	/** `missing`: 400 and 404 are an answer ("this server has no such thing"), not an error. */
	private async request<T>(path: string, what: string, o: { method?: string; body?: unknown; signal?: AbortSignal; missing?: boolean } = {}): Promise<T | undefined> {
		const res = await this.fetch(`${this.url}${path}`, { method: o.method, headers: this.headers(), body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal, timeoutMs: 15_000 });
		if (o.missing && (res.status === 404 || res.status === 400)) return undefined;
		if (res.status === 401 || res.status === 403) throw new JellyfinError("auth", `Jellyfin refused the API key (${what}: HTTP ${res.status}).`);
		if (!res.ok) throw new JellyfinError("refused", `${what}: HTTP ${res.status} ${text(res.bytes).slice(0, 200)}`);
		return res.bytes.length ? (JSON.parse(text(res.bytes)) as T) : undefined;
	}

	async info(signal?: AbortSignal): Promise<{ Id: string; ServerName: string; Version: string }> {
		return (await this.request<{ Id: string; ServerName: string; Version: string }>("/System/Info", "Jellyfin system info", { signal }))!;
	}

	/** Tell Jellyfin specific paths changed (Jellyfin's own view of the path). */
	async pathsUpdated(paths: { path: string; updateType: "Created" | "Deleted" }[], signal?: AbortSignal): Promise<void> {
		await this.request("/Library/Media/Updated", "Jellyfin path update", { method: "POST", body: { Updates: paths.map((p) => ({ Path: p.path, UpdateType: p.updateType })) }, signal });
	}

	async refreshAll(signal?: AbortSignal): Promise<void> {
		await this.request("/Library/Refresh", "Jellyfin library scan", { method: "POST", signal });
	}

	async users(signal?: AbortSignal): Promise<JellyfinUser[]> {
		return (await this.request<JellyfinUser[]>("/Users", "Jellyfin users", { signal, missing: true })) ?? [];
	}

	/** One user's items. Jellyfin 10.9+ answers /Items?userId=; older servers only /Users/{id}/Items. */
	async userItems(userId: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<JellyfinItem[]> {
		const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
		const modern = await this.request<{ Items: JellyfinItem[] }>(`/Items?userId=${encodeURIComponent(userId)}&${qs}`, "Jellyfin items", { signal, missing: true });
		if (modern) return modern.Items ?? [];
		const legacy = await this.request<{ Items: JellyfinItem[] }>(`/Users/${encodeURIComponent(userId)}/Items?${qs}`, "Jellyfin items", { signal, missing: true });
		return legacy?.Items ?? [];
	}

	/** The next episode to watch of each show this user has started. */
	async nextUp(userId: string, signal?: AbortSignal): Promise<JellyfinItem[]> {
		return (await this.request<{ Items: JellyfinItem[] }>(`/Shows/NextUp?userId=${encodeURIComponent(userId)}&limit=500&enableResumable=true&enableRewatching=false`, "Jellyfin next up", { signal, missing: true }))?.Items ?? [];
	}

	async seriesEpisodes(seriesId: string, userId: string, signal?: AbortSignal): Promise<JellyfinItem[]> {
		return (await this.request<{ Items: JellyfinItem[] }>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?userId=${encodeURIComponent(userId)}`, "Jellyfin episodes", { signal, missing: true }))?.Items ?? [];
	}

	async virtualFolders(signal?: AbortSignal): Promise<{ Name: string; ItemId?: string; Locations: string[]; CollectionType?: string }[]> {
		return (await this.request<{ Name: string; ItemId?: string; Locations: string[] }[]>("/Library/VirtualFolders", "Jellyfin libraries", { signal })) ?? [];
	}
}
