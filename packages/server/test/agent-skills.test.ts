import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionResources } from "../src/agent/host.ts";

function plant(skillsDir: string, name: string): void {
	mkdirSync(join(skillsDir, name), { recursive: true });
	writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} test skill, used when testing.\n---\n\n# ${name}\n`);
}

test("agent skills: only the listed folders are loaded; skills planted where pi looks on its own are not", async () => {
	const root = mkdtempSync(join(tmpdir(), "reelix-skills-"));
	const home = process.env.HOME;
	try {
		// A git root with the session's workspace two levels below it: pi walks up to the root.
		const repo = join(root, "data");
		const cwd = join(repo, "workspace", "downloads");
		mkdirSync(cwd, { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		const agentDir = join(repo, "pi");
		const fakeHome = join(root, "home");
		process.env.HOME = fakeHome;

		plant(join(cwd, ".agents", "skills"), "planted-agents");
		plant(join(cwd, ".pi", "skills"), "planted-pi");
		plant(join(repo, ".agents", "skills"), "planted-parent-agents");
		plant(join(agentDir, "skills"), "planted-agent-dir");
		plant(join(fakeHome, ".agents", "skills"), "planted-home");

		const builtin = join(root, "builtin-skills");
		const owner = join(repo, "skills");
		plant(builtin, "listed-builtin");
		plant(owner, "listed-owner");

		const { resourceLoader } = sessionResources({ cwd, agentDir, skillDirs: [builtin, owner, join(root, "missing")], systemPrompt: () => "test" });
		await resourceLoader.reload();
		const { skills, diagnostics } = resourceLoader.getSkills();
		assert.deepEqual(skills.map((s) => s.name).sort(), ["listed-builtin", "listed-owner"]);
		assert.deepEqual(diagnostics, []);
	} finally {
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		rmSync(root, { recursive: true, force: true });
	}
});
