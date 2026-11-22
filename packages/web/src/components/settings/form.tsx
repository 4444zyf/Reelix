import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, FolderOpen, Plus, Trash2, Undo2 } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { op, runOp } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Badge } from "../common/Badge";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FolderPicker } from "./FolderPicker";

/*
 * The pieces every Settings form is made of (docs/settings.md, "Forms and saving"): one form per section or card,
 * one Save at its end with Discard beside it, secrets as fields of the same form, and the search over the page.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------- search and filter over the page

export type SettingsView = { query: string; attention: boolean; technical: boolean };
const ViewContext = createContext<SettingsView>({ query: "", attention: false, technical: false });
/** Set by a section or card whose own title matches the search: everything inside it shows. */
const MatchedContext = createContext(false);
export const SettingsViewProvider = ViewContext.Provider;
export const useSettingsView = () => useContext(ViewContext);

const fold = (s: string) => s.toLocaleLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
	const q = fold(query.trim());
	return !q || q.split(/\s+/).every((w) => texts.some((t) => t && fold(t).includes(w)));
}

/**
 * Something the search and the "needs attention" filter can hide: a field, a card. `text` is what it is found by
 * (its label, help, name); `attention`: it needs the owner. Hidden things stay mounted, so drafts survive a search.
 */
export function Searchable({ text, attention, children, className }: { text: (string | undefined)[]; attention?: boolean; children: ReactNode; className?: string }) {
	const view = useSettingsView();
	const inMatched = useContext(MatchedContext);
	const own = matchesQuery(view.query, ...text);
	const hidden = (!inMatched && !own) || (view.attention && !attention);
	return (
		<div data-searchable="" hidden={hidden} className={className}>
			{/* A card found by its own name shows all it holds. */}
			<MatchedContext.Provider value={inMatched || (!!view.query.trim() && own)}>{children}</MatchedContext.Provider>
		</div>
	);
}

/** A section of the page: hidden while the search or filter leaves nothing in it. */
export function Section({ id, icon, title, description, children, keywords = [] }: { id: string; icon: ReactNode; title: string; description?: string; children: ReactNode; keywords?: string[] }) {
	const view = useSettingsView();
	const ref = useRef<HTMLElement>(null);
	const titleMatches = !!view.query.trim() && matchesQuery(view.query, title, description, ...keywords);
	const [empty, setEmpty] = useState(false);
	const filtering = !!view.query.trim() || view.attention;
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !filtering) return setEmpty(false);
		// Whether anything inside is shown, not counting the section's own `hidden` (it may be hidden from the last search).
		const check = () => setEmpty(![...el.querySelectorAll<HTMLElement>("[data-searchable]")].some((x) => !x.hidden && (x.parentElement?.closest("[hidden]") ?? el) === el));
		check();
		const watch = new MutationObserver(check);
		watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
		return () => watch.disconnect();
	}, [filtering, view.query, view.attention]);
	const hidden = filtering && empty && !(titleMatches && !view.attention);
	return (
		<section id={id} ref={ref} hidden={hidden} className="surface-card scroll-mt-40 rounded-xl p-4 md:p-6">
			<div className="mb-4 flex items-start gap-3">
				<span className="mt-0.5 text-primary [&_svg]:h-5 [&_svg]:w-5">{icon}</span>
				<div className="min-w-0">
					<h2 className="font-semibold">{title}</h2>
					{description && <p className="text-sm text-muted-foreground">{description}</p>}
				</div>
			</div>
			<MatchedContext.Provider value={titleMatches && !view.attention}>
				<div className="space-y-4">{children}</div>
			</MatchedContext.Provider>
		</section>
	);
}

/** A config key or other technical name, shown only with "Technical details" on, with a copy button. */
export function Technical({ children }: { children: string }) {
	const { t } = useTranslation("settings");
	if (!useSettingsView().technical) return null;
	return (
		<span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
			<span className="break-all">{children}</span>
			<button type="button" aria-label={t("form.copy")} title={t("form.copy")} className="shrink-0 rounded p-0.5 hover:bg-accent" onClick={() => void navigator.clipboard?.writeText(children)}>
				<Copy className="size-3" />
			</button>
		</span>
	);
}

