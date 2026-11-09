// TUI entry shim.
//
// OpenCode 从插件根目录认 `tui.ts`：只有 index.ts 时它报告 features: { server: true }，
// 侧边栏不会渲染。这个文件把根目录的 tui 转发到预编译产物。
//
// 指向 dist/，不要指向 src/tui.tsx：Solid JSX 必须在构建阶段用 babel-preset-solid 编译。
export * from "./dist/tui.js"
export { default } from "./dist/tui.js"
