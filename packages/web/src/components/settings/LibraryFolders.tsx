import { ArrowDown, ArrowUp, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AskAbout } from "../common/AskAbout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FolderChecks } from "./Doctor";
import { FolderPicker } from "./FolderPicker";
import { Row } from "./form";

const FACTS = ["original_language", "origin_country", "genre"] as const;
type When = Partial<Record<(typeof FACTS)[number], string[]>>;
export type Folder = { path: string; name?: string; default?: boolean; rules?: { when: When; note?: string }[] };
type Kind = "movies" | "shows" | "anime";

const words = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Empty names and rules that name nothing are left out, so the saved list stays readable. */
export function tidyFolders(list: Folder[]): Folder[] {
	return list.map((f) => {
		const rules = (f.rules ?? []).map((r) => ({ ...r, when: Object.fromEntries(Object.entries(r.when).filter(([, v]) => v?.length)) })).filter((r) => Object.keys(r.when).length);
		return { path: f.path, ...(f.name?.trim() ? { name: f.name.trim() } : {}), ...(f.default ? { default: true } : {}), ...(rules.length ? { rules } : {}) };
	});
}

/**
 * One media type's library folders: path, name, default and rules (docs/library-folders.md), as part of the
 * Folders form. `learn`: the saved list has several folders, so the assistant can learn their rules. `saved`: the
 * folders already saved, which get their checks (exists, writable, hard link, seen by the media server).
 */
export function LibraryFolders({ kind, label, value, onChange, showsFolders, learn, error, saved }: { kind: Kind; label: string; value: Folder[]; onChange: (v: Folder[]) => void; showsFolders: number; learn: boolean; error?: string; saved: string[] }) {
	const { t } = useTranslation(["settings", "common"]);
	const [picking, setPicking] = useState<number | "new" | undefined>();
	const list = value;
	const setList = (f: (l: Folder[]) => Folder[]) => onChange(f(list));
	const edit = (i: number, f: (x: Folder) => Folder) => setList((l) => l.map((x, n) => (n === i ? f(x) : x)));
	const move = (i: number, by: number) => setList((l) => { const c = [...l]; [c[i], c[i + by]] = [c[i + by]!, c[i]!]; return c; });
	const several = list.length > 1;

	return (
		<Row label={label} technical={`library.${kind}`} error={error} help={several ? t("libraryFolders.help") : undefined} search={list.map((f) => f.name ?? f.path)}>
			<div className="space-y-2">
				{!list.length && <p className="text-xs text-muted-foreground">{kind === "anime" && showsFolders ? t("libraryFolders.animeUsesShows") : t("libraryFolders.none")}</p>}
				{list.map((f, i) => (
					<div key={i} className="space-y-2 rounded-lg border border-input p-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
							<p className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</p>
							<div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
								<Button type="button" variant="ghost" size="icon" aria-label={t("libraryFolders.change")} onClick={() => setPicking(i)}><FolderOpen /></Button>
								{several && <Button type="button" variant="ghost" size="icon" aria-label={t("libraryFolders.up")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>}
								{several && <Button type="button" variant="ghost" size="icon" aria-label={t("libraryFolders.down")} disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>}
								<Button type="button" variant="ghost" size="icon" aria-label={t("libraryFolders.remove")} onClick={() => setList((l) => l.filter((_, n) => n !== i))}><Trash2 /></Button>
							</div>
						</div>
						{saved.includes(f.path) && <FolderChecks path={f.path} />}
						{several && (
							<>
								<div className="flex flex-wrap items-center gap-3">
									<label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
										<span className="shrink-0">{t("libraryFolders.name")}</span>
										<Input value={f.name ?? ""} placeholder={f.path.split("/").pop()} onChange={(e) => edit(i, (x) => ({ ...x, name: e.target.value }))} className="h-8" />
									</label>
									<label className="flex items-center gap-2 text-xs">
										<input type="radio" name={`default-${kind}`} checked={!!f.default} onChange={() => setList((l) => l.map((x, n) => ({ ...x, default: n === i })))} />
										{t("libraryFolders.default")}
									</label>
								</div>
								{(f.rules ?? []).map((r, ri) => (
									<div key={ri} className="space-y-1.5 rounded-md bg-well p-2">
										<div className="grid gap-1.5 sm:grid-cols-3">
											{FACTS.map((k) => (
												<label key={k} className="grid gap-1 text-[11px] text-muted-foreground">
													{t(`libraryFolders.fact.${k}`)}
													<Input
														className="h-8 text-sm text-foreground"
														placeholder={t(`libraryFolders.example.${k}`)}
														defaultValue={(r.when[k] ?? []).join(", ")}
														onChange={(e) => edit(i, (x) => ({ ...x, rules: x.rules!.map((y, m) => (m === ri ? { ...y, when: { ...y.when, [k]: words(e.target.value) } } : y)) }))}
													/>
												</label>
											))}
										</div>
										<div className="flex items-center gap-2">
											<p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{r.note}</p>
											<Button type="button" variant="ghost" size="sm" onClick={() => edit(i, (x) => ({ ...x, rules: x.rules!.filter((_, m) => m !== ri) }))}>
												{t("libraryFolders.removeRule")}
											</Button>
										</div>
									</div>
								))}
								<Button type="button" variant="ghost" size="sm" onClick={() => edit(i, (x) => ({ ...x, rules: [...(x.rules ?? []), { when: {} }] }))}>
									<Plus /> {t("libraryFolders.addRule")}
								</Button>
							</>
						)}
					</div>
				))}
				<Button type="button" variant="outline" size="sm" onClick={() => setPicking("new")}>
					<Plus /> {t("libraryFolders.add")}
				</Button>
				{learn && <AskAbout text={t("libraryFolders.learnPrompt", { type: label })} label={t("libraryFolders.learn")} className="justify-start" />}
				<FolderPicker
					open={picking !== undefined}
					onOpenChange={(o) => !o && setPicking(undefined)}
					start={typeof picking === "number" ? list[picking]?.path : list[0]?.path.split("/").slice(0, -1).join("/")}
					level="library"
					onChoose={(p) => setList((l) => (picking === "new" ? (l.some((x) => x.path === p) ? l : [...l, { path: p }]) : l.map((x, n) => (n === picking ? { ...x, path: p } : x))))}
				/>
			</div>
		</Row>
	);
}
