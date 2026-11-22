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
- **Agent conversations** (chat and background jobs): the first model in the list that pi knows is used for the session. A model that has just failed is skipped for a while, so the next conversation starts on the next one. In chat, the owner's next message opens the conversation again on the next model. A background job does not wait: the next model takes the task over at once ("continue from where it stopped"), each model of the list once.
- **Only the role's list.** The router never uses a model outside the role's list: not another known model, not a cheaper or dearer one, not pi's default. Pi's default is used only by a role with no list of its own and nothing to inherit. A model that is resting is still asked, last, rather than going outside the list. A test proves this (`packages/server/test/models.test.ts`).

### Why a call failed

Every failed call is classified from what the provider said (`classifyFailure` in `packages/server/src/models.ts`). Each class has one action for the owner:

| Class | For example | Action |
| --- | --- | --- |
| `signed_out` | 401/403, an invalid or expired key, an expired sign-in, no key for the provider, a model pi does not know | **reconnect** the provider |
| `timeout` | no answer within the time limit, a request that timed out | **retry** |
| `rate_limited` | 429, "too many requests", an overloaded provider, a quota per minute | **wait** until the time the provider named, when it named one |
| `budget` | "exceeded your current quota", billing, a spending limit (magpie's included), Reelix's own daily background limit | **wait** until the renewal: the time named, or for magpie the reset of Reelix's limit there, or for Reelix's own limit the next day |
| `capability` | the context is too long, the model cannot read images (`capability: "context"` or `"images"`) | **choose a model that can** |
| `other` | anything else | **retry** |

A failed model rests for a minute, doubling up to half an hour while it keeps failing, or until the time its provider named if that is later. Settings sees each resting model, why and until when (`/api/status` → `model.rests`).

What is recorded, and where the owner sees it:
- **Chat.** The failed answer carries its class (`failure`), shown under it in the owner's language with its action. The next answer that comes from another model carries the failure before it (`fallback`), shown above it: "qwen/a could not answer (signed out, or its key expired), so qwen/b, the next model in your list, answered." Both come live (`assistant_start`, `assistant_end`) and from the saved conversation, so they survive a reload. A refusal before any answer (no key) shows as an error line with its class.
- **Background jobs.** The job record (`job_runs.models_json`) keeps the model that did the work and the models that failed before it, each with its class; the Activity screen shows them under the run. A job that waits for Reelix's own daily limit records a `budget` failure with the time it resumes.
- **Direct calls.** The answer names the models skipped on the way (`skipped`); when none answers, the pause carries each model's failure.

**Test.** `model.test { role? }` asks a role's models one short question (default the chat role) and returns the answer, the model that gave it, how long it took and any failures with their class ([api.md](api.md)). Settings uses it after connecting a model; a model that answers stops resting.

### No model connected

When `/api/status` lists no models, Settings → Models shows the "No model connected" flow ([settings.md](settings.md), `ModelSetup` in `packages/web/src/components/settings/`): connect a provider (below, or connect magpie), choose the chat model, test it. The status refreshes every few seconds while the flow is open.

### Connecting a provider

Asked for by the owner on 2026-11-22: connecting a model must not need a terminal. Settings → Models lists the providers pi knows (the well-known ones first, the rest found by name), which are signed in, and each one's ways in: its own sign-in, an API key, or both (`model.providers`). Connecting runs pi's own login (`ModelRuntime.login`) on the server (`packages/server/src/model-login.ts`); its questions (a key, a code, a choice between "browser" and "copy code") and its messages (a sign-in link, a device code) go to the page and the answers come back (`model.login`, `model.login_state`, `model.login_answer`, `model.login_cancel`). The credential lands in pi's `auth.json` in Reelix's pi folder, as if `pi` had been run there, and the new models are listed at once. A key or code typed in never reaches the ledger or the agent; the operations are the owner's (`admin`). A provider whose sign-in was stored can be signed out (`model.logout`); one configured by the machine's environment is shown as signed in, without that button. A provider's own sign-in on a NAS works by "copy code": the page shows the link, the owner signs in in their browser and pastes the code back.

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
- a fake magpie gateway's models are registered, a missing key is reported, and calls go through it;
- (2026-11-22) each failure class from realistic provider messages, the reason recorded with each skipped and resting model, no model outside the role's list, and `model.test`;
- (2026-11-22) a real agent session on two fake models: the failure shows in chat live and after a reload, the next answer names it, and a background job is taken over by the next model with both recorded.

A real magpie gateway (v0.1.4405) was used on 2026-11-18 for the tests in [magpie.md](magpie.md): its models and groups list, calls go through it, and Reelix's own limit is read.
