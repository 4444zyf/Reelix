/**
 * Writes docs/plugin-reference.md from the code (docs/plugins.md §14.1): the declarations in core
 * and the kernel for modes and limits, the types of @reelix/plugin for everything else.
 *
 *   npm run plugin-reference
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { HOOK_DECLARATIONS, PLUGIN_EVENTS, SEAM_DECLARATIONS } from "@reelix/core";
import { CONTEXT_CALLS } from "../packages/server/src/plugins/context.ts";
import { ALLOWED_MODULES } from "../packages/server/src/plugins/process.ts";
import { SCREEN_CSP } from "../packages/server/src/plugins/screen.ts";
import { settingsCopy } from "../packages/plugin-testing/src/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const REFERENCE_FILE = join(ROOT, "docs/plugin-reference.md");

const sources = ["packages/plugin/src/index.ts", "packages/plugin/src/seams.ts"].map((f) => ts.createSourceFile(f, readFileSync(join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true));

function typeAlias(name: string): ts.TypeAliasDeclaration {
	for (const f of sources) for (const s of f.statements) if (ts.isTypeAliasDeclaration(s) && s.name.text === name) return s;
	throw new Error(`no type ${name} in @reelix/plugin`);
}

const memberName = (m: ts.TypeElement) => (m.name as ts.Identifier | ts.StringLiteral).text;
const members = (name: string) => (typeAlias(name).type as ts.TypeLiteralNode).members;
const doc = (node: ts.Node) => ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join(" ").replace(/\s+/g, " ").trim();
const code = (node: ts.Node) => node.getText().replace(/\/\*\*[\s\S]*?\*\/\s*/g, "").replace(/\s+/g, " ").trim();
const cell = (text: string) => text.replace(/\|/g, "\\|");
const seconds = (ms: number) => `${ms / 1000} s`;

/** Every call of `PluginContext`, by its dotted name, with the node declaring it. */
export function contextMembers(): Map<string, ts.TypeElement> {
	const found = new Map<string, ts.TypeElement>();
	const walk = (list: readonly ts.TypeElement[], prefix: string) => {
		for (const m of list) {
			const name = `${prefix}.${memberName(m)}`;
			if (ts.isPropertySignature(m) && m.type && ts.isTypeLiteralNode(m.type)) walk(m.type.members, name);
			else found.set(name, m);
		}
	};
	walk(members("PluginContext"), "ctx");
	return found;
}

function typeOfMember(alias: string, name: string): string {
	const m = members(alias).find((x) => memberName(x) === name);
	if (!m || !ts.isPropertySignature(m) || !m.type) throw new Error(`no ${name} in ${alias}`);
	return code(m.type);
}

/** The settings annotations (`SETTINGS` in @reelix/plugin): each key with what it means. */
function settingsAnnotations(): { name: string; key: string; meaning: string }[] {
	for (const f of sources)
		for (const st of f.statements) {
			if (!ts.isVariableStatement(st)) continue;
			const d = st.declarationList.declarations[0]!;
			if (!ts.isIdentifier(d.name) || d.name.text !== "SETTINGS" || !d.initializer) continue;
			const obj = (ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer) as ts.ObjectLiteralExpression;
			return obj.properties.filter(ts.isPropertyAssignment).map((p) => ({ name: (p.name as ts.Identifier).text, key: (p.initializer as ts.StringLiteral).text, meaning: doc(p) }));
		}
	throw new Error("no SETTINGS in @reelix/plugin");
}

/** The named types the context calls of phase 3 lean on. */
const CONTEXT_TYPES = ["PluginSeamId", "PluginEventId", "PluginSeamProvider", "SeamAnswer", "OperationPreview", "CardLayout", "CardButton", "Proposal", "ProposalStep", "ProposalOutcome", "ProposalStepResult", "DownloadRecord", "SettingOption"];

/** The named types a hook's or event's signature leans on, spelled out once. */
const SUPPORT_TYPES = ["HookTitle", "ParsedFacts", "HookRelease", "HookReleases", "OrganiseItem", "ReleaseHit", "Notice", "DownloadBefore", "SubtitlePick"];

/** The named types the seams' contracts lean on. */
const SEAM_TYPES = ["Call", "Outcome", "SubtitleQuery", "SubtitleHit", "Site", "IndexerQuery", "SiteResult", "ChatOut", "AddOptions", "AddResult", "Transfer", "TransferFile", "TransferChanges", "ServerUser", "ServerLibrary", "ServerItemsQuery", "ServerItem", "ServerEpisode", "PlayRequest", "PlayerLink", "Rating", "MetaHit", "Enrichment", "TrendHit"];

