---
title: "A2A 协议实战：让 AI Agent 之间「对话」起来"
date: 2026-04-27
tags: ["A2A", "Agent 协议", "多 Agent"]
excerpt: "MCP 解决了 Agent 连接工具的问题，但 Agent 之间怎么协作？A2A 协议给出了标准答案。这篇文章从协议设计到实战集成，拆解 Agent Card、任务生命周期和安全机制，帮你搞懂多 Agent 协作的通信基础设施。"
vip: false
draft: false
---
你用 MCP 给 Agent 接上了数据库、搜索引擎、日历 API，单个 Agent 已经很能干了。然后产品经理说："能不能让客服 Agent 自动把复杂问题转给技术支持 Agent，技术支持 Agent 再调用运维 Agent 去查日志？"

你发现了一个问题：**MCP 只解决了 Agent 与工具的连接，Agent 与 Agent 之间怎么通信？**

这就是 A2A（Agent-to-Agent）协议要解决的事。Google 于 2025 年提出，2026 年 4 月发布 v1.0 稳定规范，已由 Linux Foundation 托管，150+ 组织支持（含 AWS、Microsoft、Salesforce、SAP）。如果说 MCP 是 Agent 世界的 USB 接口，那 A2A 就是 Agent 世界的 HTTP——让不同厂商、不同框架构建的 Agent 能够互相发现、互相通信、协作完成任务。

## 为什么需要 A2A？MCP 不够吗？

先厘清一个常见困惑：MCP 和 A2A 不是竞争关系，而是互补关系。它们解决的是完全不同层面的问题：

```
MCP（垂直连接）：Agent ↔ 工具/数据
  → Agent 调用数据库、API、文件系统

A2A（水平协作）：Agent ↔ Agent
  → Agent 之间分工协作、委派任务

┌─────────┐  A2A  ┌─────────┐  A2A  ┌─────────┐
│ 客服Agent │◄────►│ 订单Agent │◄────►│ 物流Agent │
└────┬─────┘      └────┬─────┘      └────┬─────┘
     │ MCP             │ MCP             │ MCP
┌────┴─────┐      ┌────┴─────┐      ┌────┴─────┐
│  CRM系统  │      │ 订单数据库 │      │  物流API  │
└──────────┘      └──────────┘      └──────────┘
```

在单 Agent 场景下，MCP 完全够用。但当你的系统需要**多个专业 Agent 协作**时——比如客服系统中客服 Agent 需要调用订单 Agent 查订单、调用物流 Agent 查快递——你需要一个标准化的 Agent 间通信协议。否则每对 Agent 之间都要写定制的集成代码，N 个 Agent 就是 N² 级别的集成工作量。

## A2A 的三个核心概念

A2A 协议围绕三个核心概念设计，理解了它们就理解了整个协议：

### 1\. Agent Card：Agent 的「名片」

每个 A2A Agent 都有一张 Agent Card，放在 `/.well-known/agent.json` 路径下，描述自己是谁、能做什么、怎么认证。其他 Agent 通过读取这张名片来决定是否要与它协作：

```
{
  "name": "Order Processing Agent",
  "description": "处理订单查询、创建和状态更新",
  "url": "https://order-agent.example.com",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    {
      "id": "query_order",
      "name": "查询订单",
      "description": "根据订单号或用户ID查询订单信息",
      "inputSchema": {
        "type": "object",
        "properties": {
          "order_id": { "type": "string" },
          "user_id": { "type": "string" }
        }
      }
    }
  ],
  "authentication": {
    "schemes": ["oauth2", "apiKey"]
  }
}
```

Agent Card 的设计很巧妙——它让 Agent 的能力变得**可发现、可机读**。一个编排 Agent 可以自动扫描多个 Agent Card，根据任务需求选择合适的 Agent 来协作，不需要硬编码任何集成逻辑。v0.3 引入的 Signed Agent Cards 还支持加密签名验证，防止 Agent 身份伪造。

### 2\. Task：有状态的任务生命周期

A2A 的通信单元不是简单的请求-响应，而是一个**有状态的任务（Task）**。任务有完整的生命周期，支持中间交互：

```
任务状态流转：
submitted → working → input-required → working → completed
                                                → failed
                                                → canceled

实际交互流程：

客户端 Agent                    远程 Agent
    │                              │
    │── POST /tasks/send ─────────>│  创建任务
    │<── { status: "working" } ────│
    │                              │  ... 处理中 ...
    │<── { status: "input-required" }│  需要更多信息
    │── POST /tasks/send ─────────>│  补充信息（同一个 taskId）
    │<── { status: "completed",    │
    │     artifacts: [...] } ──────│  返回结果
```

这个设计比简单的 RPC 调用强大得多。`input-required` 状态意味着远程 Agent 可以在执行过程中**主动向调用方要更多信息**——就像人类协作中，同事做到一半发现缺少某个数据，会回来问你要。这让 Agent 间的协作更接近真实的团队协作模式。

### 3\. Artifact：结构化的任务产出

任务完成后，结果以 Artifact（产出物）的形式返回。Artifact 支持多模态内容——文本、结构化数据、文件都可以：

