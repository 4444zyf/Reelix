import type { PluginCheck } from "@reelix/plugin-testing";

/** Answers recorded from a Jackett server, for `reelix plugin check` and this plugin's tests. */
export const KEY = "jk_0123456789";
const J = "http://jackett.test:9117";

export default {
	settings: { servers: [{ url: J }] },
	secrets: { "servers.0.api_key": KEY },
	http: [
		{ url: /torznab\/api\?t=indexers/, body: `<indexers><indexer id="alpha" configured="true"><title>Alpha &amp; Co</title><type>private</type></indexer><indexer id="beta" configured="true"><title>Beta</title></indexer></indexers>` },
		{ url: /indexers\/alpha\/results\?/, body: JSON.stringify({ Results: [{ Title: "Sintel.2010.1080p", Link: `${J}/dl/alpha/?jackett_apikey=${KEY}&file=a`, Size: 100, Seeders: 9, InfoHash: "ABC", DownloadVolumeFactor: 0 }] }) },
		{ url: /indexers\/beta\/results\?/, body: JSON.stringify({ Results: [], Indexers: [{ Error: "Cloudflare" }] }) },
		{ url: /\/dl\/alpha\//, body: new TextEncoder().encode("d4:infod4:name1:xee") },
	],
	seams: {
		"reelix:indexer@1": { provider: "jackett", query: { queries: ["Sintel"], kind: "movie" }, expectHits: 1 },
	},
} satisfies PluginCheck;
