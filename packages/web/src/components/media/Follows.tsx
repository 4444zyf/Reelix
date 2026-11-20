import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints, runOp } from "../../lib/api";
import type { FollowRow, Title } from "../../lib/types";
import { Badge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function useFollows() {
	return useQuery({ queryKey: ["follows"], queryFn: () => endpoints.follows(true), staleTime: 60_000 });
}

function FollowItem({ f }: { f: FollowRow }) {
	const { t } = useTranslation(["media", "common"]);
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const active = !!Number(f.active);
	const set = async (input: object) => {
		setBusy(true);
		try {
			await runOp("follow.set", { id: f.id, ...input });
			await qc.invalidateQueries({ queryKey: ["follows"] });
		} catch (e) {
			toast({ title: t("follows.notChanged"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="rounded-md bg-surface px-2.5 py-2 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={active ? "success" : "muted"}>{active ? t("follows.active") : t("follows.paused")}</Badge>
				{f.season != null && <Badge tone="info">{t("follows.season", { season: f.season })}</Badge>}
				{f.quick_accept && <Badge tone="primary">{t("follows.quickAccept", { value: f.quick_accept })}</Badge>}
			</div>
			<p className="mt-1">{f.instruction}</p>
			{f.summary && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{f.summary}</p>}
			<div className="mt-2 flex flex-wrap gap-1">
				<Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => set({ active: !active })}>
					{busy ? <Spinner /> : active ? <Pause /> : <Play />}
					{active ? t("shared.pause") : t("shared.resume")}
				</Button>
				<Button size="sm" variant="ghost" className="h-8 text-destructive-foreground" disabled={busy} onClick={() => setConfirm(true)}>
					<Trash2 /> {t("follows.stop")}
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title={t("follows.stopTitle")}
				description={t("follows.stopDescription")}
				destructive
				confirmLabel={t("follows.stop")}
				onConfirm={async () => {
					await runOp("follow.remove", { id: f.id });
					await qc.invalidateQueries({ queryKey: ["follows"] });
				}}
			/>
		</div>
	);
}

/** Follows for one title, and a form to add one in the owner's own words. */
export function FollowsPanel({ title }: { title: Title }) {
	const { t } = useTranslation(["media", "common"]);
	const qc = useQueryClient();
	const { data } = useFollows();
	const mine = (data ?? []).filter((f) => f.title_id === title.id);
	const [instruction, setInstruction] = useState("");
	const [quick, setQuick] = useState("");
	const [season, setSeason] = useState("");
	const [busy, setBusy] = useState(false);
	if (title.kind !== "tv") return <p className="text-sm text-muted-foreground">{t("follows.onlyShows")}</p>;
	return (
		<div className="space-y-2">
			{mine.map((f) => (
				<FollowItem key={f.id} f={f} />
			))}
			<form
				className="space-y-2 rounded-md border border-line p-2.5"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!instruction.trim()) return;
					setBusy(true);
					try {
						const r = await runOp("follow.add", { title_id: title.id, instruction: instruction.trim(), season: season ? Number(season) : undefined, quick_accept: quick.trim() || undefined });
						toast({ title: t("follows.following"), description: r.text.slice(0, 300) });
						setInstruction("");
						setQuick("");
						setSeason("");
						qc.invalidateQueries({ queryKey: ["follows"] });
					} catch (err) {
						toast({ title: t("follows.notFollowed"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
					} finally {
						setBusy(false);
					}
				}}
			>
				<Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t("follows.instructionPlaceholder")} />
				<div className="flex flex-wrap gap-2">
					<Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder={t("shared.season")} inputMode="numeric" className="h-9 w-24" />
					<Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={t("follows.quickPlaceholder")} className="h-9 min-w-0 flex-1" />
					<Button type="submit" size="sm" className="h-9" disabled={busy || !instruction.trim()}>
						{busy ? <Spinner /> : <Plus />}
						{t("follows.follow")}
					</Button>
				</div>
			</form>
		</div>
	);
}
