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
      wayland ? '会话是 Wayland：xdotool 只能作用于 XWayland 应用，原生 Wayland 窗口无法定向输入' : '会话是 X11',
    ].join('\n'),
    capabilities: {
      listWindows: t.wmctrl || t.xdotool,
      inspect: false,
      act: t.xdotool,
      screenshot: t.magick || t.grim || t.gnomeShot,
    },
    note: '未在真机验证；不支持控件级读取',
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

export async function act(opts = {}) {
  const t = await tools()
  if (!t.xdotool) return { ok: false, error: '需要 xdotool（sudo apt install xdotool）' }

  const action = String(opts.action || '').toLowerCase()
  const win = opts.hwnd ? ['--window', String(opts.hwnd)] : []

  if (action === 'set-text') {
    const text = String(opts.text ?? '')
    // xdotool types into whatever has focus unless --window is honoured
    const r = await runCommand('xdotool', ['type', ...win, '--', text], { timeoutSec: 30 })
    return r.ok ? { ok: true, method: 'xdotool-type', written: text } : r
  }

  if (action === 'invoke') {
    return {
      ok: false,
      error: 'Linux 无法按元素点击（没有元素树）。请改用 action=click 给坐标，并用 computer_screenshot 先确认位置。',
    }
  }

  if (action === 'click') {
    const x = Number(opts.x), y = Number(opts.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'click 需要 x/y' }
    const r = await runCommand('xdotool', ['mousemove', ...win, String(x), String(y), 'click', '1'], { timeoutSec: 20 })
    return r.ok ? { ok: true, method: 'xdotool-click', x, y } : r
  }

  return { ok: false, error: `Linux provider 不支持动作：${action}` }
}

export async function screenshot(opts = {}) {
  if (!opts.out) return { ok: false, error: 'screenshot 需要 out 路径' }
  const t = await tools()

  if (t.grim) {
    const r = await runCommand('grim', [opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'grim' }
  }
  if (t.magick) {
    const r = await runCommand('import', ['-window', 'root', opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'import-root' }
  }
  if (t.gnomeShot) {
    const r = await runCommand('gnome-screenshot', ['-f', opts.out], { timeoutSec: 30 })
    if (r.ok) return { ok: true, path: opts.out, mode: 'gnome-screenshot' }
  }
  return { ok: false, error: '找不到截图工具：装 grim（Wayland）、ImageMagick 或 gnome-screenshot' }
}
