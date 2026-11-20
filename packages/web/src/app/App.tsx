import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router";
import { Toaster } from "../components/ui/toaster";
import { ApiError, UNAUTHORIZED_EVENT, endpoints } from "../lib/api";
import { ChatProvider } from "../lib/chat";
import "../lib/theme";
import i18n, { isLang, setLanguage } from "../lib/i18n";
import { useTranslation } from "react-i18next";
import { AppEvents } from "../lib/events";
import { AppSync } from "../lib/push";
import { Loading } from "../components/common/States";
import { LoginScreen } from "../screens/LoginScreen";
import { AppRoutes } from "./router";

function Gate() {
	const qc = useQueryClient();
	const session = useQuery({ queryKey: ["session"], queryFn: endpoints.session, retry: 2, staleTime: Infinity });
	useEffect(() => {
		const on = () => qc.invalidateQueries({ queryKey: ["session"] });
		window.addEventListener(UNAUTHORIZED_EVENT, on);
		return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
	}, [qc]);

	const { t } = useTranslation(["nav", "common"]);
	// The owner's language lives on the server (config `language`); this browser follows it.
	const serverLang = session.data?.language;
	useEffect(() => {
		if (isLang(serverLang) && serverLang !== i18n.language) setLanguage(serverLang);
	}, [serverLang]);

	if (session.isLoading) return <Loading label={t("connecting")} />;
	if (session.error)
		return (
			<div className="flex h-dvh items-center justify-center p-6 text-center text-muted-foreground">
				<div>
					<p className="text-lg text-foreground">{t("unreachable")}</p>
					<p className="text-sm">{(session.error as Error).message}</p>
					<button className="mt-3 text-sm text-primary underline" onClick={() => session.refetch()}>
						{t("common:actions.retry")}
					</button>
				</div>
			</div>
		);
	if (!session.data?.authenticated)
		return (
			<LoginScreen
				firstRun={!!session.data?.needsPassword}
				onDone={async () => {
					qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
					await qc.invalidateQueries({ queryKey: ["session"] });
				}}
			/>
		);
	return (
		<BrowserRouter>
			<ChatProvider>
				<AppEvents />
				<AppSync />
				<AppRoutes />
			</ChatProvider>
		</BrowserRouter>
	);
}

export function App() {
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 30_000,
						retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
						refetchOnWindowFocus: true,
					},
				},
			}),
	);
	// A language switch re-mounts the app so every formatted date and number follows it.
	const { i18n: live } = useTranslation();
	return (
		<QueryClientProvider client={client}>
			<Gate key={live.language} />
			<Toaster />
		</QueryClientProvider>
	);
}
