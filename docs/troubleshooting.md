# Troubleshooting

**The change is not there after editing the extension** (unpacked copy). Chrome can keep running an old copy of an
unpacked extension even after Reload: the card shows the new version while the old code runs.
`pointer browsers` flags this as `⚠ stale`. Click **Remove** on `chrome://extensions`, then **Load
unpacked** again. On Chrome 137+ a reloaded unpacked extension can also be disabled as an
"unsupported developer extension"; loading it again fixes that too.

**Hub changes are not picked up.** The hub reloads when it restarts. Stop it with
`pkill -f "pointer.mjs serve"`; the next Pointer command starts the new one.

**"WebSocket connection … ERR_CONNECTION_REFUSED" on the extension's Errors page.** The extension
tried to reach the hub while it was not running. It keeps retrying and connects once any agent or
`pointer` command starts the hub. Chrome groups the repeats into one entry; **Clear all** removes it.

**A result says "sent as page events".** Password managers such as 1Password put their own frame
into some pages, and Chrome then refuses debugger input on that tab. Pointer falls back to page
events for click, fill, and press. Most sites accept them; file upload has no fallback. Chrome can
also drop typed text there without an error, so `fill` checks the field afterwards: if the text did
not land it retries with page events, and fails with a message if the field is still empty.

**`console` says messages are read from the page itself.** On those same pages Chrome refuses the
debugger, so Pointer hooks the page's console instead. It sees messages only from its first
`console` call on that page, and a reload or navigation clears them. `network` has no such
fallback and asks you to close the password manager's popup.

**A command was slow and you want to know where the time went.** Set `POINTER_DEBUG=1` to print the
time of each step to stderr, or `POINTER_DEBUG=/tmp/pointer.log` to append it to a file. Lines
starting with `ext` come from the extension and show which step inside a command was slow (finding
the element, waiting for the page to load, and so on). The file
form also logs the background hub, as long as the hub was started with it set (stop the old hub
with `pkill -f "pointer.mjs serve"` first).

**The agent stopped and asks before continuing.** You pressed `Esc`, `Alt+Shift+S`, the popup's
Stop, or clicked in the agent's tab while it was on screen. That is the stop signal, by design: every
action is refused until the agent asks and calls `resume`. `Esc` in your other tabs does not count.

**The hub refuses the extension ("not a Pointer build it knows").** The hub accepts the Web Store
build and the `extension` folder of its own install. If you load Pointer from another folder, set
`POINTER_EXTENSION_IDS` to the id `pointer status` shows, then restart the hub.
