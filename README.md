# dsh-luastg-mcp

**v1.1.0** · 7 个核心工具 · TCP NDJSON 传输 · 需要 DSH `0.2.0-rc.2`、Node `>= 22.13`

[![CI](https://github.com/KerbalHorizon/dsh-luastg-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/KerbalHorizon/dsh-luastg-mcp/actions/workflows/ci.yml)
[![Case Study](https://img.shields.io/badge/%F0%9F%93%9A-Video--to--Code%20Case%2001-8a2be2)](docs/cases/case-study.md)

📚 **Includes Video-to-Code Case Study (Case 01)** — 一段实机录像 → 视频分析 → 节点树复刻 →
F5 观感对齐的完整复盘，含 10 项差异对照与 `LocalVar` 作用域 Bug 全记录：
[docs/cases/case-study.md](docs/cases/case-study.md)

DSH（DeepSeek Harness）插件：通过 TCP 连接 **LuaSTG Editor Sharp X** 进程内的
`LuaSTGMcpBridge`，把编辑器**当前打开**的 `.lstges` 工程节点树暴露给模型，并让模型
**通过编辑器真实 Command** 修改节点。

核心取舍：v1.0.0 起**完全不碰 `.lstges` 文件**——不解析文本、不算 sha256、不写临时文件、
不做备份、不做原子替换。读和写都发生在运行中的编辑器对象模型里，因此
**Undo / Redo 和 WPF 节点树的自动刷新天然有效**，编辑器始终是唯一数据权威。

---

## 目录

- [1. 它解决什么问题](#1-它解决什么问题)
- [2. 架构设计](#2-架构设计)
- [3. 五个核心工具](#3-五个核心工具)
- [4. 安装步骤](#4-安装步骤)
- [5. 配置](#5-配置)
- [6. 节点地址 `path`](#6-节点地址-path)
- [7. 错误处理](#7-错误处理)
- [8. 开发与测试](#8-开发与测试)
- [9. 安全边界与已知限制](#9-安全边界与已知限制)
- [10. v1.0.0 验收记录](#10-v100-验收记录)
- [11. 视频逆向解析 (Video-to-Danmaku)](#11-视频逆向解析-video-to-danmaku)
- [12. 版本与兼容](#12-版本与兼容)
- [案例库：视频逆向 Case 01](docs/cases/case-study.md)

---

## 1. 它解决什么问题

模型需要理解并修改一个**正在编辑器里打开的** LuaSTG 工程，而工程文件是编辑器私有的
XML 结构，格式细节多、易写错，而且：

- 直接改文件 → 编辑器不知道，用户看到的还是旧视图，必须手动重载；
- 直接改文件 → 没有撤销，一步写错就污染工程；
- 直接改文件 → 编辑器保存时会覆盖外部改动，形成竞态。

本插件的做法是把**编辑器本身**当成 API：所有读写都发给编辑器里的桥接，由 C# 在
WPF UI 线程上执行真实命令。效果是模型改完之后，用户**当场就能在界面上看到节点出现、
文本变化，并且可以 Ctrl+Z 撤销**。

---

## 2. 架构设计

### 2.1 分层总览

```
┌────────────────────────── DSH 进程（TypeScript） ──────────────────────────┐
│  luastg_get_nodes / add_node / update_node / update_script / delete_node    │
│        │  defineTool handler                                                │
│        ▼                                                                    │
│  BridgeClient（node:net）                                                   │
│    • 每次调用新建一条 TCP 连接，收到响应即关闭                              │
│    • UTF-8 NDJSON：一行一个 JSON 对象，'\n' 结尾                            │
│    • timeoutMs 连接+响应超时，支持 AbortSignal 取消                         │
│    • 无缓存、无后台常驻连接、无重连风暴                                     │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ 127.0.0.1:8090（仅 loopback）
┌───────────────────────────────────▼──────── LuaSTG 编辑器进程（C# / WPF）──┐
│  TcpBridgeServer    每连接一个读取循环，按行切分 JSON                       │
│        ▼                                                                    │
│  BridgeRouter       按 action 分发 + 参数校验，异常收敛为 status/error      │
│        ▼                                                                    │
│  TreeActions        get_tree / insert_node / set_attribute / delete_node    │
│        ▼                                                                    │
│  UiThread.Invoke    Dispatcher 编组到编辑器 UI 线程                         │
│        ▼                                                                    │
│  DocumentData.AddAndExecuteCommand                                          │
│    （InsertCommand / DeleteCommand / EditAttrCommand）                      │
│        ▼                                                                    │
│  Undo/Redo 栈 + WPF TreeView 自动刷新                                       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 TS 侧：无状态 TCP 客户端

`src/bridge-client.ts` 只做一件事：把一次工具调用翻译成一行 JSON，发出去，读回一行 JSON。

- **一调用一连接**：不维护长连接池。编辑器崩溃/重启后，下一次调用自然失败，不会出现
  “连接看起来还在、实际已死”的僵尸状态。
- **超时与取消**：`timeoutMs`（默认 5000，范围 100–60000）覆盖连接和响应两个阶段；
  工具层把 `AbortSignal` 透传进来，模型侧取消会关闭 socket。
- **协议错误分类**：连接拒绝 → `BridgeUnavailableError`；超时 → `BridgeTimeoutError`；
  非法 JSON / 缺 `status` → `BridgeProtocolError`；`status != ok` → `BridgeCommandError`
  （带桥接原始 `error` / `details`）。
- **不缓存树**：路径是位置索引，缓存必然漂移，所以每次都向编辑器要最新状态。
- **返回值加信封**：`{ ok, source: "editor", transport: "tcp", endpoint, action, elapsedMs, ... }`，
  桥接原始字段（`document` / `tree` / `path` / `type` / `text` / `attributes`）原样透传。

### 2.3 C# 侧：WPF UiThread 桥接

桥接源码在仓库 `D:\LuaSTG-Editor-Sharp-X-main\LuaSTGMcpBridge`（独立于本插件，单独编译）。

| 组件 | 职责 |
|---|---|
| `TcpBridgeServer` | 只绑定 `IPAddress.Loopback`；每连接一个线程，`ReadLine` 切分 NDJSON |
| `BridgeRouter` | `action` 大小写不敏感分发；参数缺失/类型错误统一成 `bad_request` |
| `TreeActions` | 真正的树操作：`get_tree` / `insert_node` / `set_attribute` / `delete_node` |
| `NodePath` | 把 `"0/4/2"` 解析成 `TreeNodes[0].Children[4].Children[2]` |
| `NodeSnapshot` | 遍历时给每个节点算好 `path`，客户端不需要自己拼路径 |
| `NodeFactory` | 按类型名反射 `(DocumentData)` 构造函数创建节点，并在插入前套用初始属性 |
| `UiThread` | `Dispatcher.Invoke` 编组，所有访问 `DocumentData` 的代码都在 UI 线程上跑 |
| `EditorContext` | 通过 `IMainWindow.ActivatedWorkSpaceData` 取活动文档；没有文档返回 `no_document` |

**为什么必须走 UI 线程：** `DocumentData`、`TreeNode`、绑定的 `TreeView` 都是 WPF
线程关联对象。socket 线程直接改会抛
`The calling thread cannot access this object because a different thread owns it`，
或者更糟——绑定静默失效。所有 handler 一律 `UiThread.Invoke`。

**为什么用 Command 而不是直接改集合：** 编辑器的撤销栈只认可
`DocumentData.AddAndExecuteCommand`。走 Command 才有三件事同时成立：

1. `Ctrl+Z` / `Ctrl+Y` 能完整还原（删除连整棵子树和属性一起回来）；
2. `TreeView` 的 `INotifyCollectionChanged` / 属性通知自动触发，界面立刻刷新；
3. 文档的 `dirty` 标记由编辑器自己维护，保存/关闭提示行为与手工编辑一致。

### 2.4 一次调用的完整时序

1. 工具 handler 解析参数（`path` / `node_type` / `attributes` / `script_content`…）；
2. `BridgeClient` 新建 socket，写入 `{"action":"...", ...}\n`；
3. 桥接读到一行 → `BridgeRouter` 分发 → `TreeActions`；
4. `UiThread.Invoke` 切到编辑器 UI 线程，拿到活动文档；
5. 读操作走 `NodeSnapshot.Capture`；写操作构造 Command 交给 `AddAndExecuteCommand`；
6. 编辑器执行 Command，撤销栈 +1，WPF 视图刷新；
7. 桥接回写一行 `{"status":"ok", ...}\n`；
8. TS 侧解析、包信封、关闭 socket，返回给模型。

### 2.5 协议契约（摘要）

完整协议见 [docs/bridge-protocol.md](docs/bridge-protocol.md)。

- 传输：TCP `127.0.0.1:8090`，UTF-8 无 BOM，一行一个紧凑 JSON，`\n` 结尾；
- 请求必须带字符串 `action`（trim 后、大小写不敏感匹配）；
- 响应一定带字符串 `status`：成功是 `"ok"`（`ping` 是 `"pong"`），其余都是错误码；
- 错误形如 `{"status":"no_document","error":"...","details":{...}}`，`details` 可选；
- 位置路径：`"0"` 是根，`"0/4/2"` 是根第 5 个子节点的第 3 个子节点。

| 桥接 action | 用途 | 是否修改文档 |
|---|---|---|
| `ping` | 健康检查 | 否 |
| `editor_state` | 文档摘要（名、路径、dirty、节点数） | 否 |
| `get_tree` | 读取子树 | 否 |
| `insert_node` | 插入一个节点 | 是（`InsertCommand`） |
| `set_attribute` | 改一个属性 | 是（`EditAttrCommand`） |
| `delete_node` | 删除子树 | 是（`DeleteCommand`） |

---

## 3. 七个核心工具

| 工具 | 读写 | 桥接 action | 作用 |
|---|---|---|---|
| `luastg_get_nodes` | 只读 | `get_tree` | 读取当前活动文档的节点树 |
| `luastg_update_node` | 写入 | `set_attribute` × N | 修改节点上已存在的属性，逐属性一条可撤销命令 |
| `luastg_add_node` | 写入 | `insert_node` | 通过 `InsertCommand` 插入一个节点 |
| `luastg_apply_subtree` | 写入 | `insert_node`（深度优先） | 一次调用建出整棵嵌套子树 |
| `luastg_delete_node` | 写入 | `delete_node` | 通过 `DeleteCommand` 删除一个节点及其子树 |
| `luastg_update_script` | 写入 | `set_attribute`（`Code`） | 替换节点的 `Code` 属性（多行 Lua 脚本） |
| `luastg_take_screenshot` | 只读 | `take_screenshot`（可选） | 截取编辑器窗口，返回 PNG 的 Base64 |

### 3.1 `luastg_get_nodes`

读取编辑器当前活动文档的节点树。只读，不写盘、不改编辑器。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `path` | string | `"0"` | 要读取的子树根路径；支持旧点号格式 |
| `node_id` | string | — | `path` 的 deprecated 别名 |
| `maxDepth` | integer | 配置值（默认 0） | 相对选中节点的深度；0 = 全部 |
| `attributes` | boolean | `true` | 是否返回属性值；大工程可设 `false` |

返回示例（节选）：

```json
{
  "ok": true,
  "source": "editor",
  "transport": "tcp",
  "endpoint": "127.0.0.1:8090",
  "action": "get_tree",
  "status": "ok",
  "path": "0",
  "maxDepth": 0,
  "attributes": true,
  "document": {
    "name": "Example Project",
    "path": "D:\\LuaSTG\\Example Project.lstges",
    "extension": ".lstges",
    "dirty": false,
    "nodeCount": 1842
  },
  "tree": {
    "path": "0",
    "type": "RootFolder",
    "text": "Example Project",
    "attributeCount": 3,
    "childCount": 2,
    "attributes": [{ "name": "Name", "value": "Example Project", "editWindow": "" }],
    "children": []
  }
}
```

> 大工程建议先 `{"maxDepth": 2}` 看结构，再对具体 `path` 读取完整子树。

### 3.2 `luastg_update_node`

修改一个节点上**已经存在**的属性。`attributes` 里每个键都会单独发一条 `set_attribute`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 二选一 | 节点路径，如 `"0/4/2"` |
| `node_id` | string | 二选一 | 旧点号 id，如 `"0.4.2"` |
| `attributes` | object | 是 | 属性名 → 新值；值可为 string / number / boolean，编辑器统一存成文本 |

**非原子**：C# 只有单属性 `set_attribute`，多属性按对象键顺序逐个发送。若第 2 个失败，
第 1 个已经生效，错误会明确列出：

```
luastg_update_node: unknown_attribute: node '0' (...) has no attribute 'Missing' ...
(1 attribute(s) already applied: Name; they are NOT rolled back — use the editor undo if needed)
```

```json
{
  "ok": true,
  "path": "0/4/2",
  "changed": [{ "name": "Comment", "oldValue": "old", "newValue": "new", "changed": true }],
  "unchanged": [],
  "changedCount": 1,
  "unchangedCount": 0,
  "text": "new"
}
```

`Code` 这类长值不回吐全文，只给 `oldChars` / `newChars` / `oldBytes` / `newBytes` 和
`valuesOmitted: true`；脚本请改用 `luastg_update_script`。

### 3.3 `luastg_add_node`

在指定父节点下插入一个新节点。C# 侧执行真实 `InsertCommand`。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `parent` | string | 否 | 父节点路径；默认根 `"0"` |
| `parent_id` | string | 否 | `parent` 的 deprecated 别名 |
| `node_type` | string | 是 | .NET 类名、完整名，或旧 `.lstges` 简写 |
| `attributes` | object | 否 | 初始属性；不存在的属性名会被编辑器拒绝 |
| `index` | integer | 否 | 0 起始的插入位置；默认追加到末尾 |

`node_type` 可写 `Comment` / `TaskWait` / `Folder`（类名）、完整名，或旧简写
`General.Folder` / `Task.TaskWait`。插件会把简写归一到类名再发给桥接；C# 的
`NodeFactory` 只按 `Type.Name` / `Type.FullName` 匹配。写错返回 `unknown_node_type`，
`details.suggestions` 给出相近类名。

未提供的属性使用该类型构造函数的默认值；v0.5.0 的“从同类型模板节点复制属性”
已随 `template_id` 移除。

返回新节点的 `path` / `type` / `text` / `parentPath` / `index` / `selected` / `nodeCount`，
并附 `pathNote` 提醒路径可能漂移。

**插入 `Stage` 时会自动补初始化块。** 编辑器 UI 的 “Add Stage” 会建出
`Stage → TaskNode → Folder "Initialize" → StageBG`（见 `PluginToolbox.AddStageNode`），
而桥接的 `InsertNodeCore` 只插你指定的那一个节点，于是桥接生成的 `Stage` 会是空壳。
插件在插入成功后立刻检查并补齐：

```
Stage "Stage 1"
└─ Folder "Initialize"            ← 索引 0，先于关卡流程
   └─ StageBG  Background=temple_background
```

- 结果放在响应的 `stageDefaults` 里：`{ stages, initialized, alreadyInitialized, items[], nodeCount }`，
  `items[].action` 取值 `created` / `folder-added` / `background-added` / `already-initialized` / `failed`；
- 已有 `Initialize` 文件夹但里面没有背景节点 → 只补背景（`background-added`）；
- 已经有 `Stage` 下的背景节点 → 只补文件夹（`folder-added`），**绝不重复创建背景**；
- 补节点失败时插 `Stage` 依然算成功，失败原因写进 `stageDefaults.warning`，不回滚。

> 注意属性名不一定是直觉写写：`Comment` 节点的正文属性叫 **`Comment`**（不是 `Text`），
> `Code` 节点的脚本属性叫 **`Code`**。不确定时先 `luastg_get_nodes` 看 `attributes[].name`。

### 3.4 `luastg_apply_subtree`

一次调用建出整棵嵌套子树，适合“造敌 + 等待 + 位移”这类一整段关卡逻辑。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `parent` | string | 否 | 子树根挂到哪个节点下；默认根 `"0"` |
| `tree` | object | 是 | 嵌套结构 `{"type","attributes","children"}` |
| `reveal` | boolean | 否 | 是否展开并选中新建节点；默认 `true` |

```json
{
  "parent": "0",
  "tree": {
    "type": "StageGroup",
    "attributes": { "Name": "Stage 1", "Start life": "7" },
    "children": [
      {
        "type": "Stage",
        "attributes": { "Name": "Stage 1" },
        "children": [
          { "type": "TaskNode", "children": [
              { "type": "CreateEnemy", "attributes": { "Name": "\"fairy\"", "Position": "320,240" } }
          ] }
        ]
      }
    ]
  }
}
```

`type` 的写法与 `luastg_add_node` 的 `node_type` 完全一致（类名 / 完整名 / 旧简写）。
每一层都可以带 `attributes` 与 `children`。

**实现方式**：协议 v1 里没有批量插入 action，插件会先尝试 `apply_subtree`（为将来
的桥接版本留口），收到 `unknown_action` 后记住“该桥接不支持”，随后按**深度优先**
逐节点发 `insert_node`：父节点先建，子节点挂到桥接返回的真实 `path` 上，路径不靠
调用方推算。任何一步被编辑器拒绝（`unknown_attribute`、`validation_failed`、
`unknown_node_type`…），已经建出来的节点会通过一次 `delete_node` 整体删掉，**文档
回到调用前的样子**。

> `tree` 里出现的每个 `Stage` 都会走 §3.3 的初始化补全：缺 `Initialize` 文件夹或背景节点
> 时自动补上，已经有的不重复建；结果同样在响应的 `stageDefaults` 里。

### 3.5 `luastg_delete_node`

删除一个节点及其整棵子树。C# 侧执行真实 `DeleteCommand`，一次 Undo 恢复整棵子树。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 二选一 | 要删除的节点路径 |
| `node_id` | string | 二选一 | 旧点号 id |

根节点（`"0"`）不能删除；标有 `[CannotDelete]` 的类型会被编辑器拒绝。
`dry_run` 已移除——C# 桥接不支持预演，不要依赖“先试后删”。

删除会让后面的兄弟节点**整体前移**，因此删除后对其他节点操作前必须重新 `get_nodes`。

### 3.6 `luastg_update_script`

替换节点的 `Code` 属性。实现上就是：

```json
{"action": "set_attribute", "path": "0/4/2", "name": "Code", "value": "..."}
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 二选一 | 节点路径 |
| `node_id` | string | 二选一 | 旧点号 id |
| `script_content` | string | 是 | 完整新 Lua 源码；空字符串表示清空；最大 4 MiB UTF-8 |

文本原样发送，TS 侧不做换行归一化或转义；编辑器负责持久化。返回值只包含
`script` / `previous` 的字符数、行数、字节数，以及 `changed` 和节点 `text`，**不回吐旧脚本**。

```json
{
  "ok": true,
  "path": "0/4/2",
  "attribute": "Code",
  "changed": true,
  "script": { "chars": 60, "lines": 3, "bytes": 60 },
  "previous": { "chars": 0, "lines": 0, "bytes": 0 },
  "text": "print(\"Hello LuaSTG Real-time!\")\nlocal x = 100\nlocal y = 200"
}
```

### 3.7 `luastg_take_screenshot`

截取编辑器窗口，**阅后即焚**：返回 PNG 的 Base64，不在磁盘上留任何文件。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `window_title` | string | 否 | 本地截图时匹配的窗口标题子串，默认 `"LuaSTG Editor"` |

两条路径：

1. **桥接优先**：发 `{"action":"take_screenshot"}`。C# 侧用 `RenderTargetBitmap` 渲染
   `MainWindow`，直接编码进 `MemoryStream` 返回 Base64，**全程不落盘**。源码见
   [csharp/take-screenshot.cs](csharp/take-screenshot.cs)（重建桥接后生效）。
2. **本地兜底**：桥接返回 `unknown_action` 时，调用
   [scripts/capture-window.ps1](scripts/capture-window.ps1) 抓窗口，写到
   `%TEMP%\luastg_shot_<时间戳>_<随机>.png`，读进内存后**立刻 `unlink`**；
   写在 `finally` 里，因此截图失败也同样删干净。可用配置 `captureFallback: false` 关闭。

```json
{
  "ok": true,
  "source": "powershell",
  "format": "png",
  "bytes": 221807,
  "window": "LuaSTG Editor",
  "imageBase64": "iVBORw0KGgoAAAANSUhEUgAA…",
  "temporaryFileWritten": true,
  "temporaryFileDeleted": true,
  "elapsedMs": 1991
}
```

图片以 Base64 放在结构化结果里；`render` 只回一段摘要，避免几 MB 的 Base64 撑爆上下文。

---

## 4. 安装步骤
### 4.1 前置条件

1. **编辑器已启动并加载桥接**：`LuaSTG Editor Sharp X` 的 `editor.log` 中出现
   `MCP bridge ready on 127.0.0.1:8090.`。
2. **编辑器里打开了一个 `.lstges` 工程**：没有活动文档时桥接返回 `no_document`
   （只开启动页不算）。
3. **DSH `0.2.0-rc.2`**（`>=0.2.0-rc.2 <0.3.0`）、**Node `>= 22.13`**。

### 4.2 装进当前桌面端 profile

```powershell
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\DSHProgramme\dsh-luastg-mcp'
```

> 上面的路径按你自己的安装位置替换：`dsh.cmd` 在 DSH 安装目录的
> `resources\runtime\cli\bin\` 下，第二个参数是本仓库目录。

### 4.3 完全重启 DSH

**必须完全退出并重新启动 DeepSeek Harness 进程。** 工具注册发生在进程启动时，
只刷新 Web 页面不会加载新工具。

### 4.4 验证

```powershell
# 1) 端口在听
Test-NetConnection 127.0.0.1 -Port 8090

# 2) 配置里能看到插件（不需要打开界面）
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' --profile desktop --dump-config | Select-String luastg

# 3) 真正的端到端 smoke test：让模型调 luastg_get_nodes
#    期望返回 status: "ok" 和当前文档的 document / tree
```

桥接侧自检脚本（不碰真实工程也能验协议）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  'D:\LuaSTG-Editor-Sharp-X-main\LuaSTGMcpBridge\tests\mcp-crud-test.ps1' -Step ping
```

### 4.5 卸载与隔离 profile

```powershell
# 卸载
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-luastg-mcp
```

想在不影响当前 GUI 的前提下试用，可以开一个独立 profile：

```powershell
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' --profile luastg --from-default-profile web
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile luastg add 'D:\DSHProgramme\dsh-luastg-mcp'
& 'D:\Deepseek Harness\resources\runtime\cli\bin\dsh.cmd' luastg
```

---

## 5. 配置

全部可选；默认连 `127.0.0.1:8090`：

```yaml
- id: luastg-mcp
  config:
    host: '127.0.0.1'
    port: 8090
    timeoutMs: 5000
    maxDepth: 0        # luastg_get_nodes 的默认深度；0 = 整棵树
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `'127.0.0.1'` | 桥接地址；C# 只绑定 loopback，改别的值连不上 |
| `port` | `8090` | 桥接端口 |
| `timeoutMs` | `5000` | 单次调用的连接 + 响应超时（100–60000） |
| `maxDepth` | `0` | `luastg_get_nodes` 默认深度；0 返回整棵树，2–3 适合大工程结构扫描 |

> 配置写在 profile 的 `cordis.patch.yml` 里，会在本 bundle 的 patch 之后应用。
> patch 会整行替换 `config`，想保留默认值的字段不要写，或写全。

---

## 6. 节点地址 `path`

节点用**位置路径**寻址，与 C# 的 `NodePath` 完全一致：

- `"0"` 是文档根节点（`RootFolder`）；
- `"0/4/2"` 是根的第 5 个子节点的第 3 个子节点；
- 每个工具返回的节点都带 `path` 字段，直接拿它继续调用即可。

**路径是位置索引，不是稳定 id。** 在某个父节点下插入或删除节点后，后面的兄弟节点会
左移/右移：删除 `0/0` 后，原来的 `0/1` 会变成 `0/0`。所以**结构修改后必须先重新
`luastg_get_nodes`**，不要跨修改缓存 `path`。

### 旧 `node_id` 仍然可用

v0.5.0 使用点分隔的 `node_id`（`"0.4.2"`）。v1.0.0 中：

- `path` 接受 `/` 或 `.` 分隔，旧值可以直接塞进 `path`；
- 保留 `node_id` 参数（`add_node` 是 `parent_id`）作为 deprecated 别名；
- 同时给 `path` 和 `node_id` 且指向不同节点时，报 `conflicting-node-reference`；
- 返回值只给规范 `path`，不再返回旧 id。

| 旧写法 | 新写法 |
|---|---|
| `{"node_id": "0.4.2", "attributes": {...}}` | `{"path": "0/4/2", "attributes": {...}}` |
| `{"node_id": "0.4.2", "script_content": "..."}` | `{"path": "0/4/2", "script_content": "..."}` |
| `{"parent_id": "0.4", "node_type": "Comment"}` | `{"parent": "0/4", "node_type": "Comment"}` |
| `{"node_id": "0.4.2", "dry_run": true}` | `{"path": "0/4/2"}`（`dry_run` 已移除） |

`node_id` 计划在 2.0 移除；新调用请统一使用 `path` / `parent`。

---

## 7. 错误处理

工具错误统一以 `luastg_<tool>: ` 开头。

### 编辑器没开 / 桥接没启动

```
luastg_get_nodes: 无法连接 LuaSTG 编辑器 MCP 桥接（127.0.0.1:8090）：连接失败，请确保 LuaSTG 编辑器已启动并加载了 MCP 桥接插件。原始错误：connect ECONNREFUSED ...
```

### 桥接超时

```
luastg_get_nodes: LuaSTG 编辑器 MCP 桥接在 5000 ms 内未响应（127.0.0.1:8090）。请确认编辑器没有卡死，或调大 luastg-mcp 配置里的 timeoutMs。
```

### 桥接状态码

| `status` | 含义 | 处理 |
|---|---|---|
| `no_document` | 编辑器没有打开工程 | 打开一个 `.lstges` 后重试 |
| `node_not_found` | 路径不存在（通常因为结构改了、路径漂移） | 重新 `luastg_get_nodes` |
| `unknown_attribute` | 节点没有这个属性 | 看错误里的 `availableAttributes` |
| `index_out_of_range` | `index` 超出父节点子节点数 | 看 `childCount` |
| `validation_failed` | 该类型不能插到这个父节点下 | 换父节点或类型 |
| `cannot_delete` | 根节点或 `[CannotDelete]` 类型 | 不能删 |
| `unknown_node_type` | 编辑器不认识 `node_type` | 看 `suggestions` |
| `bad_request` | 请求字段缺失/格式不对 | 检查参数 |
| `unknown_action` | 桥接版本太旧 | 更新 C# 桥接 |
| `error` | 桥接处理请求时抛了未捕获异常 | 看错误消息和编辑器日志 |

---

## 8. 开发与测试

```powershell
cd D:\DSHProgramme\dsh-luastg-mcp

# 0. 安装开发依赖（@deepseek-ai/dsh-tools + schemastery，用于工具契约测试）
pnpm install

# 1. 构建 lib/
node scripts/build.mjs

# 2. 结构检查（需要本地 DSH 包；test/setup.mjs 会自动找）
node --import ./test/setup.mjs scripts/check.mjs

# 3. 全部测试（TCP 客户端、路径归一化、工具报文、mock 桥接）
node --import ./test/setup.mjs test/all.mjs
```

或直接 `npm test`（等价于 build + 全部测试）。

`test/all.mjs` 在**单个进程**里按文件名顺序加载所有 `*.test.mjs`。这样 Node 22 与 24 行为一致
（`--test-isolation` 只在 Node 23+ 存在），也不依赖子进程——在没有 fork 权限的沙箱里同样能跑。

`test/setup.mjs` 按 `DSH_PACKAGES` → 仓库 `node_modules` → 全局 DSH 安装的顺序查找
`@deepseek-ai/dsh-tools`；只有全局安装那种布局才需要 `test/dsh-resolver.mjs` 的 resolve hook，
仓库内 `node_modules` 走 Node 原生解析。两者都找不到时，31 个工具契约测试会自动 skip（其余 26 个照常跑）。

CI 在 Ubuntu + Node 22 上执行 `pnpm install && npm test`，安装到 devDependencies 后 57 个测试全量运行。

测试**不需要真实编辑器**：`test/mock-bridge.mjs` 用 `node:net` 实现了一个同协议的内存树，
支持 `ping` / `get_tree` / `insert_node` / `set_attribute` / `delete_node`，并会模拟路径左移。

手工联调可以用 mock 桥接 + C# 仓库里的 PowerShell 脚本（**不会碰真实工程**）：

```powershell
# 终端 A：在 8090 启动 mock
node scripts/dev/serve-mock.mjs 8090

# 终端 B：跑完整 CRUD + 删除断言
powershell -NoProfile -ExecutionPolicy Bypass -File `
  'D:\LuaSTG-Editor-Sharp-X-main\LuaSTGMcpBridge\tests\mcp-crud-test.ps1' -NoPause
```

接真实编辑器时，先 `-Step ping`，再 `-Step tree`，最后跑完整流程；每一步都能在编辑器里
看到节点被选中、属性变化和 Undo/Redo 效果。

---

## 9. 安全边界与已知限制

### 安全边界

- 桥接只绑定 `127.0.0.1`，但**没有认证**：本机任何进程都能连上 8090 并修改当前文档。
  **不要把端口转发到局域网**。
- 没有文件级备份；回滚依赖编辑器的 Undo 栈。重要工程在批量修改前请先保存一个副本。
- `luastg_update_script` 单次最多 4 MiB；`luastg_get_nodes` 单次响应最多缓冲 32M 字符。
- 所有修改都是编辑器 Command，C# 侧是最终权威；TS 侧不做格式保留，也不校验文档内容。

### 已知限制

- C# 桥接暂未实现搜索和批量更新，因此 `luastg_search_nodes` / `luastg_batch_update`
  已移除；需要时先 `get_nodes` 再逐个更新。
- `update_node` 的多属性更新**不是事务**；失败时前面的属性已生效（错误会列出）。
- 路径是位置索引，结构变化后必须重新读取；不要跨修改缓存 `path`。
- `luastg_get_nodes` 不能只返回“活动舞台”子树；用 `path` 定位到舞台节点，或先用
  `maxDepth` 看结构。
- 桥接没有 `dry_run`、没有删除预览、没有属性级回滚。

---

## 10. v1.0.0 验收记录

2026-10-24，在 LuaSTG Editor Sharp X `0.78.4.0` + 桥接 `127.0.0.1:8090` 上做了真实 TCP 端到端验收
（工程为未保存的空工程 `TCP_Live_Test`）：

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | `luastg_get_nodes` | `status: ok`，`nodeCount: 3`（根 + `ProjSettings` + `EditorVersion`） |
| 2 | `luastg_add_node` 插入 `Comment`，文本 `Hello TCP!` | 落在 `0/2`，`nodeCount: 4`，节点被选中 |
| 3 | `luastg_update_node` 改为 `AI is watching you` | `changed: 1`，`oldValue` / `newValue` 正确 |
| 4 | `luastg_delete_node` 删除多余的 `0/3` | `nodeCount` 5 → 4，后面兄弟节点索引前移 |
| 5 | 在编辑器里 `Ctrl+Z` / `Ctrl+Y` | 节点连同属性文本完整还原，再重做后再次消失 |
| 6 | `luastg_add_node` 插入 `General.Code` + `luastg_update_script` | 写入 3 行 Lua，`script: {chars: 60, lines: 3, bytes: 60}`，`previous` 为 0 |

验收期间**没有任何 `.lstges` 文件被读取或写入**；`dirty` 标记始终由编辑器维护，
所有修改都可撤销，界面刷新实时可见。

---

## 11. 视频逆向解析 (Video-to-Danmaku)

从一段游戏录像反推出弹幕结构：抽帧 → 数弹 → 跟踪 → 阵型归类，最后给出可直接映射成
节点树的参数（弹数、颜色、速度 px/s、旋转方向）。**这一段与 MCP 桥接无关**，只依赖
Python、Pillow/numpy 和 ffmpeg。

### 11.1 依赖

| 依赖 | 说明 |
|---|---|
| Python `>= 3.10` | 脚本只用到标准库 + 下面两个包 |
| `Pillow`、`numpy` | `count-bullets.py` 首次运行会**自动 `pip install`**；设 `DSH_NO_AUTO_INSTALL=1` 可禁止 |
| `ffmpeg` | 抽帧用；需在 `PATH`，或用 `--ffmpeg=C:\path\ffmpeg.exe`，或设 `FFMPEG_PATH` |

> **不需要 OpenCV**：连通域标注是 `scripts/count-bullets.py` 里自带的并查集，模板匹配用
> 的是边缘签名，纯 numpy 实现，避免在离线环境里装 `opencv-python`。

### 11.2 四个脚本

| 脚本 | 作用 |
|---|---|
| `scripts/slice-sprites.py` | 按 THlib 的 Lua 元数据（`LoadImage` / `LoadImageGroup`）把图集切成单图，产出 `docs/sprite-index.json` |
| `scripts/count-bullets.py` | 单帧计数：阈值 + 连通域 + 颜色分类；`--auto` 自动裁战斗区自适应阈值；`--template` 按 `docs/sprites_sliced` 命名每一发 |
| `scripts/bullet_tracking.py` | 帧间互选最近邻跟踪，逐发给出 `vx, vy`（px/s）；阵型分类 `parallel / ring / aimed / fan_spread / spiral / chaos` |
| `scripts/analyze-video-bullets.py` | 串起全流程：ffmpeg 抽帧 → 逐帧计数 → 跟踪 → 写时间轴 JSON |

辅助：`scripts/extract-video-frames.mjs` 只做抽帧（场景变化或定帧率），适合先看素材。

### 11.3 用法

```bash
# 1) 切图集（模板匹配与精灵命名的前提）
python scripts/slice-sprites.py

# 2) 单张截图：计数 + 颜色分布
python scripts/count-bullets.py shots/danmaku.png --auto
python scripts/count-bullets.py shots/danmaku.png --auto --template --limit=20

# 3) 视频：每 0.5 秒抽一帧，输出时间轴
python scripts/analyze-video-bullets.py game.mp4 --interval 0.5 --out analysis_result.json

# 4) 视频 + 跟踪 + 阵型（密集弹幕建议 0.05~0.1 s）
python scripts/analyze-video-bullets.py game.mp4 --tracks --interval 0.1 --out analysis_result.json
```

`--tracks` 会在每帧追加：

```json
{
  "time": 0.5,
  "total_bullets": 220,
  "colors": {"blue": 171, "magenta": 38},
  "pattern": {"kind": "fan_spread", "confidence": 0.91, "center": [320.0, 100.0], "samples": 148},
  "tracks": {"tracks": 206, "speedMean": 244.0, "speedMax": 512.0, "lifetimeMean": 0.8},
  "bullets": [{"sprite_name": "ball_mid3", "x": 312.4, "y": 180.2, "vx": 41.2, "vy": 88.3, "track": 17}]
}
```

### 11.4 阵型判定

| `kind` | 判据 |
|---|---|
| `parallel` | 速度方向圆标准差 ≤ 10°（弹幕墙、直线流） |
| `ring` | 位置落在圆上（半径 std/mean ≤ 0.3）+ 速度径向对齐 ≥ 0.55 + 角度覆盖 ≥ 200° |
| `spiral` | 速度以切向为主（径向对齐 < 0.35、切向 ≥ 0.55） |
| `aimed` | 所有射线汇聚在**前方**一点（瞄准玩家） |
| `fan_spread` | 射线汇聚在**后方**一点（同一炮口、多角度） |
| `chaos` | 都不满足，或跟踪不稳（`lifetimeMean` 很低时通常就是它） |

密集画面先跑全局判定，退化成 `chaos` 时再切成最多 4 个空间簇分别判定，取最可信的一簇
（`source: "cluster"`）；簇结果必须置信度 ≥ 0.3、样本 ≥ 10，否则不采纳。

### 11.5 已知局限

- **跟踪依赖采样率**：0.5 s 间隔下高速弹会串号，密集场景请用 0.05–0.1 s。
- **检测层会被特效骗**：静止激光、爆炸、UI 文字都会被当成弹；用 `--crop` 锁死战斗区、
  `--no-white` 去掉白色豁免。
- **速度只能定性**：单帧无法区分“新生成/飞出/被消弹”，`spawn_rate` 是净变化率。
- 像素计数对重叠弹会少算，`estimatedBullets` 只是按中位面积拆分的启发值。

---

## 12. 版本与兼容

### 相对 v0.5.0 的变化

- 删除 `luastg_search_nodes`、`luastg_batch_update`（C# 侧暂未实现）。
- 删除所有文件读写：`projectFile`、`projectDir`、`scope`、`maxNodes`、`template_id`、
  `dry_run` 参数不再存在；不再有备份、sha256、临时文件、原子写盘、id 漂移映射。
- 节点地址从 `node_id`（`0.2.1`）迁移到 `path`（`0/2/1`）；旧参数在 1.x 继续可用。
- `luastg_get_nodes` 返回编辑器当前活动文档，不再按“活动舞台”过滤；用 `path` + `maxDepth`
  控制返回量。
- 返回值改为桥接的原始结构（`document` / `tree` / `path` / `type` / `text` / `attributes`），
  并加 `ok`、`source`、`transport`、`endpoint`、`action`、`elapsedMs` 信封字段。
- 所有修改立刻进入编辑器的 Undo 栈；编辑器保存前文档是 dirty 的，这是预期行为。

### 兼容矩阵

| 组件 | 版本要求 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0` |
| Node | `>= 22.13`（CI 用 22） |
| LuaSTG Editor Sharp X | 桥接编译自 `LuaSTGEditorSharp.sln`（实测 0.78.4.0） |
| 桥接协议 | v1（`docs/bridge-protocol.md`） |

## License

MIT，见 [LICENSE](LICENSE)。
