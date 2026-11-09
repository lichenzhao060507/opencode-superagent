import { Plugin } from "@opencode/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

/**
 * superagent —— Router + Worker 的插件实现。
 *
 * Router 就是调用 sa_dispatch 的那个会话：它只派活，不干活。
 * Worker 是一个独立子会话（独立上下文、独立目录），完成后把 RESULT.md
 * 写回任务目录，插件再把一条摘要塞回 Router 会话。
 *
 * 账本存 ctx.storage；同时镜像一份 JSON 到磁盘，供 TUI 侧边栏读取
 * （TUI 是另一个进程，读不到 ctx.storage）。
 */

const PREFIX = "task/"

function ledgerPath() {
  return join(homedir(), ".local", "share", "opencode", "superagent", "tasks.json")
}

function profilesPath() {
  return join(homedir(), ".local", "share", "opencode", "superagent", "profiles.json")
}

/** 一个 agent 的完整设定：派活时整套带进 worker 会话。 */
interface Profile {
  name: string
  description?: string
  agent?: string
  model?: string
  gate?: GateKind
  prompt?: string
  memory?: string
  mcp?: string[]
  skills?: string[]
  updatedAt?: string
}

async function readProfiles(): Promise<Profile[]> {
  try {
    const raw = await readFile(profilesPath(), "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Profile[]) : []
  } catch {
    return []
  }
}

async function writeProfiles(profiles: Profile[]) {
  const path = profilesPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(profiles, null, 2), "utf8")
}


type TaskState = "running" | "done" | "failed" | "cancelled" | "stale"

type GateKind = "data" | "cite" | "text" | "none"

interface GateResult {
  kind: GateKind
  reviewer: string
  verdict: "pass" | "warn" | "fail" | "skipped"
  p0: number
  p1: number
  detail?: string
  note?: string
}

