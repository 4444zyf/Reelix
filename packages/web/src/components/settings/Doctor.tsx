import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleDot, MessageSquare, RefreshCw, Stethoscope, XCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useStatus } from "../../app/Sidebar";
import { endpoints, runOp } from "../../lib/api";
import { useChat } from "../../lib/chat";
import type { CheckAction, CheckMessage, CheckState, DoctorCheck, FolderResult } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";

/** Most serious first; checks of the same state keep Doctor's order. */
const RANK: Record<CheckState, number> = { failed: 0, degraded: 1, not_tested: 2, skipped: 3, not_used: 4, passed: 5 };
const needsAttention = (s: CheckState) => s === "failed" || s === "degraded";

/** Words a Doctor message in the UI language: a plugin's message comes worded; Reelix's are keys in the `doctor` strings. */
function useWording() {
	const { t } = useTranslation("doctor");
	const word = (m: CheckMessage) => m.text ?? t(m.key as "check_failed", { ...m.values, defaultValue: t("check_failed") });
	const title = (name: string) => t(`checks.${name.replace(/ /g, "_")}` as "checks.tools", { defaultValue: name });
	return { t, word, title };
}

function StateIcon({ state, className }: { state: CheckState; className?: string }) {
	const c = cn("h-4 w-4 shrink-0", className);
	if (state === "passed") return <CheckCircle2 className={cn(c, "text-success")} />;
	if (state === "failed") return <XCircle className={cn(c, "text-destructive-foreground")} />;
	if (state === "degraded") return <AlertTriangle className={cn(c, "text-warning")} />;
	if (state === "not_tested") return <CircleDot className={cn(c, "text-muted-foreground")} />;
	return <CircleDashed className={cn(c, "text-muted-foreground")} />;
}

/** Jump to a place in Settings: its anchor, scrolled into view. */
function goToAnchor(id: string) {
	// A plugin that is a connection is set up on its card under Services.
	const plugin = /^plugin-(.+)$/.exec(id)?.[1];
	const target = (plugin && document.getElementById(`service-${plugin}`)) || document.getElementById(id);
	window.location.hash = `#${target?.id ?? id}`;
	target?.scrollIntoView({ behavior: "smooth", block: "center" });
	target?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });
}

