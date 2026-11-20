/**
 * A small conventional release-name parser for the routine majority (§5.2).
 * It is deliberately incomplete: when unsure it says so, and the model reads the name instead.
 */

export type ParsedName = {
	title?: string;
	year?: number;
	season?: number;
	seasons?: number[]; // a multi-season pack
	episodes?: number[]; // within `season`, or absolute when `absolute` is true
	absolute?: boolean;
	complete?: boolean; // "Complete", "全集", whole-season pack without episode numbers
	resolution?: string; // 2160p, 1080p, 720p, 480p
	source?: string; // WEB-DL, WEBRip, BluRay, Remux, HDTV, DVD, BDRip
	codec?: string; // x265, x264, AV1
	hdr?: string[]; // HDR, HDR10+, DV
	audio?: string[];
	group?: string;
	chineseSubs?: "simplified" | "traditional" | "bilingual" | "chinese";
	confident: boolean;
	why?: string; // when not confident
};

const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

export function chineseNumber(s: string): number | undefined {
	if (/^\d+$/.test(s)) return Number(s);
	if (!/^[零一二两三四五六七八九十百]+$/.test(s)) return undefined;
	let total = 0;
	let cur = 0;
	for (const ch of s) {
		if (ch === "百") {
			total += (cur || 1) * 100;
			cur = 0;
		} else if (ch === "十") {
			total += (cur || 1) * 10;
			cur = 0;
		} else cur = CN_NUM[ch] ?? 0;
	}
	return total + cur;
}

