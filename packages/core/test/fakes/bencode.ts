/** Minimal bencode encoder and .torrent builder for tests. */

export function benc(v: unknown): Buffer {
	if (typeof v === "number") return Buffer.from(`i${v}e`);
	if (typeof v === "string" || Buffer.isBuffer(v)) {
		const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
		return Buffer.concat([Buffer.from(`${b.length}:`), b]);
	}
	if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(benc), Buffer.from("e")]);
	const o = v as Record<string, unknown>;
	return Buffer.concat([Buffer.from("d"), ...Object.keys(o).sort().flatMap((k) => [benc(k), benc(o[k])]), Buffer.from("e")]);
}

/** A multi-file .torrent (each file's path is split into parts). */
export function makeTorrent(name: string, files: { path: string[]; length: number }[]): Buffer {
	return benc({ announce: "http://t/a", info: { name, "piece length": 16384, pieces: Buffer.alloc(20), files } });
}

/** A single-file .torrent. */
export function makeSingleFileTorrent(name: string, length: number): Buffer {
	return benc({ announce: "http://t/a", info: { name, "piece length": 16384, pieces: Buffer.alloc(20), length } });
}
