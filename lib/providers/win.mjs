/**
 * Windows provider — UI Automation via Windows PowerShell 5.1.
 *
 * Works on Windows 10 and 11, Home / Pro / Enterprise / Education alike:
 * UIAutomation is a system component and `powershell.exe` ships with the OS.
 *
 * Two transport paths share ONE business request (see `encodeRequest` /
 * `fallback`): the persistent `serve` helper, and a one-shot spawn used only as
 * a read-only safety net. A mutating action is never replayed — if the helper
 * may have received it, the caller gets `state: 'unknown'` and must re-observe.
 */
import { runHelper, POWERSHELL, HELPER } from '../run.mjs'
import { callHelper } from '../helper-client.mjs'
import * as native from '../native/win32.mjs'

export const platform = 'win32'
export const label = 'Windows (UI Automation)'

export const CAPABILITIES = {
  listWindows: true,
  inspect: true,
  invoke: true,
  setValue: true,
  typeText: false,
  click: true,
  drag: 'best-effort',
  screenshotWindow: true,
  screenshotScreen: true,
  backgroundInput: true,
  foregroundInput: true,
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

// Public action name -> helper action name. `click` was previously forwarded
// verbatim and fell through to "unknown action" in the helper (A05).
const ACTION_MAP = { 'set-text': 'settext', click: 'clickxy', 'scroll-to': 'scrollto' }

// Anything that can change the target application. Once such a request may
// have reached the helper, replaying it would double the side effect (A01).
const MUTATING = new Set(['settext', 'invoke', 'clickxy', 'drag', 'input'])

// Normalise before classifying: the helper's PowerShell `switch` is
// case-insensitive, so "INVOKE" would still execute while a naive lookup
// treated it as a read-only action and replayed it (A01).
const helperAction = (action) => ACTION_MAP[String(action || '').toLowerCase()] || String(action || '').toLowerCase()
const isMutating = (action) => MUTATING.has(String(action || '').toLowerCase())

/**
 * Business options -> persistent-helper wire request.
 * This is the single place that decides how a request is encoded.
 */
function encodeRequest(opts) {
  const req = { action: helperAction(opts.action) }
  if (Number.isFinite(opts.pid)) req.pid = opts.pid
  if (opts.hwnd) req.hwnd = String(opts.hwnd)
  if (opts.title) req.titleB64 = b64(opts.title)
  if (Number.isInteger(opts.index)) req.index = opts.index
  if (opts.text !== undefined) req.textB64 = b64(opts.text)
  if (opts.expectName) req.expectNameB64 = b64(opts.expectName)
  if (Number.isFinite(opts.x)) req.x = opts.x
  if (Number.isFinite(opts.y)) req.y = opts.y
  if (Number.isFinite(opts.x2)) req.x2 = opts.x2
  if (Number.isFinite(opts.y2)) req.y2 = opts.y2
  if (Number.isFinite(opts.max)) req.max = opts.max
  if (opts.out) req.out = opts.out
  if (opts.inputAction) req.inputAction = String(opts.inputAction).toLowerCase()
  if (opts.key) req.key = String(opts.key)
  if (Number.isFinite(opts.amount)) req.amount = opts.amount
  if (opts.withShot) req.withShot = true
  return req
}

/**
 * Read-only fallback through a one-shot spawn.
 * Reads the ORIGINAL business options, never the wire request: the wire form
 * stores base64 fields (`titleB64`) that the one-shot path does not understand,
 * which previously turned a real title into undefined (A02).
 */
function fallback(opts, timeoutSec) {
  return runHelper({
    action: helperAction(opts.action),
    targetPid: opts.pid,
    title: opts.title,
    index: opts.index,
    text: opts.text,
    expectName: opts.expectName,
    x: opts.x,
    y: opts.y,
    x2: opts.x2,
    y2: opts.y2,
    max: opts.max,
    out: opts.out,
    withShot: opts.withShot,
    hwnd: opts.hwnd,
    timeoutSec,
  })
}

async function call(opts, { timeoutSec = 60 } = {}) {
  const r = await callHelper(encodeRequest(opts), {
    powershell: POWERSHELL,
    helperPath: HELPER,
    timeoutMs: timeoutSec * 1000,
  })

  if (r && r.ok !== false) return r

  // The helper answered with a business error (bad index, unsupported pattern,
  // target rejected the write). The action did NOT run, so surface it as-is.
  if (r && r.ok === false && !r.channel) return r

  // Channel-level failure. A mutating action may already have been delivered;
  // we cannot tell "not sent" from "sent but the reply was lost", so never retry.
  if (isMutating(opts.action)) {
    return {
      ok: false,
      state: 'unknown',
      channel: true,
      error:
        '常驻 helper 通信失败（启动/退出/超时），该动作可能已经执行。'
        + '为避免重复副作用这里不重试；请先 computer_inspect 重新观察确认当前状态，再决定是否重发。',
      cause: r && r.error,
    }
  }

  // Read-only: safe to retry once through a fresh process.
  return fallback(opts, timeoutSec)
}

export async function status() {
  const r = await call({ action: 'list' }, { timeoutSec: 30 })
  return {
    ok: r.ok,
    platform,
    label,
    detail: r.ok ? `UIA 可用，当前 ${r.count} 个可见窗口` : (r.error || 'UIA 不可用'),
    capabilities: CAPABILITIES,
    note: '后台操作：不移动系统光标、不抢焦点；消息式拖拽对依赖真实鼠标捕获的控件可能无效',
  }
}

export async function listWindows(opts = {}) {
  const r = await call({ action: 'list' }, { timeoutSec: 40 })
  if (!r.ok) return r
  let list = r.windows || []
  if (opts.filter) {
    const f = String(opts.filter).toLowerCase()
    list = list.filter((w) => String(w.title || '').toLowerCase().includes(f))
  }
  return { ok: true, count: list.length, windows: list, total: r.count }
}

export async function inspect(opts = {}) {
  return call({
    action: 'observe',
    pid: opts.pid,
    hwnd: opts.hwnd,
    title: opts.title,
    max: opts.max,
    out: opts.out,
    withShot: Boolean(opts.out),
  }, { timeoutSec: 90 })
}

export async function act(opts = {}) {
  return call({
    action: opts.action,
    pid: opts.pid,
    hwnd: opts.hwnd,
    title: opts.title,
    index: opts.index,
    text: opts.text,
    expectName: opts.expectName,
    x: opts.x,
    y: opts.y,
    x2: opts.x2,
    y2: opts.y2,
  }, { timeoutSec: 60 })
}

export async function readClipboard() {
  return native.readClipboard()
}

export async function writeClipboard(text) {
  return native.writeClipboard(text)
}

export async function screenshot(opts = {}) {
  if (!opts.out) return { ok: false, error: 'screenshot needs an out path' }

  // Resolve the target window through the UIA list (it already applies the
  // same selector rules), then capture natively -- no PowerShell, so no AMSI.
  let hwnd = opts.hwnd ? Number(opts.hwnd) : 0
  if (!hwnd && (opts.pid || opts.title)) {
    const ls = await call({ action: 'list' }, { timeoutSec: 40 })
    if (!ls.ok) return { ok: false, error: ls.error || 'could not enumerate windows' }
    const hit = (ls.windows || []).find((w) =>
      (opts.pid ? w.pid === opts.pid : true)
      && (opts.title ? String(w.title || '').includes(opts.title) : true))
    if (!hit) return { ok: false, error: 'target window not found; refusing to capture the whole screen instead' }
    hwnd = Number(hit.hwnd)
  }

  const shot = hwnd ? native.captureWindow(hwnd, opts.out) : native.captureScreen(opts.out)
  if (!shot.ok) return shot
  if (native.isAllBlack(shot.path)) {
    shot.allBlack = true
    shot.warning = 'bitmap is entirely black: the window may use a hardware-accelerated surface. Try the foreground channel instead.'
  }
  return shot
}

/**
 * Foreground input channel: real SendInput events.
 *
 * This is the counterpart of the `click/drag/move/press/scroll` surface that
 * Codex exposes. It reaches canvas-only and game UIs that window messages
 * cannot, and it costs exactly what that reach implies: the system cursor
 * moves and keyboard input needs the target window to own the focus.
 */
export async function input(opts = {}) {
  // Native SendInput: reaches every application, and keeps the mutation out of
  // any PowerShell script (see the note at the top of native/win32.mjs).
  return native.sendInput({
    action: opts.inputAction,
    x: opts.x,
    y: opts.y,
    x2: opts.x2,
    y2: opts.y2,
    key: opts.key,
    text: opts.text,
    amount: opts.amount,
  })
}
