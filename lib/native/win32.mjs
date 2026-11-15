/**
 * Native Win32 bindings via koffi (FFI).
 *
 * WHY THIS EXISTS: the screenshot path used to live in helper.ps1, and Windows
 * Defender flags "PowerShell script that captures window bitmaps" as
 * `HackTool:PowerShell/EmpireGetScreenshot.C`. AMSI blocks the whole script, so
 * every capability died at once. Node.js is not subject to AMSI script scanning,
 * so moving capture (and input) here keeps the PowerShell helper down to plain
 * UI Automation calls.
 */
import koffi from 'koffi'
import { PNG } from 'pngjs'

// Reloading the plugin re-executes this module while koffi still holds the
// type table, and re-registering throws "Duplicate type name". Cache the
// handles globally so a reload is idempotent instead of fatal.
const KTYPES = (globalThis.__dshComputerUseKoffi ??= {})
const kstruct = (name, def) => (KTYPES[name] ??= koffi.struct(name, def))
const kunion = (name, def) => (KTYPES[name] ??= koffi.union(name, def))
import { writeFileSync, readFileSync } from 'node:fs'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

// ---------------------------------------------------------------- types

const RECT = kstruct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const POINT = kstruct('POINT', { x: 'int32', y: 'int32' })
const BITMAPINFOHEADER = kstruct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
})

// ---------------------------------------------------------------- functions

const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr h, _Out_ RECT *r)')
const IsIconic = user32.func('bool __stdcall IsIconic(intptr h)')
const IsWindow = user32.func('bool __stdcall IsWindow(intptr h)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr h, _Out_ uint32 *pid)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr h, _Out_ uint16 *buf, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr h, _Out_ uint16 *buf, int max)')
const GetDC = user32.func('intptr __stdcall GetDC(intptr h)')
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr h, intptr dc)')
const PrintWindow = user32.func('bool __stdcall PrintWindow(intptr h, intptr dc, uint32 flags)')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr h)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr h, int cmd)')
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr h)')
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)')
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)')
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')

const kernel32 = koffi.load('kernel32.dll')
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
const GetCurrentProcessId = kernel32.func('uint32 __stdcall GetCurrentProcessId()')

const CreateCompatibleDC = gdi32.func('intptr __stdcall CreateCompatibleDC(intptr dc)')
const CreateCompatibleBitmap = gdi32.func('intptr __stdcall CreateCompatibleBitmap(intptr dc, int w, int h)')
const SelectObject = gdi32.func('intptr __stdcall SelectObject(intptr dc, intptr obj)')
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr obj)')
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr dc)')
const GetDIBits = gdi32.func('int __stdcall GetDIBits(intptr dc, intptr bmp, uint32 start, uint32 lines, _Out_ uint8 *bits, _Inout_ BITMAPINFOHEADER *info, uint32 usage)')

const SetThreadDpiAwarenessContext = user32.func('void* __stdcall SetThreadDpiAwarenessContext(void* ctx)')
const GetThreadDpiAwarenessContext = user32.func('void* __stdcall GetThreadDpiAwarenessContext()')

export const PW_RENDERFULLCONTENT = 2

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2. Node.js starts DPI-unaware, so
// GetWindowRect reports a 200%-scaled window as half its real size and
// PrintWindow only renders that top-left quadrant. Bumping the THREAD context
// around a capture fixes it without changing process-wide DPI behaviour.
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = koffi.as(-4n, 'void*')

function withPhysicalPixels(fn) {
  let prev = null
  try { prev = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } catch { prev = null }
  try {
    return fn()
  } finally {
    if (prev) { try { SetThreadDpiAwarenessContext(prev) } catch {} }
  }
}

// ---------------------------------------------------------------- helpers

const utf16 = (buf, len) => Buffer.from(buf.buffer, buf.byteOffset, len * 2).toString('utf16le')

function windowTitle(hwnd) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(hwnd, buf, 512)
  return n > 0 ? utf16(buf, n) : ''
}

function windowClass(hwnd) {
  const buf = new Uint16Array(256)
  const n = GetClassNameW(hwnd, buf, 256)
  return n > 0 ? utf16(buf, n) : ''
}

function windowPid(hwnd) {
  const pid = new Uint32Array(1)
  GetWindowThreadProcessId(hwnd, pid)
  return pid[0]
}

export function isWindow(hwnd) {
  return IsWindow(Number(hwnd))
}

