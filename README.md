# dsh-computer-use

Computer Use for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): let an agent inspect a
desktop UI, click its controls, and type into it — **without stealing focus** most of the time, and with a
real-input channel for the cases where window messages are not enough.

Status: `1.4.0`. **Windows 10/11 is the only platform verified on real hardware.** macOS and Linux providers
exist but are read-only and untested.

---

## What it can do

| Tool | Purpose |
| --- | --- |
| `computer_status` | Report platform readiness and a capability matrix |
| `computer_list_windows` | List visible top-level windows (pid, title, size, class, foreground/minimized) |
| `computer_inspect` | Read the element tree: type, name, bounds, can-invoke, can-set-value, text content |
| `computer_act` | **Background channel** — `invoke` · `set-text` · `scroll-to` · `scroll-page` · `activate` · `click` · `drag` |
| `computer_input` | **Foreground channel** — `move` · `hover` · `click` · `double-click` · `right-click` · `middle-click` · `drag` · `scroll` · `press` · `type` · `wait` |
| `computer_screenshot` | Capture a window or the screen to PNG |
| `computer_clipboard` | Read or write the text clipboard |
| `computer_watch` | Wait for a window to open/close, or for a key to be pressed |
| `computer_scan` | Scroll a long page and capture it screen by screen |

### Two input channels

| | `computer_act` (background) | `computer_input` (foreground) |
| --- | --- | --- |
| Mechanism | UI Automation patterns + window messages | Real `mouse_event` / `keybd_event` injection |
| Moves your cursor | No | **Yes** |
| Needs the target focused | No | Yes, for keyboard/typing |
| Reaches canvas / games | No | **Yes** |
| Works while you use the PC | Yes | No — it takes over input |

Use the background channel when you want work done inside a window while you keep working. Use the foreground
channel when the target only understands real mouse and keyboard — at the cost of your cursor.

---

## Platform support

| Platform | List windows | Element tree | Click element | Write text | Screenshot |
| --- | --- | --- | --- | --- | --- |
| **Windows 10 / 11** (Home / Pro / Enterprise / Education) | ✅ | ✅ full UIA | ✅ no focus steal | ✅ no focus steal | ✅ occluded-safe |
| **macOS 14+** | ✅ | ⚠️ one level below each window | ❌ read-only | ❌ | ⚠️ full screen only |
| **Linux (X11 / Wayland)** | ✅ wmctrl | ❌ | ❌ read-only | ❌ | ✅ screen |

**Windows is the only platform verified on real hardware.** The macOS and Linux providers are written against
their documented APIs but could not be tested here.

Both are read-only on purpose: `osascript`'s `keystroke` and `xdotool`'s synthetic input are global or
unreliable — they act on whichever window has focus, or are silently ignored by GTK/Qt/Wayland targets.
Exposing them as `computer_act` would mean "type this into the app I named" could type into a different
application, and succeed without any error.

---

## Install

```bash
dsh plugin --profile <your-profile> add <path-or-package>
```

It is a normal DSH bundle: `package.json` carries `dsh.bundle.patch`, and `cordis.patch.yml` inserts the plugin
row. Dependencies `koffi` and `pngjs` are prebuilt — no compiler toolchain needed.

### Hot reload while developing

You do **not** need to restart the whole harness after editing plugin code:

```
plugin_manager set_plugin <entryId> enabled=false   → applied
plugin_manager set_plugin <entryId> enabled=true    → applied   (code reloaded)
```

A new session picks up the new tool surface; an existing session keeps its old tool table.

---

## Known limitations

### Antivirus and input injection

Some security products block **simulated vertical wheel input** specifically. On a machine with a bundled
Huorong/Lenovo component (`usysdiag` + `HRWSCCtrl`), `mouse_event` and `SendInput` wheel events reached no
application at all — including a plain Notepad — while `WM_VSCROLL` and keyboard injection kept working.

`computer_scan` therefore uses a ladder rather than one mechanism:

