// 把仓库里的两个包同步到 OpenCode 真正加载的位置。
//
// 为什么是两个位置：服务端放 ~/.config 才对所有项目生效，
// TUI 部分只有 ~/.opencode 才会被客户端扫到。详见 README。
import { cp, mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)

const targets = [
  { from: join(repo, "server"), to: join(homedir(), ".config", "opencode", "plugins", "superagent"), files: ["index.ts", "package.json"] },
  {
    from: join(repo, "tui"),
    to: join(homedir(), ".opencode", "plugins", "superagent-tui"),
    files: ["index.ts", "tui.ts", "package.json", "dist/tui.js", "src/tui.tsx"],
  },
]

for (const target of targets) {
  await mkdir(target.to, { recursive: true })
  for (const file of target.files) {
    const source = join(target.from, file)
    if (!existsSync(source)) {
      if (file.endsWith(".js")) {
        console.warn(`跳过 ${file}：还没有构建，先跑 npm run build`)
        continue
      }
      throw new Error(`缺少文件：${source}`)
    }
    const destination = join(target.to, file)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination)
    console.log(`✓ ${file} -> ${target.to}`)
  }
}

console.log("\n同步完成，执行 /reload 生效。")
