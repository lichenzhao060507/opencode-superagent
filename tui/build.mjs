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

const filename = join(here, "src", "tui.tsx")
const source = await readFile(filename, "utf8")

const result = await babel.transformAsync(source, {
  filename,
  babelrc: false,
  configFile: false,
  presets: [
    [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
    [require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
  ],
})

if (!result?.code) throw new Error("babel 没有输出")

await mkdir(join(here, "dist"), { recursive: true })
await writeFile(join(here, "dist", "tui.js"), result.code, "utf8")
console.log("built tui/dist/tui.js")
