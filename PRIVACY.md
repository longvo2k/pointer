# Privacy

Pointer has no servers, accounts, analytics, or telemetry. Nothing is sent to the author.

## What stays on your computer

- The Chrome extension talks only to the Pointer hub on `127.0.0.1` (your own machine).
- The extension stores two things in its own Chrome storage: a random id that tells your Chrome
  profiles apart, and (until Chrome restarts) the time a profile's window was last focused. Nothing
  else is saved.
- Console and network capture keep the last few hundred entries in memory, only for tabs where an
  agent asked for them, and drop them when the tab closes or Chrome restarts.

## What goes to your agent

When you connect an agent, Pointer gives it what it asks for: page text, lists of buttons and links,
form values (never password fields), screenshots, console messages, and network requests of the tabs
it works in.

**Your agent may send that to its AI model provider.** Claude Code sends it to Anthropic, Cursor and
OpenCode to whichever model you chose, and so on. Their privacy terms apply to it. If a page holds
something you would not paste into that agent's chat, do not point the agent at it.

## Questions

Open an issue on [GitHub](https://github.com/longvo2k/pointer/issues).
