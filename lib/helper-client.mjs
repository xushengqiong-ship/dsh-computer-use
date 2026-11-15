/**
 * Persistent helper client.
 *
 * Spawning Windows PowerShell costs ~300ms per call, and a UIA round trip is
 * often less than that. This keeps one `helper.ps1 -Action serve` process alive
 * and exchanges one JSON line per request.
 *
 * Requests are strictly serialised: PowerShell has a single thread, and a
 * half-written line would desync the stream. A dead process is restarted on the
 * next call; the in-flight request is rejected rather than silently retried.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const DEFAULT_TIMEOUT_MS = 60_000

let child = null
let rl = null
let current = null          // { resolve, reject, timer }
let chain = Promise.resolve() // serialises requests

export function isRunning() {
  return child !== null && child.exitCode === null && !child.killed
}

function spawnServe(powershell, helperPath) {
  const proc = spawn(
    powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Action', 'serve'],
    { windowsHide: true },
  )
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  const r = readline.createInterface({ input: proc.stdout })
  r.on('line', (line) => {
    const text = line.trim()
    if (!text || !current) return
    const req = current
    current = null
    clearTimeout(req.timer)
    try {
      req.resolve(JSON.parse(text))
    } catch {
      req.resolve({ ok: false, error: 'helper 返回了无法解析的输出', raw: text.slice(0, 300) })
    }
  })

  proc.on('exit', () => {
    if (current) {
      const req = current
      current = null
      clearTimeout(req.timer)
      req.resolve({ ok: false, error: 'helper 进程退出了' })
    }
    if (child === proc) {
      // drop the dead instance so the next call restarts it
      try { r.close() } catch {}
      child = null
      rl = null
    }
  })

  proc.on('error', () => {
    if (child === proc) { child = null; rl = null }
  })

  // keep stderr drained so a chatty failure cannot block the pipe
  proc.stderr.on('data', () => {})

  return { proc, r }
}

/**
 * Send one request to the persistent helper.
 * @param {object} request  { action, pid, titleB64, ... }
 * @returns {Promise<object>}
 */
export function callHelper(request, options = {}) {
  const { powershell, helperPath, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const run = () => new Promise((resolve) => {
    if (!isRunning()) {
      const started = spawnServe(powershell, helperPath)
      child = started.proc
      rl = started.r
    }
    if (!isRunning()) {
      resolve({ ok: false, error: 'helper 无法启动' })
      return
    }

    const timer = setTimeout(() => {
      if (current) {
        const req = current
        current = null
        clearTimeout(req.timer)
        req.resolve({ ok: false, error: `helper 超时（${timeoutMs}ms）` })
        // a stuck helper is worse than no helper: kill it so the next call restarts clean
        try { child?.kill() } catch {}
        child = null
        rl = null
      }
    }, timeoutMs)

    current = { resolve, timer }

    try {
      child.stdin.write(JSON.stringify(request) + '\n')
    } catch (error) {
      clearTimeout(timer)
      current = null
      resolve({ ok: false, error: `写入 helper 失败：${error.message}` })
    }
  })

  const next = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

export function shutdown() {
  if (current) {
    const req = current
    current = null
    clearTimeout(req.timer)
    req.resolve({ ok: false, error: 'helper 已关闭' })
  }
  try { rl?.close() } catch {}
  try { child?.kill() } catch {}
  child = null
  rl = null
}
