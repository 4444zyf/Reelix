import { ChevronDown, Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlayLink, PlayTarget } from "../../lib/types";
import { cn, episodeLabel } from "../../lib/utils";
import { CardShell } from "../cards/CardShell";
import { Poster } from "../common/Poster";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

const KEY = "reelix.player";
/** An app's link, never one that would run something in this page (Reelix checks this too). */
const safe = (l: PlayLink) => /^[a-z][a-z0-9+.-]*:/i.test(l.url) && !/^(javascript|data|vbscript|file|blob|about):/i.test(l.url);
const web = (l: PlayLink) => /^https?:\/\//i.test(l.url);
const saved = () => {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
};

/**
 * Plain links, so the tap itself opens the app. The first choice is remembered on this device;
 * after that one tap plays, and the menu still offers the others (docs/web-app.md, "Playing").
 */
export function PlayButton({ target, compact, size = "default", className }: { target: PlayTarget; compact?: boolean; size?: "default" | "sm"; className?: string }) {
	const { t } = useTranslation("media");
	const [app, setApp] = useState(saved);
	const links = target.links.filter(safe);
	if (!links.length) return null;
	const chosen = links.find((l) => l.app === app) ?? (links.length === 1 ? links[0] : undefined);
	const remember = (a: string) => {
		setApp(a);
		try {
			localStorage.setItem(KEY, a);
		} catch {}
	};
	const label = (l: PlayLink) => t(l.autoplay ? "player.playIn" : "player.openIn", { app: l.label });
	const external = (l: PlayLink) => (web(l) ? { target: "_blank", rel: "noreferrer" } : {});
	const round = "h-11 w-11 rounded-full bg-primary text-primary-foreground shadow-lg";
	const menu = (trigger: React.ReactNode) => (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={compact ? "center" : "end"}>
				{links.map((l) => (
					<DropdownMenuItem key={l.app} asChild>
						<a href={l.url} {...external(l)} onClick={() => remember(l.app)}>
							{label(l)}
						</a>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
	if (compact) {
		const small = target.kind === "tv" && !className;
		const cls = cn(round, small && "h-7 w-7", "inline-flex items-center justify-center", className);
		return chosen ? (
			<a href={chosen.url} {...external(chosen)} className={cls} aria-label={label(chosen)} title={label(chosen)}>
				<Play className={cn("fill-current", small ? "h-3 w-3" : "h-5 w-5")} />
			</a>
		) : (
			menu(
				<button type="button" className={cls} aria-label={t("player.choose")} title={t("player.choose")}>
					<Play className={cn("fill-current", small ? "h-3 w-3" : "h-5 w-5")} />
				</button>,
			)
		);
	}
	return (
		<div className={cn("inline-flex", className)}>
			{chosen ? (
				<Button asChild size={size} className={links.length > 1 ? "rounded-r-none" : undefined}>
					<a href={chosen.url} {...external(chosen)}>
						<Play className="fill-current" />
						{label(chosen)}
					</a>
				</Button>
			) : (
				menu(
					<Button size={size}>
						<Play className="fill-current" />
						{t("player.play")}
						<ChevronDown />
					</Button>,
				)
			)}
			{chosen &&
				links.length > 1 &&
				menu(
					<Button size={size} className="rounded-l-none border-l border-primary-foreground/20 px-2" aria-label={t("player.choose")}>
						<ChevronDown />
					</Button>,
				)}
		</div>
	);
}

/** "I want to watch…" in chat. */
export function PlayCard({ target }: { target: PlayTarget }) {
	const { t } = useTranslation("media");
	const ep = target.episode !== undefined && target.season !== undefined ? episodeLabel([{ season: target.season, episode: target.episode }]) : undefined;
	const usable = target.links.some(safe);
	return (
		<CardShell icon={<Play />} title={target.name}>
			<div className="flex gap-3">
				<Poster path={target.poster_path} alt={target.name} size="w185" className="w-20 shrink-0" />
				<div className="min-w-0 space-y-2">
					<p className="text-sm text-muted-foreground">{[target.year, ep].filter(Boolean).join(" · ")}</p>
					{target.note && <p className="text-xs text-warning">{target.note}</p>}
					{usable ? <PlayButton target={target} /> : <p className="text-sm text-muted-foreground">{target.in_library ? t("player.none") : t("player.notInLibrary")}</p>}
				</div>
			</div>
		</CardShell>
	);
}