function ActionButton({ action, onDone }: { action: CheckAction; onDone: () => void }) {
	const { t, word } = useWording();
	const [busy, setBusy] = useState(false);
	if ("anchor" in action)
		return (
			<Button size="sm" variant="outline" onClick={() => goToAnchor(action.anchor)}>
				{word(action.label)}
			</Button>
		);
	const run = async () => {
		setBusy(true);
		try {
			await runOp(action.operation, action.input ?? {});
			toast({ title: t("ui.actionDone") });
			onDone();
		} catch (e) {
			toast({ title: t("ui.actionFailed", { error: e instanceof Error ? e.message : String(e) }), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<Button size="sm" variant="outline" disabled={busy} onClick={() => void run()}>
			{busy && <Spinner />}
			{word(action.label)}
		</Button>
	);
}

/** One check's result, worded in the UI language, with its action and collapsed details. */
export function CheckRow({ check, onRerun }: { check: DoctorCheck; onRerun: () => void }) {
	const { t, word, title } = useWording();
	const technical = check.raw || check.cli || check.also?.length;
	return (
		<div className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", check.state === "failed" ? "bg-destructive/15" : check.state === "degraded" ? "bg-warning/10" : "bg-surface")}>
			<StateIcon state={check.state} className="mt-0.5" />
			<div className="min-w-0 flex-1 space-y-1">
				<p>
					<span className="font-medium">{title(check.name)}</span>
					<span className="ml-2 text-xs text-muted-foreground">{t(`state.${check.state}`)}</span>
				</p>
				<p className="break-words">{word(check.cause)}</p>
				{check.impact && <p className="break-words text-xs text-muted-foreground">{word(check.impact)}</p>}
				{check.action && check.state !== "passed" && <ActionButton action={check.action} onDone={onRerun} />}
				{technical && (
					<details className="text-xs">
						<summary className="cursor-pointer text-muted-foreground">{t("ui.details")}</summary>
						<div className="mt-1 space-y-1 rounded-md bg-well p-2 text-muted-foreground">
							{check.also?.length ? <p>{t("ui.also", { names: check.also.map(title).join(", ") })}</p> : null}
							{check.raw && <p className="whitespace-pre-wrap break-words font-mono">{check.raw}</p>}
							{check.cli && (
								<p className="break-words">
									{t("ui.command")}: <code className="font-mono">{check.cli}</code>
								</p>
							)}
						</div>
					</details>
				)}
			</div>
		</div>
	);
}

/** The Doctor section's body (docs/settings.md, "Status and Doctor"): run all or a quick check, then each result worded in the UI language. */
export function Doctor() {
	const { t, word, title } = useWording();
	const { askAbout } = useChat();
	const { data: status } = useStatus();
	const qc = useQueryClient();
	const [checks, setChecks] = useState<DoctorCheck[]>();
	const [quick, setQuick] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = async (q: boolean) => {
		setBusy(true);
		setQuick(q);
		setError(undefined);
		try {
			setChecks(await endpoints.doctor(q));
			// Each plugin's result is now its last check: the service cards and Status show it.
			void qc.invalidateQueries({ queryKey: ["plugins"] });
			void qc.invalidateQueries({ queryKey: ["doctor-quick"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	const sorted = checks?.map((c, i) => ({ c, i })).sort((a, b) => RANK[a.c.state] - RANK[b.c.state] || a.i - b.i).map(({ c }) => c);
	const problems = checks?.filter((c) => needsAttention(c.state)) ?? [];
	// Only when a model can answer (docs/settings.md, principle 4).
	const modelUsable = !!status?.models.length;
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-2">
				<Button onClick={() => void run(false)} disabled={busy}>
					{busy ? <Spinner /> : <Stethoscope />}
					{t("ui.runAll")}
				</Button>
				<Button variant="outline" onClick={() => void run(true)} disabled={busy}>
					{t("ui.quick")}
				</Button>
				{modelUsable && problems.length > 0 && (
					<Button variant="ghost" onClick={() => askAbout(t("ui.askFixPrompt", { count: problems.length, list: problems.map((c) => `${title(c.name)}: ${word(c.cause)}${c.raw ? ` (${c.raw})` : ""}`).join("; ") }))}>
						<MessageSquare /> {t("ui.askFix")}
					</Button>
				)}
			</div>
			{error && <p className="text-sm text-destructive-foreground">{t("ui.error", { error })}</p>}
			{!checks && !error && <p className="text-sm text-muted-foreground">{t("ui.intro")}</p>}
			{sorted && (
				<>
					<p className="text-sm font-medium">{problems.length ? t("ui.attention", { count: problems.length }) : t("ui.allClear")}</p>
					<div className="space-y-1.5">
						{sorted.map((c, i) => (
							<CheckRow key={`${c.name}-${c.cause_id ?? i}`} check={c} onRerun={() => void run(quick)} />
						))}
					</div>
				</>
			)}
		</div>
	);
}

const FOLDER_RESULTS = [
	["exists", "ui.exists"],
	["writable", "ui.writable"],
	["hardlink", "ui.hardlink"],
	["media_server", "ui.mediaServer"],
] as const;

/** A folder's four results, compact, for under its field (docs/settings.md, "Folder checks"). */
export function FolderChecks({ path, className }: { path: string; className?: string }) {
	const { t, word } = useWording();
	const q = useQuery({ queryKey: ["folder-checks", path], queryFn: () => endpoints.folderChecks(path), enabled: !!path, retry: false });
	if (!path) return null;
	const folder = q.data?.[0];
	return (
		<div className={cn("space-y-1 text-xs", className)} aria-label={t("ui.folderChecks")}>
			{q.isLoading && <Spinner className="h-3 w-3" />}
			{q.error && <p className="text-destructive-foreground">{q.error instanceof Error ? q.error.message : String(q.error)}</p>}
			{folder && (
				<ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
					{FOLDER_RESULTS.map(([field, label]) => {
						const r: FolderResult = folder[field];
						return (
							<li key={field} className="flex min-w-0 items-start gap-1.5" title={r.raw}>
								<StateIcon state={r.state} className="mt-px h-3.5 w-3.5" />
								<span className="min-w-0">
									<span className="sr-only">{t(label)}: </span>
									{word(r.cause)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{!q.isLoading && (
				<button type="button" onClick={() => void q.refetch()} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
					<RefreshCw className={cn("h-3 w-3", q.isFetching && "animate-spin")} />
					{t("ui.recheck")}
				</button>
			)}
		</div>
	);
}
