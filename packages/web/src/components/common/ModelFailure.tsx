import type { TFunction } from "i18next";
import { AlertTriangle, ArrowRightLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ModelFailure } from "../../lib/types";
import { cn, formatDateTime } from "../../lib/utils";

/** Why a model failed, in the owner's words (docs/models.md, "Why a call failed"). */
export function failureReason(t: TFunction<"models">, f: ModelFailure): string {
	return f.class === "capability" ? t(f.capability === "images" ? "failure.reason.capability_images" : "failure.reason.capability_context") : t(`failure.reason.${f.class}`);
}

/** What the owner can do: reconnect or choose another model (both in Settings), wait until a time, or try again. */
function FailureAction({ failure }: { failure: ModelFailure }) {
	const { t } = useTranslation("models");
	if (failure.action === "reconnect" || failure.action === "choose_model")
		return (
			<Link to="/settings#models" className="font-medium underline underline-offset-2">
				{t(`failure.action.${failure.action}`)}
			</Link>
		);
	if (failure.action === "wait" && failure.until) return <span>{t("failure.action.waitUntil", { time: formatDateTime(failure.until) })}</span>;
	return <span>{t(`failure.action.${failure.action}`)}</span>;
}

/** One model failure: which model, why, the action, and the provider's own words behind a disclosure. */
export function FailureNote({ failure, className }: { failure: ModelFailure; className?: string }) {
	const { t } = useTranslation("models");
	const reason = failureReason(t, failure);
	return (
		<div className={cn("flex items-start gap-1.5 text-xs", className)}>
			<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
			<div className="min-w-0 space-y-0.5">
				<p>
					{failure.model ? t("failure.failed", { model: failure.model, reason }) : t("failure.failedUnnamed", { reason })} <FailureAction failure={failure} />
				</p>
				<details>
					<summary className="cursor-pointer opacity-80">{t("failure.details")}</summary>
					<p className="mt-0.5 break-words font-mono opacity-80">{failure.message}</p>
				</details>
			</div>
		</div>
	);
}

/** An answer came from the role's next model because the one before failed. `to`: the model that answered (absent in a job's record). */
export function FallbackNote({ failure, to, className }: { failure: ModelFailure; to?: string; className?: string }) {
	const { t } = useTranslation("models");
	const reason = failureReason(t, failure);
	const from = failure.model ?? "";
	return (
		<p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
			<ArrowRightLeft className="mt-0.5 h-3 w-3 shrink-0" />
			<span>{to ? t("failure.fallback", { from, to, reason }) : t("failure.fallbackJob", { from, reason })}</span>
		</p>
	);
}

/** A job record's model line (`job_runs.models_json`): the models that failed on the way, with why, and the one that did the work. */
export function JobModels({ json }: { json: string }) {
	const { t } = useTranslation("models");
	let record: { model?: string; failures?: ModelFailure[] };
	try {
		record = JSON.parse(json);
	} catch {
		return null;
	}
	const failures = record.failures ?? [];
	const last = record.model ? undefined : failures.at(-1);
	return (
		<div className="mt-1 space-y-0.5">
			{failures.filter((f) => f !== last).map((f, i) => (
				<FallbackNote key={i} failure={f} />
			))}
			{last && <FailureNote failure={last} className="text-warning" />}
			{record.model && <p className="text-xs text-muted-foreground">{t("job.model", { model: record.model })}</p>}
		</div>
	);
}
