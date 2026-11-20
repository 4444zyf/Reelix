import { crc32, deflateRawSync } from "node:zlib";

/** Minimal zip writer (deflate), names in GBK unless utf8 is set — like old Chinese archives. */
export function makeZip(entries: { name: string; data: Buffer; gbkName?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = e.gbkName ? encodeGbk(e.name) : Buffer.from(e.name, "utf8");
		const comp = deflateRawSync(e.data);
		const crc = crc32(e.data);
		const flags = e.gbkName ? 0 : 0x800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(comp.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, comp);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt16LE(flags, 8);
		c.writeUInt16LE(8, 10);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(comp.length, 20);
		c.writeUInt32LE(e.data.length, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(offset, 42);
		centrals.push(c, name);
		offset += 30 + name.length + comp.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

// A tiny GBK encoder for the handful of characters used in the tests.
const GBK: Record<string, number[]> = { 简: [0xbc, 0xf2], 体: [0xcc, 0xe5], 繁: [0xb7, 0xb1], 中: [0xd6, 0xd0], 文: [0xce, 0xc4], 们: [0xc3, 0xc7], 这: [0xd5, 0xe2], 说: [0xcb, 0xb5], 个: [0xb8, 0xf6], 来: [0xc0, 0xb4], 时: [0xca, 0xb1], 我: [0xce, 0xd2], 的: [0xb5, 0xc4], 你: [0xc4, 0xe3], 是: [0xca, 0xc7], 好: [0xba, 0xc3], 了: [0xc1, 0xcb], 完: [0xcd, 0xea] };
export function encodeGbk(s: string): Buffer {
	const out: number[] = [];
	for (const ch of s) {
		if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0));
		else if (GBK[ch]) out.push(...GBK[ch]!);
		else throw new Error(`no gbk for ${ch}`);
	}
	return Buffer.from(out);
}
