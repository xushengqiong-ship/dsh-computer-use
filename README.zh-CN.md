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
| **macOS 14+** | ✅ | ⚠️ 仅窗口下一层 | ✅ System Events | ✅ 键盘输入 | ⚠️ 仅整屏 |
| **Linux · X11** | ✅ wmctrl | ❌ 未实现 | ⚠️ 仅坐标 | ✅ xdotool（需焦点） | ✅ |
| **Linux · Wayland** | ✅ wmctrl | ❌ | ❌ xdotool 够不到原生窗口 | ❌ | ✅ grim |

图例：✅ 可用 · ⚠️ 部分可用/有前提 · ❌ 不支持

**只有 Windows 在真机上验证过。** macOS 和 Linux 的 provider 是按各自官方 API 写的，但这里没法实测——请当作尽力而为，坏了欢迎提 issue。

### Linux 为什么弱

Linux 没有能对标 UIA / AX 的跨工具包无障碍 API。AT-SPI2 存在，但需要 `pyatspi` 桥接，且不同桌面、不同工具包（GTK / Qt / Electron）行为各异。与其塞一个"看起来能用其实静默失败"的实现，Linux provider 只做它可靠能做的部分——列窗口、截图、xdotool 输入——元素树则**明确返回不支持**。

## 工具

| 工具 | 作用 |
| --- | --- |
| `computer_status` | 报告平台、就绪状态、具备哪些能力 |
| `computer_list_windows` | 列出可见顶层窗口（pid、标题、尺寸；Windows 上还有类名、前台/最小化） |
| `computer_inspect` | 读元素树（类型、名称、坐标、可点击、可写入），可同时截图 |
| `computer_act` | `invoke` 点击 · `set-text` 写入 · `click` 坐标兜底 |
| `computer_screenshot` | 截窗口或整屏为 PNG；配合 `read_image` 就能真的看见 |

## 各平台怎么实现的

| 平台 | 机制 |
| --- | --- |
| Windows | 用 **Windows PowerShell 5.1** 调 `UIAutomationClient`（.NET Framework）；点击用 `InvokePattern`；旧控件写入回退 `WM_SETTEXT`；遮挡截图用 `PrintWindow(PW_RENDERFULLCONTENT)` |
| macOS | `osascript` 驱动 System Events（`click button`、`keystroke`、`click at`）；截图用 `screencapture` |
| Linux | `wmctrl` 列窗口、`xdotool` 做输入、`grim` / ImageMagick / `gnome-screenshot` 截图；无元素树 |

Windows 每次调用都重新枚举实时树，所以元素序号不会被重放到已经变化的窗口上。`expectName` 是硬校验：名字不完全匹配就拒绝执行。

## 在 Windows 10 (19045) + DSH 0.2.2-rc.3 上的实测

| 检查项 | 结果 |
| --- | --- |
| 枚举窗口 | 12 个可见顶层窗口 |
| 读 DSH 自己的 Electron 界面 | **502–783 个 UIA 元素**（随视图状态变化） |
| 点击控件 | `InvokePattern` 收起侧边栏并恢复 |
| 写中文 | 经 `WM_SETTEXT` 写入记事本，UTF-8 完好 |
| 截被遮挡窗口 | 记事本被完全盖住，`PrintWindow` 仍截准 |

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

## 许可

MIT。

---

> 状态：`0.2.0`。Windows 已验证；macOS / Linux 为尽力实现，未在真机测试。
