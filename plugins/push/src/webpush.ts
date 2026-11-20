import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

/* Standard Web Push: each message encrypted for one device (RFC 8291), signed with Reelix's own key (RFC 8292). */

const RECORD_SIZE = 4096;
export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const unb64 = (s: string) => Buffer.from(s, "base64url");

export type VapidKey = { publicKey: string; jwk: Record<string, string> };

export function newVapidPrivateKey(): string {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return b64(ecdh.getPrivateKey());
}

export function vapidKey(privateKey: string): VapidKey {
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(unb64(privateKey));
	const pub = ecdh.getPublicKey();
	return { publicKey: b64(pub), jwk: { kty: "EC", crv: "P-256", d: b64(ecdh.getPrivateKey()), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) } };
}

/** The Authorization header for one push service. */
export function vapidAuthorization(key: VapidKey, endpoint: string, origin: string, nowS = Math.floor(Date.now() / 1000)): string {
	// Apple refuses a token without a real contact: the owner's own https address, never their e-mail.
	const sub = origin.startsWith("https://") ? origin : "https://reelix.invalid";
	const part = (o: unknown) => b64(Buffer.from(JSON.stringify(o)));
	const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: nowS + 12 * 3600, sub })}`;
	const sig = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey({ key: key.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
	return `vapid t=${unsigned}.${b64(sig)}, k=${key.publicKey}`;
}

/** RFC 8291 / RFC 8188 (aes128gcm): only the device can read the message. */
export function encryptPush(plaintext: Uint8Array, p256dh: string, auth: string): Uint8Array {
	const ua = unb64(p256dh);
	const ecdh = createECDH("prime256v1");
	const as = ecdh.generateKeys();
	const shared = ecdh.computeSecret(ua);
	const salt = randomBytes(16);
	const hkdf = (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => Buffer.from(hkdfSync("sha256", ikm, s, info, n));
	const ikm = hkdf(unb64(auth), shared, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const c = createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([c.update(plaintext), c.update(Buffer.from([2])), c.final(), c.getAuthTag()]);
	const rs = Buffer.alloc(4);
	rs.writeUInt32BE(RECORD_SIZE);
	return Buffer.concat([salt, rs, Buffer.from([as.length]), as, body]);
}

/** Whether a browser's keys can be used at all. */
export function validKeys(p256dh: string, auth: string): boolean {
	if (unb64(auth).length !== 16) return false;
	try {
		const check = createECDH("prime256v1");
		check.generateKeys();
		check.computeSecret(unb64(p256dh));
		return true;
	} catch {
		return false;
	}
}

/** Only the browser makers' push services: signing up must not make Reelix call other addresses. */
export function isPushEndpoint(endpoint: string): boolean {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
	const h = u.hostname.toLowerCase();
	return h === "web.push.apple.com" || h === "fcm.googleapis.com" || h === "push.services.mozilla.com" || h.endsWith(".push.services.mozilla.com") || h.endsWith(".notify.windows.com");
}
