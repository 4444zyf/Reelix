import type { PluginCheck } from "@reelix/plugin-testing";

/**
 * A chunk of Sintel's English subtitle and an answer in the shape models give in the `translate` role (the lines
 * follow what qwen3.8-flash wrote for this chunk in the demo of 2026-11-19, which kept only its reviewed file), for
 * `reelix plugin check` and this plugin's tests.
 */
export const JOB = {
	to: "French",
	novelty: false,
	lines: [
		{ n: 0, text: "What brings you to the land\nof the gatekeepers?" },
		{ n: 1, text: "I'm searching for someone." },
		{ n: 2, text: "Someone very dear?\nA kindred spirit?" },
		{ n: 3, text: "A dragon." },
	],
	glossary: [{ term: "Sintel", as: "Sintel", note: "the heroine" }],
	tone: "Quiet, fairy-tale register.",
	context: [],
};

export const ANSWER = '{"lines":[{"n":0,"t":"Qu\'est-ce qui t\'amène au pays\\ndes gardiens ?"},{"n":1,"t":"Je cherche quelqu\'un."},{"n":2,"t":"Quelqu\'un de très cher ?\\nUne âme sœur ?"},{"n":3,"t":"Un dragon."}]}';

export default {
	model: [{ role: "translate", text: ANSWER, model: "qwen-token-plan/qwen3.8-flash" }],
	seams: {
		"reelix:translator@1": { provider: "model-translator", job: JOB, expectLines: 4 },
	},
} satisfies PluginCheck;
