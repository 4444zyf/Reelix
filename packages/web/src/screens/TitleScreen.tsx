import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Captions, CheckCircle2, Map as MapIcon, Rss, Download as DownloadIcon, FileVideo, NotebookPen, Search, Star, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { AskAbout, Why } from "../components/common/AskAbout";
import { Badge, StateBadge } from "../components/common/Badge";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import { Poster } from "../components/common/Poster";
import { Screen } from "../components/common/Screen";
import { Empty, ErrorState, Loading, Spinner } from "../components/common/States";
import { toast } from "../components/hooks/use-toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { endpoints, runOp } from "../lib/api";
import { useChat } from "../lib/chat";
import { FollowsPanel } from "../components/media/Follows";
import { SubtitlesPanel } from "../components/media/Subtitles";
import type { Title, TitleShow } from "../lib/types";
import { cn, episodeLabel, formatDateTime, percent, timeAgo, titleLabel, formatNumber } from "../lib/utils";
import { PlayButton } from "../components/media/PlayButton";
import { useShortPath } from "../lib/paths";

type Level = "entry" | "torrent" | "data";

const LEVELS: { level: Level }[] = [{ level: "entry" }, { level: "torrent" }, { level: "data" }];

function parseEpisodes(s: string): number[] | undefined {
	const out: number[] = [];
	for (const part of s.split(/[,\s]+/).filter(Boolean)) {
		const m = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!m) return undefined;
		const a = Number(m[1]);
		const b = m[2] ? Number(m[2]) : a;
		for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
	}
	return out;
}

function RemoveDialog({ data, open, onOpenChange }: { data: TitleShow; open: boolean; onOpenChange: (o: boolean) => void }) {
	const { t: tr } = useTranslation("library");
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [level, setLevel] = useState<Level>("entry");
	const [season, setSeason] = useState("");
	const [episodes, setEpisodes] = useState("");
	const t = data.title;
	const isShow = t.kind === "tv" || t.media_class === "show" || t.media_class === "anime";
	const eps = episodes.trim() ? parseEpisodes(episodes) : [];
	const valid = eps !== undefined && (!episodes.trim() || season.trim() !== "");
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={(o) => {
				onOpenChange(o);
				if (!o) {
					setLevel("entry");
					setSeason("");
					setEpisodes("");
				}
			}}
			title={tr("remove.title", { title: titleLabel(t) })}
			description={season ? (episodes.trim() ? tr("remove.descEpisodes", { season, episodes: episodes.trim() }) : tr("remove.descSeason", { season })) : tr("remove.descWhole")}
			destructive
			disabled={!valid}
			confirmLabel={level === "data" ? tr("remove.confirmData") : level === "torrent" ? tr("remove.confirmTorrent") : tr("remove.confirmEntry")}
			onConfirm={async () => {
				const r = await runOp("library.remove", { title_id: t.id, level, season: season ? Number(season) : undefined, episodes: eps?.length ? eps : undefined });
				toast({ title: tr("remove.done"), description: r.text.slice(0, 300) });
				await qc.invalidateQueries({ queryKey: ["title", t.id] });
				qc.invalidateQueries({ queryKey: ["library"] });
				qc.invalidateQueries({ queryKey: ["downloads"] });
				if (!season && level !== "entry") navigate("/library");
			}}
		>
			<div className="space-y-2">
				{LEVELS.map((l) => (
					<label key={l.level} className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors", level === l.level ? (l.level === "data" ? "border-destructive-foreground/60 bg-destructive/15" : "border-primary/60 bg-primary/10") : "border-border hover:bg-surface-hover")}>
						<input type="radio" name="level" className="mt-1 accent-[var(--color-primary)]" checked={level === l.level} onChange={() => setLevel(l.level)} />
						<span>
							<span className="block text-sm font-medium">{tr(`remove.levels.${l.level}.label`)}</span>
							<span className="block text-xs text-muted-foreground">{tr(`remove.levels.${l.level}.detail`)}</span>
						</span>
					</label>
				))}
				{isShow && (
					<div className="grid grid-cols-[100px_1fr] items-center gap-2 pt-1 text-sm">
						<span className="text-muted-foreground">{tr("remove.season")}</span>
						<Input value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, ""))} placeholder={tr("remove.seasonPlaceholder")} inputMode="numeric" className="h-9" />
						<span className="text-muted-foreground">{tr("remove.episodes")}</span>
						<Input value={episodes} onChange={(e) => setEpisodes(e.target.value)} placeholder={tr("remove.episodesPlaceholder")} className="h-9" disabled={!season} />
					</div>
				)}
				{eps === undefined && <p className="text-xs text-destructive-foreground">{tr("remove.episodesInvalid")}</p>}
			</div>
		</ConfirmDialog>
	);
}

