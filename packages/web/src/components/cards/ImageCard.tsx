import { KeyRound, MonitorPlay, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Markdown } from "../common/Markdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { CardShell } from "./CardShell";

export function ImageCard({ image, text }: { image: string; text?: string }) {
	return (
		<CardShell>
			<a href={image} target="_blank" rel="noreferrer">
				<img src={image} alt={text ?? "image from the agent"} className="max-h-[420px] w-auto max-w-full rounded-lg border border-white/5" />
			</a>
			{text && <Markdown text={text} className="mt-2 text-xs text-muted-foreground" />}
		</CardShell>
	);
}

/** A screenshot or QR code with a field for a code (sent as a message) and "open live view". */
export function VerificationCard({ image, text, onCode, threadId }: { image: string; text?: string; onCode?: (code: string) => void; threadId?: string }) {
	const [code, setCode] = useState("");
	const [sent, setSent] = useState(false);
	return (
		<CardShell icon={<KeyRound />} title="Verification needed">
			{text && <Markdown text={text} className="mb-2 text-xs" />}
			<a href={image} target="_blank" rel="noreferrer">
				<img src={image} alt="verification" className="max-h-[420px] w-auto max-w-full rounded-lg border border-white/5 bg-white" />
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
					<Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={sent ? "Code sent. Another one?" : "Code"} autoComplete="one-time-code" className="h-9" />
					<Button type="submit" size="sm" className="h-9" disabled={!code.trim()}>
						<Send /> Send
					</Button>
				</form>
			)}
			<Button asChild variant="outline" size="sm" className="mt-2 h-8">
				<Link to={threadId ? `/browser?thread=${encodeURIComponent(threadId)}` : "/browser"}>
					<MonitorPlay /> Open live view
				</Link>
			</Button>
		</CardShell>
	);
}
