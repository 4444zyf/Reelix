import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Reelix } from "@reelix/core";

/** Single-user login (§7.3): scrypt password hash, HMAC-signed HttpOnly SameSite=Strict cookie. */

export function hashPassword(pw: string): string {
	const salt = randomBytes(16);
	const h = scryptSync(pw, salt, 32);
	return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | undefined): boolean {
	if (!stored?.startsWith("scrypt$")) return false;
	const [, salt, hash] = stored.split("$");
	const h = scryptSync(pw, Buffer.from(salt!, "base64"), 32);
	const want = Buffer.from(hash!, "base64");
	return want.length === h.length && timingSafeEqual(h, want);
}

function sessionSecret(app: Reelix): string {
	let s = app.secrets["web.session_secret"];
	if (!s) {
		s = randomBytes(32).toString("base64url");
		app.setSecret("web.session_secret", s);
	}
	return s;
}

export const COOKIE = "reelix_session";
const MAX_AGE_S = 30 * 86400;

export function makeSessionCookie(app: Reelix, secure: boolean): string {
	const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
	// Signing with the password hash too means changing the password logs every session out.
	const body = `v1.${exp}`;
	const sig = createHmac("sha256", sessionSecret(app) + (app.secrets["web.password_hash"] ?? "")).update(body).digest("base64url");
	return `${COOKIE}=${body}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
	return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function validSession(app: Reelix, cookieHeader: string | undefined): boolean {
	if (!cookieHeader || !app.secrets["web.password_hash"]) return false;
	const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader);
	if (!m) return false;
	const parts = m[1]!.split(".");
	if (parts.length !== 3) return false;
	const [v, exp, sig] = parts as [string, string, string];
	if (Number(exp) < Date.now() / 1000) return false;
	const want = createHmac("sha256", sessionSecret(app) + app.secrets["web.password_hash"]).update(`${v}.${exp}`).digest("base64url");
	return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

/** Login attempts are rate-limited per address. */
const attempts = new Map<string, { n: number; until: number }>();
export function loginAllowed(ip: string): boolean {
	const a = attempts.get(ip);
	return !a || a.until < Date.now() || a.n < 5;
}
export function loginFailed(ip: string): void {
	const a = attempts.get(ip);
	if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
	else a.n++;
}
export function loginSucceeded(ip: string): void {
	attempts.delete(ip);
}
