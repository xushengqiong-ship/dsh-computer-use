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
import { readFileSync } from 'node:fs'
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

// Tool output is a list of content blocks. Emitting the capture as an image
// block lets the model SEE it in the same round trip, instead of receiving a
// path and making a separate read_image call.
const IMAGE_MAX_BYTES = 400 * 1024

function loadImageForModel(path) {
  if (!path) return null
  try {
    const buf = readFileSync(path)
    if (buf.length === 0 || buf.length > IMAGE_MAX_BYTES) return null
    const lower = String(path).toLowerCase()
    const mediaType = lower.endsWith('.png')
      ? 'image/png'
      : (lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png')
    return { mediaType, data: buf.toString('base64') }
  } catch {
    return null
  }
}

const imageOut = () => ({
  schema: { type: 'json' },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: String(value?.message ?? '') }]
    if (value?.image?.data) {
      blocks.push({ type: 'image', mediaType: value.image.mediaType, data: value.image.data })
    }
    return blocks
  },
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
  (typeof args.title === 'string' && args.title.trim() !== '') ||
  (typeof args.hwnd === 'string' && args.hwnd.trim() !== '')

// ---------------------------------------------------------------- status

// ---------------------------------------------------------------- watch

const watchTool = defineTool({
  name: 'computer_watch',
  description:
    '等待屏幕上的变化并报告：窗口打开/关闭、你按下的键。默认轮询 50ms（稳定、不注册全局钩子），超时返回空列表。' +
    '用它代替「盲等几秒」——比如点完按钮等对话框弹出、等某个应用关掉、等用户按下快捷键。' +
    '不做像素级变化检测（那需要持续截图，代价太高）。',
  parameters: {
    timeoutMs: { type: 'number', description: '最多等多久，默认 10000，最大 120000' },
    windows: { type: 'boolean', description: '是否监听窗口打开/关闭，默认 true' },
    keys: { type: 'boolean', description: '是否监听按键，默认 true' },
    until: { type: 'string', description: '只等某类事件：any | window-open | window-close | key-down，默认 any' },
    intervalMs: { type: 'number', description: '轮询间隔，默认 50ms' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, events: [], message: `❌ ${error}` }
    if (!p.watch) return { ok: false, events: [], message: '❌ 当前平台不支持变化监听（只有 Windows provider 有）。' }

    const until = String(args.until || 'any').toLowerCase()
    const allowed = ['any', 'window-open', 'window-close', 'key-down']
    if (!allowed.includes(until)) {
      return { ok: false, events: [], message: `❌ until 只能是：${allowed.join(' / ')}` }
    }
    if (args.windows === false && args.keys === false) {
      return { ok: false, events: [], message: '❌ windows 和 keys 不能同时为 false，否则永远不会有事件。' }
    }

    const r = await p.watch({
      timeoutMs: args.timeoutMs,
      intervalMs: args.intervalMs,
      windows: args.windows,
      keys: args.keys,
      until,
    })
    if (!r.ok) return { ok: false, events: [], message: `❌ 监听失败：${r.error || '未知原因'}` }
    if (r.timedOut) {
      return { ok: true, events: [], timedOut: true, message: `⏱️ 等了 ${r.elapsedMs}ms，没有等到${until === 'any' ? '任何变化' : until}` }
    }

    const lines = [`检测到 ${r.events.length} 个变化（${r.elapsedMs}ms）：`]
    for (const e of r.events.slice(0, 20)) {
      if (e.type === 'window-open') lines.push(`  ➕ 窗口打开：${e.title}（pid=${e.pid} hwnd=${e.hwnd}）`)
      else if (e.type === 'window-close') lines.push(`  ➖ 窗口关闭：${e.title}（pid=${e.pid}）`)
      else if (e.type === 'key-down') lines.push(`  ⌨️ 按键：${(e.keys || []).join(' + ')}`)
      else lines.push(`  ${e.type}`)
    }
    return { ok: true, events: r.events, message: lines.join('\n') }
  },
})
// ---------------------------------------------------------------- clipboard

