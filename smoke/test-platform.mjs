/**
 * 平台无关的加载测试：验证工具注册与结构，不碰任何窗口。
 * CI 用这个（GitHub runner 没有交互式桌面，真实 UI 自动化跑不了）。
 *
 * 注意：Windows provider 会启动常驻 helper，必须在 finally 里 shutdown，
 * 否则 Node 事件循环被存活子进程挂住，测试不会退出。
 */
import { shutdown } from '../lib/helper-client.mjs'

let failed = false
try {
  const mod = await import('../lib/index.mjs')

  const reg = []
  const ctx = {
    tools: { register: (t) => reg.push(t) },
    logger: { warn: () => {}, error: () => {} },
    inject: () => {},
  }

  mod.apply(ctx)

  const expected = [
    'computer_status',
    'computer_list_windows',
    'computer_inspect',
    'computer_act',
    'computer_screenshot',
  ]
  for (const n of expected) {
    if (!reg.some((t) => t.name === n)) throw new Error(`missing tool: ${n}`)
  }
  for (const t of reg) {
    if (!t.description) throw new Error(`${t.name}: no description`)
    if (!t.parameters) throw new Error(`${t.name}: no parameters`)
    if (!t.output?.render) throw new Error(`${t.name}: no render`)
  }

  const status = reg.find((t) => t.name === 'computer_status')
  const st = await status.execute({})
  if (typeof st.message !== 'string') throw new Error('status did not return a message')

  const act = reg.find((t) => t.name === 'computer_act')
  const bad = await act.execute({ action: 'invoke', index: 0 })
  if (bad.ok !== false) throw new Error('computer_act accepted a call with no target')

  console.log('platform:', process.platform)
  console.log('tools:', reg.map((t) => t.name).join(', '))
  console.log('status.ok =', st.ok)
  console.log('plugin load test OK')
} catch (error) {
  failed = true
  console.error('FAIL:', error.message)
} finally {
  shutdown()
}

// 给子进程一点时间退出，避免僵尸残留
setTimeout(() => process.exit(failed ? 1 : 0), 300)
