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
// The native FFI layer is optional: if koffi cannot resolve inside the host's
// module graph, UI Automation must still work. A hard import failure here was
// enough to keep the whole plugin from loading.
// Cache the native module on globalThis. A plugin hot reload re-executes this
// file, and re-importing the native module re-registers its koffi types, which
// throws "Duplicate type name" and kills every native call until a restart.
// Reusing the first successful instance makes reloads harmless.
let native = globalThis.__dshCuNativeModule ?? null
let nativeError = null
if (!native) {
  try {
    native = await import('../native/win32.mjs')
    globalThis.__dshCuNativeModule = native
  } catch (error) {
    native = null
    nativeError = String(error && error.message ? error.message : error)
  }
}

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
const ACTION_MAP = { 'set-text': 'settext', click: 'clickxy', 'scroll-to': 'scrollto', 'scroll-page': 'scrollpage' }

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
    inputAction: opts.inputAction,
    amount: opts.amount,
  }, { timeoutSec: 60 })
}

export async function watch(opts = {}) {
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
  return native.watch({
    timeoutMs: opts.timeoutMs,
    intervalMs: opts.intervalMs,
    windows: opts.windows,
    keys: opts.keys,
    until: opts.until,
  })
}

/**
 * Paste text into the focused control: clipboard write, Ctrl+V, restore.
 *
 * Typing sends one synthesized keystroke per character. That is exactly what
 * IME-hostile editors mangle, and for CJK the IME may never commit at all. A
 * paste is a single atomic edit, so it is the reliable path for long or
 * non-ASCII strings. The previous clipboard text is restored afterwards so the
 * user does not lose what they had copied.
 */
export async function paste(opts = {}) {
  if (!native) {
    return { ok: false, error: `native 模块不可用（${nativeError}）` }
  }
  const text = String(opts.text ?? '')
  if (!text) return { ok: false, error: '没有要粘贴的文本（text 为空）' }

  // Focus matters as much as the clipboard: Ctrl+V goes to whatever owns the
  // keyboard focus, and activating a window does not put focus in its editor.
  // Observed: clipboard written, Ctrl+V sent, editor still empty.
  if (opts.hwnd || Number.isFinite(opts.pid)) {
    let hwnd = opts.hwnd ? Number(opts.hwnd) : null
    if (!hwnd && Number.isFinite(opts.pid)) {
      // One process can own several windows, including tiny helper/placeholder
      // ones that appear before the real window is laid out. Activating the
      // first match sent Ctrl+V to the wrong target and produced an empty
      // editor with a success report. Pick the largest sized window instead.
      const found = await listWindows(opts)
      const candidates = (found.windows || [])
        .filter((w) => (w.width || 0) > 200 && (w.height || 0) > 100)
        .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))
      hwnd = candidates[0]?.hwnd ?? found.windows?.[0]?.hwnd ?? null
    }
    if (hwnd) {
      // Activating is enough to put the caret in the window's editor for the
      // apps tested (Notepad, Codex). An extra click here made paste fail
      // outright -- measured A/B: with click empty, without click the text
      // landed. Do not reintroduce it without evidence.
      // Use the same activation path computer_act uses: it was verified to put
      // the caret in the target, while the bare native call did not.
      await act({ action: 'activate', hwnd: String(hwnd) })
      await new Promise((r) => setTimeout(r, 520))
      // Optional explicit focus point. Chromium apps keep focus on the window,
      // not in the composer, so they need a click; Win32 editors do not.
      if (Number.isFinite(opts.x) && Number.isFinite(opts.y)) {
        await native.sendInput({ action: 'click', x: opts.x, y: opts.y })
        await new Promise((r) => setTimeout(r, 380))
      }
    }
  }

  const previous = native.readClipboard()
  native.writeClipboard(text)
  // The target reads the clipboard when it processes WM_PASTE, which happens
  // after the key event returns. Restoring too early swaps the content out from
  // under it -- observed as a successful report and an empty editor.
  // The clipboard must be fully published before the target is asked to read
  // it: 140ms was too tight and produced an empty editor with a success report.
  await new Promise((r) => setTimeout(r, 320))
  const sent = await input({ inputAction: 'press', key: 'ctrl+v' })
  // 500ms was enough for ASCII but NOT for CJK: the target was still settling
  // when the old clipboard went back, and the paste silently produced nothing.
  // 1200ms covers both; restore can be disabled when speed matters.
  await new Promise((r) => setTimeout(r, 1200))

  let restored = false
  const keep = opts.restore !== false
  if (keep && previous && typeof previous.text === 'string' && previous.text) {
    native.writeClipboard(previous.text)
    restored = true
  }
  return {
    ok: true,
    length: text.length,
    restored,
    previousLength: previous && typeof previous.text === 'string' ? previous.text.length : 0,
    sent,
  }
}

/** Release every synthetic mouse button and modifier key this code can hold. */
export function releaseAll() {
  if (!native) {
    return { ok: false, error: `native 模块不可用（${nativeError}）` }
  }
  const r = native.releaseAll()
  return { ok: true, keys: r.keys, buttons: r.buttons }
}

export function shrinkPng(src, dst, maxWidth) {
  if (!native) return src
  return native.shrinkPng(src, dst, maxWidth)
}

export async function readClipboard() {
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
  return native.readClipboard()
}

export async function writeClipboard(text) {
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
  return native.writeClipboard(text)
}

