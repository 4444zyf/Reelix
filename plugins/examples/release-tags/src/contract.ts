/**
 * The contract of the seam `release-tags:tagger@1`, for the plugins that provide it (docs/plugin-guide.md,
 * "A seam of your own"). Import it as a type: `import type { Tagger } from "reelix-plugin-release-tags/contract"`.
 * The manifest of release-tags holds the same contract as data, which Reelix checks every answer against.
 */
import type { Call, PluginSeamProvider } from "@reelix/plugin";

/** One release of a search: Reelix's handle and its name. */
export type TagRequest = { ref: string; name: string };

/** The tags a tagger read from one release's name. Leave out releases it has nothing to say about. */
export type TagResult = { ref: string; tags: string[] };

export type Tagger = PluginSeamProvider & {
	/** Every release of one search at once; 5 seconds. */
	tag(releases: TagRequest[], call: Call): Promise<TagResult[]>;
};

/** The payload of the event `release-tags:tagged`. */
export type Tagged = { title?: { id: string; name: string }; releases: { ref: string; name: string; tags: string[] }[] };
