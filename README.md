# dsh-computer-use-win

[![test](https://github.com/xushengqiong-ship/dsh-computer-use-win/actions/workflows/test.yml/badge.svg)](https://github.com/xushengqiong-ship/dsh-computer-use-win/actions/workflows/test.yml)

English | [简体中文](README.zh-CN.md)

**Windows-native Computer Use for DeepSeek Harness.** Lets the agent read a real
application's UI Automation tree, click its controls, write text into it without
stealing focus, and screenshot it even when it is occluded.

This is an independent Windows counterpart to the excellent
[`dsh-computer-use`](https://github.com/Anionex/dsh-computer-use) (macOS only).
It borrows the design goals — observe before acting, never replay a stale target,
prefer semantic automation over coordinates — but shares no code.

## Tools

| Tool | What it does |
| --- | --- |
| `win_list_windows` | List visible top-level windows: pid, title, class, size, foreground, minimized |
| `win_inspect` | Read the UIA element tree of a window (type, name, class, bounds, can-invoke, can-set-value), optionally with a screenshot |
| `win_act` | `invoke` (click a control), `set-text` (write text), `click` (window-relative coordinate fallback) |
| `win_screenshot` | Capture a window or the full screen to PNG |
| `win_status` | Check platform / PowerShell / helper readiness; touches nothing |

Screenshots return a file path — pair `win_screenshot` with `read_image` and the
agent can actually see the window.

## How it works

Everything runs through `lib/helper.ps1`, invoked with **Windows PowerShell 5.1**
(because `UIAutomationClient` lives in .NET Framework):

| Capability | Mechanism | Why it matters |
| --- | --- | --- |
| Read UI | `AutomationElement.FindAll(TreeScope.Descendants)` | Structured controls, not pixels — no OCR guessing |
| Click | `InvokePattern` | Works without bringing the window forward |
| Write text | `ValuePattern`, else `WM_SETTEXT` | **No focus stealing**; works on legacy Win32 controls that expose no UIA value pattern |
| Screenshot | `PrintWindow(..., PW_RENDERFULLCONTENT)` | Captures an **occluded** window; plain `CopyFromScreen` would photograph whatever is on top |
| Safety | `expectName` must match before acting | A stale index cannot silently click the wrong button |

Every call re-enumerates the live tree, so an index is never replayed against a
window that changed in the meantime.

## Verified on Windows 10 (19045) + DSH 0.2.2-rc.3

These are measurements from the development machine, not marketing:

| Check | Result |
| --- | --- |
| Enumerate windows | 14 visible top-level windows |
| Read DSH's own Electron UI | **783 UIA elements** (91 buttons incl. real labels like 「新建会话」) |
| Click a control | `InvokePattern` toggled the sidebar and toggled it back |
| Write CJK text | Chinese text written into Notepad via `WM_SETTEXT`, `utf-8` intact |
| Screenshot an occluded window | Notepad fully covered by DSH, captured correctly via `PrintWindow` |

## Known limitations

- **Windows only.** On other platforms the tools refuse to run instead of failing strangely.
- **Chromium/Electron apps**: web content appears in UIA only when the app exposes
  accessibility. DSH itself does (783 elements measured). Apps that don't will show
  only their native shell — use `win_screenshot` + `read_image` for those.
- **Canvas content is invisible to UIA.** A game board drawn on a canvas is one opaque
  rectangle; there are no controls to click. Screenshot it, or expose state as text.
- **No global input injection.** This plugin does not move the system cursor or send
  global keystrokes. It targets specific windows via UIA and window messages by design.
- **Minimized windows** have no usable geometry; restore them first.
- Requires **Windows PowerShell 5.1** (present on every Windows 10/11). Override with
  `DSH_WIN_CU_POWERSHELL` if needed.

## Safety

- No tool deletes files, kills processes, shuts down, or sends input outside the
  selected window.
- `win_act` accepts `expectName`; when supplied, the element name must match exactly
  or the action is refused — use it for anything destructive or irreversible.
- Read-only actions (`win_list_windows`, `win_inspect`, `win_status`) never modify a window.
- Treat screenshots as sensitive: they can contain whatever is on screen.

## Install

```powershell
dsh plugin --profile <profile> add file:C:\path\to\dsh-computer-use-win
```

Then restart DSH so the bundle and its tools load.

## Testing

```powershell
# syntax
node --check lib/run.mjs
node --check lib/index.mjs

# tool smoke test (read-only actions only: status / list / inspect)
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-tools.mjs
```

## License

MIT.

---

> Status: `0.1.0`, early. Windows UI Automation is quirky across apps; expect rough
> edges and report what breaks.
