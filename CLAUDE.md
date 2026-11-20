# Reelix: rules for anyone changing this code

## Keep the code clean: no dead code

This is a hard restriction, not a preference.

- When a change makes code unused, delete it in the same change: functions, exports, types, parameters, config keys, locale strings, routes, tests of removed behaviour, files.
- When code moves, the old path goes. No compatibility shims, no re-exports "for now", no parallel old and new versions, no flags that keep the old behaviour alive.
- No commented-out code, no `_unused` renames, no "removed" markers, no placeholder stubs for features that are not being built now.
- Do not add options, parameters or abstractions that nothing uses yet. A design may reserve a *name* in a document; code is written when the first user of it is written.
- Before finishing, check what your change orphaned: run `npm run typecheck` and search for the names you stopped using.
- Deleting dead code is always in scope. If you find some while working nearby, remove it and say so; if you are not sure it is dead, say that instead of leaving or deleting it silently.

## Other standing rules

- **Docs first.** A design is written into `docs/` and agreed before it is coded. When code changes a documented behaviour, the document changes with it.
- **Four languages.** Every user-visible string exists in en, zh, fr and ru (`docs/i18n.md`).
- **No code from `references/MoviePilot*`.** It is GPL-3.0: read for ideas only.
- **Secrets** go through the secret field or `secrets.yaml`; never print them, log them or put them in a document.
- **Checks before calling work done:** `npm run typecheck` and `npm test`.
