# Embedder Monitor 串口连接 / 日志读取 排查手册

适用版本：v0.3.0+
最近更新：v0.3.0 修复轮（hotfix）

---

## 1. 整体数据通路

```
Webview UI / AI Agent
       │
       ▼
SerialMonitorViewProvider / AcpClientImpl
       │  (postMessage / extMethod)
       ▼
       SerialManager  ──► onData EventEmitter ──► UI / Agent
                     ──► onStatus EventEmitter ──► UI 状态机
       │
       ▼
   require('serialport') 单例缓存
       │
       ├─ ok → 真实 SerialPort（autoOpen=false）
       │       └─ open() → set(DTR/RTS) → 'data'/'error'/'close'
       │
       └─ fail → VirtualSerialSimulator（透明降级）
```

---

## 2. 现象 → 排查路径速查表

### 2.1 「按钮变 Disconnect 了，但 textarea 全程空白」

> 这是 v0.3.0 hotfix 之前最常见现象。

| 可能原因 | 验证方式 | 解决 |
|---|---|---|
| **autoOpen + listener 注册竞态** | 旧代码 `new SerialPort({path,baudRate})` 默认 `autoOpen:true`，open 事件可能在 `.on('open', ...)` 注册前 fire | v0.3.0 改为 `autoOpen:false` + 显式 `port.open(cb)`，监听器先注册 |
| **设备需要 DTR/RTS 才会启动**（CH340、CP2102、ESP32 USB-CDC 等） | 设备已上电、波特率正确，但任何字节都收不到 | v0.3.0 在 open 后自动 `port.set({dtr:true, rts:true})`；可由 `embedderMonitor.assertControlSignals` 关闭 |
| **本地 banner 都没出现** | `[Embedder Monitor] Connected to ...` 也看不到 | 打开 webview DevTools（命令面板 → `Developer: Open Webview Developer Tools`），`console.debug` 看 `[serialMonitor]` 输出是否有 `onData` 抵达 |
| **webview 折叠瞬间 view 为 undefined** | 数据已写入 ringBuffer 但未到达 UI | v0.3.0 `onData` 始终先入 ringBuffer，`'ready'` 时整体 `restoreHistory` 重放，`bootstrapped` 标志防覆盖 |

### 2.2 「Port 下拉为空 / 只有 VSIM1/2/3」

| 可能原因 | 验证方式 | 解决 |
|---|---|---|
| **打包丢了 serialport 的 hoisted 运行时依赖** | 解包 `.vsix` 检查 `extension/node_modules/node-gyp-build/` 是否存在 | 在 `.vscodeignore` 里 un-ignore `node-gyp-build / debug / ms`（v0.3.0 hotfix 已修） |
| **native serialport 加载失败（ABI 失配）** | 命令 `ACP: Embedder Monitor Diagnostics` 输出 `Native serialport: unavailable` 与具体 error | 重装 `serialport`（`npm rebuild serialport` 或匹配当前 VS Code Electron 的 prebuild），或开启 `embedderMonitor.fallbackToVirtualOnConnectError` |
| **真实端口列表为空** | OS 设备管理器 / `mode` 命令验证设备已识别 | 检查 USB 线 / 驱动；点 `↻ Ports` 刷新 |
| **端口被其它程序占用** | Putty / Arduino IDE / 串口助手 | 先关掉占用方再连接 |

> **快速自检**：解包 vsix 后执行
> ```pwsh
> Expand-Archive .\acp-client-*.vsix -Force -DestinationPath .\_check
> Get-ChildItem .\_check\extension\node_modules\node-gyp-build, .\_check\extension\node_modules\@serialport\bindings-cpp\prebuilds\win32-x64
> ```
> 两者都应存在；缺任意一个都会导致 `require('serialport')` 抛错并退化到 VSIM。

### 2.3 「连接成功但乱码」

