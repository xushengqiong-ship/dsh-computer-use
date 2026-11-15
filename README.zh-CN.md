# dsh-computer-use

[![test](https://github.com/xushengqiong-ship/dsh-computer-use/actions/workflows/test.yml/badge.svg)](https://github.com/xushengqiong-ship/dsh-computer-use/actions/workflows/test.yml)

[English](README.md) | 简体中文

**跨平台的 DeepSeek Harness Computer Use。** 一套工具名，三个平台 provider：读取真实应用的界面元素树、点击控件、**不抢焦点**地写入文本，并且能在窗口被遮挡时截准图。

灵感来自 [dsh-computer-use](https://github.com/Anionex/dsh-computer-use)（仅 macOS）。独立实现，不共享代码。

## 平台支持 —— 请先看这张表

各平台能力**确实不同**。下表是代码实际行为，不是愿望清单：

| 平台 | 列窗口 | 元素树 | 点击元素 | 写文本 | 截图 |
| --- | --- | --- | --- | --- | --- |
| **Windows 10 / 11**（家庭版 / 专业版 / 企业版 / 教育版） | ✅ | ✅ 完整 UIA | ✅ 不抢焦点 | ✅ 不抢焦点 | ✅ 遮挡安全 |
| **macOS 14+** | ✅ | ⚠️ 仅窗口下一层 | ❌ **只读** | ❌ | ⚠️ 仅整屏 |
| **Linux（X11 / Wayland）** | ✅ wmctrl | ❌ | ❌ **只读** | ❌ | ✅ 整屏 |

**只有 Windows 在真机上验证过。** macOS 和 Linux 的 provider 是按各自官方 API 写的，但这里没法实测——请当作尽力而为。

### 为什么 macOS / Linux 是只读的（0.4.0）

`osascript` 的 `keystroke` / `click at`，以及 `xdotool` 的合成输入，是**全局的或不可靠的**：它们作用在当时有焦点的窗口上，或者被 GTK/Qt/Wayland 目标静默忽略。把它们当作 `computer_act` 暴露出去，意味着「往我指定的应用里打字」可能打到别的程序上——而且不报错。既然没有原生按窗口的后端就做不安全，这两个平台现在只做观测，所有写操作返回 `unsupported` 并说明原因。

### Linux 为什么弱

Linux 没有能对标 UIA / AX 的跨工具包无障碍 API。AT-SPI2 存在，但需要 `pyatspi` 桥接，且不同桌面、不同工具包（GTK / Qt / Electron）行为各异。与其塞一个"看起来能用其实静默失败"的实现，Linux provider 只做它可靠能做的部分——列窗口、截图、xdotool 输入——元素树则**明确返回不支持**。

## 工具

| 工具 | 作用 |
| --- | --- |
| `computer_status` | 报告平台、就绪状态、具备哪些能力 |
| `computer_list_windows` | 列出可见顶层窗口（pid、标题、尺寸；Windows 上还有类名、前台/最小化） |
| `computer_inspect` | 读元素树（类型、名称、坐标、可点击、可写入），可同时截图 |
| `computer_act` | `invoke` 点击 · `set-text` 写入 · `click` 坐标兜底 · `drag` 拖拽（Windows） |
| `computer_screenshot` | 截窗口或整屏为 PNG；配合 `read_image` 就能真的看见 |

## 各平台怎么实现的

| 平台 | 机制 |
| --- | --- |
| Windows | 用 **Windows PowerShell 5.1** 调 `UIAutomationClient`（.NET Framework），并**常驻一个 `serve` 进程**；点击用 `InvokePattern`；旧控件写入回退 `WM_SETTEXT`；遮挡截图用 `PrintWindow(PW_RENDERFULLCONTENT)`；拖拽用 `WM_LBUTTONDOWN/MOUSEMOVE/UP` |
| macOS | `osascript` 驱动 System Events（`click button`、`keystroke`、`click at`）；截图用 `screencapture` |
| Linux | `wmctrl` 列窗口、`xdotool` 做输入、`grim` / ImageMagick / `gnome-screenshot` 截图；无元素树 |

### 为什么要常驻

启动一次 Windows PowerShell 大约要 **1 秒**（进程启动 + .NET 程序集加载）。本机连续跑 5 次窗口列表实测：

| 模式 | 每次耗时 |
| --- | --- |
| 一次性 spawn | 999 ms |
| 常驻 `serve` 进程 | **27 ms** |

差 **37 倍**，所以 Windows provider 会保持一个 helper 活着，每次请求交换一行 JSON。请求串行执行（PowerShell 单线程），卡住会超时并杀掉重启，任何失败都回退到一次性 spawn。

`computer_inspect` 带 `screenshot: true` 时，**元素树和截图在同一次往返里完成**，不再是两次调用。

Windows 每次调用都重新枚举实时树，所以元素序号不会被重放到已经变化的窗口上。`expectName` 是硬校验：名字不完全匹配就拒绝执行。

## 在 Windows 10 (19045) + DSH 0.2.2-rc.3 上的实测

| 检查项 | 结果 |
| --- | --- |
| 枚举窗口 | 12 个可见顶层窗口 |
| 读 DSH 自己的 Electron 界面 | **502–783 个 UIA 元素**（随视图状态变化） |
| 常驻加速 | 27 ms/次 vs 一次性 999 ms/次（**37×**） |
| 树 + 截图一次返回 | 3526 个元素 + 一张 PNG，一次往返 |
| 点击控件 | `InvokePattern` 收起侧边栏并恢复 |
| 写中文 | 经 `WM_SETTEXT` 写入记事本，UTF-8 完好 |
| 截被遮挡窗口 | 记事本被完全盖住，`PrintWindow` 仍截准 |
| 拖拽 | 消息式拖拽报告成功，但见下方限制 |

## 已知限制

- **canvas 内容对 UIA 不可见。** 画在 canvas 上的棋盘只是一个不透明矩形，没有控件可点。要么截图，要么让程序把状态导出成文本。
- **Chromium/Electron 应用**只有在开启 accessibility 时才把网页内容暴露给 UIA。DSH 自己是暴露的（实测 783 个元素）；不暴露的应用请用 `computer_screenshot` + `read_image`。
- **拖拽是基于消息的，并非万能。** 它给目标窗口发 `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` / `WM_LBUTTONUP`，所以不抢焦点——但依赖真实鼠标捕获的控件（记事本的编辑区、很多 canvas 控件）会「报告成功但其实没选中」。实测：在记事本里横向拖过文字，没有产生选区。优先用 `set-text` / `invoke`，拖拽当作尽力而为。
- **最小化窗口**没有可用几何信息，先恢复再操作。
- **不做全局输入注入。** 不移动系统光标、不发全局按键，一切都定向到具体窗口。

## 安装

```powershell
# Windows
dsh plugin --profile <profile> add file:C:\path\to\dsh-computer-use
```

```bash
# macOS / Linux，命令形状一样
dsh plugin --profile <profile> add file:/path/to/dsh-computer-use
```

然后重启 DSH，让 bundle 和工具加载。

### 前置条件

| 平台 | 需要什么 |
| --- | --- |
| Windows | Windows PowerShell 5.1（Windows 10/11 自带）。可用 `DSH_WIN_CU_POWERSHELL` 覆盖 |
| macOS | 给运行 DSH 的程序授予「辅助功能」权限（系统设置 → 隐私与安全性 → 辅助功能）|
| Linux | `wmctrl`、`xdotool`，以及截图工具（Wayland 用 `grim`，否则 ImageMagick 或 `gnome-screenshot`）|

## 安全

- 没有任何工具会删文件、杀进程、关机，或把输入发到选定窗口之外。
- `computer_act` 支持 `expectName`：给了就必须完全匹配——做不可逆操作时务必带上。
- 只读动作（`computer_status`、`computer_list_windows`、`computer_inspect`）绝不修改窗口。
- 截图可能包含屏幕上的任何内容，按敏感数据处理。

## 自测

```powershell
node --check lib/index.mjs
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-platform.mjs
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-live.mjs   # 会真的碰桌面
```

## 路线图

- 借鉴官方 macOS 版的 **observation 生命周期**（observationId + 过期 + 动作前校验），防止在已变化的界面上误操作
- macOS provider 在真机验证，尤其权限与 System Events 的层级限制
- Linux：尝试 AT-SPI2 桥接，至少支持 GTK 应用
- 敏感操作的一次性确认令牌

## 0.4.0 修了什么

| 编号 | 问题 | 修法 |
| --- | --- | --- |
| A01 | 常驻失败后**重放**写动作 | 写动作返回 `state: 'unknown'`，永不重试 |
| A02 | 回退路径读的是 `req.title`，而线上字段是 `titleB64` | 一份业务请求、两处编码；回退读原始参数 |
| A03 | 死进程的迟到事件会结算新请求 | 每个请求绑定到自己的进程实例 |
| A05 | `click` 落到 `unknown action` | 显式映射 `click → clickxy` |
| A08 | 写入回退到顶层窗口句柄（会改窗口标题） | 元素没有自己的 HWND 就直接拒绝 |
| A09 | `set-text` 把请求文本当成结果返回 | 回读校验，返回 `verified / applied-unverified` |
| A10 | 目标找不到时静默截整屏 | 直接失败；截图带 `scope: window / screen` |
| A11 | 点击用客户端坐标，截图用窗口坐标 | 用 `ClientToScreen` 算偏移，返回 `offset` |
| A12/A13 | macOS/Linux 的输入是全局的 | 两个 provider 改为只读，写操作返回 `unsupported` |
| A14 | 能力报告含糊 | `computer_status` 按平台列出具体能力 |

## 仍然待办

- Observation ID（A07）：UIA 的 `RuntimeId` 在很多控件上是空的（记事本编辑区实测为空），所以身份要由 AutomationId + ControlType + 名称 + 树路径组合——方案有了但未实现
- UIA 遍历的边界（B01）和更完整的模型可见输出（B02）
- Windows 的 `type-text`（真实键盘输入）是刻意没做的

## 许可

MIT。

---

> 状态：`0.4.0`。Windows 已验证；macOS / Linux 只读，未在真机测试。
