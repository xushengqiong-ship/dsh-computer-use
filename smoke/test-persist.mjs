/**
 * 常驻 helper vs 一次性 spawn 的性能对比（只做 list，安全只读）。
 */
import { callHelper, shutdown } from '../lib/helper-client.mjs'
import { runHelper, POWERSHELL, HELPER } from '../lib/run.mjs'

const opts = { powershell: POWERSHELL, helperPath: HELPER, timeoutMs: 60000 }
const N = 5

// 预热常驻进程
const warm = await callHelper({ action: 'list' }, opts)
if (!warm.ok) {
  console.log('常驻 helper 启动失败:', warm.error)
  process.exit(1)
}

let t0 = Date.now()
for (let i = 0; i < N; i++) {
  const r = await callHelper({ action: 'list' }, opts)
  if (!r.ok) throw new Error('常驻调用失败: ' + r.error)
}
const persistMs = Date.now() - t0

t0 = Date.now()
for (let i = 0; i < N; i++) {
  const r = await runHelper({ action: 'list', timeoutSec: 60 })
  if (!r.ok) throw new Error('单次调用失败: ' + r.error)
}
const oneshotMs = Date.now() - t0

console.log(`${N} 次 list：`)
console.log(`  常驻   ${persistMs}ms  (${Math.round(persistMs / N)}ms/次)`)
console.log(`  一次性 ${oneshotMs}ms  (${Math.round(oneshotMs / N)}ms/次)`)
console.log(`  提速   ${(oneshotMs / persistMs).toFixed(1)}x`)

shutdown()
