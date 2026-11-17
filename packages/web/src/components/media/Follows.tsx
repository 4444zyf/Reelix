import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
			toast({ title: "Not changed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="rounded-md bg-white/[0.03] px-2.5 py-2 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={active ? "success" : "muted"}>{active ? "active" : "paused"}</Badge>
				{f.season != null && <Badge tone="info">season {f.season}</Badge>}
				{f.quick_accept && <Badge tone="primary">quick accept: {f.quick_accept}</Badge>}
			</div>
			<p className="mt-1">{f.instruction}</p>
			{f.summary && <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{f.summary}</p>}
			<div className="mt-2 flex flex-wrap gap-1">
				<Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => set({ active: !active })}>
					{busy ? <Spinner /> : active ? <Pause /> : <Play />}
					{active ? "Pause" : "Resume"}
				</Button>
				<Button size="sm" variant="ghost" className="h-8 text-destructive-foreground" disabled={busy} onClick={() => setConfirm(true)}>
					<Trash2 /> Stop following
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Stop following?"
				description="Nothing already downloaded is touched."
				destructive
				confirmLabel="Stop following"
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
	const qc = useQueryClient();
	const { data } = useFollows();
	const mine = (data ?? []).filter((f) => f.title_id === title.id);
	const [instruction, setInstruction] = useState("");
	const [quick, setQuick] = useState("");
	const [season, setSeason] = useState("");
	const [busy, setBusy] = useState(false);
	if (title.kind !== "tv") return <p className="text-sm text-muted-foreground">Only shows can be followed.</p>;
	return (
		<div className="space-y-2">
			{mine.map((f) => (
				<FollowItem key={f.id} f={f} />
			))}
			<form
				className="space-y-2 rounded-md border border-white/5 p-2.5"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!instruction.trim()) return;
					setBusy(true);
					try {
						const r = await runOp("follow.add", { title_id: title.id, instruction: instruction.trim(), season: season ? Number(season) : undefined, quick_accept: quick.trim() || undefined });
						toast({ title: "Following", description: r.text.slice(0, 300) });
						setInstruction("");
						setQuick("");
						setSeason("");
						qc.invalidateQueries({ queryKey: ["follows"] });
					} catch (err) {
						toast({ title: "Not followed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
					} finally {
						setBusy(false);
					}
				}}
			>
				<Input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Weekly 1080p from the same group as season 1" />
				<div className="flex flex-wrap gap-2">
					<Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder="Season" inputMode="numeric" className="h-9 w-24" />
					<Input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Quick accept (optional): group X, 1080p, WEB" className="h-9 min-w-0 flex-1" />
					<Button type="submit" size="sm" className="h-9" disabled={busy || !instruction.trim()}>
						{busy ? <Spinner /> : <Plus />}
						Follow
					</Button>
				</div>
			</form>
		</div>
	);
}
