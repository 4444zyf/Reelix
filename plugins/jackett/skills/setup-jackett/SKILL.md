---
name: setup-jackett
description: Walk the owner through connecting Reelix to their Jackett server(s), step by step. Use when the owner has just switched the jackett plugin on, asks to set up Jackett or indexers, or searches find nothing because no Jackett server is set.
---
# Setting up Jackett

Jackett is the service Reelix searches for releases. One step at a time; confirm each with the owner before the next.

1. **Where is Jackett?** Ask for its address. In docker-compose it is usually `http://jackett:9117`; on the NAS itself `http://host.docker.internal:9117`. Check it answers: `curl -s -o /dev/null -w '%{http_code}\n' <address>/UI/Login` (200 or 302 is fine).
2. **Save the address.** Settings under `plugins` are the owner's to change: call the `reelix` tool with command=config.set and input `{"path":"plugins.jackett.servers","value":[{"url":"<address>"}]}`. Reelix shows the owner the change and asks; only their yes makes it. Up to three servers, one entry each.
3. **The API key.** It is at the top right of Jackett's web page. Ask for it ONLY with the ask tool's secret field: kind=secret, key=`plugins.jackett.api_key` (the second server's is `plugins.jackett.api_key_2`, the third's `plugins.jackett.api_key_3`). Never ask for it in chat and never repeat it; if the owner pastes it into the chat anyway, tell them to replace it in Jackett.
4. **Test.** `reelix jackett indexers --test` lists Jackett's indexers and whether each answers. None configured: indexers are added in Jackett's own web page (the browser tools can help). A failing one: say which and why, from the output.
5. **Finish** with a test search the owner cares about (`release_search`), and note anything odd (a slow indexer, a site behind Cloudflare) in `/data/notes/library.md`.

The owner can do all of this in Settings → Plugins → jackett instead; say so if they prefer forms.
