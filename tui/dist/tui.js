// 由 tui/build.mjs 生成：agent-file 已内联，单文件、无相对 import。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { insertNode as _$insertNode, effect as _$effect, memo as _$memo, createComponent as _$createComponent, insert as _$insert, setProp as _$setProp, createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * agent 定义文件的生成规则。
 *
 * 服务端 server/index.ts 里有一份等价实现（插件目录之间互相 import 不到），
 * 两份必须产出同样的内容——`npm run check` 会拿磁盘上的真实文件来对。
 */

function agentSlug(name) {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-");
}
function agentMarkdown(profile) {
  const body = [profile.prompt ?? "", profile.memory ? `## 长期记忆\n${profile.memory}` : "", profile.mcp?.length ? `## 可用 MCP\n优先使用：${profile.mcp.join("、")}。` : "", profile.skills?.length ? `## 相关技能\n需要时加载：${profile.skills.join("、")}。` : ""].filter(Boolean).join("\n\n");
  return ["---", `description: ${JSON.stringify(profile.description ?? profile.name)}`, "mode: all", ...(profile.model ? [`model: ${profile.model}`] : []), "---", "", body || profile.name, ""].join("\n");
}
async function writeAgentFile(profile, baseDir) {
  const path = join(baseDir, `${agentSlug(profile.name)}.md`);
  await mkdir(dirname(path), {
    recursive: true
  });
  await writeFile(path, agentMarkdown(profile), "utf8");
  return path;
}

/** @jsxImportSource @opentui/solid */







/**
 * superagent 的 TUI 部分。
 *
 * 三件事：
 * 1. 侧边栏显示任务账本（可折叠，折叠状态由模块内信号共享）。
 * 2. /sa 面板：看任务、跳到对应会话、直接编辑 agent 设定的提示词/记忆/MCP/skill。
 * 3. /saf：收起或展开侧边栏。
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

const RECENT_FAILURE_MS = 10 * 60_000;
const MAX_ROWS = 3;

/** 展开/收起是全局状态：命令和侧边栏读同一个信号。 */
const [expanded, setExpanded] = createSignal(true);
function pidText() {
  try {
    if (typeof process !== "undefined" && process?.pid) return `pid=${process.pid}`;
  } catch {
    // TUI 沙箱里可能没有 process
  }
  return "no-process";
}
function baseDir() {
  try {
    const home = homedir();
    return home ? join(home, ".local", "share", "opencode", "superagent") : "";
  } catch {
    return "";
  }
}

/**
 * 探针用同步写：异步 append 在插件报错退出时可能来不及落盘，
 * 会让「加载失败」和「没加载」看起来一模一样。
 */
