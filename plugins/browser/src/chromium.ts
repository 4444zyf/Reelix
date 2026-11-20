import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Find a Chromium: the one set in the plugin's settings, the system's, or a Playwright download. */
export function findChromium(configured?: string): string | undefined {
	if (configured && existsSync(configured)) return configured;
	for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) if (existsSync(p)) return p;
	const pw = join(homedir(), ".cache/ms-playwright");
	if (existsSync(pw)) {
		for (const d of readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
			for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(pw, d, sub))) return join(pw, d, sub);
		}
	}
	return undefined;
}
