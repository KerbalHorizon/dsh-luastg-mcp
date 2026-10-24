# LuaSTG MCP 桥接安装说明

> 适用版本：**LuaSTG Editor Sharp X v0.78.4（含 MCP 桥接的完整版）**
> 安装包：`LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`
> 桥接协议：v1
> 最后更新：2026-10-24

## 0. 一句话说明

下载 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`，解压到一个新目录，
双击 `LuaSTGEditorSharp.exe` 即可。

**不需要自己编译，也不需要手工替换任何 DLL。**

## 1. 为什么必须使用完整包

桥接不是独立插件，而是集成在 `LuaSTGPlusLib` 插件中，随编辑器一起启动。
它依赖 v0.78.4 的运行时和整套依赖库。

v0.78.3 的依赖版本与 v0.78.4 不同。只把 `LuaSTGMcpBridge.dll` 和
`LuaSTGPlusLib.dll` 复制到旧版编辑器，常见结果是插件初始化失败、桥接不监听 8090，
或者编辑器提示插件错误。

**所以请使用完整压缩包，不要只取其中两个 DLL。**

## 2. 安装包内容

压缩包是**完整编辑器**，已经包含：

- `LuaSTGEditorSharp.exe`（v0.78.4）
- 已集成 MCP 桥接的 `LuaSTGPlusLib.dll`
- `LuaSTGMcpBridge.dll`
- 编辑器运行所需的全部依赖

## 3. 环境要求

| 组件 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 x64 |
| .NET Framework | 4.8（Windows 10 / 11 通常已自带） |
| DSH | `>=0.2.0-rc.2 <0.3.0` |
| Node.js | `>= 22.13` |
| 编译环境 | **不需要** |

## 4. 安装步骤

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
7. 打开同目录下的 `editor.log`，应出现：

   ```text
   MCP bridge ready on 127.0.0.1:8090.
   ```

> 如果 Windows 提示“已保护你的电脑”，点击“更多信息”→“仍要运行”即可。

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

期望输出：

```json
{"status":"pong","editor":"connected"}
```

## 6. 安装 DSH 插件

1. 安装插件（把两个路径换成你的实际路径）：

   ```powershell
   & '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add '<本仓库目录>'
   ```

2. **完全退出并重新启动 DSH**。工具只在 DSH 进程启动时注册。
3. 让模型调用 `luastg_get_nodes`，应返回 `status: "ok"` 和当前工程的节点树。

工具参数和返回值说明见 [README](../README.md)。

## 7. 升级与回滚

- 升级：下载新版本的完整压缩包，解压到新目录，不要覆盖旧目录。
- 回滚：直接运行旧目录的 `LuaSTGEditorSharp.exe`。
- 旧版本没有桥接时，DSH 的 `luastg_*` 工具会连接失败，这是预期行为。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 双击没有反应，或提示文件被阻止 | 右键压缩包/目录 →“属性”→“解除锁定”；也可以对文件执行 `Unblock-File`。 |
| 编辑器能启动，但 `editor.log` 没有 `MCP bridge ready` | 启动的不是 v0.78.4 完整包，或目录解压不完整。确认使用的是 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`。 |
| 弹出“插件加载失败” | 目录里混入了旧版 DLL。删除整个目录，重新解压完整包，不要手工替换文件。 |
| 8090 被占用 | 执行 `Get-NetTCPConnection -LocalPort 8090` 找到占用进程，关闭另一个编辑器实例。 |
| DSH 调用报连接失败 | 编辑器没开、桥接没启动，或 DSH 没有完全重启。先完成第 5 节的 ping。 |
| 返回 `no_document` | 编辑器还没有打开 `.lstges` 工程。 |
| 只想要两个 DLL，不要完整包 | 不支持。桥接与 v0.78.4 的依赖必须整套使用。 |

## 9. 版本矩阵

| 编辑器版本 | 桥接支持 | 说明 |
|---|---|---|
| v0.78.4 完整包（含 MCP 桥接） | ✅ 支持 | 本文档使用的版本 |
| v0.78.3 官方 Release | ❌ 不支持 | 不包含桥接，依赖版本也不匹配 |
| v0.78.3 及更早版本 + 手工替换 DLL | ❌ 不支持 | 可能导致插件加载失败，不要这样分发 |

## 10. 分发前检查清单

- [ ] 压缩包文件名是 `LuaSTG-Editor-Sharp-X_v0.78.4_with_MCP.zip`；
- [ ] 压缩包内是**完整编辑器目录**，不是只有两个 DLL；
- [ ] `LuaSTGEditorSharp.exe` 的版本为 `0.78.4`；
- [ ] 启动后 `editor.log` 出现 `MCP bridge ready on 127.0.0.1:8090.`；
- [ ] `ping` 返回 `{"status":"pong","editor":"connected"}`；
- [ ] 发布页附上 SHA256；
- [ ] 发布说明写明“仅支持 v0.78.4 完整包，不支持替换 DLL”。

## 11. 安全提示

桥接只监听 `127.0.0.1`，但**没有认证**：本机任何进程都能连接 8090 并修改当前文档。
不要做端口转发，不要把 8090 暴露到局域网或公网。
