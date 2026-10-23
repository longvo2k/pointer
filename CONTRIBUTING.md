# Contributing

Thanks for helping. Pointer is small on purpose, so most changes are short.

## Set up

```bash
git clone https://github.com/longvo2k/pointer && cd pointer
npm install
npm test
```

Load `extension/` at `chrome://extensions` (Developer mode → Load unpacked) to try changes in Chrome.
After editing the extension, use **Remove** and **Load unpacked** if Chrome keeps running the old copy
(`pointer browsers` flags it as stale).

## Where things go

- Browser mechanics: `extension/` (the service worker owns the hub connection and debugger; the
  content script owns snapshots and the cursor).
- New tools and the text agents read: `lib/tools.mjs`.
- Routing between browsers: `lib/hub.mjs`. Keep it a router.
- Guidance for agents: `skills/pointer/SKILL.md`.

## Rules that keep Pointer trustworthy

- No tool that runs arbitrary JavaScript in a page.
- No network requests to anything but `127.0.0.1`. No analytics.
- No new runtime dependencies without a strong reason.
- Never weaken the hub's request checks; `test/hub.test.mjs` covers them.

CI runs `npm run check`, `npm test`, and checks for outside URLs and dynamic code on every pull
request.

Security problems: see [SECURITY.md](SECURITY.md), not a public issue.
