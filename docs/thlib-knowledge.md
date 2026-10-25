# THlib 高层 API 速查（面向对象写法优先）

> 配套文档：`docs/luastg-knowledge.md`（引擎 `lstg.*` 层 + 编辑器节点 Schema）。
> **本文只讲 THlib 库层**——也就是你真正写弹幕时该用的那套高层封装。
> 源码：`docs/thlib-scripts`（103 个文件）；已排除 `assets/`、`shader/`、`launcher.lua`、`foundation/`、`plus/Replay.lua` 等与玩法无关的部分。

---

## 0. 一句话结论

> **能用 `New(straight, …)` 就别用 `New(_straight, …)`；能用 `New(EnemySimple, …)` 就别手写 `enemy` 的五步初始化。**

`_straight` 是**编辑器为了兼容老工程生成的 16 参数巨无霸**（`THlib/editor.lua:388`），而 THlib 自己提供的是 8 参数的 `straight`（`THlib/bullet/bullet.lua:630`）。两者的参数顺序还不一样，混用必炸。

---

## 1. 加载与全局导出

`THlib/THlib.lua` 是入口，按序 `Include` 各子系统。`lib/Lapi.lua` 把引擎 API 全部别名到全局：

```lua
New = lstg.New          -- 造对象（唯一的构造入口）
SetV = lstg.SetV        -- 设速度
Angle = lstg.Angle      -- 求朝向
IsValid = lstg.IsValid
BoxCheck / Dist / Color / Render / PlaySound / ObjList / Del / Kill / Damage ...
```

所以写弹幕时**直接写 `New`、`SetV`、`Angle`、`player`**，不用加 `lstg.` 前缀（加了也对，两者等价）。

`player` 是全局自机引用（`THlib/player/player.lua:44-45`：`lstg.player = self; player = self`）。

---

## 2. 类与继承骨架

THlib 全部用「类表 + `New`」的 OO 模型，`Class(parent)` 建子类，方法即 `init/frame/render/colli/del/kill/take_damage`。

```
object
├─ enemybase            血量、受击、出界、task.Do
│  ├─ enemy             行走图 + 掉落 + 死亡特效
│  │  ├─ EnemySimple    一步到位（位置/保护帧/掉落/行为函数）
│  │  └─ boss           符卡系统 + 血条 UI
│  └─ ...
└─ bullet               弹幕基类
   ├─ straight          直线弹（可破坏）★最常用
   ├─ straight_indes    直线弹（不可破坏）
   ├─ straight_495      直线弹（碰壁反弹）
   └─ img_class         贴图基类
      └─ arrow_big / ball_mid / knife / …（30 种样式）
```

自定义一个类：

```lua
local my_bullet = Class(bullet)
function my_bullet:init(x, y, v, a)
    bullet.init(self, arrow_big, COLOR_RED, false, true)  -- 挂贴图（destroyable = true）
    self.x, self.y = x, y
    SetV(self, v, a, true)
end
```

---

## 3. 发射子弹

### 3.1 一行式：`New(straight, …)`

```lua
New(straight, imgclass, colorIndex, stay, x, y, v, angle[, omiga])
```

| # | 参数 | 说明 |
|---|---|---|
| 1 | `imgclass` | 弹型类，如 `arrow_big`、`ball_mid`、`knife`（见 3.3） |
| 2 | `colorIndex` | 颜色索引 1~16（见 3.3），也可直接填 `COLOR_RED` 等常量 |
| 3 | `stay` | `false` = 正常飞行；`true` = 原地不动（做固定弹幕/激光预警用） |
| 4-5 | `x, y` | 出生坐标 |
| 6 | `v` | 速度（像素/帧） |
| 7 | `angle` | 角度（度，0 = 向右，90 = 向上） |
| 8 | `omiga` | 可选，自转角速度（度/帧） |

```lua
-- 朝自机打一发
New(straight, arrow_big, COLOR_RED, false, self.x, self.y, 4, Angle(self, player))
```

### 3.2 三个直线变体

