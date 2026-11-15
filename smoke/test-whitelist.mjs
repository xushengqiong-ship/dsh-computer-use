/**
 * 动作白名单测试：工具层只接受公开动作名，helper 内部名不能穿透。
 * 不触发任何真实窗口操作。
 */
import { shutdown } from '../lib/helper-client.mjs'

let failed = false
try {
  const mod = await import('../lib/index.mjs')
  const reg = []
  mod.apply({ tools: { register: (t) => reg.push(t) }, logger: {}, inject: () => {} })
  const act = reg.find((t) => t.name === 'computer_act')

  const cases = [
    { args: { pid: 1, action: 'settext', index: 0, text: 'x' }, label: '内部名 settext' },
    { args: { pid: 1, action: 'set-text', index: 0 }, label: 'set-text 缺 text' },
    { args: { pid: 1, action: 'dance' }, label: '未知动作' },
    { args: { pid: 1, action: '' }, label: '空动作' },
    { args: { action: 'invoke', index: 0 }, label: '无目标' },
    { args: { pid: 1, action: 'drag', x: 1, y: 2 }, label: 'drag 缺终点' },
    { args: { pid: 1, action: 'click' }, label: 'click 缺坐标' },
  ]

  for (const c of cases) {
    const r = await act.execute(c.args)
    const ok = r.ok === false
    console.log(`${ok ? '✓' : '✗'} ${c.label} → ${ok ? '拒绝' : '未拒绝'}`)
    if (!ok) failed = true
  }
} catch (error) {
  failed = true
  console.error('FAIL:', error.message)
} finally {
  shutdown()
}
setTimeout(() => process.exit(failed ? 1 : 0), 300)
