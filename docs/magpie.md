# Configuring magpie from Reelix

Date: 2026-11-18
Status: requested by the owner on 2026-11-18 ("add the ability to carefully configure magpie, but mind the foolish operation, like the agent changing the config of a model that itself is using"). This replaces the earlier rule "Reelix never edits magpie". **Built and tested against a real magpie on 2026-11-18** (see Implementation status).

Related: [models.md](models.md) (roles, fallback, magpie as a provider).

## What was checked on a real magpie

Magpie v0.1.4405 (the `magpie-cli-linux-amd64` release, checksum matched) was run on this machine in a separate home folder (`/tmp/magpie-home`, port 3499), with the owner's Qwen token-plan key. Findings that shape this design:

- **The management API** is at `/v1/magpie/admin/`. It needs a gateway key the owner has allowed to manage magpie (`magpie gateway-key admin <id> local`, or `any` for another machine). An ordinary key gets 403 `gateway_key_not_admin`. The API itself cannot give any key the admin level.
- **An admin key can lift any key's limit, its own caller's included.** `POST gateway-keys/limit-key` with Reelix's key and no limit removes Reelix's spending limit. Magpie does not stop this, so Reelix must.
- **Magpie accepted a routing-group member that does not exist** (`nope/x`) through `routing-groups/update`, even though its docs say this is a 400. Reelix checks members itself.
- **Node's built-in `fetch` is refused** (403 `admin_browser_refused`), because it sends a `Sec-Fetch-Mode` header and magpie treats that as a web page. Reelix calls the admin API with plain `node:http`.
- A local admin key only works when the gateway is reached as `localhost` or `127.0.0.1`. A magpie on another machine needs `admin any`.
- Reelix's own key can read its own limit (`GET /v1/magpie/limit`). A key held to a budget cannot read quotas or usage; the admin key can (`/v1/magpie/quotas`, `/v1/magpie/usage`).

## Two keys

| Secret | Magpie key | Used for |
| --- | --- | --- |
| `magpie.api_key` | an ordinary gateway key, with the owner's spending limit on it | every model call (as before) |
| `magpie.admin_key` | a separate key the owner has allowed to manage magpie | reading and changing magpie's setup |

Without `magpie.admin_key`, Reelix can still show the gateway's models and its own limit, but cannot change anything. Both keys are entered through the secret field, never in chat.

## What Reelix may change

A closed list, nothing else:

| Change | Undo |
| --- | --- |
| create a routing group (name, members, routing, stays) | remove it |
| change a routing group (members, routing, stays, name) | put back what it was |
| remove a routing group | create it again as it was |
| switch a provider on or off | switch it back |
| add a provider from a preset, its key entered by the owner through the secret field | remove it |
| remove a provider | **cannot be undone** (its key is gone) |
| set or lift the limit of another gateway key | put the earlier limits back |

**Never, for anyone, through Reelix:** Reelix's own two keys (limits, models, accounts, rotation, removal, switching off), any key with the admin level, sign-ins, exporting accounts or backups, and magpie's settings for this computer's other agents. Those are done in magpie. This keeps the agent from raising its own budget.

## Plan, then apply

Every change goes in two steps, so nothing changes without being looked at first.

1. **`magpie.plan`** reads magpie's current state and returns a plan:
   - what will change (before and after);
   - what uses it: the roles that name it (directly, through a group, or through a group inside a group) and the conversations, jobs and translations running on it right now;
   - whether every role still has a usable model afterwards;
   - a level: **safe**, **needs approval**, or **refused**, with the reasons.
   Plans are kept for 30 minutes.
2. **`magpie.apply`** carries a plan out. Before it does, it reads magpie again: if the target changed since the plan, or the level got worse, it refuses and asks for a new plan.

### Levels

**Refused** for the agent (in chat or in a background job):
- the change touches **the model the agent is running on right now**: its own routing group, a group inside it, or a provider that serves it. This is the "sawing off the branch you sit on" case. The agent tells the owner, who can do it from Settings or the terminal.
- the change would leave **a role with no usable model** (for example, removing the only group in `translate`, or switching off the only provider behind it).
- the change touches a protected key (refused for the owner too).
- the plan is invalid: a member magpie doesn't serve, a group inside itself, an unknown routing.

**Needs approval** (the owner says yes):
- anything used by a role or by something running now;
- any removal;
- adding, removing, or switching a provider;
- any key limit.

For the owner, "refused" items other than protected keys become "needs approval": the owner may empty a role on purpose. Running a plan from the terminal or the Settings screen is the owner's approval.

**Safe** (the agent may apply without asking): creating a group, or changing a group nothing uses.

### How approval reaches the owner

- **In chat:** applying a plan that needs approval shows the plan as a yes/no question. Only the owner's answer counts.
- **In a background job:** it posts the plan to the Inbox with *Approve* / *Decline* and parks. When the owner approves, the job resumes and applies it.
- An approval only counts when it comes from the owner (`owner:web`, `owner:cli`, or a chat channel the owner has allowed to approve, such as `owner:telegram`: Settings → Chat channels, on by default only for a Telegram linked before channels existed). An agent answering an Inbox item itself does not approve anything.

