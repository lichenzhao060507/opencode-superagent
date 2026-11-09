// 把 tui/src/tui.tsx 编译成 tui/dist/tui.js。
//
// OpenCode 不能直接加载 .tsx 插件：Solid JSX 运行时在插件缓存目录里解析不到，
// 必须先用 babel-preset-solid 编成普通 JS。
//
// babel 依次找：本仓库 node_modules、SUPERAGENT_BABEL_ROOT、同机其它插件的 node_modules。
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const home = homedir()

const candidates = [
  join(home, ".opencode", "plugins", "tui-polish", "package.json"),
  join(home, ".opencode", "plugins", "tavily-quota", "package.json"),
  join(home, ".opencode", "plugins", "wesearch", "package.json"),
  process.env.SUPERAGENT_BABEL_ROOT ? join(process.env.SUPERAGENT_BABEL_ROOT, "package.json") : "",
].filter(Boolean)

const hasBabel = (path) => existsSync(join(dirname(path), "node_modules", "@babel", "core", "package.json"))
const shared = candidates.find((path) => existsSync(path) && hasBabel(path))
if (!shared) {
  throw new Error("找不到 babel。先 npm i -D @babel/core @babel/preset-typescript babel-preset-solid，或设置 SUPERAGENT_BABEL_ROOT。")
}

const require = createRequire(shared)
const babel = require("@babel/core")

const entries = [
  { from: join(here, "src", "tui.tsx"), to: join(here, "dist", "tui.js") },
  { from: join(here, "src", "agent-file.ts"), to: join(here, "dist", "agent-file.js") },
]

for (const entry of entries) {
  const source = await readFile(entry.from, "utf8")
  const result = await babel.transformAsync(source, {
    filename: entry.from,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
      [require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
    ],
  })
  if (!result?.code) throw new Error(`babel 没有输出：${entry.from}`)
  await mkdir(dirname(entry.to), { recursive: true })
  await writeFile(entry.to, result.code, "utf8")
  console.log(`built ${entry.to.replace(here, "tui")}`)
}
