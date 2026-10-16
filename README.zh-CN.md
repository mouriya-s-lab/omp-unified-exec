# omp-unified-exec

[English](README.md) | 简体中文

为 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）提供长时间运行的 shell
会话，并在 Tern 里带一个 tty 终端 HUD。交互程序、REPL、`ssh`、`sudo` 和全屏程序使用真实 PTY 会话，在多次调用之间持续可用。非交互命令默认使用嵌入式 Brush shell；omp 可以拥有它们的后台任务并自动回送最终输出。

本仓库 fork 自 [iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec)，后者是 codex `unified_exec` 的 Pi 移植。本包保留五个工具（`exec_command`、`write_stdin`、`set_on_exit`、`kill_session`、`list_sessions`）。Pi 保持上游的真实进程语义；omp 增加 Brush 执行、宿主任务、截止时间、内部 URL 与输出 artifact。差异及升级检查见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

## 安装

```bash
omp install https://github.com/oh-my-omp/omp-unified-exec
```

请先卸载已有的 `pi-unified-exec`（`omp plugin uninstall pi-unified-exec`）：两者注册的是同一组工具。本 fork 不向 npm 发布任何内容。

当 PATH 中存在 `tern` 时，omp 也会把附带的 Tern 插件正常安装为副本。更新时执行同一安装命令并加上 `--force`：

```bash
omp plugin install https://github.com/oh-my-omp/omp-unified-exec --force
```

Tern 更新会在这条命令成功返回前完成，无需单独执行 Tern 命令，也不使用开发链接。

本包在 Pi 上照常加载（使用 Pi 的渲染器，没有 HUD）。PTY 模式在 Bun 1.4+ 下使用 Bun 原生的 `Bun.Terminal`（omp 是编译后的 Bun 可执行文件），在 Node 下使用可选依赖 `@homebridge/node-pty-prebuilt-multiarch`。两者都没有时，管道模式（`tty: false`）仍可用，`tty: true` 会报告缺少该能力。

## 功能

- **执行独立于连接等待。** 返回的 `session_id` 仍可通过 `write_stdin` 写入。取消调用不会杀掉执行。Brush HostJob 自动回送完成结果；Coordinator 会话使用轮询或人明确要求的完成唤醒。
- **PTY 输出就是终端上看到的内容。** `tty: true` 的会话经过一个无头终端模拟器，进度条、重绘和全屏程序返回的是当前屏幕（加上自上次调用以来滚出屏幕的行和光标位置），而不是把每次重绘都追加起来。模拟器会像真实终端一样回应终端查询（光标位置、设备属性、默认颜色），因此等待这些回应、或根据回应选择浅色/深色配色的程序，表现与在真实终端里一致。
- **输出有上限，恢复信息如实。** 真实进程结果保留 50 KiB / 2000 行的终端安全尾部与完整原始日志。Brush 最终输出使用宿主有界首尾 sink 和提取出的终端图像；有条件时完整原生文本存入真实会话 artifact，否则明确说明完整输出不可恢复。
- **只有一个完成交付方。** omp HostJob 经实际会话的任务管理器回送。Coordinator 会话支持可选 `on_exit: "wake"`；`set_on_exit` 可以在不杀执行的情况下取消唤醒。
- **omp 原生呈现。** `exec_command`、`write_stdin` 和 `kill_session` 用 omp 自己的 bash 卡片渲染（命令行、输出、退出码标签、错误配色），在 ANSI TUI 和 Tern 里都是如此。
- **Tern 里的终端 HUD。** 不用调用工具，就能查看、回滚、输入并结束模型的 tty 会话。

<a id="tern-hud"></a>

## Tern 终端 HUD

当 omp 在 Tern 里原生渲染、并且存在 tty 会话时：

