import { Puzzle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import type { PluginCardData } from "../../lib/types";
import { Markdown } from "../common/Markdown";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { CardShell } from "./CardShell";

/**
 * A plugin's card (docs/plugins.md §12.3): Reelix's own components draw what the plugin declared as data.
 * A button runs the plugin's operation as the plugin; what it answers may replace the card.
 */
export function PluginCard({ card, onPressed }: { card: PluginCardData; onPressed?: (label: string, text: string) => void }) {
	const { t } = useTranslation("chat");
	const [shown, setShown] = useState(card);
	const [busy, setBusy] = useState<number>();
	const press = async (b: PluginCardData["buttons"][number]) => {
		setBusy(b.index);
		try {
			const r = await endpoints.pressCard(shown.card, b.index);
			if (r.output.card) setShown(r.output.card);
			toast({ title: b.label, description: r.text });
			onPressed?.(b.label, r.text);
		} catch (e) {
			toast({ title: b.label, description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		} finally {
			setBusy(undefined);
		}
	};
	return (
		<CardShell icon={<Puzzle />} title={shown.title}>
			<p className="mb-2 text-[11px] text-muted-foreground">{t("cards.plugin.from", { plugin: shown.plugin })}</p>
			{shown.layout === "text" ? (
				<Markdown text={shown.text ?? ""} />
			) : shown.rows?.length ? (
				<ul className="space-y-1">
					{shown.rows.map((r, i) => (
						<li key={i} className="rounded-md bg-surface px-2.5 py-1.5 text-sm">
							<p className="break-words">{r.primary}</p>
							{r.secondary && <p className="break-words text-xs text-muted-foreground">{r.secondary}</p>}
						</li>
					))}
					{!!shown.more && <li className="text-xs text-muted-foreground">{t("cards.plugin.more", { count: shown.more })}</li>}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">{shown.empty}</p>
			)}
			{shown.buttons.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-2">
					{shown.buttons.map((b) => (
						<Button key={b.index} size="sm" variant="outline" disabled={busy !== undefined} onClick={() => press(b)}>
							{busy === b.index && <Spinner />}
							{b.label}
						</Button>
					))}
				</div>
			)}
		</CardShell>
	);
}
