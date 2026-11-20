import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { findBinary } from "../probe.ts";
import { ReelixError } from "../util.ts";

const run = promisify(execFile);

export const SUB_FILE = /\.(ass|ssa|srt|vtt|sub|idx|sup)$/i;
const LIMITS = { files: 500, totalBytes: 200 * 1024 * 1024, depth: 3 };

// ------------------------------------------------------------------ text encoding

/** Decode subtitle bytes: BOMs, valid UTF-8, else the better of GB18030 and Big5 (§5.5 step 6). */
export function decodeSubtitle(bytes: Uint8Array): { text: string; encoding: string } {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
	} catch {}
	const score = (t: string) => {
		let bad = 0;
		let common = 0;
		for (const ch of t) {
			if (ch === "�") bad += 10;
			else if (COMMON.has(ch)) common++;
			else if (/[㐀-䶿-]/.test(ch)) bad++; // rare extension / private use: wrong guess
		}
		return common - bad;
	};
	const candidates = ["gb18030", "big5"].map((enc) => {
		const text = new TextDecoder(enc).decode(bytes);
		return { text, encoding: enc, s: score(text) };
	});
	candidates.sort((a, b) => b.s - a.s);
	return { text: candidates[0]!.text, encoding: candidates[0]!.encoding };
}

// Frequent characters in both scripts, used to judge a decoding.
const COMMON = new Set("的一是不了在人有我他这個个们們中来來上大为為和国國地到以说說时時要就出会會可也你对對生能而子那得于於着著下自之年过過发發后後作里裡用道行所然家种種事成方多经經么麼去法学學如都同现現当當没沒动動面起看定天分还還进進好小部其些主样樣理心她本前开開但因只从從想实實日军軍者意无無力它与與长長把机機十民第公此已工使情明性知全三又关關点點正业業外将將两兩高间間由问問很最重并並物手应應战戰向头頭文体體政美相见見被利什二等产產或新己制身果加西斯月话話合回特代内內信表化老给給世位次度门門任常先海通教儿兒原东東声聲提立及比员員解水名真论論处處走义義各入几幾口认認条條平系系气氣题題活尔爾更别別打女变變四神总總何电電数數安少报報才结結反受目太量再感建务務做接必场場件计計管期市直德资資命山金指克许許统統区區保至队隊形社便空决決治展马馬科司五基眼书書非则則听聽白却界达達光放强強即像难難且权權思王象完设設式色路记記南品住告类類求据據程北边邊死张張该該交规規万萬取拉格望觉覺术術领領共确確传傳师師观觀清今切院让讓识識候带帶导導争爭运運笑飞飛风風步改收根干幹造言联聯持组組每济濟车車亲親极極林服快办辦议議往元英士证證近失转轉夫令准準布始怎呢存未远遠叫台单單影具罗羅字爱愛击擊流备備兵连連调調深商算质質团團集百需价價花党黨华華城石级級整府离離况況亚亞请請技际際约約示复復病息究线線似官火断斷精满滿支视視消越器容照须須九增研写寫称稱企八功吗嗎包片史委乎查轻輕易早曾除农農找装裝广廣显顯吧阿李标標谈談吃图圖念六引历歷首医醫局突专專费費号號尽盡另周较較注语語仅僅考落青随隨选選列武红紅响響虽雖推势勢参參希古众眾构構房半节節土投某案黑维維革划劃敌敵致陈陳律足态態护護七兴興派孩验驗责責营營星够夠章音跟志底站严嚴巴例防族供效续續施留讲講型料终終答紧緊黄黃绝絕奇察母京段依批群项項故按河米围圍江织織害斗鬥双雙境客纪紀采採举舉杀殺攻父苏蘇密低朝友诉訴止细細愿願千值仍男钱錢破网網热熱助倒育属屬坐帝限船脸臉职職速刻乐樂否刚剛威毛状狀率甚独獨球般普怕弹彈校苦创創假久错錯承印晚兰蘭试試股拿脑腦预預谁誰益阳陽若哪微尼继繼送急血惊驚伤傷素药藥适適波夜省初喜卫衛源食险險待述陆陸习習置居劳勞财財环環排福纳納欢歡雷警获獲模充负負云雲停木游遊龙龍树樹疑层層冷洲冲衝射略范範竟句室异異激汉漢村哈策演简簡卡罪判担擔州静靜退既衣您宗积積余餘痛检檢差富灵靈协協角占配征修皮挥揮胜勝降阶階审審沉坚堅善妈媽刘劉读讀啊超免压壓银銀买買皇养養伊怀懷执執副乱亂抗犯追帮幫宣佛岁歲航优優怪香著田铁鐵控税稅左右份穿艺藝背阵陣草脚腳概恶惡块塊顿頓敢守酒岛島托央户戶烈洋哥索胡款靠评評版宝寶座释釋景顾顧弟登货貨互付伯慢欧歐换換闻聞危忙核暗姐介坏壞讨討丽麗良序升监監临臨亮露永呼味野架域沙掉括舰艦鱼魚杂雜误誤湾灣吉减減编編楚肯测測败敗屋跑梦夢散温溫困剑劍渐漸封救贵貴枪槍缺楼樓县縣尚毫移娘朋画畫班智亦耳恩短掌恐遗遺固席松秘谢謝鲁魯遇康虑慮幸均销銷钟鐘诗詩藏赶趕剧劇票损損忽巨炮旧舊端探湖录錄叶葉春乡鄉附吸予礼禮港雨呀板庭妇婦归歸睛饭飯额額含顺順输輸摇搖招婚脱脫补補谓謂督毒油疗療旅泽澤材灭滅逐莫笔筆亡鲜鮮词詞圣聖择擇寻尋厂廠睡博勒烟煙授诺諾伦倫岸奥奧唐卖賣俄炸载載洛健堂旁宫宮喝借君禁阴陰园園谋謀宋避抓荣榮姑孙孫逃牙束跳顶頂玉镇鎮雪午练練迫爷爺篇肉嘴馆館遍凡础礎洞卷坦牛宁寧纸紙诸諸训訓私庄莊祖丝絲翻暴森塔默握戏戲隐隱熟骨访訪弱蒙歌店鬼软軟典欲萨薩伙遭盘盤爸扩擴盖蓋弄雄稳穩忘亿億刺拥擁徒姆杨楊齐齊赛賽趣曲刀床迎冰虚虛玩析窗醒妻透购購替塞努休虎扬揚途侵刑绿綠兄迅套贸貿毕畢唯谷轮輪库庫迹跡尤竞競街促延震弃棄甲伟偉麻川申缓緩潜潛闪閃售灯燈针針哲络絡抵朱埃抱鼓植纯純夏忍页頁杰筑築折郑鄭贝貝尊吴吳秀混臣雅振染盛怒舞圆圓搞狂措姓残殘秋培迷诚誠宽寬宇猛摆擺梅毁毀伸摩盟末乃悲拍丁赵趙岩".split(""));

