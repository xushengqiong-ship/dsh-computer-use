/**
 * dsh-computer-use-win — tools.
 *
 * Windows-native counterpart to dsh-computer-use (macOS): read the UI
 * Automation tree of any app, click by element index, write text without
 * stealing focus, and capture a window even when it is occluded.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import path from 'node:path'
import { runHelper, screenshotPath, helperExists, powershellExists, HELPER } from './run.mjs'

export const name = 'dsh-computer-use-win'
export const inject = ['tools']

const IS_WIN = process.platform === 'win32'

const textOut = () => ({
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: value.message }],
})

const notWin = () => ({
  ok: false,
  message: `这个插件只能在 Windows 上工作，当前平台是 ${process.platform}。`,
})

const targetOf = (args) => {
  const hasPid = Number.isFinite(args.pid) && args.pid > 0
  const hasTitle = typeof args.title === 'string' && args.title.trim() !== ''
  return hasPid || hasTitle
}

// ---------------------------------------------------------------- list

const listTool = defineTool({
  name: 'win_list_windows',
  description:
    '列出 Windows 上当前可见的顶层窗口：pid、窗口标题、窗口类名、尺寸、是否在前台、是否最小化。' +
    '要操作某个程序前先跑这个拿到它的 pid 或标题。',
  parameters: {
    filter: { type: 'string', description: '只看标题包含这个子串的窗口，可选' },
  },
  output: textOut(),
  execute: async (args) => {
    if (!IS_WIN) return notWin()
    const r = await runHelper({ action: 'list', timeoutSec: 40 })
    if (!r.ok) {
      return { ok: false, windows: [], message: `❌ 枚举窗口失败：${r.error}${r.stderr ? '\n' + r.stderr : ''}` }
    }
    let list = r.windows || []
    if (args.filter) {
      const f = String(args.filter).toLowerCase()
      list = list.filter((w) => String(w.title || '').toLowerCase().includes(f))
    }
    const lines = [`可见窗口 ${list.length} 个（总共 ${r.count}）：`, '']
    for (const w of list) {
      const tags = []
      if (w.foreground) tags.push('前台')
      if (w.minimized) tags.push('最小化')
      lines.push(`· pid=${w.pid}  ${w.width}x${w.height}  ${tags.length ? '[' + tags.join(',') + '] ' : ''}${w.title || '(无标题)'}`)
      lines.push(`     class=${w.class}  hwnd=${w.hwnd}`)
    }
    return { ok: true, count: list.length, windows: list, message: lines.join('\n') }
  },
})

// ---------------------------------------------------------------- inspect

const inspectTool = defineTool({
  name: 'win_inspect',
  description:
    '读取指定窗口的 UI Automation 元素树：每个元素的类型、名称、类名、屏幕坐标、是否可点击(invoke)、是否可写入(value)。' +
    '这是"看见界面"的手段——比截图精确，因为拿到的是结构化控件而不是像素。' +
    '可同时请求截图（screenshot=true），截图会存成 PNG 并返回路径。',
  parameters: {
    pid: { type: 'number', description: '目标窗口的进程 id（win_list_windows 拿到的 pid）' },
    title: { type: 'string', description: '目标窗口标题的子串（和 pid 二选一）' },
    max: { type: 'number', description: '最多返回多少个元素，默认 80，最大 400' },
    screenshot: { type: 'boolean', description: '是否同时截图（图片会保存到工作区）' },
  },
  output: textOut(),
  execute: async (args) => {
    if (!IS_WIN) return notWin()
    if (!targetOf(args)) {
      return { ok: false, elements: [], message: '❌ 必须给 pid 或 title 之一。先用 win_list_windows 看有哪些窗口。' }
    }
    const max = Math.min(400, Math.max(5, Number(args.max) || 80))
    const r = await runHelper({ action: 'observe', targetPid: args.pid, title: args.title, max, timeoutSec: 90 })
    if (!r.ok) {
      return { ok: false, elements: [], message: `❌ 读取界面失败：${r.error}${r.stderr ? '\n' + r.stderr : ''}` }
    }

    const els = r.elements || []
    const w = r.window || {}
    const lines = [
      `窗口：${w.title || '(无标题)'}`,
      `  pid=${w.pid} class=${w.class} 尺寸 ${w.rect?.width}x${w.rect?.height}${w.foreground ? '  [前台]' : ''}`,
      `  元素总数 ${r.total}，本次返回 ${els.length}`,
      '',
    ]
    const interesting = els.filter((e) => e.invoke || e.value)
    if (interesting.length) {
      lines.push('可交互元素：')
      for (const e of interesting) {
        const caps = []
        if (e.invoke) caps.push('可点击')
        if (e.value) caps.push('可写入')
        lines.push(`  #${e.index} ${e.type} "${e.name}" [${caps.join('/')}]`)
      }
      lines.push('')
    }
    const texts = els.filter((e) => !e.invoke && !e.value && e.name).slice(0, 25)
    if (texts.length) {
      lines.push('文本/结构元素（前 25 个）：')
      for (const e of texts) lines.push(`  #${e.index} ${e.type} "${e.name}"`)
    }

    let shot = null
    if (args.screenshot) {
      const out = screenshotPath(path.join(process.cwd(), '.dsh-screenshots'), args.pid)
      const s = await runHelper({ action: 'screenshot', targetPid: args.pid, title: args.title, out, timeoutSec: 60 })
      if (s.ok) {
        shot = s
        lines.push('', `截图：${s.path}（${s.mode}）——用 read_image 看它`)
      } else {
        lines.push('', `截图失败：${s.error}`)
      }
    }

    return {
      ok: true,
      window: w,
      total: r.total,
      elements: els,
      screenshot: shot,
      message: lines.join('\n'),
    }
  },
})

// ---------------------------------------------------------------- act

const actTool = defineTool({
  name: 'win_act',
  description:
    '对窗口里的元素执行动作。invoke=点击（UI Automation，不抢焦点）；' +
    'set-text=写入文本（优先 UIA ValuePattern，旧控件回退 WM_SETTEXT，同样不抢焦点）；' +
    'click=在窗口内坐标处点击（UIA 点不动时的兜底）。' +
    '强烈建议带 expectName：元素名对不上就拒绝执行，避免点错东西。',
  parameters: {
    pid: { type: 'number', description: '目标窗口进程 id' },
    title: { type: 'string', description: '目标窗口标题子串（和 pid 二选一）' },
    action: { type: 'string', description: 'invoke | set-text | click 之一' },
    index: { type: 'number', description: '元素序号（win_inspect 返回的 #index），invoke/set-text 必填' },
    text: { type: 'string', description: 'action=set-text 时要写入的文字' },
    expectName: { type: 'string', description: '安全校验：元素名必须完全等于它，否则拒绝执行' },
    x: { type: 'number', description: 'action=click 时的窗口内 x 坐标' },
    y: { type: 'number', description: 'action=click 时的窗口内 y 坐标' },
  },
  output: textOut(),
  execute: async (args) => {
    if (!IS_WIN) return notWin()
    if (!targetOf(args)) {
      return { ok: false, message: '❌ 必须给 pid 或 title 之一。' }
    }
    const action = String(args.action || '').toLowerCase()

    if (action === 'invoke' || action === 'set-text') {
      if (!Number.isFinite(args.index) || args.index < 0) {
        return { ok: false, message: '❌ 这个动作需要 index（先用 win_inspect 看元素序号）。' }
      }
      if (action === 'set-text' && typeof args.text !== 'string') {
        return { ok: false, message: '❌ set-text 需要 text 参数。' }
      }
    }
    if (action === 'click' && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) {
      return { ok: false, message: '❌ click 需要 x 和 y（窗口内坐标）。' }
    }

    const helperAction = action === 'set-text' ? 'settext' : action
    const r = await runHelper({
      action: helperAction,
      targetPid: args.pid,
      title: args.title,
      index: args.index,
      text: args.text,
      expectName: args.expectName,
      x: args.x,
      y: args.y,
      timeoutSec: 60,
    })

    if (!r.ok) {
      return { ok: false, result: r, message: `❌ 动作失败：${r.error}${r.stderr ? '\n' + r.stderr : ''}` }
    }

    let msg
    if (action === 'invoke') msg = `✅ 已点击 #${r.index}「${r.name}」（${r.method}）`
    else if (action === 'set-text') msg = `✅ 已写入 #${r.index}（${r.method}）：${r.written}`
    else msg = `✅ 已在 (${r.x}, ${r.y}) 点击（${r.method}）`

    return { ok: true, result: r, message: msg }
  },
})

// ---------------------------------------------------------------- screenshot

const shotTool = defineTool({
  name: 'win_screenshot',
  description:
    '截取指定窗口（或整屏）为 PNG，返回文件路径。用 PrintWindow 渲染，窗口被遮挡也能截准。' +
    '拿到路径后可以用 read_image 直接看内容。',
  parameters: {
    pid: { type: 'number', description: '目标窗口进程 id；不给则截整个屏幕' },
    title: { type: 'string', description: '目标窗口标题子串' },
    path: { type: 'string', description: '保存路径，可选；默认存到工作区 .dsh-screenshots/' },
  },
  output: textOut(),
  execute: async (args) => {
    if (!IS_WIN) return notWin()
    const out = args.path
      ? path.resolve(String(args.path))
      : screenshotPath(path.join(process.cwd(), '.dsh-screenshots'), args.pid)
    const r = await runHelper({
      action: 'screenshot',
      targetPid: args.pid,
      title: args.title,
      out,
      timeoutSec: 60,
    })
    if (!r.ok) {
      return { ok: false, path: null, message: `❌ 截图失败：${r.error}${r.stderr ? '\n' + r.stderr : ''}` }
    }
    return {
      ok: true,
      path: r.path,
      width: r.width,
      height: r.height,
      mode: r.mode,
      message: `✅ 已截图：${r.path}\n  ${r.width}x${r.height}，方式 ${r.mode}\n  用 read_image 看这张图。`,
    }
  },
})

// ---------------------------------------------------------------- status

const statusTool = defineTool({
  name: 'win_status',
  description: '检查 Windows Computer Use 是否就绪：平台、PowerShell、helper 脚本。不操作任何窗口。',
  parameters: {},
  output: textOut(),
  execute: () => {
    const lines = []
    const okPlatform = IS_WIN
    lines.push(`平台：${process.platform}${okPlatform ? ' ✅' : ' ❌ 只支持 Windows'}`)
    const okPs = powershellExists()
    lines.push(`PowerShell：${okPs ? '✅' : '❌ 找不到 C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'}`)
    const okHelper = helperExists()
    lines.push(`helper：${okHelper ? '✅' : '❌ 缺文件'} ${HELPER}`)
    lines.push('')
    lines.push('能力：枚举窗口 / 读 UIA 元素树 / 按元素点击 / 无焦点写入 / 遮挡窗口截图')
    return {
      ok: okPlatform && okPs && okHelper,
      message: lines.join('\n'),
    }
  },
})

function registerTool(ctx, tool) {
  const attempt = () => ctx.tools.register(tool)
  try {
    attempt()
    return
  } catch (error) {
    if (/duplicate/i.test(String((error && error.message) || error))) return
    ctx.logger?.warn?.(`[dsh-computer-use-win] 工具 ${tool.name} 注册失败：${(error && error.message) || error}`)
  }
  try {
    ctx.inject(['tools'], () => {
      try {
        attempt()
      } catch (error) {
        if (!/duplicate/i.test(String((error && error.message) || error))) {
          ctx.logger?.error?.(`[dsh-computer-use-win] 工具 ${tool.name} 注册仍然失败：${(error && error.message) || error}`)
        }
      }
    })
  } catch {}
}

export function apply(ctx) {
  for (const tool of [listTool, inspectTool, actTool, shotTool, statusTool]) registerTool(ctx, tool)
}
