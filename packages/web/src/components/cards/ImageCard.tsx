import { KeyRound, MonitorPlay, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Markdown } from "../common/Markdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CardShell } from "./CardShell";

export function ImageCard({ image, text }: { image: string; text?: string }) {
	const { t } = useTranslation("chat");
	return (
		<CardShell>
			<a href={image} target="_blank" rel="noreferrer">
				<img src={image} alt={text ?? t("cards.image.alt")} className="max-h-[420px] w-auto max-w-full rounded-lg border border-line" />
			</a>
			{text && <Markdown text={text} className="mt-2 text-xs text-muted-foreground" />}
		</CardShell>
	);
}

/** A screenshot or QR code with a field for a code (sent as a message) and "open live view". */
export function VerificationCard({ image, text, onCode, threadId }: { image: string; text?: string; onCode?: (code: string) => void; threadId?: string }) {
	const { t } = useTranslation("chat");
	const [code, setCode] = useState("");
	const [sent, setSent] = useState(false);
	return (
		<CardShell icon={<KeyRound />} title={t("cards.verification.title")}>
			{text && <Markdown text={text} className="mb-2 text-xs" />}
			<a href={image} target="_blank" rel="noreferrer">
				<img src={image} alt={t("cards.verification.alt")} className="max-h-[420px] w-auto max-w-full rounded-lg border border-line bg-white" />
			</a>
			{onCode && (
				<form
					className="mt-3 flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (!code.trim()) return;
						onCode(code.trim());
						setSent(true);
						setCode("");
					}}
				>
					<Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={sent ? t("cards.verification.codeSent") : t("cards.verification.code")} autoComplete="one-time-code" className="h-9" />
					<Button type="submit" size="sm" className="h-9" disabled={!code.trim()}>
						<Send /> {t("cards.verification.send")}
					</Button>
				</form>
			)}
			<Button asChild variant="outline" size="sm" className="mt-2 h-8">
				<Link to={threadId ? `/browser?thread=${encodeURIComponent(threadId)}` : "/browser"}>
					<MonitorPlay /> {t("cards.verification.liveView")}
				</Link>
			</Button>
		</CardShell>
	);
}