```
{
  "taskId": "task-123",
  "status": "completed",
  "artifacts": [
    {
      "name": "order_details",
      "parts": [
        {
          "type": "text",
          "text": "订单 #12345 已发货，预计 4 月 29 日送达"
        },
        {
          "type": "data",
          "data": {
            "orderId": "12345",
            "status": "shipped",
            "estimatedDelivery": "2026-04-29",
            "trackingNumber": "SF1234567890"
          }
        }
      ]
    }
  ]
}
```

Artifact 的多 Part 设计让调用方可以灵活处理结果：展示给用户时用 `text` 部分，程序处理时用 `data` 部分。这比返回一个纯文本字符串然后再解析要优雅得多。

## A2A vs MCP vs ACP：协议选型

2026 年的 Agent 协议生态已经形成了清晰的分层：

```
| 协议 | 提出方              | 方向          | 核心用途       | 成熟度        |
|------|--------------------|--------------|--------------|--------------| 
| MCP  | Anthropic          | Agent ↔ 工具  | 工具/数据集成   | 高（生态最大）  |
| A2A  | Google→Linux Found.| Agent ↔ Agent | 企业级协作     | 高（v1.0 稳定）|
| ACP  | IBM→Linux Found.   | Agent ↔ Agent | 轻量消息传递   | 中            |
```

选型决策很简单：

-   **Agent 调用工具/数据** → MCP，没有第二选择
-   **企业级多 Agent 协作**（任务管理、流式通信、安全认证）→ A2A
-   **轻量级 Agent 间消息传递**（快速集成、REST 风格）→ ACP
-   **大多数生产场景** → MCP + A2A 组合

ACP 由 IBM 提出，走的是轻量 REST 路线，用 OpenAPI 描述接口，支持 mDNS 本地发现。如果你的场景是内部微服务之间的 Agent 通信，ACP 的集成成本更低。但在企业级场景下，A2A 的任务生命周期管理、Signed Agent Cards 和 gRPC 支持更有优势。

## 实战：用 A2A 构建多 Agent 协作系统

来看一个实际场景：构建一个客服系统，包含三个 Agent——客服 Agent（入口）、订单 Agent（查订单）、物流 Agent（查快递）。

### 第一步：定义 Agent Card

每个 Agent 发布自己的 Agent Card，声明能力：

```
# 订单 Agent 的 Agent Card
# 部署后可通过 https://order-agent.example.com/.well-known/agent.json 访问

order_agent_card = {
    "name": "Order Agent",
    "description": "订单查询与管理",
    "url": "https://order-agent.example.com",
    "skills": [
        {
            "id": "query_order",
            "name": "查询订单",
            "description": "根据订单号查询订单详情和状态",
        },
        {
            "id": "list_orders",
            "name": "订单列表",
            "description": "查询用户的所有订单",
        }
    ],
    "capabilities": {"streaming": True},
    "authentication": {"schemes": ["oauth2"]},
}
```

### 第二步：客服 Agent 发现并调用订单 Agent

```
import httpx

async def delegate_to_order_agent(user_query: str, order_id: str):
    """客服 Agent 委派任务给订单 Agent"""

    # 1. 读取订单 Agent 的 Agent Card（实际场景中会缓存）
    async with httpx.AsyncClient() as client:
        card_resp = await client.get(
            "https://order-agent.example.com/.well-known/agent.json"
        )
        agent_card = card_resp.json()

        # 2. 确认订单 Agent 有 query_order 能力
        has_skill = any(
            s["id"] == "query_order" for s in agent_card["skills"]
        )
        if not has_skill:
            return "订单 Agent 不支持订单查询"

        # 3. 发送 A2A 任务
        task_payload = {
            "jsonrpc": "2.0",
            "method": "tasks/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": f"查询订单 {order_id}"}]
                }
            }
        }
        resp = await client.post(agent_card["url"], json=task_payload)
        result = resp.json()

        # 4. 处理任务结果
        if result["result"]["status"]["state"] == "completed":
            artifacts = result["result"]["artifacts"]
            return artifacts[0]["parts"][0]["text"]
        elif result["result"]["status"]["state"] == "input-required":
            return "订单 Agent 需要更多信息：" + result["result"]["status"]["message"]
```

### 第三步：处理 input-required 交互

A2A 的 `input-required` 状态是它区别于简单 RPC 的关键特性。当远程 Agent 需要更多信息时，客户端 Agent 可以继续在同一个任务上下文中补充：

```
async def handle_input_required(task_id: str, additional_info: str):
    """在同一个任务上下文中补充信息"""
    payload = {
        "jsonrpc": "2.0",
        "method": "tasks/send",
        "params": {
            "id": task_id,  # 复用同一个 taskId
            "message": {
                "role": "user",
                "parts": [{"type": "text", "text": additional_info}]
            }
        }
    }
    # 远程 Agent 在已有上下文基础上继续处理
    resp = await client.post(agent_url, json=payload)
    return resp.json()
```

