import { Film } from "lucide-react";
import { useState } from "react";
import { cn, posterUrl } from "../../lib/utils";

export function Poster({ path, alt, size = "w342", className }: { path?: string | null; alt: string; size?: string; className?: string }) {
	const [failed, setFailed] = useState(false);
	const src = posterUrl(path, size);
	return (
		<div className={cn("relative aspect-[2/3] overflow-hidden rounded-lg bg-muted", className)}>
			{src && !failed ? (
				<img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
			) : (
				<div className="flex h-full w-full items-center justify-center text-muted-foreground">
					<Film className="h-1/4 w-1/4 opacity-50" />
				</div>
			)}
		</div>
	);
}
