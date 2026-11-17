import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Reelix } from "@reelix/core";
export { existingSubtitles, getDownload, getTitle, json, videosOf, type Reelix } from "@reelix/core";
export function readNoteSafe(app: Reelix): string {
	const p = join(app.paths.notes, "preferences.md");
	return existsSync(p) ? readFileSync(p, "utf8") : "";
}
