# Models

Date: 2026-11-18
Status: design agreed with the owner on 2026-11-18. **Being built; not verified yet.**

Reelix reaches every model through pi. This page covers which model is used for what, what happens when one fails, and how an optional [magpie](https://github.com/yetone/magpie) gateway fits in.

## Roles

Each kind of work asks for a **role**. A role is an ordered list of models as pi names them (`provider/model-id`).

| Role | Used for | With no models of its own, uses |
| --- | --- | --- |
| `chat` | conversations with the owner (web, Telegram, terminal) | pi's default model |
| `background` | jobs: follows, the nightly summary, after-filing subtitles | `chat` |
| `glossary` | subtitle translation: reading the whole subtitle for names and tone (wants a large context) | `background` |
| `translate` | subtitle translation: the bulk work (wants cheap and fast) | `background` |
| `review` | subtitle translation: checking the result | `translate` |

There is no rules engine and no classifier: the code doing the work knows which role it needs.

Settings: `models.roles.<role>`, each a list. The earlier `models.main` and `models.background` are migrated to `models.roles.chat` and `models.roles.background` when the config is read.

## When a model fails

- **Direct calls** (translation): if a call fails before producing an answer, the next model in the role's list gets the same request. If the whole list fails, the job pauses and tries again after 5 minutes, doubling up to an hour. It says why it is paused.
- **Agent conversations** (chat and background jobs): the first model in the list that pi knows is used for the session. A model that has just failed is skipped for a while, so the next conversation starts on the next one.

- **Time limit.** A direct call that has not answered within `translation.call_timeout_s` (default 300 seconds) counts as failed. This catches a reasoning model that keeps thinking.
- **No thinking for direct calls.** Glossary, translation and review calls ask for no reasoning. A model reached through an OpenAI-compatible endpoint only honours that if pi knows how to switch its thinking off: for Qwen on DashScope, the provider entry in pi's `models.json` needs `"compat": { "thinkingFormat": "qwen", "supportsDeveloperRole": false }` and each model `"reasoning": true`. Applied to the owner's `~/.pi/agent/models.json` on 2026-11-18 (backup `models.json.bak-2026-11-18`) for the Qwen and DeepSeek models; `glm-5.3` is left without `reasoning` because the endpoint only accepts thinking on for it. Without it, Qwen 3.8 thinks at length about a Klingon glossary and runs into the time limit (seen 2026-11-18: over 100 seconds still thinking, against 14 seconds with thinking off).

There is no bookkeeping beyond that. Quotas, accounts and smarter routing belong to magpie.

## Magpie (optional)

Magpie is a local gateway that routes between providers, accounts and models, with failover, quota awareness and spending limits. Reelix does not need it and runs the same without it.

How Reelix uses it:
- **As a pi provider.** When `magpie.url` is set, Reelix registers a provider named `magpie` pointing at the gateway's OpenAI-compatible address and lists the gateway's models and routing groups. A role then names them like any other model, for example `magpie/group/translate`.
- **A typical role:** `magpie/group/translate, some-provider/some-model`. The second entry keeps Reelix working when the gateway is down.
- **Key:** Reelix has its own gateway key, stored as the secret `magpie.api_key` (entered through the secret field). A gateway on the same machine may not need one.
- **Spending limits:** set on that gateway key in magpie. When magpie refuses a request for budget, the translation pauses, keeps what is finished, and shows magpie's message.
- **Changing magpie** (groups, providers, other keys' limits) is possible with a separate admin key, through plan → check → apply, with guards against the agent changing the model it runs on. See [magpie.md](magpie.md). Reelix's own keys are never changed through Reelix.

Installing magpie is the owner's choice: `magpie serve` on the NAS, or its Docker image. `reelix site status` reports whether the gateway answers.

What was learned from magpie and deliberately left out: translating between provider APIs (pi does this), its seven quota-balancing strategies, intent classification, and conversation affinity.

## Implementation status (2026-11-18)

Built in `packages/server/src/models.ts` (the router), `packages/core/src/config.ts` (roles, inheritance, migration) and the Settings screen.

Verified by tests with a fake runtime:
- the next model answers when the first fails;
- a failed model rests and is asked last;
- inheritance between roles;
- the time limit;
- every model failing pauses the job;
- a fake magpie gateway's models are registered, a missing key is reported, and calls go through it.

A real magpie gateway (v0.1.4405) was used on 2026-11-18 for the tests in [magpie.md](magpie.md): its models and groups list, calls go through it, and Reelix's own limit is read.
