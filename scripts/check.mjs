// 一致性检查：profile 数据、agent 定义文件、构建产物三者对齐。
//
// 为什么需要：writeAgentFile 在 server 和 tui 各有一份（插件目录互相 import 不到），
// 容易漂移；这个脚本至少能保证两边都还在、且磁盘上的文件与 profiles.json 对得上。
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const home = homedir()
const data = join(home, ".local", "share", "opencode", "superagent")
const failures = []
const notes = []

function check(condition, message) {
  if (condition) return
  failures.push(message)
}

// 1. 仓库结构
for (const file of ["server/index.ts", "tui/src/tui.tsx", "tui/dist/tui.js", "tui/tui.ts", "scripts/sync.mjs"]) {
  check(existsSync(join(repo, file)), `缺少文件：${file}`)
}

// 2. 服务端应有的工具
const server = await readFile(join(repo, "server/index.ts"), "utf8")
for (const tool of ["plan", "profile_list", "profile_save", "profile_remove", "task_dispatch", "task_status", "task_cancel"]) {
  check(server.includes(`name: "${tool}"`), `server 缺少工具：${tool}`)
}
check(server.includes("async function writeAgentFile"), "server 缺少 writeAgentFile")
check(server.includes("async function writeProfiles"), "server 缺少 writeProfiles")

// 3. TUI 构建产物应有的命令与面板
const dist = await readFile(join(repo, "tui/dist/tui.js"), "utf8")
for (const marker of ["superagent.panel", "superagent.fold", "editProfile", "writeAgentFile"]) {
  check(dist.includes(marker), `dist/tui.js 缺少：${marker}`)
}
// 语法层面真的能解析（可选链是合法的现代 JS，不算问题）
const syntax = spawnSync(process.execPath, ["--check", join(repo, "tui/dist/tui.js")], { encoding: "utf8" })
check(syntax.status === 0, `dist/tui.js 语法检查失败：${(syntax.stderr ?? "").split("\n")[0]}`)

// 4. 两边的 writeAgentFile 规则一致：用 TUI 的编译产物重新生成一遍，
//    必须与磁盘上由服务端写出的文件逐字相同。
const { agentMarkdown } = await import(pathToFileURL(join(repo, "tui/dist/agent-file.js")).href)
const profilesForDiff = existsSync(join(data, "profiles.json"))
  ? JSON.parse(await readFile(join(data, "profiles.json"), "utf8"))
  : []
for (const profile of profilesForDiff) {
  const slug = String(profile.name).trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-")
  const onDisk = join(home, ".config", "opencode", "agents", `${slug}.md`)
  if (!existsSync(onDisk)) continue
  const expected = agentMarkdown(profile)
  const actual = await readFile(onDisk, "utf8")
  check(
    expected === actual,
    `TUI 与 server 生成的 agent 定义不一致（${profile.name}）：\n--- TUI 预期\n${expected}\n--- 磁盘实际\n${actual}`,
  )
}

// 5. 磁盘状态：每个 profile 都要有对应的 agent 定义
const profilesPath = join(data, "profiles.json")
if (existsSync(profilesPath)) {
  const profiles = JSON.parse(await readFile(profilesPath, "utf8"))
  for (const profile of profiles) {
    const slug = String(profile.name).trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-")
    const file = join(home, ".config", "opencode", "agents", `${slug}.md`)
    check(existsSync(file), `profile「${profile.name}」没有 agent 定义文件：${file}`)
    if (existsSync(file)) {
      const body = await readFile(file, "utf8")
      check(body.startsWith("---"), `agent 定义缺少 frontmatter：${file}`)
      check(body.includes("mode: all"), `agent 定义不是 mode: all：${file}`)
      if (profile.prompt) check(body.includes(profile.prompt), `agent 定义的提示词与 profiles.json 不一致：${file}`)
    }
  }
  notes.push(`profiles=${profiles.length}`)
} else {
  notes.push("profiles.json 不存在（还没有 agent 设定）")
}

// 6. 账本镜像
const ledgerPath = join(data, "tasks.json")
if (existsSync(ledgerPath)) {
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"))
  const tasks = Array.isArray(ledger.tasks) ? ledger.tasks : []
  check(tasks.every((task) => typeof task.id === "string" && typeof task.state === "string"), "账本里有格式不正确的记录")
  notes.push(`tasks=${tasks.length}`)
}

if (failures.length > 0) {
  console.error(`检查失败 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}

console.log(`检查通过（${notes.join(" · ")}）`)
