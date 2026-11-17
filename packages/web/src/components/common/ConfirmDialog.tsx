import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Spinner } from "./States";

/** The app's confirm box (never the browser's native one). */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	children,
	confirmLabel = "Confirm",
	destructive,
	onConfirm,
	disabled,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	confirmLabel?: string;
	destructive?: boolean;
	onConfirm: () => Promise<unknown> | unknown;
	disabled?: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!busy) {
					setError(undefined);
					onOpenChange(o);
				}
			}}
		>
			<DialogContent className="glass-card max-w-md rounded-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				{children}
				{error && <p className="text-sm text-destructive-foreground">{error}</p>}
				<DialogFooter className="gap-2">
					<Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						variant={destructive ? "destructive" : "default"}
						disabled={busy || disabled}
						onClick={async () => {
							setBusy(true);
							setError(undefined);
							try {
								await onConfirm();
								onOpenChange(false);
							} catch (e) {
								setError(e instanceof Error ? e.message : String(e));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Spinner />}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
