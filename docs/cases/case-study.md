# 案例 01：从游戏录像逆向一张 Boss 符卡

> 这是一份“黄金参考答案”：输入一段真实录像，输出一个与原作者工程在**结构、参数、视觉**三方面对齐的
> LuaSTG Editor 工程。后续任何视频逆向任务（例如红魔乡）都以本案例为基准做回归比对。
>
> 目录内容：
>
> | 文件 | 说明 |
> |---|---|
> | `analysis_1.json` | `analyze-video-bullets.py --tracks` 的原始输出（201 帧 / 0–20 s） |
> | `Reference-1.lstges` | 原作者的**真实工程**（唯一真值） |
> | `Reference-Match-1.lstges` | 本次复刻产物，已实机 F5 验证“观感一致” |

---

## 1. 输入：视频统计

| 指标 | 数值 |
|---|---|
| 帧数 / 时长 | 201 帧 / 0–20 s（0.1 s 采样） |
| 峰值 | **242 发 @ t = 0.1 s** |
| 颜色（峰值帧） | blue 171（71%）· magenta 38 · green 13 · red 13 |
| 平均生成率 | 107 发/s（峰值 910/s） |
| 平均速度 | 141 px/s（**后被证明不可信**，见 §5） |
| 阵型判定 | chaos 200 / 其它 1（跟踪 `lifetimeMean` 仅 0.2 s） |

位置几何（射线汇聚中心 `(408,479)`，半径 p10=154 / p90=581）：
方位角 16 等分直方图在 **0° / 120° / 225° / 315°** 有四个聚集，半径分布无明显多峰。

**当时（错误）的结论**：4 臂旋转 + 中心对称环。**实际**：四角炮口的瞄准扇形。

---

## 2. 真值：`Reference-1.lstges`

```
BossDefine "Stage 1 mid"   Position = 240,50
└─ BossSpellCard   保护 0 / 减伤 5 / 30 s / HP 750 / 掉落 20,0,40
   ├─ TaskNode ①（位移，与火力并行）
   │  ├─ TaskMoveToCurve  Bezier 120f MOVE_DECEL  (240,50)(-50,46.8)(-20,100)(0,120)
   │  └─ Repeat(_infinite) → EnemyWander 60f + Wait 15
   └─ TaskNode ②（火力）
      ├─ Wait 120
      └─ Repeat(_infinite)
         └─ Repeat(1)                       ← 作用域壳
            ├─ LocalVar a  = -atan2(player.x-(self.x-80), player.y-(self.y-40))*180/pi+90
            ├─ Repeat(30) → 7×water_drop / DEEP_PURPLE @(self.x-80,self.y-40) v=5 angle=a spread=160
            │              Wait 2
            ├─ Wait 45
            ├─ LocalVar a1 = ...(self.x+80, self.y-40)...
            ├─ Repeat(30) → 同款 @(self.x+80,self.y-40) angle=a1
            ├─ Wait 60
            ├─ TaskNode ③  LocalVar a2 → Repeat(20)(a3+=20, n+=1)
            │              → n×ball_mid / BLUE @(self.x-60,self.y+40) v=4 angle=a2 spread=a3 → Wait 15
            ├─ TaskNode ④  同上 @(self.x+60,self.y+40)
            └─ Wait 345
```

**四个结构性特征**（决定观感，统计量里看不出来）：

1. **发射点是偏移的**：`(±80,-40)` 与 `(±60,+40)`，不是 `(self.x,self.y)`；
2. **每波重新瞄准**：`atan2(player - 炮口)` 实时计算，玩家一动整片跟着转；
3. **扩散角是递增量**：`a3: 20 → 400`，形成“渐开的伞”；
4. **弹数是递增量**：`n: 1 → 20`，随扩散角同步变密。

---

## 3. 第一版复刻（错误范式）

```
BossDefine "BlueStorm"
└─ BossSpellCard 45 s / HP 3000
   └─ TaskNode → Repeat(999, rot += 6)
      ├─ 36×ball_mid/BLUE   @(self.x,self.y) v=4.07 angle=rot     spread=360
      ├─ 18×ball_small/CYAN @(self.x,self.y) v=2.93 angle=-rot*0.6 spread=360
      └─ Wait 24
```

**统计能对上、观感完全不对**：整环自转 ≠ 四角瞄准扇形。

---

## 4. 差异对照

| 维度 | 真值 | 第一版 | 结论 |
|---|---|---|---|
| 发射点 | 4 个偏移炮口 | 中心 1 个 | 致命 |
| 瞄准 | 每次 atan2 重算 | 无（固定自转） | 致命 |
| 扩散 | 160° 固定 / 20→400 递增 | 360° 固定 | 致命 |
| 数量 | 7 固定 / 1→20 递增 | 36+18 固定 | 致命 |
| 节奏 | Wait 2 × 30 连发 | Wait 24 单波 | 数量级差 |
| 速度 | 5 px/帧(300) / 4 px/帧(240) | 4.07(244) / 2.93(176) | 慢 19–27% |
| 贴图/色 | water_drop+DEEP_PURPLE / ball_mid+BLUE | ball_mid/BLUE + ball_small/CYAN | 错 |
| 卡面 | 30 s / 750 / 保护 0 | 45 s / 3000 / 保护 2 | 错 |
| 位移 | Bezier 入场 + EnemyWander | 静止 | 缺 |
| 并发 | 2 个 TaskNode 并行 | 1 个 | 缺一层 |