const clipboardTool = defineTool({
  name: 'computer_clipboard',
  description:
    '读写系统剪贴板（纯文本）。读：拿到当前复制的文字；写：把文字放进剪贴板，之后可用 computer_input 的 ctrl+v 粘贴。' +
    '跨应用搬运数据比逐字打字快得多，也比读元素树更准。',
  parameters: {
    action: { type: 'string', description: 'get | set' },
    text: { type: 'string', description: 'set 时要写入的文本' },
  },
  output: textOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, message: `❌ ${error}` }
    const action = String(args.action || 'get').toLowerCase()
    if (!['get', 'set'].includes(action)) {
      return { ok: false, message: `❌ 不认识的 action：${action}，可用：get / set` }
    }
    if (action === 'set') {
      if (typeof args.text !== 'string') return { ok: false, message: '❌ set 需要 text。' }
      if (!p.writeClipboard) return { ok: false, message: '❌ 当前平台不支持写剪贴板。' }
      const w = await p.writeClipboard(args.text)
      if (!w.ok) return { ok: false, result: w, message: `❌ 写入剪贴板失败：${w.error || '未知原因'}` }
      return { ok: true, result: w, message: `✅ 已写入剪贴板（${w.written} 字）` }
    }
    if (!p.readClipboard) return { ok: false, message: '❌ 当前平台不支持读剪贴板。' }
    const r = await p.readClipboard()
    if (!r.ok) return { ok: false, result: r, message: `❌ 读取剪贴板失败：${r.error || '未知原因'}` }
    if (!r.text) return { ok: true, text: '', message: '📋 剪贴板是空的（或不是纯文本）' }
    return { ok: true, text: r.text, length: r.length, message: `📋 剪贴板（${r.length} 字）：\n${String(r.text).slice(0, 4000)}` }
  },
})
// ---------------------------------------------------------------- input