// ------------------------------------------------------------------ language and script

const HANS = "们这说个为来时会过还没对后么里国们发与东车长门问间见关业话应开从实当气让认动现给经学样书钱头电读写边听觉觉进远选专贝阳热简讯网页处难万儿号";
const HANT = "們這說個為來時會過還沒對後麼裡國們發與東車長門問間見關業話應開從實當氣讓認動現給經學樣書錢頭電讀寫邊聽覺覺進遠選專貝陽熱簡訊網頁處難萬兒號";

export type SubLanguage = "zh-bilingual" | "zh-Hans" | "zh-Hant" | "zh-mixed" | "en" | "fr" | "ru" | "ja" | "und";

// Frequent short words that tell English from French in dialogue (accents alone are not enough).
const EN_WORDS = new Set("the you and is it to of what that this are was have not don't i'm we he she they my your with for on just know".split(" "));
const FR_WORDS = new Set("le la les des est et je tu vous pas que qui une un ne il elle nous on mais c'est ça pour dans avec mon ton sur".split(" "));

/** Tell 简体 from 繁體 from bilingual by reading the content, not the file name (§5.5). */
export function detectLanguage(text: string): { language: SubLanguage; hans: number; hant: number; cjkLines: number; latinLines: number; bilingualLines: number } {
	const lines = dialogueLines(text).slice(0, 3000);
	let hans = 0;
	let hant = 0;
	let cjkLines = 0;
	let latinLines = 0;
	let bilingualLines = 0;
	let kana = 0;
	let cyrillic = 0;
	let en = 0;
	let fr = 0;
	for (const l of lines) {
		const hasCjk = /[一-鿿]/.test(l);
		const hasLatin = /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(l);
		if (/[぀-ヿ]/.test(l)) kana++;
		if (/[А-яЁё]{3,}/.test(l)) cyrillic++;
		for (const w of l.toLowerCase().split(/[^a-zàâçéèêëîïôûùüÿœæ']+/)) {
			if (EN_WORDS.has(w)) en++;
			else if (FR_WORDS.has(w)) fr++;
		}
		if (hasCjk) cjkLines++;
		if (hasLatin) latinLines++;
		if (hasCjk && hasLatin) bilingualLines++;
		for (const ch of l) {
			if (HANS.includes(ch)) hans++;
			else if (HANT.includes(ch)) hant++;
		}
	}
	const n = Math.max(1, lines.length);
	let language: SubLanguage = "und";
	if (kana > n * 0.2) language = "ja";
	else if (cjkLines > n * 0.2) {
		const script = hans > hant * 3 ? "zh-Hans" : hant > hans * 3 ? "zh-Hant" : "zh-mixed";
		// Bilingual: most dialogue events carry both a Chinese and an English line.
		if (bilingualLines > cjkLines * 0.4 || (latinLines > n * 0.3 && cjkLines > n * 0.3 && Math.abs(latinLines - cjkLines) < n * 0.5)) language = "zh-bilingual";
		else language = script as SubLanguage;
		if (language === "zh-bilingual" && hant > hans * 3) language = "zh-bilingual"; // traditional bilingual still reported bilingual; script in hant/hans counts
	} else if (cyrillic > n * 0.3) language = "ru";
	else if (latinLines > n * 0.3) language = fr > en * 1.2 && fr >= 5 ? "fr" : en > fr && en >= 5 ? "en" : fr + en < 5 ? "en" : "und";
	return { language, hans, hant, cjkLines, latinLines, bilingualLines };
}

/** The spoken text of each event: ASS Dialogue text (with \N joins), or SRT/VTT cue text. */
export function dialogueLines(text: string): string[] {
	if (/^\[Script Info\]/im.test(text) || /^Dialogue:/m.test(text)) {
		return text
			.split(/\r?\n/)
			.filter((l) => l.startsWith("Dialogue:"))
			.map((l) => l.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " "))
			.filter((l) => l.trim());
	}
	const out: string[] = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		const ls = block.split(/\r?\n/).filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && l !== "WEBVTT");
		if (ls.length) out.push(ls.join(" ").replace(/<[^>]+>/g, ""));
	}
	return out;
}

