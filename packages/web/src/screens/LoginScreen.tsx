import { Film, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { endpoints } from "../lib/api";

/** Sign in, or set the password on first run. The session is an HttpOnly cookie only. */
export function LoginScreen({ firstRun, onDone }: { firstRun: boolean; onDone: () => void | Promise<void> }) {
	const [password, setPassword] = useState("");
	const [repeat, setRepeat] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(undefined);
		if (firstRun) {
			if (password.length < 8) return setError("Use at least 8 characters.");
			if (password !== repeat) return setError("The two passwords differ.");
		}
		setBusy(true);
		try {
			if (firstRun) await endpoints.setupPassword(password);
			else await endpoints.login(password);
			setPassword("");
			setRepeat("");
			await onDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="relative flex min-h-dvh items-center justify-center overflow-hidden p-4">
			<div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
			<form onSubmit={submit} className="glass-card relative w-full max-w-sm space-y-5 rounded-xl p-6">
				<div className="flex flex-col items-center gap-2 text-center">
					<div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
						<Film className="h-6 w-6" />
					</div>
					<h1 className="text-2xl font-bold tracking-tight">Reelix</h1>
					<p className="text-sm text-muted-foreground">{firstRun ? "Choose a password for this Reelix. You will use it to sign in from any device." : "Sign in to continue."}</p>
				</div>
				<div className="space-y-2">
					<Label htmlFor="pw">{firstRun ? "New password" : "Password"}</Label>
					<Input id="pw" type="password" autoComplete={firstRun ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
				</div>
				{firstRun && (
					<div className="space-y-2">
						<Label htmlFor="pw2">Repeat it</Label>
						<Input id="pw2" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
					</div>
				)}
				{error && <p className="text-sm text-destructive-foreground">{error}</p>}
				<Button type="submit" className="w-full" disabled={busy || !password}>
					{busy && <Loader2 className="animate-spin" />}
					{firstRun ? "Set password" : "Sign in"}
				</Button>
			</form>
		</div>
	);
}
