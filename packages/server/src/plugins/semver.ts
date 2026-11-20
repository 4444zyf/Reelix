/**
 * The part of npm's version ranges a manifest's `engines.reelix` uses (docs/plugins.md §13.4): exact
 * versions, `x` and `*`, comparators (`>=0.4 <1`), `^`, `~`, and `||`. Anything else is not understood
 * and counts as not satisfied, so a plugin is never loaded on a guess.
 */

type Version = [number, number, number, string];

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(text: string): Version | undefined {
	const m = VERSION.exec(text.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : undefined;
}

function comparePre(a: string, b: string): number {
	if (a === b) return 0;
	if (!a) return 1; // a release is above its pre-releases
	if (!b) return -1;
	const x = a.split(".");
	const y = b.split(".");
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if (x[i] === undefined) return -1;
		if (y[i] === undefined) return 1;
		const nx = /^\d+$/.test(x[i]!) ? Number(x[i]) : undefined;
		const ny = /^\d+$/.test(y[i]!) ? Number(y[i]) : undefined;
		if (nx !== undefined && ny !== undefined) {
			if (nx !== ny) return nx < ny ? -1 : 1;
		} else if (nx !== undefined) return -1;
		else if (ny !== undefined) return 1;
		else if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
	}
	return 0;
}

export function compareVersions(a: Version, b: Version): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
	return comparePre(a[3], b[3]);
}

type Comparator = { op: "<" | "<=" | ">" | ">=" | "="; v: Version };

/** One partial version (`1`, `1.2`, `1.x`) with its operator, as plain comparators. */
function expand(op: string, text: string): Comparator[] | undefined {
	const m = PARTIAL.exec(text);
	if (!m) return undefined;
	const wild = (s: string | undefined) => s === undefined || /^[xX*]$/.test(s);
	const major = wild(m[1]) ? undefined : Number(m[1]);
	const minor = major === undefined || wild(m[2]) ? undefined : Number(m[2]);
	const patch = minor === undefined || wild(m[3]) ? undefined : Number(m[3]);
	const pre = patch === undefined ? "" : (m[4] ?? "");
	const v = (a: number, b: number, c: number, p = ""): Version => [a, b, c, p];
	if (major === undefined) return op === "<" || op === ">" ? [{ op: "<", v: v(0, 0, 0, "0") }] : [];
	const low = v(major, minor ?? 0, patch ?? 0, pre);
	// The first version above the partial one: 1.2 -> 1.3.0, 1 -> 2.0.0.
	const above = patch !== undefined ? undefined : minor !== undefined ? v(major, minor + 1, 0, "0") : v(major + 1, 0, 0, "0");
	switch (op) {
		case "^": {
			const top = major > 0 || minor === undefined ? v(major + 1, 0, 0, "0") : minor > 0 || patch === undefined ? v(0, minor + 1, 0, "0") : v(0, 0, patch + 1, "0");
			return [{ op: ">=", v: low }, { op: "<", v: top }];
		}
		case "~":
			return [{ op: ">=", v: low }, { op: "<", v: minor === undefined ? v(major + 1, 0, 0, "0") : v(major, minor + 1, 0, "0") }];
		case "":
		case "=":
			return above ? [{ op: ">=", v: low }, { op: "<", v: above }] : [{ op: "=", v: low }];
		case ">=":
			return [{ op: ">=", v: low }];
		case "<":
			return [{ op: "<", v: above ? v(low[0], low[1], low[2], "0") : low }];
		case ">":
			return above ? [{ op: ">=", v: above }] : [{ op: ">", v: low }];
		case "<=":
			return above ? [{ op: "<", v: above }] : [{ op: "<=", v: low }];
	}
	return undefined;
}

function test(c: Comparator, v: Version): boolean {
	const d = compareVersions(v, c.v);
	return c.op === "=" ? d === 0 : c.op === "<" ? d < 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : d >= 0;
}

/** Each `||` part of a range as comparators; undefined for a part that is not understood. */
function comparatorSets(range: string): (Comparator[] | undefined)[] {
	return range.split("||").map((set) => {
		const words = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
		const comparators: Comparator[] = [];
		for (const w of words.length ? words : ["*"]) {
			const m = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(w)!;
			const got = expand(m[1] ?? "", m[2]!);
			if (!got) return undefined;
			comparators.push(...got);
		}
		return comparators;
	});
}

/** Whether every part of a range is understood (a manifest's `requires.plugins`). */
export const understoodRange = (range: string): boolean => comparatorSets(range).every((c) => c !== undefined);

/** Whether `version` is in `range`. A pre-release is only in a range that names a pre-release of the same version. */
export function satisfies(version: string, range: string): boolean {
	const v = parseVersion(version);
	if (!v) return false;
	for (const comparators of comparatorSets(range)) {
		if (!comparators || !comparators.every((c) => test(c, v))) continue;
		if (v[3] && !comparators.some((c) => c.v[3] && c.v[3] !== "0" && c.v[0] === v[0] && c.v[1] === v[1] && c.v[2] === v[2])) continue;
		return true;
	}
	return false;
}
