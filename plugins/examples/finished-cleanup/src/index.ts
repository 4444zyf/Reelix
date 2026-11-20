import { type DownloadRecord, type PluginContext, SETTINGS, type SettingOption, Type, definePlugin } from "@reelix/plugin";
import type { Static } from "typebox";

/*
 * A recipe for a card, a proposal and a typed tool (docs/plugins.md §10.3, §12.3, §6.1). Nothing is
 * removed by this plugin: it proposes, Reelix shows the owner what each step would do, and only the
 * steps the owner approves run.
 */
const DAY_MS = 86_400_000;
const MAX_STEPS = 50;

const config = Type.Object(
	{
		seeded_days: Type.Number({ default: 14, minimum: 0, maximum: 365 }),
		delete_files: Type.Boolean({ default: false }),
		kind: Type.String({ default: "all", [SETTINGS.optionsFrom]: "kinds" }),
		schedule: Type.Union([Type.Literal("manual"), Type.Literal("daily")], { default: "manual" }),
		at_most: Type.Integer({ default: 20, minimum: 1, maximum: MAX_STEPS, [SETTINGS.showWhen]: { field: "schedule", equals: "daily" } }),
	},
	{ [SETTINGS.buttons]: ["scan"] },
);
type Settings = Static<typeof config>;

type Found = { hash: string; name: string; sizeBytes?: number; seededDays: number; detail: string };

function size(bytes: number | undefined): string {
	if (bytes === undefined) return "?";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function kindOf(ctx: PluginContext, d: DownloadRecord): Promise<"movie" | "tv" | undefined> {
	if (!d.titleId) return undefined;
	const t = await ctx.reelix.read.title(d.titleId);
	return t ? (t.series ? "tv" : "movie") : undefined;
}

/** Finished downloads that have been seeding longer than the owner allows, oldest first. */
async function scan(ctx: PluginContext, s: Settings): Promise<Found[]> {
	const now = Date.now();
	const found: Found[] = [];
	for (const d of await ctx.reelix.read.downloads()) {
		if (!d.completedAt || !["complete", "filed"].includes(d.state)) continue;
		const seededDays = Math.floor((now - Date.parse(d.completedAt)) / DAY_MS);
		if (seededDays < s.seeded_days) continue;
		if (s.kind !== "all" && (await kindOf(ctx, d)) !== s.kind) continue;
		found.push({ hash: d.hash, name: d.name, sizeBytes: d.sizeBytes, seededDays, detail: ctx.t("detail", { size: size(d.sizeBytes), days: seededDays }) });
	}
	return found.sort((a, b) => b.seededDays - a.seededDays);
}

export default definePlugin({
	config,
	async activate(ctx, settings) {
		/** Ask the owner; the decision comes back later and is kept for the next scan. */
		function propose(found: Found[], limit: number): number {
			const steps = found.slice(0, Math.min(limit, MAX_STEPS)).map((f) => ({ operation: "download.remove", input: { hash: f.hash, delete_data: settings.delete_files } }));
			if (!steps.length) return 0;
			const decided = ctx.propose({ key: "cleanup", title: ctx.t("proposal.title", { count: steps.length }), why: ctx.t("proposal.why", { days: settings.seeded_days }), steps });
			decided
				.then((outcome) => ctx.kv.set("last", { status: outcome.status, done: outcome.steps.filter((x) => x.status === "succeeded").length, at: new Date().toISOString() }))
				.catch((e: unknown) => ctx.log(`the proposal was refused: ${e instanceof Error ? e.message : String(e)}`));
			return steps.length;
		}

		await ctx.card("finished", {
			layout: "list",
			title: ctx.t("card.title", { days: settings.seeded_days }),
			items: "downloads",
			primary: "name",
			secondary: "detail",
			empty: ctx.t("card.empty"),
			buttons: [{ label: ctx.t("card.propose"), operation: "propose" }],
		});

		await ctx.operation({
			name: "scan",
			summary: "List finished downloads seeded longer than the owner's limit, which they may want removed. Removes nothing; finished-cleanup.propose asks the owner",
			effect: "read",
			input: Type.Object({}),
			tool: true,
			card: "finished",
			async run() {
				const downloads = await scan(ctx, settings);
				return { seeded_days: settings.seeded_days, delete_files: settings.delete_files, downloads, last: await ctx.kv.get("last") };
			},
			toText: (o: { seeded_days: number; downloads: Found[]; last?: { status: string; done: number } }) =>
				[
					o.downloads.length ? `${o.downloads.length} finished downloads seeded ${o.seeded_days} days or more:` : `No finished download has seeded ${o.seeded_days} days or more.`,
					...o.downloads.map((d) => `${d.hash.slice(0, 10)} | ${d.name} | ${d.detail}`),
					o.last ? `Last proposal: ${o.last.status}, ${o.last.done} removed.` : "",
				]
					.filter(Boolean)
					.join("\n"),
		});

		await ctx.operation({
			name: "propose",
			summary: "Ask the owner to approve removing the finished downloads that scan lists; nothing is removed without their yes",
			effect: "write",
			input: Type.Object({}),
			async run() {
				return { proposed: propose(await scan(ctx, settings), MAX_STEPS) };
			},
			toText: (o: { proposed: number }) => (o.proposed ? `Proposed removing ${o.proposed} downloads; the owner decides in the Inbox.` : "Nothing to propose."),
		});

		await ctx.operation({
			name: "kinds",
			summary: "The kinds of title the cleanup can be limited to (options of the kind setting)",
			effect: "read",
			input: Type.Object({}),
			async run(): Promise<SettingOption[]> {
				return ["all", "movie", "tv"].map((value) => ({ value, label: ctx.t(`kinds.${value}`) }));
			},
		});

		await ctx.job({
			name: "daily",
			every: settings.schedule === "daily" ? "1440m" : undefined,
			async run() {
				const proposed = propose(await scan(ctx, settings), settings.at_most);
				return { state: "succeeded", summary: ctx.t("job", { count: proposed }) };
			},
		});
	},
});
