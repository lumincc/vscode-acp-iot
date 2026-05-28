# vscode-acp-iot 代码地图与结构分析

本文件说明了 `vscode-acp-iot` 的核心目录结构、重要模块职责以及本次 v0.3.0 串口集成中需要新增/修改的文件定位。

---

## 1. 核心代码目录与职责

```
vscode-acp-iot/
├── resources/                  # 静态资源（插件图标、面板图标）
├── src/
│   ├── config/                 # 客户端与 Registry 配置
│   │   ├── AgentConfig.ts      # 读取和设置 ACP Agents 配置
│   │   └── RegistryClient.ts   # 获取官方可用的 Agent 列表
│   ├── core/                   # 核心服务逻辑 (ACP 连接与会话管理)
│   │   ├── AcpClientImpl.ts    # ACP 客户端端点接口实现 [重要修改]
│   │   ├── AgentManager.ts     # 管理所有本地配置好的 Agent
│   │   ├── ConnectionManager.ts# 管理底层 StdIO 与 NDJSON 连接建立 [重要修改]
│   │   ├── SessionHistoryStore.ts # 本地会话缓存和持久化
│   │   ├── SessionManager.ts   # 活跃会话状态协调中心
│   │   └── SerialManager.ts    # [新增] 底层串口及物理/虚拟仿真器管理
│   ├── handlers/               # ACP 标准能力的处理程序 (FS, Terminal等)
│   │   ├── FileSystemHandler.ts# 响应 Agent 读取/写入本地文件请求
│   │   ├── PermissionHandler.ts# 响应用户确认/授权工具调用弹窗
│   │   └── TerminalHandler.ts  # 响应 Agent 终端开启与命令执行控制
│   ├── ui/                     # 插件前端 UI 模块
│   │   ├── ChatWebviewProvider.ts # AI 会话侧边栏 Webview 实现
│   │   ├── SessionTreeProvider.ts # 侧边栏 Agent 列表和会话管理树状图
│   │   ├── StatusBarManager.ts    # 状态栏图标与快速断连菜单
│   │   └── SerialMonitorViewProvider.ts # [新增] EMBEDDER MONITOR 侧边栏 Webview 桥梁
│   ├── utils/                  # 通用工具
│   │   ├── Logger.ts           # 流量日志和输出面板通道
│   │   └── TelemetryManager.ts # 遥测事件报告
│   ├── extension.ts            # 插件入口激活函数 [重要修改]
│   └── webpack.config.js       # 构建打包配置
└── media/                      # 静态资源文件 [新增子目录]
    └── serialMonitor/          # [新增] 串口监控 Webview 前端 HTML/CSS/JS 资源
```

---

## 2. 核心调用关系与数据流

### A. 物理/模拟串口 -> Webview 与 Agent 数据分发流
```
[SerialPort / VirtualSimulator]
             │ (物理/模拟数据输入)
             ▼
      [SerialManager] (广播 onData 事件)
       /          \
      /            \
     ▼              ▼
[SerialMonitorViewProvider]     [AcpClientImpl]
     │ (postMessage)                │ (extNotification)
     ▼                              ▼
[Webview View Front]          [Active AI Agent]
(渲染串口日志文本)            (流式解析硬件反馈，如判定回复 OK)
```

### B. Agent 控制硬件数据下发流
```
[AI Agent]
    │ (自定义 extension call: acp:serial_write)
    ▼
[AcpClientImpl] (接收 extMethod 并调度)
    │
    ▼
[SerialManager] (调用 send 方法)
    │
    ▼
[SerialPort / VirtualSimulator]
    │
    ▼ (物理信号/模拟仿真控制)
[嵌入式硬件板卡]
```

---

## 3. v0.3.0 重点变更单 (Planned Changes List)

| 变更文件 | 类型 | 职责说明 |
| :--- | :--- | :--- |
| `package.json` | 修改 | 添加 `serialport` 依赖，注册 `embedder-monitor` 视图和 `acp:serial_*` 命令配置。 |
| `webpack.config.js` | 修改 | 将 `serialport` 声明为 `externals`，防止 VS Code 插件构建时尝试打包 Node.js C++ 二进制扩展引发崩溃。 |
| `src/core/SerialManager.ts` | **新增** | 封装串口生命周期，内置 `VirtualSerialSimulator` 动态兼容，支持平台无关的物理/虚拟无缝切换。 |
| `src/ui/SerialMonitorViewProvider.ts` | **新增** | 实现侧边栏 Webview 逻辑，负责向 `media/` 下对应的 HTML/JS/CSS 资源注入安全 nonce。 |
| `media/serialMonitor/*` | **新增** | 包含复刻自图片中 EMBEDDER MONITOR 布局的 HTML 模板、VS Code 原生暗黑风格 CSS、以及两way消息同步 JS。 |
| `src/core/AcpClientImpl.ts` | 修改 | 实现 `extMethod` 和 `extNotification`，将 Agent 自定义调用桥接到 `SerialManager`，建立 AI Agent 与物理硬件的通道。 |
| `src/core/ConnectionManager.ts` | 修改 | 为 `AcpClientImpl` 的初始化工厂注入共享的 `SerialManager` 实例。 |
| `src/extension.ts` | 修改 | 实例化 `SerialManager` 并注册 `SerialMonitorViewProvider` 视图。 |
