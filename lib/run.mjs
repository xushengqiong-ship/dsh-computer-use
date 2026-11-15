/**
 * dsh-computer-use-win — core.
 *
 * Spawns lib/helper.ps1 (Windows PowerShell 5.1 + .NET UIAutomation) and
 * normalises its JSON replies. Deliberately stateless: every call re-reads the
 * live UI tree, so a stale index can never be replayed against a changed window.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HELPER = path.join(HERE, 'helper.ps1')

// UIAutomation lives in .NET Framework, which Windows PowerShell 5.1 has and
// PowerShell 7 (.NET Core) does not always carry. Default to 5.1.
export const POWERSHELL = process.env.DSH_WIN_CU_POWERSHELL
  || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

export const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')

function pushFlag(args, flag, value) {
  if (value === undefined || value === null || value === '') return
  args.push(flag, String(value))
}

/**
 * Run one helper action.
 * @returns {Promise<object>} parsed JSON (always has `ok`)
 */
export function runHelper(options = {}) {
  const {
    action,
    targetPid,
    title,
    index,
    text,
    expectName,
    x,
    y,
    x2,
    y2,
    max,
    out,
    withShot,
    hwnd,
    inputAction,
    key,
    amount,
    timeoutSec = 60,
  } = options

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', action]
  pushFlag(args, '-TargetPid', targetPid)
  if (hwnd) args.push('-Hwnd', String(hwnd))
  if (title) args.push('-TitleB64', b64(title))
  pushFlag(args, '-Index', index)
  if (text !== undefined && text !== null) args.push('-TextB64', b64(text))
  if (expectName) args.push('-ExpectNameB64', b64(expectName))
  pushFlag(args, '-X', x)
  pushFlag(args, '-Y', y)
  pushFlag(args, '-X2', x2)
  pushFlag(args, '-Y2', y2)
  pushFlag(args, '-Max', max)
  pushFlag(args, '-Out', out)
  if (inputAction) args.push('-InputAction', String(inputAction))
  if (key) args.push('-Key', String(key))
  pushFlag(args, '-Amount', amount)
  if (withShot) args.push('-WithShot')

  const started = Date.now()

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(POWERSHELL, args, { windowsHide: true })
    } catch (error) {
      return resolve({ ok: false, error: `无法启动 PowerShell：${error.message}` })
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
    }, Math.max(5, timeoutSec) * 1000)

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `PowerShell 执行失败：${error.message}` })
    })

    child.on('close', () => {
      clearTimeout(timer)
      const durationSec = Math.round((Date.now() - started) / 100) / 10

      // helper prints exactly one JSON object; strip any stray banner lines
      const start = stdout.indexOf('{')
      const end = stdout.lastIndexOf('}')
      if (start < 0 || end <= start) {
        return resolve({
          ok: false,
          error: '没有拿到 JSON 输出',
          stderr: stderr.trim().slice(-800),
          durationSec,
        })
      }
      try {
        const parsed = JSON.parse(stdout.slice(start, end + 1))
        parsed.durationSec = durationSec
        return resolve(parsed)
      } catch (error) {
        return resolve({
          ok: false,
          error: `JSON 解析失败：${error.message}`,
          raw: stdout.slice(start, end + 1).slice(0, 500),
          durationSec,
        })
      }
    })
  })
}

/** Make sure a screenshot directory exists and return a unique file path. */
export function screenshotPath(dir, pid) {
  const target = path.resolve(dir)
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(target, `win-${pid || 'screen'}-${stamp}.png`)
}

export function helperExists() {
  return existsSync(HELPER)
}

export function powershellExists() {
  return existsSync(POWERSHELL)
}
