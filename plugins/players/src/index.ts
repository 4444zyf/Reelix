import { type PlayRequest, type PlayerLink, definePlugin } from "@reelix/plugin";

const SEAM = "reelix:player@1";

/*
 * One tap from Reelix into a player (docs/web-app.md, "Playing"). Links only: no key or video address goes
 * to the phone, and each app plays through its own sign-in.
 *   Infuse    infuse://movie/{tmdb}?play, infuse://series/{tmdb}-{season}-{episode}?play
 *   Swiftfin  swiftfin://{server}/{user}/item/{item}  (opens the item's page)
 *   Jellyfin  {public address}/web/#/details?id={item}&serverId={server}
 * Swiftfin and Jellyfin in the browser need the media server's ids, which Reelix passes in `server`.
 */

/** Infuse finds the title in its own library by TMDB id. */
function infuse(r: PlayRequest): PlayerLink | null {
	const tmdb = r.ids.tmdb;
	if (!tmdb) return null;
	if (!r.series) return { url: `infuse://movie/${tmdb}?play`, autoplay: true };
	if (r.season !== undefined && r.episode !== undefined) return { url: `infuse://series/${tmdb}-${r.season}-${r.episode}?play`, autoplay: true };
	return { url: `infuse://series/${tmdb}`, autoplay: false };
}

const swiftfin = ({ server: s }: PlayRequest): PlayerLink | null => (s ? { url: `swiftfin://${s.serverId}/${s.userId}/item/${encodeURIComponent(s.itemId)}`, autoplay: false } : null);

const jellyfinWeb = ({ server: s }: PlayRequest): PlayerLink | null => (s?.publicUrl ? { url: `${s.publicUrl}/web/#/details?id=${encodeURIComponent(s.itemId)}&serverId=${s.serverId}`, autoplay: false } : null);

export default definePlugin({
	async activate(ctx) {
		for (const [id, label, link, needsMediaServer] of [
			["infuse", "Infuse", infuse, false],
			["swiftfin", "Swiftfin", swiftfin, true],
			["jellyfin", "Jellyfin", jellyfinWeb, true],
		] as const)
			await ctx.provide(SEAM, { id, label, needsMediaServer, links: async (requests) => requests.map(link) });
	},
});
