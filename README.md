# opencode-superagent

Router + Worker 的 OpenCode 插件：把一件事派给独立会话去跑，完成后用只读审查代理验收，再把一条摘要送回原会话。

## 为什么是两个包

OpenCode 的插件加载位置决定了它能提供什么：

| 部分 | 必须放哪里 | 原因 |
|---|---|---|
| 服务端（工具、账本、看门狗、审查） | `~/.config/opencode/plugins/superagent/` | 这个位置对所有项目目录生效；放 `~/.opencode/plugins/` 只在主目录生效，项目会话里看不到工具 |
| TUI（侧边栏、`/sa`） | `~/.opencode/plugins/superagent-tui/` | 该位置实测可用：`/api/plugin` 报 `features {server: true, tui: true}`、`status active` |

宿主解析入口的规则（从二进制里核过）：目录里有 `package.json` 且带 `name` + `exports` 时，服务端取 `exports["."]`、TUI 取 `exports["./tui"]`，按包自引用解析；根目录的 `index.ts` / `tui.ts` 只是兜底垫片，不是主入口。

> 早期把 TUI 放 `.config` 时只报 `features.server`。按上面的规则，先查那份 `package.json` 有没有 `exports["./tui"]`，再判断是不是目录本身的限制——这一条至今没有查清，别当成结论引用。

两个包只通过磁盘上的账本镜像通信：

```
~/.local/share/opencode/superagent/tasks.json
```

## 安装

```sh
git clone https://github.com/lichenzhao060507/opencode-superagent.git
cd opencode-superagent
npm run build          # 编译 TUI 部分（需要 babel，见下）
node scripts/sync.mjs  # 复制到两个插件目录
```

`build.mjs` 会依次找 babel：本仓库 `node_modules`、`SUPERAGENT_BABEL_ROOT`、`~/.opencode/plugins/tui-polish`、`~/.opencode/plugins/tavily-quota`、`~/.opencode/plugins/wesearch`。都找不到时先 `npm i -D @babel/core @babel/preset-typescript babel-preset-solid`。

装完 `/reload`。

## Agent 设定（profiles）

把「提示词 / 记忆 / 用哪些 MCP / 用哪些 skill / 默认审查类型」打包成一个可复用的 agent，派活时按名字引用。

存放位置：`~/.local/share/opencode/superagent/profiles.json`（TUI 和命令行都能改）。

```
superagent_profile_save({
  name: "文献综述",
  description: "读文献、整理引用、写综述骨架",
  gate: "cite",
  agent: "build",
  model: "deepseek/deepseek-flash",
  prompt: "你负责文献工作：先读再写，引用必须可核实。",
  memory: "文献笔记在 Obsidian；不臆造 DOI。",
  mcp: ["zotero", "obsidian"],
  skills: ["lit-review"]
})
```

派活时：

```
superagent_task_dispatch({ title, brief, profile: "文献综述" })
```

设定会整套带进 worker 会话——prompt、记忆、MCP 偏好、skill 列表全部进任务说明，`gate` 成为默认审查类型。

**同时会写一份 OpenCode agent 定义**到 `~/.config/opencode/agents/<名字>.md`（`mode: all`），所以它直接出现在 `@` 列表里：

```
@文献综述 帮我看看这三篇的引用有没有对不上的
```

派活时如果不指定 `agent`，默认用这个 agent 定义；定义文件还没被 OpenCode 发现时自动退回默认 agent，并在账本里记一条备注。

**边界**：`mcp` 和 `skills` 是**指令级**约束（写进 system prompt 让 worker 优先使用），不是沙箱级的工具隔离——OpenCode 没有"按会话禁用某几个 MCP 工具"的接口。真正硬隔离的只有 `denySubagent`（用 permissions 实现）。

## 工具

| 工具 | 作用 |
|---|---|
| `superagent_plan` | 给一句想法，拆成标题 / 自包含说明 / 建议 agent / 审查类型 / 验收点，并给出可直接调用的 dispatch |
| `superagent_task_dispatch` | 派活，立即返回任务 id |
| `superagent_task_status` | 看账本 |
| `superagent_task_cancel` | 中断并记账 |
| `superagent_profile_save` | 新建/更新一个 agent 设定，同时写出 agent 定义文件 |
| `superagent_profile_list` | 列出所有 agent |
| `superagent_profile_remove` | 删除 agent 及定义文件 |

## 想法 → 任务

```
superagent_plan({ idea: "想比较两种口径的能耗强度，看结论会不会翻转" })
```

返回：

```
建议任务：2609项目能耗强度口径对比
目标：… 范围：… 验收：… 约束：…
验收点：
- 确认两种口径定义及数据字段映射
- …
确认后这样派：
superagent_task_dispatch({ title: "…", brief: "…", gate: "data" })
```

