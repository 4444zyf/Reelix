import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReelixError } from "./util.ts";

const run = promisify(execFile);

/** Find an external binary: env override, Reelix's tools folder, then PATH. */
export function findBinary(name: string): string | undefined {
	const env = process.env[`REELIX_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
	if (env && existsSync(env)) return env;
	for (const dir of [process.env.REELIX_TOOLS, join(process.cwd(), ".tools/bin"), "/usr/local/bin", "/usr/bin"]) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, name))) return join(dir, name);
	return undefined;
}

export type Probe = {
	path: string;
	durationS?: number;
	sizeBytes?: number;
	container?: string;
	video?: { codec: string; width: number; height: number; hdr?: string };
	audio: { index: number; codec: string; language?: string; channels?: number; title?: string }[];
	subtitles: { index: number; codec: string; language?: string; title?: string; forced?: boolean; default?: boolean }[];
};

export async function probe(path: string): Promise<Probe> {
	const ffprobe = findBinary("ffprobe");
	if (!ffprobe) throw new ReelixError("missing_tool", "ffprobe is not installed, so videos cannot be inspected.");
	const { stdout } = await run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
	const d = JSON.parse(stdout) as { format?: Record<string, any>; streams?: Record<string, any>[] };
	const streams = d.streams ?? [];
	const v = streams.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
	const hdr = v?.color_transfer === "smpte2084" ? "HDR10" : v?.color_transfer === "arib-std-b67" ? "HLG" : streams.some((s) => s.side_data_list?.some((x: any) => /dovi/i.test(x.side_data_type ?? ""))) ? "DV" : undefined;
	return {
		path,
		durationS: Number(d.format?.duration) || undefined,
		sizeBytes: Number(d.format?.size) || undefined,
		container: d.format?.format_name,
		video: v ? { codec: v.codec_name, width: v.width, height: v.height, hdr } : undefined,
		audio: streams.filter((s) => s.codec_type === "audio").map((s) => ({ index: s.index, codec: s.codec_name, language: s.tags?.language, channels: s.channels, title: s.tags?.title })),
		subtitles: streams
			.filter((s) => s.codec_type === "subtitle")
			.map((s) => ({ index: s.index, codec: s.codec_name, language: s.tags?.language, title: s.tags?.title, forced: s.disposition?.forced === 1, default: s.disposition?.default === 1 })),
	};
}

/** Grab one frame as PNG (for the model to look at). */
export async function grabFrame(path: string, atS: number, out: string): Promise<string> {
	const ffmpeg = findBinary("ffmpeg");
	if (!ffmpeg) throw new ReelixError("missing_tool", "ffmpeg is not installed, so frames cannot be grabbed.");
	await run(ffmpeg, ["-v", "error", "-y", "-ss", String(atS), "-i", path, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", out], { timeout: 60_000 });
	return out;
}

export function probeToText(p: Probe): string {
	const dur = p.durationS ? `${Math.floor(p.durationS / 60)} min ${Math.round(p.durationS % 60)} s` : "unknown length";
	const v = p.video ? `${p.video.codec} ${p.video.width}x${p.video.height}${p.video.hdr ? ` ${p.video.hdr}` : ""}` : "no video";
	const a = p.audio.map((x) => `#${x.index} ${x.codec}${x.channels ? ` ${x.channels}ch` : ""} ${x.language ?? "und"}${x.title ? ` "${x.title}"` : ""}`).join("; ");
	const s = p.subtitles.map((x) => `#${x.index} ${x.codec} ${x.language ?? "und"}${x.title ? ` "${x.title}"` : ""}${x.default ? " default" : ""}${x.forced ? " forced" : ""}`).join("; ");
	return `${p.path}\n${dur}, ${v}\naudio: ${a || "none"}\nsubtitles: ${s || "none"}`;
}

/** Whether a video's running time fits TMDB's (cheap content check, §5.4). */
export function runtimeFits(durationS: number | undefined, expectedMin: number | null | undefined, kind: "movie" | "tv"): { ok: boolean; why?: string } {
	if (!durationS || !expectedMin) return { ok: true };
	const got = durationS / 60;
	const diff = Math.abs(got - expectedMin);
	const limit = kind === "movie" ? Math.max(20, expectedMin * 0.2) : Math.max(10, expectedMin * 0.5);
	if (kind === "tv" && got > expectedMin * 2.5 && got > 90) return { ok: false, why: `episode file is ${Math.round(got)} min, expected about ${expectedMin}` };
	if (kind === "movie" && diff > limit) return { ok: false, why: `film is ${Math.round(got)} min, TMDB says ${expectedMin}` };
	return { ok: true };
}
