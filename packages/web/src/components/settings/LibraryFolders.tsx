import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, FolderOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { runOp } from "../../lib/api";
import { AskAbout } from "../common/AskAbout";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FolderPicker } from "./FolderPicker";

const FACTS = ["original_language", "origin_country", "genre"] as const;
type When = Partial<Record<(typeof FACTS)[number], string[]>>;
type Folder = { path: string; name?: string; default?: boolean; rules?: { when: When; note?: string }[] };
type Kind = "movies" | "shows" | "anime";

const words = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** One media type's library folders: path, name, default and rules (docs/library-folders.md). */
export function LibraryFolders({ kind, label, folders, showsFolders }: { kind: Kind; label: string; folders: Folder[]; showsFolders: number }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const [list, setList] = useState<Folder[]>(folders);
	const [picking, setPicking] = useState<number | "new" | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	useEffect(() => setList(folders), [JSON.stringify(folders)]);
	const dirty = JSON.stringify(list) !== JSON.stringify(folders);
	const edit = (i: number, f: (x: Folder) => Folder) => setList((l) => l.map((x, n) => (n === i ? f(x) : x)));
	const move = (i: number, by: number) => setList((l) => { const c = [...l]; [c[i], c[i + by]] = [c[i + by]!, c[i]!]; return c; });

	const save = async () => {
		setBusy(true);
		setError(undefined);
		try {
			// Empty names and rules that name nothing are left out, so the saved list stays readable.
			const value = list.map((f) => {
				const rules = (f.rules ?? []).map((r) => ({ ...r, when: Object.fromEntries(Object.entries(r.when).filter(([, v]) => v?.length)) })).filter((r) => Object.keys(r.when).length);
				return { path: f.path, ...(f.name?.trim() ? { name: f.name.trim() } : {}), ...(f.default ? { default: true } : {}), ...(rules.length ? { rules } : {}) };
			});
			const r = await runOp("config.set", { path: `library.${kind}`, value });
			toast({ title: t("field.saved"), description: r.text });
			await qc.invalidateQueries({ queryKey: ["config"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="grid gap-1.5 md:grid-cols-[220px_1fr] md:gap-4">
			<div className="text-sm font-medium">{label}</div>
			<div className="min-w-0 space-y-2">
				{!list.length && <p className="text-xs text-muted-foreground">{kind === "anime" && showsFolders ? t("libraryFolders.animeUsesShows") : t("libraryFolders.none")}</p>}
				{list.map((f, i) => (
					<div key={i} className="space-y-2 rounded-lg border border-input p-3">
						<div className="flex items-center gap-2">
							<p className="min-w-0 flex-1 break-all font-mono text-xs">{f.path}</p>
							<Button variant="ghost" size="icon" aria-label={t("libraryFolders.change")} onClick={() => setPicking(i)}><FolderOpen /></Button>
							<Button variant="ghost" size="icon" aria-label={t("libraryFolders.up")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
							<Button variant="ghost" size="icon" aria-label={t("libraryFolders.down")} disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
							<Button variant="ghost" size="icon" aria-label={t("libraryFolders.remove")} onClick={() => setList((l) => l.filter((_, n) => n !== i))}><Trash2 /></Button>
						</div>
						{list.length > 1 && (
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
														className="h-8 text-xs"
														placeholder={t(`libraryFolders.example.${k}`)}
														defaultValue={(r.when[k] ?? []).join(", ")}
														onChange={(e) => edit(i, (x) => ({ ...x, rules: x.rules!.map((y, m) => (m === ri ? { ...y, when: { ...y.when, [k]: words(e.target.value) } } : y)) }))}
													/>
												</label>
											))}
										</div>
										<div className="flex items-center gap-2">
											<p className="min-w-0 flex-1 text-[11px] text-muted-foreground">{r.note}</p>
											<Button variant="ghost" size="sm" onClick={() => edit(i, (x) => ({ ...x, rules: x.rules!.filter((_, m) => m !== ri) }))}>
												{t("libraryFolders.removeRule")}
											</Button>
										</div>
									</div>
								))}
								<Button variant="ghost" size="sm" onClick={() => edit(i, (x) => ({ ...x, rules: [...(x.rules ?? []), { when: {} }] }))}>
									<Plus /> {t("libraryFolders.addRule")}
								</Button>
							</>
						)}
					</div>
				))}
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" onClick={() => setPicking("new")}>
						<Plus /> {t("libraryFolders.add")}
					</Button>
					{dirty && (
						<Button onClick={() => void save()} disabled={busy}>
							{busy && <Spinner />}
							{t("common:actions.save")}
						</Button>
					)}
				</div>
				{list.length > 1 && <p className="text-xs text-muted-foreground">{t("libraryFolders.help")}</p>}
				{folders.length > 1 && !dirty && <AskAbout text={t("libraryFolders.learnPrompt", { type: label })} label={t("libraryFolders.learn")} className="justify-start" />}
				{error && <p className="text-xs text-destructive-foreground">{error}</p>}
				<FolderPicker
					open={picking !== undefined}
					onOpenChange={(o) => !o && setPicking(undefined)}
					start={typeof picking === "number" ? list[picking]?.path : list[0]?.path.split("/").slice(0, -1).join("/")}
					level="library"
					onChoose={(p) => setList((l) => (picking === "new" ? (l.some((x) => x.path === p) ? l : [...l, { path: p }]) : l.map((x, n) => (n === picking ? { ...x, path: p } : x))))}
				/>
			</div>
		</div>
	);
}
