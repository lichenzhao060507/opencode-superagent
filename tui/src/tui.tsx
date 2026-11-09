/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { RGBA } from "@opentui/core"
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { agentSlug, writeAgentFile } from "./agent-file.js"

/**
 * superagent 的 TUI 部分。
 *
 * 三件事：
 * 1. 侧边栏显示任务账本（可折叠，折叠状态由模块内信号共享，点击标题也能收）。
 * 2. /sa 面板：看任务、跳到对应会话、直接编辑 agent 设定的提示词/记忆/MCP/skill。
 * 3. /saf：收起或展开侧边栏。
 *
 * 视觉规范沿用 WeSearch（2026-10-16 定稿）：只读主题 text / textMuted 两色、
 * 零 emoji、按钮统一 4 字、分段网格 3 格 × 宽 10 + 4 条单轨 = 34 列，
 * 落在侧栏内容宽 37 列以内。CJK 按 2 列计算，截断加省略号。
 *
 * 上下文一律用 prop 传进组件，不在组件里调 usePlugin()：
 * 槽位内容由宿主的 X0 错误边界渲染，不保证包在 PluginContextProvider 内，
 * usePlugin() 拿不到 context 会抛 "PluginContextProvider is missing"。
 *
 * 数据来源是服务端写的镜像文件（TUI 是另一个进程，读不到插件 storage）：
 *   ~/.local/share/opencode/superagent/tasks.json
 *   ~/.local/share/opencode/superagent/profiles.json
 * 编辑 agent 时同时改写 OpenCode 的 agent 定义，@ 列表才会跟着变。
 */

type Ctx = TuiPlugin.Context

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

const RECENT_FAILURE_MS = 10 * 60_000
const MAX_ROWS = 3

/** 侧栏内容宽 34（WeSearch 实测内容宽 37，留 3 列余量）。 */
const CONTENT_WIDTH = 34
const SEGMENT_WIDTH = 10

/** 分段按钮底纹：半透明灰，深浅主题自适应；悬停加深一档。 */
const WASH_NONE = RGBA.fromValues(0, 0, 0, 0)
const WASH_IDLE = RGBA.fromValues(0.5, 0.5, 0.5, 0.2)
const WASH_HOVER = RGBA.fromValues(0.5, 0.5, 0.5, 0.38)

/** 展开/收起是全局状态：命令、标题点击、按钮读同一个信号。 */
const [expanded, setExpanded] = createSignal(true)

/* ------------------------------- 终端列宽 ------------------------------- */

/** 单个字符的终端列宽（CJK 及全角记 2 列，其余 1 列）。 */
function charWidth(ch: string) {
  const cp = ch.codePointAt(0) ?? 0
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  return wide ? 2 : 1
}