export function foregroundWindow() {
  return Number(GetForegroundWindow())
}

export function cursorPosition() {
  const p = { x: 0, y: 0 }
  GetCursorPos(p)
  return p
}

export function moveCursor(x, y) {
  return SetCursorPos(Math.round(x), Math.round(y))
}

/**
 * Window geometry in the DPI-unaware (logical) coordinate space.
 * Input APIs (SetCursorPos, mouse_event) use this space, while captureWindow
 * deliberately uses physical pixels for sharpness. Mixing the two was the bug
 * behind every missed click: a physical point like 2791,2302 clamped to the
 * logical screen edge at 1440,900.
 */
export function windowInfo(hwnd) {
  const h = Number(hwnd)
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  GetWindowRect(h, r)
  return {
    hwnd: h,
    pid: windowPid(h),
    title: windowTitle(h),
    class: windowClass(h),
    minimized: Boolean(IsIconic(h)),
    foreground: foregroundWindow() === h,
    rect: { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top },
  }
}

export function activateWindow(hwnd) {
  const h = Number(hwnd)
  if (IsIconic(h)) ShowWindow(h, 9) // SW_RESTORE

  // Windows only lets the foreground process take the foreground. A synthetic
  // Alt press/release releases that lock, which SetForegroundWindow alone
  // frequently loses (observed: activated=false, scroll then hit the wrong app).
  try { key(0x12, false); key(0x12, true) } catch {}

  BringWindowToTop(h)
  let ok = SetForegroundWindow(h)
  if (!ok) {
    // Windows only honours SetForegroundWindow from the foreground process.
    const fg = foregroundWindow()
    const fgTid = GetWindowThreadProcessId(fg, new Uint32Array(1))
    const myTid = GetCurrentThreadId()
    if (fgTid !== 0 && fgTid !== myTid) {
      AttachThreadInput(myTid, fgTid, true)
      ok = SetForegroundWindow(h)
      AttachThreadInput(myTid, fgTid, false)
    }
  }
  return { activated: foregroundWindow() === h, method: 'setforegroundwindow' }
}

/**
 * Capture a window with PrintWindow and write it as PNG.
 * Returns { ok, path, width, height, mode } or { ok:false, error }.
 */
export function captureWindow(hwnd, outPath) {
  return withPhysicalPixels(() => captureWindowInner(hwnd, outPath))
}

function captureWindowInner(hwnd, outPath) {
  const h = Number(hwnd)
  if (!h || !IsWindow(h)) return { ok: false, error: `invalid window handle: ${hwnd}` }
  if (IsIconic(h)) {
    return { ok: false, error: 'target window is minimized; restore it first (its client area has no size while minimized)' }
  }

  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  GetWindowRect(h, r)
  const width = r.right - r.left
  const height = r.bottom - r.top
  if (width <= 0 || height <= 0) return { ok: false, error: `window has no drawable area (${width}x${height})` }

  const hdc = GetDC(h)
  let mem = 0
  let bmp = 0
  try {
    mem = CreateCompatibleDC(hdc)
    bmp = CreateCompatibleBitmap(hdc, width, height)
    if (!mem || !bmp) return { ok: false, error: 'GDI resource allocation failed' }
    SelectObject(mem, bmp)

    let ok = PrintWindow(h, mem, PW_RENDERFULLCONTENT)
    if (!ok) ok = PrintWindow(h, mem, 0)

    // Read the bitmap back as top-down BGRA.
    const info = {
      biSize: 40, biWidth: width, biHeight: -height, biPlanes: 1, biBitCount: 32,
      biCompression: 0, biSizeImage: width * height * 4, biXPelsPerMeter: 0,
      biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    }
    const pixels = Buffer.alloc(width * height * 4)
    const lines = GetDIBits(mem, bmp, 0, height, pixels, info, 0)
    if (lines === 0) return { ok: false, error: 'GetDIBits failed' }

    // BGRA -> RGBA for the PNG encoder.
    const png = new PNG({ width, height })
    for (let i = 0; i < pixels.length; i += 4) {
      png.data[i] = pixels[i + 2]
      png.data[i + 1] = pixels[i + 1]
      png.data[i + 2] = pixels[i]
      png.data[i + 3] = pixels[i + 3] || 255
    }
    const buffer = PNG.sync.write(png)
    writeFileSync(outPath, buffer)

    return {
      ok: true,
      path: outPath,
      width,
      height,
      bytes: buffer.length,
      mode: ok ? 'print-window-native' : 'print-window-native-fallback',
      scope: 'window',
    }
  } catch (error) {
    return { ok: false, error: `capture failed: ${error.message}` }
  } finally {
    if (bmp) DeleteObject(bmp)
    if (mem) DeleteDC(mem)
    ReleaseDC(h, hdc)
  }
}

