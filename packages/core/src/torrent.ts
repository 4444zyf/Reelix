import { createHash } from "node:crypto";
import { ReelixError } from "./util.ts";

type BValue = number | Uint8Array | BValue[] | { [k: string]: BValue };

/** Minimal bencode decoder that also records the byte span of the `info` dictionary. */
function decode(buf: Uint8Array): { value: BValue; infoSpan?: [number, number] } {
	let i = 0;
	let infoSpan: [number, number] | undefined;
	const dec = new TextDecoder();
	const readInt = (end: number) => {
		const s = dec.decode(buf.subarray(i, end));
		i = end + 1;
		return Number(s);
	};
	const next = (depth: number): BValue => {
		if (depth > 64) throw new ReelixError("bad_torrent", "torrent file is nested too deeply");
		const c = buf[i];
		if (c === 0x69 /* i */) {
			i++;
			const end = buf.indexOf(0x65, i);
			return readInt(end);
		}
		if (c === 0x6c /* l */) {
			i++;
			const out: BValue[] = [];
			while (buf[i] !== 0x65) {
				if (i >= buf.length) throw new ReelixError("bad_torrent", "truncated torrent file");
				out.push(next(depth + 1));
			}
			i++;
			return out;
		}
		if (c === 0x64 /* d */) {
			i++;
			const out: Record<string, BValue> = {};
			while (buf[i] !== 0x65) {
				if (i >= buf.length) throw new ReelixError("bad_torrent", "truncated torrent file");
				const k = dec.decode(next(depth + 1) as Uint8Array);
				const start = i;
				out[k] = next(depth + 1);
				if (k === "info" && depth === 0) infoSpan = [start, i];
			}
			i++;
			return out;
		}
		if (c !== undefined && c >= 0x30 && c <= 0x39) {
			const colon = buf.indexOf(0x3a, i);
			const len = Number(dec.decode(buf.subarray(i, colon)));
			i = colon + 1;
			const s = buf.subarray(i, i + len);
			i += len;
			return s;
		}
		throw new ReelixError("bad_torrent", "not a valid torrent file");
	};
	const value = next(0);
	return { value, infoSpan };
}

const str = (v: BValue | undefined): string | undefined => (v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined);

export type TorrentInfo = {
	infoHash: string; // v1 SHA-1 hex, lowercase
	name: string;
	files: { path: string; size: number }[];
	totalSize: number;
	private: boolean;
};

export function parseTorrent(bytes: Uint8Array): TorrentInfo {
	const { value, infoSpan } = decode(bytes);
	if (!infoSpan || typeof value !== "object" || value instanceof Uint8Array || Array.isArray(value)) throw new ReelixError("bad_torrent", "torrent file has no info section");
	const info = (value as Record<string, BValue>).info as Record<string, BValue>;
	const infoHash = createHash("sha1").update(bytes.subarray(infoSpan[0], infoSpan[1])).digest("hex");
	const name = str(info["name.utf-8"]) ?? str(info.name) ?? infoHash;
	const files: { path: string; size: number }[] = [];
	if (Array.isArray(info.files)) {
		for (const f of info.files as Record<string, BValue>[]) {
			const parts = ((f["path.utf-8"] ?? f.path) as BValue[]).map((p) => str(p) ?? "");
			// skip BEP-47 padding files
			const attr = str(f.attr);
			if (attr?.includes("p") || parts.some((x) => x.startsWith(".pad")) || parts[parts.length - 1]?.startsWith("_____padding_file")) continue;
			files.push({ path: [name, ...parts].join("/"), size: Number(f.length) });
		}
	} else {
		files.push({ path: name, size: Number(info.length) });
	}
	return { infoHash, name, files, totalSize: files.reduce((a, f) => a + f.size, 0), private: info.private === 1 };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function magnetHash(magnet: string): string | undefined {
	const m = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnet);
	if (!m) return undefined;
	const h = m[1]!;
	if (h.length === 40) return h.toLowerCase();
	if (h.length === 32) {
		let bits = "";
		for (const c of h.toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, "0");
		let hex = "";
		for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
		return hex.slice(0, 40);
	}
	return undefined;
}

export function magnetName(magnet: string): string | undefined {
	const m = /[?&]dn=([^&]+)/.exec(magnet);
	return m ? decodeURIComponent(m[1]!.replace(/\+/g, " ")) : undefined;
}

/** Whether a file list looks like a RAR-packed release (§5.4, decision I). */
export function looksRarPacked(files: { path: string }[]): boolean {
	return files.some((f) => /\.(rar|r\d\d|part\d+\.rar)$/i.test(f.path)) && !files.some((f) => isVideoPath(f.path) && !/sample/i.test(f.path));
}

export const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|mov|wmv|webm|flv|mpg|mpeg|iso|rmvb|vob)$/i;
export const SUB_EXT = /\.(ass|ssa|srt|sub|idx|sup|vtt|smi)$/i;
export const AUDIO_EXT = /\.(mka|flac|aac|ac3|dts|eac3|mp3|m4a|opus|ogg|thd|wav)$/i;

export function isVideoPath(p: string): boolean {
	return VIDEO_EXT.test(p);
}

export function isDiscStructure(files: { path: string }[]): "bdmv" | "video_ts" | undefined {
	if (files.some((f) => /(^|\/)BDMV\//i.test(f.path))) return "bdmv";
	if (files.some((f) => /(^|\/)VIDEO_TS\//i.test(f.path))) return "video_ts";
	return undefined;
}
