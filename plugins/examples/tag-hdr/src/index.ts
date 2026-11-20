import { definePlugin } from "@reelix/plugin";
import type { Tagger } from "reelix-plugin-release-tags/contract";

/** What a release name says about its dynamic range, most specific first. */
const PATTERNS: [string, RegExp][] = [
	["Dolby Vision", /(^|[^a-z0-9])(dv|dovi|dolby[ .-]?vision)([^a-z0-9]|$)/i],
	["HDR10+", /(^|[^a-z0-9])hdr10(\+|plus)/i],
	["HDR10", /(^|[^a-z0-9])hdr10([^a-z0-9+]|$)/i],
	["HDR", /(^|[^a-z0-9])hdr([^a-z0-9]|$)/i],
	["HLG", /(^|[^a-z0-9])hlg([^a-z0-9]|$)/i],
];

/** A recipe for providing a seam another plugin owns: its contract is a type from that plugin's package. */
export default definePlugin({
	async activate(ctx) {
		const tagger: Tagger = {
			id: "hdr",
			label: ctx.t("label"),
			async tag(releases) {
				return releases.flatMap((r) => {
					const tags = PATTERNS.filter(([, p]) => p.test(r.name)).map(([tag]) => tag);
					return tags.length ? [{ ref: r.ref, tags }] : [];
				});
			},
		};
		await ctx.provide("release-tags:tagger@1", tagger);
	},
});
