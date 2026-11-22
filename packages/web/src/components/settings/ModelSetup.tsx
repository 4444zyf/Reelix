import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Providers } from "./Providers";
import { Check, FlaskConical, Plug } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints, op } from "../../lib/api";
import type { ModelTestResult } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Badge } from "../common/Badge";
import { FailureNote, FallbackNote } from "../common/ModelFailure";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";

const STATUS_REFRESH_MS = 3000;

/**
 * Test a role: one short call through its models (`model.test`), showing the answer, the model that
 * gave it and the time, or why each model failed. `onResult`: told of each finished test.
 */
export function ModelTest({ role = "chat", disabled, onResult, className }: { role?: string; disabled?: boolean; onResult?: (r: ModelTestResult) => void; className?: string }) {
	const { t } = useTranslation("models");
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<ModelTestResult>();
	const run = async () => {
		setBusy(true);
		setResult(undefined);
		try {
			const r = await op<ModelTestResult>("model.test", { role });
			setResult(r);
			onResult?.(r);
			// A test changes which models rest after failing.
			void qc.invalidateQueries({ queryKey: ["status"] });
		} catch (e) {
			toast({ title: t("test.failed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	const seconds = result ? (result.ms / 1000).toFixed(1) : "";
	return (
		<div className={cn("space-y-2", className)}>
			<Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run()}>
				{busy ? <Spinner /> : <FlaskConical />} {busy ? t("test.running") : t("test.button")}
			</Button>
			{result?.ok && (
				<div className="space-y-1 rounded-md border border-line px-3 py-2 text-sm">
					{result.skipped.map((f, i) => (
						<FallbackNote key={i} failure={f} to={result.model} />
					))}
					<p className="text-xs text-muted-foreground">{t("test.answered", { model: result.model, seconds })}</p>
					<p className="whitespace-pre-wrap break-words">{result.answer}</p>
				</div>
			)}
			{result && !result.ok && (
				<div className="space-y-1.5 rounded-md bg-destructive/20 px-3 py-2 text-destructive-foreground">
					<p className="text-xs font-medium">{t("test.noAnswer", { seconds })}</p>
					{result.failures.map((f, i) => (
						<FailureNote key={i} failure={f} />
					))}
				</div>
			)}
		</div>
	);
}

function Step({ n, title, help, done, children }: { n: number; title: string; help: string; done: boolean; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", done ? "bg-success/15 text-success" : "bg-primary/15 text-primary")}>{done ? <Check className="h-3.5 w-3.5" /> : n}</span>
			<div className="min-w-0 flex-1 space-y-2">
				<div>
					<p className="text-sm font-medium">{title}</p>
					<p className="text-xs text-muted-foreground">{help}</p>
				</div>
				{children}
			</div>
		</li>
	);
}

/** Jump to magpie's card in Settings → Services (`#service-magpie`). */
function goToMagpie() {
	document.getElementById("service-magpie")?.scrollIntoView({ behavior: "smooth", block: "start" });
	history.replaceState(null, "", "#service-magpie");
}

/**
 * "No model connected" (docs/settings.md, "No usable model"): connect a provider, choose the chat
 * model, test it. Opens by itself when `/api/status` lists no models, and stays open until the owner
 * closes it, so the later steps can be finished once models appear. Renders nothing otherwise.
 */
export function ModelSetup({ onDone }: { onDone?: () => void }) {
	const { t } = useTranslation("models");
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	// The status refreshes while the flow is open, so a sign-in on the NAS shows up by itself.
	const { data: status } = useQuery({ queryKey: ["status"], queryFn: endpoints.status, refetchInterval: open ? STATUS_REFRESH_MS : 60_000 });
	const models = status?.models ?? [];
	useEffect(() => {
		if (status && !status.models.length) setOpen(true);
	}, [status]);
	const own = status?.model.roles.chat?.own ?? [];
	const [choice, setChoice] = useState("");
	const [saving, setSaving] = useState(false);
	const [passed, setPassed] = useState(false);
	if (!open) return null;

	const connected = models.length > 0;
	const chosen = own.find((m) => models.includes(m));
	const save = async () => {
		if (!choice) return;
		setSaving(true);
		try {
			await op("config.set", { path: "models.roles.chat", value: [choice, ...own.filter((m) => m !== choice)] });
			toast({ title: t("setup.saved") });
			setPassed(false);
			await qc.invalidateQueries({ queryKey: ["status"] });
			await qc.invalidateQueries({ queryKey: ["config"] });
		} catch (e) {
			toast({ title: t("setup.notSaved"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="space-y-4 rounded-lg border border-warning/40 bg-warning/5 p-4">
			<div>
				<p className="flex items-center gap-2 font-medium">
					<Plug className="h-4 w-4 text-warning" /> {t("setup.title")}
				</p>
				<p className="text-sm text-muted-foreground">{t("setup.effect")}</p>
			</div>
			<ol className="space-y-5">
				<Step n={1} title={t("setup.step1")} help={t("setup.step1Help")} done={connected}>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-2 rounded-md border border-line p-3">
							<p className="text-sm font-medium">{t("setup.providerTitle")}</p>
							<p className="text-xs text-muted-foreground">{t("setup.providerHelp")}</p>
							<Providers compact />
						</div>
						<div className="space-y-2 rounded-md border border-line p-3">
							<p className="text-sm font-medium">{t("setup.magpieTitle")}</p>
							<p className="text-xs text-muted-foreground">{t("setup.magpieHelp")}</p>
							<Button size="sm" variant="outline" onClick={goToMagpie}>
								{t("setup.magpieButton")}
							</Button>
						</div>
					</div>
					{connected ? (
						<Badge tone="success">{t("setup.connected", { count: models.length })}</Badge>
					) : (
						<p className="flex items-center gap-2 text-xs text-muted-foreground">
							<Spinner className="h-3 w-3" /> {t("setup.waiting")}
						</p>
					)}
				</Step>
				<Step n={2} title={t("setup.step2")} help={t("setup.step2Help")} done={!!chosen}>
					{!connected ? (
						<p className="text-xs text-muted-foreground">{t("setup.needsStep1")}</p>
					) : (
						<div className="space-y-2">
							{chosen && <p className="text-xs text-muted-foreground">{t("setup.current", { model: chosen })}</p>}
							<div className="flex flex-wrap items-center gap-2">
								<select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t("setup.choose")} className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
									<option value="">{t("setup.choose")}</option>
									{models.map((m) => (
										<option key={m} value={m}>
											{m}
										</option>
									))}
								</select>
								<Button size="sm" disabled={!choice || choice === chosen || saving} onClick={() => void save()}>
									{saving && <Spinner />} {t("setup.save")}
								</Button>
							</div>
						</div>
					)}
				</Step>
				<Step n={3} title={t("setup.step3")} help={t("setup.step3Help")} done={passed}>
					{!chosen ? <p className="text-xs text-muted-foreground">{t("setup.needsStep2")}</p> : <ModelTest role="chat" onResult={(r) => setPassed(r.ok)} />}
				</Step>
			</ol>
			{passed && (
				<div className="flex flex-wrap items-center justify-end gap-3">
					<p className="text-sm text-success">{t("setup.ready")}</p>
					<Button
						size="sm"
						onClick={() => {
							setOpen(false);
							onDone?.();
						}}
					>
						{t("setup.done")}
					</Button>
				</div>
			)}
		</div>
	);
}
