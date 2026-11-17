import { http, expectOk } from "../http.ts";

/** Jellyfin is optional; Reelix only tells it that paths changed (§5.6). */
export class JellyfinClient {
	url: string;
	apiKey: string;
	constructor(opts: { url: string; apiKey: string }) {
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

	async info(): Promise<{ ServerName: string; Version: string }> {
		const res = await expectOk(await http(`${this.url}/System/Info`, { headers: this.headers(), timeoutMs: 10_000 }), "Jellyfin system info");
		return res.json();
	}

	/** Tell Jellyfin specific paths changed (Jellyfin's own view of the path). */
	async pathsUpdated(paths: { path: string; updateType: "Created" | "Modified" | "Deleted" }[]): Promise<void> {
		await expectOk(
			await http(`${this.url}/Library/Media/Updated`, {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ Updates: paths.map((p) => ({ Path: p.path, UpdateType: p.updateType })) }),
				timeoutMs: 15_000,
			}),
			"Jellyfin path update",
		);
	}

	async refreshAll(): Promise<void> {
		await expectOk(await http(`${this.url}/Library/Refresh`, { method: "POST", headers: this.headers(), timeoutMs: 15_000 }), "Jellyfin library scan");
	}

	async virtualFolders(): Promise<{ Name: string; Locations: string[]; CollectionType?: string }[]> {
		const res = await expectOk(await http(`${this.url}/Library/VirtualFolders`, { headers: this.headers(), timeoutMs: 10_000 }), "Jellyfin libraries");
		return res.json();
	}
}
