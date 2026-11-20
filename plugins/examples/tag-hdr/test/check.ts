import type { PluginCheck } from "@reelix/plugin-testing";

/** `reelix plugin check` starts release-tags with it, and calls its tagger with these releases. */
export default {
	plugins: ["../release-tags"],
	pluginSeams: {
		"release-tags:tagger@1": {
			provider: "hdr",
			calls: [
				{ method: "tag", args: [[{ ref: "r1", name: "Sintel.2010.2160p.UHD.BluRay.DV.HDR10.HEVC-GRP" }, { ref: "r2", name: "Sintel.2010.1080p.BluRay.x264-GRP" }]] },
				{ method: "tag", args: [[]] },
			],
		},
	},
} satisfies PluginCheck;
