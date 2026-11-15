/**
 * macOS provider — read-only.
 *
 * Deliberately narrowed (A12/A13): `osascript` keystroke and `click at` are
 * GLOBAL — they act on whatever window has focus, not on the process the caller
 * named. Shipping that under `computer_act` would silently type into another
 * app. Until a focused, per-window AX implementation exists, macOS supports
 * observation only:
 *   - list running applications
 *   - a shallow per-window control listing
 *   - full-screen capture (clearly labelled as screen scope)
 * Every mutation returns `unsupported` with an explanation.
 *
 * NOTE: written without a Mac to test on.
 */
import { runCommand } from './contract.mjs'

export const platform = 'darwin'
export const label = 'macOS (System Events, read-only)'

const osa = (script, opts) => runCommand('osascript', ['-e', script], opts)
const escapeOsa = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

function parseLines(out) {
  return String(out || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

export const CAPABILITIES = {
  listWindows: true,
  inspect: 'shallow',
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
  const r = await osa('tell application "System Events" to return name of first process', { timeoutSec: 15 })
  return {
    ok: r.ok,
    platform,
    label,
    detail: r.ok
      ? 'System Events 可用（需要给运行 DSH 的程序授予「辅助功能」权限）'
      : (r.stderr || r.error || 'osascript 不可用'),
    note: '只读 provider：不做键盘/点击输入（osascript 的输入是全局的，会打到焦点窗口）',
    capabilities: CAPABILITIES,
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
  return {
    ok: true,
    count: windows.length,
    windows,
    note: 'macOS 只提供进程级列表；窗口级信息需要 System Events 逐个查询',
  }
}

export async function inspect(opts = {}) {
  if (!opts.title) {
    return {
      ok: false,
      supported: false,
      elements: [],
      error: 'macOS provider 需要 title（进程名）；不支持只按 pid 查询',
    }
  }
  const app = escapeOsa(opts.title)
  const script = [
    'set out to ""',
    'tell application "System Events"',
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
    return {
      index: i,
      type: kind,
      name: rest.join('\t'),
      invoke: kind === 'BUTTON',
      value: kind === 'TEXTFIELD',
    }
  })
  return {
    ok: true,
    total: elements.length,
    elements,
    window: { title: opts.title },
    note: '只读：只读取窗口下一层的按钮与文本框，且这些 index 不能用于动作（本 provider 不支持输入）',
  }
}

/** Read-only provider: every mutation is refused instead of going global. */
export async function act(opts = {}) {
  const action = String(opts.action || '').toLowerCase()
  return {
    ok: false,
    supported: false,
    state: 'not-attempted',
    error:
      `macOS provider 不支持动作 "${action}"。\n`
      + 'osascript 的 keystroke / click at 是**全局输入**，会作用在当时的焦点窗口而不是你指定的窗口，'
      + '所以这里直接拒绝，而不是冒着写错应用的风险执行。\n'
      + '需要操作界面时请用 Windows，或在 macOS 上手动完成。',
  }
}

export async function screenshot(opts = {}) {
  if (!opts.out) return { ok: false, error: 'screenshot 需要 out 路径' }
  const r = await runCommand('screencapture', ['-x', '-o', opts.out], { timeoutSec: 30 })
  return r.ok
    ? {
        ok: true,
        path: opts.out,
        mode: 'screencapture-full',
        scope: 'screen',
        note: '整屏截图（macOS provider 没有按窗口裁剪的实现，不冒充窗口截图）',
      }
    : r
}
