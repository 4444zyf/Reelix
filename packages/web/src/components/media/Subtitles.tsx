import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Captions, Check, Download, Search, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints, runOp } from "../../lib/api";
import type { SubtitleCandidate, SubtitleSearch, Title } from "../../lib/types";
import { formatDateTime } from "../../lib/utils";
import { AskAbout } from "../common/AskAbout";
import { Badge } from "../common/Badge";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useShortPath } from "../../lib/paths";

function CandidateRow({ c, onFetch, fetchLabel }: { c: SubtitleCandidate; onFetch?: (c: SubtitleCandidate) => Promise<unknown>; fetchLabel?: string }) {
	const { t } = useTranslation(["media", "common"]);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	return (
		<div className="rounded-md bg-surface px-2.5 py-2 text-xs">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1 space-y-1">
					<p className="break-all font-medium">{c.title ?? c.ref}</p>
					{c.release && <p className="break-all text-muted-foreground">{t("subtitles.forRelease", { release: c.release })}</p>}
					<div className="flex flex-wrap gap-1">
						<Badge tone="muted">{c.source}</Badge>
						{c.hashMatch && <Badge tone="success">{t("subtitles.hashMatch")}</Badge>}
						{c.episode !== undefined && <Badge>{t("subtitles.episode", { episode: c.episode })}</Badge>}
						{c.machine && <Badge tone="warning">{t("subtitles.machine")}</Badge>}
						{c.hearingImpaired && <Badge tone="muted">{t("subtitles.hearingImpaired")}</Badge>}
						{c.languages?.map((l) => (
							<Badge key={l} tone="success">
								{l}
							</Badge>
						))}
						{c.formats?.map((f) => (
							<Badge key={f}>{f}</Badge>
						))}
						{c.tags?.map((tag) => (
							<Badge key={tag} tone="info">
								{tag}
							</Badge>
						))}
					</div>
					<p className="text-muted-foreground">
						{[c.uploader && t("subtitles.by", { uploader: c.uploader }), c.downloads != null && t("subtitles.downloads", { count: c.downloads }), c.date && formatDateTime(c.date)].filter(Boolean).join(" · ")}
						<span className="ml-2 font-mono text-[10px] opacity-70">{c.ref}</span>
					</p>
				</div>
				{onFetch && (
					<Button
						size="sm"
						className="h-8 shrink-0"
						disabled={busy || done}
						onClick={async () => {
							setBusy(true);
							try {
								await onFetch(c);
								setDone(true);
							} catch (e) {
								toast({ title: t("subtitles.notFetched"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? <Spinner /> : done ? <Check /> : <Download />}
						{done ? t("subtitles.done") : (fetchLabel ?? t("subtitles.fetch"))}
					</Button>
				)}
			</div>
		</div>
	);
}

export function SubtitleResults({ data, onFetch, fetchLabel }: { data: SubtitleSearch; onFetch?: (c: SubtitleCandidate) => Promise<unknown>; fetchLabel?: string }) {
	const { t } = useTranslation(["media", "common"]);
	const missing = data.have?.filter((h) => !h.external.length && !h.embeddedWanted?.length).length ?? 0;
	return (
		<div className="space-y-2">
			{data.have?.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{missing ? t("subtitles.summaryMissing", { videos: t("subtitles.videos", { count: data.have.length }), count: missing }) : t("subtitles.summaryAll", { videos: t("subtitles.videos", { count: data.have.length }) })}
				</p>
			)}
			{data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}
			{data.languages?.length ? <p className="text-xs text-muted-foreground">{t("subtitles.wanted", { languages: data.languages.map((l) => t(`subtitles.lang.${l}` as "subtitles.lang.en")).join(" › ") })}</p> : null}
			{data.skipped?.map((s) => (
				<p key={s.source} className="text-xs text-muted-foreground">
					{t("subtitles.needsKey", { source: s.label, keys: s.needs.join(", ") })}
				</p>
			))}
			{data.errors?.map((e, i) => (
				<p key={i} className="text-xs text-warning">
					{e}
				</p>
			))}
			{data.candidates?.length ? (
				data.candidates.map((c) => <CandidateRow key={c.ref} c={c} onFetch={onFetch} fetchLabel={fetchLabel} />)
			) : (
				<p className="text-xs text-muted-foreground">{t("subtitles.noCandidates")}</p>
			)}
		</div>
	);
}

/** Title page: what is placed, search candidates, fetch one, or place a file of your own. */
export function SubtitlesPanel({ title }: { title: Title }) {
	const short = useShortPath();
	const { t } = useTranslation(["media", "common"]);
	const qc = useQueryClient();
	const isShow = title.kind === "tv";
	const [season, setSeason] = useState("");
	const [result, setResult] = useState<SubtitleSearch>();
	const [busy, setBusy] = useState<string>();
	const fileRef = useRef<HTMLInputElement>(null);
	const placed = useQuery({ queryKey: ["subtitles", title.id], queryFn: () => endpoints.subtitleList(title.id) });
	const seasonNum = season ? Number(season) : undefined;

	const search = async () => {
		setBusy("search");
		try {
			setResult(await endpoints.subtitleSearch(title.id, seasonNum));
		} catch (e) {
			toast({ title: t("subtitles.searchFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	const done = (text: string) => {
		toast({ title: t("subtitles.placed"), description: text.slice(0, 300) });
		qc.invalidateQueries({ queryKey: ["subtitles", title.id] });
	};

	const place = async (file: File) => {
		setBusy("place");
		try {
			const up = await endpoints.upload(file);
			const r = await runOp("subtitle.place", { path: up.path, title_id: title.id, season: seasonNum });
			done(r.text);
		} catch (e) {
			toast({ title: t("subtitles.notPlaced"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<div className="space-y-3">
			{placed.data?.length ? (
				<div className="space-y-1">
					{placed.data.map((s) => (
						<div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-2.5 py-1.5 text-xs">
							<Captions className="h-3.5 w-3.5 text-success" />
							<span className="min-w-0 flex-1 break-all">{short(s.path, title.library_folder)}</span>
							{s.language && <Badge tone="success">{s.language}</Badge>}
							{s.format && <Badge>{s.format}</Badge>}
							{s.source && <Badge tone="muted">{s.source}</Badge>}
						</div>
					))}
				</div>
			) : (
				<p className="text-sm text-muted-foreground">{placed.isLoading ? t("common:loading") : t("subtitles.nonePlaced")}</p>
			)}
			<div className="flex flex-wrap items-center gap-2">
				{isShow && <Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder={t("shared.season")} inputMode="numeric" className="h-9 w-24" />}
				<Button size="sm" variant="outline" className="h-9" disabled={!!busy} onClick={search}>
					{busy === "search" ? <Spinner /> : <Search />}
					{t("subtitles.search")}
				</Button>
				<Button size="sm" variant="ghost" className="h-9" disabled={!!busy} onClick={() => fileRef.current?.click()}>
					{busy === "place" ? <Spinner /> : <Upload />}
					{t("subtitles.placeFile")}
				</Button>
				<input
					ref={fileRef}
					type="file"
					hidden
					accept=".srt,.ass,.ssa,.vtt,.sup,.zip,.rar,.7z"
					onChange={(e) => {
						const f = e.target.files?.[0];
						e.target.value = "";
						if (f) void place(f);
					}}
				/>
				<AskAbout className="ml-auto" text={seasonNum ? t("subtitles.askTranslateSeason", { name: title.name, id: title.id, season: seasonNum }) : t("subtitles.askTranslate", { name: title.name, id: title.id })} label={t("subtitles.translate")} />
				<AskAbout text={seasonNum ? t("subtitles.askFindSeason", { name: title.name, id: title.id, season: seasonNum }) : t("subtitles.askFind", { name: title.name, id: title.id })} label={t("shared.letAgentChoose")} />
			</div>
			{result && (
				<SubtitleResults
					data={result}
					onFetch={async (c) => {
						const r = await runOp("subtitle.fetch", { ref: c.ref, title_id: title.id, season: seasonNum });
						done(r.text);
					}}
				/>
			)}
		</div>
	);
}