| 类 | 碰撞组 | 特性 | 用途 |
|---|---|---|---|
| `straight` | `GROUP_ENEMY_BULLET` | 可被自机子弹/炸弹消除 | 99% 的敌弹 |
| `straight_indes` | `GROUP_INDES` | **不可破坏**，炸弹清不掉 | 演出弹、强制走位弹 |
| `straight_495` | `GROUP_ENEMY_BULLET` | 撞上下左右边界**反弹**，反弹后不再反弹 | 屏幕边缘折返弹 |

三者签名完全相同：`(imgclass, index, stay, x, y, v, angle, omiga)`。

### 3.3 弹型与颜色常量

**30 种弹型**（`BULLETSTYLE`，`bullet.lua` 末尾）：

```lua
arrow_big  arrow_mid  arrow_small  gun_bullet  butterfly  square
ball_small ball_mid   ball_mid_c   ball_big    ball_huge  ball_light
star_small star_big   grain_a      grain_b     grain_c    kite
knife      knife_b    water_drop   mildew      ellipse    heart
money      music      silence      water_drop_dark  ball_huge_dark  ball_light_dark
```

**16 个颜色索引**（1~16）：

```lua
COLOR_DEEP_RED=1  COLOR_RED=2  COLOR_DEEP_PURPLE=3  COLOR_PURPLE=4
COLOR_DEEP_BLUE=5 COLOR_BLUE=6 COLOR_ROYAL_BLUE=7   COLOR_CYAN=8
COLOR_DEEP_GREEN=9 COLOR_GREEN=10 COLOR_CHARTREUSE=11 COLOR_YELLOW=12
COLOR_GOLDEN_YELLOW=13 COLOR_ORANGE=14 COLOR_DEEP_GRAY=15 COLOR_GRAY=16
```

> 索引是「颜色序号」，贴图按 `int((index+1)/2)` 成对取图，所以 1/2 用同一张图的不同配色。

### 3.4 ⚠️ `_straight` → `straight` 迁移对照

这是最容易踩的坑：**参数顺序被重排了**，直接把 `_straight` 的实参挪过来会错位。

| 语义 | `_straight` 位置 | `straight` 位置 |
|---|---|---|
| 弹型 `imgclass` | 1 | 1 |
| 颜色 `index` | 2 | 2 |
| 停留 `stay` | **9** | **3** |
| `x` | 3 | 4 |
| `y` | 4 | 5 |
| 速度 `v` | 5 | 6 |
| 角度 `angle` | 6 | 7 |
| 自转 `omiga` | 8 | 8（可选） |
| `aim`（自动瞄自机） | 7 | — 用 `Angle(self, player)` 自己算 |
| `destroyable` | 10 | — 换 `straight_indes` |
| `time`（延迟启动） | 11 | — 用 `task.New` + `task.Wait` |
| `accel / accangle / maxv` | 13-15 | — 直接写 `self.ax/ay` 或 `SetA` |
| `through`（穿屏） | 16 | — 自定义 `frame` |

对照示例：

```lua
-- ❌ 旧：16 个参数，顺序诡异，多一个 0 就弹道全乱
New(_straight, arrow_big, COLOR_RED, x, y, 4, ang, false, 0, false, true, 0, false, nil, nil, nil, false)

-- ✅ 新：8 个参数，语义清晰
New(straight, arrow_big, COLOR_RED, false, x, y, 4, ang)
```

### 3.5 自定义弹幕行为

继承 `bullet` 后重写 `frame` 即可，`bullet:frame` 本身只做 `task.Do(self)`：

```lua
local homing = Class(bullet)
function homing:init(x, y, v)
    bullet.init(self, ball_mid, COLOR_BLUE, false, true)
    self.x, self.y = x, y
    self.v = v
    SetV(self, v, 90, true)
end
function homing:frame()
    if self.timer > 20 and IsValid(player) then
        local want = Angle(self, player)
        local now = Angle(0, 0, self.vx, self.vy)
        -- 每帧最多转 3 度
        local d = ((want - now + 180) % 360) - 180
        d = max(-3, min(3, d))
        SetV(self, self.v, now + d, true)
    end
    bullet.frame(self)   -- 别忘了基类（驱动 task）
end
```

