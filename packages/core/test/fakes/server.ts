import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRequest = { method: string; url: URL; headers: IncomingMessage["headers"]; body: Buffer; raw: IncomingMessage };
export type FakeHandler = (req: FakeRequest, res: ServerResponse) => unknown;

/** Start a node:http server on 127.0.0.1, port 0, with the whole body read before the handler runs. */
export async function startServer(handler: FakeHandler): Promise<{ url: string; close(): Promise<void> }> {
	const server = createServer((raw, res) => {
		const chunks: Buffer[] = [];
		raw.on("data", (c: Buffer) => chunks.push(c));
		raw.on("end", () => {
			const req: FakeRequest = { method: raw.method ?? "GET", url: new URL(raw.url ?? "/", "http://127.0.0.1"), headers: raw.headers, body: Buffer.concat(chunks), raw };
			Promise.resolve(handler(req, res)).catch((e: unknown) => {
				if (!res.headersSent) send(res, 500, String((e as Error)?.stack ?? e));
				else res.end();
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream", ...headers });
	res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
	send(res, status, JSON.stringify(value), { "content-type": "application/json", ...headers });
}

/** Parse an urlencoded or multipart body into a FormData (using the platform's own parser). */
export async function formOf(req: FakeRequest): Promise<FormData> {
	const ct = String(req.headers["content-type"] ?? "");
	if (!ct) return new FormData();
	return new Response(new Uint8Array(req.body), { headers: { "content-type": ct } }).formData();
}
