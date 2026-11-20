# Instructions for a coding agent working on this Reelix plugin

This folder is the Reelix plugin `{{id}}` ({{kind}}). Reelix is at `{{reelix}}`. You help the author change this plugin; you do not change Reelix itself.

## Where to find facts, in this order

1. **The running Reelix.** Start one with `reelix plugin dev .` and, in another terminal, run `REELIX_DATA=<the folder it prints> reelix plugin inspect` (all plugins, seams, hooks, events and context calls, with live state) or `… reelix plugin inspect {{id}}` (this plugin: state, last error, what it registered, its settings). Inside Reelix the agent has the same thing as the tool `plugin_inspect`.
2. **The reference**, `{{reelix}}/docs/plugin-reference.md`. It is generated from Reelix's code and Reelix's tests fail when it differs, so it is exact: every seam's contract and time limits, every hook's mode and limits, every event, every `ctx` call with its signature and what it needs in the manifest.
3. **The guide**, `{{reelix}}/docs/plugin-guide.md`, with a recipe for each kind of plugin, and the design, `{{reelix}}/docs/plugins.md`.

If a fact is in none of these, say that it is unverified. Do not guess an API, a field or a limit, and do not read Reelix's internals to find one: a plugin may use only what `@reelix/plugin` exports.

## Rules

- **Compatibility** (design §13.4). `reelix.api` must equal the plugin API of the Reelix that runs it (`0` today; it may still change until it is declared `1`). `engines.reelix`, when present, is a version range checked at install and at every start. Each seam and hook has its own version (`reelix:indexer@1`, `release.rank@1`); use the versions the reference lists.
- **Declare everything** in `package.json` under `reelix.uses`: seams it provides, hooks, events, operations with their effects, typed tools, jobs, core operations it runs, network hosts, secrets, skills. Reelix refuses a registration that is not declared.
- **Only through `ctx`.** Import only `@reelix/plugin` (and your own dependencies). Fetch only with `ctx.http.fetch`, to declared hosts. Read secrets with `ctx.secret.get`; never log or return them.
- **One default export**, `definePlugin(...)`. Keep state in variables inside `activate` or in `ctx.kv`, never in module-level variables.
- **Plain data** crosses every seam, hook and operation: JSON values and bytes.
- **Outcomes are not errors.** An expected answer of a service (rate limited, needs sign-in, unavailable) is returned as an outcome. A throw counts as a failure, and five in ten minutes switch the plugin off.
- **Strings** go in `locales/en.json` and are read with `ctx.t`. Other languages are optional.

## Commands

```sh
npm test                            # this plugin's tests
reelix plugin check .               # manifest, entry, declarations, hooks and the seam's conformance suite; must pass
reelix plugin check . --write-settings   # after changing the settings schema
reelix plugin dev .                 # try it in a Reelix with fake services
```

Run `npm test` and `reelix plugin check .` before you say a change is done, and say what you ran.

## No dead code

When a change makes something unused, delete it in the same change: functions, settings, strings, declarations in `reelix.uses`, tests of removed behaviour. No commented-out code, no stubs for later, no options nothing uses. `reelix plugin check` warns about a declaration that is never registered.