function colWidth(text: string) {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** 按列宽截断，超宽补省略号。省略号本身要占 1 列，所以文本只能用到 max-1。 */
function clipCols(text: string, max: number) {
  if (max <= 0) return ""
  if (colWidth(text) <= max) return text
  let width = 0
  let out = ""
  for (const ch of text) {
    const w = charWidth(ch)
    if (width + w > max - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

/**
 * 右侧留出固定列宽后把左侧补满。
 * 不给布局引擎留判断题：空格写进文本节点，宽度就一定是算好的。
 */
function padTo(text: string, cols: number) {
  const clipped = clipCols(text, Math.max(0, cols))
  return clipped + " ".repeat(Math.max(0, cols - colWidth(clipped)))
}

/* --------------------------------- 探针 --------------------------------- */

function pidText() {
  try {
    if (typeof process !== "undefined" && process?.pid) return `pid=${process.pid}`
  } catch {
    // TUI 沙箱里可能没有 process
  }
  return "no-process"
}

function baseDir() {
  try {
    const home = homedir()
    return home ? join(home, ".local", "share", "opencode", "superagent") : ""
  } catch {
    return ""
  }
}

/**
 * 探针用同步写：异步 append 在插件报错退出时可能来不及落盘，
 * 会让「加载失败」和「没加载」看起来一模一样。
 */
function probe(line: string) {
  try {
    const base = baseDir()
    if (!base) return
    mkdirSync(base, { recursive: true })
    appendFileSync(join(base, "tui.log"), `${new Date().toISOString()} [${pidText()}] ${line}\n`, "utf8")
  } catch {
    // 探针本身绝不能影响插件
  }
}

/* -------------------------------- 数据层 -------------------------------- */

function ledgerPath() {
  const base = baseDir()
  return base ? join(base, "tasks.json") : ""
}

function profilesPath() {
  const base = baseDir()
  return base ? join(base, "profiles.json") : ""
}

function agentsDir() {
  try {
    const home = homedir()
    return home ? join(home, ".config", "opencode", "agents") : ""
  } catch {
    return ""
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!path) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

function readLedger(): TaskRow[] {
  const snapshot = readJson<{ tasks?: TaskRow[] }>(ledgerPath(), {})
  return Array.isArray(snapshot.tasks) ? snapshot.tasks : []
}

function readProfiles(): ProfileRow[] {
  const list = readJson<ProfileRow[]>(profilesPath(), [])
  return Array.isArray(list) ? list : []
}

function saveProfiles(profiles: ProfileRow[]) {
  const path = profilesPath()
  if (!path) throw new Error("找不到数据目录")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(profiles, null, 2), "utf8")
}

/** 规则与 server/index.ts 的 writeAgentFile 一致，实现共用 src/agent-file.ts。 */
function saveAgentFile(profile: ProfileRow) {
  const dir = agentsDir()
  if (!dir) throw new Error("找不到 agents 目录")
  return writeAgentFile(profile, dir)
}

function removeAgentFile(name: string) {
  const dir = agentsDir()
  if (!dir) return
  try {
    rmSync(join(dir, `${agentSlug(name)}.md`), { force: true })
  } catch {
    // 删不掉就算了，不影响主流程
  }
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

/** 主题叶名两版并存：2.0.7 是 text.default/subdued，新版本是 text.base/muted。 */
function readColors(context: Ctx) {
  try {
    const text = context.theme.text as unknown as Record<string, string | undefined>
    return { fg: text.base ?? text.default, muted: text.muted ?? text.subdued }
  } catch {
    return { fg: undefined, muted: undefined }
  }
}

/* -------------------------------- 组件 -------------------------------- */

/** 分段按钮：「 标签 」带底纹；灰=常态、白=悬停；点击触发。 */
function Segment(props: {
  context: Ctx
  label: string
  onPress: () => void
}) {
  const colors = () => readColors(props.context)
  const [hover, setHover] = createSignal(false)

  return (
    <box
      width={SEGMENT_WIDTH}
      height={1}
      backgroundColor={hover() ? WASH_HOVER : WASH_IDLE}
      onMouseUp={(event: any) => {
        if (event?.button !== 0) return
        event?.stopPropagation?.()
        props.onPress()
      }}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text width="100%" textAlign="center" selectable={false} fg={hover() ? colors().fg : colors().muted}>
        {` ${props.label} `}
      </text>
    </box>
  )
}

function Wall(props: { context: Ctx }) {
  return (
    <text selectable={false} fg={readColors(props.context).muted}>
      │
    </text>
  )
}

function Sidebar(props: { context: Ctx }) {
  const colors = () => readColors(props.context)
  const [tasks, setTasks] = createSignal<TaskRow[]>([])
  const [agents, setAgents] = createSignal(0)
  const [headHover, setHeadHover] = createSignal(false)

  const refresh = () => {
    setTasks(readLedger())
    setAgents(readProfiles().length)
  }

  refresh()
  const timer = setInterval(refresh, 4000)
  onCleanup(() => clearInterval(timer))

  const running = () => tasks().filter((task) => task.state === "running")
  const failed = () => tasks().filter(isRecentFailure)
  const recent = () => tasks().filter((task) => task.state === "done" || task.state === "cancelled").slice(0, 2)

  const statusWord = () => {
    if (running().length > 0) return `${running().length} 运行中`
    if (failed().length > 0) return `${failed().length} 待处理`
    return "空闲"
  }

  const headLeft = () => padTo(`${expanded() ? "▾" : "▸"} Superagent`, CONTENT_WIDTH - colWidth(statusWord()))

  /** 运行中优先，其次待处理；都空时退回最近完成的两条。 */
  const rows = () => {
    const live = [...running(), ...failed()].slice(0, MAX_ROWS)
    if (live.length > 0) return live
    return recent()
  }

  /** 任务行拆两段：标题走正文色、时长走弱色，右端对齐到固定列宽。 */
  const rowParts = (task: TaskRow) => {
    const minutes = typeof task.minutes === "number" && task.minutes > 0 ? `${task.minutes}m` : ""
    const right = task.state === "running" || task.state === "done" ? minutes : ""
    const leftCols = CONTENT_WIDTH - colWidth(right)
    const title = clipCols(String(task.title ?? ""), Math.max(4, leftCols - 2))
    return { left: padTo(`${stateMark(task.state)} ${title}`, leftCols), right }
  }

  return (
    <box flexDirection="column" gap={0}>
      <box
        height={1}
        backgroundColor={headHover() ? WASH_IDLE : WASH_NONE}
        onMouseUp={(event: any) => {
          if (event?.button !== 0) return
          event?.stopPropagation?.()
          setExpanded(!expanded())
        }}
        onMouseOver={() => setHeadHover(true)}
        onMouseOut={() => setHeadHover(false)}
      >
        <box flexDirection="row" height={1}>
          <text selectable={false} fg={colors().fg}>
            <b>{headLeft()}</b>
          </text>
          <text selectable={false} fg={colors().muted}>
            {statusWord()}
          </text>
        </box>
      </box>

      <box flexDirection="row" height={1}>
        <Wall context={props.context} />
        <Segment context={props.context} label="任务面板" onPress={() => void openPanel(props.context)} />
        <Wall context={props.context} />
        <Segment
          context={props.context}
          label={expanded() ? "收起面板" : "展开面板"}
          onPress={() => setExpanded(!expanded())}
        />
        <Wall context={props.context} />
        <Segment context={props.context} label="新建代理" onPress={() => void createAgent(props.context)} />
        <Wall context={props.context} />
      </box>

      <Show when={expanded()}>
        <For each={rows()}>
          {(task) => {
            const parts = rowParts(task)
            return (
              <box flexDirection="row" height={1}>
                <text selectable={false} fg={colors().fg}>
                  {parts.left}
                </text>
                <text selectable={false} fg={colors().muted}>
                  {parts.right}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={rows().length === 0}>
          <text selectable={false} fg={colors().muted}>
            {" 暂无任务 · /sa 派活"}
          </text>
        </Show>
      </Show>

      <Show when={agents() > 0}>
        <text selectable={false} fg={colors().muted}>
          {clipCols(` ${agents()} 个代理 · /sa 编辑`, CONTENT_WIDTH)}
        </text>
      </Show>
    </box>
  )
}

/**
 * 命令层必须在已挂载的组件里注册（keymap.layer 要读 Solid 上下文），
 * 且不能从槽位 render 里返回 null——宿主会把它当空子树插入。
 */
function Commands(props: { context: Ctx }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "superagent.panel",
        title: "Superagent：任务与 agent 设定",
        group: "Superagent",
        palette: true,
        slash: { name: "sa" },
        run: () => void openPanel(props.context),
      },
      {
        id: "superagent.fold",
        title: "Superagent：收起/展开侧边栏",
        group: "Superagent",
        palette: true,
        slash: { name: "saf" },
        run: () => setExpanded(!expanded()),
      },
      {
        id: "superagent.new",
        title: "Superagent：新建 agent",
        group: "Superagent",
        palette: true,
        slash: { name: "san" },
        run: () => void createAgent(props.context),
      },
    ],
  }))

  return <box flexDirection="column" />
}

export default Plugin.define({
  id: "superagent.tui",
  setup(context) {
    probe("setup 进入")

    let stopSidebar: (() => void) | undefined
    let stopCommands: (() => void) | undefined

    try {
      stopSidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => <Sidebar context={context} />,
      })
      probe("sidebar 槽位已注册")
    } catch (error) {
      probe(`sidebar 注册失败：${String(error)}`)
    }

    try {
      stopCommands = context.ui.slot({
        append: "app",
        render: () => <Commands context={context} />,
      })
      probe("app 槽位已注册")
    } catch (error) {
      probe(`app 注册失败：${String(error)}`)
    }

    return () => {
      try {
        stopSidebar?.()
      } catch {
        // 卸载失败不该抛出
      }
      try {
        stopCommands?.()
      } catch {
        // 同上
      }
    }
  },
})

/* -------------------------------- 面板 -------------------------------- */

async function createAgent(context: Ctx) {
  try {
    const name = await context.ui.dialog.prompt({ title: "新建代理", placeholder: "例如：数据核对" })
    if (!name || !name.trim()) return
    const clean = name.trim()
    const profiles = readProfiles()
    if (profiles.some((item) => item.name === clean)) {
      context.ui.toast.show({ message: `「${clean}」已存在`, variant: "warning" })
      return
    }
    saveProfiles([...profiles, { name: clean }])
    await saveAgentFile({ name: clean })
    probe(`新建代理 ${clean}`)
    context.ui.toast.show({ message: `已创建「${clean}」，接着设置提示词`, variant: "success" })
    await editProfile(context, clean)
  } catch (error) {
    probe(`新建代理失败：${String(error)}`)
    context.ui.toast.show({ message: `新建失败：${String(error)}`, variant: "error" })
  }
}

async function openPanel(context: Ctx) {
  probe("/sa 触发")
  try {
    const tasks = readLedger()
    const profiles = readProfiles()
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

    const picked = await context.ui.dialog.select<string>({ title: "Superagent", options })
    if (!picked) return

    if (picked === "new") {
      await createAgent(context)
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

async function editProfile(context: Ctx, name: string) {
  const profiles = readProfiles()
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

  const picked = await context.ui.dialog.select<string>({
    title: `编辑 ${name}`,
    options: fields.map((field) => ({
      title: field.label,
      value: field.id,
      description: field.value ? clipCols(field.value, 50) : "（空）",
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
    ;(next as Record<string, unknown>)[picked] = text || undefined
  }

  const updated = profiles.map((item) => (item.name === name ? next : item))
  saveProfiles(updated)
  await saveAgentFile(next)
  probe(`已保存 ${name}.${picked}`)
  context.ui.toast.show({ message: `已更新「${name}」的${field.label}`, variant: "success" })
}

// 模块级探针：能写出来就说明模块被求值了，比 setup 更早。
probe("module 已求值")
