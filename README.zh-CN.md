# dsh-computer-use-win

[![test](https://github.com/xushengqiong-ship/dsh-computer-use-win/actions/workflows/test.yml/badge.svg)](https://github.com/xushengqiong-ship/dsh-computer-use-win/actions/workflows/test.yml)

[English](README.md) | 简体中文

**Windows 原生的 DeepSeek Harness Computer Use。** 让 agent 读取真实应用的 UI Automation 元素树、按控件点击、**不抢焦点**地写入文本，并且能在窗口被遮挡时截准图。

这是对 [dsh-computer-use](https://github.com/Anionex/dsh-computer-use)（仅 macOS）的独立 Windows 实现。借鉴了它的设计原则——先观察再动作、不重放过期目标、优先语义化操作而非坐标——但不共享任何代码。

## 工具

| 工具 | 作用 |
| --- | --- |
| `win_list_windows` | 列出可见顶层窗口：pid、标题、类名、尺寸、是否前台/最小化 |
| `win_inspect` | 读窗口的 UIA 元素树（类型、名称、类名、坐标、能否点击/写入），可同时截图 |
| `win_act` | `invoke` 点控件 / `set-text` 写文本 / `click` 窗口内坐标点击（兜底） |
| `win_screenshot` | 截窗口或整屏为 PNG |
| `win_status` | 检查平台、PowerShell、helper 是否就绪，不动任何窗口 |

截图返回文件路径——配合 `read_image`，agent 就真的能"看见"窗口。

## 原理

全部由 `lib/helper.ps1` 完成，用 **Windows PowerShell 5.1** 调用（因为 `UIAutomationClient` 在 .NET Framework 里）：

| 能力 | 机制 | 为什么这么做 |
| --- | --- | --- |
| 读界面 | `AutomationElement.FindAll(TreeScope.Descendants)` | 拿到的是结构化控件，不是像素，不用 OCR 猜 |
| 点击 | `InvokePattern` | 不需要把窗口切到前台 |
| 写文本 | `ValuePattern`，失败回退 `WM_SETTEXT` | **不抢焦点**；旧式 Win32 控件没有 UIA value pattern 也能写 |
| 截图 | `PrintWindow(..., PW_RENDERFULLCONTENT)` | **被遮挡也能截**；普通的 `CopyFromScreen` 只会拍到盖在上面的东西 |
| 安全 | 动作前校验 `expectName` | 过期的序号不会误点到别的按钮 |

每次调用都重新枚举实时树，所以序号不会被重放到已经变化的窗口上。

## 在 Windows 10 (19045) + DSH 0.2.2-rc.3 上的实测

以下是开发机上的真实测量，不是宣传语：

| 检查项 | 结果 |
| --- | --- |
| 枚举窗口 | 14 个可见顶层窗口 |
| 读 DSH 自己的 Electron 界面 | **783 个 UIA 元素**（91 个按钮，含「新建会话」这类真实标签） |
| 点击控件 | `InvokePattern` 收起侧边栏并成功收起 |
| 写入中文 | 经 `WM_SETTEXT` 写入记事本，UTF-8 完好 |
| 截被遮挡窗口 | 记事本被 DSH 完全盖住，`PrintWindow` 仍截准 |

## 已知限制

- **只支持 Windows。** 其他平台工具会明确拒绝，而不是莫名失败。
- **Chromium/Electron 应用**：只有当应用暴露 accessibility 时，网页内容才出现在 UIA 里。DSH 自己是暴露的（实测 783 个元素），不暴露的应用只能看到原生外壳——那种情况用 `win_screenshot` + `read_image`。
- **canvas 内容对 UIA 不可见。** 画在 canvas 上的游戏棋盘只是一个不透明矩形，没有控件可点。要么截图，要么让程序把状态导出成文本。
- **不做全局输入注入。** 本插件不移动系统光标、不发全局按键，只通过 UIA 和窗口消息定向到具体窗口——这是刻意的。
- **最小化窗口**没有可用几何信息，先恢复再操作。
- 依赖 **Windows PowerShell 5.1**（Windows 10/11 都有）。可用 `DSH_WIN_CU_POWERSHELL` 覆盖。

## 安全

- 没有任何工具会删除文件、结束进程、关机，或把输入发到选定窗口之外。
- `win_act` 支持 `expectName`：给了它就必须完全匹配，否则拒绝执行。**做不可逆操作时请务必带上。**
- 只读动作（`win_list_windows`、`win_inspect`、`win_status`）绝不修改窗口。
- 截图可能包含屏幕上的任何内容，按敏感数据处理。

## 安装

```powershell
dsh plugin --profile <profile> add file:C:\path\to\dsh-computer-use-win
```

然后重启 DSH，让 bundle 和工具加载。

## 自测

```powershell
# 语法
node --check lib/run.mjs
node --check lib/index.mjs

# 工具冒烟（只做只读动作：status / list / inspect）
node --no-warnings --experimental-loader ./smoke/loader.mjs ./smoke/test-tools.mjs
```

## 许可

MIT。

---

> 状态：`0.1.0`，早期版本。Windows UI Automation 在不同应用上表现不一，会有粗糙的地方——遇到问题欢迎提 issue。
