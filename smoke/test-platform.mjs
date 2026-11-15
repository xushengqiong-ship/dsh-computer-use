/**
 * 平台无关的加载测试：验证工具注册与结构，不碰任何窗口。
 * CI 用这个（GitHub runner 没有交互式桌面，真实 UIA 跑不了）。
 */
const mod = await import('../lib/index.mjs')

const reg = []
const ctx = {
  tools: { register: (t) => reg.push(t) },
  logger: { warn: () => {}, error: () => {} },
  inject: () => {},
}

mod.apply(ctx)

const expected = ['win_list_windows', 'win_inspect', 'win_act', 'win_screenshot', 'win_status']
for (const n of expected) {
  if (!reg.some((t) => t.name === n)) throw new Error(`missing tool: ${n}`)
}
for (const t of reg) {
  if (!t.description) throw new Error(`${t.name}: no description`)
  if (!t.parameters) throw new Error(`${t.name}: no parameters`)
  if (!t.output?.render) throw new Error(`${t.name}: no render`)
}

// status 不碰窗口，任何平台都能跑
const status = reg.find((t) => t.name === 'win_status')
const st = await status.execute({})
if (typeof st.message !== 'string') throw new Error('status did not return a message')

// 参数校验（不触发 helper）
const act = reg.find((t) => t.name === 'win_act')
const bad = await act.execute({ action: 'invoke', index: 0 })
if (bad.ok !== false) throw new Error('win_act accepted a call with no target')

console.log('tools:', reg.map((t) => t.name).join(', '))
console.log('status.ok =', st.ok)
console.log('plugin load test OK')