/** One field: its label (with a badge that wraps under it, never clipped), the control, help and error. */
export function Row({ label, badge, help, error, htmlFor, technical, search = [], attention, children }: { label: ReactNode; badge?: ReactNode; help?: ReactNode; error?: string; htmlFor?: string; technical?: string; search?: (string | undefined)[]; attention?: boolean; children: ReactNode }) {
	return (
		<Searchable text={[typeof label === "string" ? label : undefined, typeof help === "string" ? help : undefined, technical, ...search]} attention={attention}>
			{/* `field-<setting>`: where Doctor's actions and links land. */}
			<div id={technical ? `field-${technical}` : undefined} className="scroll-mt-40 grid gap-1.5 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)] md:gap-4">
				<div className="min-w-0">
					<label htmlFor={htmlFor} className="text-sm font-medium">
						{label}
					</label>
					{badge && <div className="mt-1 flex flex-wrap gap-1">{badge}</div>}
					{technical && <Technical>{technical}</Technical>}
				</div>
				<div className="min-w-0">
					{children}
					{help && <div className="mt-1 text-xs text-muted-foreground">{help}</div>}
					{error && <p className="mt-1 text-xs text-destructive-foreground">{error}</p>}
				</div>
			</div>
		</Searchable>
	);
}

/** A collapsed part of a form or card: Advanced, Technical details. */
export function Disclosure({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
	return (
		<details className="group rounded-md border border-border px-3 py-2" open={open}>
			<summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground group-open:mb-3">{title}</summary>
			<div className="space-y-4">{children}</div>
		</details>
	);
}

/** The end of every form: what is unsaved, Discard and Save, right-aligned. Both wait until something changed. */
export function SaveBar({ dirty, busy, onSave, onDiscard, error, label }: { dirty: boolean; busy: boolean; onSave: () => void; onDiscard: () => void; error?: string; label?: string }) {
	const { t } = useTranslation(["settings", "common"]);
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
				{dirty && <span className="mr-auto text-xs text-warning">{t("form.unsaved")}</span>}
				<Button type="button" variant="ghost" disabled={!dirty || busy} onClick={onDiscard}>
					<Undo2 /> {t("form.discard")}
				</Button>
				<Button type="submit" disabled={!dirty || busy} onClick={(e) => (e.preventDefault(), onSave())}>
					{busy && <Spinner />}
					{label ?? t("common:actions.save")}
				</Button>
			</div>
			{error && <p className="text-right text-xs text-destructive-foreground">{error}</p>}
		</div>
	);
}

// ---------------------------------------------------------------- a section's settings from config.yaml

/**
 * The draft of some settings of config.yaml, saved together with config.set (each path validated and recorded by
 * the server). `errors` is per path; `prepare` turns a path's draft into what is saved.
 */
export function useConfigDraft(config: Record<string, unknown>, paths: string[], prepare: Record<string, (v: unknown) => unknown> = {}) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const saved = Object.fromEntries(paths.map((p) => [p, getPath(config, p)]));
	const [draft, setDraft] = useState<Record<string, unknown>>(saved);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const key = JSON.stringify(saved);
	useEffect(() => setDraft(JSON.parse(key)), [key]);
	const changed = paths.filter((p) => !same(draft[p], saved[p]));
	return {
		get: (p: string) => draft[p],
		set: (p: string, v: unknown) => setDraft((d) => ({ ...d, [p]: v })),
		dirty: changed.length > 0,
		busy,
		errors,
		discard: () => (setDraft(JSON.parse(key)), setErrors({})),
		async save() {
			setBusy(true);
			const failed: Record<string, string> = {};
			for (const p of changed) {
				try {
					const v = prepare[p] ? prepare[p](draft[p]) : draft[p];
					await runOp("config.set", { path: p, value: v === undefined || v === "" ? null : v });
				} catch (e) {
					failed[p] = message(e);
				}
			}
			setErrors(failed);
			setBusy(false);
			if (!Object.keys(failed).length) toast({ title: t("field.saved") });
			await qc.invalidateQueries({ queryKey: ["config"] });
			qc.invalidateQueries({ queryKey: ["status"] });
		},
	};
}
export type ConfigDraft = ReturnType<typeof useConfigDraft>;

