import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { BrowserRouter } from "react-router";
import { Toaster } from "../components/ui/toaster";
import { ApiError, UNAUTHORIZED_EVENT, endpoints } from "../lib/api";
import { ChatProvider } from "../lib/chat";
import { AppEvents } from "../lib/events";
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

	if (session.isLoading) return <Loading label="Connecting to Reelix…" />;
	if (session.error)
		return (
			<div className="flex h-dvh items-center justify-center p-6 text-center text-muted-foreground">
				<div>
					<p className="text-lg text-foreground">Reelix is not reachable.</p>
					<p className="text-sm">{(session.error as Error).message}</p>
					<button className="mt-3 text-sm text-primary underline" onClick={() => session.refetch()}>
						Try again
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
	return (
		<QueryClientProvider client={client}>
			<Gate />
			<Toaster />
		</QueryClientProvider>
	);
}