- **计数按钮。** 一个终端图标加存储中的 tty 会话数，单独一行放在 omp 计数器正上方。整行、药丸和分段使用 Tern 原生 HUD 样式，跟随 Reader、Spine、Console 和配色主题。没有外层隐藏按钮；最后一个 tty 被移除后，计数按钮自动卸载。
- **Terminals 面板。** 点击计数按钮打开一个仿照 omp Agents 面板的面板：每个 tty 会话一行，带状态点、尺寸、PID 和运行时长；选中会话的命令、状态、目录、PID、尺寸、启动时间、可点击的日志路径和最新几行输出作为预览。↑/↓ 或点击选择会话，`x` / Kill 按 `kill_session` 的方式结束它，Esc / Close 关闭面板。
- **终端页。** Enter / Open 把会话打开成一个仿照 omp Console 的全屏页：显示保留的历史和当前屏幕，带颜色、按会话自身宽度显示，跟随新输出，并可向上回滚。键入的按键会发给会话（与 `write_stdin` 的写法相同，模型能看到效果）；Esc / Back 返回面板；Kill 结束会话。

HUD 直接读取会话，不保存副本。它只在 omp 原生渲染时存在，因此 ANSI TUI 不会多出一行。PTY 的模型输出仍是无终端控制的文本；Brush 图像提取与此 HUD 无关。

**Tern 插件。** omp 扩展无法往 omp 的计数器那一行里加东西，所以本包附带一个只含 CSS 的 Tern 插件（`fork-features/tern-plugin/`）。它把共享的 `belowEditor` widget 容器移到 omp 计数器上方，清除容器的间距、背景和阴影，避免与原生 HUD 边距重复叠加。同一容器中的其他 widget 也共享这个位置和重置；插件不重设药丸外观或 omp 的输入框，并让面板的输出预览使用等宽字体。

omp 等待扩展 factory 完成，因此插件在包安装校验（包括 `install --force`）和普通扩展加载期间同步。它向 Tern 查询插件目录及 catalog；只有三个文件完全一致的正常副本，且版本、样式表和 ready 状态都匹配时，才不改动。缺失或旧文件通过 `tern plugin install <包内目录> --force` 更新。已确认的旧 `.path` 注册由 Tern 自己的 unlink 和正常副本安装自动迁移，不创建开发链接。

CLI 继承 omp 的环境，由 Tern 决定目标目录并负责重新加载。daemon 未运行时，Tern 安装副本供下次启动使用。没有 `tern` 可执行文件不影响非 Tern 使用；如果 Tern 存在但同步失败，包校验或普通扩展加载会失败并报告命令诊断，不延迟到 session-start 重试，也不显示成功 toast。如果 omp 随后保存包配置失败，已经完成的外部 Tern 更新不会一起回滚。没有插件时，计数按钮显示在输入框下方。

设计、决策和 Tern 实测记录：
[docs/IV-0002-output-lifecycle-and-rendering.md](docs/IV-0002-output-lifecycle-and-rendering.md)。

## 工具

### `exec_command`

在 omp 上，省略/空 `shell` 且 `tty: false` 选择 **Brush**；非空 `shell` 选择真实 **PipeProcess**；`tty: true` 总是选择真实 **PtyProcess**。Git Guard、内置命令、内部 URL 路径与原生压缩只在 Brush 下生效。Pi 保持原有真实进程选择。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `cmd` | string | — | 必填 shell 命令；审批检查原始请求，执行/结果使用计划后的生效命令。 |
| `workdir` | string | 调用方 cwd | 相对路径按调用会话解析。Brush 还接受受支持的内部 URL 目录，真实进程拒绝 URL workdir。 |
| `shell` | string | 省略 | omp 中省略/为空时选择 Brush，除非 `tty: true`；非空则选择真实进程。真实进程默认 bash，Windows 没有 bash 时用 PowerShell。 |
| `tty` | boolean | `false` | 给交互程序、REPL、ssh、sudo 和密码提示使用真实 PTY；输出是渲染后的终端状态。 |
| `cols` | number | `120` | PTY 宽度，限制在 [20, 500]；Brush 与管道忽略。 |
| `rows` | number | `30` | PTY 高度，限制在 [5, 300]；Brush 与管道忽略。 |
| `yield_time_ms` | number | 取决于后端 | 连接等待，不是执行期限。显式值限制在 [250, 30000]。真实进程默认 10000 ms。Brush HostJob 在自动后台开启时使用绑定会话阈值，否则省略时等到完成/截止；Coordinator Brush 同样等到完成/截止。 |
| `timeout` | number | Brush 为宿主默认；进程无限 | 仅 omp，单位秒。Brush 宿主默认 300，受 `tools.maxTimeout` 封顶。显式正数受宿主 1..3600 与全局上限限制；`0` 禁用期限。返回会话 id 不会取消期限。 |
| `async` | boolean | `false` | 仅 omp，且只在 `async.enabled` 为真时出现在 schema。立即将 Brush 转为 HostJob；manager 缺失/已满时拒绝且不启动。真实进程变体拒绝 async。 |
| `on_exit` | `"none"` \| `"wake"` | `"none"` | 只有 Coordinator 支持人明确要求的唤醒。HostJob `"wake"` 是类型化错误；`"none"` 不改变宿主交付。 |

