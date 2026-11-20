import { ReelixError } from "../util.ts";

/**
 * Subtitles as timed lines, for translation: read SRT, WebVTT and ASS into cues, keep what must
 * survive (timings, sign positions, song styling), and give the model plain text only.
 */
export type Cue = {
	/** Seconds. */
	start: number;
	end: number;
	/** Plain text; line breaks as \n. No styling codes. */
	text: string;
	/** dialogue: translated and restyled. sign: translated, keeps its own style and position. keep: copied as it is (karaoke, drawings). */
	kind: "dialogue" | "sign" | "keep";
	/** ASS only: the event's own fields, so signs and songs keep their look. */
	ass?: { layer: string; style: string; name: string; marginL: string; marginR: string; marginV: string; effect: string; lead: string; raw: string };
};

export type ParsedSubtitle = {
	format: "srt" | "vtt" | "ass";
	cues: Cue[];
	/** ASS only: what the output needs to keep signs and songs looking the same. */
	ass?: { playResX?: number; playResY?: number; styleLines: string[] };
};

const time = (h: string, m: string, s: string, frac: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac}`);

function parseSrtLike(text: string, format: "srt" | "vtt"): ParsedSubtitle {
	const cues: Cue[] = [];
	for (const block of text.replace(/^﻿/, "").split(/\r?\n\s*\r?\n/)) {
		const lines = block.split(/\r?\n/);
		const at = lines.findIndex((l) => l.includes("-->"));
		if (at < 0) continue;
		const m = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})/.exec(lines[at]!);
		if (!m) continue;
		const body = lines
			.slice(at + 1)
			.map((l) => l.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").trim())
			.filter(Boolean)
			.join("\n");
		if (!body) continue;
		cues.push({ start: time(m[1] ?? "0", m[2]!, m[3]!, m[4]!), end: time(m[5] ?? "0", m[6]!, m[7]!, m[8]!), text: body, kind: "dialogue" });
	}
	return { format, cues };
}

const SIGN_STYLE = /sign|title|screen|note|caption|typeset|\bts\b|op\b|ed\b|song|lyric|karaoke|insert/i;

function parseAss(text: string): ParsedSubtitle {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/);
	const cues: Cue[] = [];
	const styleLines: string[] = [];
	let section = "";
	let format: string[] = [];
	let playResX: number | undefined;
	let playResY: number | undefined;
	for (const line of lines) {
		const sec = /^\[(.+)\]\s*$/.exec(line);
		if (sec) {
			section = sec[1]!.toLowerCase();
			continue;
		}
		if (section === "script info") {
			const m = /^PlayRes([XY]):\s*(\d+)/i.exec(line);
			if (m) m[1]!.toUpperCase() === "X" ? (playResX = Number(m[2])) : (playResY = Number(m[2]));
		} else if (section.includes("styles")) {
			if (/^Style:/i.test(line)) styleLines.push(line.trim());
		} else if (section === "events") {
			if (/^Format:/i.test(line)) format = line.slice(7).split(",").map((s) => s.trim().toLowerCase());
			if (!/^Dialogue:/i.test(line)) continue;
			const n = format.length || 10;
			const parts = line.slice(line.indexOf(":") + 1).split(",");
			const f = parts.slice(0, n - 1).map((s) => s.trim());
			const raw = parts.slice(n - 1).join(",");
			const idx = (k: string, d: number) => (format.indexOf(k) >= 0 ? format.indexOf(k) : d);
			const ts = (s: string) => {
				const m = /(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(s);
				return m ? time(m[1]!, m[2]!, m[3]!, m[4]!) : 0;
			};
			const lead = /^(\{[^}]*\})+/.exec(raw)?.[0] ?? "";
			const plain = raw.replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").replace(/\\n/g, " ").replace(/\\h/g, " ").trim();
			const style = f[idx("style", 3)] ?? "Default";
			const karaoke = /\\k[fo]?\d/i.test(raw);
			const drawing = /\\p[1-9]/.test(raw);
			const positioned = /\\(pos|move|org|clip|iclip)\s*\(/.test(lead) || /\\an[1-9]/.test(lead);
			const kind: Cue["kind"] = karaoke || drawing || !plain ? "keep" : positioned || SIGN_STYLE.test(style) ? "sign" : "dialogue";
			cues.push({
				start: ts(f[idx("start", 1)] ?? ""),
				end: ts(f[idx("end", 2)] ?? ""),
				text: plain,
				kind,
				ass: { layer: f[idx("layer", 0)] ?? "0", style, name: f[idx("name", 4)] ?? "", marginL: f[idx("marginl", 5)] ?? "0", marginR: f[idx("marginr", 6)] ?? "0", marginV: f[idx("marginv", 7)] ?? "0", effect: f[idx("effect", 8)] ?? "", lead, raw },
			});
		}
	}
	cues.sort((a, b) => a.start - b.start);
	return { format: "ass", cues, ass: { playResX, playResY, styleLines } };
}

export function parseSubtitle(text: string, format?: string): ParsedSubtitle {
	const isAss = format === "ass" || format === "ssa" || /^\[Script Info\]/im.test(text) || /^Dialogue:/m.test(text);
	const parsed = isAss ? parseAss(text) : parseSrtLike(text, /^﻿?WEBVTT/.test(text) || format === "vtt" ? "vtt" : "srt");
	if (!parsed.cues.length) throw new ReelixError("no_cues", "This subtitle has no timed lines that can be read (it may be a picture-based format).");
	return parsed;
}

export function assTime(s: number): string {
	const cs = Math.max(0, Math.round(s * 100));
	const p = (n: number) => String(n).padStart(2, "0");
	return `${Math.floor(cs / 360000)}:${p(Math.floor(cs / 6000) % 60)}:${p(Math.floor(cs / 100) % 60)}.${p(cs % 100)}`;
}

/** Text safe to put in an ASS event: no braces (they start styling codes), line breaks as \N. */
export function assText(s: string): string {
	return s.replace(/[{}]/g, "").replace(/\\/g, "＼").replace(/\r?\n/g, "\\N");
}

/** Characters a viewer can read in the time a line is shown (about 20 per second; half for CJK). */
export function readableLimit(c: Cue, cjk: boolean): number {
	const d = Math.max(0.7, c.end - c.start);
	return Math.max(cjk ? 12 : 24, Math.round(d * (cjk ? 10 : 20)));
}
