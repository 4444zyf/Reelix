import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChat } from "../../lib/chat";
import type { Candidate, Card, Download, IndexerOutcome, PlanItem, PlayTarget, PluginCardData, Release, SubtitleSearch, Title } from "../../lib/types";
import { PlayCard } from "../media/PlayButton";
import { Markdown } from "../common/Markdown";
import { SubtitleResults } from "../media/Subtitles";
import { Captions } from "lucide-react";
import { CandidatesCard } from "./CandidatesCard";
import { CardShell } from "./CardShell";
import { DownloadsCard } from "./DownloadsCard";
import { ImageCard, VerificationCard } from "./ImageCard";
import { PlanCard } from "./PlanCard";
import { PluginCard } from "./PluginCard";
import { ProgressCard } from "./ProgressCard";
import { ReleasesCard } from "./ReleasesCard";
import { TitleCard } from "./TitleCard";

/**
 * A card in a conversation. Buttons either answer the agent or run the operation directly and
 * then leave a short note in the thread so the agent knows what the owner did (design §7.2).
 */
export function ChatCard({ card, threadId }: { card: Card; threadId?: string }) {
	const { t } = useTranslation("chat");
	const { note, askAbout } = useChat();
	const tell = (text: string) => {
		if (threadId) void note(threadId, text);
	};
	const c = card as Record<string, any>;
	switch (card.kind) {
		case "play":
			return c.play ? <PlayCard target={c.play as PlayTarget} /> : null;
		case "title":
			return c.title ? <TitleCard title={c.title as Title} /> : null;
		case "candidates":
			return <CandidatesCard candidates={(c.candidates ?? []) as Candidate[]} onPick={threadId ? (x) => tell(x.year ? t("cards.agent.candidateYear", { name: x.name, year: x.year, id: x.id }) : t("cards.agent.candidate", { name: x.name, id: x.id })) : undefined} />;
		case "releases":
			return (
				<ReleasesCard
					releases={(c.releases ?? []) as Release[]}
					pick={c.pick as string | undefined}
					reason={c.reason as string | undefined}
					total={c.total as number | undefined}
					indexers={c.indexers as IndexerOutcome[] | undefined}
					onDownloaded={(r, out) => tell(t(out.adopted ? "cards.agent.downloadedAdopted" : "cards.agent.downloaded", { handle: r.handle, title: r.title, hash: out.hash.slice(0, 10) }))}
				/>
			);
		case "plan":
			return (
				<PlanCard
					items={(c.items ?? []) as PlanItem[]}
					problems={c.problems as string[] | undefined}
					results={c.results}
					mode={c.mode as string | undefined}
					reason={c.reason as string | undefined}
					onApplied={(_o, text) => tell(t("cards.agent.planApplied", { text: text.slice(0, 1500) }))}
					onEdit={() => askAbout(t("cards.agent.planEdit"))}
				/>
			);
		case "progress":
			return <ProgressCard hash={String(c.hash ?? "")} name={c.name as string | undefined} />;
		case "downloads":
			return <DownloadsCard downloads={(c.downloads ?? []) as Download[]} />;
		case "image":
			return <ImageCard image={String(c.image)} text={c.text as string | undefined} />;
		case "verification":
			return <VerificationCard image={String(c.image)} text={c.text as string | undefined} onCode={threadId ? (code) => tell(code) : undefined} threadId={threadId} />;
		case "subtitles":
			return (
				<CardShell icon={<Captions />} title={c.title ? t("cards.subtitles.titleFor", { title: String(c.title) }) : t("cards.subtitles.title")}>
					<SubtitleResults data={{ have: [], candidates: [], errors: [], ...(c as object) } as SubtitleSearch} fetchLabel={t("cards.subtitles.use")} onFetch={threadId ? async (s) => tell(s.title ? t("cards.agent.subtitleTitled", { ref: s.ref, title: s.title }) : t("cards.agent.subtitle", { ref: s.ref })) : undefined} />
				</CardShell>
			);
		case "text":
			return (
				<CardShell icon={<FileText />}>
					<Markdown text={String(c.text ?? "")} />
				</CardShell>
			);
		case "plugin":
			return <PluginCard card={card as PluginCardData} onPressed={(label, text) => tell(t("cards.agent.pressed", { label, plugin: c.plugin, text: text.slice(0, 1500) }))} />;
		default:
			return null;
	}
}
