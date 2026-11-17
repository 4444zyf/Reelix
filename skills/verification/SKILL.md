---
name: verification
description: The escalation ladder for human-verification checks (Cloudflare, captchas, QR codes, phone codes) on sites like subhd — avoid, use the real browser, do what's on the page, hand over only what needs the owner, live view takeover, fall back. Use when a site blocks or asks to verify.
---
# Verification ladder

1. **Avoid it.** Plain requests first, a gentle pace, and respect each site's remembered limits (`reelix site status`).
2. **Use the real browser** (`browser_open`): it has a saved profile, so cookies from earlier passes persist; Cloudflare's checks often pass by themselves after a few seconds — `browser_wait` then `browser_snapshot`.
3. **Do what is on the page** when you can do it as the owner would: tick the "verify you are human" box, type a code you can read in a screenshot (`browser_screenshot` shows you the page).
4. **Hand over only what needs the owner** — a QR code to scan with their phone, or a code sent to their phone:
   - In chat: `browser_screenshot` (crop to the QR if possible) and `show` it with kind=verification, keep the page open, wait for the owner's reply, type the code in.
   - In a background job: `notify` with the screenshot (attach=true, wait=false), wait up to a few minutes with `browser_wait_for_answer`; if no reply, `notify wait=true` and stop — the job parks and releases the tab. When resumed later, start the verification afresh (codes expire) and send a new picture.
5. **Let the owner take over** in the live view (Browser screen): say so and wait.
6. **Fall back:** another source (ASSRT for subtitles), a retry later, and a plain account of what happened.

Never: disguise the browser, use paid solving services, or hammer a site. Cloudflare sometimes refuses automated browsers outright; then go to steps 4–6.
