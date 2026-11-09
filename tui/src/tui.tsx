/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { agentSlug, writeAgentFile as writeAgentMarkdown } from "./agent-file.js"

/**
 * superagent 的 TUI 部分。
 *
 * 两件事：
 * 1. 侧边栏显示任务账本（可折叠，折叠状态记在 memory storage 里）。
 * 2. /sa 面板：看任务、跳到对应会话、直接编辑 agent 设定的提示词/记忆/MCP/skill。
 *
 * 数据来源是服务端写的镜像文件（TUI 是另一个进程，读不到插件 storage）：
 *   ~/.local/share/opencode/superagent/tasks.json
 *   ~/.local/share/opencode/superagent/profiles.json
 * 编辑 agent 时同时改写 OpenCode 的 agent 定义，@ 列表才会跟着变。
 */

type TaskRow = {
  id: string
  title: string
  state: string
  minutes: number
  sessionID: string | null
  finishedAt: string | null
}

type ProfileRow = {
  name: string
  description?: string
  prompt?: string
  memory?: string
  mcp?: string[]
  skills?: string[]
  gate?: string
  agent?: string
  model?: string
}

const BASE = join(homedir(), ".local", "share", "opencode", "superagent")
const LEDGER = join(BASE, "tasks.json")
const PROFILES = join(BASE, "profiles.json")
const PROBE = join(BASE, "tui.log")
const AGENTS_DIR = join(homedir(), ".config", "opencode", "agents")

const RECENT_FAILURE_MS = 10 * 60_000
const MAX_ROWS = 3

/** 展开/收起是全局状态：命令和侧边栏读同一个信号。 */
const [expanded, setExpanded] = createSignal(true)

function probe(line: string) {
  const where = `pid=${process.pid} argv=${(process.argv ?? []).slice(0, 2).join(" ")}`
  void appendFile(PROBE, `${new Date().toISOString()} [${where}] ${line}\n`).catch(() => {})
}

function clip(text: string, max = 30) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return fallback
  }
}

async function readLedger(): Promise<TaskRow[]> {
  const snapshot = await readJson<{ tasks?: TaskRow[] }>(LEDGER, {})
  return Array.isArray(snapshot.tasks) ? snapshot.tasks : []
}

async function readProfiles(): Promise<ProfileRow[]> {
  const list = await readJson<ProfileRow[]>(PROFILES, [])
  return Array.isArray(list) ? list : []
}

async function saveProfiles(profiles: ProfileRow[]) {
  await mkdir(dirname(PROFILES), { recursive: true })
  await writeFile(PROFILES, JSON.stringify(profiles, null, 2), "utf8")
}

/** 与服务端 server/index.ts 的 writeAgentFile 等价，规则在 src/agent-file.ts。 */
async function writeAgentFile(profile: ProfileRow) {
  return writeAgentMarkdown(profile, AGENTS_DIR)
}

async function removeAgentFile(name: string) {
  await rm(join(AGENTS_DIR, `${agentSlug(name)}.md`), { force: true }).catch(() => {})
}

function isRecentFailure(task: TaskRow) {
  if (task.state !== "failed" && task.state !== "stale") return false
  if (!task.finishedAt) return true
  return Date.now() - Date.parse(task.finishedAt) < RECENT_FAILURE_MS
}

function stateMark(state: string) {
  if (state === "running") return "●"
  if (state === "done") return "✓"
  if (state === "cancelled") return "■"
  return "✗"
}

function Sidebar() {
  const context = usePlugin()
  const [tasks, setTasks] = createSignal<TaskRow[]>([])

  const refresh = async () => setTasks(await readLedger())
  void refresh()
  const timer = setInterval(() => void refresh(), 4000)
  onCleanup(() => clearInterval(timer))

  const running = () => tasks().filter((task) => task.state === "running")
  const failed = () => tasks().filter(isRecentFailure)
  const recent = () => tasks().filter((task) => task.state === "done" || task.state === "cancelled").slice(0, 2)

  const head = () =>
    running().length > 0
      ? `${expanded() ? "▾" : "▸"} Superagent v4 · ${running().length} 个运行中`
      : failed().length > 0
        ? `${expanded() ? "▾" : "▸"} Superagent v4 · ${failed().length} 个待处理`
        : `${expanded() ? "▾" : "▸"} Superagent v4 · 空闲`

  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>{head()}</text>
      <Show when={expanded()}>
        <For each={[...running(), ...failed()].slice(0, MAX_ROWS)}>
          {(task) => (
            <text fg={context.theme.text.base}>
              {`  ${task.state === "running" ? "●" : "✗"} ${clip(task.title)}${task.state === "running" ? ` · ${task.minutes}m` : ""}`}
            </text>
          )}
        </For>
        <Show when={running().length === 0 && failed().length === 0 && recent().length > 0}>
          <For each={recent()}>
            {(task) => <text fg={context.theme.text.base}>{`  ✓ ${clip(task.title)}`}</text>}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "superagent.tui",
  setup(context) {
    probe("setup 进入")

    try {
      context.ui.slot({ append: "sidebar.content", render: () => <Sidebar /> })
      probe("sidebar 槽位已注册")
    } catch (error) {
      probe(`sidebar 注册失败：${String(error)}`)
    }

    // keymap.layer 要读 Solid 上下文，必须在已挂载的组件里调用
    try {
      context.ui.slot({
        append: "app",
        render: () => {
          registerCommands(context)
          return null
        },
      })
    } catch (error) {
      probe(`app 槽位注册失败：${String(error)}`)
    }
  },
})

