import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, endpoints } from "../../lib/api";
import type { PluginActionResult, PluginInfo, PluginReview, PluginUpdates } from "../../lib/types";
import { Badge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The lists a declaration difference names (`DeclarationDiff`). */
type DeclKey = "network" | "secrets" | "skills" | "scripts" | "operations" | "tools" | "provides" | "plugins" | "owns" | "hooks" | "events" | "runs" | "jobs";

/** Whether this Reelix can restart itself (docs/plugins.md §5.3): it offers `server.restart` only when something starts it again. */
function useCanRestart(): boolean {
	const { data } = useQuery({ queryKey: ["ops"], queryFn: () => api<{ name: string }[]>("/api/ops"), staleTime: 60_000 });
	return !!data?.some((o) => o.name === "server.restart");
}

/** Plugins approved or updated since start: their code is loaded at the next restart. */
export function RestartBanner({ plugins }: { plugins: PluginInfo[] }) {
	const { t } = useTranslation("settings");
	const canRestart = useCanRestart();
	const [busy, setBusy] = useState(false);
	const waiting = plugins.filter((p) => p.restartNeeded).map((p) => p.id);
	if (!waiting.length) return null;
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" data-testid="restart-banner">
			<span className="min-w-0 flex-1">{t(canRestart ? "plugins.restartNeeded" : "plugins.restartNeededManual", { ids: waiting.join(", ") })}</span>
			{canRestart && (
				<Button
					size="sm"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							toast({ title: t("plugins.restarting"), description: (await endpoints.restart()).next });
						} catch (e) {
							toast({ title: t("plugins.restartFailed"), description: message(e), variant: "destructive" });
							setBusy(false);
						}
					}}
				>
					{busy ? <Spinner /> : <RotateCcw />}
					{t("plugins.restart")}
				</Button>
			)}
		</div>
	);
}

/** Where a plugin comes from: a folder, git pinned to a commit, or npm pinned to a version (§13.1). */
export function InstallBox({ onReview }: { onReview: (r: PluginReview) => void }) {
	const { t } = useTranslation("settings");
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<form
			className="space-y-1 rounded-md bg-surface px-3 py-2"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				setError(undefined);
				try {
					onReview(await endpoints.installPlugin(source.trim()));
					setSource("");
				} catch (err) {
					setError(message(err));
				} finally {
					setBusy(false);
				}
			}}
		>
			<label htmlFor="plugin-source" className="text-sm font-medium">
				{t("plugins.installTitle")}
			</label>
			<p className="text-xs text-muted-foreground">{t("plugins.installIntro")}</p>
			<details className="text-xs text-muted-foreground">
				<summary className="cursor-pointer">{t("plugins.installHow")}</summary>
				<p className="mt-1">{t("plugins.installHelp")}</p>
			</details>
			<div className="flex gap-2">
				<Input id="plugin-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("plugins.installPlaceholder")} />
				<Button type="submit" disabled={busy || !source.trim()} className="shrink-0">
					{busy ? <Spinner /> : <Download />}
					{t("plugins.install")}
				</Button>
			</div>
			{busy && <p className="text-xs text-muted-foreground">{t("plugins.installing")}</p>}
			{error && <p className="whitespace-pre-wrap break-words text-xs text-destructive-foreground">{error}</p>}
		</form>
	);
}

function Row({ label, items, tone }: { label: string; items: string[]; tone?: "warning" }) {
	if (!items.length) return null;
	return (
		<div className="grid gap-1 text-sm sm:grid-cols-[170px_1fr]">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className={`break-words font-mono text-xs ${tone === "warning" ? "text-warning" : ""}`}>{items.join(", ")}</span>
		</div>
	);
}

/**
 * The approval screen (docs/plugins.md §11.1, §13.3): what the plugin declares, from its manifest only,
 * and for an update what changed and the author's changelog. Approving takes back the hash shown.
 */
