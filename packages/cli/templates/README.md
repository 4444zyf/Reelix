# {{id}}

A Reelix plugin: {{kind}}. It was written by `reelix plugin new` from {{from}}, and it works as it is: its tests and `reelix plugin check` pass. Change it into your own.

## What is here

| File | What it is |
| --- | --- |
| `package.json` | The manifest. `reelix.id` is the plugin's name; `reelix.uses` declares everything the plugin registers or reaches. Reelix refuses what is not declared. |
| `src/index.ts` | The code: one default export, `definePlugin({ activate(ctx, settings) { … } })`. A skill pack has no code. |
| `locales/en.json` | The plugin's strings, read with `ctx.t(key)`. `zh.json`, `fr.json` and `ru.json` are optional. |
| `settings.schema.json` | Only when the plugin has settings: a copy of its settings schema, so Reelix can show the form before the code runs. Write it again with `reelix plugin check . --write-settings` after you change the schema. |
| `skills/` | Only in a skill pack (or with `uses.skills`): `SKILL.md` files the agent reads. |
| `test/` | `node:test` tests with `@reelix/plugin-testing`. `test/check.ts`, when there is one, holds the answers recorded from the real service that `reelix plugin check` runs the plugin against. |
| `AGENTS.md` | Instructions for a coding agent that helps you. |

## Commands

```sh
npm test                          # this plugin's own tests
reelix plugin check .             # the checks Reelix runs on any plugin, and the seam's conformance suite
reelix plugin dev .               # a Reelix with fake services and this plugin loaded; prints the address and a password
```

`node_modules/@reelix` links to the Reelix in `{{reelix}}`, because `@reelix/plugin` and `@reelix/plugin-testing` are not published yet. Reelix always gives a running plugin its own copy of `@reelix/plugin`.

## Next steps

1. Choose the real service, and change the address in the code and in `reelix.uses.network`.
2. Record real answers of the service (with `curl`, for example) and put them in `test/check.ts`. Change the tests to match.
3. Run `npm test` and `reelix plugin check .` until both pass.
4. Try it with `reelix plugin dev .`.
5. Publish it as a git repository (the owner installs it by commit) or on npm with an `npm-shrinkwrap.json`.

The guide is `{{reelix}}/docs/plugin-guide.md`. The reference of every seam, hook, event and context call is `{{reelix}}/docs/plugin-reference.md`.
