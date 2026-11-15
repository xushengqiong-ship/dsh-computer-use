/**
 * 错误路径测试：坏输入必须快速、明确地失败，而不是挂住或假装成功。
 * 需要 Windows helper（会启动常驻进程），所以只在 Windows 上跑完整断言。
 */
import { shutdown } from '../lib/helper-client.mjs'

let failed = false
const check = (label, ok, extra) => {
  console.log(`${ok ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!ok) failed = true
}

try {
  const m = await import('../lib/providers/win.mjs')

  // 不存在的 pid：必须失败，不是返回空列表
  const ghost = await m.inspect({ pid: 999999, max: 5 })
  check('不存在的 pid 被拒绝', ghost.ok === false, String(ghost.error || '').slice(0, 50))

  // 不存在的 hwnd
  const badHwnd = await m.inspect({ hwnd: '1', max: 5 })
  check('无效 hwnd 被拒绝', badHwnd.ok === false, String(badHwnd.error || '').slice(0, 50))

  // 非法 hwnd 字符串
  const junkHwnd = await m.inspect({ hwnd: 'not-a-handle', max: 5 })
  check('非数字 hwnd 被拒绝', junkHwnd.ok === false, String(junkHwnd.error || '').slice(0, 50))

  // 越界 index：必须失败，不能默默操作别的元素
  const list = await m.listWindows({})
  const target = (list.windows || []).find((w) => w.title && !w.minimized)
  if (target) {
    const oob = await m.act({ pid: target.pid, action: 'invoke', index: 99999 })
    check('越界 index 被拒绝', oob.ok === false, String(oob.error || '').slice(0, 50))
  } else {
    console.log('- 跳过越界 index 测试（没有合适窗口）')
  }

  // 未知动作：provider 层应报错
  const weird = await m.act({ pid: 1, action: 'explode' })
  check('未知动作被拒绝', weird.ok === false, String(weird.error || '').slice(0, 50))

  // 截图无 out
  const noOut = await m.screenshot({ pid: target?.pid })
  check('截图缺 out 被拒绝', noOut.ok === false, String(noOut.error || '').slice(0, 50))
} catch (error) {
  failed = true
  console.error('FAIL:', error.message)
} finally {
  shutdown()
}
setTimeout(() => process.exit(failed ? 1 : 0), 300)
