import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { op } from "../../lib/api";
import { Badge } from "../common/Badge";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ErrorState, Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

type Method = { type: "api_key" | "oauth"; name: string };
type Provider = { id: string; name: string; configured: boolean; source?: string; models: number; methods: Method[] };
type AuthEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };
type Question = { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
type Login = { id: string; provider: string; status: "running" | "asking" | "done" | "failed" | "cancelled"; events: AuthEvent[]; question?: Question; error?: string };

const POLL_MS = 1000;
/** The providers most owners have an account with come first; the rest are found by name. */
const FIRST = ["anthropic", "openai", "openai-codex", "google", "openrouter", "deepseek", "xai", "mistral", "github-copilot", "groq"];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The model providers pi knows, signed in or not, each with its ways to sign in (docs/models.md, "Connecting a
 * provider"): in the page, never in a terminal.
 */
export function Providers({ compact }: { compact?: boolean }) {
	const { t } = useTranslation("models");
	const qc = useQueryClient();
	const list = useQuery({ queryKey: ["model.providers"], queryFn: () => op<Provider[]>("model.providers"), retry: false });
	const [login, setLogin] = useState<{ provider: Provider; method: Method }>();
	const [signOut, setSignOut] = useState<Provider>();
	const [find, setFind] = useState("");
	if (list.isLoading) return <Spinner />;
	if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
	const all = list.data ?? [];
	const signedIn = all.filter((p) => p.configured);
	const rank = (p: Provider) => (FIRST.includes(p.id) ? FIRST.indexOf(p.id) : FIRST.length);
	const others = all.filter((p) => !p.configured && p.methods.length).sort((a, b) => rank(a) - rank(b));
	const q = find.trim().toLowerCase();
	const shown = q ? others.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)) : compact ? others.filter((p) => FIRST.includes(p.id)).slice(0, 6) : others;
	const row = (p: Provider) => (
		<li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
			<span className="min-w-[8rem] flex-1 text-sm">
				{p.name}
				{p.configured && <span className="block text-xs text-muted-foreground">{t("providers.models", { count: p.models })}</span>}
			</span>
			{p.configured ? (
				<>
					<Badge tone="success">{t("providers.signedIn")}</Badge>
					{p.source === "stored" && (
						<Button size="sm" variant="ghost" onClick={() => setSignOut(p)}>
							<LogOut /> {t("providers.signOut")}
						</Button>
					)}
				</>
			) : (
				<span className="flex flex-wrap justify-end gap-1">
					{p.methods.map((m) => (
						<Button key={m.type} size="sm" variant="outline" onClick={() => setLogin({ provider: p, method: m })}>
							{m.type === "oauth" ? <LogIn /> : <KeyRound />}
							{t(m.type === "oauth" ? "providers.signIn" : "providers.enterKey")}
						</Button>
					))}
				</span>
			)}
		</li>
	);
	return (
		<div className="space-y-2">
			{signedIn.length > 0 && <ul className="divide-y divide-border rounded-md border border-input">{signedIn.map(row)}</ul>}
			<Input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("providers.find", { count: others.length })} aria-label={t("providers.find", { count: others.length })} className="h-9" />
			{shown.length > 0 ? <ul className="divide-y divide-border rounded-md border border-input">{shown.map(row)}</ul> : q && <p className="text-xs text-muted-foreground">{t("providers.none")}</p>}
			{login && (
				<LoginDialog
					provider={login.provider}
					method={login.method}
					onClose={() => {
						setLogin(undefined);
						void qc.invalidateQueries({ queryKey: ["model.providers"] });
						void qc.invalidateQueries({ queryKey: ["status"] });
					}}
				/>
			)}
			<ConfirmDialog
				open={!!signOut}
				onOpenChange={(o) => !o && setSignOut(undefined)}
				title={t("providers.signOutTitle", { name: signOut?.name })}
				description={t("providers.signOutBody")}
				confirmLabel={t("providers.signOut")}
				destructive
				onConfirm={async () => {
					try {
						await op("model.logout", { provider: signOut!.id });
					} catch (e) {
						toast({ title: message(e), variant: "destructive" });
					}
					setSignOut(undefined);
					await qc.invalidateQueries({ queryKey: ["model.providers"] });
					qc.invalidateQueries({ queryKey: ["status"] });
				}}
			/>
		</div>
	);
}

