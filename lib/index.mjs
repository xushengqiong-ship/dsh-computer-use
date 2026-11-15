/**
 * dsh-computer-use — cross-platform Computer Use for DeepSeek Harness.
 *
 * One tool vocabulary, three providers:
 *   Windows → UI Automation (full: tree, click, no-focus write, occluded capture)
 *   macOS   → System Events via osascript (window list, click, keystrokes)
 *   Linux   → window manager level (list, screenshot, xdotool input)
 *
 * The tool layer is platform-agnostic; see lib/platform.mjs.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loadProvider } from './platform.mjs'

export const name = 'dsh-computer-use'
export const inject = ['tools']

const textOut = () => ({
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: value.message }],
})

async function provider() {
  const p = await loadProvider()
  if (!p) {
    return {
      error:
        `不支持的平台：${process.platform}。\n` +
        '支持 Windows（完整）、macOS（System Events）、Linux（窗口级）。',
    }
  }
  return { p }
}

function shotPath(dir, pid) {
  const target = path.resolve(dir)
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(target, `cu-${pid || 'screen'}-${stamp}.png`)
}

const targetOf = (args) =>
  (Number.isFinite(args.pid) && args.pid > 0) ||
  (typeof args.title === 'string' && args.title.trim() !== '')

// ---------------------------------------------------------------- status

const statusTool = defineTool({
  name: 'computer_status',
  description:
    '检查当前平台上的 Computer Use 是否可用、具备哪些能力（枚举窗口 / 读元素树 / 点击 / 写入 / 截图）。不操作任何窗口。',
  parameters: {},
  output: textOut(),
  execute: async () => {
    const { p, error } = await provider()
    if (error) return { ok: false, message: `❌ ${error}` }

    const s = await p.status()
    const lines = [
      `平台：${p.label}`,
      `就绪：${s.ok ? '✅' : '❌'}`,
      s.detail ? `详情：${s.detail}` : '',
      s.note ? `说明：${s.note}` : '',
    ]
    if (s.capabilities) {
      lines.push('', '能力：')
      for (const [k, v] of Object.entries(s.capabilities)) {
        lines.push(`  ${k}: ${v ? '✓' : '✗'}`)
      }
    }
    return { ok: s.ok, message: lines.filter(Boolean).join('\n') }
  },
})

// ---------------------------------------------------------------- list

const listTool = defineTool({
  name: 'computer_list_windows',
  description:
    '列出当前可见的顶层窗口（pid、标题、尺寸，Windows 上还有类名和前台/最小化状态）。' +
    '要操作某个程序前先跑这个拿到 pid 或标题。',
  parameters: {
    filter: { type: 'string', description: '只看标题包含这个子串的窗口，可选' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, windows: [], message: `❌ ${error}` }

    const r = await p.listWindows({ filter: args.filter })
    if (!r.ok) {
      return { ok: false, windows: [], message: `❌ 枚举窗口失败：${r.error || r.stderr || '未知原因'}` }
    }

    const list = r.windows || []
    const lines = [`可见窗口 ${list.length} 个${r.total ? `（总共 ${r.total}）` : ''}：`, '']
    for (const w of list) {
      const tags = []
      if (w.foreground) tags.push('前台')
      if (w.minimized) tags.push('最小化')
      const size = w.width ? `  ${w.width}x${w.height}` : ''
      lines.push(`· pid=${w.pid}${size}  ${tags.length ? '[' + tags.join(',') + '] ' : ''}${w.title || '(无标题)'}`)
      if (w.class) lines.push(`     class=${w.class}  hwnd=${w.hwnd}`)
    }
    if (r.note) lines.push('', r.note)
    return { ok: true, count: list.length, windows: list, message: lines.join('\n') }
  },
})

// ---------------------------------------------------------------- inspect

const inspectTool = defineTool({
  name: 'computer_inspect',
  description:
    '读取指定窗口的界面元素树（类型、名称、坐标、能否点击/写入）。比截图精确，因为拿到的是结构化控件。' +
    '能力因平台而异：Windows 完整；macOS 只读窗口下一层；Linux 不支持。' +
    '可同时截图（screenshot=true），截图存成 PNG 并返回路径。',
  parameters: {
    pid: { type: 'number', description: '目标窗口 pid（computer_list_windows 拿到的）' },
    title: { type: 'string', description: '目标窗口标题/进程名子串（和 pid 二选一）' },
    max: { type: 'number', description: '最多返回多少个元素，默认 80，最大 400' },
    screenshot: { type: 'boolean', description: '是否同时截图' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, elements: [], message: `❌ ${error}` }
    if (!targetOf(args)) {
      return { ok: false, elements: [], message: '❌ 必须给 pid 或 title。先用 computer_list_windows 看有哪些窗口。' }
    }

    const max = Math.min(400, Math.max(5, Number(args.max) || 80))
    // Ask the provider to capture in the same round trip when it can: one UIA
    // traversal plus one capture beats two separate calls.
    const shotFile = args.screenshot ? shotPath(path.join(process.cwd(), '.dsh-screenshots'), args.pid) : undefined
    const r = await p.inspect({ pid: args.pid, title: args.title, max, out: shotFile })

    if (!r.ok) {
      return {
        ok: false,
        elements: [],
        message: `❌ 读取界面失败：${r.error || r.stderr || '未知原因'}${r.supported === false ? '\n（该平台不支持元素树读取）' : ''}`,
      }
    }

    const els = r.elements || []
    const lines = []
    if (r.window) {
      lines.push(`窗口：${r.window.title || r.window.name || '(未命名)'}`)
      const bits = []
      if (r.window.pid) bits.push(`pid=${r.window.pid}`)
      if (r.window.class) bits.push(`class=${r.window.class}`)
      if (r.window.foreground) bits.push('前台')
      if (bits.length) lines.push('  ' + bits.join(' '))
    }
    lines.push(`元素 ${els.length} 个${r.total ? ` / 共 ${r.total}` : ''}`, '')

    const interactive = els.filter((e) => e.invoke || e.value)
    if (interactive.length) {
      lines.push('可交互：')
      for (const e of interactive) {
        const caps = []
        if (e.invoke) caps.push('可点击')
        if (e.value) caps.push('可写入')
        lines.push(`  #${e.index} ${e.type} "${e.name}" [${caps.join('/')}]`)
      }
      lines.push('')
    }
    const named = els.filter((e) => !e.invoke && !e.value && e.name).slice(0, 20)
    if (named.length) {
      lines.push('其它元素（前 20）：')
      for (const e of named) lines.push(`  #${e.index} ${e.type} "${e.name}"`)
    }
    if (r.note) lines.push('', r.note)

    let shot = null
    if (r.screenshot && r.screenshot.path) {
      // Provider captured it in the same round trip.
      shot = r.screenshot
      lines.push('', `截图：${shot.path}${shot.mode ? `（${shot.mode}）` : ''} — 用 read_image 看`)
    } else if (args.screenshot) {
      // Provider did not support combined capture (macOS/Linux): ask separately.
      const s = await p.screenshot({ pid: args.pid, title: args.title, out: shotFile })
      if (s.ok) {
        shot = s
        lines.push('', `截图：${s.path}${s.mode ? `（${s.mode}）` : ''} — 用 read_image 看`)
      } else {
        lines.push('', `截图失败：${s.error || s.stderr || '未知原因'}`)
      }
    }

    return { ok: true, window: r.window, total: r.total, elements: els, screenshot: shot, message: lines.join('\n') }
  },
})

// ---------------------------------------------------------------- act

const actTool = defineTool({
  name: 'computer_act',
  description:
    '对窗口执行动作：invoke=点击元素（不抢焦点，Windows/macOS）；' +
    'set-text=写入文本（Windows 用 UIA 或 WM_SETTEXT 不抢焦点；macOS/Linux 走键盘输入）；' +
    'click=坐标点击；drag=从 (x,y) 拖到 (x2,y2)（Windows）。强烈建议带 expectName 做安全校验。',
  parameters: {
    pid: { type: 'number', description: '目标窗口 pid' },
    title: { type: 'string', description: '目标窗口标题/进程名（和 pid 二选一）' },
    action: { type: 'string', description: 'invoke | set-text | click | drag' },
    index: { type: 'number', description: '元素序号（computer_inspect 的 #index），invoke 需要' },
    text: { type: 'string', description: 'action=set-text 时写入的文字' },
    expectName: { type: 'string', description: '安全校验：元素名必须完全匹配，否则拒绝执行' },
    x: { type: 'number', description: 'action=click/drag 的 x 坐标' },
    y: { type: 'number', description: 'action=click/drag 的 y 坐标' },
    x2: { type: 'number', description: 'action=drag 的终点 x 坐标' },
    y2: { type: 'number', description: 'action=drag 的终点 y 坐标' },
    hwnd: { type: 'string', description: 'Linux 下的窗口 id（wmctrl 输出的第一列），可选' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, message: `❌ ${error}` }

    const action = String(args.action || '').toLowerCase()
    if (!targetOf(args) && !args.hwnd) {
      return { ok: false, message: '❌ 必须给 pid、title 或 hwnd。' }
    }
    if (action === 'invoke' && !Number.isFinite(args.index)) {
      return { ok: false, message: '❌ invoke 需要 index（先用 computer_inspect 看元素序号）。' }
    }
    if (action === 'set-text' && typeof args.text !== 'string') {
      return { ok: false, message: '❌ set-text 需要 text。' }
    }
    if (action === 'click' && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) {
      return { ok: false, message: '❌ click 需要 x 和 y。' }
    }
    if (action === 'drag' && !['x', 'y', 'x2', 'y2'].every((k) => Number.isFinite(args[k]))) {
      return { ok: false, message: '❌ drag 需要 x、y（起点）和 x2、y2（终点）。' }
    }

    const r = await p.act({
      action,
      pid: args.pid,
      title: args.title,
      index: args.index,
      text: args.text,
      expectName: args.expectName,
      x: args.x,
      y: args.y,
      x2: args.x2,
      y2: args.y2,
      hwnd: args.hwnd,
    })

    if (!r.ok) {
      return { ok: false, result: r, message: `❌ 动作失败：${r.error || r.stderr || '未知原因'}` }
    }

    let msg = '✅ 完成'
    if (action === 'invoke') msg = `✅ 已点击 #${r.index ?? args.index}「${r.name ?? args.expectName ?? ''}」（${r.method}）`
    else if (action === 'set-text') msg = `✅ 已写入：「${r.written ?? args.text}」（${r.method}）`
    else if (action === 'click') msg = `✅ 已在 (${r.x ?? args.x}, ${r.y ?? args.y}) 点击（${r.method}）`
    else if (action === 'drag') msg = `✅ 已从 (${args.x}, ${args.y}) 拖到 (${args.x2}, ${args.y2})（${r.method}，${r.steps ?? ''} 步）`

    return { ok: true, result: r, message: msg }
  },
})

// ---------------------------------------------------------------- screenshot

const shotTool = defineTool({
  name: 'computer_screenshot',
  description:
    '截取窗口（或整屏）为 PNG 并返回路径。Windows 用 PrintWindow，窗口被遮挡也能截准。' +
    '拿到路径后用 read_image 看内容。',
  parameters: {
    pid: { type: 'number', description: '目标窗口 pid；不给则截整屏' },
    title: { type: 'string', description: '目标窗口标题/进程名' },
    path: { type: 'string', description: '保存路径，可选；默认存到工作区 .dsh-screenshots/' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, path: null, message: `❌ ${error}` }

    const out = args.path
      ? path.resolve(String(args.path))
      : shotPath(path.join(process.cwd(), '.dsh-screenshots'), args.pid)

    const r = await p.screenshot({ pid: args.pid, title: args.title, out })
    if (!r.ok) {
      return { ok: false, path: null, message: `❌ 截图失败：${r.error || r.stderr || '未知原因'}` }
    }
    const size = r.width ? `\n  ${r.width}x${r.height}` : ''
    return {
      ok: true,
      path: r.path,
      width: r.width,
      height: r.height,
      mode: r.mode,
      message: `✅ 已截图：${r.path}${size}${r.mode ? `，方式 ${r.mode}` : ''}\n  用 read_image 看这张图。`,
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
    ctx.logger?.warn?.(`[dsh-computer-use] 工具 ${tool.name} 注册失败：${(error && error.message) || error}`)
  }
  try {
    ctx.inject(['tools'], () => {
      try {
        attempt()
      } catch (error) {
        if (!/duplicate/i.test(String((error && error.message) || error))) {
          ctx.logger?.error?.(`[dsh-computer-use] 工具 ${tool.name} 注册仍然失败：${(error && error.message) || error}`)
        }
      }
    })
  } catch {}
}

export function apply(ctx) {
  for (const tool of [statusTool, listTool, inspectTool, actTool, shotTool]) registerTool(ctx, tool)
}