### 3.6 清弹

| 类 | 行为 |
|---|---|
| `New(bullet_killer, x, y, kill_indes)` | 半径随时间扩大（`timer*20`），**Kill** 范围内的敌弹；40 帧后自毁 |
| `New(bullet_deleter, x, y, kill_indes)` | 同上，但用 **Del**（无消弹得分/特效） |
| `New(bullet_killer_SP, x, y, kill_indes)` | 带可见特效的消弹 |

`kill_indes = true` 时连 `GROUP_INDES`（不可破坏弹）一起清——**放 bom 时要传 true**。

---

## 4. 创建带血量判定的敌机

### 4.1 一步到位：`New(EnemySimple, …)`

```lua
New(EnemySimple, style, hp, x, y, drop, protectFrames, clearBullet, autoDelete, nonTaijutsu, behavior)
```

| # | 参数 | 说明 |
|---|---|---|
| 1 | `style` | 行走图编号 **1~34**（见 4.4），不是字符串 |
| 2 | `hp` | 血量；`maxhp` 同步 |
| 3-4 | `x, y` | 出生坐标 |
| 5 | `drop` | 掉落表 `{power, faith, point}`，直接传给 `item.DropItem`；**`[2]`/`[3]` 是道具个数（会被循环生成），别填大数**；传 `nil` 则不掉落 |
| 6 | `protectFrames` | 出生保护帧数（期间 `protect = true`，不掉血） |
| 7 | `clearBullet` | 死亡时是否清屏（`true` → 掉血弹幕消失） |
| 8 | `autoDelete` | 出界后是否自动 `bound = true` 删除 |
| 9 | `nonTaijutsu` | `true` → 碰撞组改为 `GROUP_NONTJT`（非体术，不被撞死） |
| 10 | `behavior` | 行为函数 `function(self) … end`，内部可开 `task` |

```lua
New(EnemySimple, 1, 100, 120, 420, {4, 0, 0}, 30, false, false, false, function(self)
    task.New(self, function()
        while true do
            task.Wait(60)
            if IsValid(player) then
                New(straight, arrow_big, COLOR_RED, false, self.x, self.y, 4, Angle(self, player))
            end
        end
    end)
end)
```

### 4.2 手动版：`New(enemy, …)`

需要精细控制时（比如先创建、后由别处定位）：

```lua
local e = New(enemy, style, hp, clearBullet, autoDelete, nonTaijutsu)
e.x, e.y = 120, 420
e.drop = {4, 0, 0}
e.protect = true
task.New(e, function()
    task.Wait(30)
    e.protect = false
end)
-- 之后再用 task 驱动行为
```

签名：`enemy:init(style, hp, clear_bullet, auto_delete, nontaijutsu)`。

### 4.3 血量判定链路（为什么"自动就扣血了"）

```
自机子弹命中
  └─ enemybase:colli(other)        -- other.dmg 存在才结算
       ├─ Damage(self, dmg) → enemy:take_damage(dmg)
       │     ├─ protect == true ? 不掉血
       │     └─ self.hp = self.hp - dmg
       └─ Kill(other)              -- 消掉自机子弹

每帧 enemybase:frame()
  ├─ colli = BoxCheck(...) && self._colli   -- 出界即关闭碰撞
  ├─ if self.hp <= 0 then Kill(self)        -- 死亡统一入口
  └─ task.Do(self)                          -- 驱动协程

Kill → enemy:kill()
  ├─ New(enemy_death_ef, …)  死亡特效
  ├─ item.DropItem(x, y, drop)  掉落
  ├─ New(bullet_killer, player.x, player.y, false)  清弹（clear_bullet）
  └─ _kill_servants(self)    清理附属物
```

手动扣血用全局 `Damage(obj, dmg)`（会走 `take_damage`，尊重 `protect`）。

### 4.4 行走图 style 编号表

