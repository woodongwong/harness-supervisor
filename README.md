# Harness Supervisor

给原生 Codex 和 ZCode 保存一份可交接的任务记录。Codex 额度用完时，保存已经观察到的过程和当前 Git 变更，让 ZCode 继续；之后也能交回原来的 Codex 会话。

不需要 Octos，不替换两者的模型配置，也不合并多个 Plus 账号的额度。

## 快速开始

需要 Node.js 20+，以及已经登录的 Codex CLI。无需安装 npm 依赖。在本仓库目录运行：

```bash
node src/cli.mjs run \
  --cwd /home/woodong/projects/jnht/cy-admin.tjjnht.cn \
  --task "填写你这次要完成的具体任务"
```

默认使用 Codex；遇到额度、认证、连接或进程失败时转交 ZCode。没有配置 ZCode 非交互启动器时，状态为 `awaiting_manual`，打印交接材料路径和下一步命令，不会伪造自动启动成功。此时退出码为 2，并非交接材料生成失败。

Codex 使用本机配置及登录状态。需要限制执行权限时，可配置：

```bash
export CODEX_SUPERVISOR_ARGS_JSON='["--sandbox","workspace-write"]'
```

不希望自动准备交接时，加 `--fallback none`。先用 ZCode 时，加 `--primary zcode --fallback codex`，生成材料后按下文手动接管。

## 第一次接入 ZCode

本仓库根目录的 `marketplace.json` 是本地插件市场入口：

1. 在 ZCode 打开项目，然后进入 **设置 → 插件 → 创建 → 添加插件市场**。
2. 添加本仓库目录或其中的 `marketplace.json`。
3. 安装并启用 `harness-supervisor-bridge`。
4. 在 **设置 → Hooks** 确认桥接插件的事件条目存在。

插件遵循 [ZCode 官方 Hook 协议](https://zcode.z.ai/cn/docs/hooks)。ZCode 中运行 Hook 的环境需要能找到 `node`。启用插件或改动 Hook 后要新建会话。

## Codex → ZCode

如果任务已显示 `awaiting_manual`，直接绑定；也可以主动生成交接材料：

```bash
node src/cli.mjs takeover task-实际编号 --to zcode
node src/cli.mjs bind-zcode task-实际编号
```

在 ZCode 打开输出中指定的同一个项目目录，**新建会话**，发送“继续交接任务”。插件会注入材料位置和摘要，并记录提示、工具操作、最终回复及临时 transcript 的快照。

绑定后，第一个在该目录触发 SessionStart 的会话会认领任务；其他会话不会混入同一份任务记录。需要换一个 ZCode 会话时，先停止原会话，再 unbind、bind、新建会话。

没有启用插件时，也可以把 `context.md` 的内容手动交给 ZCode，但不会自动记录 ZCode 过程。

## ZCode → Codex

先在 ZCode 停止该任务，等正在运行的工具结束，再执行：

```bash
node src/cli.mjs unbind-zcode task-实际编号
node src/cli.mjs takeover task-实际编号 --to codex \
  --feedback "说明已完成内容、剩余问题或验收要求"
```

如果该任务已有 Codex thread ID，会恢复原会话，并补充近期 ZCode 记录和当前 Git 状态。没有旧 ID 时创建新 Codex 会话。ZCode 的 Stop 事件只表示一轮停止，不自动判定整个任务验收通过。

## 查看、继续、取消

```bash
node src/cli.mjs status task-实际编号
node src/cli.mjs status task-实际编号 --json
node src/cli.mjs resume task-实际编号
node src/cli.mjs capabilities
```

`resume` 继续当前自动执行器；等待手动交接的任务需显式 `takeover`。执行中的任务可按 Ctrl+C；也可在 run/resume/takeover 后加 `--timeout-seconds 300`。取消会终止子进程，在 POSIX 系统上终止其进程组，不会触发备用执行器。

`run`、`resume`、`takeover` 支持 `--json`，退出码：完成 0、等待手动接管 2、失败或取消 1。这里的“完成”表示原生执行器成功返回，验收仍以实际变更和测试为准。

## 状态保存在哪里

默认 `~/.harness-supervisor/tasks/<task-id>/`：

```text
task.json                 任务、状态、原生会话 ID 和执行记录
events.jsonl              supervisor 和 Codex 的持久事件
external-events.jsonl     ZCode 插件事件
context.md                最近一次生成的交接材料
native/zcode-*.jsonl       ZCode transcript 快照（有大小限制）
```

可用 `HARNESS_SUPERVISOR_HOME` 改目录；**桌面 ZCode 的 Hook 进程也需要同一个环境变量**，否则找不到绑定。普通使用建议保持默认路径。

同一存储目录中的执行器按真实项目路径互斥；ZCode 绑定也会阻止新自动执行器进入该目录。手动启动的其他终端/应用不受此锁控制，请停止旧执行器后再交接。不要通过不同存储目录并发操作同一项目。

强制结束 supervisor 后可能留锁。确认其子进程也已停止，再使用 `unlock <task-id>`；仍在运行的 supervisor 不允许解锁。

Hook 对常见密钥字段做了脱敏，但 Codex 事件、Git diff 和交接材料可能包含项目敏感内容，整个状态目录应作为本地工作数据保管。交接上下文是有大小限制的近期记录，不能恢复不可观察的模型内部状态。

## 自定义 ZCode 启动器（可选）

仅在你已有可用的非交互启动器时配置：

```bash
export ZCODE_BIN=/path/to/your/launcher
export ZCODE_SUPERVISOR_ARGS_JSON='["--prompt","{prompt}"]'
export ZCODE_SUPERVISOR_RESUME_ARGS_JSON='["resume","{session}","--prompt","{prompt}"]'
```

以上参数只是模板示例，不是对 ZCode 桌面程序参数的承诺。支持 `{prompt}`、`{session}`、`{cwd}`、`{task}`。`capabilities` 中 ZCode 的 `headless: true` 仅表示显式配置了模板，不能证明该启动器可用；原生恢复参数也需要自行验证。

## 开发与验证

```bash
npm test
npm run check
```

测试包括真实 CLI 子进程驱动的模拟额度交接、Hook 协议、异步事件落盘、会话恢复参数、工作目录互斥、取消和中文大上下文限制；不会消耗模型额度。

Codex 的真实调用/恢复已在本机验证。ZCode Hook 的协议测试已通过，但尚未完成安装插件后的真实桌面模型接管验证，不能据此宣称双端全自动接管已跑通。
