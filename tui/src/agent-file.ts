import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * agent 定义文件的生成规则。
 *
 * 服务端 server/index.ts 里有一份等价实现（插件目录之间互相 import 不到），
 * 两份必须产出同样的内容——`npm run check` 会拿磁盘上的真实文件来对。
 */
export type AgentProfile = {
  name: string
  description?: string
  prompt?: string
  memory?: string
  mcp?: string[]
  skills?: string[]
  model?: string
}

export function agentSlug(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-")
}

export function agentMarkdown(profile: AgentProfile) {
  const body = [
    profile.prompt ?? "",
    profile.memory ? `## 长期记忆\n${profile.memory}` : "",
    profile.mcp?.length ? `## 可用 MCP\n优先使用：${profile.mcp.join("、")}。` : "",
    profile.skills?.length ? `## 相关技能\n需要时加载：${profile.skills.join("、")}。` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  return [
    "---",
    `description: ${JSON.stringify(profile.description ?? profile.name)}`,
    "mode: all",
    ...(profile.model ? [`model: ${profile.model}`] : []),
    "---",
    "",
    body || profile.name,
    "",
  ].join("\n")
}

export async function writeAgentFile(profile: AgentProfile, baseDir: string) {
  const path = join(baseDir, `${agentSlug(profile.name)}.md`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, agentMarkdown(profile), "utf8")
  return path
}
