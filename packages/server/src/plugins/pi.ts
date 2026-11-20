import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentSessionInfo, PiExtension } from "@reelix/plugin";

/** One plugin's raw pi extension (docs/plugins.md §10.4), as the kernel registered it. */
export type PluginExtension = {
	plugin: string;
	extension: PiExtension;
	/** Whether the plugin still runs; its tools and handlers do nothing once it has stopped. */
	isOpen(): boolean;
	/** Run its code so that stopping the plugin waits for it. */
	track<T>(fn: () => Promise<T>): Promise<T>;
	/** Its factory threw, or Reelix refused what it registered. */
	onFailure(error: unknown): void;
};

/**
 * The raw pi extensions of running plugins. The agent host loads them into every session it opens, and
 * opens a session again at its next run when they changed, so tools are always the running plugins' own.
 */
export class PiExtensions {
	private entries = new Set<PluginExtension>();
	private listeners = new Set<() => void>();

	add(e: PluginExtension): () => void {
		this.entries.add(e);
		this.changed();
		return () => {
			this.entries.delete(e);
			this.changed();
		};
	}

	list(): PluginExtension[] {
		return [...this.entries];
	}

	onChange(listener: () => void): void {
		this.listeners.add(listener);
	}

	private changed(): void {
		for (const l of this.listeners) l();
	}
}

/** The prefix every tool of a plugin's pi extension has, as its typed tools do. */
const piToolPrefix = (plugin: string) => `${plugin}_`;

/**
 * The factories for one session: each plugin's extension, given a pi whose `registerTool` refuses a name
 * outside the plugin's prefix or one that is already taken (Reelix's tools, other plugins'), and whose tools
 * and handlers stop working when the plugin stops. `taken` holds the session's tool names so far and grows.
 */
export function sessionExtensions(list: PluginExtension[], session: AgentSessionInfo, taken: Set<string>): { name: string; factory: ExtensionFactory }[] {
	return list.map((e) => ({
		name: `plugin:${e.plugin}`,
		factory: (pi: ExtensionAPI) => {
			const stopped = () => new Error(`the plugin ${e.plugin} has stopped`);
			const guarded = new Proxy(pi, {
				get(target, prop) {
					if (prop === "registerTool") {
						return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
							const name = String(tool?.name);
							if (!name.startsWith(piToolPrefix(e.plugin)) || name.length === piToolPrefix(e.plugin).length) throw new Error(`tool "${name}" refused: the tools of ${e.plugin}'s pi extension are named ${piToolPrefix(e.plugin)}<name>`);
							if (taken.has(name)) throw new Error(`tool "${name}" refused: a Reelix tool or another plugin's has that name`);
							taken.add(name);
							target.registerTool({
								...tool,
								execute: (...args: Parameters<typeof tool.execute>) => {
									if (!e.isOpen()) throw stopped();
									return e.track(async () => tool.execute(...args));
								},
							});
						};
					}
					if (prop === "on") {
						return (event: string, handler: (...a: unknown[]) => unknown) => (target.on as (ev: string, h: (...a: unknown[]) => unknown) => () => void)(event, (...a) => (e.isOpen() ? handler(...a) : undefined));
					}
					const value = Reflect.get(target, prop, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			try {
				e.extension(guarded, session);
			} catch (error) {
				e.onFailure(error);
			}
		},
	}));
}