只给建议，不自动派发。用的是 `ctx.experimental.generate.text`，模型由 `planModel` 控制（默认 `deepseek/deepseek-flash`）。

## 工具

## 一次派活发生了什么

1. 检查并发上限（默认 2）。
2. 建任务目录 `<dir>/.superagent/<task-id>/`。
3. 建独立会话（独立上下文、指定目录），禁止再派子代理。
4. 下发固定模板的任务说明，要求把结果写成 `RESULT.md`（结论 / 产物 / 待确认）。
5. 等它空闲，读 `RESULT.md`。
6. 起一个只读审查会话（`review-data` / `review-cite` / `review-text`），有 P0/P1 就把发现丢回去返工，最多 1 轮。
7. 把一条摘要 queue 回原会话。

看门狗每 30 秒扫一次：标着 running 但超时的任务会被中断并记为 `stale`。

## 审查 gate

- 类型按任务内容自动判断：文献/引用/DOI → `cite`；数据/表格/回归/样本 → `data`；其余 → `text`。可用 `gate` 参数覆盖，`none` 跳过。
- 审查代理必须最后输出 `GATE: <pass|warn|fail> P0=<n> P1=<n>`。
- **没有这一行、或会话报错，一律记「未运行」，绝不当成通过。**
- 审查跑在免费模型上，额度耗尽（429）时自动换 `gateFallbackModel`（默认 `deepseek/deepseek-flash`）重试一次。
- 已知假阳性：路径里出现 `\n`、`\t` 片段时（`...\task-name\num.csv`）可能误判文件名少字母。已要求审查以文件系统为准，未完全根除。

## TUI

侧边栏 `sidebar.content`，在 MCP 面板和 Tavily 配额之间，四段结构：

- 表头：`▾ Superagent` 加粗 + 任务总数角标 + 右对齐状态词（`空闲` / `N 运行中` / `N 待处理`），**点击表头即收起/展开**；
- 分段按钮：`│任务面板│收起面板│新建代理│`，每格 10 列，悬停增亮；
- 展开时列运行中与待处理任务（最多 3 条，都空时退回最近两条已完成）。任务行**悬停高亮**，右侧时长换成 `›`，**点击跳到该任务的会话**；运行中的圆点在 `●` / `○` 之间脉动，只在真有运行中任务时才翻信号；
- 末尾一行 `N 个代理 · MCP n · Skill n`（没有 profile 时不显示）。

宽度在 JS 里算好再送进文本节点，不依赖布局引擎：CJK 记 2 列，总宽 34（侧栏内容宽实测 37）。

命令与鼠标等价：

| 命令 | 作用 | 鼠标等价 |
|---|---|---|
| `/sa` | 面板：agent 设定 + 任务列表 | 点「任务面板」 |
| `/saf` | 收起 / 展开侧边栏 | 点表头或「收起面板」 |
| `/san` | 新建 agent | 点「新建代理」 |
| — | 跳到某个任务的会话 | 点那一行任务 |

`/sa` 面板上半是 agent 设定（逐项编辑提示词 / 记忆 / MCP / skill / 审查类型 / 说明书 / worker agent / 模型），下半是任务（选中跳到对应会话），最后一条是「＋ 新建 agent」。改完直接落盘 `profiles.json` 并重写 agent 定义，`@` 列表跟着变。

**热重载不可靠。** TUI 客户端对插件目录的监视会失效——实测连改写 `index.ts` 都不触发重载，`scripts/sync.mjs` 末尾那句「执行 /reload 生效」只在监视器活着时成立。改完 TUI 后必须**完全退出所有 opencode 进程再开**；判断是否真的换了代码，看侧边栏表头版本号与 `~/.local/share/opencode/superagent/tui.log`。

各插件在同一槽位里是兄弟节点，只能整体靠前或靠后，顺序取决于插件加载顺序。

## 配置

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/superagent",
      "options": {
        "maxConcurrent": 2,
        "timeoutMinutes": 45,
        "workerAgent": "build",
        "notify": true,
        "denySubagent": true,
        "gate": true,
        "gateRepairs": 1,
        "gateFallbackModel": "deepseek/deepseek-flash",
        "position": "end"
      }
    }
  ]
}
```

## 已知限制

- **成本有底价。** 最简任务实测 85k 输入 token、$0.015；worker 继承完整系统提示与工具集。
- **worker 是顶层会话。** 用 `parentID` 挂成子会话时会被父会话回合拖住（实测 3 分钟未完成），所以保留顶层，列表里会看到 `[t-xxxx]`。
- **并发受单例资源约束。** MATLAB / Stata 这类串行队列会被并行 worker 互相堵，涉及时把 `maxConcurrent` 调成 1。
- **没有事件触发。** 只能显式调用，不监听收件箱、不主动开工。
- **结果靠文件传回。** 不解析 worker 会话消息，`RESULT.md` 不合格时摘要为空。

## 许可

MIT