Brush 的说明与稳定 base/async schema 读取绑定会话的当前设置。绑定先于被 await 的首次活动工具刷新，包括 `--keep-builtin-bash`。数值在宿主下一次重建提示词时重新读取；仅修改数字不保证立即触发重建。未绑定的 omp 执行报告 `host_binding_unavailable`，不使用其他会话的设置。Pi 的说明与参数保持不变。

HostJob 在达到配置阈值、显式连接等待到期或发起调用被取消时转后台。`job_id` 指向宿主任务，最终结果自动回送；不要为了该结果轮询。没有宿主任务槽时，普通 Brush 使用 Coordinator，可轮询。交互会话用 `tty: true`；无限期的非交互 Brush 工作用 `timeout: 0`。插件没有 service/ready API。

Brush 只有成功关闭后才报告 `log_path: artifact://<id>`。artifact 保存图像/压缩转换之前原生文本的精确 UTF-8 编码；String 原生桥不保留任意非法 UTF-8 进程字节。只有该文本保存成功，压缩结果才替换内联文本，并附 `[raw output: artifact://<id>]`。捕获缺失/失败时保留有界原文投影，说明完整输出未保存，不提供恢复链接。Brush 不写临时进程日志。图像随前台最终结果与 HostJob 回送交付；轮询（包括终态观察）只返回新增文本。

HostJob 的前台/后台最终结果共用配置溢出预算与宿主异步内联门槛中的较小值（当前为 12000 字符，保守地限制 UTF-8 字节数）。即使关闭自动后台，前台 Brush 输出也可能更短；这样避免把已减缩结果再保存为第二个 artifact。Coordinator Brush 保持配置的内联预算。

真实进程响应体（输出较短、未截断时）：

```
[still running]                     (or [exited])
session_id: 1                       (mutually exclusive with exit_code)
exit_code: 0                        (mutually exclusive with session_id)
signal: SIGTERM                     (optional, if killed)
log_path: /tmp/pi-unified-exec-1-5cc5e104.log
cwd: /home/you/project
wall_time_seconds: 0.502
chunk_id: a4f2c1
original_token_count: 37
output_bytes_total: 148            (cumulative bytes since spawn — compare across polls to detect stalls)
omitted_bytes: 0                   (only present when the 1 MiB in-memory retention dropped middle bytes)
tty: false
---
<captured stdout+stderr>
```

真实管道进程两次轮询间超过 1 MiB 保留量时，中间内容被丢弃，并在该位置插入标记。Brush 共用增量保留机制，但报告它实际的 artifact/inline-only 恢复状态：

```
[... 3145728 bytes omitted here (output exceeded the 1048576-byte in-memory retention between polls; the full stream is in the session log file) ...]
```

真实进程的输出超过 50 KiB / 2000 行时，末尾附上说明：

```
...tail of output...

[Showing lines 3900-4120 of 4500 (50.0KB limit). Full output: /tmp/pi-unified-exec-1-5cc5e104.log]
```

<a id="pty-sessions"></a>

#### PTY 会话（`tty: true`）