export async function screenshot(opts = {}) {
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
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
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
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

/**
 * Scroll a window and capture it screen by screen.
 *
 * Why this exists: Electron/Chromium virtualise long content, so neither the
 * UIA document text nor a single screenshot contains what has been scrolled
 * out of view. Verified on ChatGPT: Document text stopped at 3267 chars and did
 * not include messages further down. Reading a long page therefore requires
 * scrolling and capturing repeatedly.
 */
export async function scan(opts = {}) {
  if (!native) { return { ok: false, error: `native 模块不可用（）；UIA 功能不受影响` } }
  const maxFrames = Math.min(10, Math.max(1, Number(opts.maxFrames) || 5))
  const outDir = opts.outDir
  const stepRatio = Math.min(0.95, Math.max(0.3, Number(opts.stepRatio) || 0.8))
  const settleMs = Math.min(2000, Math.max(120, Number(opts.settleMs) || 420))
  // down/up scroll vertically; left/right scroll horizontally (Shift+wheel).
  const dir = String(opts.direction || 'down').toLowerCase()
  const horizontal = dir === 'left' || dir === 'right'
  const sign = (dir === 'up' || dir === 'left') ? 1 : -1

  let hwnd = opts.hwnd ? Number(opts.hwnd) : 0
  if (!hwnd) {
    const ls = await call({ action: 'list' }, { timeoutSec: 40 })
    if (!ls.ok) return { ok: false, error: ls.error || 'could not enumerate windows' }
    const hit = (ls.windows || []).find((w) =>
      (opts.pid ? w.pid === opts.pid : true)
      && (opts.title ? String(w.title || '').includes(opts.title) : true))
    if (!hit) return { ok: false, error: 'target window not found' }
    hwnd = Number(hit.hwnd)
  }

  // Activate first: it restores a minimized window (SW_RESTORE), so the
  // minimized check must come after it, not before.
  native.activateWindow(hwnd)
  await new Promise((r) => setTimeout(r, 320))

  const info = native.windowInfo(hwnd)
  if (info.minimized) return { ok: false, error: 'target window is still minimized after restore' }

  // Aim at the content area by default; point lets the caller target a nested
  // scroller (a modal list, a side panel) instead of the window itself.
  const px = Number.isFinite(opts.point?.x) ? opts.point.x : Math.floor(info.rect.width * 0.68)
  const py = Number.isFinite(opts.point?.y) ? opts.point.y : Math.floor(info.rect.height * 0.55)
  const cx = info.rect.left + px
  const cy = info.rect.top + py
  const step = Math.round((horizontal ? info.rect.width : info.rect.height) * stepRatio)

  // Keyboard paging needs the focus INSIDE the scroll container. Clicking the
  // content point is what makes PageDown land there (measured: without the
  // click the same PageDown changed nothing).
  if (opts.focusClick !== false) {
    await native.sendInput({ action: 'click', x: cx, y: cy })
    await new Promise((r) => setTimeout(r, 260))
  }

  // Rewind first: starting at the wrong end makes every scroll a no-op and the
  // capture loop exits after one frame (observed: Notepad sat at its bottom).
  if (!horizontal) {
    const rewind = dir === 'up' ? 'down' : 'up'
    for (let i = 0; i < 40; i++) {
      const r = await act({ action: 'scroll-page', hwnd: String(hwnd), inputAction: rewind, amount: 1 })
      if (!r || !r.changed) break
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  const frames = []
  let prevHash = ''
  for (let i = 0; i < maxFrames; i++) {
    const file = `${outDir}/scan-${String(i).padStart(2, '0')}.png`
    const cap = native.captureWindow(hwnd, file)
    if (!cap.ok) return { ok: false, error: cap.error, frames }

    // Cheap change detector: byte length plus a sampled pixel signature.
    const sig = `${cap.width}x${cap.height}:${cap.bytes}`
    if (sig === prevHash && i > 0) break
    prevHash = sig
    frames.push({ index: i, path: cap.path, width: cap.width, height: cap.height, bytes: cap.bytes })

    // Strategy ladder, because each layer fails on different software:
    //   1. WM_VSCROLL/WM_HSCROLL message -- bypasses the input queue entirely,
    //      so security software that blocks simulated input does not stop it.
    //   2. Simulated wheel/keyboard -- needed by Chromium views, which ignore
    //      the window message, and only works when input injection is allowed.
    let advanced = false
    if (!horizontal) {
      const msg = await act({
        action: 'scroll-page',
        pid: opts.pid,
        hwnd: String(hwnd),
        inputAction: dir === 'up' ? 'up' : 'down',
        amount: 1,
      })
      advanced = Boolean(msg && msg.changed)
    }
    if (!advanced) {
      if (horizontal) {
        await native.sendInput({ action: 'scroll', x: cx, y: cy, amount: sign * step, horizontal: true })
      } else if (opts.focusClick === false) {
        await native.sendInput({ action: 'press', key: dir === 'up' ? 'pageup' : 'pagedown' })
      } else {
        await native.sendInput({ action: 'press', key: dir === 'up' ? 'pageup' : 'pagedown' })
      }
    }
    await new Promise((r) => setTimeout(r, settleMs))
  }

  return { ok: true, frames, count: frames.length, hwnd, rect: info.rect, direction: dir, horizontal, point: { x: px, y: py } }
}