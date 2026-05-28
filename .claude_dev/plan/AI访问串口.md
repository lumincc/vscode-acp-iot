我先梳理一下**现在 ACP / Chat / 串口**三者之间已经打通了哪些链路、还缺什么，然后给你一个下一步实现方案。


# 现状判断

现在**串口核心已经打通了**，但 **Chat 对话层还没真正“可用化”**。

## 已经有的能力

在 [src/core/AcpClientImpl.ts](cci:7://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/AcpClientImpl.ts:0:0-0:0) 里，ACP 自定义接口已经有这 3 个：

- `acp:serial_connect`
- `acp:serial_disconnect`
- `acp:serial_write`

并且串口收到的数据会通过：

- `acp:serial_data`

回推给 agent。

也就是说，**协议半条链已经通了**：

- **Agent -> VS Code**
  - 可调用串口连接/断开/发送
- **VS Code -> Agent**
  - 可推送串口收到的数据

## 还没打通的地方

真正缺的是这两层：

- **[Chat UI 层]**
  - `ChatWebviewProvider` 现在只会 `sendPrompt`
  - 它不会把聊天输入识别成串口命令
  - 也不会把串口数据渲染成 chat 消息

- **[Agent 能力暴露层]**
  - 虽然 [extMethod](cci:1://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/AcpClientImpl.ts:72:2-100:3) 已经实现了
  - 但 agent **不一定知道**应该去调用 `acp:serial_connect/write/...`
  - 所以仅靠自然语言“帮我连 COM7 并发 AT”不一定会触发串口操作

---

# 所以问题本质是什么

不是串口层不行。  
而是：

**ACP 已经有串口接口，但 Chat 还没有“把这些接口变成对话能力”的桥。**

---

# 我建议的下一步方案

我建议分成 **3 层推进**，不要一步做太大。

## Phase 1：补齐 ACP 串口协议
这是最先要做的。

当前只有 connect / disconnect / write，还不够 Chat 真正使用。  
建议补 3 个接口：

- **`acp:serial_list`**
  - 返回当前可用串口列表
- **`acp:serial_status`**
  - 返回当前连接状态、端口、波特率、模式
- **`acp:serial_read_snapshot`**
  - 返回最近 N 行串口缓存，用于 agent “补读”上下文

同时增加 1 个通知：

- **`acp:serial_status_changed`**
  - connected / disconnected / error / connecting

这样 agent 才能先“看见”串口，再决定怎么操作。

## Phase 2：让 Chat 本身能直接驱动串口
这是**最实用**的一层。

不要完全依赖 agent 理解 extMethod，先给 Chat 增加本地命令解释器。  
推荐支持这些 chat 命令：

- **`/serial ports`**
- **`/serial status`**
- **`/serial connect COM7 115200`**
- **`/serial send AT`**
- **`/serial disconnect`**
- **`/serial tail 50`**

实现方式：

- 在 `ChatWebviewProvider.handleSendPrompt()` 里先判断是否是 `/serial`
- 如果是：
  - 不走 `sessionManager.sendPrompt()`
  - 直接调用本地 [SerialManager](cci:2://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/SerialManager.ts:43:0-440:1)
  - 再把结果作为一条 chat message 回显到 chat 面板

这一步的好处：

- **不依赖 agent 能不能懂协议**
- 用户立刻能在 Chat 面板里操作串口
- 风险最低、见效最快

## Phase 3：让 Agent 真正“会用串口”
这是高级能力。

目标是让用户直接在 chat 中说：

- “连接 ESP32 到 115200”
- “发送 `AT+RST`”
- “读取最近 20 行 boot log 并分析异常”

要做到这点，需要给 agent 一份明确的工具契约。比如在 session 启动时注入说明：

- 你可以调用：
  - `acp:serial_list`
  - `acp:serial_status`
  - `acp:serial_connect`
  - `acp:serial_write`
  - `acp:serial_disconnect`
  - `acp:serial_read_snapshot`
- 串口数据会通过：
  - `acp:serial_data`
  - `acp:serial_status_changed`
  返回

否则 agent 只是“看见聊天文本”，但**不知道存在这些扩展接口**。

---

# 推荐实现顺序

我建议按这个顺序做：

## 第一步
**补 ACP 协议**

新增：

- `acp:serial_list`
- `acp:serial_status`
- `acp:serial_read_snapshot`
- `acp:serial_status_changed`

原因：

- 改动集中在 [SerialManager](cci:2://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/SerialManager.ts:43:0-440:1) 和 [AcpClientImpl](cci:2://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/AcpClientImpl.ts:37:0-161:1)
- 对现有 UI 影响小
- 是后续 Chat/Agent 两边共用的基础

## 第二步
**做 Chat 的 `/serial` 本地命令**

原因：

- 最快形成可用能力
- 用户马上可以在 Chat 窗口读写串口
- 不依赖不同 agent 的实现差异

## 第三步
**把 serial 事件映射成 chat message**

比如：

- 连接成功 → 一条 system/tool 消息
- 收到串口数据 → 一条 stream/tool output
- 发送命令 → 一条 tool input

这样 Chat 不只是“能发”，还“看得见串口上下文”。

## 第四步
**再做 agent-aware 的 tool contract**

这一步才是真正“自然语言驱动串口”。

---

# 具体代码落点

## 1. [src/core/SerialManager.ts](cci:7://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/SerialManager.ts:0:0-0:0)
建议新增：

- **`getRecentData(limit?: number)`**
  - 返回最近串口缓存
- **`getStatus()`**
  - 返回当前连接态
- 保持一份最近串口 ring buffer，供 ACP snapshot 使用

## 2. [src/core/AcpClientImpl.ts](cci:7://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/AcpClientImpl.ts:0:0-0:0)
扩展 [extMethod()](cci:1://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/core/AcpClientImpl.ts:72:2-100:3)：

- **`acp:serial_list`**
- **`acp:serial_status`**
- **`acp:serial_read_snapshot`**

并在 `onStatus` 上加：

- **`agent.extNotification('acp:serial_status_changed', ...)`**

## 3. [src/ui/ChatWebviewProvider.ts](cci:7://file:///d:/jx_work/AI-Code-vscode/vscode-acp-iot/src/ui/ChatWebviewProvider.ts:0:0-0:0)
在 `handleSendPrompt()` 前置解析：

- 如果输入以 `/serial` 开头
- 走本地串口命令分支
- 不再发给 agent

## 4. Chat webview 前端
增加：

- tool/system message 渲染
- 可选：串口输出折叠块
- 可选：命令输入辅助按钮

---

# 我最推荐的方案

如果你要一个**投入最小、收益最大**的方案，我推荐：

## 方案 A（推荐）
- **先做 ACP 补接口**
- **再做 Chat `/serial` 命令**
- 暂时**不强依赖 agent 自动理解 extMethod**

这是最稳的。

因为现在真正的问题不是“串口不能用了”，而是：

**串口能力没有被 Chat 层产品化。**

---

# 一句话结论

现在已经有了 **ACP 串口底座**，下一步不是重写串口，而是做一座桥：

- **协议补全**
- **Chat 本地命令**
- **Agent 工具契约**

这三步做完，Chat 才能真正“读取串口 + 输入串口”。

# 建议下一步

我建议你下一步让我直接做：

- **Phase 1：补齐 `acp:serial_list / status / read_snapshot / status_changed`**
- 然后继续做
- **Phase 2：Chat `/serial ...` 命令**

# 状态

**分析完成。**  
如果你同意，我下一条就直接开始实现 **Phase 1 的 ACP 串口补接口**。