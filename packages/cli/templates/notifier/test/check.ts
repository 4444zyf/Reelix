import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * Answers recorded from the service, for `reelix plugin check` and this plugin's tests.
 * Record them from the real service: the conformance suite checks the provider against them.
 */
export const ADDRESS = "https://hooks.example.org/reelix";

export default {
	settings: { url: ADDRESS },
	http: [{ method: "POST", url: ADDRESS, status: 204 }],
	seams: {
		"reelix:notifier@1": { provider: "example-notifier" },
	},
} satisfies PluginCheck;