interface TaskRecord {
  id: string
  title: string
  brief: string
  directory: string
  agent?: string
  sessionID?: string
  originSessionID?: string
  resultPath: string
  state: TaskState
  createdAt: string
  startedAt?: string
  finishedAt?: string
  summary?: string
  error?: string
  gate?: GateKind
  gateResult?: GateResult
  repairs?: number
  note?: string
  profile?: Profile
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

function newID() {
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `t-${stamp}${salt}`
}

function sessionIDOf(info: any): string {
  return info?.id ?? info?.sessionID ?? ""
}

function oneLine(text: string, max: number) {
  const flat = text.replace(/\r/g, "").replace(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max) + "…" : flat
}

function workerPrompt(task: TaskRecord) {
  const profile = task.profile
  const extra: string[] = []
  if (profile?.prompt) extra.push("", "## 这个 agent 的设定", profile.prompt)
  if (profile?.memory) extra.push("", "## 长期记忆（每次派活都带上，可随时改）", profile.memory)
  if (profile?.mcp?.length) {
    extra.push("", "## 可用 MCP", `优先用这些：${profile.mcp.join("、")}。不要在无关的 MCP 上浪费时间。`)
  }
  if (profile?.skills?.length) {
    extra.push("", "## 相关技能", `需要时加载这些 skill：${profile.skills.join("、")}。`)
  }
  return [
    `你是 ${profile?.name ? `「${profile.name}」` : "worker"}。你只负责下面这一件事，全程不与用户对话。`,
    "",
    "## 任务",
    task.title,
    "",
    task.brief,
    ...extra,
    "",
    "## 工作约定",
    "1. 动手前先读当前目录里的 AGENTS.md / HANDOFF.md（存在的话），按已有约定做事。",
    "2. 只改本任务需要的文件；不派发子代理；不碰任务目录之外的内容。",
    "3. 有把握的做到底，没把握的不要猜——写进「待确认」。",
    "4. 失败就如实写失败，不要为了交付而绕过限制或编造结果。",
    "",
    "## 交付物",
    `把结果写入：${task.resultPath}`,
    "文件结构固定为：",
    "",
    "# 结果",
    "## 结论",
    "（一段话，说清做成了什么、关键数字或结论）",
    "## 产物",
    "（改动了哪些文件 / 生成了什么，逐条列路径）",
    "## 待确认",
    "（需要人来定的问题，逐条列；没有就写「无」）",
    "",
    "写完后即可结束，不需要向任何人解释过程。",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function inferGate(text: string): GateKind {
  if (/文献|引用|参考文献|引注|doi|citation|zotero|bib/i.test(text)) return "cite"
  if (/数据|表格|回归|系数|统计|口径|样本|指标|stata|duckdb|面板|chart|plot/i.test(text)) return "data"
  return "text"
}

function reviewerFor(kind: GateKind) {
  if (kind === "data") return "review-data"
  if (kind === "cite") return "review-cite"
  if (kind === "text") return "review-text"
  return ""
}

function gatePrompt(task: TaskRecord, kind: GateKind) {
  const focus =
    kind === "data"
      ? "数字前后是否一致、单位与口径是否统一、百分比与百分点有没有混用、样本量与分母是否对得上、表内合计是否正确、正文与表格是否一致。"
      : kind === "cite"
        ? "正文引用与文献表是否一一对应、作者/年份/期刊/卷期/页码/DOI 是否自洽、有无重复条目、有无编造。"
        : "结论与证据是否相符、有无夸大或断言过头、关键限制是否缺失、术语与口径是否前后一致。"
  return [
    `你是审查员，只读。审查刚完成的任务产出，不要修改任何文件。`,
    "",
    `## 被审任务`,
    `${task.title}`,
    ``,
    `${task.brief}`,
    "",
    "## 产出位置",
    `- 任务目录：${task.directory}`,
    `- 结果说明：${task.resultPath}`,
    "任务目录下的改动就是这次交付物。",
    "",
    "## 重点检查",
    focus,
    "",
    "## 输出要求",
    "先逐条列发现，格式：`severity | location | evidence | why | fix`。",
    "severity 只用 P0（错数/错引用/事实错误）、P1（结论与证据不符/口径不一致）、P2（可读性）、P3（偏好）。",
    "判断路径是否存在，以文件系统为准：先列目录，再比对文件名；不要靠字符串字面匹配下结论。",
    "文本里的 `\\n`、`\\t` 在 Windows 路径里是目录分隔符，不一定是被转义的换行或制表符——例如 `...\\task-name\\num.csv` 里的 `\\n` 只是分隔符。",
    "没有发现就写「未发现问题」。",
    "最后一行必须是机器可读的判定，且只有这一行以 GATE 开头：",
    "GATE: <pass|warn|fail> P0=<n> P1=<n>",
    "pass = 无 P0 且无 P1；warn = 只有 P1；fail = 有 P0。",
  ].join("\n")
}

/** 从会话里取最后一条助手消息的正文。审查代理只读，不能写文件，只能这样拿结果。 */
function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== "assistant") continue
    const parts = Array.isArray(message?.content) ? message.content : []
    const text = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function parseVerdict(text: string): { verdict: GateResult["verdict"]; p0: number; p1: number } {
  const match = text.match(/GATE:\s*(pass|warn|fail)\s*P0\s*=\s*(\d+)\s*P1\s*=\s*(\d+)/i)
  if (match) {
    return {
      verdict: match[1].toLowerCase() as GateResult["verdict"],
      p0: Number(match[2]),
      p1: Number(match[3]),
    }
  }
  const p0 = (text.match(/\bP0\b/g) ?? []).length
  const p1 = (text.match(/\bP1\b/g) ?? []).length
  if (p0 > 0) return { verdict: "fail", p0, p1 }
  if (p1 > 0) return { verdict: "warn", p0, p1 }
  // 空回复、跑题、只说"我看看"——都不能算通过
  if (/未发现问题/.test(text)) return { verdict: "pass", p0: 0, p1: 0 }
  return { verdict: "skipped", p0: 0, p1: 0 }
}

/** 审查会话若因额度/供应商错误结束，内容里不带任何判定，必须识别出来。 */
function lastAssistantError(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== "assistant") continue
    const error = message?.error
    if (error) return `审查失败：${error.message ?? error.type ?? "未知错误"}`
    if (message?.finish === "error") return "审查失败：会话异常结束"
    return ""
  }
  return ""
}

