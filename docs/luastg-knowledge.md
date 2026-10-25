# LuaSTG 终极开发与架构指南

> 面向 **LuaSTG AEX+ / LuaSTG Sub 引擎 + LuaSTG Editor Sharp X 编辑器** 的实战速查手册。
> 目标读者：写关卡脚本的人、写批量生成工具的人、以及需要让 AI 准确产出节点树的人。

---

## LuaSTG 开发者工程规范（工程化最高约束）

> 本节的效力高于全文所有示例：示例、模板与本节冲突时，**一律以本节为准**。
> 依据：`LuaSTGNode.Legacy/EditorData/Node/Enemy/{EnemyDefine,EnemyInit,CreateEnemy}.cs` 源码
> ＋真实工程存档 `Hakureisama.lstges`。

### 0.1 四条硬规则

1. **选型分两类：实体走 Define + Create，普通弹幕走内置 Simple Bullet 节点。**
   - **敌机 / Boss / 带独立复杂逻辑的对象**（有血量、掉落、受击、死亡，要按
     `Difficulty` 分级，要被多个关卡、多个实例复用）→ 必须先在类型定义节点里定义
     （`EnemyDefine` / `BossDefine` / `ObjectDefine`），
     再用 `CreateEnemy` / `CreateBoss` / `CreateObject` 实例化。
     `CreateSimpleEnemy` 做不到这些，**交付工程里禁止出现**。
   - **普通弹幕（直线、自机狙、扇形、360° 环形）** → **必须优先使用内置的
     `CreateSimpleBullet` / `CreateSimpleBulletGroup`**：弹数、张角、速度全在同一张
     属性面板上。**禁止**为了"规范"先建 `BulletDefine`、再套 `Repeat` + `CreateBullet`
     手工铺一圈——那是**过度设计**，节点树会凭空臃肿三层。
   `BulletDefine` 只留给"每一发都要独立行为"的复杂弹（跟踪、分裂、定时变向、
   按帧改速度曲线）。完整判定见 [节点选用决策树](#节点选用决策树decision-matrix)。
2. **生成关卡前，先检查资源目录是否合理。**
   打开工程先看 `File`（`RootFolder`）下有没有 `Resources` 分类目录；没有就先补目录，
   再写关卡。随手把 Define 丢在根节点下、或把定义混在 Stage 里的工程，一律视为未整理。
3. **定义先于引用。**
   生成的 Lua 按节点树顺序输出，`_editor_class["MyTank"]` 必须出现在使用它的 Stage
   代码之前。所以资源目录永远排在 `StageGroup` 前面；新增 Define 后不要把它拖到关卡后面。
4. **铁律：Stage 不允许是空壳。**
   凡是要生成 `Stage` 节点，其子节点**必须**包含 `Initialize` 文件夹（`General.Folder`，
   `Name = "Initialize"`）和一个背景设置节点（`StageBG`，`Background = temple_background`
   等）。**绝对不允许生成没有任何子节点的空 `Stage`**，否则关卡缺少初始化段，运行到该关
   时会直接报错。路径固定为：

   ```
   Stage                       [RequireParent(StageGroup)]
   └─ Folder "Initialize"
      └─ StageBG               Background=temple_background   ← New(_editor_class[...] or ...)
   ```

   > 依据：编辑器 UI 的 “Add Stage”（`PluginToolbox.AddStageNode`）就是这么建默认子节点的；
   > 但桥接 API 直接调 `InsertNodeCore`，**不会**套用这层默认值，所以只能由生成侧自己补。
   > 本仓库的 `luastg_add_node` / `luastg_apply_subtree` 已内置兜底：新建 `Stage` 后自动
   > 检测并补 `Initialize` + `StageBG`，结果放在响应的 `stageDefaults` 里。手写节点树时同样
   > 必须显式带上这两个节点。

### 0.2 标准资源目录

```
File（RootFolder）
├─ ProjSettings
├─ EditorVersion
├─ Resources                      ← 所有类型定义集中在这里
│  ├─ Tanks                       ← 按题材/用途分类，不要一股脑塞平
│  ├─ Helis
│  ├─ Bullets                     ← 只有"逐发独立行为"的复杂弹才建这里的 Define
│  └─ Bosses
└─ StageGroup "Stage 1"           ← 关卡脚本永远排在资源之后
   └─ Stage "Stage 1"
      ├─ Folder "Initialize"      ← 铁律 4：必须有，且带 StageBG
      │  └─ StageBG
      └─ TaskNode
         └─ CreateEnemy
```

### 0.3 标准作业顺序（新增一种敌机）

1. `Resources/<分类>` 建 `Folder`（分类名用复数名词：`Tanks`、`Bosses`）。
2. 其下建 `EnemyDefine`：`Name` 填类型名（如 `MyTank`），`Difficulty` 默认 `All`。
3. `EnemyDefine` 下自动带一个**唯一且不可删**的 `EnemyInit`：在这里配
   `Style` / `Hit point` / 掉落 / 保护帧；需要行为就再挂 `TaskNode`
   （`EnemyInit` 是代码上下文，可容纳协程）。
4. `Stage → TaskNode` 里用 `CreateEnemy` 实例化：`Name` 写**带引号的类型名**
   （`"\"MyTank\""`），`Position` 写 `"x, y"` 单个字符串。
5. 用 `luastg_get_nodes` 复核：Define 在 Stage 之前、`Name` 带引号、
   `Difficulty` 非 `All` 时类型名带后缀。

### 0.4 上线自检清单

- [ ] `Resources` 目录存在、分类合理，Define 没有散落在根节点；
- [ ] 每个 `CreateEnemy` / `CreateBoss` 都能在 `Resources` 下找到同名 Define；
- [ ] `CreateEnemy.Name` / `CreateBoss.Name` 带 Lua 引号；`Difficulty` 非 `All` 时类型名带
      `:Hard` 之类后缀；
- [ ] 敌机行为写在 `EnemyInit` 的 `TaskNode` 里，而不是每个实例各抄一遍；
- [ ] 普通弹幕用的是 `CreateSimpleBullet` / `CreateSimpleBulletGroup`，
      没有为一发子弹去建 `BulletDefine`（见 [节点选用决策树](#节点选用决策树decision-matrix)）；
- [ ] 工程里没有 `CreateSimpleEnemy`，也没有用一个大 `Code` 代替整棵树；
- [ ] 每个 `Stage` 都有 `Folder "Initialize"` 且其中带 `StageBG`；没有空 `Stage`
      （见 [0.1 铁律 4](#01-四条硬规则)）。

---

## 最高指导原则：原生节点优先（NATIVE FIRST）

> **除非原生节点绝对无法表达该逻辑，否则禁止使用 `General.Code` 节点。**

> **铁律（与上一条同级，冲突时优先）：凡是要生成 `Stage` 节点，其子节点必须包含
> `Initialize` 文件夹及背景设置节点（`StageBG`），绝对不允许生成空 `Stage`，否则会导致
> 引擎报错。**
> 判定只看两点，缺一即补：① `Stage` 下有没有 `Name = "Initialize"` 的 `Folder`；
> ② 该文件夹里有没有 `StageBG`。桥接插入不会套用编辑器 UI 的默认子节点，生成侧必须自己保证
> （`luastg_add_node` / `luastg_apply_subtree` 已自动兜底，见 [0.1 铁律 4](#01-四条硬规则)）。

判定顺序（自上而下，命中即停）：

| 优先级 | 场景 | 做法 |
|---|---|---|
| 1 | 等待、造敌、造弹、设速度、位移、循环、条件、播音、载资源 | **全部用原生节点** |
| 2 | 需要少量自定义数值 / 分支，但能落到节点属性上 | 原生节点 + 属性里写表达式/宏 |
| 3 | 原生节点集合里确实没有对应动作（任意表操作、引擎独有 API、复杂数学） | 才允许 `Code`，且**只写那一小段** |

**为什么**：人类在编辑器里靠属性面板 + 拖拽微调；一坨 Code 等于把编辑器退化成文本编辑器。原生节点还能逐节点撤销、复制粘贴、被 `RequireParent` / `Uniqueness` 静态校验，并且节点树是结构化数据——可批量生成、可校验、可重构，Code 是黑盒。

**反例（禁止）**：一个 `Code` 里塞完造敌 + 等待 + 移动 + 弹幕；
或者用 `CreateSimpleEnemy` 把敌机属性写死在关卡流程里。

**正例（标准 Define + Create）**：

```
Resources/Tanks
└─ EnemyDefine "fairy"                     → _editor_class["fairy"] = Class(enemy)
   └─ EnemyInit  Style=1, Hit point=500    → init(self, _x, _y, …)
      └─ TaskNode                          → 行为写在定义里，所有实例共享
         ├─ TaskWait      Time=60
         └─ SetVelocity   Target=self, Velocity=1, Angle=90

Stage 1
└─ Stage
   ├─ Folder "Initialize"                  ← 铁律 4：Stage 必带
   │  └─ StageBG  Background=temple_background
   └─ TaskNode
      └─ CreateEnemy  Name="\"fairy\"", Position="320,240"
                                           → New(_editor_class["fairy"], 320, 240, _)
```

同一份定义可以被任意多个 `CreateEnemy` 复用：改一次血量或行为，全场生效。
这是 `CreateSimpleEnemy` 做不到的，也是"先建资源、再造关卡"的原因。

> ⚠️ 但 **Define + Create 只适用于"实体"**。普通弹幕（直线、自机狙、扇形、环形）
> 不是实体，套 Define 就是过度设计——见下一节。

---

## 节点选用决策树（Decision Matrix）

> 这一节解决"这件事到底该用哪种节点"。**过度设计**（把一发子弹拆成
> `BulletDefine` + `Repeat` + `CreateBullet`）和**滥用 `Code`** 一样是错误，
> 只是它更隐蔽：树能跑，但属性面板失去了可调性，别人也读不懂。

### 三步判定（自上而下，命中即停）

| # | 先问自己 | 命中 → 用什么 |
|---|---|---|
| 1 | 它有**独立血量 / 掉落 / 受击 / 死亡**吗？要在多个实例、多个关卡间复用吗？要按 `Difficulty` 分级吗？ | **Define + Create**：`EnemyDefine` / `BossDefine` / `ObjectDefine` ＋ `CreateEnemy` / `CreateBoss` / `CreateObject` |
| 2 | 它只是**一发或一组弹幕表现**（直线、自机狙、扇形、360° 环形），弹数/张角/速度都是随手要调的数值吗？ | **内置 Simple Bullet 节点**：`CreateSimpleBullet` / `CreateSimpleBulletGroup` |
| 3 | 每一发子弹都需要**自己的独立行为**（跟踪、分裂、定时变向、按帧改速度曲线）吗？ | 才轮到 `BulletDefine` ＋ `CreateBullet` |

一句话记法：**Define 是给"有生命周期的实体"的，不是给"一发子弹"的。**

### 判定表

| 需求 | 唯一推荐节点 | 属性面板上的旋钮 | 禁止的写法 |
|---|---|---|---|
| 敌机（有血、有行为、可复用） | `EnemyDefine` → `EnemyInit` → `CreateEnemy` | `Style` / `Hit point` / 掉落 / 行为 `TaskNode` | `CreateSimpleEnemy` 散落在关卡流程里 |
| Boss | `BossDefine` → `BossInit` + `BossSpellCard`（血量在卡上）→ `CreateBoss` | `Position` / 每张卡的 `Hit point` | 用 `CreateSimpleEnemy` 冒充 Boss |
| 单发直线弹、自机狙 | `CreateSimpleBullet` | `Style` `Color` `Position` `Velocity` `Angle` `Aim to player` `Acceleration` `Rebound` | `BulletDefine` + `CreateBullet` |
| 扇形散弹 | `CreateSimpleBulletGroup`（`Number` = 弹数，`Angle spread` = 总张角） | `Number` `Angle` `Angle spread` `Velocity begin/end` `Interval` | 一个 `Code` 里 `for` 循环刷弹 |
| 360° 环形弹 | `CreateSimpleBulletGroup`（`Number=36`、`Angle spread=360`） | 同上 | `BulletDefine` + `Repeat(36)` + 36 次 `CreateBullet` |

### 为什么普通弹幕不该上 Define

- **一个节点 vs 一棵子树**：一圈 36 发的 360° 环弹，人类写法只要一个叶子节点——
  `CreateSimpleBulletGroup`，`Number=36`、`Angle=0`、`Angle spread=360`、
  `Velocity begin/end=4`。Define 写法要
  `BulletDefine` → `BulletInit` → `SetVelocity`（还得把 `v`/`a` 变成 `Parameter List`）
  ＋ `Repeat(Times=36, a=0, increment=10)` ＋ `CreateBullet(Parameters=a)`，
  **5 个节点干 1 个节点的活**。
- **调参位置**：Simple Bullet 的全部旋钮在同一张面板上；Define 写法把弹数拆到
  `Repeat.Times`、张角拆到 `Var 1 increment`、速度拆到 `BulletInit.SetVelocity`，
  改一次弹幕要在三个节点之间来回跳。
- **没有复用价值**：`BulletDefine` 存在的意义是"同一套逐发行为被多处复用"。
  一发普通子弹的行为永远是"直线飞出去"，不存在值得抽出来的行为差异，
  Define 只剩一层间接。
- **可读性反而下降**：别人看到 `Repeat(36)` 会以为在铺什么复杂弹幕，
  实际只是想要一个圆环。

### 反例（过度设计，禁止）

```
BossSCStart
└─ TaskNode
   └─ Repeat(Times=36, a=0, increment=10)          ← 只为画一个圆环
      └─ CreateBullet  Name="RingBullet"  Parameters=a

Resources/Bullets
└─ BulletDefine "RingBullet"  Parameter List=a     ← 多余的定义
   └─ BulletInit  Style=ball_mid  Color=COLOR_PURPLE
      └─ SetVelocity  Target=self  Velocity=4  Angle=a
```

### 正例（人类写法）

```
BossSCStart
└─ TaskNode
   └─ Repeat(Times=_infinite)
      ├─ CreateBulletGroup  Number=36  Angle=0  Angle spread=360  Velocity begin/end=4
      └─ TaskWait  Time=90                          ← 每 1.5 秒放一圈
```

改扇形：只把 `Angle spread` 从 `360` 改成 `120`；改弹数：只改 `Number`；
改自机狙：`Aim to player=true`、`Angle` 留 `0`。**全在一个面板上。**
（`Aim to player` 是相对角度：扇形/环弹会整体绕自机方向旋转，`Angle` 仍是中心角。）

---

## 0. 本文档的来源与可信度

本文不是凭空编写的，所有条目分三类来源，**已交叉校验**：

| 来源 | 路径 | 提供什么 | 校验方式 |
|---|---|---|---|
| 引擎 API 字典（主源） | `docs/luastgaex+_doc/**`（45 个文本文件 → 保留 32 个，合并 164.9 KB） | 169 个 `lstg.*` 全局函数、75 个 `---@class` 定义 | `scripts/extract-docs.mjs` + `scripts/api-index.mjs` 自动解析 LuaLS 标注 |
| 编辑器节点源码 | `LuaSTGNode.Legacy/EditorData/Node/**`、`LuaSTGEditorSharp.Core/**` | 节点层级约束（`RequireParent` / `RequireAncestor` / `Uniqueness`）、真实属性名（`attrCap`）、代码生成模板 | 直接读取 C# 类的 `DoubleCheckAttr` 与 `ToLua()` |
| 运行时库 | `game/packages/thlib-scripts/**` | `task.*`、`boss.*`、`lstg.player`、碰撞组/图层常量 | 读取 `Ltask.lua` / `Lobject.lua` / `player.lua` 的定义处 |

**重要澄清（避免写错 API）**：

- 本引擎**没有** `GetPlayer()`、`NewBullet()`、`SetPlayer()` —— 那是旧版 LuaSTG Plus / THlib 变体的写法，在本引擎的源码中已确认不存在。
- 自机句柄是 **`lstg.player`**（由 `player_class:init` 写入）；THlib 另外把全局 **`player`** 也指向它。
- 造对象只有一个入口 **`New(类, ...)`**：THlib OO 写法是 `New(straight, …)` / `New(EnemySimple, …)`；只有用编辑器节点时才出现 `New(_editor_class["类名"], x, y, ...)`。
- 引擎 API 前缀是 `lstg.`（THlib 已通过 `lib/Lapi.lua` 别名到全局）；任务系统是全局 `task.`。
- **发射子弹 / 造带血敌机的首选写法见 [`thlib-knowledge.md`](thlib-knowledge.md)**：本文第 4 节模板已全部改为 THlib OO，不再使用 `_straight`。

**重新生成临时语料**：

```bash
node scripts/extract-docs.mjs     # 产出 docs/_raw_api_temp.md
node scripts/api-index.mjs        # 产出 docs/_api_index.md（452 个函数 / 75 个类索引）
```

---

## 1. 核心层级嵌套规则

编辑器节点树不是随意的，每个节点都声明了自己"必须挂在谁下面"、"自己能不能当容器"。理解这一点，是让 AI 生成合法 `.lstges` 的前提。

### 1.1 四种节点角色

| 角色 | 判定标志（源码） | 代表节点 | 作用 |
|---|---|---|---|
| **类定义容器** | `[ClassNode]` | `StageGroup`、`EnemyDefine`、`BulletDefine`、`BossDefine`、`ObjectDefine`、`PlayerDefine` | 注册一个具名类型，子节点定义它的回调 |
| **代码上下文** | 类型被列入 `CodeAlikeTypes` | `Stage`、`EnemyInit`、`BulletInit`、`BossInit`、`BossSCBeforeStart`、`OnRender`、`TaskDefine`、`Function` | 打开一个 `function(self, ...)` 函数体 |
| **任务上下文** | 类型被列入 `TaskAlikeTypes` | `TaskNode`、`TaskForObject`、`TaskDefine`、`Tasker`、`BossSC*` | 打开一个协程体，允许 `TaskWait` / `TaskMoveTo` |
| **叶子节点** | `[LeafNode]` | `TaskWait`、`TaskMoveTo`、`CreateEnemy`、`CreateBullet`、`Code`、`Del`、`Kill` | 只能被生成一行/一段代码，不能再挂子节点 |

一个节点**可以同时是多种角色**：`TaskNode` 既是"任务上下文"，又要求自己是"代码上下文"的后代；`Stage` 既是代码上下文，又是任务上下文（它本身就被包进 `task.New`）。

### 1.2 硬约束（源码级）

| 约束属性 | 语义 | 出现在哪些节点 |
|---|---|---|
| `[RequireParent(T)]` | **直接父节点**必须是 T | `Stage` ← `StageGroup`；`EnemyInit`/`BulletInit`/`BossInit` ← 各自的 Define |
| `[RequireAncestor(T)]` | **任意祖先**中必须有 T | `TaskNode`、`CreateEnemy`、`CreateBullet` ← `CodeAlikeTypes`；`TaskWait`、`TaskMoveTo` ← `TaskAlikeTypes` |
| `[Uniqueness]` | 同级只能有一个 | `EnemyInit`、`BulletInit`、`BossInit` |
| `[CannotDelete, CannotBan]` | 不可删除、不可禁用 | `EnemyInit` |
| `[LeafNode]` | 不可有子节点 | `Code`、`TaskWait`、`TaskMoveTo`、`CreateEnemy`、`CreateBullet` |

`CodeAlikeTypes` 的完整成员（源码 `CodeAlikeTypes.cs`）：
`Stage`、`EnemyInit`、`BulletInit`、`ObjectInit`、`BossInit`、`LaserInit`、`BentLaserInit`、`PlayerDefine`、`PlayerInit`、`BossBGLayerInit/Frame/Render`、`BossSCStart`、`BossSCFinish`、`BossSCBeforeStart`、`BossSCBeforeFinish`、`BossSCAfter`、`CallBackFunc`、`BGOnFrame`、`BGOnRender`、`OnRender`、`Dialog`、`Function`、`TaskDefine`、`DefineItem`、`PlayerBulletInit/Frame/Render/Colli/Kill/Del`。

### 1.3 标准层级图

```
RootFolder                                  ← 文档根，depth = 0
├─ ProjSettings                             工程设置（Output Name / Author / Mod version）
├─ EditorVersion                            编辑器版本（0.78.3.0）
├─ Folder "Classes"                         建议：所有"类定义"集中放这里
│  ├─ BulletDefine "aimed"                  [ClassNode]  → _editor_class["aimed"] = Class(bullet)
│  │  ├─ BulletInit                         [RequireParent, Uniqueness, CannotDelete]
│  │  │  └─ Code / CreateBullet / ...
│  │  └─ CreateBullet（不推荐，定义体里一般不刷弹）
│  ├─ EnemyDefine "fairy"                   [ClassNode]  → _editor_class["fairy"] = Class(enemy)
│  │  ├─ EnemyInit                          [RequireParent, Uniqueness, CannotDelete]
│  │  │  └─ TaskNode / Code / CreateBullet
│  │  └─ CallBackFunc(frame)                可选：帧回调
│  └─ BossDefine "Boss"
│     ├─ BossInit
│     └─ BossSpellCard
│        ├─ BossSCBeforeStart               ← CodeAlike + TaskAlike
│        ├─ BossSCStart
│        └─ BossSCFinish
└─ StageGroup "SpellCard"                   [ClassNode] → stage.group.New(...)
   └─ Stage "SpellCard"                     [RequireParent(StageGroup)] → stage.group.AddStage(...)
      ├─ Folder "Initialize"                ← **必须有**（铁律 4），且必须先于关卡流程
      │  └─ StageBG                          Background=temple_background → 设置背景
      ├─ TaskNode                           [RequireAncestor(CodeAlike)] ← Stage 满足
      │  ├─ Code
      │  ├─ TaskWait
      │  ├─ TaskMoveTo
      │  └─ Enemy.CreateEnemy
      └─ Code                               ← 直接写原始 Lua
```

**一句话记法**：

> `StageGroup` 管"这一关的初始资源（残机/火力/信仰/炸弹）"；`Stage` 管"这一关的脚本"（且必带 `Initialize` → `StageBG` 初始化块）；`EnemyDefine`/`BulletDefine`/`BossDefine` 是"类型表"；`*Init` 是"类型的构造体（唯一）"；`TaskNode` 是"一个协程"，`TaskWait`/`TaskMoveTo` 只能活在协程里；`Code` 是"逃生舱"，哪都能挂，直接写 Lua。

> 层级图里的 `BulletDefine` 只说明"这个角色可以挂在这里"，**不是**要求普通弹幕也这么写：
> 直线、扇形、环弹、自机狙用 `CreateSimpleBullet` / `CreateSimpleBulletGroup` 就够，
> 只有"每一发都要独立行为"的复杂弹才值得建定义。见 [节点选用决策树](#节点选用决策树decision-matrix)。

### 1.4 代码生成链（节点 → 真实 Lua）

每一步都是 `ToLua()` 的真实输出，最后一段就是引擎里跑的东西：

```lua
-- StageGroup
stage.group.New('menu', {}, "SpellCard",
    {lifeleft = 7, power = 400, faith = 50000, bomb = 3}, true, 1)
-- Stage（Stage.cs 的实际输出，节选）
stage.group.AddStage('SpellCard', 'Stage 1', ...)
stage.group.DefStageFunc('Stage 1@SpellCard', 'init', function(self)
    -- 子节点按顺序原样输出到这里，**不会**被自动包进 task.New
    lasttask = task.New(self, function() ... end)   -- 只有树里放了 TaskNode 才有这层
end)
-- EnemyDefine / EnemyInit
_editor_class["fairy"] = Class(enemy)
_editor_class["fairy"].init = function(self, _x, _y, hp)
    ...
end
-- CreateEnemy / CreateBullet
last = New(_editor_class["fairy"], 120, 420, 100)
last = New(_editor_class["aimed"], self.x, self.y, 4, 90)
-- TaskNode / TaskWait / TaskMoveTo
lasttask = task.New(self, function()
    task._Wait(60)
    task.MoveTo(0, 120, 60, MOVE_NORMAL)
end)
-- Code
-- 原样输出，不做任何包装
```

---

## 2. 节点类型与属性（Schema）

属性名 = `.lstges` 里的 `attrCap`，**必须逐字一致**（大小写、空格都算）。`EditWindow` 决定编辑器用什么控件，批量生成时可忽略但建议保留。

### 2.1 十个最常用节点（必填属性加 ★）

| # | 节点 `$type` | 层级约束 | 属性（attrCap） | 生成代码 |
|---|---|---|---|---|
| 1 | `.Stage.StageGroup` | 顶层 / Folder 下 | `Name`★ `Start life`★ `Start power` `Start faith` `Start bomb` `Allow practice` `Difficulty value` | `stage.group.New('menu', {}, Name, {lifeleft,power,faith,bomb}, practice, diff)` |
| 2 | `.Stage.Stage` | **父必须是 StageGroup** | `Name`★ `Start life (practice)` `Start power (practice)` `Start faith (practice)` `Start bomb (practice)` `Allow practice` | `stage.group.AddStage(...)` + `DefStageFunc(..., 'init', function(self) … end)` |
| 3 | `.Stage.StageBG` | Stage 下 | `Background`★ | 绑定背景资源 |
| 4 | `.Enemy.EnemyDefine` | 任意（约定 `Resources/<分类>`） | `Name`★ `Difficulty`（默认 `All`） | `_editor_class["Name"] = Class(enemy)` |
| 5 | `.Enemy.EnemyInit` | **父必须是 EnemyDefine**；同级唯一；不可删 | `Parameter List` `Style`★ `Hit point` `Drop power` `Drop faith` `Drop point` `Protect (frames)` `Clear bullets` `Offscreen removal` `Contact damage` | `_editor_class["Name"].init = function(self, _x, _y, …) end` |
| 6 | `.Enemy.CreateEnemy` | **祖先需 CodeAlike**；叶子 | `Name`★（`enemyDef`，**值要自带 Lua 引号**） `Position`★（`"x, y"`） `Parameters` | `last = New(_editor_class["Name"], x, y, …)` |
| 7 | `.Bullet.BulletDefine` | 任意（类定义区） | `Name`★ `Difficulty` | `_editor_class["Name"] = Class(bullet)` |
| 8 | `.Bullet.BulletInit` | **父必须是 BulletDefine**；同级唯一 | `Parameter List` `Style`★（`bulletStyle`） `Color` `Stay on create` `Destroyable` | `_editor_class["Name"].init = function(self, _x, _y, …) end` |
| 9 | `.Task.TaskNode` | **祖先需 CodeAlike**；自身可作 Task 上下文 | 无属性 | `lasttask = task.New(self, function() … end)` |
| 10 | `.General.Code` | 任意；叶子 | `Code`★（多行 Lua 原文） | 原样输出（自动缩进） |

### 2.2 补充常用节点

| 节点 | 层级约束 | 属性 | 生成代码 |
|---|---|---|---|
| `.Bullet.CreateBullet` | 祖先需 CodeAlike；叶子 | `Name`★ `Position`★ `Parameters` | `last = New(_editor_class["Name"], x, y, …)` |
| `.Task.TaskWait` | **祖先需 TaskAlike**；叶子 | `Time`★（帧数，可为 0） | `task._Wait(n)` |
| `.Task.TaskMoveTo` | 祖先需 TaskAlike；叶子 | `Destination`★(x,y) `Frame`★ `Mode`★ | `task.MoveTo(x, y, frame, MOVE_NORMAL)` |
| `.Boss.BossDefine` | 类定义区 | `Name`★ `Difficulty` `Displayed name` `Background` `Background Music` | 注册 Boss 类型 |
| `.Boss.BossInit` | 父必须是 BossDefine；唯一 | `Position`★ `Spell Card Background` | `function(self)` 入口 |
| `.Boss.BossSpellCard` | BossDefine 下 | `Name`★ `Protect time (sec)` `DMG redu. time (sec)` `Total time (sec)` `Hit point` `Drop power/faith/point` `Immune to bomb` `Performing action` `Optional ID` | 一张符卡定义 |
| `.Boss.CreateBoss` | 祖先需 CodeAlike | `Name`★ `Wait`★(bool) | 生成 Boss 实体 |
| `.Audio.PlayBGM` | 任意 | `Name`★ `Time` `Set stage time` | 播放 BGM |
| `.General.Folder` | 任意 | `Name`★ | 纯组织用途，不产生代码 |

### 2.3 属性易错点

1. **`Position` 是单个字符串**，写作 `"x, y"`（如 `"240,384"`），不是两个属性。
2. **`Time` 可为 0**：`TaskWait` 走的是 `task._Wait`（允许 0 帧），而手写 `task.Wait` 最少 1 帧，两者语义不同。
3. **`Difficulty` 默认 `All`**；填 `Easy/Normal/Hard/Lunatic` 时，生成的类名会带后缀，如 `_editor_class["fairy:Hard"]`。
4. **`Parameter List`** 是形参列表字符串（如 `hp, v, a`），它会成为 `init` 的签名，`CreateEnemy`/`CreateBullet` 的 `Parameters` 必须按同序传实参。
5. **`EnemyInit` 不可删除**：误删只能重建定义。
6. **`CreateEnemy.Name` 必须自带 Lua 引号**：节点是原样拼接 `_editor_class[<Name>]`，写 `MyTank` 会读全局变量 nil；正确写法是 `"\"MyTank\""`。

---

### 2.4 原生节点速查（人类最常用，替代 Code）

按"要做什么"查，一律优先用它，别写 Code。

| 想做的事 | 节点 `$type` | 必填属性（attrCap） | 层级约束 |
|---|---|---|---|
| 等 N 帧 | `.Task.TaskWait` | `Time`★（帧，可为 0） | 祖先需 TaskAlike |
| 开协程 | `.Task.TaskNode` | 无 | 祖先需 CodeAlike |
| 匀速/插值位移 | `.Task.TaskMoveTo` | `Destination`★ `Frame`★ `Mode`★ | 祖先需 TaskAlike |
| 相对位移 | `.Task.TaskMoveBy` | `Distance`★ `Frame`★ `Mode`★ | 祖先需 TaskAlike |
| 设速度 | `.Object.SetVelocity` | `Target`(默认 self)★ `Velocity`★ `Angle`★ `Aim to Player` `Set Rotation` | 祖先需 CodeAlike，叶子 |
| 删除对象 | `.Object.Del` | `Target`★ | 祖先需 CodeAlike，叶子 |
| 击杀对象 | `.Object.Kill` | `Target`★ | 祖先需 CodeAlike，叶子 |
| 一行造带血敌机（**仅调试**，交付禁用） | `.Enemy.CreateSimpleEnemy` | `Style`★ `Hit point`★ `Position`★ `Drop power` `Drop faith` `Drop point` `Protect (n frames)` `Clear bullets` `Offscreen removal` `Contact damage` | 祖先需 CodeAlike；**自身是 Task 上下文**（子节点即敌机行为） |
| 定义敌机类型 | `.Enemy.EnemyDefine` | `Name`★ `Difficulty` | 任意（约定放 `Resources/<分类>`） |
| 敌机 init 回调 | `.Enemy.EnemyInit` | `Parameter List` `Style`★ `Hit point` `Drop power` `Drop faith` `Drop point` `Protect (frames)` `Clear bullets` `Offscreen removal` `Contact damage` | 父必须是 EnemyDefine、唯一、不可删 |
| 造已定义敌机 | `.Enemy.CreateEnemy` | `Name`★（**必须是带引号的 Lua 字符串**） `Position`★ `Parameters` | 祖先需 CodeAlike，叶子 |
| 一行造单发弹（直线/自机狙） | `.Bullet.CreateSimpleBullet` | `Style`★ `Color`★ `Position`★ `Velocity`★ `Angle` `Aim to player` `Acceleration` `Rebound` | 祖先需 CodeAlike，叶子 |
| 一行造 N 发（扇形/环形） | `.Bullet.CreateBulletGroup` | `Style`★ `Color`★ `Position`★ `Number`★ `Angle` `Angle spread` `Velocity begin/end` `Interval` `Aim to player` | 祖先需 CodeAlike，叶子 |
| 定义子弹类型（**仅复杂弹**） | `.Bullet.BulletDefine` | `Name`★ `Difficulty` | 任意 |
| 子弹 init 回调 | `.Bullet.BulletInit` | `Parameter List` `Style`★ `Color` `Stay on create` `Destroyable` | 父必须是 BulletDefine、唯一 |
| 清弹 | `.Bullet.BulletClear` | 见属性面板 | 祖先需 CodeAlike |
| 循环 | `AdvancedRepeat` | `Times`★（按面板实际属性名） | 视具体节点 |
| 条件分支 | `IfElse` / `IfElseIf` | 条件表达式★ | 视具体节点 |
| 造 Boss | `.Boss.CreateBoss` | `Name`★ `Wait`★ | 祖先需 CodeAlike |
| 播放 BGM | `.Audio.PlayBGM` | `Name`★ `Time` `Set stage time` | 任意 |
| 分组/整理 | `.General.Folder` | `Name`★ | 任意（不产生代码） |

> 属性名必须逐字一致（空格、大小写）。`Position` 是**单个字符串** `"x, y"`，不是两个属性。
> 上表已覆盖"造敌 / 造弹 / 等待 / 位移 / 速度 / 循环 / 分支 / 音频"——**这些场景都不需要 Code**。

> **2026-10-25 对 v0.78.3 纯净版实测校正**：
> - `CreateSimpleEnemy` 的造型属性在编辑器里叫 **`Style`**；写成 `Enemy style` 会被桥接拒绝（`unknown_attribute`）。
> - `SetVelocity` 除 `Target / Velocity / Angle / Aim to Player` 外还有 **`Set Rotation`**（默认 `true`，会把朝向也设成飞行角度）。
> - `CreateSimpleBullet` 的 15 个属性实测为：`Style / Color / Position / Velocity / Angle / Aim to player /
>   Rotation velocity / Stay on create / Destroyable / Time / Rebound / Acceleration / Accel Angle /
>   Max Velocity / Shuttle`。
> - `CreateBulletGroup`（编辑器显示名 "Create Simple Bullet Group"）的 15 个属性实测为：
>   `Style / Color / Position / Number / Interval / Velocity begin / Velocity end / Angle /
>   Angle spread / Aim to player / Rotation velocity / Stay on create / Destroyable / Time / Rebound`；
>   生成 `_create_bullet_group(style, color, x, y, n, interval, v1, v2, angle, spread, aim, omiga, stay, destroyable, time, rebound, enemy)`，
>   其中扇形以 `angle` 为**中心**（内部先偏转 `-spread/2`），`aim=true` 时整体绕自机方向旋转。
> - 遇到 `unknown_attribute` 时不要猜：桥接错误的 `details.availableAttributes` 就是该节点在当前编辑器版本里的真实属性表，以它为准。

### 2.5 Define + Create 完整 Schema（源码级）

> 依据 `LuaSTGNode.Legacy/EditorData/Node/Enemy/{EnemyDefine,EnemyInit,CreateEnemy}.cs`（v0.78.3 / 0.78.4 通用）。
> 三个节点是一套：`EnemyDefine` 注册类型 → `EnemyInit` 定义构造与属性 → `CreateEnemy` 实例化。

#### 2.5.1 `EnemyDefine`（类定义容器）

| 属性 | EditWindow | 默认 | 说明 |
|---|---|---|---|
| `Name`★ | — | `""` | 类型名；留空会被编辑器报 `ArgNotNull` |
| `Difficulty` | `objDifficulty` | `All` | 非 `All` 时注册名带后缀 `Name:Hard` |

约束：`[ClassNode]`，任意父节点（约定放 `Resources/<分类>`）；子节点是
**唯一且不可删的 `EnemyInit`**，外加任意行为节点（`TaskNode`、`CreateBullet`、`Code`…）。

```lua
_editor_class["MyTank"] = Class(enemy)        -- Difficulty = All
_editor_class["MyTank:Hard"] = Class(enemy)   -- Difficulty = Hard
```

#### 2.5.2 `EnemyInit`（构造体，同级唯一）

约束：`[CannotDelete, CannotBan] [RequireParent(EnemyDefine), Uniqueness]`。

| 属性 | EditWindow | 构造默认 | 去向 |
|---|---|---|---|
| `Parameter List` | — | `""` | `init(self, _x, _y, …)` 的形参，空则占位 `_` |
| `Style`★ | `enemyStyle` | `"1"` | `enemy.init(self, style, …)` |
| `Hit point` | — | `"10"` | 同上 |
| `Drop power` | — | `"0"` | `self.drop[1]` |
| `Drop faith` | — | `"0"` | `self.drop[2]` |
| `Drop point` | — | `"0"` | `self.drop[3]` |
| `Protect (frames)` | — | `"1"` | 保护帧协程 `task.Wait(n)` |
| `Clear bullets` | `bool` | `false` | `enemy.init` 参数 |
| `Offscreen removal` | `bool` | `true` | 同上 |
| `Contact damage` | `bool` | `false` | 同上 |

```lua
_editor_class["MyTank"].init = function(self, _x, _y, _)
    enemy.init(self, 5, 500, 0, false, true, false)   -- style, hp, protect, clrbullet, offscr, contact
    self.x, self.y = _x, _y
    self.drop = {0, 0, 0}
    task.New(self, function() self.protect = true task.Wait(0) self.protect = false end)
end
```

子节点会追加在 `end` 之前——**敌机行为写在这里**（`EnemyInit` 属于 `CodeAlikeTypes`，
可以套 `TaskNode`），所有 `CreateEnemy` 出的实例共享同一份。

> ⚠️ 造型属性名是 `Style`，不是 `Enemy style`；保护帧是 `Protect (frames)`，
> 与 `CreateSimpleEnemy` 的 `Protect (n frames)` 拼写不同。

#### 2.5.3 `CreateEnemy`（实例化，叶子）

约束：`[RequireAncestor(CodeAlikeTypes)] [LeafNode]`（`Stage` / `TaskNode` / `EnemyInit` 都满足）。

| 属性 | EditWindow | 默认 | 说明 |
|---|---|---|---|
| `Name`★ | `enemyDef` | `""` | **必须写带引号的 Lua 字符串**，如 `"\"MyTank\""`；`Difficulty` 非 `All` 时写 `"\"MyTank:Hard\""` |
| `Position`★ | `position` | `self.x, self.y` | 单个字符串 `"x, y"`；可写表达式，真实工程里有 `ran:Float(-100,100),250` |
| `Parameters` | `enemyParam` | `""` | 与 `Parameter List` 同序的实参；空则填 `_` |

```lua
last = New(_editor_class["MyTank"], 320, 240, _)
```

`Name` 是**原样拼接**进 `_editor_class[` … `]` 的，少写引号会变成
`_editor_class[MyTank]`（读全局变量，nil），关卡一运行就报错。
`New` 的返回值存进全局 `last`，后续 `SetVelocity` / `Del` / `Kill` 等节点可以把
`last` 当作 `Target`。

#### 2.5.4 定义与实例的对应关系

| 定义处 | 实例处 | 必须一致 |
|---|---|---|
| `EnemyDefine.Name` + `Difficulty` | `CreateEnemy.Name` | 类型名；`Difficulty` 非 `All` 时带 `:Hard` 后缀 |
| `EnemyInit.Parameter List`（如 `hp, v, a`） | `CreateEnemy.Parameters` | 顺序、个数 |
| `EnemyInit.Style / Hit point / …` | —— | 只在定义处配一次，实例处无需重复 |

---

## 3. Lua 核心 API 字典

以下 30 条全部来自 `docs/luastgaex+_doc` 的 `---@param` / `---@return` 标注（已去重、去实验性分支），可直接信任参数类型。

### 3.1 对象生命周期

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `lstg.New(class, ...)` | `class: lstg.Class` + 变参 | `lstg.GameObject` | 申请对象并执行 `init`；变参原样传给 `init` |
| `lstg.Del(unit, ...)` | `unit` + 变参 | — | 触发 `del` 回调并标记回收 |
| `lstg.Kill(unit, ...)` | `unit` + 变参 | — | 触发 `kill` 回调（死亡动画），区别于 Del |
| `lstg.IsValid(unit)` | 任意值 | `boolean` | 判断引用是否仍有效；**每帧遍历前必须用它判空** |
| `lstg.ObjList(groupid)` | `groupid: number` | 迭代器 | 按碰撞组遍历；传非法组则遍历全部 |
| `lstg.GetnObj()` | — | `number` | 当前对象池占用量（性能排查用） |

### 3.2 运动、几何、碰撞

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `lstg.SetV(unit, v, a, updaterot)` | 对象 / 速度 / 角度(度) / 是否同步朝向 | — | 同时写 `vx, vy`；`a` 为**角度制** |
| `lstg.GetV(unit)` | 对象 | `number` | 读速度标量（`_speed` 的高误差封装，慎用极低速） |
| `lstg.Angle(...)` | `(obj,obj)` / `(obj,x,y)` / `(x,y,obj)` / `(x1,y1,x2,y2)` | `number` | 求朝向角（度），自机狙的核心 |
| `lstg.Dist(...)` | 同上四种组合 | `number` | 求距离模 |
| `lstg.SetBound(l, r, b, t)` | 四边界 | — | 场景边界，默认 `-100,100,-100,100` |
| `lstg.BoxCheck(unit, l, r, b, t)` | 对象 + 矩形 | `boolean` | 点/对象是否在矩形内（裁剪用） |
| `lstg.ColliCheck(a, b, ignoreworldmask)` | 两对象 | `boolean` | 单次精确碰撞判定 |
| `lstg.CollisionCheck(groupA, groupB)` | 两碰撞组号 | — | 批量碰撞，**禁止在协程中调用** |

### 3.3 渲染

| 函数 | 参数 | 说明 |
|---|---|---|
| `lstg.Render(img, x, y, rot, hs, vs, z)` | 图名 + 位置 + 旋转 + 缩放 + 深度 | 最常用绘制；受 `SetImageScale` 影响 |
| `lstg.RenderRect(img, l, r, b, t)` | 图名 + 矩形 | 平铺/拉伸绘制 |
| `lstg.RenderAnimation(ani, t, x, y, rot, hs, vs, z)` | 序列名 + 帧计时 | 序列帧动画 |
| `lstg.RenderText(fnt, text, x, y, scale, align)` | 位图字体 | `align` 决定对齐方式 |
| `lstg.RenderTTF(ttf, text, l, r, b, t, align, color, scale)` | 矢量字体 + 矩形 + 颜色 | 注意：`scale` 会自动 ×0.5 |
| `lstg.RenderClear(color)` | `lstg.Color` | 清屏 |
| `lstg.SetImageState(imgname, blendmode, color)` | 图名 + 混合模式 + 颜色 | 也支持 4 顶点色重载 |
| `lstg.SetViewport(l, r, b, t)` | 四边界 | 视口；原点左下、y 轴向上 |

### 3.4 资源加载与音频

| 函数 | 参数 | 说明 |
|---|---|---|
| `lstg.LoadTexture(name, path, mipmap)` | `mipmap` 默认 `false` | 纹理 |
| `lstg.LoadImage(name, tex, x, y, w, h, a, b, rect)` | 像素坐标切图 | `a,b,rect` 会写回对象 |
| `lstg.LoadAnimation(name, tex, x, y, w, h, col, row, aniv, a, b, rect)` | 行列切图 + 帧间隔 | 序列帧 |
| `lstg.LoadSound(name, path)` | wav/ogg，双声道 44.1kHz/16bit | 音效 |
| `lstg.LoadMusic(name, path, loopend, looplength)` | 支持循环节 | BGM（**必须用 LoadMusic，不是 LoadSound**） |
| `lstg.PlaySound(name, volume, pan)` | `pan` 为声像 | 播放音效 |
| `lstg.PlayMusic(name, volume, position)` | `position` 单位秒 | 播放 BGM |
| `lstg.GetKeyState(vkey)` | 虚拟键码 | 键盘状态 |

### 3.5 其余高频一行速查

`lstg.Log(level, msg)`（1~5 = debug/info/warning/error/fatal）、`lstg.GetFPS()`、`lstg.SetFPS(n)`（默认 60）、`lstg.AddSuperPause(t)`、`lstg.SetBGMVolume(v)`、`lstg.StopMusic(name)`、`lstg.StopSound(name)`、`lstg.SetImageCenter(img, x, y)`、`lstg.LoadTTF(name, path, w, h)`、`lstg.LoadTextFile(path, archivepath)`、`lstg.LoadPS(name, path, img)`、`lstg.ParticleFire(unit)`、`lstg.ParticleStop(unit)`、`lstg.GetMousePosition()`、`lstg.SetOrtho(l, r, b, t)`。

### 3.6 任务系统（THlib 运行时，非引擎文档）

| 函数 | 签名 | 说明 |
|---|---|---|
| `task.New(target, f)` | `target` + 协程函数 | 建协程，返回 thread；编辑器里由 `TaskNode` 生成 |
| `task.Wait(t)` | 最少 1 帧 | 普通等待（**不能传 0**） |
| `task._Wait(t)` | 允许 0 帧 | 编辑器 `TaskWait` 节点的专用版本 |
| `task.MoveTo(x, y, t, mode)` | `mode` 取 `MOVE_NORMAL`(0) / `MOVE_ACCEL`(1) / `MOVE_DECEL`(2) / `MOVE_ACC_DEC`(3) | 直线插值移动 |
| `task.MoveToPlayer(t, ...)` | 追踪自机 | 带区间约束的追踪 |
| `task.GetSelf()` | — | 取当前协程宿主对象（等价 `self`） |
| `task.Clear(target, keepself)` | — | 清空目标上的协程 |

### 3.7 关键常量（THlib `Lobject.lua` / `Ltask.lua`）

```lua
-- 碰撞组
GROUP_GHOST=0  GROUP_ENEMY_BULLET=1  GROUP_ENEMY=2  GROUP_PLAYER_BULLET=3
GROUP_PLAYER=4 GROUP_INDES=5         GROUP_ITEM=6   GROUP_NONTJT=7
GROUP_SPELL=8  GROUP_CPLAYER=9       GROUP_ALL=16   GROUP_NUM_OF_GROUP=16

-- 渲染图层
LAYER_BG=-700  LAYER_ENEMY=-600  LAYER_PLAYER_BULLET=-500  LAYER_PLAYER=-400
LAYER_ITEM=-300 LAYER_ENEMY_BULLET=-200  LAYER_ENEMY_BULLET_EF=-100  LAYER_TOP=0
```

### 3.8 `lstg.GameObject` 常用字段

| 分类 | 字段 |
|---|---|
| 基本 | `status`（`"normal"/"del"/"kill"`）、`class`、`world`（世界掩码，默认 `0xF`） |
| 位置 | `x` `y` `dx` `dy`(只读增量) |
| 运动 | `vx` `vy` `ax` `ay` `maxvx` `maxvy` `maxv` `ag`（重力，朝 y 负方向） `_angle` `_speed` |
| 碰撞 | `group`（0~15） `bound` `colli` `hw` `hh` |
| 渲染 | `img` `ani` `rect` `a` `b` `layer` `hscale` `vscale` `rot` `omiga` `hide` `navi` `_blend` `_color` `_a` `_r` `_g` `_b` |
| 杂项 | `timer` `nopause` |

> ⚠️ 用 `lstg.ObjList` 遍历时**不要直接改 `group`**，必须先缓存、遍历结束后再改（源码注释的明确警告）。

---

## 4. 三个标准代码模板（THlib 面向对象写法）

> **本节写法约定**：一律使用 THlib 现成类 `straight` / `EnemySimple`，**不写 `_straight` 的 16 参数调用**。
> 参数含义、`_straight` → `straight` 的逐项迁移对照见 [`thlib-knowledge.md`](thlib-knowledge.md)。

### 4.0 为什么不再用 `_straight`

| 对比项 | `New(_straight, …)` | `New(straight, …)` |
|---|---|---|
| 参数个数 | 16 | 8 |
| `stay` 位置 | 第 9 位 | 第 3 位 |
| 瞄准自机 | `aim = true` 布尔开关 | 显式 `Angle(self, player)`，可加预判 |
| 实例 | `New(_straight, arrow_big, COLOR_RED, x, y, 4, ang, false, 0, false, true, 0, false, nil, nil, nil, false)` | `New(straight, arrow_big, COLOR_RED, false, x, y, 4, ang)` |

`_straight` 只是编辑器的老工程兼容层（`THlib/editor.lua`），新代码不要主动用。

> 本节节点树里若没有 `BulletDefine` / `EnemyDefine`，是**故意的**：用 THlib OO 写法就不需要这些类定义节点，直接 `StageGroup → Stage → TaskNode → Code` 即可。

> ⚠️ 能落到原生节点就别写 `Code`：直线弹、扇形散弹、360° 环弹、自机狙分别对应
> `CreateSimpleBullet` / `CreateSimpleBulletGroup`（`Number` + `Angle spread` +
> `Aim to player`），见 [节点选用决策树](#节点选用决策树decision-matrix)。
> 本节的手写 Lua 模板只在需要**逐发数学变化**（例如第 i 发速度 = f(i)、
> 逐发角度按曲线变化）时才使用。

### 4.1 模板一：自机狙（Aimed Shot）

**节点树**

```
StageGroup "Stage 1"
└─ Stage
   └─ TaskNode
      ├─ Code        瞄准发射
      └─ TaskWait    Time = 60
```

**`Code` 节点内容**

```lua
if IsValid(player) then
    New(straight, arrow_big, COLOR_RED, false,
        self.x, self.y, 4, Angle(self, player))
end
```

**要点**

- `player` 是 THlib 全局自机引用（等价 `lstg.player`），开局可能为 `nil`，**必须 `IsValid`**。
- `v = 4` 表示 60FPS 下 240 像素/秒。
- 要预判：`Angle(self, player.x + player.dx * lead, player.y + player.dy * lead)`。
- 第 4 个参数是 `stay`：正常飞行填 `false`，填 `true` 子弹会停在原地。
- 要"不可破坏弹"（炸弹清不掉）把 `straight` 换成 `straight_indes`。

### 4.2 模板二：扇形散弹（Fan Spread）

**节点树**

```
StageGroup "Stage 1"
└─ Stage
   └─ TaskNode
      ├─ Code        扇形循环
      ├─ TaskWait    Time = 45
      └─ TaskNode    下一轮（形成常驻弹幕）
```

**`Code` 节点内容**

```lua
local base = IsValid(player) and Angle(self, player) or -90
local N, SPREAD, SPEED = 9, 60, 3.2
local half = SPREAD / 2

for i = 0, N - 1 do
    local t = (N > 1) and (i / (N - 1)) or 0.5
    New(straight, ball_mid, COLOR_PURPLE, false,
        self.x, self.y, SPEED, base - half + SPREAD * t)
end
PlaySound('se_tan02', 0.8, 0)
```

**要点**

- `TaskWait` 放在 `Code` **之后**，这就是"每 45 帧一轮"的节拍来源。
- `SPREAD` 是**总张角**；`N` 取奇数时必有一发正对 `base`。
- 换弹型只改第 2 个参数：`ball_mid` → `knife` / `ellipse` / `ball_big`…（30 种见 THlib 文档）。

### 4.3 模板三：Boss 入场循环弹幕

**节点树**

```
BossDefine "Boss"
└─ BossSpellCard "「测试符卡」"
   └─ BossSCStart
      └─ TaskNode
         ├─ TaskMoveTo   Destination="240,200"  Frame=90  Mode=MOVE_NORMAL
         ├─ TaskWait     Time = 30
         └─ TaskNode     循环体
            ├─ Code      双螺旋
            └─ TaskWait  Time = 8
```

**等价 Lua（节点树展开后的样子）**

```lua
-- BossSCStart 本身是代码上下文；内层 TaskNode 会自动包出 task.New
lasttask = task.New(self, function()
    -- 1) 入场：阻塞式，绝不能写进 while true
    task.MoveTo(240, 200, 90, MOVE_NORMAL)
    task._Wait(30)

    -- 2) 双螺旋循环
    local spin = 0
    while true do
        local aim = IsValid(player) and Angle(self, player) or -90
        for k = 0, 1 do
            for i = 0, 11 do
                New(straight, ball_mid, COLOR_CYAN, false,
                    self.x, self.y, 3.0, aim + spin + k * 15 + i * 30)
            end
        end
        spin = spin + 7
        task._Wait(8)
    end
end)
```

**要点**

- `task.MoveTo` 是**阻塞**的协程调用，写进 `while true` 里面会让 Boss 永远在入场。
- 循环体必须有 `task._Wait`，漏写会在一帧内把对象池打空、帧率归零。
- 符卡结束可以 `task.Clear(self)`；无敌演出设 `self.protect = true`。
- 想要"演出弹不可被打掉"，用 `straight_indes`。

### 4.4 附加模板：一行生成带血量的敌机（**旧写法，仅调试**）

> ⚠️ 与 [`§0`](#luastg-开发者工程规范工程化最高约束) 冲突：本模板只适合临时验证一两行效果。
> 交付工程请走 **`EnemyDefine` + `EnemyInit` + `CreateEnemy`**（见 §2.5）：
> 属性写死在实例上的 `EnemySimple` 无法复用、无法按 `Difficulty` 分级、也无法被其他关卡引用。

自机狙的发射逻辑挂在敌机身上时，`EnemySimple` 可以一步到位（临时调试用，不需要 `EnemyDefine` + `EnemyInit` 两个节点）：

```lua
New(EnemySimple, 1, 100, 120, 420, {4, 0, 0}, 30, false, false, false, function(self)
    task.New(self, function()
        while true do
            task.Wait(60)                      -- 60 帧 = 1 秒
            if IsValid(player) then
                New(straight, arrow_big, COLOR_RED, false,
                    self.x, self.y, 4, Angle(self, player))
            end
        end
    end)
end)
```

参数依次是：`style(1~34)`、`hp`、`x`、`y`、`drop{power, faith 个数, point 个数}`、`保护帧`、`死亡清弹`、`出界删除`、`非体术`、`行为函数`。
血量判定、掉落、受击闪白全部由 `enemybase` 自动处理，详见 [`thlib-knowledge.md`](thlib-knowledge.md) 第 4 节。

---

## 5. 完整关卡 JSON 树示例

### 5.1 `.lstges` 的真实格式（关键！）

编辑器存档**不是**嵌套 JSON 数组，而是**逐行 "深度,JSON" 的扁平序列**（每行一个节点，缩进由行首数字表达）：

```
<depth>,{"$type":".<命名空间>.<类名>, <程序集>","Attributes":[{"attrCap":"…","attrInput":"…","EditWindow":"…"}],"AttributeCount":n}
```

四条硬性规则：

1. `depth` 从 `0`（`RootFolder`）开始，每条记录比父节点大 1；**层级完全靠这个数字推断**。
2. `$type` 的 `<程序集>` 后缀不统一：`General.*` 用 `LuaSTGEditorSharp`，剧情/敌人/子弹等旧库节点留空（写成 `, `）。
3. `AttributeCount` 必须等于 `Attributes` 数组长度，否则编辑器会当作损坏存档。
4. `attrCap` 必须与第 2 节表格逐字一致。

### 5.2 树形视图（本示例的结构）

```
RootFolder
├─ ProjSettings
├─ EditorVersion
└─ StageGroup "Stage 1"
   └─ Stage "Stage 1"
      ├─ StageBG
      └─ TaskNode
         ├─ Code          加载资源
         ├─ TaskWait 60
         ├─ Code          一行生成带血敌机（EnemySimple）
         └─ TaskNode      60 帧自机狙循环
            ├─ Code
            └─ TaskWait 60
```

### 5.3 完整 `.lstges` 内容

> 注意与前一版示例的差别：**没有 `BulletDefine` / `EnemyDefine`**——发射与造敌都走 THlib 的 `straight` / `EnemySimple`，所以整棵树只剩 `Stage` + `TaskNode` + `Code`。

```text
0,{"$type":".RootFolder, LuaSTGEditorSharp","Attributes":[{"attrCap":"Name","attrInput":"File","EditWindow":""}],"AttributeCount":1}
1,{"$type":".ProjSettings, LuaSTGEditorSharp","Attributes":[{"attrCap":"Output Name","attrInput":"","EditWindow":""},{"attrCap":"Author","attrInput":"LuaSTG User","EditWindow":""},{"attrCap":"Allow practice","attrInput":"true","EditWindow":"bool"},{"attrCap":"Allow sc practice","attrInput":"true","EditWindow":"bool"},{"attrCap":"Mod version","attrInput":"4096","EditWindow":""}],"AttributeCount":5}
1,{"$type":".EditorVersion, LuaSTGEditorSharp","Attributes":[{"attrCap":"Editor version","attrInput":"0.78.3.0","EditWindow":""}],"AttributeCount":1}
1,{"$type":".Stage.StageGroup, ","Attributes":[{"attrCap":"Name","attrInput":"Stage 1","EditWindow":"stageGroup"},{"attrCap":"Start life","attrInput":"7","EditWindow":""},{"attrCap":"Start power","attrInput":"400","EditWindow":""},{"attrCap":"Start faith","attrInput":"50000","EditWindow":""},{"attrCap":"Start bomb","attrInput":"3","EditWindow":""},{"attrCap":"Allow practice","attrInput":"true","EditWindow":"bool"},{"attrCap":"Difficulty value","attrInput":"1","EditWindow":"difficulty"}],"AttributeCount":7}
2,{"$type":".Stage.Stage, ","Attributes":[{"attrCap":"Name","attrInput":"Stage 1","EditWindow":""},{"attrCap":"Start life (practice)","attrInput":"7","EditWindow":""},{"attrCap":"Start power (practice)","attrInput":"400","EditWindow":""},{"attrCap":"Start faith (practice)","attrInput":"50000","EditWindow":""},{"attrCap":"Start bomb (practice)","attrInput":"3","EditWindow":""},{"attrCap":"Allow practice","attrInput":"true","EditWindow":"bool"}],"AttributeCount":6}
3,{"$type":".Stage.StageBG, ","Attributes":[{"attrCap":"Background","attrInput":"temple_background","EditWindow":"BG"}],"AttributeCount":1}
3,{"$type":".Task.TaskNode, ","Attributes":[]}
4,{"$type":".General.Code, LuaSTGEditorSharp","Attributes":[{"attrCap":"Code","attrInput":"LoadTexture(\"tex_arrow\", \"img/arrow.png\")\nLoadImageGroup(\"arrow_big\", \"tex_arrow\", 0, 0, 16, 16, 8, 1, 8, 8)","EditWindow":"code"}],"AttributeCount":1}
4,{"$type":".Task.TaskWait, ","Attributes":[{"attrCap":"Time","attrInput":"60","EditWindow":"yield"}],"AttributeCount":1}
4,{"$type":".General.Code, LuaSTGEditorSharp","Attributes":[{"attrCap":"Code","attrInput":"New(EnemySimple, 1, 100, 120, 420, {4, 0, 0}, 30, false, false, false, function(self)\n    task.New(self, function()\n        while true do\n            task.Wait(60)\n            if IsValid(player) then\n                New(straight, arrow_big, COLOR_RED, false,\n                    self.x, self.y, 4, Angle(self, player))\n            end\n        end\n    end)\nend)","EditWindow":"code"}],"AttributeCount":1}
4,{"$type":".Task.TaskNode, ","Attributes":[]}
5,{"$type":".General.Code, LuaSTGEditorSharp","Attributes":[{"attrCap":"Code","attrInput":"local base = IsValid(player) and Angle(self, player) or -90\nfor i = 0, 8 do\n    New(straight, ball_mid, COLOR_PURPLE, false,\n        self.x, self.y, 3.2, base - 30 + i * 7.5)\nend","EditWindow":"code"}],"AttributeCount":1}
5,{"$type":".Task.TaskWait, ","Attributes":[{"attrCap":"Time","attrInput":"60","EditWindow":"yield"}],"AttributeCount":1}
```

### 5.4 用这份格式做批量生成

1. **先解析成树**：读每一行 → 栈里维护 depth → depth 变小就弹栈，得到 `[节点, 子节点...]`。
2. **改树再序列化**：深度优先遍历，写出 `depth,json`，`AttributeCount = len(Attributes)`。
3. **注意转义**：`attrInput` 里的 Lua 代码含双引号、`\n`，JSON 序列化会自动转义；`Position` 这类字段里是 `"x, y"` 普通字符串。
4. **校验三步**：① `$type` 的命名空间是否存在；② `RequireParent` / `RequireAncestor` 是否满足（第 1.2 节表格）；③ `Uniqueness` 节点是否重复。
5. **替代路径**：编辑器开着 MCP 桥接时，可以直接用 `luastg_add_node` 按父节点路径挂载，让编辑器自己维护 depth 与 `AttributeCount`，避免手写序列化出错。

---

## 附录 A：快速排错表

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| 编辑器里 `TaskWait` 拖不进去 | 当前父节点不是 TaskAlike（如直接在 `EnemyInit` 下） | 外面套一层 `Task.TaskNode` |
| 生成的 Lua 里 `_editor_class["x"]` 为 nil | ①`EnemyDefine` 排在 `CreateEnemy` 之后；②`Difficulty` 后缀不匹配（定义是 `MyTank:Hard`，实例写 `MyTank`）；③`CreateEnemy.Name` 没写引号，生成成了 `_editor_class[MyTank]` | 把 Define 挪到关卡之前；统一 `Difficulty`；`Name` 写 `"\"MyTank\""` |
| 子弹不动 | `BulletInit` 里没设速度 | `lstg.SetV(self, v, a)` 或写 `self.vx/vy` |
| 自机狙打偏/报错 | `lstg.player` 为 nil 时直接取 `.x` | 用 `lstg.IsValid(p)` 守卫 |
| 帧率骤降到个位数 | `while true` 循环里缺 `task._Wait` | 每轮至少 `task._Wait(1)` |
| 存档打开为空 | `AttributeCount` 与 `Attributes` 数量不符 | 重新序列化并校验 |

## 附录 B：本文档覆盖范围与再生成

- 语料：`docs/luastgaex+_doc` 共 48 个文件（45 个可解析文本、1 个无扩展名 `LICENSE`、2 张 PNG），**保留 32 个** API 文件，剔除 `更新日志.txt`（50 KB 变更日志）、`history.md`、`README.md`、`LICENSE`、`specification/`（画布/坐标系说明）与 3 个 <300 字节的空壳文件。
- 索引：452 个函数（含 169 个 `lstg.*`）、75 个类。
- 节点 Schema 与 JSON 格式：来自编辑器源码与真实 `.lstges` 存档，非本文档语料，已在第 0 节标注。
- 补充校验：`EnemyInit` 中挂 `TaskNode` 之所以能运行，是因为编辑器运行时基类 `_object:frame()` 内部调用了 `task.Do(self)`（THlib `editor.lua`）。
