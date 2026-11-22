# The installable web app and native notifications

Date: 2026-11-18
Status: asked for by the owner on 2026-11-18 ("implement the web app, use the native notification capability").

## What it is

Reelix's existing web UI, installable on a phone or computer (on iOS: Share → Add to Home Screen). It opens full-screen with its own icon and can show the operating system's own notifications through standard Web Push. There is no separate app and no App Store.

## What needs a notification

One rule for every notifier, applied by Reelix's dispatcher (`docs/plugins.md` §7.3): anything that needs the owner (questions, plans, verification, urgent notices). Routine notices stay in the Inbox. The `telegram` and `push` plugins are independent; either, both or neither can be on.

A notification shows the Inbox item's title and a short body. Tapping it opens that item in the Inbox, where it is answered. iOS web notifications have no answer buttons and no pictures, so Telegram remains the way to answer without opening anything.

The icon's badge is the number of open Inbox items. It is set by each notification and corrected whenever the app is open. Notifications for items already handled are removed when the app next opens: iOS does not allow a silent push to remove them earlier.

## How it works

- **Each device turns it on itself**, in Settings → Notifications, by a tap (iOS only asks for permission after one).
- **Keys.** Reelix makes one VAPID key pair on first use. The private key is in `secrets.yaml` (`push.vapid_private`), the public key goes to browsers. No Apple or Google account is needed.
- **Sending.** The NAS connects outward to the browser maker's push service (Apple, Google, Mozilla, Microsoft). Nothing on the NAS has to be reachable for delivery. The `push` entry of the proxy settings applies.
- **Privacy.** Every message is end-to-end encrypted for the device (RFC 8291), so the push service sees only its size and timing. The text is put through the same secret filter as other output.
- **Format.** Messages use WebKit's Declarative Web Push format, so iOS 18.4 and later show them without running any page code. A small service worker reads the same message on older iOS and on other browsers.
- **Only known push services.** A subscription's address must be HTTPS on a known push service, so the sign-up route cannot be used to make Reelix call arbitrary addresses.
- **Dead devices.** When the service says a subscription is gone (404, 410), it is deleted. Busy or failed sends are retried once after 30 seconds, and the last error is shown in Settings.

## What the owner needs

**HTTPS with a certificate the phone trusts.** Browsers offer neither service workers nor push on plain HTTP, except on `localhost`. Options, best first:

1. **Tailscale** on the NAS and the phone: `tailscale serve --bg 7878` gives `https://<nas>.<tailnet>.ts.net` and opens nothing to the internet.
2. A reverse proxy the owner already runs, with a real certificate.

Settings explains which step is missing on the device in use: HTTPS, installing to the Home Screen, or permission.

An installed iOS app keeps its own sign-in, separate from Safari, so the owner signs in once more inside it.

## Playing: one tap into Infuse, Swiftfin or Jellyfin

Asked for by the owner on 2026-11-18: jump to the specific video, in one click from the library or from chat ("I want to watch…"). The links come from the players (`reelix:player@1`, [plugins.md](plugins.md) §7.9); the built-in plugin `players` has the three below. They are offered in the order of the setting `players` (Settings → Services → Media server), and a player not in that list comes after.

| App | Link | What it does |
| --- | --- | --- |
| Infuse | `infuse://movie/{tmdb}?play`, `infuse://series/{tmdb}-{season}-{episode}?play` | Finds the title in the Infuse library by TMDB ID and starts playing |
| Swiftfin | `swiftfin://{server}/{user}/item/{item}` | Opens that film or episode's page (Swiftfin has no link that starts playback) |
| Jellyfin web | `{public address}/web/#/details?id={item}&serverId={server}` | Opens the page in the browser |

- **Where:** a play button on each library poster and on the title page, one on each episode, and a play card in chat. For "I want to watch…" the agent shows the card; the owner taps it.
- **Which episode:** the one asked for, else the media server's Next Up for the history user (the `jellyfin` plugin's `watch_users`), else the first episode in the library. Swiftfin and Jellyfin web get the server's ids for the item from the active media server (`reelix:media.server@1`), never from the `jellyfin` plugin directly.
- **One tap:** the first tap asks which player, per device; after that the button opens that player directly, and the others stay in its menu. The choice is remembered by the player's id (`infuse`, `swiftfin`, `jellyfin`). A link to a web address opens in a new tab.
- **No secrets leave the NAS.** Links hold only IDs. Each app plays through its own sign-in, so no Jellyfin key or stream address reaches the phone.
- **Needs:** Infuse must have the same library added. Swiftfin must be signed in as the same Jellyfin user and needs a recent version. Jellyfin web needs the `jellyfin` plugin's `public_url` when Reelix reaches Jellyfin by a Docker name.

## Not included

- No offline mode: Reelix is a live connection to the NAS, and a cached copy could show stale state.
- No answer buttons on notifications, because iOS does not support them for web apps.

## Implementation status (2026-11-18)

Built: the manifest, icons and service worker (`packages/web/public`); the `push` plugin in `plugins/push` (keys, devices, encryption, signing, sending) with its operations `push.devices`, `push.subscribe`, `push.unsubscribe` and `push.test`; Settings → Notifications; Inbox items opened from a notification; badge and stale-notification upkeep; `packages/core/src/playback.ts`, `title.play`, `library.play_links`, the `show` tool's `kind=play`, and play buttons on posters, the title page, episodes and chat.

Verified:
- `plugins/push/test/push.test.ts` and `packages/core/test/playback.test.ts`.
- **A real delivery through Mozilla's push service**: it accepted the signed message and the test receiver decrypted the exact text.
- In real Chromium: manifest and icons served, worker registered, a pushed message shown as a system notification, tapping it opens and highlights the Inbox item, the notification is cleared, the right message appears on plain HTTP and in iPhone Safari, poster, title-page and chat play links are correct, and the player choice is remembered. In chat the real model answered "I want to watch Sintel" with the play card.
- Link formats were taken from Infuse's API page, Swiftfin's `DeepLink.swift` and jellyfin-web's router.

Not verified:
- **On a real iPhone**: installing, the permission prompt, delivery through Apple, and the badge. This needs HTTPS. Apple was only reached with a made-up device address, which it refused (`BadWebPushToken`), so its acceptance of a real subscription is unproven.
- Subscribing in the test Chromium fails because it has no Google push keys, so the Settings flow used a stand-in subscription.
- Opening Infuse or Swiftfin themselves, and the requests against a real Jellyfin server.