这种有状态的任务模型让多轮交互变得自然——远程 Agent 不需要每次都从头理解上下文，因为任务状态在服务端持久化了。

## 安全机制：Signed Agent Cards 与零信任

在开放网络中，Agent 间通信面临一个核心安全问题：**你怎么确认对面的 Agent 是它声称的那个？**

A2A v0.3 引入了 Signed Agent Cards 机制，用加密签名验证 Agent 身份：

```
Signed Agent Card 验证流程：

1. Agent B 发布 Agent Card，用私钥签名
2. Agent A 获取 Agent Card
3. Agent A 用 Agent B 的公钥验证签名
4. 签名有效 → 确认 Agent Card 未被篡改
5. 建立安全通信通道

安全层次：
├── 传输层：HTTPS / mTLS
├── 身份层：Signed Agent Cards（加密签名）
├── 认证层：OAuth 2.0 / API Key
└── 授权层：基于 Skill 的细粒度权限控制
```

这套安全机制对企业场景至关重要。想象一下，你的财务 Agent 需要调用外部的税务计算 Agent——你必须确保对方是合法的服务提供商，而不是一个伪装的恶意 Agent。Signed Agent Cards + OAuth 2.0 的组合提供了从身份验证到授权的完整安全链路。

## A2A 与 Agent 框架的集成

A2A 是协议层的标准，具体实现需要与 Agent 框架配合。目前主流框架的集成状态：

-   **LangGraph**：通过 A2A Python SDK 集成，将 LangGraph Agent 包装为 A2A Server，或在图节点中调用远程 A2A Agent
-   **CrewAI**：原生支持 A2A 协议，Crew 中的 Agent 可以通过 A2A 调用外部 Agent
-   **Google ADK**：作为 A2A 的参考实现，提供最完整的协议支持

A2A SDK 已覆盖 5 种语言：Python、JavaScript、Java、Go、.NET。对于大多数团队来说，用 Python SDK 快速搭建原型，验证多 Agent 协作的业务价值，是最务实的起步方式。

## 协议全景：从工具到 Agent 到用户

2026 年的 Agent 协议生态已经形成了完整的三层架构：

```
                         ┌──────────┐
                         │   用户    │
                         └─────┬────┘
                          AG-UI│     ← Agent 与 UI 的通信
                         ┌─────┴────┐
                         │  前端 UI  │
                         └─────┬────┘
                               │
                ┌──────────────┼──────────────┐
                │              │              │
           ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
           │ Agent A  │   │ Agent B │   │ Agent C │
           └────┬────┘   └────┬────┘   └────┬────┘
             A2A│             │A2A           │
                │◄───────────►│              │  ← Agent 间协作
            MCP │          MCP│          MCP │
           ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
           │  Tools   │   │   DB    │   │  API    │  ← Agent 与工具
           └─────────┘   └─────────┘   └─────────┘
```

-   **底层 MCP**：Agent 连接工具和数据（已成熟，生态最大）
-   **中层 A2A/ACP**：Agent 之间协作通信（A2A v1.0 稳定，进入生产）
-   **上层 AG-UI**：Agent 输出展示给用户（新兴方向，CopilotKit 推动）

对于大多数团队，**MCP + A2A** 的组合就能覆盖 90% 的场景。先用 MCP 让单个 Agent 具备工具调用能力，再用 A2A 让多个 Agent 协作起来。

## 落地建议：从单 Agent 到多 Agent 的演进路径

不要一上来就搭多 Agent 系统。推荐的演进路径：

1.  **阶段一：单 Agent + MCP**。先让一个 Agent 通过 MCP 连接必要的工具和数据，验证核心业务价值
2.  **阶段二：识别协作需求**。当单 Agent 的职责变得过于复杂（比如同时处理客服、订单、物流），考虑拆分为多个专业 Agent
3.  **阶段三：引入 A2A**。用 A2A 协议连接多个 Agent，每个 Agent 发布 Agent Card 声明能力，通过任务委派实现协作
4.  **阶段四：安全加固**。启用 Signed Agent Cards、OAuth 2.0 认证、细粒度权限控制，满足生产环境的安全要求

Anthropic 的建议同样适用于协议选型：**从简单开始，仅在必要时增加复杂度**。单 Agent + MCP 能解决的问题，不要急着上 A2A 多 Agent 架构。

## 写在最后

A2A 协议的意义不只是技术标准——它代表了 AI Agent 生态从"单兵作战"向"团队协作"的范式转变。当 Agent 之间有了标准化的通信方式，我们就可以像搭积木一样组合不同厂商、不同框架构建的 Agent，构建真正的 Agent 网络。

2026 年是 A2A 的元年：v1.0 稳定规范发布、Linux Foundation 托管、150+ 组织支持、5 种语言 SDK。如果你正在构建多 Agent 系统，现在是认真了解 A2A 的最佳时机。

> 我的 [GitHub 仓库](https://github.com/walterwang0x01/tech-learning-and-projects) 中有完整的 Agent 协议学习笔记（6 篇），覆盖 MCP、A2A、ACP、ANP、AG-UI 协议全景，以及协议选型指南和实战集成方案。
