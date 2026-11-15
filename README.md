# dsh-computer-use

[![test](https://github.com/xushengqiong-ship/dsh-computer-use/actions/workflows/test.yml/badge.svg)](https://github.com/xushengqiong-ship/dsh-computer-use/actions/workflows/test.yml)

English | [简体中文](README.zh-CN.md)

**Cross-platform Computer Use for DeepSeek Harness.** One tool vocabulary, three
platform providers: read a real application's UI tree, click its controls, write
text without stealing focus, and screenshot it even when occluded.

Inspired by [dsh-computer-use](https://github.com/Anionex/dsh-computer-use) (macOS only).
Independent implementation, no shared code.

## Platform support — read this first

Capability genuinely differs per platform. This table is what the code actually
does, not an aspiration:

| Platform | List windows | Element tree | Click element | Write text | Screenshot |
| --- | --- | --- | --- | --- | --- |
| **Windows 10 / 11** (Home / Pro / Enterprise / Education) | ✅ | ✅ full UIA | ✅ no focus steal | ✅ no focus steal | ✅ occluded-safe |
| **macOS 14+** | ✅ | ⚠️ one level below each window | ❌ **read-only** | ❌ | ⚠️ full screen only |
| **Linux (X11 / Wayland)** | ✅ wmctrl | ❌ | ❌ **read-only** | ❌ | ✅ screen |

Legend: ✅ works · ⚠️ partial / caveated · ❌ unsupported

**Windows is the only platform verified on a real machine.** macOS and Linux
providers are written against their documented APIs but could not be tested
here; treat them as best-effort and report what breaks.

### Why macOS and Linux are read-only (0.4.0)

`osascript`'s `keystroke` / `click at` and `xdotool`'s synthetic input are
**global or unreliable**: they act on whatever window currently has focus, or are
silently ignored by GTK/Qt/Wayland targets. Exposing them as `computer_act`
meant "type this into the app I named" could instead type into a different
application — and succeed without any error. Since that cannot be made safe
without a native per-window backend, those platforms now support observation
only and every mutation returns `unsupported` with an explanation.

### Why Linux is weaker

Linux has no cross-toolkit accessibility API comparable to UIA or AX. AT-SPI2
exists, but it needs a `pyatspi` bridge and behaves differently per desktop and
per toolkit (GTK vs Qt vs Electron). Rather than ship something that silently
fails, the Linux provider does what it can — window lists, screenshots, xdotool
input — and returns an explicit "unsupported" for element inspection.

## Tools

| Tool | Purpose |
| --- | --- |
| `computer_status` | Report platform, readiness and which capabilities are available |
| `computer_list_windows` | List visible top-level windows (pid, title, size, plus class/foreground on Windows) |
| `computer_inspect` | Read the element tree (type, name, bounds, can-invoke, can-set-value), optional screenshot |
| `computer_act` | **Background channel**: `invoke` · `set-text` · `scroll-to` · `activate` · `click` · `drag` — targets a window, never moves the cursor |
| `computer_input` | **Foreground channel**: `move` · `hover` · `click` · `double-click` · `right-click` · `middle-click` · `drag` · `scroll` · `press` · `type` · `wait` — real SendInput events |
| `computer_screenshot` | Capture window or screen to PNG; pair with `read_image` to actually see it |

### Two input channels, two trade-offs

| | `computer_act` (background) | `computer_input` (foreground) |
| --- | --- | --- |
| Mechanism | UIA patterns + window messages | `SendInput` — real pointer/keyboard events |
| Moves your cursor | ❌ no | ✅ **yes** |
| Needs target focused | ❌ no | ✅ yes for keyboard/typing |
| Reaches canvas / games | ❌ no | ✅ **yes** |
| Works while you use the PC | ✅ yes | ❌ it takes over the input |

Use the background channel when you want work done in a window while you keep
working. Use the foreground channel when the target only understands real
mouse/keyboard — at the cost of your cursor.

## How each platform works

| Platform | Mechanism |
| --- | --- |
| Windows | `UIAutomationClient` (.NET Framework) through **Windows PowerShell 5.1**, kept alive as a **persistent `serve` process**; `InvokePattern` for clicks; `WM_SETTEXT` fallback for legacy controls; `PrintWindow(PW_RENDERFULLCONTENT)` for occluded capture; `WM_LBUTTONDOWN/MOUSEMOVE/UP` for drag |
| macOS | `osascript` → System Events (`click button`, `keystroke`, `click at`); `screencapture` |
| Linux | `wmctrl` for windows, `xdotool` for input, `grim` / ImageMagick / `gnome-screenshot` for capture; no element tree |

### Why the helper stays resident

Spawning Windows PowerShell costs about **1 second** (process start + .NET assembly
load). Measured on this machine with 5 consecutive window lists:

| Mode | Per call |
| --- | --- |
| One-shot spawn | 999 ms |
| Persistent `serve` process | **27 ms** |

That is a **37×** difference, so the Windows provider keeps one helper alive and
exchanges one JSON line per request. Requests are serialised (PowerShell is
single-threaded), a stuck helper is killed on timeout, and any failure falls back
to a one-shot spawn.

`computer_inspect` with `screenshot: true` now captures **in the same round trip**
as the tree read, instead of two separate calls.

Every Windows call re-enumerates the live tree, so an index is never replayed
against a window that changed. `expectName` adds a hard guard: the element name
must match exactly or the action is refused.

## Verified on Windows 10 (19045) + DSH 0.2.2-rc.3

| Check | Result |
| --- | --- |
| Enumerate windows | 12 visible top-level windows |
| Read DSH's own Electron UI | **502–783 UIA elements** depending on view state |
| Persistent helper speed | 27 ms/call vs 999 ms one-shot (**37×**) |
| Combined tree + screenshot | 3526 elements and a PNG in one round trip |
| Click a control | `InvokePattern` toggled the sidebar and toggled it back |
| Write CJK text | Chinese written into Notepad via `WM_SETTEXT`, UTF-8 intact |
| Screenshot occluded window | Notepad fully covered, captured correctly via `PrintWindow` |
| Drag | Message-based drag reports success, but see the limitation below |

## Known limitations

- **Canvas content is invisible to UIA.** A board drawn on a canvas is one opaque rectangle — there are no controls to click. Screenshot it, or have the app expose state as text.
- **Chromium/Electron apps** expose web content to UIA only when accessibility is enabled. DSH itself does (783 elements measured); for apps that don't, use `computer_screenshot` + `read_image`.
- **Drag is message-based and not universally effective.** It sends `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` / `WM_LBUTTONUP` to the target window, so no focus is stolen — but controls that rely on real mouse capture (Notepad's edit area, many canvas widgets) report success without actually selecting anything. Verified: dragging across text in Notepad produced no selection. Prefer `set-text` / `invoke`; treat drag as best-effort.
- **Minimized windows** have no usable geometry; restore them first.
- **No global input injection.** This plugin never moves the system cursor or sends global keystrokes; everything is targeted at a specific window.

## Install

```powershell
# Windows
dsh plugin --profile <profile> add file:C:\path\to\dsh-computer-use
```

```bash
# macOS / Linux — same command shape
dsh plugin --profile <profile> add file:/path/to/dsh-computer-use
```

Then restart DSH so the bundle and tools load.

### Prerequisites

| Platform | Needs |
| --- | --- |
| Windows | Windows PowerShell 5.1 (present on every Windows 10/11). Override with `DSH_WIN_CU_POWERSHELL` |
| macOS | Accessibility permission for the app running DSH (System Settings → Privacy & Security → Accessibility) |
| Linux | `wmctrl`, `xdotool`, and a screenshot tool (`grim` on Wayland, else ImageMagick or `gnome-screenshot`) |

## Safety

- No tool deletes files, kills processes, shuts down, or sends input outside the selected window.
- `computer_act` accepts `expectName`; when supplied it must match exactly — use it for anything irreversible.
- Read-only actions (`computer_status`, `computer_list_windows`, `computer_inspect`) never modify a window.
- Screenshots can contain anything on screen; treat them as sensitive.

## Testing

```powershell
node --check lib/index.mjs
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-platform.mjs
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-live.mjs   # touches the real desktop
```

## Scrolling: which path works where

A bundled AV product (Lenovo Windows Security Center / Huorong) blocks simulated
**vertical wheel** input, while window messages and keyboard injection keep
working. `computer_scan` therefore uses a ladder instead of one mechanism:

| Target | Vertical | Horizontal |
| --- | --- | --- |
| Win32 (Notepad, Explorer, Office) | `WM_VSCROLL` message ✅ | `WM_HSCROLL` |
| Chromium / Electron (Codex, Chrome) | click to focus + `PageUp`/`PageDown` ✅ | **Shift + wheel ✅** |

Measured on a 20-column table page: Shift+wheel moved the view from `COL-01` to
`COL-11`. Ordinary wheel events did nothing in the same Chromium view, so the
block is not "injection is dead" but "Chromium ignores synthesised vertical
wheel scrolling".

## New in 0.8.0 — native capture and input (no antivirus friction)

Screenshot and input used to live in the PowerShell helper. Windows Defender
classifies "a PowerShell script that captures window bitmaps" as
`HackTool:PowerShell/EmpireGetScreenshot.C` and blocks the entire script through
AMSI — which disabled every capability at once.

Both now run in Node.js through `koffi` FFI against `user32.dll` / `gdi32.dll`:

| | PowerShell helper | Native (koffi) |
| --- | --- | --- |
| Window capture | ~900 ms | **185 ms** |
| AMSI script scan | ❌ blocked | ✅ not applicable |
| Needs an AV exclusion | yes | **no** |

The helper now contains UI Automation only. Verified: a copy of `helper.ps1`
placed outside any exclusion path runs clean (`Defender` no longer flags it).

## New in 0.5.0 — foreground input channel

Mirrors the input surface Codex's computer use exposes:

- `move` / `click` / `drag` / `scroll` / `press` (supports `ctrl+s` combos) / `type` (CJK included)
- Real `SendInput`, so it **reaches canvas, games and any UI**
- Cost: it moves the system cursor; typing needs the target in the foreground

Verified on Windows 10: cursor move ✅ (962,533 → 400,300, restored afterwards) and typing ✅ (wrote `SendInput typing works 123` into Notepad).

## Fixed in 0.4.0

| ID | Problem | Fix |
| --- | --- | --- |
| A01 | A failed persistent call replayed mutating actions | Mutating actions now return `state: 'unknown'` and are never retried |
| A02 | Fallback path read wire fields (`req.title`) that only exist as `titleB64` | One business request, two encoders; fallback reads the original options |
| A03 | Late events from a dead helper could settle a newer request | Every request is bound to its process instance |
| A05 | `click` fell through to `unknown action` | Explicit `click → clickxy` mapping |
| A08 | Write fell back to the top-level window handle (retitled windows) | Refuses unless the element has its own HWND |
| A09 | `set-text` reported the request text as if verified | Reads back and returns `state: verified / applied-unverified` |
| A10 | Missing target silently captured the whole screen | Fails instead; screenshots report `scope: window / screen` |
| A11 | Clicks used client coordinates while screenshots use window coordinates | Offset computed via `ClientToScreen`, returned as `offset` |
| A12/A13 | macOS/Linux input was global, not target-bound | Both providers are read-only; mutations return `unsupported` |
| A14 | Capability reporting was vague | `computer_status` lists concrete capabilities per provider |

## Still open

- Observation IDs (A07): UIA `RuntimeId` is empty for many controls (verified on
  Notepad's edit area), so identity must be AutomationId + ControlType + name +
  tree path — designed but not implemented.
- Bounded UIA traversal (B01) and richer model-visible output (B02).
- `type-text` on Windows (real keyboard input) is deliberately absent.

## License

MIT.

---

> Status: `0.5.0`. Windows verified including foreground input; macOS/Linux read-only and untested.
