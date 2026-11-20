import { definePlugin } from "@reelix/plugin";

/**
 * A recipe for `agent.tool`: block a tool call, with a reason. In a background job nobody is watching, so a
 * destructive operation (removing a download with its files, a title from the library) is refused there, whichever
 * tool reaches it: a typed tool or the `reelix` tool. In a conversation the owner is present and nothing changes.
 * The hook never sees the agent's shell; see the guide on what that means.
 */
export default definePlugin({
	async activate(ctx) {
		await ctx.hook("agent.tool@1", ({ operation, session }) => (session.kind === "job" && operation?.effect === "destructive" ? { reason: ctx.t("reason", { operation: operation.name }) } : undefined));
	},
});