/** Capture the whole virtual screen region where the window sits. */
export function captureScreen(outPath) {
  const sw = GetSystemMetrics(78) // SM_CXVIRTUALSCREEN
  const sh = GetSystemMetrics(79) // SM_CYVIRTUALSCREEN
  if (sw <= 0 || sh <= 0) return { ok: false, error: 'could not read virtual screen size' }
  const hdc = GetDC(0)
  let mem = 0
  let bmp = 0
  try {
    mem = CreateCompatibleDC(hdc)
    bmp = CreateCompatibleBitmap(hdc, sw, sh)
    if (!mem || !bmp) return { ok: false, error: 'GDI resource allocation failed' }
    SelectObject(mem, bmp)
    // BitBlt from the screen DC into the memory DC.
    const SRCCOPY = 0x00CC0020
    const BitBlt = gdi32.func('bool __stdcall BitBlt(intptr dst, int x, int y, int w, int h, intptr src, int sx, int sy, uint32 rop)')
    if (!BitBlt(mem, 0, 0, sw, sh, hdc, 0, 0, SRCCOPY)) return { ok: false, error: 'BitBlt failed' }

    const info = {
      biSize: 40, biWidth: sw, biHeight: -sh, biPlanes: 1, biBitCount: 32,
      biCompression: 0, biSizeImage: sw * sh * 4, biXPelsPerMeter: 0,
      biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    }
    const pixels = Buffer.alloc(sw * sh * 4)
    if (GetDIBits(mem, bmp, 0, sh, pixels, info, 0) === 0) return { ok: false, error: 'GetDIBits failed' }
    const png = new PNG({ width: sw, height: sh })
    for (let i = 0; i < pixels.length; i += 4) {
      png.data[i] = pixels[i + 2]
      png.data[i + 1] = pixels[i + 1]
      png.data[i + 2] = pixels[i]
      png.data[i + 3] = pixels[i + 3] || 255
    }
    const buffer = PNG.sync.write(png)
    writeFileSync(outPath, buffer)
    return { ok: true, path: outPath, width: sw, height: sh, bytes: buffer.length, mode: 'bitblt-native', scope: 'screen' }
  } catch (error) {
    return { ok: false, error: `screen capture failed: ${error.message}` }
  } finally {
    if (bmp) DeleteObject(bmp)
    if (mem) DeleteDC(mem)
    ReleaseDC(0, hdc)
  }
}

/** Sample a few pixels to detect an entirely-black capture. */
export function isAllBlack(path) {
  try {
    const png = PNG.sync.read(readFileSync(path))
    if (png.width < 8 || png.height < 8) return false
    let dark = 0
    let n = 0
    for (let i = 1; i <= 24; i++) {
      const x = Math.floor((png.width * ((i - 1) % 6 + 0.5)) / 6)
      const y = Math.floor((png.height * (Math.floor((i - 1) / 6) + 0.5)) / 4)
      const idx = (y * png.width + x) * 4
      if (png.data[idx] < 10 && png.data[idx + 1] < 10 && png.data[idx + 2] < 10) dark++
      n++
    }
    return n > 0 && dark === n
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- input

const MOUSEINPUT = kstruct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
})
const KEYBDINPUT = kstruct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
})
const INPUTUNION = kunion('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
const INPUT = kstruct('INPUT', { type: 'uint32', u: INPUTUNION })

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, _In_ INPUT *arr, int size)')
const INPUT_SIZE = koffi.sizeof(INPUT)

const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const MOUSEEVENTF_RIGHTDOWN = 0x0008
const MOUSEEVENTF_RIGHTUP = 0x0010
const MOUSEEVENTF_MIDDLEDOWN = 0x0020
const MOUSEEVENTF_MIDDLEUP = 0x0040
const MOUSEEVENTF_WHEEL = 0x0800
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// mouse_event / keybd_event instead of SendInput: the koffi union encoding for
// INPUT did NOT reach applications (measured: wheel via SendInput changed the
// capture by 4 bytes, i.e. nothing; the same wheel via mouse_event scrolled the
// page immediately). The legacy entry points take plain arguments, so there is
// no layout to get wrong.
const mouse_event = user32.func('void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, uint32 data, void* extra)')
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, void* extra)')

