/**
 * 真实调用测试（仅 Windows / macOS / Linux 上跑当前平台 provider）。
 * 只做只读动作：status / list / inspect。
 */
const mod = await import('../lib/index.mjs')

const reg = []
mod.apply({ tools: { register: (t) => reg.push(t) }, logger: {}, inject: () => {} })
const get = (n) => reg.find((t) => t.name === n)

const st = await get('computer_status').execute({})
console.log('--- status ---\n' + st.message)
if (!st.ok) { console.log('status 未就绪，后续跳过'); process.exit(0) }

const ls = await get('computer_list_windows').execute({})
console.log(`\n--- list --- ok=${ls.ok} count=${ls.count}`)
if (!ls.ok) process.exit(1)

const pick = (ls.windows || []).find((w) => w.title && !w.minimized && (!w.width || w.width > 200))
if (pick) {
  const ins = await get('computer_inspect').execute({ pid: pick.pid, title: pick.title, max: 40 })
  console.log(`\n--- inspect "${pick.title}" ---`)
  console.log(`ok=${ins.ok} elements=${(ins.elements || []).length}/${ins.total}`)
  const types = {}
  for (const e of ins.elements || []) types[e.type] = (types[e.type] || 0) + 1
  console.log('types:', JSON.stringify(types))
}

console.log('\nlive test OK')
