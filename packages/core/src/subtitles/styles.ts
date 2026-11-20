import { execFileSync } from "node:child_process";
import { ReelixError } from "../util.ts";
import { findBinary } from "../probe.ts";
import { type Cue, type ParsedSubtitle, assText, assTime } from "./cues.ts";

/**
 * The look of a translated subtitle (an ASS file): named presets, owner- or agent-made custom
 * looks checked against a short list of styling fields, and two effects built from the timings
 * by code (fade, typewriter). The video is never touched.
 */
export type Look = {
	font: string;
	size: number;
	color: string; // #RRGGBB
	outline: string;
	shadow: string;
	bold: boolean;
	italic: boolean;
	spacing: number;
	outlineWidth: number;
	shadowDepth: number;
	/** box: an opaque box behind the text instead of an outline. */
	box: boolean;
	alignment: "bottom" | "top" | "middle";
	marginV: number;
	/** The smaller second line (the source text) in bilingual files. */
	second: { font: string; size: number; color: string; italic: boolean };
};

export type Effects = { fade: boolean; typewriter: boolean };

export type Preset = { id: string; description: string; look: Look; effects: Effects };

const base: Look = { font: "Noto Sans", size: 58, color: "#FFFFFF", outline: "#000000", shadow: "#000000", bold: false, italic: false, spacing: 0, outlineWidth: 2.5, shadowDepth: 1, box: false, alignment: "bottom", marginV: 54, second: { font: "Noto Sans", size: 38, color: "#C8C8C8", italic: false } };
const look = (o: Partial<Omit<Look, "second">> & { second?: Partial<Look["second"]> }): Look => ({ ...base, ...o, second: { ...base.second, ...(o.second ?? {}) } });

/** Sizes are for a 1920×1080 canvas; players scale them. */
export const PRESETS: Preset[] = [
	{ id: "plain", description: "White with a thin black outline: reads on anything.", look: look({}), effects: { fade: false, typewriter: false } },
	{ id: "cinematic", description: "Warm off-white serif with a soft shadow and a gentle fade.", look: look({ font: "Noto Serif", size: 56, color: "#F4EBDD", outlineWidth: 1.2, shadowDepth: 2.5, spacing: 0.5, second: { font: "Noto Serif", color: "#BDB4A6", italic: true } }), effects: { fade: true, typewriter: false } },
	{ id: "warrior", description: "Angular amber capitals on a dark outline (Klingon and other martial tongues).", look: look({ font: "DejaVu Sans Mono", size: 54, color: "#FFB000", outline: "#2A0A00", bold: true, spacing: 3, outlineWidth: 3, shadowDepth: 0, second: { color: "#D9C7A3" } }), effects: { fade: true, typewriter: false } },
	{ id: "parchment", description: "Pale gold italic serif with a soft glow (Elvish and other high tongues).", look: look({ font: "Noto Serif", size: 58, color: "#F1E3B0", outline: "#3B2F12", italic: true, spacing: 1, outlineWidth: 1.5, shadowDepth: 2, second: { font: "Noto Serif", color: "#CFC7AE" } }), effects: { fade: true, typewriter: false } },
	{ id: "terminal", description: "Green monospace in a dark box, typed out letter by letter.", look: look({ font: "DejaVu Sans Mono", size: 48, color: "#5CFF7A", outline: "#06140A", box: true, outlineWidth: 6, shadowDepth: 0, second: { font: "DejaVu Sans Mono", size: 34, color: "#9AD8A6" } }), effects: { fade: false, typewriter: true } },
	{ id: "storybook", description: "Rounded cream text in a brown box, for rhymes, pirates and children's tales.", look: look({ font: "Noto Serif", size: 54, color: "#FFF6DC", outline: "#4A2E12", box: true, bold: true, outlineWidth: 8, shadowDepth: 0, second: { color: "#E7D6B0" } }), effects: { fade: true, typewriter: false } },
];

export function getPreset(id: string): Preset {
	const p = PRESETS.find((x) => x.id === id);
	if (!p) throw new ReelixError("no_style", `No subtitle style "${id}". Styles: ${PRESETS.map((x) => x.id).join(", ")}.`);
	return p;
}