function registerCommands(context: any) {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "superagent.panel",
        title: "Superagent：任务与 agent 设定",
        group: "Superagent",
        palette: true,
        slash: { name: "sa" },
        run: () => void openPanel(context),
      },
      {
        id: "superagent.fold",
        title: "Superagent：收起/展开侧边栏",
        group: "Superagent",
        palette: true,
        slash: { name: "saf" },
        run: () => setExpanded(!expanded()),
      },
    ],
  }))
}

async function openPanel(context: any) {
  probe("/sa 触发")
  try {
    const [tasks, profiles] = await Promise.all([readLedger(), readProfiles()])
    probe(`/sa 任务 ${tasks.length} 条，agent ${profiles.length} 个`)

    const options = [
      ...profiles.map((profile) => ({
        title: `✎ ${profile.name}`,
        value: `profile:${profile.name}`,
        category: "Agent 设定",
        description: profile.description ?? "编辑提示词 / 记忆 / MCP / skill",
      })),
      ...tasks.slice(0, 12).map((task) => ({
        title: `${stateMark(task.state)} ${task.title}`,
        value: `task:${task.id}`,
        category: "任务",
        description: `${task.id} · ${task.minutes}m`,
        disabled: !task.sessionID,
      })),
      {
        title: "＋ 新建 agent",
        value: "new",
        category: "Agent 设定",
        description: "输入名字，再逐项设置",
      },
    ]

    const picked = await context.ui.dialog.select({ title: "Superagent", options })
    if (!picked) return

    if (picked === "new") {
      const name = await context.ui.dialog.prompt({ title: "新建 agent", placeholder: "例如：数据核对" })
      if (!name) return
      const profilesNext = [...profiles, { name: name.trim() }]
      await saveProfiles(profilesNext)
      await writeAgentFile({ name: name.trim() })
      await editProfile(context, name.trim())
      return
    }

    if (picked.startsWith("profile:")) {
      await editProfile(context, picked.slice("profile:".length))
      return
    }

    if (picked.startsWith("task:")) {
      const id = picked.slice("task:".length)
      const target = tasks.find((task) => task.id === id)
      if (target?.sessionID) context.ui.router.navigate({ type: "session", sessionID: target.sessionID })
    }
  } catch (error) {
    probe(`/sa 执行失败：${String(error)}`)
    context.ui.toast.show({ message: `操作失败：${String(error)}`, variant: "error" })
  }
}

async function editProfile(context: any, name: string) {
  const profiles = await readProfiles()
  const profile = profiles.find((item) => item.name === name)
  if (!profile) {
    context.ui.toast.show({ message: `没有找到 agent ${name}`, variant: "error" })
    return
  }

  const fields = [
    { id: "prompt", label: "提示词", value: profile.prompt ?? "" },
    { id: "memory", label: "长期记忆", value: profile.memory ?? "" },
    { id: "mcp", label: "MCP（逗号分隔）", value: (profile.mcp ?? []).join(", ") },
    { id: "skills", label: "Skill（逗号分隔）", value: (profile.skills ?? []).join(", ") },
    { id: "gate", label: "审查类型", value: profile.gate ?? "auto" },
    { id: "description", label: "一句话说明", value: profile.description ?? "" },
    { id: "agent", label: "worker agent", value: profile.agent ?? "" },
    { id: "model", label: "模型", value: profile.model ?? "" },
  ]

  const picked = await context.ui.dialog.select({
    title: `编辑 ${name}`,
    options: fields.map((field) => ({
      title: field.label,
      value: field.id,
      description: field.value ? clip(field.value, 50) : "（空）",
    })),
  })
  if (!picked) return

  const field = fields.find((item) => item.id === picked)
  if (!field) return

  const answer = await context.ui.dialog.prompt({
    title: field.label,
    placeholder: field.value || "留空表示清空",
  })
  if (answer === undefined) return

  const next: ProfileRow = { ...profile }
  const text = answer.trim()
  if (picked === "mcp" || picked === "skills") {
    const list = text
      ? text
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
      : []
    if (picked === "mcp") next.mcp = list
    else next.skills = list
  } else if (picked === "gate") {
    next.gate = text || undefined
  } else {
    ;(next as any)[picked] = text || undefined
  }

  const updated = profiles.map((item) => (item.name === name ? next : item))
  await saveProfiles(updated)
  await writeAgentFile(next)
  probe(`已保存 ${name}.${picked}`)
  context.ui.toast.show({ message: `已更新「${name}」的${field.label}`, variant: "success" })
}
