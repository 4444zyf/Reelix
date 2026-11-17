import { Navigate, Route, Routes } from "react-router";
import { ActivityScreen } from "../screens/ActivityScreen";
import { AdoptScreen } from "../screens/AdoptScreen";
import { BrowserScreen } from "../screens/BrowserScreen";
import { ChatScreen } from "../screens/ChatScreen";
import { DownloadsScreen } from "../screens/DownloadsScreen";
import { InboxScreen } from "../screens/InboxScreen";
import { LibraryScreen } from "../screens/LibraryScreen";
import { SearchScreen } from "../screens/SearchScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { TitleScreen } from "../screens/TitleScreen";
import { Layout } from "./Layout";

/** Client-side routes inside the single Astro page. */
export function AppRoutes() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route index element={<Navigate to="/chat" replace />} />
				<Route path="chat" element={<ChatScreen />} />
				<Route path="chat/:threadId" element={<ChatScreen />} />
				<Route path="inbox" element={<InboxScreen />} />
				<Route path="library" element={<LibraryScreen />} />
				<Route path="library/adopt" element={<AdoptScreen />} />
				<Route path="library/:titleId" element={<TitleScreen />} />
				<Route path="search" element={<SearchScreen />} />
				<Route path="downloads" element={<DownloadsScreen />} />
				<Route path="activity" element={<ActivityScreen />} />
				<Route path="browser" element={<BrowserScreen />} />
				<Route path="settings" element={<SettingsScreen />} />
				<Route path="*" element={<Navigate to="/chat" replace />} />
			</Route>
		</Routes>
	);
}
