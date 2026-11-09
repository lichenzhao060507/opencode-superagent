/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { appendFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * superagent 的 TUI 部分。
 *
 * 只做一件事：在侧边栏显示"还需要人看"的任务。
 * 数据来自服务端写的镜像文件（TUI 是另一个进程，读不到插件 storage）。
 *
 * 规则：没有运行中/刚失败的任务时什么都不显示——健康状态不占地方。
 */

type TaskRow = {
  id: string
  title: string
  state: string
  minutes: number
  sessionID: string | null
  finishedAt: string | null
}

type Snapshot = { updated: string; tasks: TaskRow[] }

const LEDGER = join(homedir(), ".local", "share", "opencode", "superagent", "tasks.json")
const PROBE = join(homedir(), ".local", "share", "opencode", "superagent", "tui.log")
const RECENT_FAILURE_MS = 10 * 60_000
const MAX_ROWS = 3

/** TUI 里看不到 console，用文件留证据，排查时才不用靠猜。 */
function probe(line: string) {
  void appendFile(PROBE, `${new Date().toISOString()} ${line}\n`).catch(() => {})
}

function clip(text: string, max = 30) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

async function readLedger(): Promise<TaskRow[]> {
  try {
    const raw = await readFile(LEDGER, "utf8")
    const snapshot = JSON.parse(raw) as Snapshot
    return Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  } catch {
    return []
  }
}

function isRecentFailure(task: TaskRow) {
  if (task.state !== "failed" && task.state !== "stale") return false
  if (!task.finishedAt) return true
  return Date.now() - Date.parse(task.finishedAt) < RECENT_FAILURE_MS
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
      ? `⚙ Superagent · ${running().length} 个运行中`
      : failed().length > 0
        ? `⚙ Superagent · ${failed().length} 个待处理`
        : "⚙ Superagent · 空闲"

  return (
    <box flexDirection="column">
      <text fg={context.theme.text.base}>{head()}</text>
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
    </box>
  )
}

export default Plugin.define({
  id: "superagent.tui",
  setup(context) {
    probe("setup 进入")
    const position = (context.options as any)?.position === "start" ? "start" : "end"
    try {
      context.ui.slot(
        position === "start"
          ? { prepend: "sidebar.content", render: () => <Sidebar /> }
          : { append: "sidebar.content", render: () => <Sidebar /> },
      )
      probe(`sidebar 槽位已注册（position=${position}）`)
    } catch (error) {
      probe(`sidebar 注册失败：${String(error)}`)
    }

    // keymap.layer 要读 Solid 上下文，必须在已挂载的组件里调用，直接在 setup 里调用等于没注册
    try {
      context.ui.slot({
        append: "app",
        render: () => {
          probe("app 槽位渲染，注册 /sa")
          try {
            registerCommand(context)
            probe("/sa 命令已注册")
          } catch (error) {
            probe(`/sa 注册失败：${String(error)}`)
          }
          return null
        },
      })
      probe("app 槽位已注册")
    } catch (error) {
      probe(`app 槽位注册失败：${String(error)}`)
    }
  },
})

function registerCommand(context: any) {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "superagent.tasks",
        title: "Superagent：任务账本",
        group: "Superagent",
        palette: true,
        slash: { name: "sa" },
        run: async () => {
          probe("/sa 触发")
          try {
            const tasks = await readLedger()
            probe(`/sa 读到 ${tasks.length} 条任务`)
            if (tasks.length === 0) {
              context.ui.toast.show({ message: "还没有任务记录", variant: "info" })
              return
            }
            const picked = await context.ui.dialog.select({
              title: "Superagent 任务",
              options: tasks.map((task: TaskRow) => ({
                title: `${stateMark(task.state)} ${task.title}`,
                value: task.id,
                description: `${task.id} · ${task.minutes}m${task.state === "running" ? " · 运行中" : ""}`,
                disabled: !task.sessionID,
              })),
            })
            probe(`/sa 选择结果：${String(picked)}`)
            const target = tasks.find((task: TaskRow) => task.id === picked)
            if (target?.sessionID) {
              context.ui.router.navigate({ type: "session", sessionID: target.sessionID })
            }
          } catch (error) {
            probe(`/sa 执行失败：${String(error)}`)
          }
        },
      },
    ],
  }))
}

function stateMark(state: string) {
  if (state === "running") return "●"
  if (state === "done") return "✓"
  if (state === "cancelled") return "■"
  return "✗"
}
