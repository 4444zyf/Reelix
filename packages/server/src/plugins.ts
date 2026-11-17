import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Hono } from "hono";
import type { Reelix } from "@reelix/core";
import type { AgentHost } from "./agent/host.ts";
import type { SessionKind } from "./agent/prompt.ts";
import type { JobRunner } from "./jobs.ts";
import type { TelegramBot } from "./telegram.ts";
import type { Watcher } from "./watcher.ts";

/** Internal subsystems that add tools, routes and jobs (subtitles, browser, follows). */
export type Subsystem = {
	name: string;
	init?: (d: { app: Reelix; host: AgentHost; jobs: JobRunner; watcher: Watcher; telegram: TelegramBot }) => void;
	tools?: (ctx: { threadId: string; kind: SessionKind; actor: string; emit: (e: Record<string, unknown>) => void }) => ToolDefinition<any, any, any>[];
	routes?: (api: Hono, d: { app: Reelix; host: AgentHost }) => void;
};

import { subtitlesSubsystem } from "./subtitles.ts";
import { browserSubsystem } from "./browser.ts";
import { followsSubsystem } from "./follows.ts";

export const plugins: Subsystem[] = [subtitlesSubsystem, browserSubsystem(), followsSubsystem];
