// 由 tui/build.mjs 生成：agent-file 已内联，单文件、无相对 import。

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { memo as _$memo, createComponent as _$createComponent, createTextNode as _$createTextNode, effect as _$effect, insertNode as _$insertNode, insert as _$insert, setProp as _$setProp, createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { RGBA } from "@opentui/core";
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

const RECENT_FAILURE_MS = 10 * 60_000;
const MAX_ROWS = 3;

/** 侧栏内容宽 34（WeSearch 实测内容宽 37，留 3 列余量）。 */
const CONTENT_WIDTH = 34;
const SEGMENT_WIDTH = 10;

/** 分段按钮底纹：半透明灰，深浅主题自适应；悬停加深一档。 */
const WASH_NONE = RGBA.fromValues(0, 0, 0, 0);
const WASH_IDLE = RGBA.fromValues(0.5, 0.5, 0.5, 0.2);
const WASH_HOVER = RGBA.fromValues(0.5, 0.5, 0.5, 0.38);

/** 展开/收起是全局状态：命令、标题点击、按钮读同一个信号。 */
const [expanded, setExpanded] = createSignal(true);

/* ------------------------------- 终端列宽 ------------------------------- */

/** 单个字符的终端列宽（CJK 及全角记 2 列，其余 1 列）。 */
function charWidth(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  const wide = cp >= 0x1100 && cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe30 && cp <= 0xfe4f || cp >= 0xff00 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6;
  return wide ? 2 : 1;
}
function colWidth(text) {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 按列宽截断，超宽补省略号。省略号本身要占 1 列，所以文本只能用到 max-1。 */
function clipCols(text, max) {
  if (max <= 0) return "";
  if (colWidth(text) <= max) return text;
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/**
 * 右侧留出固定列宽后把左侧补满。
 * 不给布局引擎留判断题：空格写进文本节点，宽度就一定是算好的。
 */
function padTo(text, cols) {
  const clipped = clipCols(text, Math.max(0, cols));
  return clipped + " ".repeat(Math.max(0, cols - colWidth(clipped)));
}

/* --------------------------------- 探针 --------------------------------- */

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

/* -------------------------------- 数据层 -------------------------------- */

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

/* -------------------------------- 组件 -------------------------------- */

/** 分段按钮：「 标签 」带底纹；灰=常态、白=悬停；点击触发。 */
function Segment(props) {
  const colors = () => readColors(props.context);
  const [hover, setHover] = createSignal(false);
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", 10);
    _$setProp(_el$, "height", 1);
    _$setProp(_el$, "onMouseUp", event => {
      if (event?.button !== 0) return;
      event?.stopPropagation?.();
      props.onPress();
    });
    _$setProp(_el$, "onMouseOver", () => setHover(true));
    _$setProp(_el$, "onMouseOut", () => setHover(false));
    _$setProp(_el$2, "width", "100%");
    _$setProp(_el$2, "textAlign", "center");
    _$setProp(_el$2, "selectable", false);
    _$insert(_el$2, () => ` ${props.label} `);
    _$effect(_p$ => {
      var _v$ = hover() ? WASH_HOVER : WASH_IDLE,
        _v$2 = hover() ? colors().fg : colors().muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
function Wall(props) {
  return (() => {
    var _el$3 = _$createElement("text");
    _$insertNode(_el$3, _$createTextNode(`│`));
    _$setProp(_el$3, "selectable", false);
    _$effect(_$p => _$setProp(_el$3, "fg", readColors(props.context).muted, _$p));
    return _el$3;
  })();
}
function Sidebar(props) {
  const colors = () => readColors(props.context);
  const [tasks, setTasks] = createSignal([]);
  const [agents, setAgents] = createSignal(0);
  const [headHover, setHeadHover] = createSignal(false);
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
  const statusWord = () => {
    if (running().length > 0) return `${running().length} 运行中`;
    if (failed().length > 0) return `${failed().length} 待处理`;
    return "空闲";
  };
  const headLeft = () => padTo(`${expanded() ? "▾" : "▸"} Superagent`, CONTENT_WIDTH - colWidth(statusWord()));

  /** 运行中优先，其次待处理；都空时退回最近完成的两条。 */
  const rows = () => {
    const live = [...running(), ...failed()].slice(0, MAX_ROWS);
    if (live.length > 0) return live;
    return recent();
  };

  /** 任务行拆两段：标题走正文色、时长走弱色，右端对齐到固定列宽。 */
  const rowParts = task => {
    const minutes = typeof task.minutes === "number" && task.minutes > 0 ? `${task.minutes}m` : "";
    const right = task.state === "running" || task.state === "done" ? minutes : "";
    const leftCols = CONTENT_WIDTH - colWidth(right);
    const title = clipCols(String(task.title ?? ""), Math.max(4, leftCols - 2));
    return {
      left: padTo(`${stateMark(task.state)} ${title}`, leftCols),
      right
    };
  };
  return (() => {
    var _el$5 = _$createElement("box"),
      _el$6 = _$createElement("box"),
      _el$7 = _$createElement("box"),
      _el$8 = _$createElement("text"),
      _el$9 = _$createElement("b"),
      _el$0 = _$createElement("text"),
      _el$1 = _$createElement("box");
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$1);
    _$setProp(_el$5, "flexDirection", "column");
    _$setProp(_el$5, "gap", 0);
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "height", 1);
    _$setProp(_el$6, "onMouseUp", event => {
      if (event?.button !== 0) return;
      event?.stopPropagation?.();
      setExpanded(!expanded());
    });
    _$setProp(_el$6, "onMouseOver", () => setHeadHover(true));
    _$setProp(_el$6, "onMouseOut", () => setHeadHover(false));
    _$insertNode(_el$7, _el$8);
    _$insertNode(_el$7, _el$0);
    _$setProp(_el$7, "flexDirection", "row");
    _$setProp(_el$7, "height", 1);
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "selectable", false);
    _$insert(_el$9, headLeft);
    _$setProp(_el$0, "selectable", false);
    _$insert(_el$0, statusWord);
    _$setProp(_el$1, "flexDirection", "row");
    _$setProp(_el$1, "height", 1);
    _$insert(_el$1, _$createComponent(Wall, {
      get context() {
        return props.context;
      }
    }), null);
    _$insert(_el$1, _$createComponent(Segment, {
      get context() {
        return props.context;
      },
      label: "\u4EFB\u52A1\u9762\u677F",
      onPress: () => void openPanel(props.context)
    }), null);
    _$insert(_el$1, _$createComponent(Wall, {
      get context() {
        return props.context;
      }
    }), null);
    _$insert(_el$1, _$createComponent(Segment, {
      get context() {
        return props.context;
      },
      get label() {
        return expanded() ? "收起面板" : "展开面板";
      },
      onPress: () => setExpanded(!expanded())
    }), null);
    _$insert(_el$1, _$createComponent(Wall, {
      get context() {
        return props.context;
      }
    }), null);
    _$insert(_el$1, _$createComponent(Segment, {
      get context() {
        return props.context;
      },
      label: "\u65B0\u5EFA\u4EE3\u7406",
      onPress: () => void createAgent(props.context)
    }), null);
    _$insert(_el$1, _$createComponent(Wall, {
      get context() {
        return props.context;
      }
    }), null);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return expanded();
      },
      get children() {
        return [_$createComponent(For, {
          get each() {
            return rows();
          },
          children: task => {
            const parts = rowParts(task);
            return (() => {
              var _el$13 = _$createElement("box"),
                _el$14 = _$createElement("text"),
                _el$15 = _$createElement("text");
              _$insertNode(_el$13, _el$14);
              _$insertNode(_el$13, _el$15);
              _$setProp(_el$13, "flexDirection", "row");
              _$setProp(_el$13, "height", 1);
              _$setProp(_el$14, "selectable", false);
              _$insert(_el$14, () => parts.left);
              _$setProp(_el$15, "selectable", false);
              _$insert(_el$15, () => parts.right);
              _$effect(_p$ => {
                var _v$6 = colors().fg,
                  _v$7 = colors().muted;
                _v$6 !== _p$.e && (_p$.e = _$setProp(_el$14, "fg", _v$6, _p$.e));
                _v$7 !== _p$.t && (_p$.t = _$setProp(_el$15, "fg", _v$7, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$13;
            })();
          }
        }), _$createComponent(Show, {
          get when() {
            return rows().length === 0;
          },
          get children() {
            var _el$10 = _$createElement("text");
            _$insertNode(_el$10, _$createTextNode(` 暂无任务 · /sa 派活`));
            _$setProp(_el$10, "selectable", false);
            _$effect(_$p => _$setProp(_el$10, "fg", colors().muted, _$p));
            return _el$10;
          }
        })];
      }
    }), null);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return agents() > 0;
      },
      get children() {
        var _el$12 = _$createElement("text");
        _$setProp(_el$12, "selectable", false);
        _$insert(_el$12, () => clipCols(` ${agents()} 个代理 · /sa 编辑`, CONTENT_WIDTH));
        _$effect(_$p => _$setProp(_el$12, "fg", colors().muted, _$p));
        return _el$12;
      }
    }), null);
    _$effect(_p$ => {
      var _v$3 = headHover() ? WASH_IDLE : WASH_NONE,
        _v$4 = colors().fg,
        _v$5 = colors().muted;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$6, "backgroundColor", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$0, "fg", _v$5, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$5;
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
    }, {
      id: "superagent.new",
      title: "Superagent：新建 agent",
      group: "Superagent",
      palette: true,
      slash: {
        name: "san"
      },
      run: () => void createAgent(props.context)
    }]
  }));
  return (() => {
    var _el$16 = _$createElement("box");
    _$setProp(_el$16, "flexDirection", "column");
    return _el$16;
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

/* -------------------------------- 面板 -------------------------------- */

async function createAgent(context) {
  try {
    const name = await context.ui.dialog.prompt({
      title: "新建代理",
      placeholder: "例如：数据核对"
    });
    if (!name || !name.trim()) return;
    const clean = name.trim();
    const profiles = readProfiles();
    if (profiles.some(item => item.name === clean)) {
      context.ui.toast.show({
        message: `「${clean}」已存在`,
        variant: "warning"
      });
      return;
    }
    saveProfiles([...profiles, {
      name: clean
    }]);
    await saveAgentFile({
      name: clean
    });
    probe(`新建代理 ${clean}`);
    context.ui.toast.show({
      message: `已创建「${clean}」，接着设置提示词`,
      variant: "success"
    });
    await editProfile(context, clean);
  } catch (error) {
    probe(`新建代理失败：${String(error)}`);
    context.ui.toast.show({
      message: `新建失败：${String(error)}`,
      variant: "error"
    });
  }
}
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
      await createAgent(context);
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
      description: field.value ? clipCols(field.value, 50) : "（空）"
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
  saveProfiles(updated);
  await saveAgentFile(next);
  probe(`已保存 ${name}.${picked}`);
  context.ui.toast.show({
    message: `已更新「${name}」的${field.label}`,
    variant: "success"
  });
}

// 模块级探针：能写出来就说明模块被求值了，比 setup 更早。
probe("module 已求值");