function parseModelRef(input: unknown): { providerID: string; id: string } | undefined {
  if (input && typeof input === "object") {
    const value = input as { providerID?: unknown; id?: unknown }
    if (typeof value.providerID === "string" && typeof value.id === "string") {
      return { providerID: value.providerID, id: value.id }
    }
    return undefined
  }
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (!trimmed || trimmed === "false") return undefined
  const slash = trimmed.lastIndexOf("/")
  if (slash <= 0) return undefined
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) }
}


function doneMessage(task: TaskRecord) {
  const head =
    task.state === "done"
      ? `✅ ${task.id} 完成：${task.title}`
      : task.state === "cancelled"
        ? `■ ${task.id} 已取消：${task.title}`
        : task.state === "stale"
          ? `⏱ ${task.id} 超时中断：${task.title}`
          : `❌ ${task.id} 失败：${task.title}`
  const gate = task.gateResult
  const gateLine =
    gate && gate.verdict !== "skipped"
      ? gate.verdict === "pass"
        ? `\n审查：${gate.reviewer} 通过`
        : `\n审查：${gate.reviewer} ${gate.verdict === "fail" ? "不通过" : "有条件通过"}（P0=${gate.p0} P1=${gate.p1}）${task.repairs ? ` 已返工 ${task.repairs} 轮` : ""}${gate.detail ? `\n${oneLine(gate.detail, 500)}` : ""}`
      : gate?.note
        ? `\n审查：未运行（${gate.note}）`
        : ""
  const body = task.summary
    ? `\n摘要：${oneLine(task.summary, 600)}`
    : task.error
      ? `\n原因：${oneLine(task.error, 400)}`
      : ""
  return `${head}${gateLine}${body}\n结果文件：${task.resultPath}`
}