/** Run one operation for this title and show what it said. */
function OpButton({ op, input, icon, label }: { op: string; input: object; icon: React.ReactNode; label: string }) {
	const { t: tr } = useTranslation("library");
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-8 justify-start px-2 text-muted-foreground"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const r = await runOp(op, input);
					toast({ title: label, description: r.text.slice(0, 400) });
					qc.invalidateQueries({ queryKey: ["title"] });
				} catch (e) {
					toast({ title: tr("title.opFailed", { label }), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : icon}
			{label}
		</Button>
	);
}

/** Where the title will be filed, when its media type has several library folders (docs/library-folders.md). */
function LibraryFolderChoice({ id, library }: { id: string; library: TitleShow["library"] }) {
	const { t: tr } = useTranslation("library");
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	const d = library.decided;
	const choose = async (folder: string) => {
		setBusy(true);
		try {
			await runOp("title.library_folder.set", { id, folder });
			await qc.invalidateQueries({ queryKey: ["title", id] });
		} catch (e) {
			toast({ title: tr("title.libraryFolderFailed"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(false);
		}
	};
	const why = !d ? tr("title.libraryFolderUndecided") : d.how === "rule" ? tr("title.libraryFolderRule", { rule: Object.entries(d.rule ?? {}).map(([k, v]) => `${k} ${v.join("/")}`).join(", ") }) : tr(`title.libraryFolderHow.${d.how}`);
	return (
		<div className="mb-3 grid gap-1">
			<label htmlFor="library-folder" className="text-xs font-medium">
				{tr("title.libraryFolder")}
			</label>
			<select id="library-folder" disabled={busy} value={library.choice ?? ""} onChange={(e) => void choose(e.target.value)} className="h-9 rounded-md border border-input bg-background px-2 text-sm">
				<option value="">{d && d.how !== "chosen" ? tr("title.libraryFolderAutoIs", { name: library.folders.find((f) => f.path === d.path)?.name ?? d.path }) : tr("title.libraryFolderAuto")}</option>
				{library.folders.map((f) => (
					<option key={f.path} value={f.path}>
						{f.name}
					</option>
				))}
			</select>
			<p className="text-xs text-muted-foreground">{why}</p>
		</div>
	);
}

function Section({ title, icon, children, actions }: { title: string; icon: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode }) {
	return (
		<section className="surface-card rounded-xl p-4">
			<div className="mb-3 flex items-center gap-2">
				<span className="text-primary [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
				<h2 className="text-sm font-semibold">{title}</h2>
				<div className="ml-auto">{actions}</div>
			</div>
			{children}
		</section>
	);
}

function NoteEditor({ t }: { t: Title }) {
	const { t: tr } = useTranslation("library");
	const qc = useQueryClient();
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div className="space-y-2">
			{t.notes ? <p className="whitespace-pre-wrap rounded-md bg-surface p-2 text-sm">{t.notes}</p> : <p className="text-sm text-muted-foreground">{tr("title.noNotes")}</p>}
			<form
				className="flex gap-2"
				onSubmit={async (e) => {
					e.preventDefault();
					if (!note.trim()) return;
					setBusy(true);
					try {
						await runOp("title.note", { id: t.id, note: note.trim() });
						setNote("");
						await qc.invalidateQueries({ queryKey: ["title", t.id] });
					} catch (err) {
						toast({ title: tr("title.noteFailed"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
					} finally {
						setBusy(false);
					}
				}}
			>
				<Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("title.addNote")} className="h-9" />
				<Button type="submit" size="sm" className="h-9" disabled={busy || !note.trim()}>
					{busy && <Spinner />}
					{tr("title.add")}
				</Button>
			</form>
		</div>
	);
}

function MediaClassPicker({ t }: { t: Title }) {
	const { t: tr } = useTranslation("library");
	const qc = useQueryClient();
	const [busy, setBusy] = useState(false);
	return (
		<select
			value={t.media_class ?? ""}
			disabled={busy}
			className="h-8 rounded-md border border-input bg-background px-2 text-xs"
			onChange={async (e) => {
				setBusy(true);
				try {
					await runOp("title.set", { id: t.id, media_class: e.target.value });
					await qc.invalidateQueries({ queryKey: ["title", t.id] });
					qc.invalidateQueries({ queryKey: ["library"] });
				} catch (err) {
					toast({ title: tr("title.notChanged"), description: err instanceof Error ? err.message : String(err), variant: "destructive" });
				} finally {
					setBusy(false);
				}
			}}
			aria-label={tr("title.mediaClass")}
		>
			<option value="movie">{tr("kinds.movie")}</option>
			<option value="show">{tr("kinds.show")}</option>
			<option value="anime">{tr("kinds.anime")}</option>
		</select>
	);
}

/** A title: files, downloads with "why?", notes, follows, history and remove at three levels. */
export function TitleScreen() {
	const { t: tr } = useTranslation("library");
	const short = useShortPath();
	const { titleId = "" } = useParams();
	const id = decodeURIComponent(titleId);
	const { askAbout } = useChat();
	const { data, isLoading, error, refetch } = useQuery({ queryKey: ["title", id], queryFn: () => endpoints.titleShow(id) });
	const play = useQuery({ queryKey: ["play", id], queryFn: () => endpoints.titlePlay(id), staleTime: 60_000 });
	const history = useQuery({ queryKey: ["activity", { title_id: id }], queryFn: () => endpoints.activity({ title_id: id, limit: 20 }) });
	// A plugin's operation is offered only while its plugin runs.
	const plugins = useQuery({ queryKey: ["plugins"], queryFn: endpoints.plugins, staleTime: 60_000 });
	const has = (operation: string) => !!plugins.data?.some((p) => p.state === "active" && p.operations.includes(operation));
	const [remove, setRemove] = useState(false);
	const back = (
		<Button asChild variant="ghost" size="icon" className="shrink-0">
			<Link to="/library" aria-label={tr("title.backToLibrary")}>
				<ArrowLeft />
			</Link>
		</Button>
	);
	if (isLoading)
		return (
			<Screen title={tr("title.fallbackTitle")} back={back}>
				<Loading />
			</Screen>
		);
	if (error || !data)
		return (
			<Screen title={tr("title.fallbackTitle")} back={back}>
				<ErrorState error={error ?? tr("title.notFound")} onRetry={() => refetch()} />
			</Screen>
		);
	const t = data.title;
	const desc = `${titleLabel(t)} [${t.id}]`;
	return (
		<Screen
			title={t.name}
			subtitle={[t.original_name !== t.name ? t.original_name : null, t.year].filter(Boolean).join(" · ")}
			back={back}
			actions={(scrolled) => (
				<>
					{play.data?.in_library && <PlayButton target={play.data} size={scrolled ? "sm" : "default"} />}
					<Button asChild size={scrolled ? "sm" : "default"} variant="outline" className="hidden sm:inline-flex">
						<Link to={`/trends?title=${encodeURIComponent(t.id)}`}>
							<Search /> {tr("title.releases")}
						</Link>
					</Button>
					<Button size={scrolled ? "sm" : "default"} variant="destructive" onClick={() => setRemove(true)}>
						<Trash2 />
						<span className="hidden sm:inline">{tr("title.remove")}</span>
					</Button>
				</>
			)}
		>
			<div className="grid gap-4 lg:grid-cols-[240px_1fr]">
				<div className="space-y-3">
					<Poster path={t.poster_path} alt={t.name} size="w500" className="mx-auto w-40 sm:w-52 lg:w-full" />
					<div className="flex flex-wrap gap-1">
						<Badge tone="muted">{t.id}</Badge>
						{t.rating ? (
							<Badge tone="warning">
								<Star className="h-3 w-3" /> {formatNumber(Number(t.rating), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
							</Badge>
						) : null}
						{Object.entries(t.ratings ?? {}).map(([id, r]) => (
							<Badge key={id} tone="success">
								{r.label} {r.value}
							</Badge>
						))}
						{t.runtime_min ? <Badge tone="muted">{tr("title.runtime", { min: t.runtime_min })}</Badge> : null}
						{t.imdb_id && <Badge tone="muted">{t.imdb_id}</Badge>}
					</div>
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						{tr("title.kind")} <MediaClassPicker t={t} />
					</div>
					<div className="flex flex-col gap-1">
						<Button asChild variant="outline" size="sm" className="sm:hidden">
							<Link to={`/trends?title=${encodeURIComponent(t.id)}`}>
								<Search /> {tr("title.findReleases")}
							</Link>
						</Button>
						<AskAbout text={tr("title.aboutPrompt", { desc })} className="justify-start" />
						<Button variant="ghost" size="sm" className="h-8 justify-start px-2 text-muted-foreground" onClick={() => askAbout(tr("title.fixMatchPrompt", { desc }))}>
							<Wrench /> {tr("title.fixMatch")}
						</Button>
						<Button variant="ghost" size="sm" className="h-8 justify-start px-2 text-muted-foreground" onClick={() => askAbout(tr("title.refilePrompt", { desc }))}>
							<FileVideo /> {tr("title.refile")}
						</Button>
						{has("douban.rating") && <OpButton op="douban.rating" input={{ title_id: t.id }} icon={<Star />} label={tr("title.refreshDouban")} />}
						{t.media_class === "anime" && <OpButton op="anime.map" input={{ title_id: t.id }} icon={<MapIcon />} label={tr("title.mapBangumi")} />}
					</div>
				</div>

				<div className="min-w-0 space-y-4">
					{t.overview && <p className="text-sm leading-relaxed text-muted-foreground">{t.overview}</p>}
					{t.seasons && t.seasons.length > 0 && (
						<div className="flex flex-wrap gap-1">
							{t.seasons.map((s) => {
								const have = data.have.episodes.filter((e) => e.season === s.season_number).length;
								return (
									<Badge key={s.season_number} tone={have >= s.episode_count && s.episode_count > 0 ? "success" : have ? "primary" : "muted"}>
										{tr("title.seasonBadge", { season: s.season_number, have, total: s.episode_count })}
									</Badge>
								);
							})}
						</div>
					)}

					<Section title={tr("title.files", { n: data.files.length })} icon={<FileVideo />}>
						{!data.have.folder && data.library.folders.length > 1 && <LibraryFolderChoice id={t.id} library={data.library} />}
						{data.have.folder && <p className="mb-2 break-all text-xs text-muted-foreground">{tr("title.folder", { folder: short(data.have.folder) })}</p>}
						{data.files.length === 0 ? (
							<p className="text-sm text-muted-foreground">{tr("title.noFiles")}</p>
						) : (
							<div className="space-y-1">
								{data.files.map((f) => (
									<div key={f.id} className="flex items-start gap-2 rounded-md bg-surface px-2.5 py-1.5 text-xs">
										{f.exists ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />}
										<span className="min-w-0 flex-1 break-all">{short(f.dest, data.have.folder)}</span>
										<span className="flex shrink-0 gap-1">
											{(() => {
												const e = f.kind === "video" && f.episodes[0] ? play.data?.episodes?.find((x) => x.season === f.episodes[0]!.season && x.episode === f.episodes[0]!.episode) : undefined;
												return e && play.data ? <PlayButton target={{ ...play.data, season: e.season, episode: e.episode, links: e.links }} compact /> : null;
											})()}
											{f.episodes.length > 0 && <Badge tone="info">{episodeLabel(f.episodes)}</Badge>}
											<Badge tone="muted">{f.kind}</Badge>
											{!f.exists && <Badge tone="warning">{tr("title.missing")}</Badge>}
										</span>
									</div>
								))}
							</div>
						)}
					</Section>

					<Section title={tr("title.downloads", { n: data.downloads.length })} icon={<DownloadIcon />} actions={<Link to="/downloads" className="text-xs text-primary hover:underline">{tr("title.allDownloads")}</Link>}>
						{data.downloads.length === 0 ? (
							<p className="text-sm text-muted-foreground">{tr("title.noDownloads")}</p>
						) : (
							<div className="space-y-2">
								{data.downloads.map((d) => (
									<div key={d.hash} className="rounded-md bg-surface px-2.5 py-2 text-xs">
										<div className="flex items-start justify-between gap-2">
											<p className="min-w-0 break-all font-medium">{d.name}</p>
											<StateBadge state={d.state} />
										</div>
										{d.state === "downloading" && <Progress value={percent(d.progress)} className="mt-1.5 h-1" />}
										<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
											<span>{tr("title.addedAgo", { ago: timeAgo(d.added_at) })}</span>
											<span className="font-mono">{d.hash.slice(0, 10)}</span>
											<Why reason={d.reason} />
										</div>
									</div>
								))}
							</div>
						)}
					</Section>

					<Section title={tr("title.subtitles")} icon={<Captions />}>
						<SubtitlesPanel title={t} />
					</Section>

					{t.kind === "tv" && (
						<Section title={tr("title.following")} icon={<Rss />}>
							<FollowsPanel title={t} />
						</Section>
					)}

					<Section title={tr("title.notes")} icon={<NotebookPen />}>
						<NoteEditor t={t} />
					</Section>

					<Section title={tr("title.history")} icon={<NotebookPen />} actions={<Link to="/activity" className="text-xs text-primary hover:underline">{tr("title.activity")}</Link>}>
						{history.isLoading ? (
							<Spinner />
						) : !history.data?.length ? (
							<Empty title={tr("title.noHistory")} />
						) : (
							<div className="space-y-1 text-xs">
								{history.data.map((a) => (
									<div key={a.id} className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-2.5 py-1.5">
										<StateBadge state={a.status} />
										<span className="font-medium">{a.op}</span>
										<span className="text-muted-foreground">{a.actor}</span>
										<span className="ml-auto text-muted-foreground" title={formatDateTime(a.started_at)}>
											{timeAgo(a.started_at)}
										</span>
										{a.error && <span className="w-full text-destructive-foreground">{a.error}</span>}
									</div>
								))}
							</div>
						)}
					</Section>
				</div>
			</div>
			<RemoveDialog data={data} open={remove} onOpenChange={setRemove} />
		</Screen>
	);
}
