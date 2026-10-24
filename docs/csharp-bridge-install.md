# LuaSTG MCP 桥接安装说明

> 推荐版本：**LuaSTG Editor Sharp X v0.78.4 完整整合包**
> 实验性支持：**官方 v0.78.3 + BridgeDeps 文件集（仅 ExPlus 插件）**
> 完整整合包：`LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`
> 桥接协议：v1
> 最后更新：2026-10-24

## 0. 两种获取方式

### 方式 A：C# 源码仓库（仅开发者）

需要查看或自行编译源码的开发者，请使用：

**https://github.com/KerbalHorizon/LuaSTG-Editor-Sharp-X**

普通用户不需要走方式 A，直接使用完整整合包，或按第 4 节在 v0.78.3 上做实验性安装。

### 方式 B：完整整合包（推荐普通用户）

下载 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`，解压到一个新目录，
双击 `LuaSTGEditorSharp.exe` 即可。

**不需要自己编译，也不需要手工替换任何 DLL。**

> v0.78.3 用户不要直接覆盖日常安装。请先看第 4 节，在备份目录里实验。

## 1. 兼容范围（先看）

| 编辑器版本 | 状态 | 说明 |
|---|---|---|
| v0.78.4 完整整合包 | ✅ 支持 | 推荐给所有人 |
| v0.78.3 官方 Release + 第 4 节文件集 | ⚠️ 实验性 | 0.78.3 Core 的 API 探测已通过；完整编辑器仍需按附录实测 |
| v0.78.0–v0.78.2 官方 Release + 第 4 节文件集 | ⚠️ best effort | 本地没有这三个版本的参考 DLL；由运行时能力门禁兜底 |
| v0.78.3 及更早版本 + 只替换两个 DLL | ❌ 不支持 | 会缺少 BridgeDeps，桥接通常不会启动 |

**仅支持 LuaSTG ExPlus 插件。** 桥接启动点在 `LuaSTGPlusLib.dll` 的 `PluginEntry`
构造函数里。如果编辑器当前选择的是 `LuaSTGSubLib.dll` / `LuaSTGEvoLib.dll` /
`LuaSTGFluxLib.dll`，桥接不会启动。

## 2. 为什么不能只替换两个 DLL

桥接不是独立插件，而是集成在 `LuaSTGPlusLib` 插件中，随编辑器一起启动。
它还需要自己的第三方依赖：

- 桥接编译时使用 **Serilog 4.3.1**；
- 官方 v0.78.3 自带 **Serilog 4.2.0.0**；
- 两者都是强名称程序集，不能靠“忽略版本”解决。

因此桥接启动时会注册一个受控的 `AssemblyResolve`：

- 只劫持 **Serilog** 和 **Newtonsoft.Json**；
- 只接受桥接程序集发起的请求；
- 从 `BridgeDeps` 目录加载自带版本；
- **绝不劫持** `LuaSTGEditorSharp.Core`、`LuaSTGNode.*` 或 `LuaSTGPlusLib`。

所以 v0.78.3 需要的是一套文件，不是两个 DLL：

```text
LuaSTGPlusLib.dll
LuaSTGMcpBridge.dll
BridgeDeps\Serilog.dll
BridgeDeps\Newtonsoft.Json.dll
```

## 3. 完整整合包安装（推荐）

1. 下载 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`。
2. 可选：按发布页提供的 SHA256 校验压缩包。
3. 解压到一个**新目录**，例如：

   ```text
   D:\LuaSTG\LuaSTG-Editor-Sharp-X_v0.78.4
   ```

   - 不要覆盖原来的 v0.78.3 目录；
   - 不要在压缩包预览窗口里直接双击运行。

4. 进入解压后的目录，双击 `LuaSTGEditorSharp.exe`。
5. 确认窗口标题或“关于”窗口显示 **v0.78.4**。
6. 打开一个 `.lstges` 工程（只开启动页不算）。
7. 打开同目录下的 `mcp-bridge.log`，应出现：

   ```text
   MCP bridge ready on 127.0.0.1:8090.
   ```

> 桥接日志现在写入独立的 `mcp-bridge.log`，**不再写入 `editor.log`**。
> `editor.log` 只保留编辑器宿主自己的日志。

## 4. 官方 v0.78.3 实验性安装（仅 ExPlus）

> 这一节是高级用法。请务必在官方 v0.78.3 的**备份副本**里操作，
> 不要直接改日常使用的编辑器目录。

### 4.1 文件清单

把以下文件放进编辑器目录：

```text
<EditorRoot>\
  lib\
    LuaSTGPlusLib.dll          ← 替换（先备份原文件）
    LuaSTGMcpBridge.dll        ← 新增
    BridgeDeps\
      Serilog.dll              ← 新增，4.3.1 net471
      Newtonsoft.Json.dll      ← 新增，13.0.4 net45
```

可选：

- `lib\LuaSTGPlusLib.dll.config` 可以替换成我们构建输出的版本；
- 宿主的 `LuaSTGEditorSharp.exe.config` 才是最终绑定配置，不建议改。

**不要替换**：