/** Fonts every common player has or substitutes well, plus what this machine has installed. */
const SAFE_FONTS = ["Arial", "Noto Sans", "Noto Serif", "Noto Sans Mono", "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans", "Liberation Serif", "Liberation Mono", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Impact", "Noto Sans CJK SC", "Noto Serif CJK SC", "Noto Sans SC", "Noto Serif SC"];
let installed: Set<string> | undefined;

export function knownFonts(): Set<string> {
	if (installed) return installed;
	installed = new Set(SAFE_FONTS.map((f) => f.toLowerCase()));
	const fc = findBinary("fc-list");
	if (fc) {
		try {
			for (const l of execFileSync(fc, [":", "family"], { encoding: "utf8", timeout: 10_000 }).split("\n")) for (const f of l.split(",")) if (f.trim()) installed.add(f.trim().toLowerCase());
		} catch {
			/* the safe list is enough */
		}
	}
	return installed;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A custom look: only the fields of Look, with plain values. Anything else is refused, so a look
 * can never carry ASS codes (drawings, clips, embedded files) into the library.
 */
export function checkLook(input: unknown, from: Look = base, extraFonts: string[] = []): Look {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReelixError("bad_style", "A custom style is an object of styling fields.");
	const o = input as Record<string, unknown>;
	const problems: string[] = [];
	const allowed = new Set(["font", "size", "color", "outline", "shadow", "bold", "italic", "spacing", "outlineWidth", "shadowDepth", "box", "alignment", "marginV", "second"]);
	for (const k of Object.keys(o)) if (!allowed.has(k)) problems.push(`unknown field "${k}"`);
	const fonts = knownFonts();
	const font = (v: unknown, where: string, d: string) => {
		if (v === undefined) return d;
		if (typeof v !== "string" || !/^[\w .'-]{1,60}$/.test(v)) return problems.push(`${where}: not a font name`), d;
		if (!fonts.has(v.toLowerCase()) && !extraFonts.some((f) => f.toLowerCase() === v.toLowerCase())) return problems.push(`${where}: "${v}" is not installed here or in the common list (${SAFE_FONTS.slice(0, 8).join(", ")}…)`), d;
		return v;
	};
	const num = (v: unknown, where: string, d: number, min: number, max: number) => {
		if (v === undefined) return d;
		if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return problems.push(`${where}: a number from ${min} to ${max}`), d;
		return v;
	};
	const color = (v: unknown, where: string, d: string) => {
		if (v === undefined) return d;
		if (typeof v !== "string" || !HEX.test(v)) return problems.push(`${where}: a colour like #FFB000`), d;
		return v.toUpperCase();
	};
	const bool = (v: unknown, where: string, d: boolean) => {
		if (v === undefined) return d;
		if (typeof v !== "boolean") return problems.push(`${where}: true or false`), d;
		return v;
	};
	const s = (o.second ?? {}) as Record<string, unknown>;
	if (o.second !== undefined && (typeof o.second !== "object" || o.second === null)) problems.push("second: an object");
	else for (const k of Object.keys(s)) if (!["font", "size", "color", "italic"].includes(k)) problems.push(`second: unknown field "${k}"`);
	const out: Look = {
		font: font(o.font, "font", from.font),
		size: num(o.size, "size", from.size, 20, 120),
		color: color(o.color, "color", from.color),
		outline: color(o.outline, "outline", from.outline),
		shadow: color(o.shadow, "shadow", from.shadow),
		bold: bool(o.bold, "bold", from.bold),
		italic: bool(o.italic, "italic", from.italic),
		spacing: num(o.spacing, "spacing", from.spacing, 0, 20),
		outlineWidth: num(o.outlineWidth, "outlineWidth", from.outlineWidth, 0, 12),
		shadowDepth: num(o.shadowDepth, "shadowDepth", from.shadowDepth, 0, 12),
		box: bool(o.box, "box", from.box),
		alignment: o.alignment === undefined ? from.alignment : o.alignment === "bottom" || o.alignment === "top" || o.alignment === "middle" ? o.alignment : (problems.push("alignment: bottom, top or middle"), from.alignment),
		marginV: num(o.marginV, "marginV", from.marginV, 0, 400),
		second: { font: font(s.font, "second.font", from.second.font), size: num(s.size, "second.size", from.second.size, 16, 100), color: color(s.color, "second.color", from.second.color), italic: bool(s.italic, "second.italic", from.second.italic) },
	};
	if (problems.length) throw new ReelixError("bad_style", `The custom style was not accepted: ${problems.join("; ")}.`);
	return out;
}

/** #RRGGBB → ASS &H00BBGGRR. */
const assColor = (hex: string, alpha = "00") => `&H${alpha}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

function styleLine(name: string, l: { font: string; size: number; color: string; italic: boolean }, full: Look): string {
	const align = full.alignment === "top" ? 8 : full.alignment === "middle" ? 5 : 2;
	return `Style: ${name},${l.font},${l.size},${assColor(l.color)},${assColor(l.color)},${assColor(full.outline)},${assColor(full.box ? full.outline : full.shadow, full.box ? "30" : "60")},${full.bold ? -1 : 0},${l.italic ? -1 : 0},0,0,100,100,${full.spacing},0,${full.box ? 3 : 1},${full.outlineWidth},${full.shadowDepth},${align},60,60,${full.marginV},1`;
}

/** Each letter appears in turn over at most 60% of the line's time. Built from the timing only. */
function typewriter(text: string, durationS: number): string {
	const chars = [...text];
	const letters = chars.filter((c) => c !== "\n").length;
	if (!letters) return assText(text);
	const step = Math.max(8, Math.min(45, Math.floor((durationS * 600) / letters)));
	let i = 0;
	return chars
		.map((c) => {
			if (c === "\n") return "\\N";
			const at = i++ * step;
			return `{\\alpha&HFF&\\t(${at},${at + 1},\\alpha&H00&)}${assText(c)}`;
		})
		.join("");
}

export type RenderLine = { cue: Cue; text: string; second?: string };

/** The finished ASS file. Signs and songs from an ASS source keep their own styles and position codes. */
export function renderAss(lines: RenderLine[], opts: { look: Look; effects: Effects; source?: ParsedSubtitle["ass"]; title?: string }): string {
	const src = opts.source;
	const kept = new Set(lines.filter((l) => l.cue.kind !== "dialogue" && l.cue.ass).map((l) => l.cue.ass!.style));
	const sourceStyles = (src?.styleLines ?? []).filter((s) => kept.has(s.slice(6).split(",")[0]!.trim()) && !/^Style:\s*Reelix/i.test(s));
	const useSourceRes = sourceStyles.length > 0 && src?.playResX && src?.playResY;
	const resX = useSourceRes ? src!.playResX! : 1920;
	const resY = useSourceRes ? src!.playResY! : 1080;
	// Preset sizes are for 1080 lines; scale them when the source's canvas is kept for its signs.
	const k = resY / 1080;
	const scaled: Look = { ...opts.look, size: Math.round(opts.look.size * k), marginV: Math.round(opts.look.marginV * k), outlineWidth: Math.round(opts.look.outlineWidth * k * 10) / 10, shadowDepth: Math.round(opts.look.shadowDepth * k * 10) / 10, second: { ...opts.look.second, size: Math.round(opts.look.second.size * k) } };
	const head = [
		"[Script Info]",
		`Title: ${(opts.title ?? "Reelix translation").replace(/[\r\n]/g, " ")}`,
		"ScriptType: v4.00+",
		"WrapStyle: 0",
		"ScaledBorderAndShadow: yes",
		`PlayResX: ${resX}`,
		`PlayResY: ${resY}`,
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
		styleLine("Reelix", scaled, scaled),
		styleLine("ReelixSecond", scaled.second, { ...scaled, bold: false, spacing: 0 }),
		...sourceStyles,
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	];
	const events = lines.map(({ cue, text, second }) => {
		const t = `${assTime(cue.start)},${assTime(cue.end)}`;
		if (cue.kind === "keep" && cue.ass) return `Dialogue: ${cue.ass.layer},${t},${cue.ass.style},${cue.ass.name},${cue.ass.marginL},${cue.ass.marginR},${cue.ass.marginV},${cue.ass.effect},${cue.ass.raw}`;
		if (cue.kind === "sign" && cue.ass) return `Dialogue: ${cue.ass.layer},${t},${cue.ass.style},${cue.ass.name},${cue.ass.marginL},${cue.ass.marginR},${cue.ass.marginV},${cue.ass.effect},${cue.ass.lead}${assText(text)}`;
		const dur = cue.end - cue.start;
		const fade = opts.effects.fade && dur > 0.6 ? "{\\fad(140,140)}" : "";
		const main = opts.effects.typewriter ? typewriter(text, dur) : assText(text);
		const under = second ? `\\N{\\rReelixSecond}${assText(second.replace(/\r?\n/g, " "))}` : "";
		return `Dialogue: 0,${t},Reelix,,0,0,0,,${fade}${main}${under}`;
	});
	return "﻿" + [...head, ...events].join("\n") + "\n";
}

/** Klingon in Latin letters → the pIqaD script (Private Use Area, the ConScript registry's code points). */
const PIQAD: [string, number][] = [["tlh", 0xf8e4], ["ch", 0xf8d2], ["gh", 0xf8d5], ["ng", 0xf8dc], ["a", 0xf8d0], ["b", 0xf8d1], ["D", 0xf8d3], ["e", 0xf8d4], ["H", 0xf8d6], ["I", 0xf8d7], ["j", 0xf8d8], ["l", 0xf8d9], ["m", 0xf8da], ["n", 0xf8db], ["o", 0xf8dd], ["p", 0xf8de], ["q", 0xf8df], ["Q", 0xf8e0], ["r", 0xf8e1], ["S", 0xf8e2], ["t", 0xf8e3], ["u", 0xf8e5], ["v", 0xf8e6], ["w", 0xf8e7], ["y", 0xf8e8], ["'", 0xf8e9], ["’", 0xf8e9]];

export function toPiqad(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; ) {
		const hit = PIQAD.find(([l]) => text.startsWith(l, i));
		if (hit) {
			out += String.fromCharCode(hit[1]);
			i += hit[0].length;
		} else if (/\d/.test(text[i]!)) out += String.fromCharCode(0xf8f0 + Number(text[i++]));
		else out += text[i++];
	}
	return out;
}
