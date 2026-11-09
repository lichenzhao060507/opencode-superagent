# opencode-superagent

Router + Worker 的 OpenCode 插件：把一件事派给独立会话去跑，完成后用只读审查代理验收，再把一条摘要送回原会话。

## 为什么是两个包

OpenCode 的插件加载位置决定了它能提供什么：

| 部分 | 必须放哪里 | 原因 |
|---|---|---|
| 服务端（工具、账本、看门狗、审查） | `~/.config/opencode/plugins/superagent/` | 这个位置对所有项目目录生效；放 `~/.opencode/plugins/` 只在主目录生效，项目会话里看不到工具 |
| TUI（侧边栏、`/sa`） | `~/.opencode/plugins/superagent-tui/` | TUI 部分只从这个位置被客户端扫到；放 `.config` 时 `/api/plugin` 只报 `features.server` |

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

## 工具

| 工具 | 作用 |
|---|---|
| `superagent_task_dispatch` | 派活，立即返回任务 id |
| `superagent_task_status` | 看账本 |
| `superagent_task_cancel` | 中断并记账 |

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

- 侧边栏 `sidebar.content`，在 MCP 面板和 Tavily 配额之间：常驻 `⚙ Superagent · 空闲 / N 个运行中 / N 个待处理`，运行中列标题与耗时，空闲时列最近两条已完成。
- `/sa` 打开任务列表，选中跳到对应 worker 会话。
- 各插件在同一槽位里是兄弟节点，只能整体靠前或靠后，顺序取决于插件加载顺序。

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
