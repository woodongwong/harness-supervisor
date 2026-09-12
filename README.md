# Harness Relay

在不同 coding harness 之间接续同一个开发任务，保留任务目标、待办、验证结果和工作目录。目前支持 Codex 和 ZCode，其他 harness 可通过适配器接入。

通过 Hook 自动交接，通过 Skill 维护跨轮次任务状态，通过 Git worktree 隔离同项目的并行任务。接入后，在目标客户端打开同一任务目录并正常发送消息即可继续工作。

首次使用请从[自动交接配置](#自动交接日常直接使用-codex--zcode)开始；需要并行开发时，为每个独立任务[创建 worktree](#同项目并行一个任务一个-worktree)。

## 同项目并行：一个任务一个 worktree

已有至少一次提交的 Git 仓库可以创建多个独立任务。先完成下文的一次性 Hook 接入与信任，然后创建任务：

```bash
node src/cli.mjs task-new --repo /path/to/git-repo --name login --task "修复登录问题"
node src/cli.mjs task-new --repo /path/to/git-repo --name report --task "优化报表页面"
node src/cli.mjs task-list --repo /path/to/git-repo
```

每次创建都会生成独立的 task ID、`harness/<task-id>` 分支和 worktree，预先登记任务目标并启用自动交接。目录默认放在 `~/.harness-relay/worktrees/<项目编号>/`，命令会打印具体路径。默认基于当前 `HEAD`，也可用 `--base main` 指定本地分支或提交；**原工作目录的未提交改动不会复制到新任务**。

```bash
node src/cli.mjs task-open task-实际编号 --in codex
node src/cli.mjs task-open task-实际编号 --in zcode
```

`task-open` 启动原生客户端，并传入该任务的 worktree 路径；不发送任务消息、不更换模型。Linux 上 ZCode 桌面程序默认 `/opt/ZCode/zcode`，其他安装位置可设置 `ZCODE_DESKTOP_BIN`。ZCode 的目录打开行为需以所装客户端实际支持为准；也可省略 `--in` 查看路径，再在客户端手动打开该目录。Codex 使用 `CODEX_BIN` 或 PATH 中的 `codex`。

之后正常聊天即可：在任务 A 的 worktree 内，Codex 与 ZCode 自动共享 A 的进展；任务 B 使用另一个 worktree，可以同时运行。仅打开窗口不抢占，实际发送消息时才交接。两端必须打开命令打印的同一个任务 worktree，打开原始仓库目录不会猜测你想接续哪个任务。

worktree 及其子目录、指向它们的符号链接都关联同一个任务；嵌套的另一个 Git 仓库不会继承父任务。列表按 Git 公共仓库目录分组，从主仓库或任意关联 worktree 查询都能看到同项目任务。

### 当前会话属于哪个任务

会话启动时 Hook 提供任务身份，首次认领或执行权变化后的摘要会要求 agent 用一行展示任务名、worktree 和执行者。这是模型收到的提示，不是客户端常驻状态栏。想随时确认，可在当前会话的目录执行：

```bash
node /path/to/harness-relay/src/cli.mjs status
# 或显式指定目录 / 查看整个项目
node src/cli.mjs status --cwd /path/to/task-worktree
node src/cli.mjs status --repo /path/to/git-repo --json
```

输出包含当前目录关联的任务 ID、目录、登记分支、执行会话、交接等待和同项目任务列表。执行会话是当前持有执行权的会话，不一定是查询所在的会话。仅查看身份不会认领任务；原始仓库未关联任务时也不会自动选中某个 worktree。`status <task-id>` 保留原有查看任务记录的用法。

工作结束后：

```bash
node src/cli.mjs task-close task-实际编号
```

关闭只允许在任务空闲、无在途工具和交接等待时进行。关闭后阻止旧会话继续执行，但保留 worktree、未提交改动、分支及任务记录；随后可自行审查、测试并合并分支。不会自动提交、合并或删除 worktree。分支可能修改同一处代码，最终合并仍可能产生冲突。自动重开和清理尚未提供。

创建失败会保留任务记录和可能已创建的目录以供检查，不会强制删除。不是 Git 仓库、没有提交或基点无效时，创建命令会报错，工具不会擅自初始化业务目录。

## 自动交接：日常直接使用 Codex / ZCode

一次性接入需要共享任务的项目：

```bash
cd /path/to/harness-relay
node src/cli.mjs setup-auto --cwd /path/to/project
```

安装器保留已有配置，并在改动前创建备份，写入用户级 `~/.codex/hooks.json` 和 `~/.zcode/cli/config.json`。Hook 使用 Node 和当前 checkout 的绝对路径；不要移动或删除该 checkout。自动交接只在明确启用的项目目录生效，其余目录直接放行。

在 Codex 中通过 `/hooks` 一次性审阅并信任新 Hook，然后两端新建会话。ZCode 使用官方用户级 Hook，无需再安装旧 bridge 插件。Codex 的信任属于客户端要求，安装器不篡改信任记录。

之后的操作就是平常聊天：

- 在 Codex 发任务，系统自动建立项目任务记录。
- 换到 ZCode，在同一个目录发送“继续实现”或其他普通消息，自动注入此前进展与当前 Git 状态。
- 再回 Codex 发送“检查结果”，自动读取 ZCode 的工作记录。

不需要 task ID、bind、unbind、takeover，也不要求先耗尽额度。仅打开窗口不会触发切换；发送消息才表示该会话要继续工作。已有原生会话保留自己的历史，新会话接收共享记录，不自动恢复另一个客户端的隐藏状态。

如果旧会话仍在执行，新消息的 Hook 会等待最多 45 秒，旧会话后续工具会被拒绝，正在运行的工具需先收到完成事件；确认本轮停止后才转交。等待超时会阻断本次消息并说明原因，不会按时间强行认定旧进程已停止。客户端崩溃、取消后漏报工具完成、其他 Hook 要求继续等情况可能需要人工处理；不能保证任意外部进程都能自动中止。

每个 worktree（或单独启用的目录）只关联一个主任务，不同 worktree 可以并行。直接创建子智能体的调用会被阻止，交接材料也要求不要启动脱离会话的后台写入。Hook 不是完整进程隔离机制，未接入的终端、已有未加载 Hook 的会话及绕过 Hook 的操作不受它控制。

```bash
node src/cli.mjs auto-status --cwd /path/to/project
```

状态位于 `~/.harness-relay/auto/<目录哈希>/state.json`，记录 taskId、owner、pending 和未完成 tools。过程仍写入 `tasks/<task-id>/`。一个启用目录关联一份任务记录，最新用户消息优先；不会猜测新会话是否代表另一项业务任务。`setup-auto` 单独启用的普通目录仍按精确真实路径匹配；`task-new` 创建的 worktree 自动覆盖子目录。

### 交接文档的体积

自动和手动接管都使用同一份摘要生成器，`context.md` 最多 **8 KiB（UTF-8 字节）**。它按固定规则提取最新要求、近期进展声明、命令退出码、失败记录和变更文件；声明不等于已验收，未观察到的待办状态不会被猜测。生成摘要不调用额外模型。

`context.md` 是带生成时间的快照，不是实时状态页。自动模式通常在提交消息时生成，因此随后收到 Stop 后，旧文件可能仍显示生成时的“执行中”；这时用 `status` 查看实时运行态即可。快照中的写入租约只在原活动轮次有效，重读旧文件不会恢复权限。不会为了刷新显示而在每个工具事件后重新扫描 Git、重写整份摘要。

工具响应正文、原始事件 JSON 和完整代码 diff 不放入摘要。Git 只读取文件状态与 diff 统计；非仓库或命令失败只记简短原因。原始过程仍在日志及 transcript 快照中按需查阅。自动 Hook 已直接注入摘要，模型无需再读取 `context.md`；若仍读取，相关工具事件只保留标记，避免把文档正文再次收进交接日志。已有旧日志也会在摘要阶段过滤。

摘要采用原子替换，避免读到半份文件。维护时重建旧摘要会先备份，只允许在会话和在途工具均已结束后进行，不改变任务执行权。

### 交接 Skill 与当前会话重点

插件附带英文 [harness-handoff Skill](zcode-plugin/skills/harness-handoff/SKILL.md)，说明如何续接、何时才需要查原始日志，以及如何管理并行任务。`setup-auto` 会将同一份 Skill 链接到 Codex 和 ZCode 的用户技能目录；ZCode 可在“设置 → 技能”刷新，Codex 新会话重新发现。Skill 使用英文说明，回复仍遵循用户语言。安装器保留已有的其他同名技能，不直接覆盖。

摘要优先展示最近相关会话的请求、最终回复及 Stop 状态，不再把普通目录最初的测试消息当作永久任务重点，也不夹带其他旧会话指向过期转录的回复。每个 harness 的最近结束轮次会单独保存，请求不会因为工具事件太多被近期日志窗口挤掉。长回复保留末尾，避免丢失尚未执行的测试或待办。worktree 的登记目标仍单独保留。

### 持续任务状态：问答不覆盖开发待办

最近一轮回复与长期任务状态分开保存。`tasks/<task-id>/task.json` 的 `progress` 字段保存目标、任务名、工作项、验证结果、约束和决策，带版本号及来源 harness/session。比如登录代码写完、测试待运行，此时插入“项目是什么”的问答，再换 harness，摘要仍会传递待运行的登录测试。

英文 Skill 指导 agent 在开发进展变化时自动调用摘要提供的 `task-state` 入口，用户无需额外发出交接或记账指令。普通问答不必更新状态；程序不会从任意自然语言里猜测任务已经完成。首次启用该机制的旧任务会显示“尚未建立结构化任务状态”，不会假装已经还原了所有历史待办。

每次写入是按稳定事项 ID 的增量更新：省略旧事项不会删除它，完成、取消、验证通过或约束失效必须显式标记，并提供依据或原因。修改代码和验证通过是两条独立事实；Stop 只改变轮次运行态。任务更新需要当前活动轮次的租约及正确版本，旧轮次、其他 worktree、已交接会话、交接等待期间的写入都会被拒绝。租约是防止过期写入的本地关联标识，不是独立的账户权限系统。

```bash
# 仅在需要完整任务状态时读取，不需要逐个翻查历史日志
node src/cli.mjs task-state --cwd /path/to/task-worktree
```

摘要仍限制为 8 KiB，优先展示阻塞、有效约束和未完成事项。事项过多时明确提示省略数量，完整状态保留在任务记录，可通过上述命令定向读取。单项文本有长度限制，整个状态最多 256 KiB；超限更新报错并保留旧记录，不静默清空待办。

此自动记录依赖 agent 执行 Skill 的更新入口以及客户端允许该命令写入 supervisor 状态目录。进程突然结束前未保存的模型内部想法无法恢复；写入失败时必须明确说明。未提供更新入口的旧手动 bridge 流程仍使用原有摘要，不声称已有持续状态能力。其他 harness 需要提供对应的轮次事件、状态更新入口及客户端权限适配。

`task-state` 返回 `observedAt` 和 `progressAssessment`：`uninitialized` 表示尚未建立状态；`no_work_items` 表示尚未登记工作或验证事项；`pending` 表示有登记待办；`recorded_items_resolved` 只表示已登记事项均已结束。前两者不能解释为“没有历史待办”，最后一种也不是全部历史任务已验收。摘要把上一轮回复明确标为原会话陈述，不将其中“没有遗留待办”等说法自动提升为已核实事实。

Git 文件清单按顶层目录聚合。Skill 要求普通问答已作答时简短续接；只有明确矛盾、必要信息缺失或用户要求审计，才针对来源会话查证。摘要自身也带有简短的相同默认规则，不能假定每个模型都会自动加载 Skill。Stop 表示轮次结束，不能据此推断开发任务验收通过。

会话检查点与摘要按通用 harness 标识工作。`src/harness-integrations.mjs` 只登记目前真正实现的 Hook 控制能力；新增 harness 时还需实现原生事件映射、启动/恢复入口、技能分发与必要的客户端验证。

以下旧命令行模式仍可用于未启用自动交接的目录。同一目录不能混用两种执行权管理流程。

## 快速开始

需要 Node.js 20+，以及已经登录的 Codex CLI。无需安装 npm 依赖。在本仓库目录运行：

```bash
node src/cli.mjs run \
  --cwd /path/to/project \
  --task "填写你这次要完成的具体任务"
```

默认使用 Codex；遇到额度、认证、连接或进程失败时转交 ZCode。没有配置 ZCode 非交互启动器时，状态为 `awaiting_manual`，打印交接材料路径和下一步命令，不会伪造自动启动成功。此时退出码为 2，并非交接材料生成失败。

Codex 使用本机配置及登录状态。需要限制执行权限时，可配置：

```bash
export CODEX_RELAY_ARGS_JSON='["--sandbox","workspace-write"]'
```

不希望自动准备交接时，加 `--fallback none`。先用 ZCode 时，加 `--primary zcode --fallback codex`，生成材料后按下文手动接管。

## 第一次接入 ZCode

本仓库根目录的 `marketplace.json` 是本地插件市场入口：

1. 在 ZCode 打开项目，然后进入 **设置 → 插件 → 创建 → 添加插件市场**。
2. 添加本仓库目录或其中的 `marketplace.json`。
3. 安装并启用 `harness-relay-bridge`。
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

默认 `~/.harness-relay/tasks/<task-id>/`：

```text
task.json                 任务、状态、原生会话 ID 和执行记录
events.jsonl              supervisor 和 Codex 的持久事件
external-events.jsonl     ZCode 插件事件
context.md                最近一次生成的交接材料
native/zcode-*.jsonl       ZCode transcript 快照（有大小限制）
```

可用 `HARNESS_RELAY_HOME` 改目录；**桌面 ZCode 的 Hook 进程也需要同一个环境变量**，否则找不到绑定。普通使用建议保持默认路径。

同一存储目录中的执行器按真实项目路径互斥；ZCode 绑定也会阻止新自动执行器进入该目录。手动启动的其他终端/应用不受此锁控制，请停止旧执行器后再交接。不要通过不同存储目录并发操作同一项目。

强制结束 supervisor 后可能留锁。确认其子进程也已停止，再使用 `unlock <task-id>`；仍在运行的 supervisor 不允许解锁。

Hook 对常见密钥字段做了脱敏，但 Codex 事件、Git diff 和交接材料可能包含项目敏感内容，整个状态目录应作为本地工作数据保管。交接上下文是有大小限制的近期记录，不能恢复不可观察的模型内部状态。

## 自定义 ZCode 启动器（可选）

仅在你已有可用的非交互启动器时配置：

```bash
export ZCODE_BIN=/path/to/your/launcher
export ZCODE_RELAY_ARGS_JSON='["--prompt","{prompt}"]'
export ZCODE_RELAY_RESUME_ARGS_JSON='["resume","{session}","--prompt","{prompt}"]'
```

以上参数只是模板示例，不是对 ZCode 桌面程序参数的承诺。支持 `{prompt}`、`{session}`、`{cwd}`、`{task}`。`capabilities` 中 ZCode 的 `headless: true` 仅表示显式配置了模板，不能证明该启动器可用；原生恢复参数也需要自行验证。

## 开发与验证

```bash
npm test
npm run check
```

测试包括真实 CLI 子进程驱动的模拟额度交接、Hook 协议、异步事件落盘、会话恢复参数、工作目录互斥、取消和中文大上下文限制；不会消耗模型额度。

自动交接另有跨进程测试：普通消息双向切换、打开窗口不抢占、等待工具完成和 Stop、超时不抢占、迟到事件隔离、安装器保留原配置与幂等。Codex 的真实调用/恢复已在本机验证。ZCode Hook 的协议测试已通过，但真实桌面模型接管尚待验证，不能据此宣称双端端到端已跑通。

协议依据：[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[ZCode Hooks](https://zcode.z.ai/cn/docs/hooks)。安装或修改配置后，请按客户端规则信任 Hook 并重新建立会话。