---

## 5. 为什么“统计对、观感错”

- **速度被低估**：`lifetimeMean = 0.33 s` 时互选最近邻大量串号，位移被算小；`speedMean` 在峰值帧
  其实是 154–187（不是 141），真值是 300/240。
- **半径直方图被误读**：中心点是用噪声速度拟合出来的（rms 190 px），在假中心上量半径，
  “内密外疏”其实是“四角朝玩家汇聚”的投影。数据当时已在暗示扇形。
- **颜色误判**：`byColor` 取连通块均值，弹体高光边缘把 BLUE/DEEP_PURPLE 判成了 CYAN。

**教训**：发数、颜色、均速只是必要条件。决定观感的是**发射点、瞄准方式、扩散规律、节奏**——
这四项必须从结构层面（节点树）复刻，不能靠像素统计反推。

---

## 6. 致命 Bug：`LocalVar` 的作用域

第一次按真值重建后，F5 直接崩溃：

```
调用全局函数 'FrameFunc' 时出错:
[string "lib/Ltask.lua"]:36: [string "THlib/editor.lua"]:455:
attempt to perform arithmetic on local 'angle' (a nil value)
```

`_create_bullet_group` 第 455 行是 `angle = angle + da * (-n / 2 + 0.5)`，`angle` 为 nil。

根因：`LocalVar` 生成的是**块级局部变量**（`Data/LocalVar.cs`）：

```csharp
yield return sp + "local " + NonMacrolize(i) + " = (" + Macrolize(i + 1) + ")\n";
```

错误结构（把 `Repeat(30)` 放成了 `Repeat(1)` 的**兄弟**）：

```lua
for _ = 1, _infinity do
  for _ = 1, 1 do local a = (...) end   -- a 死在这里
  for _ = 1, 30 do
    _create_bullet_group(..., a, ...)   -- a == nil
  end
end
```

正确结构（`Repeat(1)` 是**每轮的局部作用域壳**，所有发射逻辑是它的子节点）：

```lua
for _ = 1, _infinity do
  do for _ = 1, 1 do
    local a = (...)
    for _ = 1, 30 do _create_bullet_group(..., a, ...) task._Wait(2) end
    task._Wait(45)
    local a1 = (...)
    ...
  end end
end
```

### 6.1 `player` 为 nil 的兜底

`player` 在死亡/重生/无敌帧可能为 nil，索引 `player.x` 会二次崩溃。四个 `LocalVar` 统一改成：

```lua
player and (-math.atan2(player.x-(self.x-80), player.y-(self.y-40))*(180/math.pi)+90) or 0
```

### 6.2 `atan2` 与 `Angle`

`math.atan2` 在 LuaSTG 的 Lua 5.1/LuaJIT 上可用，且参考工程本身就在用；
本次崩溃与它无关。若目标引擎确实没有，可换成引擎原生 `Angle(self, player)+90`
（会失去 ±80/±40 炮口偏移的细微角度差）。

---

## 7. 最终产物：`Reference-Match-1.lstges`

与真值同构（45 节点），三处等价简化：

1. 蓝色段的 `Repeat(20)` 用**单变量** `a3`（20→400），`Number = a3/20` 代替原版的
   `a3 += 20` + `n += 1` 双变量（数值等价，绕开多变量依赖属性在桥接上的一次性插入限制）；
2. 其余 4 个 `LocalVar` 直接挂在协程体/子 TaskNode 里，作用域与原版一致；
3. 角度表达式加了 `player` 兜底。

**验收结果**：F5 实机运行，“四角水柱喷射 + 蓝伞渐开 + 实时追踪自机”与原版观感一致。

---

## 8. 复跑方法

```bash
# 1) 分析视频，拿到时间轴、速度、颜色、阵型
python scripts/analyze-video-bullets.py game.mp4 --tracks --interval 0.1 --out analysis_1.json

# 2) 看峰值帧的散点，重点看三件事：
#    - 半径是否多峰（多环）还是单调（扇形/云）
#    - 速度相对“某个中心”是径向、切向还是汇聚
#    - 相邻帧的颜色比例是否交替（错拍的子系统）
python scripts/count-bullets.py frame.png --auto --template
```

节点复刻检查清单：

- [ ] 发射点是否都在 `self.x,self.y`？（真值常有偏移）
- [ ] 每波是否重新瞄准（`atan2` / `Angle`）？
- [ ] `spread` / `Number` 是否应该是**变量**而非常量？
- [ ] 局部变量是否放在 `Repeat(1)` 作用域壳里、且消费者在同一壳内？
- [ ] `player` 是否有 nil 兜底？
- [ ] 卡面数值（时长/血量/保护）是否与真值一致？

---

## 9. 已知误差

- 视频侧：`lifetimeMean < 0.5 s` 时速度不可信；重叠弹连通域会少算；亮度背景会污染计数。
- 工程侧：`Number = a3/20` 产生浮点（1.0…20.0），`for i = 0, n-1` 与 `da/n` 均可正确处理；
  若需严格整数改成 `math.floor(a3/20)`。
- 视觉侧：`Angle(self, player)` 替代式会丢掉炮口偏移角，密弹时肉眼几乎不可辨。
