/**
 * Windows provider — UI Automation via Windows PowerShell 5.1.
 *
 * Works on Windows 10 and 11, Home / Pro / Enterprise / Education alike:
 * UIAutomation is a system component and `powershell.exe` ships with the OS.
 *
 * Uses the persistent helper by default (one long-lived `serve` process) and
 * falls back to one-shot spawns if that helper cannot start.
 */
import { runHelper, POWERSHELL, HELPER } from '../run.mjs'
import { callHelper } from '../helper-client.mjs'

export const platform = 'win32'
export const label = 'Windows (UI Automation)'

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

/** 常驻调用；失败则降级为一次性 spawn。 */
async function call(req, { timeoutSec = 60, allowFallback = true } = {}) {
  const r = await callHelper(req, {
    powershell: POWERSHELL,
    helperPath: HELPER,
    timeoutMs: timeoutSec * 1000,
  })

  // 常驻进程起不来时（权限、编码、环境异常），退回每次 spawn 的老路。
  if (r && r.ok === false && allowFallback && /无法启动|退出了|超时/.test(String(r.error || ''))) {
    return runHelper({
      action: req.action,
      targetPid: req.pid,
      title: req.title,
      index: req.index,
      text: req.text,
      expectName: req.expectName,
      x: req.x,
      y: req.y,
      out: req.out,
      max: req.max,
      timeoutSec,
    })
  }
  return r
}

export async function status() {
  const r = await call({ action: 'list' }, { timeoutSec: 30 })
  return {
    ok: r.ok,
    platform,
    label,
    detail: r.ok ? `UIA 可用，当前 ${r.count} 个可见窗口` : (r.error || 'UIA 不可用'),
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
  const req = { action: 'observe', pid: opts.pid, max: opts.max }
  if (opts.title) req.titleB64 = b64(opts.title)
  if (opts.out) {
    req.out = opts.out
    req.withShot = true
  }
  return call(req, { timeoutSec: 90 })
}

export async function act(opts = {}) {
  const action = opts.action === 'set-text' ? 'settext' : opts.action
  const req = {
    action,
    pid: opts.pid,
    index: opts.index,
    x: opts.x,
    y: opts.y,
    x2: opts.x2,
    y2: opts.y2,
  }
  if (opts.title) req.titleB64 = b64(opts.title)
  if (opts.expectName) req.expectNameB64 = b64(opts.expectName)
  if (opts.text !== undefined) req.textB64 = b64(opts.text)
  return call(req, { timeoutSec: 60 })
}

export async function screenshot(opts = {}) {
  const req = { action: 'screenshot', pid: opts.pid, out: opts.out }
  if (opts.title) req.titleB64 = b64(opts.title)
  return call(req, { timeoutSec: 60 })
}
