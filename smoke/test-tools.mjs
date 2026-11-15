/**
 * 工具层冒烟测试：真实调用 helper（只读动作，不点任何东西）。
 */
const mod = await import('../lib/index.mjs')

const reg = []
const ctx = {
  tools: { register: (t) => reg.push(t) },
  logger: { warn: (m) => console.log('WARN', m), error: (m) => console.log('ERROR', m) },
  inject: () => {},
}

mod.apply(ctx)
console.log('name  =', mod.name)
console.log('tools =', reg.map((t) => t.name).join(', '))

const expected = ['win_list_windows', 'win_inspect', 'win_act', 'win_screenshot', 'win_status']
for (const n of expected) {
  if (!reg.some((t) => t.name === n)) throw new Error(`缺少工具 ${n}`)
}
for (const t of reg) {
  if (!t.description || !t.parameters || !t.output?.render) throw new Error(`${t.name} 结构不完整`)
}
console.log('结构   OK')

const status = reg.find((t) => t.name === 'win_status')
const list = reg.find((t) => t.name === 'win_list_windows')
const inspect = reg.find((t) => t.name === 'win_inspect')
const act = reg.find((t) => t.name === 'win_act')

const st = await status.execute({})
console.log('\n--- status ---\n' + st.message)
if (!st.ok) throw new Error('status 未就绪')

const ls = await list.execute({})
console.log(`\n--- list --- 窗口数=${ls.count}，ok=${ls.ok}`)
if (!ls.ok || ls.count === 0) throw new Error('列窗口失败')

// 挑一个非最小化、有标题的窗口做 inspect
const pick = (ls.windows || []).find((w) => !w.minimized && w.title && w.width > 200)
if (pick) {
  const ins = await inspect.execute({ pid: pick.pid, max: 30 })
  console.log(`\n--- inspect pid=${pick.pid} "${pick.title}" ---`)
  console.log(`ok=${ins.ok} 元素总数=${ins.total} 返回=${(ins.elements || []).length}`)
  const types = {}
  for (const e of ins.elements || []) types[e.type] = (types[e.type] || 0) + 1
  console.log('类型分布:', JSON.stringify(types))
} else {
  console.log('没有合适的窗口做 inspect')
}

// 参数校验：不给目标应被拒绝
const bad = await act.execute({ action: 'invoke', index: 0 })
console.log('\n无目标被拒 =', bad.ok === false, '|', bad.message.split('\n')[0])

// 参数校验：缺 index 应被拒绝
const bad2 = await act.execute({ pid: pick ? pick.pid : 1, action: 'invoke' })
console.log('缺 index 被拒 =', bad2.ok === false, '|', bad2.message.split('\n')[0])

console.log('\n冒烟测试通过')
