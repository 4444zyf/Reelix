import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";

/** The agent's markdown. Raw HTML is not rendered. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
	return (
		<div className={cn("md text-sm", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
