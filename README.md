# Harness Relay

在不同 coding harness 之间接续同一个开发任务，保留任务目标、待办、验证结果和工作目录。目前支持 Codex、ZCode 和 CodeBuddy CLI 的原生 Hook 交接，其他 harness 可通过适配器接入。

通过 Hook 自动保存进展和交接，Skill 提供续接指导及可选任务笔记，通过 Git worktree 隔离同项目的并行任务。接入后，在目标客户端打开同一任务目录并正常发送消息即可继续工作。

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
node src/cli.mjs task-open task-实际编号 --in codebuddy
```

`task-open --in` 默认打印一条在新终端运行的命令，不启动客户端，也不改变当前会话目录。这样 agent 创建任务后可以结束本轮，避免嵌套客户端使原目录一直处于占用状态。Codex 使用 `CODEX_BIN` 或 PATH 中的 `codex`；Linux ZCode 默认 `/opt/ZCode/zcode`，可用 `ZCODE_DESKTOP_BIN` 覆盖。省略 `--in` 时只打印 worktree 路径。

需要自动打开独立终端时，配置本机已安装的终端启动器参数数组，例如支持该语法的 GNOME Terminal 可用 `HARNESS_RELAY_TERMINAL_JSON='["gnome-terminal","--"]'`，然后执行 `task-open <task-id> --in codex --terminal`。Relay 直接传递参数，不通过 shell 拼接；发出启动请求即返回，不等待 Codex 退出，也不声称已验证客户端就绪。当前环境没有终端启动器时，使用默认输出的命令手动打开即可。仅供用户在真实终端直接运行的 `--interactive` 保留前台启动方式；agent 不应使用它，即使工具分配了 PTY。

新窗口中先确认客户端显示的目录等于任务 worktree，再发送开发要求。新开一个仍指向原项目的窗口，或仅在消息中写“独立 worktree”，都不会产生隔离。

之后正常聊天即可：在任务 A 的 worktree 内，各 harness 可以接续 A 的进展；独立任务 B 使用另一个 worktree。打开窗口和发送消息都不直接抢占；模型先结合请求及历史判断意图，只有续接工作才申请执行权。

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

### 显式完成并合并任务

安装器会同时分发英文 `harness-handoff` 和 `harness-finish` Skill。可明确调用：

```text
使用 $harness-finish，将任务 task-实际编号合并到 main，验证通过后清理 worktree 和任务分支。
```

Skill 指导 agent 审查、测试、提交任务代码，再合并、验证，按请求清理或 push。新增 `task-integrate` 接受明确的源/目标提交、目标目录和验证命令参数数组，检查空闲状态、固定提交及干净工作区后执行合并和验证。默认保留 worktree 和分支，不自动 push。后台 worker 若已获任务中的合并授权，可登记 `task-plan-finish`，进程退出后自动尝试收尾，无需用户再次输入命令。未获授权时保持 review_pending；不根据 Stop 或退出码推断合并授权。

手动诊断入口（正常使用由模型处理）：

```text
node src/cli.mjs task-run <task-id> --in codex
node src/cli.mjs task-job <task-id>
node src/cli.mjs task-integrate <task-id> --target <target-worktree> --branch main --source-commit <full-SHA> --target-commit <full-SHA> --verify-json '["npm","test"]'
```

在活动的目标目录会话中，模型还需提供当前轮次的 `--lease`。其他目标会话活动、源工具未确认结束、提交变化、Git 冲突或验证失败时保留现场，不强行接管。结果与验证输出保存在任务目录的 `integration.json` 和验证日志中。收尾计划是模型根据用户授权登记的，不是独立的权限安全边界。

源任务必须空闲且无在途工具，目标目录不能有冲突中的 Git 操作或无关未提交改动。清理前再次验证提交已合入目标，并检查未跟踪及忽略文件；不会强制删除 worktree。多个任务逐个合并并验证。合并冲突或测试失败时保留现场与任务记录。

## 自动交接：日常直接使用 Codex / ZCode

一次性接入需要共享任务的项目：

```bash
cd /path/to/harness-relay
node src/cli.mjs setup-auto --cwd /path/to/project
```

安装器保留已有配置，并在改动前创建备份，写入用户级 `~/.codex/hooks.json` 和 `~/.zcode/cli/config.json`。Hook 使用 Node 和当前 checkout 的绝对路径；不要移动或删除该 checkout。自动交接只在明确启用的项目目录生效，其余目录直接放行。

在 Codex 中通过 `/hooks` 一次性审阅并信任新 Hook，然后两端新建会话。ZCode 使用官方用户级 Hook，无需再安装旧 bridge 插件。Codex 的信任属于客户端要求，安装器不篡改信任记录。

### CodeBuddy CLI

为已登记项目增加 CodeBuddy 接入（只修改 CodeBuddy 用户配置，不重新登记任务）：

```bash
node src/cli.mjs setup-auto --harness codebuddy
```

新项目可同时安装三端 Hook 并登记目录：

```bash
node src/cli.mjs setup-auto --cwd /path/to/project --harness codex,zcode,codebuddy
```

CodeBuddy 配置写入 `~/.codebuddy/settings.json`，两个 Skill 链接到 `~/.codebuddy/skills/harness-handoff` 和 `~/.codebuddy/skills/harness-finish`；可用 `CODEBUDDY_CONFIG_DIR` 指定配置目录。安装器保留原模型设置及其他 Hook，并备份被改动的配置。按[官方 Hook 指南](https://www.codebuddy.cn/docs/cli/hooks-guide)在 `/hooks` 面板检查配置；2.150.0 面板提示外部配置变更需重启。Web UI 的插件计数不包含用户级 Hook。安装器不修改客户端信任记录。在同一任务目录运行 `codebuddy`，发送普通消息即可接力，也可用 `task-open --in codebuddy`；自定义可执行文件用 `CODEBUDDY_BIN`。

CLI 2.150.0 中用户拒绝工具的交互路径可能不发送 PostToolUse/Stop。下一条消息会核对原生转录中的精确会话、轮次、调用编号、参数及用户拒绝记录，证实工具未启动才清理占用。同会话随后可以继续；其他会话仍需旧轮次的结束证据。普通执行失败、模糊取消文本、缺失或截断的证据不触发解锁。被拒绝的命令不会由恢复逻辑重新执行。

协议及一次真实命令闭环已用 CLI **2.150.0** 验证：`generation_id` 关联轮次，`tool_use_id` / `call_id` 关联工具，`PostToolUseFailure` 记录失败，Stop 保存最终回复。缺少必要编号的工具调用会被阻止，不按相同命令猜测关联；不带轮次编号的 SessionEnd 不会释放执行权。CodeBuddy 的 `continue:false` 在 Stop 上表示继续运行，因此 Relay 不用它要求会话结束。当前只接入原生 Hook、被动检查点、Skill 和 worktree 启动；旧的 `run/resume/takeover` 托管执行流程及其 `capabilities` 列表尚未接入 CodeBuddy。

之后的操作就是平常聊天：

- 在 Codex 发任务，系统自动建立项目任务记录。
- 换到 ZCode，在同一个目录发送“继续实现”或其他普通消息，自动注入此前进展与当前 Git 状态。
- 再回 Codex 发送“检查结果”，自动读取 ZCode 的工作记录。

不需要用户填写 task ID、bind、unbind、takeover，也不要求先耗尽额度。已有原生会话保留自己的历史，新会话接收共享记录，不自动恢复另一个客户端的隐藏状态。

### 模型判断意图，Hook 执行边界

原生消息 Hook 先注入当前任务、最近请求和结束回复供当前模型判断，不调用另一个模型，也不按关键词直接抢占。普通问题可以直接回答；在执行工具前，模型调用注入的内部 `route` 命令选择续接、问答或独立开发。用户不必表达模式，也不必调用 Skill。判断依赖模型，不能保证永远准确；有影响操作结果的歧义时仍需澄清。

问答保存在该会话的 `routes/<id>/route.json`，不污染开发任务检查点，不设置接管等待，也不停止原任务。当前问答通道只允许直接文字回答；需要工具检查时模型须申请续接。续接取得写入权后才注入完整交接材料。独立开发自动创建新的 managed worktree；重复相同决定不会创建重复任务。票据按目录、harness、会话和轮次关联，过期决定不能抢占已经推进的任务。部署前已开始的旧轮次继续受原工具守卫管理。

独立 worktree 创建后，`new` 路由自动启动独立后台 worker，将任务要求直接交给客户端，不再依赖桌面终端，也不要求用户复制第二条命令。Codex 使用 `exec --json`，CodeBuddy 使用 `-p --output-format json --permission-mode bypassPermissions`；CodeBuddy 的后台进程没有可交互的权限确认界面，因此任务入队后会显式使用无人值守权限模式。ZCode 需要已配置的非交互启动参数模板，未配置时保留任务并报告限制，不换 harness。Hook 提供模型名时传给新 worker；其他设置沿用该 CLI 配置。当前原生会话目录仍不改变。

启动器立即返回，持久化的 `job.json` 防止重复启动；独立进程将输出写入任务目录的 worker 日志，保存退出码、可识别的最终答复和失败状态。`review_pending` 仅表示进程成功返回；已授权的收尾计划成功后才为 `integrated`，被占用或验证失败则为 `integration_blocked`。后续消息注入同项目最近后台任务的简短状态，`status` 也展示后台状态。当前没有向闲置原生聊天窗口主动推送消息的 API；结果在下一轮查询/聊天时可见。

后台任务期间其他 Relay 会话不能接管其 worktree。进程崩溃导致的 queued/running 残留不会根据计时自动重新执行任务，避免重复副作用；未完成的计划和日志保留供核对。受控后台执行不等于隔离沙箱，客户端的路径和权限约束仍由其自身执行。

完整链路已用 CodeBuddy CLI 2.150.0 的真实模型和临时 Git 仓库验收：自然语言被判断为独立任务，Relay 创建 worktree 并启动后台 worker，模型修改代码、运行测试并提交，原生进程退出后 Relay 合并到 `main`、再次运行测试并清理任务 worktree 和分支。错误保留、提交漂移、脏目标目录、冲突和验证失败另有进程级测试。后台结果并非实时推送到原窗口。

已通过 CodeBuddy CLI 的真实模型测试：活动任务旁的普通时间问题直接作答，原任务状态完全不变；“继续完成刚才留下的验证”由模型调用内部路由并执行验证命令，Pre/Post/Stop 闭环结束后无工具残留。Codex 与 ZCode 的新路由通过协议测试；不据此声称所有客户端的模型判断都已实测。

如果旧会话仍在执行，新消息的 Hook 会等待最多 45 秒，旧会话后续工具会被拒绝，正在运行的工具需先收到完成事件；确认本轮停止后才转交。等待超时会阻断本次消息并说明原因，不会按时间强行认定旧进程已停止。客户端崩溃、取消后漏报工具完成、其他 Hook 要求继续等情况可能需要人工处理；不能保证任意外部进程都能自动中止。

Codex 的同步 `apply_patch` 校验失败可能缺少 `PostToolUse`。当日志同时记录同一会话、同一轮次的补丁开始和后续 Stop 时，Relay 会释放这条残留工具记录，并将结果标为未知，避免下一条消息永久等待。此规则不适用于 Bash、MCP、未知工具或仅收到 Interrupt/SessionEnd 的情况；不会把释放记录当作补丁成功。

如果连 Stop 也漏报，下一条消息会核对原生转录中的会话、工作目录、轮次及 `task_complete` 时间。精确匹配才补记轮次结束，并清理此前的同步补丁占用；日志注明原生证据来源，不伪造 Stop。Bash、MCP 等未确认工具仍保留。证据缺失、截断或位于读取窗口之外时继续等待，不凭空闲时长或最终回复文字解锁。

异步 Bash 命令即使没有被再次轮询，也可能已在原生转录中留下 `item_completed / CommandExecution`。Relay 会匹配会话、轮次、调用编号、目录、完整命令和时间，只有终态与整数退出码同时存在才清理占用。先收到 SessionEnd 也不会跳过后续原生核对；仅有进程编号、仍执行中或缺少退出码时保留占用。退出码只证明命令返回，不代表其中每个步骤或业务验收成功。

会话目录按原生 `turn_context` 核对；命令可以显式在另一个绝对路径下执行，有 Hook `workdir` 时另行核对执行目录。工具完成核对默认读取转录末尾 4 MiB，未匹配时最多扩大到 16 MiB，覆盖终端大量输出挤出轮次信息的情况；仍无精确证据则保留占用。维护恢复只会清理已过期的交接等待，不会覆盖有效的接管请求。

对于 Codex 创建进程前拒绝的 Bash 调用，Relay 会在 Stop 后核对原生转录中的会话、轮次、单次字面量 `exec_command` 调用、完整命令、开始时间及对应的 `CreateProcess Rejected` 错误。证据匹配才释放记录，并标记为“未启动”。此兼容逻辑目前识别 `const r = await tools.exec_command({...}); text(JSON.stringify(r));` 形式；转录格式变化、证据缺失、复杂或并行脚本、已启动的进程均不会据此释放。读取限于转录头部和末尾 4 MiB，核对不会重新执行命令。

每个 worktree（或单独启用的目录）只关联一个主任务，不同 worktree 可以并行。直接创建未受管理子智能体的调用会被阻止；Relay 自身的后台任务有独立 worktree、持久化任务记录及占用守卫。Hook 不是完整进程隔离机制，未接入的终端、已有未加载 Hook 的会话及绕过 Hook 的操作不受它控制。

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

Hook 每次接收有效请求、工具事件或轮次结束事件时，先追加日志，再原子更新 `tasks/<task-id>/passive.json`。不调用模型，也不要求 agent 执行 `task-state` 或生成最终回复。检查点保存最近 6 轮请求及每轮最近 16 个工具观察；更早内容保留在日志，省略不代表完成。检查点失败后的下一事件会按日志字节游标补放尚未保存的事件。只有已收到的事件能保存；完全缺失的事件无法凭空恢复。

新消息注入之前的被动进展，包含中断轮次、操作返回及未知状态；Git 概况在接手时读取，属于整个工作区，不归因给某一会话。普通问答不会清除之前的结构化待办。`task-state` 改为可选语义增强，用于长期决策和明确待办，交接不依赖 agent 调用。没有结构化状态时显示未知，不推断任务验收通过。

被动持久化不等于自动解锁：Interrupt/SessionEnd 且无在途工具时可正常交接；若进程突然消失、客户端没报结束，或仍有未确认工具，继续阻止接管，直到取得结束证据。不会根据额度错误文本或等待时间强行放行。

每次写入是按稳定事项 ID 的增量更新：省略旧事项不会删除它，完成、取消、验证通过或约束失效必须显式标记，并提供依据或原因。修改代码和验证通过是两条独立事实；Stop 只改变轮次运行态。任务更新需要当前活动轮次的租约及正确版本，旧轮次、其他 worktree、已交接会话、交接等待期间的写入都会被拒绝。租约是防止过期写入的本地关联标识，不是独立的账户权限系统。

```bash
# 仅在需要完整任务状态时读取，不需要逐个翻查历史日志
node src/cli.mjs task-state --cwd /path/to/task-worktree
```

摘要仍限制为 8 KiB，优先展示阻塞、有效约束和未完成事项。事项过多时明确提示省略数量，完整状态保留在任务记录，可通过上述命令定向读取。单项文本有长度限制，整个状态最多 256 KiB；超限更新报错并保留旧记录，不静默清空待办。

可选语义记录依赖 agent 执行更新入口以及客户端允许该命令写入状态目录；被动检查点不依赖这个入口。进程突然结束前未保存的模型内部想法无法恢复；写入失败时必须明确说明。未提供更新入口的旧手动 bridge 流程仍使用原有摘要，不声称已有持续状态能力。其他 harness 需要提供对应的轮次事件、状态更新入口及客户端权限适配。

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