const inputTool = defineTool({
  name: 'computer_input',
  description:
    '【前台输入】用真实键鼠事件操作电脑：move 移光标 · click/double-click/right-click/middle-click 点击 · drag 拖拽 · scroll 滚轮 · press 按键（支持 "ctrl+s"）· type 打字 · wait 等待。' +
    '坐标是**屏幕绝对坐标**。这是唯一能操作 canvas、游戏、任何界面的通道——' +
    '代价是会移动你的鼠标、键盘输入需要目标窗口在前台。' +
    '只想后台操作某个窗口时，用 computer_act（不动光标）。',
  parameters: {
    action: { type: 'string', description: 'move | click | double-click | right-click | middle-click | drag | scroll | press | type | wait' },
    x: { type: 'number', description: '屏幕 X 坐标（move/click/drag/scroll 的起点）' },
    y: { type: 'number', description: '屏幕 Y 坐标' },
    x2: { type: 'number', description: 'drag 的终点 X' },
    y2: { type: 'number', description: 'drag 的终点 Y' },
    key: { type: 'string', description: 'press 的键名：enter/tab/esc/up/down/left/right/f1..f12，组合键写 "ctrl+s"' },
    text: { type: 'string', description: 'type 要输入的文本（支持中文）' },
    amount: { type: 'number', description: 'scroll 的滚动量，正数向上、负数向下，默认 -120' },
    ms: { type: 'number', description: 'wait 的等待毫秒数（最多 60000）；配合 pid/title 则等到窗口出现为止' },
  },
  output: textOut(),
  execute: async (args) => {
    const action = String(args.action || '').toLowerCase()
    const ALLOWED = [
      'move', 'hover', 'click', 'double-click', 'right-click', 'middle-click',
      'drag', 'scroll', 'press', 'type', 'wait',
    ]
    if (!ALLOWED.includes(action)) {
      return { ok: false, message: `❌ 不认识的 action：${args.action || '(空)'}，可用：${ALLOWED.join(' / ')}` }
    }

    // wait is pure waiting: no provider needed, works on every platform.
    if (action === 'wait') {
      const ms = Math.max(0, Math.min(60000, Number(args.ms ?? (args.timeoutMs ?? 1000))))
      const until = Date.now() + ms
      // Optional: wait FOR a window (pid or title) instead of a fixed delay.
      if (args.pid || args.title) {
        const { p: wp, error: we } = await provider()
        if (we) return { ok: false, message: `❌ ${we}` }
        while (Date.now() < until) {
          const ls = await wp.listWindows({ filter: args.title })
          const hit = (ls.windows || []).find((w) =>
            (args.pid ? w.pid === args.pid : true) && (args.title ? String(w.title || '').includes(args.title) : true))
          if (hit) {
            return { ok: true, result: hit, message: `✅ 窗口已出现：pid=${hit.pid}「${String(hit.title).slice(0, 40)}」` }
          }
          await new Promise((r) => setTimeout(r, 250))
        }
        return { ok: false, message: `❌ 等待 ${ms}ms 后仍未出现目标窗口` }
      }
      await new Promise((r) => setTimeout(r, ms))
      return { ok: true, message: `✅ 等待 ${ms}ms` }
    }

    const { p, error } = await provider()
    if (error) return { ok: false, message: `❌ ${error}` }
    if (!p.input) {
      return { ok: false, message: '❌ 当前平台的 provider 不支持前台输入（只有 Windows provider 有）。' }
    }
    const needsPoint = ['move', 'hover', 'click', 'double-click', 'right-click', 'middle-click', 'drag', 'scroll']
    if (needsPoint.includes(action) && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) {
      return { ok: false, message: `❌ ${action} 需要屏幕坐标 x 和 y。` }
    }
    if (action === 'drag' && (!Number.isFinite(args.x2) || !Number.isFinite(args.y2))) {
      return { ok: false, message: '❌ drag 需要 x2 和 y2（终点坐标）。' }
    }
    if (action === 'press' && !String(args.key || '').trim()) {
      return { ok: false, message: '❌ press 需要 key（如 "enter" 或 "ctrl+s"）。' }
    }
    if (action === 'type' && typeof args.text !== 'string') {
      return { ok: false, message: '❌ type 需要 text。' }
    }

    const r = await p.input({
      inputAction: action,
      x: args.x,
      y: args.y,
      x2: args.x2,
      y2: args.y2,
      key: args.key,
      text: args.text,
      amount: args.amount,
    })

    if (!r.ok) {
      return { ok: false, result: r, message: `❌ 输入失败：${r.error || r.stderr || '未知原因'}` }
    }

    const state = r.state || 'sent-unverified'
    let what = action
    if (action === 'press') what = `按键 ${(r.keys || []).join('+')}`
    if (action === 'type') what = `输入 ${r.chars} 个字符`
    if (action === 'scroll') what = `滚动 ${r.amount}`
    const where = Number.isFinite(r.x) ? ` @(${r.x},${r.y})` : ''
    return { ok: true, result: r, message: `✅ ${what}${where}（sendinput，${state}）` }
  },
})

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
        const mark = typeof v === 'string' ? v : (v ? '✓' : '✗')
        lines.push(`  ${k}: ${mark}`)
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
    hwnd: { type: 'string', description: '精确窗口句柄（推荐：同进程多窗口时用它消歧）' },
    title: { type: 'string', description: '目标窗口标题/进程名子串（和 pid 二选一）' },
    max: { type: 'number', description: '最多返回多少个元素，默认 80，最大 400' },
    screenshot: { type: 'boolean', description: '是否同时截图' },
    waitFor: { type: 'string', description: '等待名称包含这段文字（或类型等于它）的元素出现，找到再返回' },
    timeoutMs: { type: 'number', description: 'waitFor 的超时毫秒，默认 5000，最大 60000' },
  },
  output: imageOut(),
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
    const readOnce = () => p.inspect({ pid: args.pid, hwnd: args.hwnd, title: args.title, max })
    // With waitFor we poll without capturing; the screenshot is taken once the
    // element actually shows up (capturing on every poll would be wasteful).
    let r = await readOnce()

    if (args.waitFor) {
      const want = String(args.waitFor)
      const hit = (list) =>
        (list || []).some((e) => String(e.name || '').includes(want) || String(e.type || '') === want)
      const budget = Math.min(60000, Math.max(200, Number(args.timeoutMs) || 5000))
      const deadline = Date.now() + budget
      while (!hit(r.elements) && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 250))
        r = await readOnce()
        if (!r.ok) break
      }
      if (!r.ok) {
        return { ok: false, elements: [], message: `❌ 读取界面失败：${r.error || '未知原因'}` }
      }
      if (!hit(r.elements)) {
        return {
          ok: false,
          elements: [],
          message: `❌ 等了 ${budget}ms 仍未出现含「${want}」的元素（当前 ${(r.elements || []).length} 个）`,
        }
      }
      if (args.screenshot) r = await readOnce()
    }

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
        const preview = e.textValue ? ` — 「${String(e.textValue).replace(/\s+/g, ' ').slice(0, 80)}」` : ''
        lines.push(`  #${e.index} ${e.type} "${e.name}" [${caps.join('/')}]${preview}`)
      }
      lines.push('')
    }
    const named = els.filter((e) => !e.invoke && !e.value && e.name).slice(0, 20)
    if (named.length) {
      lines.push('其它元素（前 20）：')
      for (const e of named) {
        const preview = e.textValue ? ` — 「${String(e.textValue).replace(/\s+/g, ' ').slice(0, 80)}」` : ''
        lines.push(`  #${e.index} ${e.type} "${e.name}"${preview}`)
      }
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

    // Ship the capture as an image block too, so inspect+screenshot is one move.
    const image = shot ? loadImageForModel(shot.thumb || shot.path) : null
    if (image) lines.push('  （图像已随结果返回，直接看即可）')
    return { ok: true, window: r.window, total: r.total, elements: els, screenshot: shot, image, message: lines.join('\n') }
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
    // Accept only the public action names. Helper-internal names ("settext")
    // must not slip through: they would skip the per-action validation below.
    const ALLOWED = ['invoke', 'set-text', 'click', 'drag', 'activate', 'scroll-to']
    if (!ALLOWED.includes(action)) {
      return { ok: false, message: `❌ 不认识的 action：${args.action || '(空)'}，可用：${ALLOWED.join(' / ')}` }
    }
    if (!targetOf(args) && !args.hwnd) {
      return { ok: false, message: '❌ 必须给 pid、title 或 hwnd。' }
    }
    if (action === 'invoke' && !Number.isFinite(args.index)) {
      return { ok: false, message: '❌ invoke 需要 index（先用 computer_inspect 看元素序号）。' }
    }
    if ((action === 'scroll-to') && !Number.isInteger(args.index)) {
      return { ok: false, message: '❌ scroll-to 需要 index（先用 computer_inspect 看元素序号）。' }
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

    const callAct = (index) => p.act({
      action,
      pid: args.pid,
      title: args.title,
      index,
      text: args.text,
      expectName: args.expectName,
      x: args.x,
      y: args.y,
      x2: args.x2,
      y2: args.y2,
      hwnd: args.hwnd,
    })

    let r = await callAct(args.index)

    // UIA elements go stale once the control's content changes; the index we
    // were given may simply no longer exist. With an expectName we can safely
    // re-locate the element by name and retry ONCE — the name check is what
    // makes the retry safe (a stale index could otherwise hit a different control).
    if (!r.ok && !r.channel && args.expectName && Number.isInteger(args.index)) {
      const stale = /stale|not found|out of range|no such element|element.*(gone|invalid)/i.test(String(r.error || ''))
      if (stale) {
        const ins = await p.inspect({ pid: args.pid, hwnd: args.hwnd, title: args.title, max: 400 })
        const reloc = (ins.elements || []).find((e) => e.name === args.expectName
          && (action === 'invoke' ? e.invoke : (action === 'set-text' ? e.value : true)))
        if (reloc && reloc.index !== args.index) {
          const retry = await callAct(reloc.index)
          if (retry.ok) {
            retry.relocated = true
            retry.previousIndex = args.index
            r = retry
          }
        }
      }
    }

    if (!r.ok) {
      return { ok: false, result: r, message: `❌ 动作失败：${r.error || r.stderr || '未知原因'}` }
    }

    // Never report a request as a completed effect: "the call was sent" and
    // "the value is there" are different claims (A09).
    const state = r.state || 'unknown'
    let msg
    if (action === 'set-text') {
      msg = r.verified
        ? `✅ 已写入并回读确认（${r.method}）：${r.actual}`
        : `⚠️ 写入已下达，但回读不符（${r.method}）；请求=${JSON.stringify(r.requested)} 实际=${JSON.stringify(r.actual)}`
    } else if (action === 'invoke') {
      msg = `✅ 已触发 #${r.index ?? args.index}「${r.name ?? ''}」（${r.method}，${state}）`
    } else if (action === 'click') {
      msg = `✅ 已发送点击 (${r.x ?? args.x}, ${r.y ?? args.y})（${r.method}，${state}）`
    } else if (action === 'drag') {
      msg = `✅ 已发送拖拽 (${args.x},${args.y}) → (${args.x2},${args.y2})（${r.method}，${state}）`
    } else if (action === 'activate') {
      msg = r.activated
        ? `✅ 已激活「${r.window}」（前台）`
        : `⚠️ 没能把「${r.window}」带到前台：${r.note || '系统拒绝了焦点切换'}`
    } else if (action === 'scroll-to') {
      msg = `✅ 已滚动到 #${r.index}「${r.name || ''}」`
    } else {
      msg = '✅ 完成'
    }
    return { ok: true, result: r, message: msg }
  },
})