function probe(line) {
  try {
    const base = baseDir();
    if (!base) return;
    mkdirSync(base, {
      recursive: true
    });
    appendFileSync(join(base, "tui.log"), `${new Date().toISOString()} [${pidText()}] ${line}\n`, "utf8");
  } catch {
    // 探针本身绝不能影响插件
  }
}
function ledgerPath() {
  const base = baseDir();
  return base ? join(base, "tasks.json") : "";
}
function profilesPath() {
  const base = baseDir();
  return base ? join(base, "profiles.json") : "";
}
function agentsDir() {
  try {
    const home = homedir();
    return home ? join(home, ".config", "opencode", "agents") : "";
  } catch {
    return "";
  }
}
function clip(text, max = 30) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
function readJson(path, fallback) {
  if (!path) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function readLedger() {
  const snapshot = readJson(ledgerPath(), {});
  return Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
}
function readProfiles() {
  const list = readJson(profilesPath(), []);
  return Array.isArray(list) ? list : [];
}
function saveProfiles(profiles) {
  const path = profilesPath();
  if (!path) throw new Error("找不到数据目录");
  mkdirSync(dirname(path), {
    recursive: true
  });
  writeFileSync(path, JSON.stringify(profiles, null, 2), "utf8");
}

/** 规则与 server/index.ts 的 writeAgentFile 一致，实现共用 src/agent-file.ts。 */
function saveAgentFile(profile) {
  const dir = agentsDir();
  if (!dir) throw new Error("找不到 agents 目录");
  return writeAgentFile(profile, dir);
}
function removeAgentFile(name) {
  const dir = agentsDir();
  if (!dir) return;
  try {
    rmSync(join(dir, `${agentSlug(name)}.md`), {
      force: true
    });
  } catch {
    // 删不掉就算了，不影响主流程
  }
}
function isRecentFailure(task) {
  if (task.state !== "failed" && task.state !== "stale") return false;
  if (!task.finishedAt) return true;
  return Date.now() - Date.parse(task.finishedAt) < RECENT_FAILURE_MS;
}
function stateMark(state) {
  if (state === "running") return "●";
  if (state === "done") return "✓";
  if (state === "cancelled") return "■";
  return "✗";
}

/** 主题叶名两版并存：2.0.7 是 text.default/subdued，新版本是 text.base/muted。 */
function readColors(context) {
  try {
    const text = context.theme.text;
    return {
      fg: text.base ?? text.default,
      muted: text.muted ?? text.subdued
    };
  } catch {
    return {
      fg: undefined,
      muted: undefined
    };
  }
}
function Sidebar(props) {
  const colors = () => readColors(props.context);
  const [tasks, setTasks] = createSignal([]);
  const [agents, setAgents] = createSignal(0);
  const refresh = () => {
    setTasks(readLedger());
    setAgents(readProfiles().length);
  };
  refresh();
  const timer = setInterval(refresh, 4000);
  onCleanup(() => clearInterval(timer));
  const running = () => tasks().filter(task => task.state === "running");
  const failed = () => tasks().filter(isRecentFailure);
  const recent = () => tasks().filter(task => task.state === "done" || task.state === "cancelled").slice(0, 2);
  const head = () => {
    const mark = expanded() ? "▾" : "▸";
    if (running().length > 0) return `${mark} Superagent v5 · ${running().length} 个运行中`;
    if (failed().length > 0) return `${mark} Superagent v5 · ${failed().length} 个待处理`;
    return `${mark} Superagent v5 · 空闲`;
  };
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$insert(_el$2, head);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return expanded();
      },
      get children() {
        return [_$createComponent(For, {
          get each() {
            return [...running(), ...failed()].slice(0, MAX_ROWS);
          },
          children: task => (() => {
            var _el$4 = _$createElement("text");
            _$insert(_el$4, () => `  ${task.state === "running" ? "●" : "✗"} ${clip(task.title)}${task.state === "running" ? ` · ${task.minutes}m` : ""}`);
            _$effect(_$p => _$setProp(_el$4, "fg", colors().fg, _$p));
            return _el$4;
          })()
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => !!(running().length === 0 && failed().length === 0))() && recent().length > 0;
          },
          get children() {
            return _$createComponent(For, {
              get each() {
                return recent();
              },
              children: task => (() => {
                var _el$5 = _$createElement("text");
                _$insert(_el$5, () => `  ✓ ${clip(task.title)}`);
                _$effect(_$p => _$setProp(_el$5, "fg", colors().fg, _$p));
                return _el$5;
              })()
            });
          }
        }), _$createComponent(Show, {
          get when() {
            return agents() > 0;
          },
          get children() {
            var _el$3 = _$createElement("text");
            _$insert(_el$3, () => `  ${agents()} 个 agent · /sa 编辑`);
            _$effect(_$p => _$setProp(_el$3, "fg", colors().muted, _$p));
            return _el$3;
          }
        })];
      }
    }), null);
    _$effect(_$p => _$setProp(_el$2, "fg", colors().fg, _$p));
    return _el$;
  })();
}

/**
 * 命令层必须在已挂载的组件里注册（keymap.layer 要读 Solid 上下文），
 * 且不能从槽位 render 里返回 null——宿主会把它当空子树插入。
 */