| Target | Vertical | Horizontal |
| --- | --- | --- |
| Win32 (Notepad, Explorer, Office) | `WM_VSCROLL` message | `WM_HSCROLL` |
| Chromium / Electron (Codex, Chrome) | click to focus, then `PageUp` / `PageDown` | Shift + wheel |

If injection is blocked entirely on your machine, the background channel still works; only `computer_input` is
affected.

### Tool results must be plain text

DSH rejects tool results that contain a single `undefined` (`value is not lossless JSON`), and — verified the
hard way — a tool whose `render` returns an **image content block** makes the whole model request fail with
`DeepSeek Messages transport failed`. Every tool here therefore returns plain text only, passes its result
through one `clean()` wrapper, and declares no nested object parameters.

Screenshots return a path; read the image with a separate tool.

### Other constraints

- **Canvas content is invisible to UIA.** A board drawn on a canvas is one opaque rectangle. Screenshot it.
- **Chromium/Electron apps** expose web content to UIA only when accessibility is on. DSH itself does;
  for apps that don't, use a screenshot.
- **Qt apps** (WeChat, for example) may expose almost nothing — a single TitleBar. Only the
  screenshot + coordinate path works there.
- **Drag is message-based and not universally effective.** Controls that rely on real mouse capture
  (Notepad's edit area, many canvas widgets) report success without selecting anything.
- **Minimized windows** have no usable geometry; restore them first.
- **No global input injection.** `computer_act` never moves the system cursor or sends global keystrokes.

---

## How it works

```
lib/index.mjs          tool definitions (plain text results, no nesting)
lib/providers/win.mjs  Windows provider: UIA via helper, capture/input via native
lib/providers/mac.mjs  macOS provider (read-only, osascript)
lib/providers/linux.mjs Linux provider (read-only, wmctrl)
lib/native/win32.mjs   koffi FFI: PrintWindow capture, mouse_event/keybd_event, clipboard
lib/helper.ps1         Windows PowerShell 5.1 helper: UI Automation only
lib/helper-client.mjs  persistent helper client (one JSON line per request)
```

**Why capture and input are native, not PowerShell:** a PowerShell script that captures window bitmaps is
classified by Windows Defender as `HackTool:PowerShell/EmpireGetScreenshot.C`, and AMSI then blocks the entire
script — every capability dies at once. Moving capture and injection into Node (via `koffi`, prebuilt) removes
that failure mode: verified by running the helper from a path with no AV exclusion.

Capture also got faster on the way: about **185 ms per shot** versus ~900 ms for the PowerShell version.

**Why the helper stays resident:** spawning Windows PowerShell costs roughly one second. One `serve` process
answering JSON lines brings a UIA round trip down to ~27 ms — a **37×** difference. Requests are serialised,
a stuck helper is killed on timeout, and any failure falls back to a one-shot spawn.

**DPI:** Node starts DPI-unaware, so on a 200% display `GetWindowRect` reports half the real size and
`PrintWindow` renders only the top-left quadrant. Capture raises the thread DPI context to
`PER_MONITOR_AWARE_V2` and restores it afterwards; input stays in the logical coordinate space that
`SetCursorPos` expects.

---

## Verified on Windows 10 (19045) with DSH 0.2.2-rc.3

| Check | Result |
| --- | --- |
| Enumerate windows | 11 visible top-level windows |
| Read DSH's own Electron UI | **637 UIA elements** |
| Read a WinUI app | 59 elements for Calculator; `7+8=15` driven through the background channel |
| Type with real keyboard events | 283 ASCII characters landed in Notepad, cursor moved to line 30 |
| Scroll a long page | `computer_scan` captured 3 screens; the last frame showed lines that were previously out of view |
| Persistence | 27 ms/call versus 999 ms one-shot (**37×**) |
| Capture speed | 185 ms per shot (native PrintWindow) |
| Clipboard round trip | CJK text written then read back exactly |
| End to end | Read a long conversation in Codex, located its input box, typed 246 characters including CJK, sent it |

CI runs on `windows-latest` with Node 22 and 24: syntax checks, `helper.ps1` parse, and a platform-agnostic
load test. The GitHub runner has no interactive desktop, so real UI automation is not exercised there.

---

## License

MIT