export default Plugin.define({
  id: "superagent",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, any>
    const maxConcurrent = clamp(Number(options.maxConcurrent ?? 2), 1, 6)
    const timeoutMs = clamp(Number(options.timeoutMinutes ?? 45), 5, 240) * 60_000
    const workerAgent: string | undefined =
      typeof options.workerAgent === "string" && options.workerAgent.length > 0 ? options.workerAgent : undefined
    const notify = options.notify !== false
    const denySubagent = options.denySubagent !== false
    const gateOn = options.gate !== false

    const root = ctx.location.directory
    const inFlight = new Map<string, { startedAt: number }>()

    const key = (id: string) => `${PREFIX}${id}`
    const save = async (task: TaskRecord) => {
      await ctx.storage.set(key(task.id), task as any)
      void mirrorLedger()
    }

    const loadAll = async (): Promise<TaskRecord[]> => {
      const out: TaskRecord[] = []
      let cursor: string | undefined
      for (let guard = 0; guard < 20; guard++) {
        const page: any = await ctx.storage.scan({ prefix: PREFIX, limit: 200, ...(cursor ? { after: cursor } : {}) })
        for (const entry of page?.entries ?? []) {
          const value = entry?.value
          if (value && typeof value === "object" && typeof value.id === "string") out.push(value as TaskRecord)
        }
        if (!page?.next) break
        cursor = page.next
      }
      return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    }

    // TUI 侧边栏读这份镜像；写失败不影响服务端账本
    const mirrorLedger = async () => {
      try {
        const tasks = await loadAll()
        const snapshot = {
          updated: new Date().toISOString(),
          tasks: tasks.slice(0, 50).map((task) => ({
            id: task.id,
            title: task.title,
            state: task.state,
            directory: task.directory,
            sessionID: task.sessionID ?? null,
            createdAt: task.createdAt,
            startedAt: task.startedAt ?? null,
            finishedAt: task.finishedAt ?? null,
            minutes: task.startedAt
              ? Math.max(
                  0,
                  Math.round(
                    (Date.parse(task.finishedAt ?? new Date().toISOString()) - Date.parse(task.startedAt)) / 60000,
                  ),
                )
              : 0,
            error: task.error ?? null,
          })),
        }
        const path = ledgerPath()
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify(snapshot, null, 2), "utf8")
      } catch {
        // 镜像只是给界面看的
      }
    }

    void mirrorLedger()

    const resolveDirectory = (input: string | undefined, base: string) => {
      const raw = input && input.trim() ? input.trim() : base
      return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
    }

    const readResult = async (task: TaskRecord) => {
      try {
        const text = await readFile(task.resultPath, "utf8")
        return text.trim().slice(0, 4000)
      } catch {
        return ""
      }
    }

    const notifyOrigin = async (task: TaskRecord) => {
      if (!notify || !task.originSessionID) return
      try {
        await ctx.session.prompt({
          sessionID: task.originSessionID,
          text: doneMessage(task),
          delivery: "queue",
        } as any)
      } catch {
        // 原会话可能已关闭；账本里仍有记录，不影响任务本身
      }
    }

    const runGate = async (task: TaskRecord, workerSessionID: string, cancelled: boolean) => {
      const kind: GateKind = task.gate ?? "none"
      if (!gateOn || kind === "none") return
      const reviewer = reviewerFor(kind)
      if (!reviewer) return

      const record = (patch: Partial<GateResult>) => {
        task.gateResult = {
          kind,
          reviewer,
          verdict: "skipped",
          p0: 0,
          p1: 0,
          ...patch,
        }
      }

      let gateSession = ""
      try {
        const created: any = await ctx.session.create({
          title: `[gate ${task.id}] ${task.title}`,
          location: { directory: task.directory },
          agent: reviewer,
          permissions: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "subagent", resource: "*", effect: "deny" },
          ],
        } as any)
        gateSession = sessionIDOf(created)
        if (!gateSession) throw new Error("审查会话创建失败")

        const waitBounded = async (sessionID: string) => {
          let timer: NodeJS.Timeout | undefined
          try {
            await Promise.race([
              ctx.session.wait({ sessionID } as any),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("审查超时")), 10 * 60_000)
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        }

        // 审查代理跑在免费模型上，额度耗尽时会返回空内容；不能把空内容当成通过
        const ask = async (text: string) => {
          await ctx.session.prompt({ sessionID: gateSession, text, delivery: "queue" } as any)
          await waitBounded(gateSession)
          const raw: any = await ctx.session.context({ sessionID: gateSession } as any)
          const messages: any[] = Array.isArray(raw) ? raw : (raw?.data ?? [])
          const failure = lastAssistantError(messages)
          return { text: lastAssistantText(messages), error: failure }
        }

        const fallback = parseModelRef(options.gateFallbackModel ?? "deepseek/deepseek-flash")
        let usedFallback = false
        const askWithFallback = async (text: string) => {
          let answer = await ask(text)
          if (answer.error && fallback && !usedFallback) {
            usedFallback = true
            try {
              await ctx.session.switchModel({ sessionID: gateSession, model: fallback } as any)
              answer = await ask(text)
            } catch {
              // 换模型失败就按原错误处理
            }
          }
          return answer
        }

        let answer = await askWithFallback(gatePrompt(task, kind))
        if (answer.error) {
          record({ note: answer.error })
          return
        }

        let verdictText = answer.text
        let parsed = parseVerdict(verdictText)
        if (parsed.verdict === "skipped") {
          record({ note: "审查未给出可识别的判定", detail: verdictText.slice(0, 800) })
          return
        }

        const maxRepairs = clamp(Number(options.gateRepairs ?? 1), 0, 2)
        let repairs = 0
        while ((parsed.verdict === "fail" || parsed.verdict === "warn") && repairs < maxRepairs && !cancelled) {
          repairs += 1
          task.repairs = repairs
          await save(task)
          const findings = verdictText.replace(/^GATE:.*$/gim, "").trim()
          await ctx.session.prompt({
            sessionID: workerSessionID,
            text: [
              "审查发现以下问题。只修这些问题，不要扩大范围，改完更新 RESULT.md 就结束。",
              "",
              findings || "（审查未给出可读条目，请自行复核交付物）",
            ].join("\n"),
            delivery: "queue",
          } as any)
          await ctx.session.wait({ sessionID: workerSessionID } as any)
          task.summary = await readResult(task)
          const recheck = await askWithFallback("已按前述问题返工，请重新审查同一批交付物，并照原格式给出判定。")
          if (recheck.error) {
            record({ note: recheck.error, detail: findings.slice(0, 1200) })
            return
          }
          verdictText = recheck.text
          parsed = parseVerdict(verdictText)
          if (parsed.verdict === "skipped") {
            record({ note: "返工后审查未给出可识别的判定", detail: verdictText.slice(0, 800) })
            return
          }
        }

        record({
          verdict: parsed.verdict,
          p0: parsed.p0,
          p1: parsed.p1,
          detail: verdictText.replace(/^GATE:.*$/gim, "").trim().slice(0, 1500),
        })
      } catch (err: any) {
        if (gateSession) {
          try {
            await ctx.session.interrupt({ sessionID: gateSession, resume: false } as any)
          } catch {
            // 会话可能已结束
          }
        }
        record({ note: err?.message ? String(err.message) : String(err) })
      }
    }

    const run = async (task: TaskRecord) => {
      inFlight.set(task.id, { startedAt: Date.now() })
      let sid = ""
      try {
        task.state = "running"
        task.startedAt = new Date().toISOString()
        await save(task)

        await mkdir(join(task.directory, ".superagent", task.id), { recursive: true })

        const agent = task.agent ?? workerAgent
        const model = parseModelRef(task.profile?.model)
        const created: any = await ctx.session.create({
          title: `[${task.id}] ${task.title}`,
          location: { directory: task.directory },
          ...(agent ? { agent } : {}),
          ...(model ? { model } : {}),
          ...(denySubagent
            ? { permissions: [{ action: "subagent", resource: "*", effect: "deny" }] }
            : {}),
        } as any)
        sid = sessionIDOf(created)
        if (!sid) throw new Error("会话创建失败：没有返回会话 ID")
        task.sessionID = sid
        await save(task)

        const actual = String(created?.location?.directory ?? created?.directory ?? "")
        if (actual && resolve(actual) !== task.directory) {
          await ctx.session.move({ sessionID: sid, directory: task.directory } as any)
        }

        await ctx.session.prompt({ sessionID: sid, text: workerPrompt(task), delivery: "queue" } as any)
        await ctx.session.wait({ sessionID: sid } as any)

        task.summary = await readResult(task)

        // 取消后又跑完的，不要把状态改回 done
        const latest = (await ctx.storage.get(key(task.id))) as TaskRecord | undefined
        const wasCancelled = latest?.state === "cancelled"

        await runGate(task, sid, latest?.state === "cancelled")

        task.finishedAt = new Date().toISOString()
        if (!wasCancelled) task.state = "done"
        else task.note = "已取消，worker 之后仍自行结束"
        await save(task)
      } catch (err: any) {
        task.state = "failed"
        task.finishedAt = new Date().toISOString()
        task.error = err?.message ? String(err.message) : String(err)
        await save(task)
      } finally {
        inFlight.delete(task.id)
      }
      await notifyOrigin(task)
    }

    const dispatch = async (input: any, toolCtx: any) => {
      const title = String(input?.title ?? "").trim()
      const brief = String(input?.brief ?? "").trim()
      if (!title || !brief) return { content: "缺少 title 或 brief，任务未派发。" }

      const running = (await loadAll()).filter((t) => t.state === "running").length
      if (running >= maxConcurrent) {
        return {
          content: `当前有 ${running} 个任务在跑，已达上限 ${maxConcurrent}。等其中一个完成，或先用 superagent_task_cancel 收掉一个。`,
        }
      }

      // 默认落在调用方会话所在的目录，而不是插件实例的目录
      let originDirectory = root
      if (toolCtx?.sessionID) {
        try {
          const origin: any = await ctx.session.get({ sessionID: toolCtx.sessionID } as any)
          if (typeof origin?.directory === "string" && origin.directory) originDirectory = origin.directory
        } catch {
          // 拿不到就退回插件实例目录
        }
      }

      const id = newID()
      const directory = resolveDirectory(
        typeof input?.directory === "string" ? input.directory : undefined,
        originDirectory,
      )

      const profileName = typeof input?.profile === "string" ? input.profile.trim() : ""
      let profile: Profile | undefined
      if (profileName) {
        profile = (await readProfiles()).find((item) => item.name === profileName)
        if (!profile) {
          return {
            content: `没有名为「${profileName}」的 agent。先 superagent_profile_list 看看有哪些，或用 superagent_profile_save 新建。`,
          }
        }
      }

      const requestedGate = typeof input?.gate === "string" ? input.gate.trim() : ""
      const gate: GateKind =
        requestedGate === "none" || requestedGate === "data" || requestedGate === "cite" || requestedGate === "text"
          ? (requestedGate as GateKind)
          : (profile?.gate ?? inferGate(`${title} ${brief}`))
      const task: TaskRecord = {
        id,
        title,
        brief,
        directory,
        gate,
        profile: profile ? { ...profile } : undefined,
        agent:
          typeof input?.agent === "string" && input.agent.trim()
            ? input.agent.trim()
            : (profile?.agent ?? undefined),
        originSessionID: toolCtx?.sessionID,
        resultPath: join(directory, ".superagent", id, "RESULT.md"),
        state: "running",
        createdAt: new Date().toISOString(),
      }
      await save(task)
      void run(task).catch((err) => {
        task.state = "failed"
        task.error = String(err?.message ?? err)
        void save(task)
      })

      return {
        content: [
          `已派发 ${id}：${title}`,
          profile ? `agent 设定：${profile.name}` : "agent 设定：默认",
          `目录：${directory}`,
          gateOn && gate !== "none" ? `完成后过审查：${reviewerFor(gate)}` : "审查：跳过",
          "它在独立会话里跑（默认不打扰你），完成后会有一条摘要回到本会话。",
          `中途可用 superagent_task_status 查 id=${id}，或 superagent_task_cancel 取消。`,
        ].join("\n"),
      }
    }

    const status = async (input: any) => {
      const wanted = typeof input?.id === "string" ? input.id.trim() : ""
      const tasks = await loadAll()
      const picked = wanted ? tasks.filter((t) => t.id === wanted) : tasks.slice(0, 12)
      if (picked.length === 0) return { content: wanted ? `没有找到任务 ${wanted}。` : "还没有任务。" }

      const lines = picked.map((t) => {
        const age = t.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(t.startedAt)) / 60000)) : 0
        const tail = t.state === "running" ? `，已跑 ${age} 分钟` : t.finishedAt ? `，${t.finishedAt}` : ""
        const gate = t.gateResult
        const mark =
          gate && gate.verdict !== "skipped"
            ? `；审查 ${gate.verdict === "pass" ? "通过" : `${gate.verdict} P0=${gate.p0} P1=${gate.p1}`}`
            : gate?.note
              ? `；审查未运行（${oneLine(gate.note, 40)}）`
              : ""
        return `${t.state.padEnd(9)} ${t.id}  ${t.title}（${t.directory}${tail}${mark}）`
      })
      return { content: ["状态 | id | 标题", ...lines].join("\n") }
    }

    const cancel = async (input: any) => {
      const id = typeof input?.id === "string" ? input.id.trim() : ""
      if (!id) return { content: "需要 id。" }
      const task = (await loadAll()).find((t) => t.id === id)
      if (!task) return { content: `没有找到任务 ${id}。` }
      if (task.state !== "running") return { content: `${id} 当前状态是 ${task.state}，无需取消。` }

      if (task.sessionID) {
        try {
          await ctx.session.interrupt({ sessionID: task.sessionID, resume: false } as any)
        } catch {
          // 会话可能已结束
        }
      }
      inFlight.delete(id)
      task.state = "cancelled"
      task.finishedAt = new Date().toISOString()
      await save(task)
      return { content: `已取消 ${id}。` }
    }

    const profileList = async () => {
      const profiles = await readProfiles()
      if (profiles.length === 0) {
        return {
          content: [
            "还没有 agent。用 superagent_profile_save 新建一个：",
            `superagent_profile_save({ name: "文献综述", gate: "cite", prompt: "…", skills: ["lit-review"], mcp: ["zotero"] })`,
            `存放位置：${profilesPath()}`,
          ].join("\n"),
        }
      }
      const lines = profiles.map((item) => {
        const bits = [`gate=${item.gate ?? "auto"}`]
        if (item.agent) bits.push(`agent=${item.agent}`)
        if (item.model) bits.push(`model=${item.model}`)
        if (item.mcp?.length) bits.push(`mcp=${item.mcp.join(",")}`)
        if (item.skills?.length) bits.push(`skills=${item.skills.join(",")}`)
        return `${item.name}  ·  ${bits.join(" · ")}${item.description ? `\n    ${item.description}` : ""}`
      })
      return { content: [`共 ${profiles.length} 个 agent：`, ...lines].join("\n") }
    }

    const profileSave = async (input: any) => {
      const name = String(input?.name ?? "").trim()
      if (!name) return { content: "需要 name。" }
      const profiles = await readProfiles()
      const index = profiles.findIndex((item) => item.name === name)
      const before = index >= 0 ? profiles[index] : ({ name } as Profile)

      const pick = (field: string) => (input && Object.prototype.hasOwnProperty.call(input, field) ? input[field] : undefined)
      const next: Profile = { ...before }
      const description = pick("description")
      if (typeof description === "string") next.description = description
      const agent = pick("agent")
      if (typeof agent === "string") next.agent = agent
      const model = pick("model")
      if (typeof model === "string") next.model = model
      const gate = pick("gate")
      if (gate === "data" || gate === "cite" || gate === "text" || gate === "none") next.gate = gate
      const prompt = pick("prompt")
      if (typeof prompt === "string") next.prompt = prompt
      const memory = pick("memory")
      if (typeof memory === "string") next.memory = memory
      const mcp = pick("mcp")
      if (Array.isArray(mcp)) next.mcp = mcp.filter((item: unknown) => typeof item === "string") as string[]
      const skills = pick("skills")
      if (Array.isArray(skills)) next.skills = skills.filter((item: unknown) => typeof item === "string") as string[]
      next.updatedAt = new Date().toISOString()

      if (index >= 0) profiles[index] = next
      else profiles.push(next)
      await writeProfiles(profiles)
      return {
        content: `${index >= 0 ? "已更新" : "已新建"} agent「${name}」。\n派活时传 profile: "${name}" 就会带上这套设定。`,
      }
    }

    const profileRemove = async (input: any) => {
      const name = String(input?.name ?? "").trim()
      if (!name) return { content: "需要 name。" }
      const profiles = await readProfiles()
      const remaining = profiles.filter((item) => item.name !== name)
      if (remaining.length === profiles.length) return { content: `没有名为「${name}」的 agent。` }
      await writeProfiles(remaining)
      return { content: `已删除 agent「${name}」。` }
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "superagent", description: "Router + Worker：把任务派给独立会话执行，完成后只回一条摘要" })

      editor.add({
        name: "profile_list",
        description: "列出所有可复用的 agent 设定（prompt / 记忆 / MCP / skill / gate）。",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "superagent", codemode: true },
        execute: profileList,
      })

      editor.add({
        name: "profile_save",
        description:
          "新建或更新一个 agent 设定。只传要改的字段，未传的保持原样。设定会整套带进 worker 会话。",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "agent 名字，派活时用 profile 引用" },
            description: { type: "string", description: "一句话说明它是干什么的" },
            agent: { type: "string", description: "worker 使用的 OpenCode agent 名" },
            model: { type: "string", description: "模型，格式 provider/model，如 deepseek/deepseek-flash" },
            gate: { type: "string", enum: ["data", "cite", "text", "none"], description: "默认审查类型" },
            prompt: { type: "string", description: "角色设定与做事要求" },
            memory: { type: "string", description: "长期记忆/背景事实，每次派活都带上" },
            mcp: { type: "array", items: { type: "string" }, description: "优先使用的 MCP 名称" },
            skills: { type: "array", items: { type: "string" }, description: "需要时加载的 skill 名" },
          },
          required: ["name"],
          additionalProperties: false,
        },
        options: { namespace: "superagent", codemode: true },
        execute: profileSave,
      })

      editor.add({
        name: "profile_remove",
        description: "删除一个 agent 设定。",
        input: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        options: { namespace: "superagent", codemode: true },
        execute: profileRemove,
      })

      editor.add({
        name: "task_dispatch",
        description:
          "把一件独立的事派给 worker 会话执行（独立上下文、独立目录），立即返回。完成或失败时会有摘要回到当前会话，不要轮询。",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "一句话说清要做什么" },
            brief: { type: "string", description: "自包含的任务说明：目标、范围、验收标准、已知约束" },
            directory: { type: "string", description: "任务目录（相对当前目录或绝对路径），默认当前目录" },
            agent: { type: "string", description: "可选：指定 worker 使用的 agent 名" },
            profile: { type: "string", description: "可选：使用哪个 agent 设定（prompt/记忆/MCP/skill/gate 一起带上）" },
            gate: {
              type: "string",
              enum: ["data", "cite", "text", "none"],
              description: "完成后用哪个只读审查代理验收；省略则按任务内容自动判断，none 表示跳过",
            },
          },
          required: ["title", "brief"],
          additionalProperties: false,
        },
        options: { namespace: "superagent", codemode: true },
        execute: dispatch,
      })

      editor.add({
        name: "task_status",
        description: "查看任务账本：正在跑、已完成、失败的任务及耗时。",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "可选：只看某个任务" } },
          additionalProperties: false,
        },
        options: { namespace: "superagent", codemode: true },
        execute: status,
      })

      editor.add({
        name: "task_cancel",
        description: "中断一个正在运行的任务并标记为已取消。",
        input: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        options: { namespace: "superagent", codemode: true },
        execute: cancel,
      })
    })

    // 看门狗：只处理"还标着 running 但已经超时"的任务
    const watchdog = setInterval(() => {
      void (async () => {
        const tasks = await loadAll()
        for (const task of tasks) {
          if (task.state !== "running" || !task.startedAt) continue
          const elapsed = Date.now() - Date.parse(task.startedAt)
          if (elapsed < timeoutMs) continue
          if (task.sessionID) {
            try {
              await ctx.session.interrupt({ sessionID: task.sessionID, resume: false } as any)
            } catch {
              // 会话已不存在，直接结账
            }
          }
          inFlight.delete(task.id)
          task.state = "stale"
          task.finishedAt = new Date().toISOString()
          task.error = `超过 ${Math.round(timeoutMs / 60000)} 分钟未结束，已中断`
          await save(task)
          await notifyOrigin(task)
        }
      })().catch(() => {})
    }, 30_000)

    return () => clearInterval(watchdog)
  },
})