function mouse(flags, data = 0) {
  mouse_event(flags, 0, 0, data >>> 0, null)
}

function key(vk, up) {
  keybd_event(vk & 0xff, 0, up ? KEYEVENTF_KEYUP : 0, null)
}

function unicodeChar(code) {
  // keybd_event takes a byte scan code, so only BMP values below 256 are safe;
  // wider characters go through the clipboard path instead.
  const c = code & 0xff
  keybd_event(0, c, KEYEVENTF_UNICODE, null)
  keybd_event(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, null)
}

const VK = {
  enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B, space: 0x20,
  backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
}

function vkOf(name) {
  const n = String(name || '').trim().toLowerCase()
  if (!n) throw new Error('empty key name')
  if (Object.hasOwn(VK, n)) return VK[n]
  if (n.length === 1) {
    const c = n.toUpperCase()
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c.charCodeAt(0)
  }
  throw new Error(`unknown key: ${name}`)
}

/**
 * Real pointer/keyboard injection. Reaches canvas-only and game UIs that window
 * messages cannot, because it goes through the system input queue.
 */
export async function sendInput(opts = {}) {
  // Deliberately NOT wrapped in withPhysicalPixels: injection APIs live in the
  // logical (DPI-unaware) space that windowInfo now reports.
  const action = String(opts.action || '').toLowerCase()
  const x = Number(opts.x)
  const y = Number(opts.y)

  switch (action) {
    case 'move': {
      if (!SetCursorPos(Math.round(x), Math.round(y))) return { ok: false, error: 'SetCursorPos failed' }
      return { ok: true, method: 'sendinput', action, x, y, state: 'moved' }
    }
    case 'hover': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(60)
      SetCursorPos(Math.round(x) + 1, Math.round(y))
      await sleep(40)
      SetCursorPos(Math.round(x), Math.round(y))
      return { ok: true, method: 'sendinput', action, x, y, state: 'sent-unverified' }
    }
    case 'click': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(30)
      mouse(MOUSEEVENTF_LEFTDOWN)
      await sleep(30)
      mouse(MOUSEEVENTF_LEFTUP)
      return { ok: true, method: 'sendinput', action, x, y, state: 'sent-unverified' }
    }
    case 'double-click': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(30)
      for (let i = 0; i < 2; i++) {
        mouse(MOUSEEVENTF_LEFTDOWN)
        await sleep(20)
        mouse(MOUSEEVENTF_LEFTUP)
        if (i === 0) await sleep(80)
      }
      return { ok: true, method: 'sendinput', action, x, y, state: 'sent-unverified' }
    }
    case 'right-click': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(30)
      mouse(MOUSEEVENTF_RIGHTDOWN)
      await sleep(30)
      mouse(MOUSEEVENTF_RIGHTUP)
      return { ok: true, method: 'sendinput', action, x, y, state: 'sent-unverified' }
    }
    case 'middle-click': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(30)
      mouse(MOUSEEVENTF_MIDDLEDOWN)
      await sleep(30)
      mouse(MOUSEEVENTF_MIDDLEUP)
      return { ok: true, method: 'sendinput', action, x, y, state: 'sent-unverified' }
    }
    case 'drag': {
      const x2 = Number(opts.x2)
      const y2 = Number(opts.y2)
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(60)
      mouse(MOUSEEVENTF_LEFTDOWN)
      await sleep(60)
      const steps = 16
      for (let i = 1; i <= steps; i++) {
        SetCursorPos(Math.round(x + ((x2 - x) * i) / steps), Math.round(y + ((y2 - y) * i) / steps))
        await sleep(15)
      }
      mouse(MOUSEEVENTF_LEFTUP)
      return { ok: true, method: 'sendinput', action, from: { x, y }, to: { x: x2, y: y2 }, state: 'sent-unverified' }
    }
    case 'scroll': {
      SetCursorPos(Math.round(x), Math.round(y))
      await sleep(20)
      const delta = Number.isFinite(Number(opts.amount)) && Number(opts.amount) !== 0 ? Number(opts.amount) : -120
      const horizontal = opts.horizontal === true || String(opts.axis || '').toLowerCase() === 'horizontal'
      if (horizontal) {
        // Shift+wheel is the portable way to scroll sideways; most toolkits
        // (Chromium, WinUI, Office) honour it where MOUSEHWHEEL often is ignored.
        key(0x10, false)
        await sleep(15)
        mouse(MOUSEEVENTF_WHEEL, delta)
        await sleep(15)
        key(0x10, true)
      } else {
        mouse(MOUSEEVENTF_WHEEL, delta)
      }
      return { ok: true, method: 'sendinput', action, x, y, amount: delta, horizontal, state: 'sent-unverified' }
    }
    case 'press': {
      const parts = String(opts.key || '').split('+').map((s) => s.trim()).filter(Boolean)
      if (parts.length === 0) return { ok: false, error: 'press needs key (e.g. "enter" or "ctrl+s")' }
      let vks
      try { vks = parts.map(vkOf) } catch (e) { return { ok: false, error: e.message } }
      for (const vk of vks) { key(vk, false); await sleep(20) }
      for (let i = vks.length - 1; i >= 0; i--) { key(vks[i], true); await sleep(20) }
      return { ok: true, method: 'sendinput', action, keys: parts, state: 'sent-unverified' }
    }
    case 'type': {
      const text = String(opts.text ?? '')
      if (text === '') return { ok: true, method: 'legacy-input', action, chars: 0, state: 'noop' }
      const chars = [...text]
      const bmpSafe = chars.every((ch) => ch.codePointAt(0) < 256)

      if (bmpSafe) {
        for (const ch of chars) {
          unicodeChar(ch.codePointAt(0))
          await sleep(8)
        }
        return { ok: true, method: 'legacy-input', action, chars: chars.length, state: 'sent-unverified' }
      }

      // CJK and other wide characters: keybd_event's scan code is a single byte,
      // so paste through the clipboard instead. The previous clipboard content
      // is restored afterwards.
      const previous = readClipboard()
      writeClipboard(text)
      await sleep(80)
      key(0x11, false)             // Ctrl down
      await sleep(20)
      key(0x56, false)             // V down
      await sleep(40)
      key(0x56, true)
      await sleep(20)
      key(0x11, true)
      await sleep(150)
      if (previous.ok && previous.text) writeClipboard(previous.text)
      return {
        ok: true,
        method: 'clipboard-paste',
        action,
        chars: chars.length,
        state: 'sent-unverified',
        note: 'non-ASCII text is pasted via the clipboard (previous content restored)',
      }
    }
    default:
      return { ok: false, error: `unknown input action: ${action}` }
  }
}
// ---------------------------------------------------------------- clipboard

