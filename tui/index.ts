import { Plugin } from "@opencode/plugin"

// superagent-tui 只有 TUI 部分：侧边栏任务列表 + /sa 命令。
//
// 服务端（派活、账本、审查）在 ~/.config/opencode/plugins/superagent，
// 那里对所有 location 生效但 TUI 部分扫描不到；TUI 部分放在
// ~/.opencode/plugins/ 才能和 tavily-quota / wesearch 一起被客户端加载。
//
// 两个包靠磁盘上的账本镜像通信：
//   ~/.local/share/opencode/superagent/tasks.json
//
// 这个服务端入口是空的，但必须有——缺 index.ts 整个插件不会被发现。
export default Plugin.define({
  id: "superagent-tui",
  setup() {},
})
