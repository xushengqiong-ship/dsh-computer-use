/**
 * Persistent helper client.
 *
 * Spawning Windows PowerShell costs about a second; a UIA round trip is often
 * less. This keeps one `helper.ps1 -Action serve` process alive and exchanges
 * one JSON line per request.
 *
 * Invariants (each one was a bug before it was an invariant):
 *  - A request belongs to ONE process instance. Late `line`/`exit`/`error`
 *    events from a previous process must never settle a newer request (A03).
 *  - Every request settles exactly once, through `settle()` (A04).
 *  - stdin write failures and EPIPE settle the request instead of leaving it
 *    to time out.
 *  - Requests are serialised: PowerShell is single threaded and a half-written
 *    line would desync the stream.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const DEFAULT_TIMEOUT_MS = 60_000

let child = null
let rl = null
let current = null            // { resolve, timer, proc }
let chain = Promise.resolve()
let generation = 0

export function isRunning() {
  return child !== null && child.exitCode === null && !child.killed
}

/** Settle the in-flight request at most once. */
function settle(request, payload) {
  if (!request) return
  clearTimeout(request.timer)
  if (current === request) current = null
  try { request.resolve(payload) } catch {}
}

function spawnServe(powershell, helperPath) {
  const proc = spawn(
    powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Action', 'serve'],
    { windowsHide: true },
  )
  generation += 1
  proc.__gen = generation

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  const reader = readline.createInterface({ input: proc.stdout })

  reader.on('line', (line) => {
    // Only the process that owns the in-flight request may answer it.
    if (!current || current.proc !== proc) return
    const text = line.trim()
    if (!text) return
    const request = current
    current = null
    clearTimeout(request.timer)
    try {
      request.resolve(JSON.parse(text))
    } catch {
      request.resolve({ ok: false, channel: true, error: 'helper 返回了无法解析的输出', raw: text.slice(0, 300) })
    }
  })

  proc.on('error', (error) => {
    if (current && current.proc === proc) {
      settle(current, { ok: false, channel: true, error: `helper 启动失败：${error.message}` })
    }
    if (child === proc) { child = null; rl = null }
  })

  proc.on('exit', () => {
    if (current && current.proc === proc) {
      settle(current, { ok: false, channel: true, error: 'helper 进程退出了' })
    }
    if (child === proc) {
      try { reader.close() } catch {}
      child = null
      rl = null
    }
  })

  // EPIPE and friends surface here, not in the write() try/catch.
  proc.stdin.on('error', (error) => {
    if (current && current.proc === proc) {
      settle(current, { ok: false, channel: true, error: `helper stdin 错误：${error.message}` })
    }
  })

  // Drain stderr so a chatty failure cannot block the pipe.
  proc.stderr.on('data', () => {})

  return { proc, reader }
}

function killCurrent() {
  const proc = child
  child = null
  try { rl?.close() } catch {}
  rl = null
  if (proc) {
    try { proc.kill() } catch {}
  }
}

/**
 * Send one request to the persistent helper.
 * @param {object} request  wire form: { action, pid, titleB64, ... }
 */
export function callHelper(request, options = {}) {
  const { powershell, helperPath, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const run = () => new Promise((resolve) => {
    if (!isRunning()) {
      const started = spawnServe(powershell, helperPath)
      child = started.proc
      rl = started.reader
    }

    const proc = child
    if (!proc || !isRunning()) {
      return resolve({ ok: false, channel: true, error: 'helper 无法启动' })
    }

    const req = { resolve, timer: null, proc }

    req.timer = setTimeout(() => {
      if (current !== req) return
      current = null
      // A stuck helper is worse than none: kill it so the next call restarts clean.
      killCurrent()
      resolve({ ok: false, channel: true, error: `helper 超时（${timeoutMs}ms）` })
    }, timeoutMs)

    current = req

    try {
      proc.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error && current === req) {
          settle(req, { ok: false, channel: true, error: `写入 helper 失败：${error.message}` })
        }
      })
    } catch (error) {
      settle(req, { ok: false, channel: true, error: `写入 helper 失败：${error.message}` })
    }
  })

  const next = chain.then(run, run)
  chain = next.catch(() => {})
  return next
}

export function shutdown() {
  if (current) settle(current, { ok: false, channel: true, error: 'helper 已关闭' })
  killCurrent()
}