/** One sign-in, following pi's own steps: a link or a code to show, a key, a code or a choice to give. */
function LoginDialog({ provider, method, onClose }: { provider: Provider; method: Method; onClose: () => void }) {
	const { t } = useTranslation(["models", "common"]);
	const [login, setLogin] = useState<Login>();
	const [error, setError] = useState<string>();
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		void op<Login>("model.login", { provider: provider.id, type: method.type })
			.then((l) => live && setLogin(l))
			.catch((e) => live && setError(message(e)));
		return () => {
			live = false;
		};
	}, [provider.id, method.type]);
	const running = login?.status === "running" || login?.status === "asking";
	useEffect(() => {
		if (!login || !running) return;
		const timer = setInterval(() => void op<Login>("model.login_state", { id: login.id }).then(setLogin).catch(() => undefined), POLL_MS);
		return () => clearInterval(timer);
	}, [login?.id, running]);
	const close = () => {
		if (login && running) void op("model.login_cancel", { id: login.id }).catch(() => undefined);
		onClose();
	};
	const answer = async (v: string) => {
		if (!login?.question) return;
		setBusy(true);
		try {
			setLogin(await op<Login>("model.login_answer", { id: login.id, question: login.question.id, value: v }));
			setValue("");
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	};
	const q = login?.question;
	return (
		<Dialog open onOpenChange={(o) => !o && close()}>
			<DialogContent className="surface-card max-w-lg rounded-xl">
				<DialogHeader>
					<DialogTitle>{t("providers.loginTitle", { name: provider.name })}</DialogTitle>
					<DialogDescription>{method.name}</DialogDescription>
				</DialogHeader>
				<div className="space-y-3 text-sm">
					{!login && !error && <Spinner />}
					{login?.events.map((e, i) =>
						e.type === "auth_url" ? (
							<div key={i} className="space-y-1 rounded-md bg-well p-3">
								<a href={e.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 font-medium text-primary hover:underline">
									<ExternalLink className="size-4" /> {t("providers.openSignIn")}
								</a>
								<p className="text-xs text-muted-foreground">{e.instructions ?? t("providers.afterSignIn")}</p>
							</div>
						) : e.type === "device_code" ? (
							<div key={i} className="space-y-1 rounded-md bg-well p-3">
								<p>{t("providers.deviceCode")}</p>
								<p className="font-mono text-2xl tracking-widest">{e.userCode}</p>
								<a href={e.verificationUri} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 text-primary hover:underline">
									<ExternalLink className="size-4" /> {e.verificationUri}
								</a>
							</div>
						) : e.type === "info" ? (
							<p key={i} className="text-muted-foreground">
								{e.message}{" "}
								{e.links?.map((l) => (
									<a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
										{l.label ?? l.url}
									</a>
								))}
							</p>
						) : i === login.events.length - 1 && running ? (
							<p key={i} className="flex items-center gap-2 text-muted-foreground">
								<Spinner className="size-3" /> {e.message}
							</p>
						) : null,
					)}
					{q && (
						<form
							className="space-y-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (value) void answer(value);
							}}
						>
							<label htmlFor="login-answer" className="block font-medium">
								{q.message}
							</label>
							{q.type === "select" ? (
								<div className="grid gap-2">
									{q.options?.map((o) => (
										<Button key={o.id} type="button" variant="outline" className="h-auto justify-start whitespace-normal py-2 text-left" disabled={busy} onClick={() => void answer(o.id)}>
											<span>
												{o.label}
												{o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
											</span>
										</Button>
									))}
								</div>
							) : (
								<div className="flex gap-2">
									<Input id="login-answer" autoFocus type={q.type === "secret" ? "password" : "text"} autoComplete={q.type === "secret" ? "new-password" : "off"} placeholder={q.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
									<Button type="submit" disabled={!value || busy} className="shrink-0">
										{busy && <Spinner />}
										{t("providers.continue")}
									</Button>
								</div>
							)}
							{q.type === "secret" && <p className="text-xs text-muted-foreground">{t("providers.keyStays")}</p>}
						</form>
					)}
					{login?.status === "running" && !q && !login.events.length && (
						<p className="flex items-center gap-2 text-muted-foreground">
							<Spinner className="size-3" /> {t("providers.working")}
						</p>
					)}
					{login?.status === "done" && <p className="text-success">{t("providers.done", { name: provider.name })}</p>}
					{(login?.status === "failed" || error) && <p className="break-words text-destructive-foreground">{t("providers.failed", { error: login?.error ?? error })}</p>}
				</div>
				<DialogFooter>
					<Button variant={login?.status === "done" ? "default" : "ghost"} onClick={close}>
						{running ? t("common:actions.cancel") : t("providers.close")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