function range(a: number, b: number): number[] {
	if (b < a || b - a > 2000) return [a];
	return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

export function parseReleaseName(input: string): ParsedName {
	const raw = input.replace(/\.(mkv|mp4|avi|ts|m2ts|torrent)$/i, "");
	const out: ParsedName = { confident: true };
	const n = raw.replace(/_/g, " ");

	// --- quality fields
	const res = /\b(2160p|4k|uhd|1080[pi]|720p|576p|480p)\b/i.exec(n);
	if (res) out.resolution = /4k|uhd|2160/i.test(res[1]!) ? "2160p" : res[1]!.toLowerCase().replace("1080i", "1080p");
	const src = /\b(remux|blu-?ray|bdrip|brrip|bd|web-?dl|webrip|web|hdtv|dvdrip|dvd|hdrip|uhd blu-?ray)\b/i.exec(n);
	if (src) {
		const s = src[1]!.toLowerCase().replace("-", "");
		out.source = /remux/.test(s) ? "Remux" : /bluray|^bd$/.test(s) ? "BluRay" : s === "bdrip" || s === "brrip" ? "BDRip" : s === "webdl" ? "WEB-DL" : s === "webrip" ? "WEBRip" : s === "web" ? "WEB" : s === "hdtv" ? "HDTV" : s.startsWith("dvd") ? "DVD" : s;
		if (/remux/i.test(n) && out.source !== "Remux") out.source = "Remux";
	}
	const codec = /\b(x\.?265|h\.?265|hevc|x\.?264|h\.?264|avc|av1|vp9)\b/i.exec(n);
	if (codec) out.codec = /265|hevc/i.test(codec[1]!) ? "x265" : /264|avc/i.test(codec[1]!) ? "x264" : codec[1]!.toUpperCase();
	const hdr: string[] = [];
	if (/\b(dv|dovi|dolby[ .]?vision)\b/i.test(n)) hdr.push("DV");
	if (/\bhdr10\+|hdr10plus\b/i.test(n)) hdr.push("HDR10+");
	else if (/\bhdr(10)?\b/i.test(n)) hdr.push("HDR");
	if (hdr.length) out.hdr = hdr;
	const audio = [...n.matchAll(/\b(atmos|truehd|dts-?hd(?:[ .]?ma)?|dts-?x|dts|ddp?[ .]?5[ .]1|dd\+|eac3|e-ac-3|ac3|aac|flac|opus)\b/gi)].map((m) => m[1]!.toUpperCase());
	if (audio.length) out.audio = [...new Set(audio)];

	// --- Chinese subtitle hints
	if (/简繁|繁简|简中.*繁中|chs.?cht|cht.?chs/i.test(n)) out.chineseSubs = "chinese";
	else if (/简英|中英|双语|chs.?eng|eng.?chs|bilingual/i.test(n)) out.chineseSubs = "bilingual";
	else if (/简体|简中|chs|gb\b|简日/i.test(n)) out.chineseSubs = "simplified";
	else if (/繁体|繁中|cht|big5|繁日/i.test(n)) out.chineseSubs = "traditional";
	else if (/中字|中文字幕|内封|内嵌|官中/i.test(n)) out.chineseSubs = "chinese";

	// --- group: "-GROUP" at the end, or a leading [Group] (anime)
	const lead = /^\s*\[([^\]]+)\]/.exec(n);
	const tail = /-([A-Za-z0-9@&]+)(?:\s*\[[^\]]*\])?\s*$/.exec(raw);
	if (lead && !/^\d/.test(lead[1]!)) out.group = lead[1];
	else if (tail && !/^(dl|rip|\d+p)$/i.test(tail[1]!)) out.group = tail[1];

	// --- seasons and episodes
	let idx = -1; // where the title ends
	const mark = (m: RegExpExecArray | null) => {
		if (m && (idx === -1 || m.index < idx)) idx = m.index;
		return m;
	};
	let m: RegExpExecArray | null;
	if ((m = mark(/\bS(\d{1,2})[ .-]?E(\d{1,4})(?:[ .-]?(?:E|-E?)(\d{1,4}))*/i.exec(n)))) {
		out.season = Number(m[1]);
		const eps = [...m[0].matchAll(/E?(\d{1,4})/gi)].slice(1).map((x) => Number(x[1]));
		const first = Number(m[2]);
		const last = eps.length ? eps[eps.length - 1]! : first;
		out.episodes = /-/.test(m[0].slice(m[0].toUpperCase().indexOf("E"))) ? range(first, last) : [...new Set([first, ...eps])];
	} else if ((m = mark(/\bS(\d{1,2})\s*-\s*S?(\d{1,2})\b/i.exec(n)))) {
		out.seasons = range(Number(m[1]), Number(m[2]));
		out.complete = true;
	} else if ((m = mark(/\b(?:S|Season[ .]?)(\d{1,2})\b(?![ .]?E\d)/i.exec(n)))) {
		out.season = Number(m[1]);
		out.complete = true;
	}
	// Chinese forms: 第二季 第01集 第1-12集 全12集
	const cnSeason = mark(/第([零一二两三四五六七八九十百\d]+)季/.exec(n));
	if (cnSeason && out.season === undefined) out.season = chineseNumber(cnSeason[1]!);
	const cnEp = mark(/第(\d{1,4})(?:\s*[-~]\s*(\d{1,4}))?[集话話]/.exec(n));
	if (cnEp && !out.episodes) out.episodes = cnEp[2] ? range(Number(cnEp[1]), Number(cnEp[2])) : [Number(cnEp[1])];
	if (mark(/全\s*(\d{1,4})\s*[集话話]|全集|complete/i.exec(n)) && !out.episodes) out.complete = true;

	// Anime: "[Group] Title - 05 [1080p]" or "Title - 05v2"; "[01-12]"
	if (!out.episodes && out.season === undefined) {
		const a = mark(/\s-\s(\d{1,4})(?:v\d)?(?=\s|\[|\(|$)/.exec(n)) ?? mark(/\[(\d{1,4})(?:v\d)?\]/.exec(n));
		if (a) {
			out.episodes = [Number(a[1])];
			out.absolute = true;
		}
		const ab = mark(/\[(\d{1,4})\s*-\s*(\d{1,4})(?:\s*(?:fin|end))?\]|\s(\d{1,4})\s*-\s*(\d{1,4})\s*(?:fin|end)?(?=\s*[[(]|\s*$)/i.exec(n));
		if (ab && !a) {
			const lo = Number(ab[1] ?? ab[3]);
			const hi = Number(ab[2] ?? ab[4]);
			out.episodes = range(lo, hi);
			out.absolute = true;
		}
	}

	// --- year: last plausible year that is not the whole title (1917, 2012 are titles)
	const years = [...n.matchAll(/(?:^|[\s.([])((?:19|20)\d{2})(?=$|[\s.)\]])/g)];
	for (const y of years.reverse()) {
		const before = n.slice(0, y.index).replace(/^\s*\[[^\]]*\]\s*/, "").trim();
		if (before.length === 0) continue; // the title itself is a year
		out.year = Number(y[1]);
		if (idx === -1 || y.index! < idx) idx = y.index! + (y[0].length - y[1]!.length);
		break;
	}

	// --- title: everything before the first structural marker
	const qualityIdx = /\b(2160p|4k|1080[pi]|720p|480p|web-?dl|webrip|blu-?ray|remux|hdtv|x26[45]|h\.?26[45]|hevc)\b/i.exec(n)?.index;
	let end = idx === -1 ? (qualityIdx ?? n.length) : Math.min(idx, qualityIdx ?? Infinity);
	let titlePart = n.slice(0, end);
	titlePart = titlePart.replace(/^\s*\[[^\]]*\]\s*/, ""); // leading [Group]
	titlePart = titlePart.replace(/[[(【][^\])】]*$/, ""); // dangling bracket
	titlePart = titlePart.replace(/\./g, " ").replace(/\s+-\s*$/, "").replace(/[\s\-_[(（【]+$/, "").trim();
	// Chinese-English names like "奥本海默 Oppenheimer": keep both; the matcher splits them.
	if (titlePart) out.title = titlePart;

	// --- confidence
	const reasons: string[] = [];
	if (!out.title) reasons.push("no title found");
	if (/[[【].*[\]】].*[[【].*[\]】].*[[【]/.test(n) && !out.episodes && !out.complete) reasons.push("bracket-heavy name without a clear episode");
	if (out.absolute && out.episodes && out.episodes.length === 1 && out.episodes[0]! > 200) reasons.push("episode number looks like something else");
	if (/\b(trailer|sample|featurette)\b/i.test(n)) reasons.push("looks like an extra");
	if (reasons.length) {
		out.confident = false;
		out.why = reasons.join("; ");
	}
	return out;
}

/** Split "奥本海默 Oppenheimer" into its CJK and Latin parts for matching. */
export function titleVariants(title: string): string[] {
	const v = new Set<string>([title.trim()]);
	const cjk = title.match(/[぀-ヿ㐀-鿿豈-﫿][぀-ヿ㐀-鿿豈-﫿\d：:·・\s]*/g);
	const latin = title.replace(/[぀-ヿ㐀-鿿豈-﫿：·・]+/g, " ").replace(/\s+/g, " ").trim();
	for (const c of cjk ?? []) if (c.trim()) v.add(c.trim());
	if (latin && /[a-z]/i.test(latin)) v.add(latin);
	return [...v];
}

/** Normalise a name for exact comparison. */
export function normName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[\s.\-_:：·・'’!?,，。!？&]+/g, "")
		.replace(/^the/, "");
}
