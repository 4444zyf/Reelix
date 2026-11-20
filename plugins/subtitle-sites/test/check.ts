import type { SubtitleQuery } from "@reelix/plugin";
import type { PluginCheck } from "@reelix/plugin-testing";

/** Answers recorded from SubHD, for `reelix plugin check` and this plugin's tests. */
export const SUBHD = "https://subhd.test";
export const QUERY: SubtitleQuery = { names: ["示例"], ids: {}, kind: "movie", series: false, languages: ["zh"] };
const PAGE = `<div class="bg-white shadow-sm rounded-3 mb-4"><a href='/d/77'></a><a href='/a/sid1'></a><div class="float-start f16 fw-bold">示例</div></div>`;
/** Search, then the two steps before a download. */
export const DOWN_FLOW = [
	{ url: `${SUBHD}/search/${encodeURIComponent("示例")}`, body: PAGE },
	{ url: `${SUBHD}/api/sub/prepare-download`, method: "POST", cookies: ["sess=1; Path=/"], body: JSON.stringify({ success: true, url: "/down/x" }) },
	{ url: `${SUBHD}/down/x`, body: "<html></html>" },
];

export default {
	settings: { subhd_url: SUBHD },
	http: [...DOWN_FLOW, { url: `${SUBHD}/api/sub/down`, method: "POST", body: JSON.stringify({ pass: true, url: `${SUBHD}/f/a.zip` }) }, { url: `${SUBHD}/f/a.zip`, body: "zip-bytes" }],
	seams: {
		"reelix:subtitle.source@1": { provider: "subhd", query: QUERY, expectHits: 1 },
	},
} satisfies PluginCheck;