| 可能原因 | 解决 |
|---|---|
| 波特率错配 | 选对设备波特率（多数 ESP32 默认 115200） |
| 设备输出非 UTF-8（hex 数据帧） | 当前版本统一按 UTF-8 解码；二进制查看需要后续 hex 模式开关（v0.4.0 计划） |
| 启动时拉低 RTS 触发 reset 反而丢失日志 | 关闭 `embedderMonitor.assertControlSignals` |

### 2.4 「AI Agent 调 acp:serial_connect 没反应」

- `OUTPUT → ACP Traffic` 看 RPC 是否真的送达 Agent / Client
- `OUTPUT → Embedder Monitor` 看 `SerialManager.connect` 是否被调用
- 检查 Agent 实现是否已经实现 `extMethod` 并知道 `acp:serial_*` 自定义协议名

---

## 3. 诊断命令与开关

| 名称 | 类型 | 说明 |
|---|---|---|
| `ACP: Embedder Monitor Diagnostics` | 命令 | 打印当前 mode / 是否原生加载 / 当前端口 / 端口列表 / 平台 / Node 版本 |
| `embedderMonitor.verboseLog` | 配置 | 开启后 OUTPUT → "Embedder Monitor" 会输出 DEBUG（per-event 字节数） |
| `embedderMonitor.assertControlSignals` | 配置 | 默认 `true`；少数设备（如纯 USB-CDC）可关 |
| `embedderMonitor.fallbackToVirtualOnConnectError` | 配置 | 默认 `false`；开启后真实端口 open 失败会自动用虚拟模拟器跑通下游链路 |
| `embedderMonitor.defaultPort` / `defaultBaud` | 配置 | 默认空值（自动选第一个端口）+ 115200 |
| Webview DevTools | 调试 | 命令面板 `Developer: Open Webview Developer Tools`，看 `[serialMonitor]` console.debug |

---

## 4. 常用复现脚本

### 4.1 强制走虚拟模拟器
1. 临时把 `node_modules/serialport` 重命名（断开 require）
2. 重新激活扩展 → mode 自动 = virtual
3. 在 EMBEDDER MONITOR 选 `🟡 VSIM1` → Connect
4. 应该立即看到 `[Virtual Simulator] Booting device... System Ready.`，输入 `help` 验证 echo

### 4.2 验证 ESP32 真实链路
1. USB 接 ESP32（CH340/CP2102）
2. 选 `COM? — USB-SERIAL CH340`、波特率 115200、NL=LF
3. 点 Connect → 1 秒内出现 boot log
4. 输入 `restart` 测试下行命令

### 4.3 验证 ACP Agent 控制
1. 让 Claude/Copilot Agent 连入 ACP
2. Agent 调 `acp:serial_connect` { port: "COM3", baud: 115200 }
3. 看 OUTPUT → "Embedder Monitor" 应有 `connect: opened COM3 (mode=real)` + `DTR/RTS asserted`
4. Agent 调 `acp:serial_write` { data: "AT", newline: "\r\n" }
5. Agent 应通过 `extNotification('acp:serial_data', { data })` 收到回执

---

## 5. 关键代码定位

- 单例 require + 缓存：`@/d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/SerialManager.ts` `getLoadResult()`
- 显式 open + DTR/RTS：`SerialManager.openReal()`
- 状态广播：`SerialManager.onStatus`
- UI 端 ringBuffer + bootstrapped race 修复：`@/d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/ui/SerialMonitorViewProvider.ts` 与 `@/d:/jx_work/AI-Code-vscode/vscode-acp-iot/media/serialMonitor/serialMonitor.js`
- 诊断命令：`@/d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/extension.ts` `acp.serial.diag`

---

## 6. 已知风险

- `port.set({dtr,rts})` 在极少数纯 USB-CDC 设备上可能引发不必要复位 → 由 `assertControlSignals=false` 兜底
- 真实端口 ABI 失配在不同 VS Code Electron 版本之间会反复出现，建议 CI 内固定 `@vscode/test-electron` 版本并在 `npm postinstall` 加 `electron-rebuild` 脚本（计划于 v0.5.0）
- ringBuffer 容量 50000 字符（约 50KB）：长会话最早部分会被截断，是预期行为
