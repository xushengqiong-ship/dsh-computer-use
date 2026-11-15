/**
 * Windows provider — UI Automation via Windows PowerShell 5.1.
 *
 * Works on Windows 10 and 11, Home / Pro / Enterprise / Education alike:
 * UIAutomation is a system component and `powershell.exe` ships with the OS.
 */
import { runHelper } from '../run.mjs'

export const platform = 'win32'
export const label = 'Windows (UI Automation)'

export async function status() {
  const r = await runHelper({ action: 'list', timeoutSec: 30 })
  return {
    ok: r.ok,
    platform,
    label,
    detail: r.ok ? `UIA 可用，当前 ${r.count} 个可见窗口` : (r.error || 'UIA 不可用'),
  }
}

export async function listWindows(opts = {}) {
  const r = await runHelper({ action: 'list', timeoutSec: 40 })
  if (!r.ok) return r
  let list = r.windows || []
  if (opts.filter) {
    const f = String(opts.filter).toLowerCase()
    list = list.filter((w) => String(w.title || '').toLowerCase().includes(f))
  }
  return { ok: true, count: list.length, windows: list, total: r.count }
}

export async function inspect(opts = {}) {
  return runHelper({
    action: 'observe',
    targetPid: opts.pid,
    title: opts.title,
    max: opts.max,
    timeoutSec: 90,
  })
}

export async function act(opts = {}) {
  const helperAction = opts.action === 'set-text' ? 'settext' : opts.action
  return runHelper({
    action: helperAction,
    targetPid: opts.pid,
    title: opts.title,
    index: opts.index,
    text: opts.text,
    expectName: opts.expectName,
    x: opts.x,
    y: opts.y,
    timeoutSec: 60,
  })
}

export async function screenshot(opts = {}) {
  return runHelper({
    action: 'screenshot',
    targetPid: opts.pid,
    title: opts.title,
    out: opts.out,
    timeoutSec: 60,
  })
}