function Commands(props) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "superagent.panel",
      title: "Superagent：任务与 agent 设定",
      group: "Superagent",
      palette: true,
      slash: {
        name: "sa"
      },
      run: () => void openPanel(props.context)
    }, {
      id: "superagent.fold",
      title: "Superagent：收起/展开侧边栏",
      group: "Superagent",
      palette: true,
      slash: {
        name: "saf"
      },
      run: () => setExpanded(!expanded())
    }]
  }));
  return (() => {
    var _el$6 = _$createElement("box");
    _$setProp(_el$6, "flexDirection", "column");
    return _el$6;
  })();
}
export default Plugin.define({
  id: "superagent.tui",
  setup(context) {
    probe("setup 进入");
    let stopSidebar;
    let stopCommands;
    try {
      stopSidebar = context.ui.slot({
        append: "sidebar.content",
        render: () => _$createComponent(Sidebar, {
          context: context
        })
      });
      probe("sidebar 槽位已注册");
    } catch (error) {
      probe(`sidebar 注册失败：${String(error)}`);
    }
    try {
      stopCommands = context.ui.slot({
        append: "app",
        render: () => _$createComponent(Commands, {
          context: context
        })
      });
      probe("app 槽位已注册");
    } catch (error) {
      probe(`app 注册失败：${String(error)}`);
    }
    return () => {
      try {
        stopSidebar?.();
      } catch {
        // 卸载失败不该抛出
      }
      try {
        stopCommands?.();
      } catch {
        // 同上
      }
    };
  }
});
async function openPanel(context) {
  probe("/sa 触发");
  try {
    const tasks = readLedger();
    const profiles = readProfiles();
    probe(`/sa 任务 ${tasks.length} 条，agent ${profiles.length} 个`);
    const options = [...profiles.map(profile => ({
      title: `✎ ${profile.name}`,
      value: `profile:${profile.name}`,
      category: "Agent 设定",
      description: profile.description ?? "编辑提示词 / 记忆 / MCP / skill"
    })), ...tasks.slice(0, 12).map(task => ({
      title: `${stateMark(task.state)} ${task.title}`,
      value: `task:${task.id}`,
      category: "任务",
      description: `${task.id} · ${task.minutes}m`,
      disabled: !task.sessionID
    })), {
      title: "＋ 新建 agent",
      value: "new",
      category: "Agent 设定",
      description: "输入名字，再逐项设置"
    }];
    const picked = await context.ui.dialog.select({
      title: "Superagent",
      options
    });
    if (!picked) return;
    if (picked === "new") {
      const name = await context.ui.dialog.prompt({
        title: "新建 agent",
        placeholder: "例如：数据核对"
      });
      if (!name || !name.trim()) return;
      const clean = name.trim();
      await saveProfiles([...profiles, {
        name: clean
      }]);
      await saveAgentFile({
        name: clean
      });
      await editProfile(context, clean);
      return;
    }
    if (picked.startsWith("profile:")) {
      await editProfile(context, picked.slice("profile:".length));
      return;
    }
    if (picked.startsWith("task:")) {
      const id = picked.slice("task:".length);
      const target = tasks.find(task => task.id === id);
      if (target?.sessionID) context.ui.router.navigate({
        type: "session",
        sessionID: target.sessionID
      });
    }
  } catch (error) {
    probe(`/sa 执行失败：${String(error)}`);
    context.ui.toast.show({
      message: `操作失败：${String(error)}`,
      variant: "error"
    });
  }
}
async function editProfile(context, name) {
  const profiles = readProfiles();
  const profile = profiles.find(item => item.name === name);
  if (!profile) {
    context.ui.toast.show({
      message: `没有找到 agent ${name}`,
      variant: "error"
    });
    return;
  }
  const fields = [{
    id: "prompt",
    label: "提示词",
    value: profile.prompt ?? ""
  }, {
    id: "memory",
    label: "长期记忆",
    value: profile.memory ?? ""
  }, {
    id: "mcp",
    label: "MCP（逗号分隔）",
    value: (profile.mcp ?? []).join(", ")
  }, {
    id: "skills",
    label: "Skill（逗号分隔）",
    value: (profile.skills ?? []).join(", ")
  }, {
    id: "gate",
    label: "审查类型",
    value: profile.gate ?? "auto"
  }, {
    id: "description",
    label: "一句话说明",
    value: profile.description ?? ""
  }, {
    id: "agent",
    label: "worker agent",
    value: profile.agent ?? ""
  }, {
    id: "model",
    label: "模型",
    value: profile.model ?? ""
  }];
  const picked = await context.ui.dialog.select({
    title: `编辑 ${name}`,
    options: fields.map(field => ({
      title: field.label,
      value: field.id,
      description: field.value ? clip(field.value, 50) : "（空）"
    }))
  });
  if (!picked) return;
  const field = fields.find(item => item.id === picked);
  if (!field) return;
  const answer = await context.ui.dialog.prompt({
    title: field.label,
    placeholder: field.value || "留空表示清空"
  });
  if (answer === undefined) return;
  const next = {
    ...profile
  };
  const text = answer.trim();
  if (picked === "mcp" || picked === "skills") {
    const list = text ? text.split(/[,，]/).map(item => item.trim()).filter(Boolean) : [];
    if (picked === "mcp") next.mcp = list;else next.skills = list;
  } else if (picked === "gate") {
    next.gate = text || undefined;
  } else {
    ;
    next[picked] = text || undefined;
  }
  const updated = profiles.map(item => item.name === name ? next : item);
  await saveProfiles(updated);
  await saveAgentFile(next);
  probe(`已保存 ${name}.${picked}`);
  context.ui.toast.show({
    message: `已更新「${name}」的${field.label}`,
    variant: "success"
  });
}

// 模块级探针：能写出来就说明模块被求值了，比 setup 更早。
probe("module 已求值");

