import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { runOp } from "../../lib/api";
import { LANGUAGES, type Lang, isLang, setLanguage } from "../../lib/i18n";
import type { Session } from "../../lib/types";
import { toast } from "../hooks/use-toast";
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "../ui/dropdown-menu";

/**
 * Change the owner's language: saved on the server (the agent's own messages, inbox notices and
 * Telegram follow it) and applied to this browser.
 */
export function useChangeLanguage() {
	const qc = useQueryClient();
	const { t } = useTranslation("appearance");
	return async (l: Lang) => {
		try {
			await runOp("config.set", { path: "language", value: l });
		} catch (e) {
			toast({ title: t("language"), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
		}
		qc.setQueryData<Session>(["session"], (s) => (s ? { ...s, language: l } : s));
		setLanguage(l);
	};
}

export function LanguagePickerItems() {
	const { i18n } = useTranslation();
	const change = useChangeLanguage();
	return (
		<DropdownMenuRadioGroup value={i18n.language} onValueChange={(v) => isLang(v) && void change(v)}>
			{LANGUAGES.map((l) => (
				<DropdownMenuRadioItem key={l.id} value={l.id} lang={l.html}>
					{l.native}
				</DropdownMenuRadioItem>
			))}
		</DropdownMenuRadioGroup>
	);
}
