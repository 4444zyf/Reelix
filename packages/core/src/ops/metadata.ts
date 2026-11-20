import { Type } from "typebox";
import { TMDB_LOCALES } from "../config.ts";
import { defineOperation } from "../registry.ts";
import { refreshAllTitles } from "../titles.ts";

defineOperation({
	name: "title.refresh_metadata",
	summary: "Re-read every title from TMDB in the owner's language (runs by itself when the language changes)",
	effect: "write",
	input: Type.Object({}),
	async run(ctx) {
		return { language: TMDB_LOCALES[ctx.app.config.language ?? "en"], ...(await refreshAllTitles(ctx.app)) };
	},
	toText: (o: any) => `${o.refreshed} titles re-read in ${o.language}.${o.failed.length ? ` Failed: ${o.failed.map((f: any) => `${f.id} (${f.error})`).join("; ")}` : ""}`,
});
