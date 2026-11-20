# Plugin systems studied: MoviePilot, DeepSeek Harness (Cordis), pi

Date: 2026-11-18
Status: background for [plugins.md](plugins.md), the agreed design. This file records what was read and found; it decides nothing.

Read from source: MoviePilot v3.2.7 and its plugin and frontend repos (`references/`), pi 1.5.2 (`node_modules/@earendil-works/pi-coding-agent`), DeepSeek Harness 0.2.2-rc.4 and Cordis 4.0.0-rc.13 (shallow clones). MoviePilot is GPL: ideas only, no code.

## 1.1 MoviePilot: a wide surface and a market, no boundary

- **Shape.** One Python class per plugin. Each capability is a method that returns a list of plain records, and the host collects them: commands, HTTP routes, scheduled jobs, workflow actions, agent tools, dashboard widgets, sidebar entries, login providers.
- **Two kinds of events.** Broadcast events are fire-and-forget (`download.added`, `transfer.complete`, `subscribe.added` …). Chain events run handlers in priority order over one shared payload, and a handler intercepts by changing it (`transfer.rename`, `resource.selection`, `name.recognize` …).
- **Replacing core behaviour.** `get_module()` returns named methods that run before the built-in ones; a result short-circuits or is merged. This is how the community adds downloaders, media servers and metadata sources, and it is the main reason the ecosystem is large (about 56 v3 plugins, more for v2).
- **UI in two tiers.** A JSON tree of Vuetify components for simple forms and pages; module federation with a versioned frontend SDK for rich ones.
- **Market.** A market is a GitHub repository with an index file (`package.v3.json`) and one folder per plugin. A fork is a third-party market. Installs are staged with rollback. Entries carry a host-version range. Install counts and ratings give social proof.
- **Contributor experience.** One long guide, 22 recipe pages, an `AGENTS.md` for coding agents, CI gates, and a test harness that needs the host checked out next to the plugins.
- **Weaknesses.**
  - No isolation at all: plugins run in the host process, can read every secret, and can subscribe to the login event that carries passwords.
  - The JSON UI evaluates strings as code and accepts raw HTML in the admin's session.
  - No signing; a third-party market is a remote-code channel.
  - Python dependencies go into the host's own environment.
  - Metadata and hook results are untyped, so mistakes surface as log lines at run time.
  - Three parallel plugin generations (v1, v2, v3) because plugins import host internals, so every host refactor breaks them.
  - Cleanup is left to authors; the host grew a lot of defensive machinery to cope.

## 1.2 Cordis and DeepSeek Harness: the runtime owns cleanup

- **The idea** (paper arXiv 2608.25512, abstract only was read). Two properties: every side effect a component makes is reversed when it is removed, and dependencies are declared and tracked by the runtime.
- **Mechanics.** A plugin is `apply(ctx, config)` plus `inject: [...]`. Everything it registers through `ctx` (a listener, a tool, a service) is an *effect* with a recorded disposer. Disposing the plugin runs them all. Plugins find each other only through named *services* on the context, never by import. Events have explicit modes: `emit`, `parallel`, `serial` (first result wins), `waterfall` (middleware with `next()`). Config is validated by a schema before the plugin starts.
- **In DeepSeek Harness** everything is a plugin, including the agent loop, the model adapter and the session log. A recurring pattern is the *seam*: a service definition, one or more providers, and consumers that look it up by name. Plugin lists are YAML with stable ids and a `disabled` flag. There is a read-only `cordis_inspect` tool so the agent can discover services, events and config schemas before writing a plugin, and a `plugin_manager` tool behind approval.
- **Weaknesses, from their own docs and postmortems.**
  - A plugin whose dependency is missing or misspelt waits silently, with no error.
  - Proxy contexts are hard to debug; one production bug hid behind 178 passing tests.
  - A waterfall handler that forgets `next()` silently removes everything after it.
  - Cordis 4 is still a release candidate after two years, upstream calls the API unstable, and DeepSeek vendors a patched copy rather than depending on it.
  - Disposal reverses registrations only, not what the plugin did to the outside world.
  - No sandbox either: "installed host code executes in-process outside the workspace sandbox".

## 1.3 pi: simple factories, a package manager, no boundary

- **Shape.** `export default function (pi: ExtensionAPI)`. The API registers tools, commands and providers, and subscribes to about 40 events. `tool_call` can block or change a call, `tool_result` can change a result, `before_agent_start` can change the system prompt.
- **Cleanup is the author's job** (`session_start` / `session_shutdown`); reload re-runs every factory.
- **Packages.** A `pi` key in `package.json` lists extensions, skills, prompt templates and themes. `pi install` takes npm, git or a local path, pins versions, and stores packages under the agent directory. The same logic is exported to embedders as `DefaultPackageManager`. TypeScript loads without a build step.
- **Skills** are the cheapest extension of all: a folder with a `SKILL.md`, read by the model when relevant. No code is needed.
- **No sandbox.** Extensions can read provider keys, replace built-in tools without a warning, and see every tool call. npm install scripts run.
- **What Reelix uses today:** inline hooks, custom tools and extra skill folders. It does not use packages, extension paths, the event bus or commands.

## 1.4 Side by side

| | MoviePilot | Cordis / DSH | pi |
| --- | --- | --- | --- |
| Plugin is | a class with collector methods | `apply(ctx, config)` + `inject` | a factory given an API object |
| Cleanup | author (`stop_service`) | runtime, automatic | author (`session_shutdown`) |
| Plugins depend on | host internals | named services | nothing (a shared event bus) |
| Replace core parts | yes, per method | yes, everything | no, add only |
| Config | JSON, untyped | schema, checked first | none built in |
| UI | JSON tree or federated Vue | client plugin packages | terminal only |
| Distribution | GitHub repo as market | npm + static index files | npm / git / local, gallery by keyword |
| Isolation | none | none | none |

All three run third-party code in-process with full access. None has solved isolation; DSH and pi say so plainly, MoviePilot less so.

## 1.5 Two findings about Reelix itself

Found while reading how Reelix embeds pi. Neither is fixed yet.

1. **Skills load from places Reelix does not list.** `packages/server/src/agent/host.ts` sets `noExtensions` and `noContextFiles` but not `noSkills`, and pi's in-memory settings default to "project trusted". pi therefore also loads `.pi/skills` and `.agents/skills` from the agent's working directory and each parent up to the git root, plus `~/.agents/skills` (checked in `package-manager.js:2182-2223`). A skill planted there would be offered to the model. **Fixed 2026-11-18:** `noSkills: true` (the two listed folders still load) and `projectTrusted: false`, in `sessionResources()`; `packages/server/test/agent-skills.test.ts` plants skills in all five places and checks none load. Not rerun against a live model session.
2. **`session.bindExtensions()` is never called**, so `session_start` never fires. It does not matter today; any pi extension from a plugin would silently do nothing until it is.
