import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { looksRarPacked, magnetHash, parseTorrent } from "../src/torrent.ts";
import { benc, makeTorrent } from "./fakes/bencode.ts";

test("info hash and file list from a .torrent", () => {
	const t = makeTorrent("Pack", [
		{ path: ["S01E01.mkv"], length: 100 },
		{ path: [".pad", "0"], length: 5 },
		{ path: ["Subs", "a.srt"], length: 3 },
	]);
	const info = parseTorrent(t);
	const infoBytes = benc({ name: "Pack", "piece length": 16384, pieces: Buffer.alloc(20), files: [{ path: ["S01E01.mkv"], length: 100 }, { path: [".pad", "0"], length: 5 }, { path: ["Subs", "a.srt"], length: 3 }] });
	assert.equal(info.infoHash, createHash("sha1").update(infoBytes).digest("hex"));
	assert.deepEqual(info.files.map((f) => f.path), ["Pack/S01E01.mkv", "Pack/Subs/a.srt"]);
	assert.equal(info.totalSize, 103);
});

test("magnet hashes, hex and base32", () => {
	assert.equal(magnetHash("magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=x"), "c12fe1c06bba254a9dc9f519b335aa7c1367a88a");
	assert.equal(magnetHash("magnet:?xt=urn:btih:YEX6BQDLXISUVHOJ6UM3GNNKPQJWPKEK"), "c12fe0c06bba254a9dc9f519b335aa7c1367a88a");
});

test("RAR detection", () => {
	assert.ok(looksRarPacked([{ path: "a/x.rar" }, { path: "a/x.r00" }, { path: "a/sample.mkv" }]));
	assert.ok(!looksRarPacked([{ path: "a/x.mkv" }, { path: "a/subs.rar" }]));
});
