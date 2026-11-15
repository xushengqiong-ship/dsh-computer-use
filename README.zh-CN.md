# dsh-computer-use

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 Computer Use 插件：让 agent 读取桌面界面、
点击控件、输入文字——多数情况下**不抢你的焦点**，需要时也有真实键鼠通道兜底。

状态：`1.4.0`。**只有 Windows 10/11 在真机上验证过。** macOS 和 Linux 的 provider 存在，但只读、未实测。

---

## 能做什么

| 工具 | 作用 |
| --- | --- |
| `computer_status` | 报告平台就绪状态和能力矩阵 |
| `computer_list_windows` | 列出可见顶层窗口（pid、标题、尺寸、类名、前台/最小化） |
| `computer_inspect` | 读元素树：类型、名称、坐标、能否点击/写入、文本内容 |
| `computer_act` | **后台通道** —— `invoke` · `set-text` · `scroll-to` · `scroll-page` · `activate` · `click` · `drag` |
| `computer_input` | **前台通道** —— `move` · `hover` · `click` · `double-click` · `right-click` · `middle-click` · `drag` · `scroll` · `press` · `type` · `wait` |
| `computer_screenshot` | 截窗口或整屏为 PNG |
| `computer_clipboard` | 读写纯文本剪贴板 |
| `computer_watch` | 等窗口打开/关闭，或等你按下某个键 |
| `computer_scan` | 滚动长页面并逐屏截图 |

### 两条输入通道

| | `computer_act`（后台） | `computer_input`（前台） |
| --- | --- | --- |
| 机制 | UI Automation 语义 + 窗口消息 | 真实 `mouse_event` / `keybd_event` 注入 |
| 移动你的光标 | 不会 | **会** |
| 需要目标在前台 | 不需要 | 键盘/打字需要 |
| 能操作 canvas / 游戏 | 不能 | **能** |
| 你还能同时用电脑 | 可以 | 不行——输入被接管 |

你在干别的事、要我在某个窗口里后台干活 → 用后台通道。目标只认真实鼠标键盘（canvas、游戏）→ 用前台通道，
代价是光标被我接管。

---

## 平台支持

| 平台 | 列窗口 | 元素树 | 点击元素 | 写文本 | 截图 |
| --- | --- | --- | --- | --- | --- |
| **Windows 10 / 11**（家庭版 / 专业版 / 企业版 / 教育版） | ✅ | ✅ 完整 UIA | ✅ 不抢焦点 | ✅ 不抢焦点 | ✅ 遮挡安全 |
| **macOS 14+** | ✅ | ⚠️ 仅窗口下一层 | ❌ 只读 | ❌ | ⚠️ 仅整屏 |
| **Linux（X11 / Wayland）** | ✅ wmctrl | ❌ | ❌ 只读 | ❌ | ✅ 整屏 |

**只有 Windows 在真机上验证过。** macOS 和 Linux 的 provider 是按各自官方 API 写的，但这里没法实测。

这两个平台是**故意只读**的：`osascript` 的 `keystroke` 和 `xdotool` 的合成输入是全局的或不可靠的——它们作用在
当时有焦点的窗口上，或者被 GTK/Qt/Wayland 目标静默忽略。把它当作 `computer_act` 暴露，意味着「往我指定的应用
里打字」可能打到别的程序上，而且不报错。

---

## 安装

```bash
dsh plugin --profile <你的profile> add <路径或包名>
```

它是标准的 DSH bundle：`package.json` 里有 `dsh.bundle.patch`，`cordis.patch.yml` 插入插件行。
依赖 `koffi` 和 `pngjs` 都是预编译的，**不需要任何编译工具链**。

### 开发时热重载

改完插件代码**不需要重启整个 harness**：

```
plugin_manager set_plugin <entryId> enabled=false   → applied
plugin_manager set_plugin <entryId> enabled=true    → applied（代码重新加载）
```

新建会话就会拿到新的工具表；已经存在的会话保留旧的。

---

## 已知限制

### 杀毒软件与输入注入

某些安全软件会专门拦**模拟垂直滚轮**。在一台装了联想预装的火绒组件（`usysdiag` + `HRWSCCtrl`）的机器上，
`mouse_event` 和 `SendInput` 的滚轮事件**完全到不了任何应用**——连记事本都滚不动——而 `WM_VSCROLL` 和键盘注入
照常工作。

所以 `computer_scan` 用的是分级降级，而不是单一机制：

