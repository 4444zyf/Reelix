import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Reelix, addInbox, emptyExpiredTrash, errorMessage, freeSpace, humanBytes, nowIso } from "@reelix/core";
import type { JobRunner } from "./jobs.ts";

/** Back up the database and config to /data/backups, keeping 14 days. */
export function backup(app: Reelix): string {
	const day = nowIso().slice(0, 10);
	const dir = app.paths.backups;
	const dbOut = join(dir, `reelix-${day}.db`);
	if (existsSync(dbOut)) rmSync(dbOut);
	app.db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
	if (existsSync(app.paths.config)) copyFileSync(app.paths.config, join(dir, `config-${day}.yaml`));
	for (const n of readdirSync(dir)) {
		const m = /(\d{4}-\d{2}-\d{2})/.exec(n);
		if (m && Date.parse(m[1]!) < Date.now() - 14 * 86400_000) rmSync(join(dir, n));
	}
	return dbOut;
}

/**
 * The nightly tidy-up and morning summary (§5.9): code first; the agent only if code found
 * something; one summary to the Inbox (and Telegram if anything needs the owner).
 */
export function registerNightly(app: Reelix, jobs: JobRunner): void {
	jobs.schedule("nightly", "nightly", `daily ${app.config.schedule.nightly_at}`);
	jobs.register("nightly", async (ctx) => {
		const lines: string[] = [];
		const problems: string[] = [];
		try {
			backup(app);
			lines.push("Backed up the database and settings.");
		} catch (e) {
			problems.push(`Backup failed: ${errorMessage(e)}`);
		}
		const trash = emptyExpiredTrash(app);
		if (trash.deleted) lines.push(`Emptied ${trash.deleted} expired trash items (${humanBytes(trash.bytes)}).`);

		const since = new Date(Date.now() - 86400_000).toISOString();
		const filed = app.db.prepare("SELECT name FROM downloads WHERE filed_at > ?").all(since) as { name: string }[];
		const added = app.db.prepare("SELECT name FROM downloads WHERE added_at > ?").all(since) as { name: string }[];
		const waiting = app.db.prepare("SELECT hash, name, state, note FROM downloads WHERE state IN ('stalled','needs_agent','gone')").all() as any[];
		const unfiled = app.db.prepare("SELECT hash, name FROM downloads WHERE state = 'complete' AND completed_at < ?").all(new Date(Date.now() - 6 * 3600_000).toISOString()) as any[];
		for (const w of waiting) problems.push(`${w.name}: ${w.state}${w.note ? ` (${w.note})` : ""}`);
		for (const u of unfiled) problems.push(`${u.name}: complete for over 6 hours but not filed`);
		const free = freeSpace(app);
		if (free !== undefined && free < 50 * 1024 ** 3) problems.push(`Only ${humanBytes(free)} free in the download folder.`);
		try {
			if (app.config.jackett?.url) {
				const ix = await app.jackett().indexers();
				const { outcomes } = await app.jackett().searchEach(ix, ["test"], [], 20_000);
				for (const o of outcomes.filter((x) => !x.ok)) problems.push(`Indexer ${o.name} is failing: ${o.error}`);
			}
		} catch (e) {
			problems.push(`Jackett check failed: ${errorMessage(e)}`);
		}
		const openQuestions = (app.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status = 'open' AND kind != 'notice' AND kind != 'summary'").get() as { n: number }).n;

		let agentText = "";
		if (problems.length) {
			try {
				const r = await ctx.agent(
					`Nightly tidy-up. Code found these problems:\n- ${problems.join("\n- ")}\n\nLook into each with your tools. Fix what is safe and routine (re-file, re-check, retry). For anything destructive or a real decision, prepare a question with notify (options as buttons, wait=false) — do not wait. End with a short plain summary of what you did and what is waiting for the owner.`,
					"Nightly tidy-up",
				);
				agentText = r.text;
			} catch (e) {
				agentText = `(The agent did not look into these: ${errorMessage(e)})`;
			}
		}
		const body = [
			added.length ? `Added: ${added.map((a) => a.name).join("; ")}` : "",
			filed.length ? `Filed: ${filed.map((f) => f.name).join("; ")}` : "",
			...lines,
			problems.length ? `Problems found:\n- ${problems.join("\n- ")}` : "No problems found.",
			agentText ? `\n${agentText}` : "",
			openQuestions ? `${openQuestions} item(s) are waiting for you in the Inbox.` : "",
		]
			.filter(Boolean)
			.join("\n");
		addInbox(app, { kind: "summary", title: `Morning summary ${nowIso().slice(0, 10)}`, body, payload: { urgent: problems.length > 0 || openQuestions > 0 }, dedupeKey: `summary:${nowIso().slice(0, 10)}` });
		return { state: "succeeded", summary: body.slice(0, 2000) };
	});
}