export function ReviewDialog({ review, onClose, onApproved }: { review?: PluginReview; onClose: () => void; onApproved: (r: PluginActionResult) => void }) {
	const { t } = useTranslation(["settings", "common"]);
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	if (!review) return null;
	const d = review.declarations;
	const yes = (b: boolean) => (b ? t("plugins.yes") : t("plugins.no"));
	const diff = review.diff;
	const what = (k: string) => t(`plugins.decl.${k as DeclKey}`);
	const diffRows = diff ? [...Object.entries(diff.added).map(([k, v]) => [t("plugins.diffAdded", { what: what(k) }), v] as const), ...Object.entries(diff.removed).map(([k, v]) => [t("plugins.diffRemoved", { what: what(k) }), v] as const)] : [];
	return (
		<Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
			<DialogContent className="surface-card max-h-[90vh] max-w-2xl overflow-y-auto rounded-xl" data-testid="plugin-review">
				<DialogHeader>
					<DialogTitle>{t(`plugins.review.${review.what}`, { id: d.id, version: d.version, from: review.from?.version })}</DialogTitle>
					<DialogDescription>{d.kind === "plugin" ? t(d.runtime === "process" ? "plugins.reviewWarningProcess" : "plugins.reviewWarning") : t("plugins.reviewSkills")}</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					{d.description && <p className="text-sm">{d.description}</p>}
					<Row label={t("plugins.decl.source")} items={[`${review.source.kind} ${review.source.location}${review.source.pin ? ` @ ${review.source.pin}` : ""}`]} />
					{d.license && <Row label={t("plugins.decl.license")} items={[d.license]} />}
					<Row label={t("plugins.decl.provides")} items={d.provides} />
					<Row label={t("plugins.decl.requires")} items={d.requires} />
					{review.requirements.length > 0 && (
						<div className="grid gap-1 text-sm sm:grid-cols-[170px_1fr]" data-testid="plugin-requirements">
							<span className="text-xs text-muted-foreground">{t("plugins.decl.plugins")}</span>
							<ul className="space-y-0.5 font-mono text-xs">
								{review.requirements.map((q) => (
									<li key={q.id} className={q.satisfied ? "" : "text-warning"}>
										{q.id} {q.range}: {q.version === undefined ? t("plugins.requirementMissing") : q.satisfied ? t("plugins.requirementHas", { version: q.version }) : t("plugins.requirementOther", { version: q.version })}
									</li>
								))}
							</ul>
						</div>
					)}
					<Row label={t("plugins.decl.owns")} items={d.owns} />
					<Row label={t("plugins.decl.hooks")} items={d.hooks} />
					<Row label={t("plugins.decl.events")} items={d.events} />
					<Row label={t("plugins.decl.operations")} items={d.operations.map((o) => `${o.name} (${t(`plugins.effect.${o.effect}`)}${o.tool ? `, ${t("plugins.toolNamed", { tool: o.tool })}` : ""})`)} />
					<Row label={t("plugins.decl.jobs")} items={d.jobs} />
					<Row label={t("plugins.decl.runs")} items={d.runs} />
					<Row label={t("plugins.decl.network")} items={d.network.map((n) => (n === "*" ? t("plugins.anyHost") : n))} tone={d.anyHost ? "warning" : undefined} />
					<Row label={t("plugins.decl.secrets")} items={d.secrets} />
					<Row label={t("plugins.decl.skills")} items={d.skills} />
					<Row label={t("plugins.scriptsWarning")} items={d.scripts} tone="warning" />
					{d.kind === "plugin" && (
						<div className="flex flex-wrap gap-2 pt-1 text-xs">
							<Badge tone={d.agent ? "warning" : "muted"}>{t("plugins.flag.agent", { v: yes(d.agent) })}</Badge>
							<Badge tone={d.inbox ? "warning" : "muted"}>{t("plugins.flag.inbox", { v: yes(d.inbox) })}</Badge>
							<Badge tone={d.model ? "warning" : "muted"}>{t("plugins.flag.model", { v: yes(d.model) })}</Badge>
							{d.modelRoles.length > 0 && <Badge tone="warning">{t("plugins.flag.modelRoles", { roles: d.modelRoles.join(", ") })}</Badge>}
							{d.unmetered && <Badge tone="warning">{t("plugins.flag.unmetered")}</Badge>}
							<Badge tone={d.pi ? "danger" : "muted"}>{t("plugins.flag.pi", { v: yes(d.pi) })}</Badge>
							<Badge tone={d.native ? "warning" : "muted"}>{t("plugins.flag.native", { v: yes(d.native) })}</Badge>
						</div>
					)}
					{d.kind === "plugin" && <Row label={t("plugins.decl.runtime")} items={[t(d.runtime === "process" ? "plugins.runtimeProcess" : d.processAllowed ? "plugins.runtimeInProcess" : "plugins.runtimeNoProcess")]} />}
					{d.screen && <Row label={t("plugins.decl.screen")} items={[d.screen]} />}
					{d.native && <p className="text-xs text-muted-foreground">{t("plugins.nativeHelp")}</p>}
					<Row label={t("plugins.nativeFound")} items={review.nativeFound} />
					<Row label={t("plugins.scriptsNotRun")} items={review.scriptsNotRun} />
					{diff && (
						<div className="space-y-1 rounded-md bg-well p-2" data-testid="plugin-diff">
							<p className="text-xs font-semibold">{t("plugins.diffTitle")}</p>
							{diffRows.map(([label, items]) => (
								<Row key={label} label={label} items={[...items]} tone="warning" />
							))}
							<Row label={t("plugins.diffEffects")} items={diff.effects.map((e) => `${e.operation}: ${e.from ? `${t(`plugins.effect.${e.from}`)} → ` : ""}${t(`plugins.effect.${e.to}`)}`)} tone="warning" />
							<Row label={t("plugins.diffFlags")} items={diff.flags} tone="warning" />
							{!diffRows.length && !diff.effects.length && !diff.flags.length && <p className="text-xs text-muted-foreground">{t("plugins.diffNone")}</p>}
						</div>
					)}
					{review.proposal && <ProposalFiles proposal={review.proposal} />}
					{review.changelog && (
						<div>
							<p className="text-xs font-semibold">{t("plugins.changelog")}</p>
							<pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-well p-2 text-xs">{review.changelog}</pre>
						</div>
					)}
				</div>
				{error && <p className="text-sm text-destructive-foreground">{error}</p>}
				<DialogFooter className="gap-2">
					<Button variant="ghost" disabled={busy} onClick={onClose}>
						{t("plugins.notNow")}
					</Button>
					<Button
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							setError(undefined);
							try {
								onApproved(review.proposal ? await endpoints.decidePluginProposal(review.proposal.id, true, review.hash) : await endpoints.approvePlugin(review.id, review.hash));
								onClose();
							} catch (e) {
								setError(message(e));
							} finally {
								setBusy(false);
								qc.invalidateQueries({ queryKey: ["plugins"] });
							}
						}}
					>
						{busy && <Spinner />}
						{t("plugins.approve")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A proposed plugin's note, files and difference to its previous proposal (docs/plugins.md §16, phase 7). The note is the proposer's words. */
function ProposalFiles({ proposal }: { proposal: NonNullable<PluginReview["proposal"]> }) {
	const { t } = useTranslation("settings");
	return (
		<div className="space-y-2" data-testid="proposal-files">
			{proposal.note && (
				<blockquote className="border-l-2 border-line pl-3 text-sm">
					<span className="text-xs text-muted-foreground">{t("plugins.proposalNote", { by: proposal.by })}</span>
					<p className="whitespace-pre-wrap break-words">{proposal.note}</p>
				</blockquote>
			)}
			<p className="text-xs font-semibold">{proposal.diffFrom ? t("plugins.proposalFilesSince", { id: proposal.diffFrom }) : t("plugins.proposalFiles")}</p>
			<ul className="space-y-0.5 font-mono text-xs">
				{proposal.files.map((f) => (
					<li key={f.path} className={f.change === "same" ? "text-muted-foreground" : ""}>
						{t(`plugins.fileChange.${f.change}`)} {f.path} ({f.size} B)
					</li>
				))}
			</ul>
			<pre className="max-h-96 overflow-auto whitespace-pre rounded-md bg-well p-2 text-xs" data-testid="proposal-diff">{proposal.diff || t("plugins.diffNone")}</pre>
		</div>
	);
}

/** A plugin the agent proposed, in the Inbox: Reelix's summary, the review screen, decline. Only the owner decides. */
export function PluginProposalCard({ id, open }: { id: string; open: boolean }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [review, setReview] = useState<PluginReview>();
	const [busy, setBusy] = useState<string>();
	const act = async (what: string, fn: () => Promise<void>) => {
		setBusy(what);
		try {
			await fn();
		} catch (e) {
			toast({ title: t("plugins.proposalFailed"), description: message(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
			qc.invalidateQueries({ queryKey: ["inbox"] });
			qc.invalidateQueries({ queryKey: ["plugins"] });
		}
	};
	return (
		<div className="space-y-2" data-testid={`plugin-proposal-${id}`}>
			<p className="text-sm">{t("plugins.proposalHelp")}</p>
			{open && (
				<div className="flex flex-wrap gap-2">
					<Button size="sm" disabled={!!busy} onClick={() => act("review", async () => setReview(await endpoints.pluginProposal(id)))}>
						{busy === "review" && <Spinner />}
						{t("plugins.review.open")}
					</Button>
					<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("decline", async () => void toast({ title: (await endpoints.decidePluginProposal(id, false)).next }))}>
						{busy === "decline" && <Spinner />}
						{t("plugins.decline")}
					</Button>
				</div>
			)}
			<ReviewDialog review={review} onClose={() => setReview(undefined)} onApproved={(r) => toast({ title: r.id, description: r.next })} />
		</div>
	);
}

/** Per installed plugin: review, look for updates, uninstall (docs/plugins.md §12.4, §13.3). */
export function InstalledActions({ p, onReview }: { p: PluginInfo; onReview: (r: PluginReview) => void }) {
	const { t } = useTranslation("settings");
	const qc = useQueryClient();
	const [busy, setBusy] = useState<string>();
	const [updates, setUpdates] = useState<PluginUpdates>();
	const [uninstalling, setUninstalling] = useState(false);
	const [deleteData, setDeleteData] = useState(false);
	const act = async (what: string, fn: () => Promise<void>) => {
		setBusy(what);
		try {
			await fn();
		} catch (e) {
			toast({ title: p.id, description: message(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	const reviewable = p.state === "changed" || (p.state === "installed" && !p.restartNeeded) || !!p.update;
	return (
		<div className="mt-1 space-y-2">
			<p className="break-words text-xs text-muted-foreground">
				{t("plugins.from", { source: `${p.source!.kind} ${p.source!.location}${p.source!.pin ? ` @ ${p.source!.pin.slice(0, 12)}` : ""}` })}
			</p>
			<div className="flex flex-wrap gap-2">
				{reviewable && (
					<Button size="sm" variant={p.state === "active" ? "outline" : "default"} disabled={!!busy} onClick={() => act("review", async () => onReview(await endpoints.reviewPlugin(p.id)))}>
						{busy === "review" && <Spinner />}
						{t(p.update ? "plugins.reviewUpdate" : p.state === "changed" ? "plugins.reapprove" : "plugins.review.open")}
					</Button>
				)}
				<Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("check", async () => setUpdates((await endpoints.pluginUpdates(p.id))[0]))}>
					{busy === "check" ? <Spinner /> : <RefreshCw />}
					{t("plugins.checkUpdates")}
				</Button>
				<Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setUninstalling(true)}>
					{t("plugins.uninstall")}
				</Button>
			</div>
			{updates && (
				<div className="space-y-1 rounded-md bg-well px-3 py-2 text-xs" data-testid={`updates-${p.id}`}>
					{updates.error ? (
						<p className="text-warning">{t("plugins.checkFailed", { error: updates.error })}</p>
					) : updates.available.length ? (
						updates.available.map((a) => (
							<div key={a.to + a.label} className="flex items-center gap-2">
								<span className="min-w-0 flex-1 break-words font-mono">{a.label}</span>
								<Button size="sm" variant="outline" className="h-7" disabled={!!busy} onClick={() =>
										act(a.to, async () => {
											onReview(await endpoints.updatePlugin(p.id, a.to));
											setUpdates(undefined);
										})
									}>
									{busy === a.to && <Spinner />}
									{t("plugins.fetchUpdate")}
								</Button>
							</div>
						))
					) : (
						<p>{t("plugins.upToDate")}</p>
					)}
				</div>
			)}
			<ConfirmDialog
				open={uninstalling}
				onOpenChange={(o) => {
					setUninstalling(o);
					if (!o) setDeleteData(false);
				}}
				title={t("plugins.uninstallTitle", { id: p.id })}
				description={t("plugins.uninstallHelp")}
				destructive
				confirmLabel={t("plugins.uninstall")}
				onConfirm={async () => {
					const r = await endpoints.uninstallPlugin(p.id, deleteData);
					toast({ title: t("plugins.uninstalled", { id: p.id }), description: r.next });
					await qc.invalidateQueries({ queryKey: ["plugins"] });
				}}
			>
				<label className="flex items-start gap-2 text-sm">
					<input type="checkbox" className="mt-1" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} />
					<span>{t("plugins.deleteData")}</span>
				</label>
			</ConfirmDialog>
		</div>
	);
}