| 目标 | 纵向 | 横向 |
| --- | --- | --- |
| Win32（记事本 / 资源管理器 / Office） | `WM_VSCROLL` 消息 | `WM_HSCROLL` |
| Chromium / Electron（Codex / Chrome） | 点击聚焦后用 `PageUp` / `PageDown` | Shift + 滚轮 |

如果你的机器上注入被完全禁掉，后台通道仍然可用，只有 `computer_input` 受影响。

### 工具结果必须是纯文本

DSH 会拒绝含单个 `undefined` 的结果（`value is not lossless JSON`）；而且——这是实打实踩出来的——
如果某个工具的 `render` 返回**图像内容块**，整个模型请求会以 `DeepSeek Messages transport failed` 失败。
所以这里所有工具只返回纯文本，结果统一过一个 `clean()` 包装，也不声明任何嵌套 object 参数。

截图返回路径，要看图请另调工具。

### 其它约束

- **canvas 内容对 UIA 不可见。** 画在 canvas 上的棋盘只是一个不透明矩形，请截图。
- **Chromium/Electron 应用**只有在开启 accessibility 时才把网页内容暴露给 UIA。DSH 自己是暴露的；
  不暴露的应用请截图。
- **Qt 应用**（比如微信）可能几乎什么都不暴露——只有一个标题栏。那种地方只有「截图 + 坐标」这条路。
- **拖拽是基于消息的，并非万能。** 依赖真实鼠标捕获的控件（记事本的编辑区、很多 canvas 控件）会
  报告成功但其实没选中。
- **最小化窗口**没有可用几何信息，先恢复再操作。
- **不做全局输入注入。** `computer_act` 从不移动系统光标、不发全局按键。

---

## 实现结构

```
lib/index.mjs          工具定义（纯文本结果，无嵌套）
lib/providers/win.mjs  Windows provider：UIA 走 helper，截图/输入走 native
lib/providers/mac.mjs  macOS provider（只读，osascript）
lib/providers/linux.mjs Linux provider（只读，wmctrl）
lib/native/win32.mjs   koffi FFI：PrintWindow 截图、mouse_event/keybd_event、剪贴板
lib/helper.ps1         Windows PowerShell 5.1 helper：只做 UI Automation
lib/helper-client.mjs  常驻 helper 客户端（每次请求一行 JSON）
```

**为什么截图和输入走原生，不走 PowerShell：** 用 PowerShell 截窗口位图的脚本会被 Windows Defender 判成
`HackTool:PowerShell/EmpireGetScreenshot.C`，随后 AMSI 阻断**整个脚本**——所有能力一起失效。把截图和注入搬到
Node（通过 `koffi`，预编译）就消除了这条失效路径：实测把 helper 放到没有任何杀毒排除项的路径下执行，不再被拦。

顺带快了：每张截图约 **185ms**，PowerShell 版约 900ms。

**为什么要常驻 helper：** 启动一次 Windows PowerShell 大约要 1 秒。一个 `serve` 进程按行应答 JSON，
把 UIA 往返压到约 **27ms**——差 **37 倍**。请求串行执行，卡住会超时杀掉，失败会回退到一次性 spawn。

**DPI：** Node 进程默认是 DPI-unaware，在 200% 缩放的屏幕上 `GetWindowRect` 只报告一半尺寸，
`PrintWindow` 也就只渲染左上角。截图时把线程 DPI 上下文提到 `PER_MONITOR_AWARE_V2`、截完恢复；
输入则留在 `SetCursorPos` 期望的逻辑坐标系里。

---

## 在 Windows 10 (19045) + DSH 0.2.2-rc.3 上的实测

| 检查项 | 结果 |
| --- | --- |
| 枚举窗口 | 11 个可见顶层窗口 |
| 读 DSH 自己的 Electron 界面 | **637 个 UIA 元素** |
| 读 WinUI 应用 | 计算器 59 个元素；`7+8=15` 全程由后台通道完成 |
| 真实键盘输入 | 283 个 ASCII 字符落进记事本，光标移到第 30 行 |
| 滚动长页面 | `computer_scan` 拍到 3 屏，最后一屏露出了原先看不见的行 |
| 常驻加速 | 27 ms/次 vs 一次性 999 ms/次（**37×**） |
| 截图速度 | 185 ms/张（原生 PrintWindow） |
| 剪贴板往返 | 中文写入后读回完全一致 |
| 端到端 | 在 Codex 里读完一段长对话、定位输入框、输入 246 个字符（含中文）并发送 |

CI 跑在 `windows-latest` + Node 22/24：语法检查、`helper.ps1` 解析、平台无关的加载测试。
GitHub runner 没有交互式桌面，真实 UI 自动化不在 CI 覆盖范围内。

---

## 许可

MIT