- `LuaSTGEditorSharp.exe`
- `LuaSTGEditorSharp.Core.dll`
- `LuaSTGNode.Legacy.dll` / `LuaSTGNode.Legacy.Windows.dll`
- 宿主自带的 `lib\Serilog.dll`（4.2）

### 4.2 安装步骤

1. 把官方 v0.78.3 压缩包解压到一个新目录，例如：

   ```text
   D:\LuaSTG\test-0783-mcp
   ```

2. 备份原插件：

   ```powershell
   Copy-Item 'lib\LuaSTGPlusLib.dll' 'lib\LuaSTGPlusLib.dll.orig'
   ```

3. 从我们的构建输出复制文件（以下命令在编辑器根目录执行）：

   ```powershell
   $src = 'D:\LuaSTG-Editor-Sharp-X-main\bin\Release'
   Copy-Item "$src\LuaSTGPlusLib.dll" 'lib\LuaSTGPlusLib.dll' -Force
   Copy-Item "$src\LuaSTGMcpBridge.dll" 'lib\LuaSTGMcpBridge.dll' -Force
   New-Item -ItemType Directory 'lib\BridgeDeps' -Force | Out-Null
   Copy-Item "$src\BridgeDeps\Serilog.dll" 'lib\BridgeDeps\Serilog.dll' -Force
   Copy-Item "$src\BridgeDeps\Newtonsoft.Json.dll" 'lib\BridgeDeps\Newtonsoft.Json.dll' -Force
   ```

4. 解除 Windows 对下载文件的锁定：

   ```powershell
   Get-ChildItem 'lib' -Recurse -File | Unblock-File
   ```

5. 启动编辑器，在设置里把节点库切换为：

   ```text
   lib\LuaSTGPlusLib.dll
   ```

   也就是 **LuaSTG ExPlus**。如果仍然指向 `lib\LuaSTGSubLib.dll`，
   桥接不会启动。

6. 打开一个 `.lstges` 工程。
7. 检查编辑器根目录的 `mcp-bridge.log`，应出现：

   ```text
   MCP bridge starting for editor "0.78.3.x"; compatible=True.
   MCP bridge listening on 127.0.0.1:8090.
   MCP bridge ready on 127.0.0.1:8090.
   ```

### 4.3 回滚

1. 关闭编辑器。
2. 恢复原插件：

   ```powershell
   Copy-Item 'lib\LuaSTGPlusLib.dll.orig' 'lib\LuaSTGPlusLib.dll' -Force
   ```

3. 删除新增文件：

   ```text
   lib\LuaSTGMcpBridge.dll
   lib\BridgeDeps\
   ```

4. 在设置里把节点库切回原来的 `lib\LuaSTGSubLib.dll` 或你常用的插件。

## 5. 验证桥接

```powershell
# 1) 端口是否在监听
Test-NetConnection 127.0.0.1 -Port 8090

# 2) 最小协议测试，应返回 pong
$c = New-Object Net.Sockets.TcpClient
$c.Connect('127.0.0.1', 8090)
$s = $c.GetStream()
$w = New-Object IO.StreamWriter($s); $w.AutoFlush = $true
$r = New-Object IO.StreamReader($s)
$w.WriteLine('{"action":"ping"}')
$r.ReadLine()
$c.Close()
```

期望输出（字段可能更多）：

```json
{"status":"pong","editor":"connected","editorVersion":"0.78.3.0","bridgeCompatible":true}
```

- `bridgeCompatible: true`：当前编辑器 API 探测通过；
- `bridgeCompatible: false`：桥接能启动，但树操作会被拒绝，
  返回 `unsupported_editor_version`，`details.missing` 会列出缺失的成员。

## 6. 安装 DSH 插件

1. 安装插件（把两个路径换成你的实际路径）：

   ```powershell
   & '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本仓库目录>'
   ```

2. **完全退出并重新启动 DSH**。工具只在 DSH 进程启动时注册。
3. 让模型调用 `luastg_get_nodes`，应返回 `status: "ok"` 和当前工程的节点树。

工具参数和返回值说明见 [README](../README.md)。

## 7. 日志与排查

桥接现在使用**独立的** `mcp-bridge.log`：

- 位置：编辑器根目录；如果根目录不可写，则退到
  `%TEMP%\LuaSTG Editor\mcp-bridge.log`；
- 内容：只包含桥接自己的启动、兼容性探测和 TCP 错误；
- 不会写入宿主的 `editor.log`。

