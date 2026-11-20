// Importing this module declares every operation of core; the list then never changes.
import { sealCoreOperations } from "../registry.ts";
import "./media.ts";
import "../reasons.ts";
import "../inbox.ts";
import "../channels.ts";
import "../subtitles/pipeline.ts";
import "../anime.ts";
import "../follows.ts";
import "../adopt.ts";
import "../themes.ts";
import "../plugins.ts";
import "../proposals.ts";
import "./metadata.ts";
import "./translate.ts";
import "../magpie.ts";

export const CORE_OPERATIONS = sealCoreOperations();