/** Time of the last subtitle event in seconds (the rough timing check, §5.5). */
export function lastTimestamp(text: string): number | undefined {
	let max = 0;
	for (const m of text.matchAll(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/g)) {
		max = Math.max(max, Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]));
	}
	for (const m of text.matchAll(/^Dialogue:\s*[^,]*,(\d+):(\d{2}):(\d{2})\.\d+,(\d+):(\d{2}):(\d{2})\.\d+/gm)) {
		max = Math.max(max, Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]));
	}
	return max || undefined;
}

export function timingFits(lastS: number | undefined, videoS: number | undefined): { ok: boolean; why?: string } {
	if (!lastS || !videoS) return { ok: true };
	if (lastS > videoS + 120) return { ok: false, why: `last line at ${fmt(lastS)} but the video is ${fmt(videoS)} long (made for a longer cut?)` };
	if (lastS < videoS * 0.7 && videoS - lastS > 600) return { ok: false, why: `last line at ${fmt(lastS)}, the video runs ${fmt(videoS)} (made for a shorter cut, or incomplete)` };
	return { ok: true };
}

function fmt(s: number): string {
	return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ hardened unpacking

function safeRel(name: string): string | undefined {
	const n = name.replace(/\\/g, "/");
	if (n.startsWith("/") || /^[a-z]:/i.test(n) || n.split("/").some((p) => p === "..")) return undefined;
	if (n.split("/").length > LIMITS.depth + 1) return undefined;
	return n;
}

/** Decode a ZIP entry name: UTF-8 when flagged, else the old Chinese code pages. */
function zipName(raw: Uint8Array, utf8Flag: boolean): string {
	if (utf8Flag) return new TextDecoder().decode(raw);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		return decodeSubtitle(raw).text;
	}
}

