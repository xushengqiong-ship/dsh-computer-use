/**
 * Linux provider — window-manager level only.
 *
 * Honest scope: Linux has no cross-toolkit accessibility API that works the way
 * UIA (Windows) or AX (macOS) does from a plain script. AT-SPI2 exists but needs
 * a Python/pyatspi bridge and behaves differently per desktop and per toolkit.
 * So this provider offers:
 *   - window enumeration  (wmctrl, falling back to xdotool)
 *   - screenshot          (ImageMagick `import`, `grim` on Wayland, `gnome-screenshot`)
 *   - keyboard/pointer    (xdotool, X11 only)
 * and explicitly reports "unsupported" for element-tree inspection.
 *
 * NOTE: written without a Linux box to test on. Treat as best-effort.
 */
import { runCommand, hasCommand } from './contract.mjs'

export const platform = 'linux'
export const label = 'Linux (window manager)'

let cachedTools = null

async function tools() {
  if (cachedTools) return cachedTools
  cachedTools = {
    wmctrl: await hasCommand('wmctrl'),
    xdotool: await hasCommand('xdotool'),
    magick: await hasCommand('import'),
    grim: await hasCommand('grim'),
    gnomeShot: await hasCommand('gnome-screenshot'),
  }
  return cachedTools
}

export const CAPABILITIES = {
  listWindows: true,
  inspect: false,
  invoke: false,
  setValue: false,
  typeText: false,
  click: false,
  drag: false,
  screenshotWindow: false,
  screenshotScreen: true,
  backgroundInput: false,
}

export async function status() {
  const t = await tools()
  const wayland = String(process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
  return {
    ok: t.wmctrl || t.xdotool,
    platform,
    label,
    detail: [
      `wmctrl=${t.wmctrl ? '✓' : '✗'} xdotool=${t.xdotool ? '✓' : '✗'} screenshot=${
        t.grim ? 'grim' : t.magick ? 'import' : t.gnomeShot ? 'gnome-screenshot' : '✗'
      }`,
      wayland ? '会话是 Wayland' : '会话是 X11',
    ].join('\n'),
    capabilities: CAPABILITIES,
    note: '只读 provider：能列窗口和截图，不做输入（见 act 的说明）',
  }
}

export async function listWindows(opts = {}) {
  const t = await tools()

  if (t.wmctrl) {
    const r = await runCommand('wmctrl', ['-lp'], { timeoutSec: 30 })
    if (!r.ok) return r
    let windows = String(r.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // 0x04000007  0  1234  host  window title
        const parts = line.split(/\s+/)
        return {
          hwnd: parts[0],
          desktop: parts[1],
          pid: Number(parts[2]) || 0,
          host: parts[3],
          title: parts.slice(4).join(' '),
        }
      })
    if (opts.filter) {
      const f = String(opts.filter).toLowerCase()
      windows = windows.filter((w) => w.title.toLowerCase().includes(f))
    }
    return { ok: true, count: windows.length, windows }
  }

  if (t.xdotool) {
    const r = await runCommand('xdotool', ['search', '--onlyvisible', '--name', ''], { timeoutSec: 30 })
    if (!r.ok) return r
    const ids = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const windows = []
    for (const id of ids.slice(0, 50)) {
      const n = await runCommand('xdotool', ['getwindowname', id], { timeoutSec: 10 })
      const p = await runCommand('xdotool', ['getwindowpid', id], { timeoutSec: 10 })
      if (n.ok && String(n.stdout).trim()) {
        windows.push({ hwnd: id, pid: Number(String(p.stdout).trim()) || 0, title: String(n.stdout).trim() })
      }
    }
    let out = windows
    if (opts.filter) {
      const f = String(opts.filter).toLowerCase()
      out = windows.filter((w) => w.title.toLowerCase().includes(f))
    }
    return { ok: true, count: out.length, windows: out }
  }

  return { ok: false, error: '需要 wmctrl 或 xdotool（sudo apt install wmctrl xdotool）' }
}

export async function inspect(opts = {}) {
  return {
    ok: false,
    supported: false,
    elements: [],
    error:
      'Linux 不支持控件级元素树读取。\n' +
      '用 computer_screenshot 截图后用 read_image 看，或者给目标程序找一个 CLI / API。\n' +
      '（AT-SPI2 理论上可行，但需要 pyatspi 桥接且各桌面行为不一，本插件未实现。）',
  }
}

/** Read-only provider: input is refused rather than risk hitting the wrong window. */
export async function act(opts = {}) {
  const action = String(opts.action || '').toLowerCase()
  return {
    ok: false,
    supported: false,
    state: 'not-attempted',
    error:
      `Linux provider 不支持动作 "${action}"。\n`
      + 'xdotool 的合成输入只对部分 X11 应用有效（GTK/Qt 常常忽略），'
      + 'Wayland 原生窗口更是收不到；把它当作可用能力会得到"报告成功但实际没生效"。\n'
      + '需要操作界面时请用 Windows，或在 Linux 上走目标程序的 CLI / API。',
  }
}

export async function screenshot(opts = {}) {
  if (!opts.out) return { ok: false, error: 'screenshot 需要 out 路径' }
  const t = await tools()

  if (t.grim) {
    const r = await runCommand('grim', [opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'grim', scope: 'screen' }
  }
  if (t.magick) {
    const r = await runCommand('import', ['-window', 'root', opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'import-root', scope: 'screen' }
  }
  if (t.gnomeShot) {
    const r = await runCommand('gnome-screenshot', ['-f', opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'gnome-screenshot', scope: 'screen' }
  }
  return { ok: false, error: '找不到截图工具：装 grim（Wayland）、ImageMagick 或 gnome-screenshot' }
}
