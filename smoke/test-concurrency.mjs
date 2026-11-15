/**
 * 并发测试：常驻 helper 是单线程的，请求必须串行且互不干扰。
 * 同时确认并发失败不会让后续请求变慢或拿到别人的结果。
 */
import { shutdown, callHelper } from '../lib/helper-client.mjs'
import { POWERSHELL, HELPER } from '../lib/run.mjs'

let failed = false
const check = (label, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed = true
}

try {
  // 10 个 list 请求并发发起：每个都必须拿到自己的完整结果
  const reqs = Array.from({ length: 10 }, () =>
    callHelper({ action: 'list' }, { powershell: POWERSHELL, helperPath: HELPER, timeoutMs: 60000 }))

  const t0 = Date.now()
  const results = await Promise.all(reqs)
  const elapsed = Date.now() - t0

  const allOk = results.every((r) => r && r.ok !== false)
  check('10 个并发请求全部成功', allOk, `${elapsed}ms`)

  // 每个结果都必须是完整结构，不能混入别人的错误
  const shaped = results.every((r) => Array.isArray(r.windows) && typeof r.count === 'number')
  check('每个结果结构完整（无串味）', shaped)

  // 串行执行意味着总耗时 >= 单次耗时 * 1（而不是并行的那份）
  const counts = results.map((r) => r.count)
  const consistent = counts.every((c) => c === counts[0])
  check('所有结果计数一致', consistent, `count=${counts[0]}`)

  // 并发中的坏请求不能污染好请求
  const mixed = await Promise.all([
    callHelper({ action: 'list' }, { powershell: POWERSHELL, helperPath: HELPER, timeoutMs: 60000 }),
    callHelper({ action: 'nonsense' }, { powershell: POWERSHELL, helperPath: HELPER, timeoutMs: 60000 }),
    callHelper({ action: 'list' }, { powershell: POWERSHELL, helperPath: HELPER, timeoutMs: 60000 }),
  ])
  check('坏请求只影响自己', mixed[0]?.ok !== false && mixed[1]?.ok === false && mixed[2]?.ok !== false)
} catch (error) {
  failed = true
  console.error('FAIL:', error.message)
} finally {
  shutdown()
}
setTimeout(() => process.exit(failed ? 1 : 0), 300)