/** A small ZIP reader (stored and deflate) so most subtitle archives need no external tool. */
function unzip(buf: Buffer, outDir: string): string[] {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) {
		eocd = i;
		break;
	}
	if (eocd < 0) throw new ReelixError("bad_archive", "not a valid zip file");
	const count = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16);
	if (count > LIMITS.files) throw new ReelixError("archive_limits", `archive has ${count} files (limit ${LIMITS.files})`);
	const out: string[] = [];
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(off) !== 0x02014b50) throw new ReelixError("bad_archive", "corrupt zip directory");
		const flags = buf.readUInt16LE(off + 8);
		const method = buf.readUInt16LE(off + 10);
		const csize = buf.readUInt32LE(off + 20);
		const usize = buf.readUInt32LE(off + 24);
		const nlen = buf.readUInt16LE(off + 28);
		const elen = buf.readUInt16LE(off + 30);
		const clen = buf.readUInt16LE(off + 32);
		const local = buf.readUInt32LE(off + 42);
		const name = zipName(buf.subarray(off + 46, off + 46 + nlen), (flags & 0x800) !== 0);
		off += 46 + nlen + elen + clen;
		if (name.endsWith("/")) continue;
		if (flags & 1) throw new ReelixError("encrypted_archive", "the archive is password-protected");
		const rel = safeRel(name);
		if (!rel) continue; // refuse paths escaping the scratch folder
		total += usize;
		if (total > LIMITS.totalBytes) throw new ReelixError("archive_limits", "archive unpacks to more than 200 MB");
		const lnlen = buf.readUInt16LE(local + 26);
		const lelen = buf.readUInt16LE(local + 28);
		const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
		let content: Buffer;
		if (method === 0) content = Buffer.from(data);
		else if (method === 8) content = inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) + 1024 });
		else throw new ReelixError("unsupported_archive", `zip compression method ${method} is not supported; needs 7-Zip`);
		const dest = resolve(outDir, rel);
		if (!dest.startsWith(resolve(outDir) + sep)) continue;
		mkdirSync(resolve(dest, ".."), { recursive: true });
		writeFileSync(dest, content);
		out.push(dest);
	}
	return out;
}

async function sevenZip(archive: string, outDir: string): Promise<string[]> {
	const bin = findBinary("7zz") ?? findBinary("7z") ?? findBinary("7za");
	if (!bin) throw new ReelixError("missing_tool", "7-Zip is not installed, so RAR/7z subtitle archives cannot be unpacked. Drop in an unpacked file instead.");
	// List first and check limits before extracting anything.
	const { stdout } = await run(bin, ["l", "-slt", "-p-", archive], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
	const entries = stdout.split(/\n\n/).map((b) => ({ path: /^Path = (.*)$/m.exec(b)?.[1], size: Number(/^Size = (\d+)$/m.exec(b)?.[1] ?? 0), folder: /^Folder = \+$/m.test(b) })).filter((e) => e.path && !e.folder);
	const files = entries.slice(1); // first block describes the archive itself
	if (files.length > LIMITS.files) throw new ReelixError("archive_limits", `archive has ${files.length} files`);
	if (files.reduce((a, f) => a + f.size, 0) > LIMITS.totalBytes) throw new ReelixError("archive_limits", "archive unpacks to more than 200 MB");
	if (files.some((f) => !safeRel(f.path!))) throw new ReelixError("archive_unsafe", "archive contains paths that escape the folder");
	await run(bin, ["x", "-y", "-p-", "-snl-", `-o${outDir}`, archive], { timeout: 120_000 });
	return walk(outDir);
}

function walk(dir: string, depth = 0): string[] {
	if (depth > LIMITS.depth + 1) return [];
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, depth + 1));
		else if (e.isFile()) out.push(p);
	}
	return out;
}

/** Unpack an archive (zip, rar, 7z) into a fresh scratch folder, nested once. Plain subtitle files pass through. */
export async function unpackSubtitles(file: string, scratch: string, depth = 0): Promise<string[]> {
	mkdirSync(scratch, { recursive: true });
	const buf = readFileSync(file);
	const head = buf.subarray(0, 8);
	let files: string[];
	if (head[0] === 0x50 && head[1] === 0x4b) files = unzip(buf, scratch);
	else if (head.toString("latin1", 0, 4) === "Rar!" || (head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc)) files = await sevenZip(file, scratch);
	else return SUB_FILE.test(file) || looksLikeSubtitle(buf) ? [file] : [];
	const out: string[] = [];
	for (const f of files) {
		if (SUB_FILE.test(f)) out.push(f);
		else if (depth < 1 && /\.(zip|rar|7z)$/i.test(f)) out.push(...(await unpackSubtitles(f, join(scratch, `n${out.length}`), depth + 1)));
	}
	return out.filter((f) => statSync(f).size < 20 * 1024 * 1024);
}

function looksLikeSubtitle(buf: Buffer): boolean {
	const t = buf.subarray(0, 4000).toString("latin1");
	return /-->/.test(t) || /\[Script Info\]/i.test(t);
}
