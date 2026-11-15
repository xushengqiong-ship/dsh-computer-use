// Full-surface acceptance: every tool, normal and error paths.
// Goal: find anything that throws instead of returning a result, and anything
// whose result would fail DSH's lossless-JSON requirement.
import { shutdown } from '../lib/helper-client.mjs'

const mod = await import('../lib/index.mjs')
const reg = []
mod.apply({ tools: { register: (t) => reg.push(t) }, logger: {}, inject: () => {} })
const T = (n) => reg.find((t) => t.name === n)

let pass = 0
let fail = 0
const failures = []

const check = async (label, fn, opts = {}) => {
  try {
    const r = await fn()
    if (r === undefined || r === null) throw new Error('returned ' + r)
    const json = JSON.stringify(r)
    if (json === undefined) throw new Error('result not serialisable')
    if (/\bundefined\b/.test(json)) throw new Error('result contains undefined')
    if (typeof r !== 'object') throw new Error('result not an object')
    if (opts.expectOk === true && r.ok !== true) throw new Error('expected ok=true, got ' + r.ok + ': ' + String(r.message || '').slice(0, 60))
    if (opts.expectOk === false && r.ok !== false) throw new Error('expected ok=false, got ' + r.ok)
    if (opts.expectError && r.ok !== false) throw new Error('expected a refusal, got success')
    pass++
    console.log('  OK   ' + label + (r.ok === false ? '  (refused: ' + String(r.message || '').slice(0, 50) + ')' : ''))
    return r
  } catch (e) {
    fail++
    const msg = e && e.message ? e.message : String(e)
    failures.push(label + ': ' + msg)
    console.log('  FAIL ' + label + ' -> ' + msg.slice(0, 100))
    return null
  }
}

try {
  console.log('tools registered:', reg.map((t) => t.name.replace('computer_', '')).join(', '))
  console.log('')

  // find a live target
  const list = await T('computer_list_windows').execute({})
  const target = (list.windows || []).find((w) => (w.title || '').includes('ChatGPT') && !w.minimized)
    || (list.windows || []).find((w) => (w.width || 0) > 800)
  const PID = target ? target.pid : 0
  const HWND = target ? target.hwnd : 0
  console.log('target:', target ? `${target.title} pid=${PID}` : 'none')
  console.log('')

  console.log('[computer_status]')
  await check('status', () => T('computer_status').execute({}), { expectOk: true })

  console.log('[computer_list_windows]')
  await check('list all', () => T('computer_list_windows').execute({}), { expectOk: true })
  await check('list with filter hit', () => T('computer_list_windows').execute({ filter: 'C' }), { expectOk: true })
  await check('list with filter miss', () => T('computer_list_windows').execute({ filter: 'zzz-no-such-window' }), { expectOk: true })

  console.log('[computer_inspect]')
  await check('inspect by pid', () => T('computer_inspect').execute({ pid: PID, max: 10 }), { expectOk: true })
  await check('inspect by hwnd', () => T('computer_inspect').execute({ hwnd: String(HWND), max: 10 }), { expectOk: true })
  await check('inspect no target', () => T('computer_inspect').execute({}), { expectError: true })
  await check('inspect bad pid', () => T('computer_inspect').execute({ pid: 999999 }), { expectError: true })

  console.log('[computer_screenshot]')
  await check('screenshot by pid', () => T('computer_screenshot').execute({ pid: PID }), { expectOk: true })
  await check('screenshot by hwnd', () => T('computer_screenshot').execute({ hwnd: String(HWND) }), { expectOk: true })
  await check('screenshot screen', () => T('computer_screenshot').execute({}), { expectOk: true })
  await check('screenshot bad pid', () => T('computer_screenshot').execute({ pid: 999999 }), { expectError: true })

  console.log('[computer_act]')
  await check('act unknown action', () => T('computer_act').execute({ pid: PID, action: 'nope' }), { expectError: true })
  await check('act no target', () => T('computer_act').execute({ action: 'invoke', index: 0 }), { expectError: true })
  await check('act invoke needs index', () => T('computer_act').execute({ pid: PID, action: 'invoke' }), { expectError: true })
  await check('act set-text needs text', () => T('computer_act').execute({ pid: PID, action: 'set-text', index: 1 }), { expectError: true })
  await check('act click needs x/y', () => T('computer_act').execute({ pid: PID, action: 'click' }), { expectError: true })
  await check('act drag needs x2/y2', () => T('computer_act').execute({ pid: PID, action: 'drag', x: 1, y: 1 }), { expectError: true })
  await check('act bad index', () => T('computer_act').execute({ pid: PID, action: 'invoke', index: 99999 }), { expectError: true })
  await check('act activate', () => T('computer_act').execute({ pid: PID, action: 'activate' }), { expectOk: true })

  console.log('[computer_input]')
  await check('input unknown action', () => T('computer_input').execute({ action: 'nope' }), { expectError: true })
  await check('input move needs x/y', () => T('computer_input').execute({ action: 'move' }), { expectError: true })
  await check('input press needs key', () => T('computer_input').execute({ action: 'press' }), { expectError: true })
  await check('input type needs text', () => T('computer_input').execute({ action: 'type' }), { expectError: true })
  await check('input drag needs x2/y2', () => T('computer_input').execute({ action: 'drag', x: 1, y: 1 }), { expectError: true })
  await check('input wait', () => T('computer_input').execute({ action: 'wait', ms: 120 }), { expectOk: true })
  await check('input bad key name', () => T('computer_input').execute({ action: 'press', key: 'notakey' }), { expectError: true })

  console.log('[computer_clipboard]')
  await check('clipboard get', () => T('computer_clipboard').execute({ action: 'get' }), { expectOk: true })
  const before = await T('computer_clipboard').execute({ action: 'get' })
  await check('clipboard set', () => T('computer_clipboard').execute({ action: 'set', text: 'ACCEPTANCE-PROBE' }), { expectOk: true })
  await check('clipboard set empty', () => T('computer_clipboard').execute({ action: 'set', text: '' }), { expectOk: true })
  await check('clipboard unknown action', () => T('computer_clipboard').execute({ action: 'nope' }), { expectError: true })
  // restore
  if (before && typeof before.text === 'string') {
    await T('computer_clipboard').execute({ action: 'set', text: before.text })
  }

  console.log('[computer_watch]')
  await check('watch timeout', () => T('computer_watch').execute({ timeoutMs: 250, keys: false }), { expectOk: true })
  await check('watch bad until', () => T('computer_watch').execute({ until: 'nope', timeoutMs: 200 }), { expectError: true })
  await check('watch both false', () => T('computer_watch').execute({ windows: false, keys: false, timeoutMs: 200 }), { expectError: true })

  console.log('[computer_scan]')
  await check('scan bad pid', () => T('computer_scan').execute({ pid: 999999, maxFrames: 1 }), { expectError: true })

  console.log('[computer_stop]')
  await check('stop', () => T('computer_stop').execute({}), { expectOk: true })
} finally {
  shutdown()
}

console.log('')
console.log('PASS ' + pass + '  FAIL ' + fail)
if (failures.length) {
  console.log('--- failures ---')
  for (const f of failures) console.log('  ' + f)
}
process.exit(fail ? 1 : 0)
