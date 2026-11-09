// 编译 TUI 部分。
//
// 1. OpenCode 不能直接加载 .tsx，Solid JSX 必须先用 babel-preset-solid 编译。
// 2. 相对 import 其实能用（wesearch 的 dist/tui.js 就 import 了 ./rpc.js、
//    ./columns.js，加载正常）。这里仍然把 agent-file 拼进同一个产物，是因为
//    scripts/sync.mjs 只拷固定文件列表——单文件少一个「忘了拷兄弟模块」的坑。
// 所以 dist/tui.js 自成一体。
//
// dist/agent-file.js 仍然单独产出：scripts/check.mjs 拿它做「与服务端写出的文件
// 逐字一致」的交叉检查。
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

async function compile(from) {
  const source = await readFile(from, "utf8")
  const result = await babel.transformAsync(source, {
    filename: from,
    babelrc: false,
    configFile: false,
    presets: [
      [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
      [require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
    ],
  })
  if (!result?.code) throw new Error(`babel 没有输出：${from}`)
  return result.code
}

const agentSource = await compile(join(here, "src", "agent-file.ts"))
const tuiSource = await compile(join(here, "src", "tui.tsx"))

/** 把 `import { a, b } from "x"` 抽出来，方便合并去重。 */
function splitImports(code) {
  const buckets = new Map()
  const rest = code.replace(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";?[ \t]*$/gm, (_match, names, module) => {
    if (module === "./agent-file.js") return ""
    for (const name of names.split(",")) {
      const clean = name.trim()
      if (!clean) continue
      if (!buckets.has(module)) buckets.set(module, new Set())
      buckets.get(module).add(clean)
    }
    return ""
  })
  return { buckets, rest }
}

const agentParts = splitImports(agentSource)
const tuiParts = splitImports(tuiSource)

const modules = new Map()
for (const bucket of [agentParts.buckets, tuiParts.buckets]) {
  for (const [module, names] of bucket) {
    if (!modules.has(module)) modules.set(module, new Set())
    for (const name of names) modules.get(module).add(name)
  }
}

const importBlock = [...modules.entries()]
  .map(([module, names]) => `import { ${[...names].join(", ")} } from "${module}";`)
  .join("\n")

const bundle = [
  "// 由 tui/build.mjs 生成：agent-file 已内联，单文件、无相对 import。",
  importBlock,
  agentParts.rest.trim().replace(/^export /gm, ""),
  tuiParts.rest.trim(),
  "",
].join("\n\n")

await mkdir(join(here, "dist"), { recursive: true })
await writeFile(join(here, "dist", "tui.js"), bundle, "utf8")
await writeFile(join(here, "dist", "agent-file.js"), agentSource, "utf8")
console.log("built tui/dist/tui.js（内联 agent-file）与 tui/dist/agent-file.js")
