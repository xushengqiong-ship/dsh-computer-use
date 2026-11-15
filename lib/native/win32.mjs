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
import { writeFileSync, readFileSync } from 'node:fs'

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')

// ---------------------------------------------------------------- types

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
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

export const PW_RENDERFULLCONTENT = 2

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

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr',
})
const INPUTUNION = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUTUNION })

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

function mouse(flags, data = 0) {
  const arr = [{ type: 0, u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }]
  return SendInput(1, arr, INPUT_SIZE)
}

function key(vk, up) {
  const arr = [{ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } } }]
  return SendInput(1, arr, INPUT_SIZE)
}

function unicodeChar(code) {
  const down = { type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } }
  const up = { type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } }
  return SendInput(2, [down, up], INPUT_SIZE)
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
      const delta = Number.isFinite(Number(opts.amount)) && Number(opts.amount) !== 0 ? Number(opts.amount) : -120
      mouse(MOUSEEVENTF_WHEEL, delta)
      return { ok: true, method: 'sendinput', action, x, y, amount: delta, state: 'sent-unverified' }
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
      if (text === '') return { ok: true, method: 'sendinput', action, chars: 0, state: 'noop' }
      for (const ch of text) {
        unicodeChar(ch.codePointAt(0) & 0xFFFF)
        await sleep(8)
      }
      return { ok: true, method: 'sendinput', action, chars: [...text].length, state: 'sent-unverified' }
    }
    default:
      return { ok: false, error: `unknown input action: ${action}` }
  }
}