export function renderReference(): string {
	const out: string[] = ["# Plugin reference", "", "Generated from the code by `npm run plugin-reference`. Do not edit: `npm test` fails when this file differs. The design is in [plugins.md](plugins.md).", ""];

	out.push("## Seams", "", "Each provider method has the time limit shown. A method marked *outcome* may answer with a typed outcome instead of a result; the others throw `OutcomeError` for an expected answer of the service. Of a seam of the kind *many* every provider is used; of one of the kind *one of several* the owner picks the active provider, and Reelix never switches by itself.", "");
	for (const s of SEAM_DECLARATIONS) {
		const contract = typeOfMember("SeamContracts", s.id);
		out.push(`### \`${s.id}\``, "", `Kind: ${s.kind === "many" ? "many" : "one of several"}. Contract: \`${contract}\``, "", "```ts", code(typeAlias(contract)), "```", "", "| Method | Limit | Outcome | Optional |", "| --- | --- | --- | --- |");
		for (const m of s.methods) out.push(`| \`${m.name}\` | ${seconds(m.limitMs)} | ${m.outcomes ? "yes" : "no"} | ${m.optional ? "yes" : "no"} |`);
		out.push("");
	}

	out.push("### Types used by seams", "", "```ts", ...SEAM_TYPES.map((t) => code(typeAlias(t))), "```", "");

	out.push("## Hooks", "", "Returning nothing means \"no opinion\". A result outside the limits is dropped and counted as a failure. Pipelines run built-in plugins first, then in order of installation.", "");
	const hooks = members("PluginHooks");
	for (const h of HOOK_DECLARATIONS) {
		const m = hooks.find((x) => memberName(x) === h.id) as ts.PropertySignature;
		out.push(`### \`${h.id}\``, "", h.summary, "", `- Mode: **${h.mode}**`, `- Time limit: ${seconds(h.limitMs)}`, ...h.limits.map((l) => `- Limit: ${l}`), "", "```ts", code(m.type!), "```", "");
	}
	out.push("### Types used by hooks", "", "```ts", ...SUPPORT_TYPES.map((t) => code(typeAlias(t))), "```", "");

	out.push("## Events", "", "| Event | Payload | Meaning |", "| --- | --- | --- |");
	const events = members("PluginEvents");
	for (const e of PLUGIN_EVENTS) {
		const m = events.find((x) => memberName(x) === e) as ts.PropertySignature;
		out.push(`| \`${e}\` | \`${cell(code(m.type!))}\` | ${cell(doc(m))} |`);
	}
	out.push("");

	out.push(
		"## Seams and events plugins own",
		"",
		"A plugin declares these in `reelix.owns` of its manifest; other plugins provide the seams and listen to the events, and must require the owner in `reelix.requires.plugins`. The contract is data: Reelix checks every answer against the method's `result` schema and every payload against the event's, and only the owner calls the seam (`ctx.seams.call`) and emits the event (`ctx.emit`). The owner's package exports the matching types. These are the ones of the plugins in this repository.",
		"",
	);
	for (const o of ownedDeclarations()) {
		for (const [id, d] of Object.entries(o.owns.seams ?? {})) {
			out.push(`### Seam \`${id}\``, "", `Owner: \`${o.id}\` (\`${o.dir}\`)${o.contract ? `; types: \`${o.name}/contract\` (\`${o.contract}\`)` : ""}. ${d.summary}`, "", "| Method | Limit | Result (JSON Schema) |", "| --- | --- | --- |");
			for (const [name, m] of Object.entries(d.methods)) out.push(`| \`${name}\` | ${seconds(m.limitMs ?? 60_000)} | \`${cell(JSON.stringify(m.result))}\` |`);
			out.push("");
		}
		for (const [id, d] of Object.entries(o.owns.events ?? {})) out.push(`### Event \`${id}\``, "", `Owner: \`${o.id}\`. ${d.summary}`, "", `Payload (JSON Schema): \`${cell(JSON.stringify(d.payload))}\``, "");
	}

	out.push("## Settings form", "", "The form is generated from the plugin's `config` schema. These annotations, written in a schema's options as `[SETTINGS.<name>]`, add what plain TypeBox cannot say. A manifest's `settings` names a JSON copy of the schema, so the form can be shown before the code is loaded.", "", "| Name | Key | Meaning |", "| --- | --- | --- |");
	for (const a of settingsAnnotations()) out.push(`| \`${a.name}\` | \`${a.key}\` | ${cell(a.meaning)} |`);
	out.push("");

	out.push("## Context calls", "", "| Call | Needs in the manifest | Signature | Meaning |", "| --- | --- | --- | --- |");
	const calls = contextMembers();
	for (const [name, needs] of Object.entries(CONTEXT_CALLS)) {
		const m = calls.get(name);
		if (!m) throw new Error(`${name} is declared but PluginContext has no such call`);
		const signature = ts.isPropertySignature(m) ? code(m.type!) : code(m).slice(memberName(m).length);
		out.push(`| \`${name}\` | ${needs ? `\`${needs}\`` : ""} | \`${cell(signature)}\` | ${cell(doc(m))} |`);
	}
	out.push("", "### Types used by context calls", "", "```ts", ...CONTEXT_TYPES.map((t) => code(typeAlias(t))), "```", "");

	const manifest = (name: string) => doc(members("PluginManifest").find((m) => memberName(m) === name)!);
	const runtimes = PLUGIN_DIRS.flatMap((dir) => {
		const r = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { reelix?: { id: string; runtime?: string; screen?: { title: string } } }).reelix;
		return r ? [{ id: r.id, runtime: r.runtime, screen: r.screen?.title }] : [];
	});
	out.push(
		"## Runtimes",
		"",
		`\`runtime\`: ${manifest("runtime")}`,
		"",
		`In a process of its own, the plugin is started with Node's permission model, enforced by Node, not by the operating system: it may read only its own folder (with its own \`node_modules\`), \`@reelix/plugin\` and the few files of Reelix and its packages the process runs, and write only its own data folder (\`ctx.folder()\`); its working folder is \`/\`; it cannot start programs or workers or load compiled addons; its environment holds none of Reelix's variables. Node 22's permission model does not cover the network, signals or \`node:sqlite\`, so Reelix's code in the process allows only these of Node's modules: ${ALLOWED_MODULES.map((m) => `\`${m}\``).join(", ")}; refuses module hooks of the plugin's own and signals to other processes; and removes Node's own \`fetch\`, \`WebSocket\` and \`EventSource\`. That part is Reelix's code inside the process, not a guarantee of the operating system: a determined plugin may find a way past it (docs/plugins.md §11.7). The network is \`ctx.http.fetch\`, which Reelix runs with its rules. Everything crosses as plain data, at most 80 MB in one message from the plugin; an ended process is a failure and starts again after a growing delay.`,
		"",
		`Plugins in this repository that run in a process of their own by default: ${runtimes.filter((r) => r.runtime === "process").map((r) => `\`${r.id}\``).join(", ") || "none"}.`,
		"",
		"## Screens",
		"",
		`\`screen\`: ${manifest("screen")}`,
		"",
		`The frame is \`<iframe sandbox="allow-scripts">\` with the document as \`srcdoc\`: no origin of its own, so no cookies, no storage of Reelix's, no calls to \`/api\` with the owner's session, no forms, pop-ups or navigation of the page around it. Reelix puts this Content-Security-Policy before anything the plugin wrote: \`${SCREEN_CSP}\`.`,
		"",
		`\`window.reelix\`: ${bridgeDoc()}`,
		"",
		`Plugins in this repository with a screen: ${runtimes.filter((r) => r.screen).map((r) => `\`${r.id}\` (${r.screen})`).join(", ") || "none"}.`,
		"",
	);
	return out.join("\n");
}

/** The documentation of `window.reelix`, from the code that defines it. */
function bridgeDoc(): string {
	const f = ts.createSourceFile("screen.ts", readFileSync(join(ROOT, "packages/server/src/plugins/screen.ts"), "utf8"), ts.ScriptTarget.Latest, true);
	for (const st of f.statements) if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "BRIDGE")) return doc(st).replace(/^`window\.reelix` inside the frame: /, "");
	throw new Error("no BRIDGE in screen.ts");
}

type OwnsDeclaration = { seams?: Record<string, { summary: string; methods: Record<string, { limitMs?: number; result: unknown }> }>; events?: Record<string, { summary: string; payload: unknown }> };

/** The plugins in this repository that own seams or events, with where their types are. */
function ownedDeclarations(): { id: string; name: string; dir: string; contract?: string; owns: OwnsDeclaration }[] {
	return PLUGIN_DIRS.flatMap((dir) => {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; exports?: Record<string, string>; reelix?: { id: string; owns?: OwnsDeclaration } };
		if (!pkg.reelix?.owns) return [];
		const rel = dir.slice(ROOT.length + 1);
		const contract = pkg.exports?.["./contract"];
		return [{ id: pkg.reelix.id, name: pkg.name, dir: rel, contract: contract && join(rel, contract), owns: pkg.reelix.owns }];
	});
}

/** The plugins in this repository, and the templates of `reelix plugin new` that are whole plugins. */
const PLUGIN_DIRS = [join(ROOT, "plugins"), join(ROOT, "plugins/examples"), join(ROOT, "packages/cli/templates")].flatMap((root) => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name))).filter((d) => existsSync(join(d, "package.json")));

/** Each plugin's copy of its settings schema (docs/plugins.md §12.2): the file its manifest names, and what the code declares. */
export async function settingsCopies(): Promise<{ dir: string; file: string; expected: string }[]> {
	const out: { dir: string; file: string; expected: string }[] = [];
	for (const dir of PLUGIN_DIRS) {
		const copy = await settingsCopy(dir);
		if (copy) out.push({ dir, ...copy });
	}
	return out;
}

if (process.argv[1] === import.meta.filename) {
	writeFileSync(REFERENCE_FILE, renderReference());
	console.log(`Wrote ${REFERENCE_FILE}`);
	for (const c of await settingsCopies()) {
		writeFileSync(c.file, c.expected);
		console.log(`Wrote ${c.file}`);
	}
}
