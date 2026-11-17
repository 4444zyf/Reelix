import { FileText } from "lucide-react";
import { useChat } from "../../lib/chat";
import type { Candidate, Card, Download, IndexerOutcome, PlanItem, Release, SubtitleSearch, Title } from "../../lib/types";
import { Markdown } from "../common/Markdown";
import { SubtitleResults } from "../media/Subtitles";
import { Captions } from "lucide-react";
import { CandidatesCard } from "./CandidatesCard";
import { CardShell } from "./CardShell";
import { DownloadsCard } from "./DownloadsCard";
import { GenericCard } from "./GenericCard";
import { ImageCard, VerificationCard } from "./ImageCard";
import { PlanCard } from "./PlanCard";
import { ProgressCard } from "./ProgressCard";
import { ReleasesCard } from "./ReleasesCard";
import { TitleCard } from "./TitleCard";

/**
 * A card in a conversation. Buttons either answer the agent or run the operation directly and
 * then leave a short note in the thread so the agent knows what the owner did (design §7.2).
 */
export function ChatCard({ card, threadId }: { card: Card; threadId?: string }) {
	const { note, askAbout } = useChat();
	const tell = (text: string) => {
		if (threadId) void note(threadId, text);
	};
	const c = card as Record<string, any>;
	switch (card.kind) {
		case "title":
			return c.title ? <TitleCard title={c.title as Title} /> : null;
		case "candidates":
			return <CandidatesCard candidates={(c.candidates ?? []) as Candidate[]} onPick={threadId ? (x) => tell(`It is ${x.name}${x.year ? ` (${x.year})` : ""}, ${x.id}.`) : undefined} />;
		case "releases":
			return (
				<ReleasesCard
					releases={(c.releases ?? []) as Release[]}
					pick={c.pick as string | undefined}
					reason={c.reason as string | undefined}
					total={c.total as number | undefined}
					indexers={c.indexers as IndexerOutcome[] | undefined}
					onDownloaded={(r, out) => tell(`I downloaded release ${r.handle} ("${r.title}") from the list${out.adopted ? " (it was already in qBittorrent and was adopted)" : ""}. Hash ${out.hash.slice(0, 10)}.`)}
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
					onApplied={(_o, text) => tell(`I approved the plan and it was applied:\n${text.slice(0, 1500)}`)}
					onEdit={() => askAbout("About the plan above, change this: ")}
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
				<CardShell icon={<Captions />} title={`Subtitles${c.title ? ` for ${String(c.title)}` : ""}`}>
					<SubtitleResults data={{ have: [], candidates: [], errors: [], ...(c as object) } as SubtitleSearch} fetchLabel="Use this" onFetch={threadId ? async (s) => tell(`Use subtitle ${s.ref}${s.title ? ` ("${s.title}")` : ""}.`) : undefined} />
				</CardShell>
			);
		case "text":
			return (
				<CardShell icon={<FileText />}>
					<Markdown text={String(c.text ?? "")} />
				</CardShell>
			);
		default:
			return <GenericCard card={card as { kind: string }} />;
	}
}
