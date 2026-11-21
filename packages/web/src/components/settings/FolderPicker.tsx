import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CornerLeftUp, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { op } from "../../lib/api";
import { ErrorState, Spinner } from "../common/States";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

type Listing = { root: string; path: string; parent: string | null; folders: { name: string; path: string }[]; truncated: boolean };

/** Browse the folders inside the media folder (operation media.folders) and choose one. */
export function FolderPicker({ open, onOpenChange, start, onChoose, level }: { open: boolean; onOpenChange: (open: boolean) => void; start?: string; onChoose: (path: string) => void; level: "downloads" | "library" }) {
	const { t } = useTranslation(["settings", "common"]);
	const [path, setPath] = useState<string | undefined>(start || undefined);
	useEffect(() => {
		if (open) setPath(start || undefined);
	}, [open, start]);
	const listing = useQuery({
		queryKey: ["media.folders", path ?? ""],
		queryFn: () => op<Listing>("media.folders", path ? { path } : {}),
		enabled: open,
		retry: false,
	});
	// A starting folder that no longer exists (or lies outside the media folder): start at the top instead.
	useEffect(() => {
		if (listing.error && path && path === start) setPath(undefined);
	}, [listing.error, path, start]);
	const here = listing.data;
	// A title's own folder ([tmdbid-N]) or a season folder is never a download or library folder.
	const tooDeep = !!here && /\[tmdbid-\d+\]|^(Season \d+|extras)$/i.test(here.path.split("/").pop() ?? "");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="surface-card max-w-lg rounded-xl">
				<DialogHeader>
					<DialogTitle>{t("folderPicker.title")}</DialogTitle>
					<DialogDescription>{t("folderPicker.description", { root: here?.root ?? "/media" })}</DialogDescription>
				</DialogHeader>
				<p className="text-sm">{t(`folderPicker.level.${level}`)}</p>
				<p className="break-all rounded-md bg-well px-3 py-2 font-mono text-xs">{here?.path ?? path ?? "…"}</p>
				<div className="max-h-80 min-h-40 overflow-y-auto rounded-md border border-input">
					{listing.isLoading ? (
						<div className="flex justify-center p-6">
							<Spinner />
						</div>
					) : listing.error ? (
						<ErrorState error={listing.error} onRetry={() => listing.refetch()} />
					) : (
						<ul className="divide-y divide-border text-sm">
							{here?.parent && (
								<li>
									<button type="button" onClick={() => setPath(here.parent!)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-accent">
										<CornerLeftUp className="size-4" />
										{t("folderPicker.up")}
									</button>
								</li>
							)}
							{here?.folders.map((f) => (
								<li key={f.path}>
									<button type="button" onClick={() => setPath(f.path)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent">
										<Folder className="size-4 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate">{f.name}</span>
										<ChevronRight className="size-4 shrink-0 text-muted-foreground" />
									</button>
								</li>
							))}
							{here && !here.folders.length && <li className="px-3 py-4 text-muted-foreground">{t("folderPicker.empty")}</li>}
							{here?.truncated && <li className="px-3 py-2 text-xs text-muted-foreground">{t("folderPicker.truncated")}</li>}
						</ul>
					)}
				</div>
				{tooDeep && <p className="text-sm text-destructive-foreground">{t("folderPicker.tooDeep")}</p>}
				<DialogFooter className="gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t("common:actions.cancel")}
					</Button>
					<Button
						disabled={!here || tooDeep}
						onClick={() => {
							onChoose(here!.path);
							onOpenChange(false);
						}}
					>
						{t("folderPicker.choose")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
