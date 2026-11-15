/**
 * macOS provider — System Events via `osascript`.
 *
 * Capability is deliberately narrower than the Windows provider: macOS exposes
 * the AX tree through System Events, which is slow and requires the calling app
 * to hold Accessibility permission. Element-level inspection is limited to one
 * level below each window; anything deeper should use AppleScript directly.
 *
 * NOTE: written without a Mac to test on. Treat as best-effort.
 */
import { runCommand } from './contract.mjs'

export const platform = 'darwin'
export const label = 'macOS (System Events)'

const osa = (script, opts) => runCommand('osascript', ['-e', script], opts)

const escapeOsa = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function parseLines(out) {
  return String(out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

export async function status() {
  const r = await osa('tell application "System Events" to return name of first process', { timeoutSec: 15 })
  return {
    ok: r.ok,
    platform,
    label,
    detail: r.ok
      ? 'System Events 可用（需要给运行 DSH 的程序授予「辅助功能」权限）'
      : (r.stderr || r.error || 'osascript 不可用'),
    note: '未在真机验证；控件级能力弱于 Windows',
  }
}

export async function listWindows(opts = {}) {
  const script = [
    'set out to ""',
    'tell application "System Events"',
    '  repeat with p in (every process whose background only is false)',
    '    try',
    '      set n to name of p',
    '      set pn to unix id of p',
    '      set fg to false',
    '      set out to out & n & tab & pn & linefeed',
    '    end try',
    '  end repeat',
    'end tell',
    'return out',
  ].join('\n')

  const r = await osa(script, { timeoutSec: 30 })
  if (!r.ok) return r

  let windows = parseLines(r.stdout).map((line, i) => {
    const parts = line.split('\t')
    return { pid: Number(parts[1]) || 0, title: parts[0] || '', index: i }
  })

  if (opts.filter) {
    const f = String(opts.filter).toLowerCase()
    windows = windows.filter((w) => w.title.toLowerCase().includes(f))
  }
  return { ok: true, count: windows.length, windows, note: 'macOS 只给出进程级列表，窗口级信息需 System Events 逐个查询' }
}

export async function inspect(opts = {}) {
  if (!opts.title) {
    return {
      ok: false,
      elements: [],
      error: 'macOS provider 需要 title（进程名）；不支持只按 pid 查询',
      supported: false,
    }
  }
  const app = escapeOsa(opts.title)
  const script = [
    'set out to ""',
    `tell application "System Events"`,
    `  if not (exists process "${app}") then return "NO_SUCH_PROCESS"`,
    `  tell process "${app}"`,
    '    repeat with w in windows',
    '      set out to out & "WINDOW\t" & (name of w) & linefeed',
    '      try',
    '        repeat with b in (buttons of w)',
    '          set out to out & "BUTTON\t" & (name of b) & linefeed',
    '        end repeat',
    '      end try',
    '      try',
    '        repeat with t in (text fields of w)',
    '          set out to out & "TEXTFIELD\t" & (name of t) & linefeed',
    '        end repeat',
    '      end try',
    '    end repeat',
    '  end tell',
    'end tell',
    'return out',
  ].join('\n')

  const r = await osa(script, { timeoutSec: 60 })
  if (!r.ok) return r
  if (String(r.stdout).includes('NO_SUCH_PROCESS')) {
    return { ok: false, elements: [], error: `没有找到进程「${opts.title}」` }
  }

  const elements = parseLines(r.stdout).map((line, i) => {
    const [kind, ...rest] = line.split('\t')
    return { index: i, type: kind, name: rest.join('\t'), invoke: kind === 'BUTTON', value: kind === 'TEXTFIELD' }
  })
  return {
    ok: true,
    total: elements.length,
    elements,
    window: { title: opts.title },
    note: 'macOS 只读取窗口下一层的按钮与文本框；更深的层级需要 AppleScript 精确路径',
  }
}

export async function act(opts = {}) {
  const action = String(opts.action || '').toLowerCase()

  if (action === 'click') {
    const x = Number(opts.x), y = Number(opts.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'click 需要 x/y' }
    const r = await osa(`tell application "System Events" to click at {${x}, ${y}}`, { timeoutSec: 30 })
    return r.ok ? { ok: true, method: 'system-events-click', x, y } : r
  }

  if (action === 'set-text') {
    const text = escapeOsa(opts.text ?? '')
    const r = await osa(`tell application "System Events" to keystroke "${text}"`, { timeoutSec: 30 })
    return r.ok ? { ok: true, method: 'keystroke', written: opts.text } : r
  }

  if (action === 'invoke') {
    if (!opts.title) return { ok: false, error: 'macOS 的 invoke 需要 title（进程名）和 expectName（按钮名）' }
    if (!opts.expectName) return { ok: false, error: 'macOS 的 invoke 必须给 expectName，避免点错' }
    const app = escapeOsa(opts.title)
    const btn = escapeOsa(opts.expectName)
    const script = [
      'tell application "System Events"',
      `  tell process "${app}"`,
      `    click button "${btn}" of window 1`,
      '  end tell',
      'end tell',
    ].join('\n')
    const r = await osa(script, { timeoutSec: 30 })
    return r.ok ? { ok: true, method: 'system-events-click-button', name: opts.expectName } : r
  }

  return { ok: false, error: `macOS provider 不支持动作：${action}` }
}

export async function screenshot(opts = {}) {
  if (!opts.out) return { ok: false, error: 'screenshot 需要 out 路径' }
  // -x: no sound; -o: no shadow. Window-targeted capture needs a CGWindowID,
  // which we do not resolve here, so this captures the full screen.
  const r = await runCommand('screencapture', ['-x', '-o', opts.out], { timeoutSec: 30 })
  return r.ok
    ? { ok: true, path: opts.out, mode: 'screencapture-full', note: '整屏截图；未按窗口裁剪' }
    : r
}