// ---------------------------------------------------------------- screenshot

const shotTool = defineTool({
  name: 'computer_screenshot',
  description:
    '截取窗口（或整屏）并**直接把图像返回给你看**：Windows 用 PrintWindow，窗口被遮挡也能截准。' +
    '返回里同时给出原图路径（PNG）和一张缩略图；图像本身已经随结果送到，不需要再调 read_image。',
  parameters: {
    pid: { type: 'number', description: '目标窗口 pid；不给则截整个屏幕' },
    hwnd: { type: 'string', description: '精确窗口句柄（推荐）' },
    title: { type: 'string', description: '目标窗口标题/进程名' },
    path: { type: 'string', description: '保存路径，可选；默认存到工作区 .dsh-screenshots/' },
  },
  output: imageOut(),
  execute: async (args) => {
    const { p, error } = await provider()
    if (error) return { ok: false, path: null, message: `❌ ${error}` }

    const out = args.path
      ? path.resolve(String(args.path))
      : shotPath(path.join(process.cwd(), '.dsh-screenshots'), args.pid)

    const r = await p.screenshot({ pid: args.pid, hwnd: args.hwnd, title: args.title, out })
    if (!r.ok) {
      return { ok: false, path: null, message: `❌ 截图失败：${r.error || r.stderr || '未知原因'}` }
    }
    // Prefer the downscaled JPEG: it is small enough to ride along with the
    // result, while the full PNG stays on disk for detail work.
    const image = loadImageForModel(r.thumb || r.path)
    const size = r.width ? `\n  ${r.width}x${r.height}` : ''
    const seen = image
      ? '\n  图像已随结果返回，直接看即可。'
      : `\n  图像过大或读取失败，需要时用 read_image 打开：${r.path}`
    const warn = r.warning ? `\n  ⚠️ ${r.warning}` : ''
    return {
      ok: true,
      path: r.path,
      thumb: r.thumb,
      width: r.width,
      height: r.height,
      mode: r.mode,
      scope: r.scope,
      allBlack: Boolean(r.allBlack),
      image,
      message: `✅ 已截图：${r.path}${size}${r.mode ? `，方式 ${r.mode}` : ''}${seen}${warn}`,
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
  for (const tool of [statusTool, listTool, inspectTool, actTool, shotTool, inputTool, clipboardTool, watchTool]) registerTool(ctx, tool)
}