| style | 图像来源 | 说明 |
|---|---|---|
| 1~18 | `enemy1_1` ~ `enemy18_12` | 标准 12 帧行走图（左右移动会切帧） |
| 19~22 | `kedama1` ~ `kedama4` | 毛玉 |
| 23~26 | `enemy_orb1` ~ `enemy_orb4` | 光球（自转） |
| 27~30 | `ghost_fire_r/b/g/y` | 鬼火（红/蓝/绿/黄） |
| 31~34 | 同上（另一组） | 鬼火变体 |

### 4.5 常用字段

| 字段 | 作用 |
|---|---|
| `hp` / `maxhp` | 当前/最大血量 |
| `protect` | `true` 时免疫伤害（出生保护、符卡切换） |
| `dmgmaxt` / `dmgt` | 受击闪白（`dmgt` 每帧 -1） |
| `dmg_factor` | 伤害倍率（<1 减伤） |
| `drop` | 掉落表 `{power, faith, point}`，其中 `[2]`/`[3]` 是**个数** |
| `clear_bullet` | 死亡清屏 |
| `auto_delete` / `bound` | 出界删除 |
| `_wisys` | 行走图系统（`render` 用） |

---

## 5. Boss 与符卡

```lua
-- 1) 定义（注册到 boss.record[id]）
boss.define(id, name, x, y, scbg, diff, bgm, bg, img, nCol, nRow, a, b, intv, imgs, anis)
-- 2) 造符卡
local cards = {
    boss.card.New('',           0, 20, 30, 1200, {4,0,0}, false),  -- 非符（名字留空）
    boss.card.New('「测试」',   2,  8, 45, 1800, {0,0,0},    false),  -- 符卡
}
-- 3) 生成
local b = boss.createWithCards(id, cards)
```

| API | 说明 |
|---|---|
| `boss.card.New(name, t1, t2, t3, hp, drop, is_extra)` | `t1/t2/t3` 单位**秒**（内部 ×60），须满足 `t1 ≤ t2 ≤ t3`；`name = ''` 即非符 |
| `boss.create(id, x, y)` | 生成 Boss（`x/y` 可覆盖定义时的坐标） |
| `boss.createWithCards(id, cards)` | 同 `New(boss.record[id], cards)`，带符卡表 |
| `boss.move.New(x, y, t, m)` | 符卡内的位移动作 |
| `boss.escape.New(x, y, t, m)` | 退场动作 |
| `boss.dialog.New(can_skip)` | 对话系统 |
| `boss:show_aura(bool)` / `boss:cast(t)` | 光环 / 蓄力演出 |

> `boss.define` 的 `img/nRow/nCol/imgs/anis/intv/a/b` 是行走图参数，透传给 `BossWalkImageSystem:SetImage`；不确定时用编辑器 `BossDefine` 节点生成，别手搓。

---

## 6. 任务与走位

| 函数 | 说明 |
|---|---|
| `task.New(target, f)` | 在 `target` 上开协程，返回 thread |
| `task.Wait(n)` | 等 n 帧（**最少 1 帧**） |
| `task._Wait(n)` | 等 n 帧（**允许 0 帧**，编辑器节点专用） |
| `task.MoveTo(x, y, t, mode)` | 直线插值到目标 |
| `task.MoveToPlayer(t, …)` | 追自机 |
| `task.GetSelf()` | 取当前协程宿主 |
| `task.Clear(target)` | 清空目标上的协程 |
| `boss.MoveTowardsPlayer(t)` | Boss 专用：朝自机移动 |

`mode` 常量：`MOVE_NORMAL=0`、`MOVE_ACCEL=1`、`MOVE_DECEL=2`、`MOVE_ACC_DEC=3`。

---

## 7. 道具与掉落

```lua
item.DropItem(x, y, {power, faith, point})
```

`drop[1]` 是**火力值**（`>= 400` 时直接掉一个大 P），`drop[2]` 是信仰道具**个数**，`drop[3]` 是点数道具**个数**——后两项走 `for i = 1, drop[n]` 循环，填 `1000` 就是真的生成 1000 个道具，会明显掉帧。三项加权和 `< 1` 时不掉落。

