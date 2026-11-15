/**
 * 真实调用测试（只在当前平台跑），仅只读动作：status / list / inspect。
 * 必须在 finally 里 shutdown，否则常驻 helper 会挂住 Node 进程。
 */
import { shutdown } from '../lib/helper-client.mjs'

let failed = false
try {
  const mod = await import('../lib/index.mjs')
  const reg = []
  mod.apply({ tools: { register: (t) => reg.push(t) }, logger: {}, inject: () => {} })
  const get = (n) => reg.find((t) => t.name === n)

  const st = await get('computer_status').execute({})
  console.log('--- status ---\n' + st.message)
  if (!st.ok) {
    console.log('status 未就绪，跳过后续')
  } else {
    const ls = await get('computer_list_windows').execute({})
    console.log(`\n--- list --- ok=${ls.ok} count=${ls.count}`)
    if (!ls.ok) throw new Error('list failed')

    const pick = (ls.windows || []).find((w) => w.title && !w.minimized && (!w.width || w.width > 200))
    if (pick) {
      const ins = await get('computer_inspect').execute({ pid: pick.pid, title: pick.title, max: 40 })
      console.log(`\n--- inspect "${pick.title}" ---`)
      console.log(`ok=${ins.ok} elements=${(ins.elements || []).length}/${ins.total}`)
      const types = {}
      for (const e of ins.elements || []) types[e.type] = (types[e.type] || 0) + 1
      console.log('types:', JSON.stringify(types))
    }
  }
  console.log('\nlive test OK')
} catch (error) {
  failed = true
  console.error('FAIL:', error.message)
} finally {
  shutdown()
}

setTimeout(() => process.exit(failed ? 1 : 0), 300)
