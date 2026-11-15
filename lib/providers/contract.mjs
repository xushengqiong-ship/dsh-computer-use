/**
 * Provider contract.
 *
 * Every platform module exports the same five async functions. The tool layer
 * (lib/index.mjs) knows nothing about the platform specifics.
 *
 * @typedef {object} Provider
 * @property {string} platform        'win32' | 'darwin' | 'linux'
 * @property {string} label           human-readable platform name
 * @property {() => Promise<object>} status
 * @property {(opts) => Promise<object>} listWindows
 * @property {(opts) => Promise<object>} inspect
 * @property {(opts) => Promise<object>} act
 * @property {(opts) => Promise<object>} screenshot
 */
import { spawn } from 'node:child_process'

/**
 * Run a child process and collect its output. Shared by the POSIX providers,
 * which shell out to osascript / xdotool instead of embedding a native helper.
 */
export function runCommand(cmd, args, { timeoutSec = 60, stdin } = {}) {
  const started = Date.now()
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      return resolve({ ok: false, error: `无法启动 ${cmd}：${error.message}` })
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
    }, Math.max(5, timeoutSec) * 1000)

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `${cmd} 执行失败：${error.message}`, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        exitCode: code,
        durationSec: Math.round((Date.now() - started) / 100) / 10,
        ...(code !== 0 ? { error: `${cmd} 退出码 ${code}` } : {}),
      })
    })
    if (stdin !== undefined) {
      try { child.stdin.end(String(stdin)) } catch {}
    }
  })
}

/** Does `cmd` exist on PATH? */
export function hasCommand(cmd) {
  const probe = spawn(cmd, ['--version'], { windowsHide: true })
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    probe.on('error', () => finish(false))
    probe.on('close', (code) => finish(code === 0 || code === 1))
    setTimeout(() => { try { probe.kill() } catch {}; finish(false) }, 5000)
  })
}