export function getPath(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// ---------------------------------------------------------------- secrets

/**
 * A secret as a field of its form. `value`: undefined, unchanged; a string, the new value; null, remove it on save.
 * A stored one shows masked with "Saved" and Replace; Remove is under its menu.
 */
export function SecretInput({ id, set, value, onChange, required }: { id: string; set: boolean; value: string | null | undefined; onChange: (v: string | null | undefined) => void; required?: boolean }) {
	const { t } = useTranslation("settings");
	if (value === null)
		return (
			<div className="flex min-h-10 items-center gap-2 rounded-md border border-dashed border-input px-3 text-sm text-muted-foreground">
				<span className="flex-1">{t("form.secretRemoved")}</span>
				<Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
					{t("form.undo")}
				</Button>
			</div>
		);
	if (set && value === undefined)
		return (
			<div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
				<span className="tracking-widest text-muted-foreground">••••••••</span>
				<Badge tone="success">{t("form.secretSaved")}</Badge>
				<span className="ml-auto flex gap-1">
					<Button type="button" variant="ghost" size="sm" onClick={() => onChange("")}>
						{t("form.replace")}
					</Button>
					<Button type="button" variant="ghost" size="sm" className="text-destructive-foreground" onClick={() => onChange(null)}>
						<Trash2 /> {t("form.remove")}
					</Button>
				</span>
			</div>
		);
	return (
		<div className="flex gap-2">
			<Input id={id} type="password" autoComplete="new-password" value={value ?? ""} onChange={(e) => onChange(e.target.value || (set ? "" : undefined))} placeholder={set ? t("form.secretNew") : required ? t("form.secretNeeded") : t("form.secretOptional")} />
			{set && (
				<Button type="button" variant="ghost" className="shrink-0" onClick={() => onChange(undefined)}>
					{t("form.cancel")}
				</Button>
			)}
		</div>
	);
}

/** The badge beside a secret's label. */
export function SecretBadge({ set, required }: { set: boolean; required?: boolean }) {
	const { t } = useTranslation("settings");
	if (set) return null;
	return required ? <Badge tone="warning">{t("form.needed")}</Badge> : <Badge tone="muted">{t("form.optional")}</Badge>;
}

// ---------------------------------------------------------------- editors

export type ListItem = { id: string; label: string; note?: string; warn?: boolean };

/**
 * An ordered choice among named items (subtitle sites, languages, players, models): the chosen ones in order, with
 * up, down and a switch; the others below. Items the value names but `items` lacks are kept and marked.
 */
export function OrderedPicker({ items, value, onChange, unknownNote, id }: { items: ListItem[]; value: string[]; onChange: (v: string[]) => void; unknownNote?: string; id?: string }) {
	const { t } = useTranslation("settings");
	const byId = new Map(items.map((i) => [i.id, i]));
	const chosen = value.map((v) => byId.get(v) ?? { id: v, label: v, note: unknownNote, warn: true });
	const rest = items.filter((i) => !value.includes(i.id));
	const move = (i: number, by: number) => {
		const c = [...value];
		[c[i], c[i + by]] = [c[i + by]!, c[i]!];
		onChange(c);
	};
	return (
		<ul id={id} className="divide-y divide-border rounded-md border border-input">
			{chosen.map((item, i) => (
				<li key={item.id} className="flex items-center gap-2 px-2 py-1.5">
					<input type="checkbox" checked aria-label={item.label} onChange={() => onChange(value.filter((v) => v !== item.id))} />
					<span className="w-5 text-right text-xs text-muted-foreground">{i + 1}.</span>
					<span className="min-w-0 flex-1 text-sm">
						{item.label}
						{item.note && <span className={cn("block text-xs", item.warn ? "text-warning" : "text-muted-foreground")}>{item.note}</span>}
					</span>
					<Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("form.moveUp", { name: item.label })} disabled={i === 0} onClick={() => move(i, -1)}>
						<ArrowUp />
					</Button>
					<Button type="button" variant="ghost" size="icon" className="h-7 w-7" aria-label={t("form.moveDown", { name: item.label })} disabled={i === chosen.length - 1} onClick={() => move(i, 1)}>
						<ArrowDown />
					</Button>
				</li>
			))}
			{rest.map((item) => (
				<li key={item.id} className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground">
					<input type="checkbox" checked={false} aria-label={item.label} onChange={() => onChange([...value, item.id])} />
					<span className="w-5" />
					<span className="min-w-0 flex-1 text-sm">
						{item.label}
						{item.note && <span className={cn("block text-xs", item.warn && "text-warning")}>{item.note}</span>}
					</span>
				</li>
			))}
			{!chosen.length && !rest.length && <li className="px-3 py-2 text-sm text-muted-foreground">{t("form.nothingToChoose")}</li>}
		</ul>
	);
}