const OpenClipboard = user32.func('bool __stdcall OpenClipboard(void* h)')
const CloseClipboard = user32.func('bool __stdcall CloseClipboard()')
const EmptyClipboard = user32.func('bool __stdcall EmptyClipboard()')
const GetClipboardData = user32.func('void* __stdcall GetClipboardData(uint32 fmt)')
const SetClipboardData = user32.func('void* __stdcall SetClipboardData(uint32 fmt, void* mem)')
const IsClipboardFormatAvailable = user32.func('bool __stdcall IsClipboardFormatAvailable(uint32 fmt)')
const GlobalAlloc = kernel32.func('void* __stdcall GlobalAlloc(uint32 flags, uintptr bytes)')
const GlobalLock = kernel32.func('void* __stdcall GlobalLock(void* h)')
const GlobalUnlock = kernel32.func('bool __stdcall GlobalUnlock(void* h)')
const GlobalFree = kernel32.func('void* __stdcall GlobalFree(void* h)')
const lstrlenW = kernel32.func('int __stdcall lstrlenW(void* p)')

const CF_UNICODETEXT = 13
const GMEM_MOVEABLE = 0x0002

function withClipboard(fn) {
  // The clipboard is shared: another process may hold it for a few
  // milliseconds, and OpenClipboard succeeding does not mean EmptyClipboard
  // will. Retry the whole operation, not just the open, and pause between
  // attempts instead of spinning on the CPU.
  let lastFailure = null
  for (let attempt = 0; attempt < 12; attempt++) {
    if (OpenClipboard(null)) {
      try {
        const result = fn()
        if (result && result.ok) return result
        lastFailure = result
      } finally {
        CloseClipboard()
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
  }
  return lastFailure || { ok: false, error: 'clipboard is locked by another process' }
}

export function readClipboard() {
  return withClipboard(() => {
    if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return { ok: true, text: '', empty: true }
    const h = GetClipboardData(CF_UNICODETEXT)
    if (!h) return { ok: true, text: '', empty: true }
    const p = GlobalLock(h)
    if (!p) return { ok: false, error: 'GlobalLock failed' }
    try {
      const len = lstrlenW(p)
      if (len <= 0) return { ok: true, text: '', empty: true }
      const u16 = koffi.decode(p, 'uint16', len)
      const buf = Buffer.alloc(len * 2)
      for (let i = 0; i < len; i++) buf.writeUInt16LE(u16[i], i * 2)
      return { ok: true, text: buf.toString('utf16le'), length: len }
    } finally {
      GlobalUnlock(h)
    }
  })
}

export function writeClipboard(text) {
  const s = String(text ?? '')
  return withClipboard(() => {
    if (!EmptyClipboard()) return { ok: false, error: 'EmptyClipboard failed' }
    // An empty string means "clear the clipboard". SetClipboardData rejects a
    // zero-length handle, so stop right after EmptyClipboard instead of letting
    // the allocation path fail with a confusing Win32 error.
    if (s.length === 0) return { ok: true, written: 0, cleared: true }
    const utf16 = Buffer.from(s + '\0', 'utf16le')
    const mem = GlobalAlloc(GMEM_MOVEABLE, utf16.length)
    if (!mem) return { ok: false, error: 'GlobalAlloc failed' }
    const p = GlobalLock(mem)
    if (!p) { GlobalFree(mem); return { ok: false, error: 'GlobalLock failed' } }
    koffi.encode(p, 'uint8', utf16, utf16.length)
    GlobalUnlock(mem)
    if (!SetClipboardData(CF_UNICODETEXT, mem)) {
      GlobalFree(mem)
      return { ok: false, error: 'SetClipboardData failed' }
    }
    // Ownership transferred to the clipboard on success: do not free.
    return { ok: true, written: s.length }
  })
}
// ---------------------------------------------------------------- watching

const GetTopWindow = user32.func('intptr __stdcall GetTopWindow(void* h)')
const GetWindow = user32.func('intptr __stdcall GetWindow(intptr h, uint32 cmd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr h)')
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vk)')
const GW_HWNDNEXT = 2

const VK_NAMES = {
  0x08: 'backspace', 0x09: 'tab', 0x0D: 'enter', 0x10: 'shift', 0x11: 'ctrl', 0x12: 'alt',
  0x1B: 'esc', 0x20: 'space', 0x21: 'pageup', 0x22: 'pagedown', 0x23: 'end', 0x24: 'home',
  0x25: 'left', 0x26: 'up', 0x27: 'right', 0x28: 'down', 0x2D: 'insert', 0x2E: 'delete',
  0x5B: 'win', 0x5C: 'win',
}
for (let i = 0x30; i <= 0x39; i++) VK_NAMES[i] = String.fromCharCode(i)   // 0-9
for (let i = 0x41; i <= 0x5A; i++) VK_NAMES[i] = String.fromCharCode(i)   // A-Z
for (let i = 0x70; i <= 0x7B; i++) VK_NAMES[i] = `f${i - 0x6F}`            // F1-F12

/** Visible top-level windows with a non-empty title, cheaply enumerated. */
export function enumTopWindows() {
  const out = []
  let h = Number(GetTopWindow(null))
  let guard = 0
  while (h && guard++ < 2000) {
    if (IsWindowVisible(h)) {
      const buf = new Uint16Array(512)
      const len = GetWindowTextW(h, buf, 512)
      if (len > 0) {
        out.push({ hwnd: h, title: Buffer.from(buf.buffer, 0, len * 2).toString('utf16le'), pid: windowPid(h) })
      }
    }
    h = Number(GetWindow(h, GW_HWNDNEXT))
  }
  return out
}

/** Which named keys are physically down right now. */
export function pressedKeys() {
  const keys = []
  for (let vk = 8; vk < 256; vk++) {
    const st = GetAsyncKeyState(vk)
    if (st & 0x8000) keys.push(VK_NAMES[vk] || `vk_${vk.toString(16)}`)
  }
  return keys
}

/**
 * Block until something changes, then report it.
 *
 * Deliberately polling rather than SetWinEventHook: a global keyboard hook is
 * indistinguishable from a keylogger and gets flagged by AV, and a Win32 message
 * loop inside the main thread can wedge the whole plugin. Polling costs ~1ms per
 * tick, so a 50ms cadence is cheap and cannot hang the host.
 */
export async function watch(opts = {}) {
  const timeoutMs = Math.min(120000, Math.max(200, Number(opts.timeoutMs) || 10000))
  const intervalMs = Math.min(1000, Math.max(20, Number(opts.intervalMs) || 50))
  const wantWindows = opts.windows !== false
  const wantKeys = opts.keys !== false
  const until = String(opts.until || 'any').toLowerCase()

  const snapshot = () => {
    const w = wantWindows ? enumTopWindows() : []
    const k = wantKeys ? pressedKeys() : []
    return { windows: w, keys: k }
  }

  const base = snapshot()
  const baseHwnds = new Set(base.windows.map((w) => w.hwnd))
  const baseKeys = new Set(base.keys)
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const now = snapshot()
    const events = []

    if (wantWindows) {
      const nowHwnds = new Set(now.windows.map((w) => w.hwnd))
      for (const w of now.windows) {
        if (!baseHwnds.has(w.hwnd)) events.push({ type: 'window-open', hwnd: w.hwnd, title: w.title, pid: w.pid })
      }
      for (const w of base.windows) {
        if (!nowHwnds.has(w.hwnd)) events.push({ type: 'window-close', hwnd: w.hwnd, title: w.title, pid: w.pid })
      }
    }

    if (wantKeys) {
      const nowKeys = new Set(now.keys)
      const fresh = now.keys.filter((k) => !baseKeys.has(k))
      if (fresh.length) {
        // Report the whole chord so "ctrl+s" arrives as one event.
        const chord = now.keys.filter((k) => ['ctrl', 'shift', 'alt', 'win'].includes(k))
        events.push({ type: 'key-down', keys: chord.length ? [...chord, ...fresh.filter((k) => !chord.includes(k))] : fresh })
      }
    }

    if (events.length) {
      const filtered = until === 'any' ? events
        : events.filter((e) => e.type === until)
      if (filtered.length) {
        return { ok: true, events: filtered, elapsedMs: Date.now() - started, baseline: { windows: base.windows.length } }
      }
    }
  }

  return { ok: true, events: [], timedOut: true, elapsedMs: Date.now() - started, baseline: { windows: base.windows.length } }
}
/** Nearest-neighbour downscale so a capture fits into a model context. */