宿主 `editor.log` 仍然由编辑器自己的 Serilog 4.2 写入。**不要再用
`editor.log` 判断桥接是否启动**，请看 `mcp-bridge.log`。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 编辑器能启动，但 `mcp-bridge.log` 没有 `MCP bridge ready` | 启动的不是完整包，或插件路径仍指向 `lib\LuaSTGSubLib.dll`。确认已选择 `lib\LuaSTGPlusLib.dll`。 |
| `bridgeCompatible` 为 `false` | 当前版本缺少桥接需要的 Core API。看 `details.missing`；0.78.0–0.78.2 属于 best effort。 |
| 弹出“插件加载失败” | `LuaSTGPlusLib.dll` / `LuaSTGMcpBridge.dll` / `BridgeDeps` 不完整或版本混用。恢复 `LuaSTGPlusLib.dll.orig` 后重新按第 4 节复制。 |
| 8090 被占用 | 执行 `Get-NetTCPConnection -LocalPort 8090` 找到占用进程，关闭另一个编辑器实例。 |
| DSH 调用报连接失败 | 编辑器没开、桥接没启动，或 DSH 没有完全重启。先完成第 5 节的 ping。 |
| 返回 `no_document` | 编辑器还没有打开 `.lstges` 工程。 |
| 返回 `unsupported_editor_version` | 当前编辑器缺少必要 API，桥接选择拒绝执行而不是崩溃。看 `details.missing`。 |
| 下载的 DLL 被 Windows 锁定 | 在目录上执行 `Unblock-File`（可配合 `Get-ChildItem -Recurse`），或“属性 → 解除锁定”。 |

## 9. 版本矩阵

| 编辑器版本 | 桥接支持 | 说明 |
|---|---|---|
| v0.78.4 完整整合包（含 MCP 桥接） | ✅ 支持 | 推荐 |
| v0.78.3 官方 Release + 第 4 节文件集 | ⚠️ 实验性 | API 探测通过；完整编辑器需按附录实测 |
| v0.78.0–v0.78.2 官方 Release + 第 4 节文件集 | ⚠️ best effort | 无参考 DLL，依赖能力门禁 |
| v0.78.3 及更早版本 + 只替换两个 DLL | ❌ 不支持 | 缺少 BridgeDeps，桥接通常不启动 |

## 10. 分发前检查清单

- [ ] 完整包文件名是 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`；
- [ ] v0.78.3 文件集至少包含 `LuaSTGPlusLib.dll`、`LuaSTGMcpBridge.dll`、
      `BridgeDeps\Serilog.dll`、`BridgeDeps\Newtonsoft.Json.dll`；
- [ ] `LuaSTGPlusLib.dll` 与 `LuaSTGMcpBridge.dll` 来自同一次构建；
- [ ] 启动后 `mcp-bridge.log` 出现 `MCP bridge ready`；
- [ ] `ping` 返回 `status: "pong"`，`bridgeCompatible: true`；
- [ ] 发布页附上 SHA256；
- [ ] 发布说明写明“仅 ExPlus；0.78.3 为实验性；0.78.0–0.78.2 为 best effort”。

## 11. 安全提示

桥接只监听 `127.0.0.1`，但**没有认证**：本机任何进程都能连接 8090 并修改当前文档。
不要做端口转发，不要把 8090 暴露到局域网或公网。

## 附录 A：v0.78.3 纯净版测试步骤

> 目标：在**备份副本**里验证桥接，不影响日常使用的编辑器。

1. 准备一个全新的官方 v0.78.3 目录，例如 `D:\LuaSTG\test-0783-mcp`。
2. 确认 `LuaSTGEditorSharp.exe` 的文件版本是 `0.78.3`。
3. 备份：

   ```powershell
   Copy-Item 'lib\LuaSTGPlusLib.dll' 'lib\LuaSTGPlusLib.dll.orig'
   ```

4. 复制构建输出（第 4.2 节的 5 条命令）。
5. 执行 `Unblock-File`。
6. 启动编辑器，进入设置，把节点库切换为 `lib\LuaSTGPlusLib.dll`（LuaSTG ExPlus）。
   如果设置界面打不开，或默认路径仍是根目录，先在**测试副本**的
   `LuaSTGEditorSharp.exe.config` 中把 `LuaSTGNodeLibPath` 的值改成
   `lib\LuaSTGPlusLib.dll`，再启动。
7. 关闭编辑器，删除旧的 `editor.log` 和 `mcp-bridge.log`。
8. 重新启动编辑器，打开一个测试 `.lstges`。
9. 检查 `mcp-bridge.log`：

   - 应有 `MCP bridge starting for editor "0.78.3.x"`；
   - 应有 `MCP bridge ready on 127.0.0.1:8090.`；
   - 如果出现 `compatible=False`，记录 `details` 里的缺失成员。

10. 检查 `editor.log`：

    - 应有宿主的 `Plugin initialization successful`；
    - **不应**因为桥接而出现 `FileLoadException` / `TypeLoadException`；
    - 桥接启动后，宿主仍应继续写 `MainWindow` 等日志，证明 `editor.log` 没被劫持。

11. 执行第 5 节的 ping，确认 `bridgeCompatible: true`。
12. 让 DSH 调用 `luastg_get_nodes`，确认能读到当前工程节点树。
13. 依次测试插入、改属性、删除，并在编辑器里按 `Ctrl+Z` / `Ctrl+Y` 验证 Undo/Redo。
14. 关闭编辑器，确认 `mcp-bridge.log` 中没有未处理异常。
15. 回滚：按第 4.3 节恢复 `LuaSTGPlusLib.dll.orig`，删除桥接文件和 `BridgeDeps`，
    再把节点库切回原来的插件。
