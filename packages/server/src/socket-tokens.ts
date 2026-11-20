import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import type { Reelix } from "@reelix/core";

/** Who a token on the local socket stands for. Tokens live as long as the server. */
export class SocketTokens {
	private actors = new Map<string, string>();

	issue(actor: string): string {
		const token = randomBytes(32).toString("hex");
		this.actors.set(token, actor);
		return token;
	}

	revoke(token: string): void {
		this.actors.delete(token);
	}

	/** On the owner's socket, a caller without a known token is treated as the agent (docs/plugins.md §11.3). */
	actorOf(token: string | undefined): string {
		return (token && this.actors.get(token)) || "agent:socket";
	}

	/** On the agent's socket: the session a token belongs to; the owner's token, or none, is nobody there. */
	sessionActor(token: string | undefined): string | undefined {
		const actor = token ? this.actors.get(token) : undefined;
		return actor && !actor.startsWith("owner:") ? actor : undefined;
	}

	/** The owner's token, readable only by Reelix's user; the CLI uses it at a real terminal. Never shown to the model. */
	writeOwnerToken(app: Reelix): void {
		const path = app.paths.ownerToken;
		const token = this.issue("owner:cli");
		app.addRedaction("owner.token", token);
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, token + "\n", { mode: 0o600 });
		renameSync(tmp, path);
		chmodSync(path, 0o600);
	}
}