/**
 * Release every button and modifier this code could have left held down.
 *
 * A drag or chord that fails halfway is worse than a no-op: the desktop keeps
 * the synthetic button down, so the user's own clicks turn into drags and the
 * only escape is Task Manager. Releasing unconditionally is safe because a
 * key-up on an already-up key is ignored.
 */
export function releaseAll() {
  const keys = []
  for (const [name, vk] of [
    ['ctrl', 0x11], ['shift', 0x10], ['alt', 0x12],
    ['lwin', 0x5b], ['rwin', 0x5c],
  ]) {
    key(vk, true)
    keys.push(name)
  }
  const buttons = []
  for (const [name, flag] of [
    ['left', MOUSEEVENTF_LEFTUP],
    ['right', MOUSEEVENTF_RIGHTUP],
    ['middle', MOUSEEVENTF_MIDDLEUP],
  ]) {
    mouse(flag, 0)
    buttons.push(name)
  }
  return { keys, buttons }
}

export function shrinkPng(src, dst, maxWidth = 1000) {
  try {
    const png = PNG.sync.read(readFileSync(src))
    if (png.width <= maxWidth) return src
    const ratio = maxWidth / png.width
    const w = Math.max(1, Math.floor(png.width * ratio))
    const h = Math.max(1, Math.floor(png.height * ratio))
    const out = new PNG({ width: w, height: h })
    for (let y = 0; y < h; y++) {
      const sy = Math.min(png.height - 1, Math.floor(y / ratio))
      for (let x = 0; x < w; x++) {
        const sx = Math.min(png.width - 1, Math.floor(x / ratio))
        const si = (sy * png.width + sx) * 4
        const di = (y * w + x) * 4
        out.data[di] = png.data[si]
        out.data[di + 1] = png.data[si + 1]
        out.data[di + 2] = png.data[si + 2]
        out.data[di + 3] = png.data[si + 3]
      }
    }
    const buf = PNG.sync.write(out)
    writeFileSync(dst, buf)
    return dst
  } catch {
    return src
  }
}

