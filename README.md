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
| **macOS 14+** | ✅ | ⚠️ one level below each window | ✅ System Events | ✅ keystroke | ⚠️ full screen only |
| **Linux · X11** | ✅ wmctrl | ❌ not implemented | ⚠️ coordinates only | ✅ xdotool (needs focus) | ✅ |
| **Linux · Wayland** | ✅ wmctrl | ❌ | ❌ xdotool can't reach native windows | ❌ | ✅ grim |

Legend: ✅ works · ⚠️ partial / caveated · ❌ unsupported

**Windows is the only platform verified on a real machine.** macOS and Linux
providers are written against their documented APIs but could not be tested
here; treat them as best-effort and report what breaks.

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
| `computer_act` | `invoke` click · `set-text` write · `click` coordinate fallback |
| `computer_screenshot` | Capture window or screen to PNG; pair with `read_image` to actually see it |

## How each platform works

| Platform | Mechanism |
| --- | --- |
| Windows | `UIAutomationClient` (.NET Framework) through **Windows PowerShell 5.1**; `InvokePattern` for clicks; `WM_SETTEXT` fallback for legacy controls; `PrintWindow(PW_RENDERFULLCONTENT)` for occluded capture |
| macOS | `osascript` → System Events (`click button`, `keystroke`, `click at`); `screencapture` |
| Linux | `wmctrl` for windows, `xdotool` for input, `grim` / ImageMagick / `gnome-screenshot` for capture; no element tree |

Every Windows call re-enumerates the live tree, so an index is never replayed
against a window that changed. `expectName` adds a hard guard: the element name
must match exactly or the action is refused.

## Verified on Windows 10 (19045) + DSH 0.2.2-rc.3

| Check | Result |
| --- | --- |
| Enumerate windows | 12 visible top-level windows |
| Read DSH's own Electron UI | **502–783 UIA elements** depending on view state |
| Click a control | `InvokePattern` toggled the sidebar and toggled it back |
| Write CJK text | Chinese written into Notepad via `WM_SETTEXT`, UTF-8 intact |
| Screenshot occluded window | Notepad fully covered, captured correctly via `PrintWindow` |

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

## License

MIT.

---

> Status: `0.2.0`. Windows verified; macOS/Linux best-effort and untested on real hardware.
