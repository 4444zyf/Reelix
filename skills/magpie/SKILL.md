---
name: magpie
description: Reading and changing the owner's magpie model gateway (routing groups, providers, other gateway keys' limits) with magpie_status, magpie_plan, magpie_apply and magpie_undo. Covers why a model stopped (budget, quota, a provider off), making a routing group for a role, and the rules that keep you from breaking the model you run on. Use when the owner asks about magpie, model budgets or quotas, or wants a role to fail over between models.
---
# magpie

magpie is an optional local gateway between Reelix and the model providers. Roles name its models as `magpie/<provider>/<model>` or `magpie/group/<id>` (a routing group: several models picked as one, with failover). Details: docs/magpie.md.

## Reading

`magpie_status` shows the gateway's models, routing groups, providers (on/off), gateway keys and their limits, **Reelix's own limit and what is left**, and which roles use magpie. Add `quotas: true` for each plan's allowance.

Use it first when translation or a job pauses with a budget or quota message: "Reelix's key has used $1.00 of $1.00 today; it renews at 00:00 UTC."

## Changing: always plan → apply

1. `magpie_plan` with the change. Nothing changes yet. Read the plan:
   - **safe**: apply it.
   - **needs approval**: `magpie_apply` asks the owner (a question in chat; in a background job an Inbox item, and you park). Say in one line what it changes and why before you apply.
   - **refused**: do not try another way. Tell the owner the reason and what they can do (Settings, the terminal, or magpie itself).
2. `magpie_apply` with the plan id. Afterwards every changed thing a role uses is sent one tiny request; if it fails, the change is put back automatically. Report the result as it is, including a rollback.
3. To reverse a change later: `magpie_undo` with the action id, then `magpie_apply`.

## Rules you cannot argue with

- **Never change the model you are running on**: your own routing group, a group inside it, or its provider. You would cut the branch you sit on. The plan refuses it; the owner can do it.
- **Never leave a role with no usable model.**
- **Never touch Reelix's own gateway keys** (their limits, models, rotation): raising your own budget is the owner's decision, made in magpie.
- Never call magpie's admin API with curl or run magpie's CLI from the shell. The tools are the only way, because they check.
- Provider keys come from the owner through `ask` kind=secret with `secret_key=magpie.new_provider_key`, never through chat. Then plan `provider.add` with the preset.

## Common tasks

- **A role that fails over:** create a group (`group.create`, members in order, `routing: order`), check it answers (the apply does), then suggest the owner put `magpie/group/<id>` first in that role under Settings → Models, with a non-magpie model after it so Reelix keeps working when the gateway is down.
- **Members** are named as magpie names them in `magpie_status` (`provider/model`, or `group/<id>`). An unknown name is refused, even though magpie itself would accept it.
- **"Stop using DeepSeek for a while":** `provider.off` on that provider. If a role depends on it alone, the plan says so.
