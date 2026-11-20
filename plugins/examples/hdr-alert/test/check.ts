import type { PluginCheck } from "@reelix/plugin-testing";

/** `reelix plugin check` starts release-tags with it: the owner of the event it listens to. */
export default { plugins: ["../release-tags"] } satisfies PluginCheck;
