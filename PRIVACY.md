# Privacy

Pointer has no servers, accounts, analytics, or telemetry. Nothing is sent to the author.

## What stays on your computer

- The Chrome extension talks only to the Pointer hub on `127.0.0.1` (your own machine).
- The extension stores these in its own Chrome storage: a random id that tells your Chrome profiles
  apart; your choices on the settings page (including the sites you block); and, until Chrome
  restarts, the time a profile's window was last focused and what the bar on the agent's tab shows
  (the agent's state, its last action and caption). Nothing else is saved.
- The hub reads Chrome's `Local State` file and the folders Chrome keeps for Pointer's own storage,
  to learn your profiles' names and emails and which profile each Pointer connection runs in. It
  only reads them, and only the names, emails, and folder names leave those files.
- Notifications are off until you turn them on. They are shown by Chrome on your computer and say
  only the agent's name, the site's name, and how many actions it took.
- Console and network capture keep the last few hundred entries in memory, only for tabs where an
  agent asked for them, and drop them when the tab closes or Chrome restarts.

## What goes to your agent

When you connect an agent, Pointer gives it what it asks for: page text, lists of buttons and links,
form values, screenshots, console messages, and network requests of the tabs it works in. Pointer
hides the value of password, one-time-code and card fields (and fields named like them), drops the
`#fragment` from URLs, and replaces secret-looking query values (`token`, `code`, `key`, …) with `…`.
Text the page hides from you is not included in page text. It also gives the agent the name and email of each Chrome profile
on this computer, so it can tell your profiles apart.

**Your agent may send that to its AI model provider.** Claude Code sends it to Anthropic, Cursor and
OpenCode to whichever model you chose, and so on. Their privacy terms apply to it. If a page holds
something you would not paste into that agent's chat, do not point the agent at it.

## Questions

Open an issue on [GitHub](https://github.com/longvo2k/pointer/issues).