## After a change

1. Reelix asks magpie for its models again, so pi sees new and removed groups at once.
2. **Check:** each changed thing that a role uses gets one tiny request through the gateway ("Reply OK"). A new group nothing uses yet gets one too, to report whether it works.
3. **Automatic rollback:** if a check fails on something a role uses, Reelix puts back what it changed and reports both the error and the rollback.
4. The change is in the ledger with what it was before, so **`magpie.undo`** (plan and apply again) can reverse it later.

## Reading

`magpie.status` shows:
- whether the gateway answers, and its models;
- routing groups with their members;
- providers: on or off, keys, models;
- Reelix's own limit, what's used and when it renews;
- with the admin key: quotas;
- which roles use which magpie models.

The agent uses it to answer "why did translation stop?", for example "Reelix's key has used $1.00 of $1.00 today; it renews at 08:00".

## Honest limits

- The agent has a shell. The guard stops mistakes made through Reelix's tools; it cannot stop an agent that reads `secrets.yaml` and calls magpie with curl. The shell carries the session's `REELIX_TOKEN`, so `reelix magpie ...` in that shell is treated as the agent, not the owner.
- The check costs one small request per affected group.
- "Running right now" is what this Reelix process is doing. Other programs using the same magpie (StardewPilot, coding agents) are not seen. Magpie's own Requests page shows them.

## Implementation status (2026-11-18)

Built:
- `packages/core/src/magpie.ts`: the client (plain `node:http`), state reading, plan levels, apply with checks and rollback, undo, and the operations `magpie.status`, `magpie.plan`, `magpie.apply`, `magpie.undo` (agent tools `magpie_status`, `magpie_plan`, `magpie_apply`, `magpie_undo`; terminal `reelix magpie ...`).
- `packages/server/src/agent/host.ts`: what runs on which model right now (conversations, background jobs, translation calls), and listing magpie's models again after a change.
- `packages/server/src/agent/tools.ts`: the approval step (a question in chat; an Inbox item and parking in a job).
- Settings → Models shows Reelix's own limit and whether changes are possible. Skill `skills/magpie`. A rule in the agent's prompt.

Tested with a fake magpie (`packages/core/test/magpie.test.ts`, `packages/server/test/magpie-tools.test.ts`, 7 tests):
- the management API is called without browser headers;
- unknown members and loops are refused;
- the model the agent runs on, through a group inside a group, is refused;
- a role left empty is refused for the agent and needs approval for the owner;
- a change that breaks a role is rolled back, and undo reverses a kept change;
- Reelix's own keys are refused even for the owner;
- an agent answering the Inbox approves nothing;
- a change in magpie between plan and apply is caught;
- chat asks, and a job parks and goes ahead after the owner's Approve.

Tested against a real magpie (v0.1.4405, sandboxed on port 3499, the owner's Qwen token-plan key, a DeepSeek provider with a deliberately invalid key):
- status read groups, providers, keys and Reelix's own $1/day limit;
- the agent created a group, and the check went through Qwen and answered;
- switching off the provider the agent runs on was refused, with every role listed as left empty;
- lifting Reelix's own limit was refused;
- swapping the group to the invalid DeepSeek key failed its check (401) and was put back automatically;
- a routing change needed approval, went through after it, and was undone;
- the test group was removed at the end.

Second round on the real magpie (2026-11-18):
- **Providers:** adding one is refused until the owner's key is waiting. With the key it needs approval; the key appears in neither the plan nor the ledger and is deleted from Reelix's secrets after use. Switching off and on works, and removal needs approval and refuses undo.
- **Another key's limits:** two limits (week $5, every 5 hours 200k tokens) are set and read back. Undo restores no limit, or an earlier 3-day $2 limit, exactly. Reelix's own $1/day is untouched throughout. Undo restarts a limit's period, because magpie stamps a new start whenever a limit is set.
- **magpie's own groups** (`auto/<model>`, made when two providers serve one model) are followed like any other. The agent running on one cannot switch off a provider behind it.
- **Settings in a browser** (headless Chromium, on a Reelix bound to 127.0.0.1): the normal, spent and read-only lines all render, in all four languages, with localized amounts and dates.

Bugs found by the live tests and fixed:
- magpie reports a key's second and later limits as `moreLimits`. Reelix read only the first, so undo would have dropped the others.
- magpie names token limits `tokenLimit`, not `tokensLimit`, which hid them in the status text.
- Rollback was too eager. Switching a provider *on* whose key is bad failed its check and was switched off again, although it broke nothing. Now only something that worked before the change and fails after it is put back; other failures are reported.
- magpie's own groups are named `auto/<model>`, not `group/<id>`. Reelix now uses each group's `ref`.
- Settings showed Reelix's spending as of start-up. It is now read again at most once a minute, and when the admin key is added or removed.

Not tested: a magpie on another machine (`admin any`). Simulating one needs magpie's network sharing turned on, and that step was blocked by the session's safety check. On this server the only other address is public, and the sandbox magpie holds the owner's real Qwen key.
