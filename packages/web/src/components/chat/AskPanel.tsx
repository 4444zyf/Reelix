import { HelpCircle, KeyRound, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChat } from "../../lib/chat";
import type { Ask } from "../../lib/types";
import { Spinner } from "../common/States";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The agent's open question: buttons for choice/confirm, a text field, or a password field for
 * kind=secret. A secret goes straight to the server's secrets file and is never shown again.
 */
export function AskPanel({ ask }: { ask: Ask }) {
	const { t } = useTranslation(["chat", "common"]);
	const { answer } = useChat();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState<string>();
	useEffect(() => setValue(""), [ask.id]);
	const submit = async (v: string) => {
		setBusy(v || "(empty)");
		const ok = await answer(v);
		setBusy(undefined);
		if (ok) setValue("");
	};
	const isSecret = ask.kind === "secret";
	const options = ask.options?.length ? ask.options : ask.kind === "confirm" ? [t("common:actions.yes"), t("common:actions.no")] : [];
	return (
		<div className="raised rounded-xl p-3">
			<div className="mb-2 flex items-start gap-2 text-sm">
				{isSecret ? <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
				<p className="whitespace-pre-wrap">{ask.question}</p>
			</div>
			{options.length > 0 && (ask.kind === "choice" || ask.kind === "confirm") ? (
				<div className="flex flex-wrap gap-2">
					{options.map((o) => (
						<Button key={o} size="sm" variant="outline" disabled={!!busy} onClick={() => submit(o)}>
							{busy === o && <Spinner />}
							{o}
						</Button>
					))}
				</div>
			) : (
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (value || isSecret) void submit(value);
					}}
				>
					<Input
						type={isSecret ? "password" : "text"}
						autoComplete={isSecret ? "new-password" : "off"}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={isSecret ? (ask.secret_key ?? t("ask.secret")) : t("ask.answerPlaceholder")}
						className="h-9"
						autoFocus
					/>
					<Button type="submit" size="sm" className="h-9" disabled={!!busy || (!isSecret && !value)}>
						{busy ? <Spinner /> : <Send />}
						{isSecret ? t("common:actions.save") : t("ask.send")}
					</Button>
					{isSecret && (
						<Button type="button" size="sm" variant="ghost" className="h-9" disabled={!!busy} onClick={() => submit("")}>
							{t("ask.skip")}
						</Button>
					)}
				</form>
			)}
			{isSecret && <p className="mt-1.5 text-[11px] text-muted-foreground">{t("ask.secretNote", { key: ask.secret_key })}</p>}
			{!isSecret && options.length > 0 && <p className="mt-1.5 text-[11px] text-muted-foreground">{t("ask.orType")}</p>}
		</div>
	);
}
