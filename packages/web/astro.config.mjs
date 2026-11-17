// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

/** The Reelix server the dev server forwards /api to (SSE streams pass straight through). */
const API = process.env.REELIX_API ?? "http://localhost:7878";

/**
 * One page, client-side routes: in dev, any HTML request that is not an asset or /api is
 * answered with the single index page (the Reelix server does the same for the built files).
 * @returns {import("vite").Plugin}
 */
function spaFallback() {
	return {
		name: "reelix-spa-fallback",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				const path = (req.url ?? "/").split("?")[0] ?? "/";
				const wantsHtml = (req.headers.accept ?? "").includes("text/html");
				if (req.method === "GET" && wantsHtml && path !== "/" && !path.startsWith("/api") && !path.startsWith("/@") && !path.startsWith("/_") && !path.startsWith("/node_modules") && !/\.[a-z0-9]+$/i.test(path)) req.url = "/";
				next();
			});
		},
	};
}

export default defineConfig({
	output: "static",
	outDir: "./dist",
	integrations: [react()],
	server: { port: 4321 },
	devToolbar: { enabled: false },
	vite: {
		plugins: [tailwindcss(), spaFallback()],
		build: { chunkSizeWarningLimit: 900 },
		server: {
			proxy: {
				// changeOrigin stays false: the server compares Origin with Host, so Host must be the dev server's.
				"/api": { target: API, changeOrigin: false },
			},
		},
	},
});
