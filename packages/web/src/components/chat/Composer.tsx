import { FileUp, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { endpoints } from "../../lib/api";
import { type ImageAttachment, useChat } from "../../lib/chat";
import i18n from "../../lib/i18n";
import { cn, formatBytes } from "../../lib/utils";
import { Spinner } from "../common/States";
import { toast } from "../hooks/use-toast";
import { Button } from "../ui/button";

const MAX_IMAGE = 8 * 1024 * 1024;

function readBase64(file: File): Promise<ImageAttachment> {
	return new Promise((resolve, reject) => {
		const r = new FileReader();
		r.onload = () => {
			const s = String(r.result);
			resolve({ data: s.slice(s.indexOf(",") + 1), mimeType: file.type || "image/png", name: file.name || i18n.t("chat:composer.pastedImage") });
		};
		r.onerror = () => reject(r.error);
		r.readAsDataURL(file);
	});
}

/** Shared by the composer and the drop zone around the conversation. */
export function useAttachments() {
	const { t } = useTranslation("chat");
	const { setDraft } = useChat();
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [uploading, setUploading] = useState(0);

	const addImage = async (f: File) => {
		if (f.size > MAX_IMAGE) {
			toast({ title: t("composer.imageTooLarge"), description: t("composer.imageTooLargeDetail", { name: f.name, size: formatBytes(f.size), limit: formatBytes(MAX_IMAGE) }), variant: "destructive" });
			return;
		}
		const img = await readBase64(f);
		setImages((l) => [...l, img]);
	};

	/** Pasted images go into the message itself. */
	const addPasted = async (files: File[]) => {
		for (const f of files) if (f.type.startsWith("image/")) await addImage(f);
	};

	/** Dropped or picked files are uploaded; the agent is told where. Images are also attached. */
	const addFiles = async (files: File[]) => {
		for (const f of files) {
			setUploading((n) => n + 1);
			try {
				const up = await endpoints.upload(f);
				setDraft((d) => `${d}${d && !d.endsWith("\n") ? "\n" : ""}${t("composer.droppedFile", { path: up.path, name: up.name, size: formatBytes(up.size) })}`);
				if (f.type.startsWith("image/")) await addImage(f);
			} catch (e) {
				toast({ title: t("composer.uploadFailed", { name: f.name }), description: e instanceof Error ? e.message : String(e), variant: "destructive" });
			} finally {
				setUploading((n) => n - 1);
			}
		}
	};

	return { images, setImages, uploading, addFiles, addPasted };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function DropZone({ attachments, children, className }: { attachments: Attachments; children: React.ReactNode; className?: string }) {
	const { t } = useTranslation("chat");
	const [over, setOver] = useState(false);
	const depth = useRef(0);
	const isFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
	return (
		<div
			className={cn("relative", className)}
			onDragEnter={(e) => {
				if (!isFiles(e)) return;
				e.preventDefault();
				depth.current++;
				setOver(true);
			}}
			onDragOver={(e) => {
				if (isFiles(e)) e.preventDefault();
			}}
			onDragLeave={() => {
				depth.current = Math.max(0, depth.current - 1);
				if (!depth.current) setOver(false);
			}}
			onDrop={(e) => {
				if (!isFiles(e)) return;
				e.preventDefault();
				depth.current = 0;
				setOver(false);
				void attachments.addFiles(Array.from(e.dataTransfer.files));
			}}
		>
			{children}
			{over && (
				<div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-background/80 text-sm text-primary">
					<FileUp className="h-8 w-8" />
					{t("composer.dropHint")}
				</div>
			)}
		</div>
	);
}

export function Composer({ attachments, compact }: { attachments: Attachments; compact?: boolean }) {
	const { t } = useTranslation("chat");
	const { draft, setDraft, send, sending, thread, abort } = useChat();
	const ref = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const [stopping, setStopping] = useState(false);
	const running = !!thread?.running;
	const { images, setImages, uploading } = attachments;

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, compact ? 160 : 240)}px`;
	}, [draft, compact]);

	// "Ask about this" fills the composer: put the cursor at the end.
	useEffect(() => {
		const el = ref.current;
		if (el && draft && document.activeElement !== el && window.matchMedia("(pointer: fine)").matches) {
			el.focus();
			el.setSelectionRange(draft.length, draft.length);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft.length > 0]);

	useEffect(() => {
		if (!running) setStopping(false);
	}, [running]);

	const submit = async () => {
		if ((!draft.trim() && !images.length) || uploading) return;
		const imgs = images;
		setImages([]);
		await send(draft, imgs);
	};

	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
			e.preventDefault();
			void submit();
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
		if (files.length) {
			e.preventDefault();
			void attachments.addPasted(files);
		}
	};

	return (
		<div className="raised rounded-[min(var(--radius-control),1.75rem)] p-2 pl-3">
			{(images.length > 0 || uploading > 0) && (
				<div className="mb-2 flex flex-wrap gap-2 px-1">
					{images.map((img, i) => (
						<div key={i} className="relative">
							<img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} className="h-14 w-14 rounded-md object-cover" />
							<button type="button" aria-label={t("composer.removeImage")} className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 ring-1 ring-border" onClick={() => setImages((l) => l.filter((_, j) => j !== i))}>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
					{uploading > 0 && (
						<div className="flex h-14 items-center gap-2 px-2 text-xs text-muted-foreground">
							<Spinner /> {t("composer.uploading")}
						</div>
					)}
				</div>
			)}
			<div className="flex items-end gap-1">
				<Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" title={t("composer.attach")} onClick={() => fileRef.current?.click()}>
					<Paperclip />
				</Button>
				<input
					ref={fileRef}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						const files = Array.from(e.target.files ?? []);
						e.target.value = "";
						void attachments.addFiles(files);
					}}
				/>
				<textarea
					ref={ref}
					rows={1}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={onKey}
					onPaste={onPaste}
					placeholder={running ? t("composer.placeholderRunning") : thread?.pending && thread.pending.kind !== "secret" ? t("composer.placeholderAnswer") : t("composer.placeholder")}
					className="max-h-60 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
				/>
				{running && (
					<Button
						type="button"
						variant="secondary"
						size="icon"
						className="h-9 w-9 shrink-0"
						title={t("composer.stop")}
						disabled={stopping}
						onClick={() => {
							setStopping(true);
							void abort();
						}}
					>
						{stopping ? <Spinner /> : <Square className="fill-current" />}
					</Button>
				)}
				<Button type="button" size="icon" className="h-9 w-9 shrink-0 rounded-control" title={t("composer.send")} disabled={sending || uploading > 0 || (!draft.trim() && !images.length)} onClick={() => void submit()}>
					{sending ? <Spinner /> : <Send />}
				</Button>
			</div>
		</div>
	);
}