export type PathMap = { theirs: string; ours: string }[];

/** How a service names the same folders (`path_maps`), as rows: its path, and the folder as Reelix sees it. */
export function PathMapEditor({ service, value, onChange, example }: { service: string; value: PathMap; onChange: (v: PathMap) => void; example: { theirs: string; ours: string } }) {
	const { t } = useTranslation("settings");
	const [picking, setPicking] = useState<number>();
	const rows = value.length ? value : [];
	const edit = (i: number, k: "theirs" | "ours", v: string) => onChange(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
	return (
		<div className="space-y-2">
			<div className="hidden grid-cols-[1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground sm:grid">
				<span>{t("pathMap.theirs", { service })}</span>
				<span>{t("pathMap.ours")}</span>
				<span className="w-9" />
			</div>
			{rows.map((r, i) => (
				<div key={i} className="space-y-1">
					<div className="grid items-center gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_auto] sm:border-0 sm:p-0">
						<span className="text-xs text-muted-foreground sm:hidden">{t("pathMap.theirs", { service })}</span>
						<Input value={r.theirs} placeholder={example.theirs} aria-label={t("pathMap.theirs", { service })} onChange={(e) => edit(i, "theirs", e.target.value)} />
						<span className="text-xs text-muted-foreground sm:hidden">{t("pathMap.ours")}</span>
						<div className="flex gap-1">
							<Input value={r.ours} placeholder={example.ours} aria-label={t("pathMap.ours")} onChange={(e) => edit(i, "ours", e.target.value)} />
							<Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label={t("folderPicker.browse")} onClick={() => setPicking(i)}>
								<FolderOpen />
							</Button>
						</div>
						<Button type="button" variant="ghost" size="icon" className="justify-self-end" aria-label={t("pathMap.remove")} onClick={() => onChange(rows.filter((_, n) => n !== i))}>
							<Trash2 />
						</Button>
					</div>
					<FolderCheck path={r.ours} />
				</div>
			))}
			{!rows.length && <p className="text-xs text-muted-foreground">{t("pathMap.none", { service, theirs: example.theirs, ours: example.ours })}</p>}
			<Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { theirs: "", ours: "" }])}>
				<Plus /> {t("pathMap.add")}
			</Button>
			<FolderPicker open={picking !== undefined} onOpenChange={(o) => !o && setPicking(undefined)} start={picking !== undefined ? rows[picking]?.ours : undefined} level="downloads" onChoose={(p) => picking !== undefined && edit(picking, "ours", p)} />
		</div>
	);
}

type Listing = { path: string; folders: { name: string; path: string }[] };

/** Whether a folder Reelix should see exists, and if not, one that differs only in letter case. */
export function FolderCheck({ path }: { path: string }) {
	const { t } = useTranslation("settings");
	const [state, setState] = useState<{ kind: "ok" | "missing" | "case" | "outside"; hint?: string }>();
	useEffect(() => {
		const p = path.trim().replace(/\/+$/, "");
		if (!p.startsWith("/")) return setState(undefined);
		let live = true;
		const timer = setTimeout(async () => {
			const parent = p.split("/").slice(0, -1).join("/") || "/";
			const name = p.split("/").pop() ?? "";
			try {
				const here = await op<Listing>("media.folders", { path: p }).catch(() => undefined);
				if (here) return live && setState({ kind: "ok" });
				const up = await op<Listing>("media.folders", { path: parent });
				const near = up.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
				if (live) setState(near ? { kind: "case", hint: near.path } : { kind: "missing" });
			} catch {
				if (live) setState({ kind: "outside" });
			}
		}, 400);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [path]);
	if (!state || state.kind === "ok") return null;
	return <p className="text-xs text-warning">{t(`pathMap.check.${state.kind}`, { path: state.hint })}</p>;
}