tty 会话把子进程写出的每个字节按顺序送进一个尺寸为会话 `cols`×`rows` 的无头终端模拟器（[`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)），每次结果报告的是这个终端显示的内容，而不是原始输出流：

```
[still running]
session_id: 3
…
tty: true
terminal: normal screen 120x30, cursor row 4 col 5
history_lines: 2                   (optional: lines scrolled off above the screen since the last call)
---
<history lines not yet reported>
<the full current screen, trailing blank rows removed>
```

- **历史加屏幕。** 先给出自上次调用以来从顶部滚出、且尚未报告过的行，再给出完整的当前屏幕。回车刷新的进度条和重绘只显示最终状态。
- **屏幕未变。** 屏幕、光标和历史都没变化时，结果带 `screen_changed: false` 和 `(no output)`。
- **全屏程序**（备用屏幕，比如 `top`、编辑器）报告为 `terminal: alternate screen …`；退出后恢复普通屏幕。
- **只有纯文本和光标。** 模型结果里没有颜色；原始输出在 `log_path` 里，Tern 的终端页会显示颜色。
- **终端查询会被回应**，回应写到子进程的输入上：光标位置、设备属性，以及默认前景色/背景色（OSC 10/11）。在 omp 上颜色跟随 omp 的主题（浅色或深色，在 Tern 里跟随 Tern 的外观）；在 Pi 上为深色。
- 两次调用之间的历史受单元格预算限制（`TERMINAL_HISTORY_CELLS` 除以 `cols` 得到行数）。在被报告之前就超出预算的行会使结果带上 `history_may_be_truncated: true`；这些行只存在于日志中。

### `write_stdin`

驱动或轮询一个已有会话。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `chars` | string | `""` | 为空表示纯轮询；非空时先写入（经转义解码）再轮询。与 `chars_b64` 互斥。 |
| `chars_b64` | string | `""` | 要写入的 Base64 编码字节，二进制安全。与 `chars` 互斥。 |
| `yield_time_ms` | number | 有输入时 `250`；空轮询 `5_000` | 连接等待窗口，不是进程超时。带输入的调用限制在 [250, 30_000]。空轮询最少 5_000，没有内置上限；毫秒小数部分向下取整。运维显式设置的上限会拒绝更长的相对轮询。与 `yield_until` 互斥。 |
| `yield_until` | string | — | **仅用于空轮询**的绝对 UTC 截止时间，严格的 RFC 3339 UTC 格式（`2026-07-21T18:30:00Z` 或带 `.mmm`；大写 `Z`；必须是真实存在的日期）。**仅在人明确要求**长时间等待时使用。进程退出、调用取消或到达截止时间时返回；已过去的截止时间等同于立即轮询。与 `yield_time_ms` 及输入字节互斥。 |

#### 等待长时间运行的命令

1. 根据预期的任务时长使用有限的 `yield_time_ms`。空轮询默认五秒，没有内置上限。等待到期永远不会杀掉进程。
2. **仅在人明确要求**对**有限、非交互**的命令长时间等待或设定挂钟截止时间时，才用 `yield_until`，并根据 `tool_time_utc` 计算。**绝不要**用于 REPL、`sudo`、`ssh`、密码提示、开发服务器、文件监听或调试器。
3. `on_exit` 默认 `"none"`。只有人明确希望自动恢复时才用 `"wake"`；`set_on_exit(session_id, on_exit: "none")` 可在不杀进程的情况下取消。
4. 被工具结果直接观察到的退出会消耗掉唤醒；到期或取消则保留唤醒。

两种空轮询共用事件驱动的单调时钟等待。管道/Brush 保留有界游标内容，tty 保留渲染后的屏幕。进程日志接收原始字节；Brush 使用会话 artifact 或明示 inline-only 状态。流式更新由输出驱动，安静时没有心跳。缓存预热归宿主负责。进程日志与可用的 Brush artifact 在磁盘上不设上限；归档配额仍是[后续工作](docs/IV-0002-output-lifecycle-and-rendering.md#output-archive-safety)。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PI_UNIFIED_EXEC_MAX_EMPTY_POLL_MS` | 未设置，无上限 | 可选的空相对轮询上限。小于 `5_000` 的值按 `5_000` 处理；无效值会让轮询失败，而不是取消上限。不影响 `yield_until`。 |

#### `chars` 里的控制字节和转义

`chars` 在写入前按 C 风格转义字符串解码。

| 转义 | 结果 |
|---|---|
| `\\n` `\\r` `\\t` `\\b` `\\f` `\\v` | LF CR TAB BS FF VT |
| `\\0` | NUL (0x00) |
| `\\a` | BEL (0x07) |
| `\\e` | ESC (0x1B) |
| `\\xHH`（2 位十六进制） | 单个字节 |
| `\\uHHHH`（4 位十六进制） | Unicode 字符 |
| `\\u{H…H}`（1–6 位十六进制） | Unicode 码点 |
| `\\\\` `\\"` `\\'` | 字面量 `\` `"` `'` |
| 不在上表中的 `\\X` | 原样保留（两个字符） |
| 字符串里的原始字节 | 原样通过 |

```
write_stdin chars="\x03"          → Ctrl-C   (0x03)
write_stdin chars="\x04"          → Ctrl-D   (0x04)
write_stdin chars="\x1b:wq\n"     → ESC + ":wq" + LF     (vim save+quit)
write_stdin chars="\x1b[A"        → ESC + "[A"           (up arrow)
write_stdin chars="C:\\\\temp"    → "C:\\temp"           (must escape \)
write_stdin chars_b64="G3s6wgo="  → exact 5 decoded bytes
```

同时传 `chars` 和 `chars_b64`，或 base64 格式错误，都会拒绝调用。向 tty 提交输入请用 `\r`：它在所有平台都有效，而 `\n` 在旧版 Windows 控制台里不会执行这一行。

### `set_on_exit`

修改 `on_exit` 策略，**不杀进程**。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `on_exit` | `"none"` \| `"wake"` | — | `"none"` 取消待发的唤醒（会话被淘汰后留下的协调器墓碑记录同样适用）。`"wake"` 在会话仍在存储中运行时启用唤醒。 |

状态标记：`disarmed`、`already_none`、`armed`、`already_armed`、`too_late`；未知 id 返回 `found: false`。取消无法撤回已经排队交给宿主的后续提示。

对于 HostJob，`"none"` 不改变自动宿主交付；`"wake"` 返回 `on_exit_requires_coordinator`。

### `on_exit: "wake"`——完成通知

> Coordinator 的完成要么经已定稿工具结果交付，要么触发一次合成模型提示，绝不两者都有。HostJob 只经宿主交付。

- 在 `write_stdin` 观察期间发生的退出由该调用返回，结果定稿时消耗唤醒。结果以错误或取消定稿时，唤醒仍然有效。
- 到期或被取消的调用保留唤醒；进程之后退出时，恰好发送一条后续提示（`deliverAs: "followUp"`，不会打断正在进行的轮次）。同时发生的多个完成会合并成一条提示。
- 提示只包含有限的元数据（会话 id、退出码/信号、命令、cwd、耗时、日志路径、失败信息）——绝不包含原始输出。
- `kill_session`、`/unified-exec-sessions` 命令、对存活进程的 LRU 淘汰以及 `session_shutdown` 都会取消唤醒；kill 失败则恢复唤醒。自然退出、尚未通知就被淘汰的唤醒会话会保留一条有上限的墓碑记录，唤醒仍会送达。

### `kill_session`

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `session_id` | number | — | 必填。 |
| `signal` | string | `"SIGTERM"` | 2 秒后升级为 SIGKILL。`"SIGKILL"` 跳过等待。Windows 上任何信号都会强制结束进程树。 |

真实进程信号名会被规范化（`term`、`INT`、`sigkill`），未知名称被拒绝；kill 失败时保留会话并报告 `running: true`。Brush 不区分信号，只走唯一终止原语。隐藏的 slash 控制保留观察游标；模型可见的 `kill_session` 返回未观察尾部，并发观察对每段尾部只消费一次。已结算的 Brush 报告 `already_exited`；HostJob 不重放已交付正文。仅 tty 的 HUD 使用真实进程 kill 路径。

### `list_sessions`

真实进程退出后最后报告一次再移除。已结束的 Brush HostJob 带 `delivery: pending | delivered | terminated`：pending 结果保留供观察，delivered/terminated 的索引移除，但结果归宿主所有。每条记录报告 `wake_armed` 和真实的 `log_path`；Brush 运行期间报告原生 `pids`，而不是 shell `pid`。响应包含 `tool_time_utc`。

## 命令和参数

- `/unified-exec-sessions`——在选择器里列出存活会话（已启用唤醒的显示 `[wake]`），不经过模型就能结束选中的会话或全部会话，同样是 SIGTERM → 2 秒 → SIGKILL。
- `--keep-builtin-bash`——在 Pi 上，内置的 `bash` 工具默认会被移出活动工具集，让模型使用 `exec_command` / `write_stdin`；这个参数会保留它。

## 呈现

**在 omp 上，**`exec_command`、`write_stdin` 和 `kill_session` 通过 omp 导出的 bash 渲染器渲染，ANSI TUI 和 Tern 都一样：`$ cmd`，可用 omp 的展开快捷键展开的折叠输出，失败时的退出码标签和错误配色，运行中会话显示 `Backgrounded: session N`，最后一行是带日志路径的截断标记。`write_stdin` 和 `kill_session` 以 bash 注释的形式显示所做的动作（`# poll session N`、`# stdin → session N: "…"`、`# kill session N (SIGTERM)`）。`set_on_exit` 和 `list_sessions` 使用 omp 的默认卡片。如果 omp 的 bash 渲染器缺失或接口变了，插件会直接加载失败，而不是显示原始的结果包装。

**在 Pi 上，**五个工具都有各自的渲染器：命令标题、默认显示五个可视行的输出尾部（用 `app.tools.expand` 展开）、实时计时、`⟳ poll` / `» input` 标题，以及 kill/list 摘要。有进程存活时，底栏显示 `unified-exec: N sessions running`。

Pi 的输出契约不变；omp Brush 增加前述 artifact、图像、超时与 HostJob 元数据。宿主目前按工具名保留后台卡片：调用返回后，协议/任务进度继续更新，但扩展的原始卡片可能停留在旧输出。插件不修改该私有白名单，也不增加另一个 HUD。

## Codemode 脚本（Pi）

每个工具都声明了 `outputSchema` 并返回对应的 `structuredContent`，因此 Pi 的 codemode 脚本拿到的是对象：

```js
const r = await tools.exec_command({ cmd: "npm test", yield_time_ms: 30000 });
if (r.running) text(`still running as session ${r.session_id}`);
else text(`exit ${r.exit_code}`);
text(r.output); // print the output, not the whole object
```

结构定义在 `src/script-result.ts`。在 Pi 上，本包还会把折叠状态下的 codemode 结果限制在十个可视行（对所有嵌套工具生效，仅影响显示）；`PI_UNIFIED_EXEC_COMPACT_CODEMODE=0` 可关闭。omp 没有 codemode，所以在 omp 上不生效。

## 常量

```
MIN_YIELD_TIME_MS            = 250
MAX_YIELD_TIME_MS            = 30_000
MIN_EMPTY_YIELD_TIME_MS      = 5_000
DEFAULT_EXEC_YIELD_MS        = 10_000
DEFAULT_WRITE_STDIN_YIELD_MS = 250
EARLY_EXIT_GRACE_PERIOD_MS   = 150
HEAD_TAIL_MAX_BYTES          = 1 MiB   (in-memory drain buffer, pipe sessions)
TERMINAL_HISTORY_CELLS       = 240_000 (tty history between calls: cells / cols rows, at least one screen)
MAX_SESSIONS                 = 64
LRU_PROTECTED_COUNT          = 8
DEFAULT_MAX_BYTES            = 50 KiB  (model-visible per-call cap)
DEFAULT_MAX_LINES            = 2000
```

## 语义

- **真实进程提前退出：**150 毫秒内完成的命令不进入存储；Brush 在异步准备之前建立索引，原生执行/输出有独立生命周期。
- **在两次调用之间退出：**真实进程保留到被观察；HostJob 索引跟随宿主消费/保留状态，不重复交付。
- **启动失败：**omp cwd 错误在分配之前拒绝；真实进程 spawn 失败报告 `failure_message`。
- **shell 退出与管道关闭：**真实进程的 stdout 被继承时，会话保持打开。Brush 随其前台原生命令结束；保留的 `&` 任务属于 shell 生命周期，不会重新打开已结束的输出归档。
- **关闭了 stdin** 不会让宿主崩溃；写入时报告 `failure_message`。
- **Esc** 中断当前等待，但会话继续运行。
- **关闭：**Brush 经取消原语终止，并 dispose 自己拥有的 shell；真实进程收到 TERM，存活者再收到 KILL。
- **LRU 淘汰**在达到 64 个会话时进行，淘汰最旧的非保护会话，优先选已退出的；最近使用的 8 个永不淘汰。
- **tty 观察**按会话串行执行；流式更新和 Tern HUD 读取屏幕时不消耗它。
- **恢复：**真实进程日志在临时目录里，本包不删除。Brush 文本归宿主会话 artifact 生命周期所有；失败/部分捕获绝不链接为完整输出。查看原始 PTY 日志请用不执行控制序列的查看器，不要用 `cat`。

## 示例

### 开发服务器

```
> exec_command(cmd="npm run dev", shell="bash", yield_time_ms=5000)
[still running]
session_id: 1
---
> Server listening on :3000

> write_stdin(session_id=1, chars="", yield_time_ms=10000)
[still running]
---
  GET /health 200 in 3ms

> kill_session(session_id=1)
```

### 交互式 Python REPL

```
> exec_command(cmd="python3 -q", tty=true, yield_time_ms=1500)
[still running]
session_id: 1
terminal: normal screen 120x30, cursor row 1 col 5
---
>>>

> write_stdin(session_id=1, chars="print(7*6)\r", yield_time_ms=1000)
[still running]
terminal: normal screen 120x30, cursor row 3 col 5
---
>>> print(7*6)
42
>>>
```

### 带自动恢复的长任务（人要求时）

```
> exec_command(cmd="npm test", shell="bash", yield_time_ms=1000, on_exit="wake")
[still running]
session_id: 2
completion_notification: armed
---
# …the agent ends its turn; when npm test exits, one follow-up prompt resumes it.
> set_on_exit(session_id=2, on_exit="none")   # if the job is abandoned
```

## Windows

管道和 PTY 都可用；`tty: true` 通过 `Bun.Terminal`（Bun）或 node-pty（Node）使用 ConPTY。

- **真实进程默认 shell：**依次查找 `PI_UNIFIED_EXEC_BASH`、PATH 上的 `bash`（排除 System32 的 WSL 存根）、由 `git.exe` 推导或常见位置下的 Git for Windows，最后退回 `powershell` 并提示一次。启动前把 shell 名解析成绝对路径。
- **没有 POSIX 信号：**每次 kill 都是结束整个进程树（`taskkill /T /F`）；被结束的进程报告 `exit_code: 1`，kill 失败会如实报告。
- **Node PTY 预编译包**在安装时下载，不受 npm 摘要校验覆盖；Bun 内置的后端不需要这一下载。

## 目录结构

| 领域 | 文件 |
|---|---|
| 注册、会话与所有权 | `src/index.ts`、`session.ts`、`session-store.ts`、`completion.ts` |
| 观察与等待 | `src/head-tail-buffer.ts`、`collect.ts`、`long-wait.ts`、`time.ts`、`notify.ts` |
| 真实进程与终端 | `src/pty.ts`、`shell.ts`、`terminal-screen.ts`、`unescape.ts` |
| 结果与 Pi 呈现 | `src/tool-result.ts`、`script-result.ts`、`render.ts`、`codemode-render.ts`、`output-safety.ts`、`format-time.ts` |
| omp Brush 与原生 addon | `fork-features/brush/`、`fork-features/native/` |
| omp 卡片与 tty HUD | `fork-features/omp-presentation.ts`、`omp-tools.d.ts`、`tern-terminal-hud.ts` |
| Tern 安装/样式 | `fork-features/tern-plugin-install.ts`、`fork-features/tern-plugin/` |
| 契约与维护 | `docs/IV-0001-long-wait-and-wake-control.md`、`IV-0002-output-lifecycle-and-rendering.md`、`DC-0001-agentic-workspace.md`、`DEV.md`、`fork-features/README.md` |

## 测试

```bash
npm install
npm test                                   # strict typecheck + unit/integration suites
EXPECT_PTY=1 bun test ./tests/tern-terminal-hud.test.ts ./tests/omp-presentation.test.ts
npm run test:tui                           # Pi tmux acceptance (skips without tmux)
```

在 Node 下加载不到预编译包时，Node PTY 测试会跳过；Bun 那条命令会用真实的 PTY 会话跑 HUD 生命周期测试。Tern 上的行为在真实的 Tern 窗口里验证，做法见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

## 开发与上游

[docs/DEV.md](docs/DEV.md) 是上游的维护者指南（开发流程、测试方法、codex 源码对照）；其中的 npm 发布部分不适用于本 fork，因为 fork 的发布 workflow 已停用。上游改动通过每日的 `Sync upstream` workflow 合入；fork 改动如何与上游隔离、同步冲突如何处理，见 [fork-features/README.zh-CN.md](fork-features/README.zh-CN.md)。

与上游一样采用 [MIT](./LICENSE) 许可。