---

## 8. 常用特效与工具类

| 对象 | 用途 |
|---|---|
| `New(hinter, img, size, x, y, t1, t2, fade)` | 预警提示（"Boss 接近"之类） |
| `New(bubble, img, x, y, life, s1, s2, c1, c2, layer, blend)` | 气泡/爆炸特效 |
| `New(bubble2, …)` | 带初速的气泡 |
| `New(float_text, fnt, text, x, y, v, angle, life, s1, s2, c1, c2)` | 飘字 |
| `New(tasker, f)` | 纯协程宿主（无渲染） |
| `New(shutter, mode)` / `New(mask_fader, mode)` | 转场 |
| `New(Shaker, time, size)` / `misc.ShakeScreen(t, s)` | 震屏 |
| `misc.Renderhp / Renderhpbar / RenderRing` | 血条、圆环 UI |
| `misc.KeepParticle(o)` | 对象死亡后保持粒子 |
| `ex.SmoothSetValueTo(...)` / `ex.WaitTo(...)` | 平滑插值 / 定时等待 |

---

## 9. 常量速查

```lua
-- 碰撞组
GROUP_GHOST=0 GROUP_ENEMY_BULLET=1 GROUP_ENEMY=2 GROUP_PLAYER_BULLET=3
GROUP_PLAYER=4 GROUP_INDES=5 GROUP_ITEM=6 GROUP_NONTJT=7
GROUP_SPELL=8 GROUP_CPLAYER=9 GROUP_ALL=16

-- 图层
LAYER_BG=-700 LAYER_ENEMY=-600 LAYER_PLAYER_BULLET=-500 LAYER_PLAYER=-400
LAYER_ITEM=-300 LAYER_ENEMY_BULLET=-200 LAYER_ENEMY_BULLET_EF=-100 LAYER_TOP=0

-- 插值模式
MOVE_NORMAL=0 MOVE_ACCEL=1 MOVE_DECEL=2 MOVE_ACC_DEC=3
```

---

## 10. 和编辑器生成代码共存

| 场景 | 写法 |
|---|---|
| 编辑器 `BulletDefine` + `CreateBullet` 节点 | 生成 `_editor_class["x"] = Class(bullet)`，`CreateBullet` 内部仍是 `New(_straight, …)` |
| 想要 OO 写法 | 直接开 `Code` 节点写 `New(straight, …)`，**完全不需要 BulletDefine** |
| 想要带血量敌机 | `Code` 里 `New(EnemySimple, …)`，**不需要 EnemyDefine** |
| 已有 `_editor_class` 类要复用 | `New(_editor_class["名字"], …)` 仍可用，二者不冲突 |

**推荐架构**：类定义交给 THlib 现成的 `straight`/`EnemySimple`，编辑器树里只用 `StageGroup → Stage → TaskNode → Code`，节点树更短、代码更直观。

---

## 11. 坑位清单

| 现象 | 原因 | 解法 |
|---|---|---|
| 子弹参数错位、弹道诡异 | 把 `_straight` 的实参顺序套到 `straight` | 记住 `stay` 在第 3 位，`x,y` 在其后 |
| 敌机不扣血 | 碰撞的是 `GROUP_NONTJT`，或 `protect` 未解除 | 检查 `nonTaijutsu` 参数与保护帧 |
| 敌机打不死 | `take_damage` 被重写但没调基类 | 自定义类里 `enemy.take_damage(self, dmg)` |
| 掉血但没掉落 | `drop` 表加权和 < 1，或没设 `self.drop` | 传 `{4, 0, 0}` 这类合法表（`[2]`/`[3]` 是个数） |
| 清弹没清干净 | `bullet_killer` 的 `kill_indes` 传了 `false` | 炸弹场景传 `true` |
| 子弹停在原地 | `stay = true` | 正常飞行传 `false` |
| 敌机子弹穿过自机不消失 | 用了 `straight_indes` | 换 `straight` |
