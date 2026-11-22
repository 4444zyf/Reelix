import { Check, Languages, MonitorSmartphone, Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../../lib/i18n";
import { type ThemeManifest, findTheme, localized, resolve, themeAttrs, useTheme } from "../../lib/theme";
import { cn } from "../../lib/utils";
import { Searchable, Section } from "../settings/form";
import { Badge } from "./Badge";
import { useChangeLanguage } from "./LanguageMenu";

/** A miniature of a theme drawn with its own tokens (the theme attributes scope them). */
function Miniature({ id }: { id: string }) {
	return (
		<div {...themeAttrs(id)} className="ambient pointer-events-none flex h-28 overflow-hidden rounded-md border border-line text-foreground">
			<div className="flex w-8 flex-col items-center gap-1.5 border-r border-line pt-2">
				<span className="display text-[11px] leading-none text-primary">R</span>
				<span className="h-3 w-4 rounded-sm bg-nav-active" />
				<span className="h-1 w-3 rounded bg-muted-foreground/40" />
				<span className="h-1 w-3 rounded bg-muted-foreground/40" />
			</div>
			<div className="flex flex-1 flex-col gap-1.5 p-2">
				<span className="user-msg ml-auto px-2 py-0.5 text-[8px] leading-tight">
					<span className="user-text">Sintel 2010</span>
				</span>
				<div className="feature flex gap-2 p-1.5">
					<span className="h-10 w-7 shrink-0 rounded-sm bg-gradient-to-b from-info/70 to-background" />
					<div className="min-w-0">
						<p className="display text-[13px] leading-none">Sintel</p>
						<p className="mt-1 text-[7px] text-muted-foreground">2010 · 15 min</p>
						<span className="mt-1 block h-1 w-16 overflow-hidden rounded bg-muted">
							<span className="block h-full w-2/3 bg-primary" />
						</span>
					</div>
				</div>
				<span className="raised mt-auto h-3.5 rounded-[min(var(--radius-control),0.5rem)]" />
			</div>
		</div>
	);
}

function ThemeCard({ id, name, description, on, onPick, installed, footnote }: { id: string; name: string; description: string; on: boolean; onPick: () => void; installed?: boolean; footnote?: string }) {
	const { t } = useTranslation("appearance");
	return (
		<button type="button" role="radio" aria-checked={on} onClick={onPick} className={cn("rounded-lg border p-2 text-left transition-colors", on ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground/50")}>
			<Miniature id={id} />
			<div className="mt-2 flex items-center gap-1.5 px-0.5">
				{footnote && <MonitorSmartphone className="h-3.5 w-3.5 text-muted-foreground" />}
				<span className="text-sm font-semibold">{name}</span>
				{installed && <Badge tone="muted">{t("installed")}</Badge>}
				{on && <Check className="ml-auto h-4 w-4 text-primary" />}
			</div>
			<p className="px-0.5 text-xs text-muted-foreground">{footnote ?? description}</p>
		</button>
	);
}

export function ThemePicker() {
	const { t } = useTranslation("appearance");
	const { choice, themes, setTheme } = useTheme();
	const name = (m?: ThemeManifest) => localized(m?.name) || m?.id || "";
	return (
		<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={t("theme")}>
			{themes.map((m) => (
				<ThemeCard key={m.id} id={m.id} name={name(m)} description={[localized(m.description), m.installed && m.author ? `— ${m.author}` : ""].filter(Boolean).join(" ")} on={choice === m.id} installed={m.installed} onPick={() => setTheme(m.id)} />
			))}
			<ThemeCard id={resolve("auto")} name={t("matchDevice")} description="" footnote={t("matchDeviceDescription", { dark: name(findTheme("marquee")), light: name(findTheme("paper")) })} on={choice === "auto"} onPick={() => setTheme("auto")} />
		</div>
	);
}

export function LanguagePicker() {
	const { t, i18n } = useTranslation("appearance");
	const pick = useChangeLanguage();
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("language")}>
				{LANGUAGES.map((l) => {
					const on = i18n.language === l.id;
					return (
						<button key={l.id} type="button" role="radio" aria-checked={on} lang={l.html} onClick={() => void pick(l.id)} className={cn("rounded-control border px-4 py-2 text-sm transition-colors", on ? "border-primary bg-primary/10 font-semibold text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
							{l.native}
						</button>
					);
				})}
			</div>
			<p className="text-xs text-muted-foreground">{t("languageHint")}</p>
		</div>
	);
}

/** Settings → Appearance: language and theme. */
export function AppearanceSection() {
	const { t } = useTranslation("appearance");
	return (
		<Section id="appearance" icon={<Palette />} title={t("title")} description={t("description")}>
			<Searchable text={[t("language")]} className="space-y-2">
				<p className="flex items-center gap-2 text-sm font-medium">
					<Languages className="h-4 w-4 text-primary" />
					{t("language")}
				</p>
				<LanguagePicker />
			</Searchable>
			<Searchable text={[t("theme"), t("makeYourOwn", { dir: "/data/themes" })]} className="space-y-2">
				<p className="flex items-center gap-2 text-sm font-medium">
					<Palette className="h-4 w-4 text-primary" />
					{t("theme")}
				</p>
				<ThemePicker />
				<p className="text-xs text-muted-foreground">{t("makeYourOwn", { dir: "/data/themes" })}</p>
			</Searchable>
		</Section>
	);
}
