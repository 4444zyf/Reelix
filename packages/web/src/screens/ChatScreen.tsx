import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { ChatPane } from "../components/chat/ChatPane";
import { useChat } from "../lib/chat";

/** The conversation, full size. The URL follows the open thread (/chat/:threadId). */
export function ChatScreen() {
	const { threadId } = useParams();
	const { activeId, setActive } = useChat();
	const navigate = useNavigate();
	const mounted = useRef(false);

	useEffect(() => {
		if (threadId && threadId !== activeId) setActive(threadId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [threadId]);

	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			if (threadId || !activeId) return;
		}
		if ((activeId ?? undefined) !== threadId) navigate(activeId ? `/chat/${encodeURIComponent(activeId)}` : "/chat", { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeId]);

	return (
		<div className="h-full">
			<ChatPane variant="screen" />
		</div>
	);
}
