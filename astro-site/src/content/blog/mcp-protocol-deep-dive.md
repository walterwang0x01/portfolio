---
title: "MCP 协议深度解析：AI Agent 连接万物的通信标准"
date: 2026-05-05
tags: ["MCP", "AI Agent", "协议"]
excerpt: "MCP 是 AI Agent 连接工具和数据的 USB 接口。从协议架构到 Server 开发，从安全模型到生产部署，一文搞懂 Model Context Protocol 的设计哲学和工程实践。"
vip: false
draft: false
---
你的 AI Agent 很聪明，但它是个"瞎子"——看不到你的数据库、读不了你的文件、调不了你的 API。每次想让它做点实际的事，你就得手动复制粘贴上下文，或者写一堆胶水代码把工具接进去。

这就是 **Model Context Protocol（MCP）**要解决的问题。Anthropic 于 2024 年 11 月开源了这个协议，到 2026 年它已经成为 AI Agent 连接外部世界的事实标准——超过 300 个官方和社区 MCP Server，覆盖数据库、文件系统、API、开发工具等几乎所有场景。

如果说 HTTP 让浏览器能访问任何网站，那 MCP 就是让 AI Agent 能连接任何工具和数据源的通用协议。本文从协议设计哲学到生产级 Server 开发，完整拆解 MCP 的核心机制。

## 为什么需要 MCP？

在 MCP 出现之前，每个 AI 应用要连接外部工具，都需要写定制的集成代码。假设你有 M 个 AI 应用和 N 个工具，就需要 M×N 个集成——这是经典的 N×M 问题：

```
没有 MCP 的世界（M×N 集成）：
┌──────────┐     ┌──────────┐
│ Claude   │────▶│ GitHub   │  定制集成 A
│          │────▶│ Slack    │  定制集成 B
│          │────▶│ Database │  定制集成 C
└──────────┘     └──────────┘
┌──────────┐     ┌──────────┐
│ GPT-4o   │────▶│ GitHub   │  定制集成 D（重复！）
│          │────▶│ Slack    │  定制集成 E（重复！）
└──────────┘     └──────────┘

有 MCP 的世界（M+N 集成）：
┌──────────┐                  ┌──────────┐
│ Claude   │──┐               │ GitHub   │──┐
└──────────┘  │  ┌────────┐  └──────────┘  │
┌──────────┐  ├──│  MCP   │──┐┌──────────┐ │
│ GPT-4o   │──┤  │Protocol│  ├│ Slack    │─┤
└──────────┘  │  └────────┘  │└──────────┘ │
┌──────────┐  │               │┌──────────┐│
│ Kiro     │──┘               └│ Database ││
└──────────┘                   └──────────┘│
                                           │
每个工具只需实现一次 MCP Server ─────────────┘
```

MCP 把 M×N 问题降维为 M+N：每个 AI 应用实现一次 MCP Client，每个工具实现一次 MCP Server，就能互相连接。这和 USB 的设计哲学完全一致——你不需要为每台电脑和每个外设之间设计专用接口。

## MCP 的核心架构

MCP 采用经典的 Client-Server 架构，但有一个关键的设计约束：**Server 是无状态的能力提供者，Client 是有状态的会话管理者**。

```
┌─────────────────────────────────────────────┐
│              MCP Host（宿主应用）              │
│  ┌─────────────────────────────────────┐    │
│  │           MCP Client                 │    │
│  │  ┌───────────────────────────────┐  │    │
│  │  │      Protocol Layer           │  │    │
│  │  │  JSON-RPC 2.0 消息处理         │  │    │
│  │  └───────────────────────────────┘  │    │
│  │  ┌───────────────────────────────┐  │    │
│  │  │      Transport Layer          │  │    │
│  │  │  stdio / SSE / Streamable HTTP│  │    │
│  │  └───────────────────────────────┘  │    │
│  └─────────────────────────────────────┘    │
└──────────────────┬──────────────────────────┘
                   │ JSON-RPC 2.0
┌──────────────────▼──────────────────────────┐
│              MCP Server                      │
│  ┌────────┐  ┌────────┐  ┌────────────┐    │
│  │ Tools  │  │Resources│  │  Prompts   │    │
│  │ 工具    │  │ 资源    │  │  提示模板   │    │
│  └────────┘  └────────┘  └────────────┘    │
└─────────────────────────────────────────────┘
```

三个核心角色：

-   **Host（宿主）**：用户直接交互的应用，如 Kiro、Claude Desktop、Cursor。负责管理 MCP Client 的生命周期
-   **Client（客户端）**：Host 内部的协议实现，与 Server 建立 1:1 连接，处理能力协商和消息路由
-   **Server（服务端）**：暴露具体能力（工具、资源、提示模板）的轻量级进程，每个 Server 专注于一个领域

## 三大核心能力：Tools、Resources、Prompts

MCP Server 通过三种原语向 Client 暴露能力，每种原语有不同的控制语义：

### Tools（工具）：模型主动调用的函数

Tools 是 MCP 最核心的能力——让 LLM 能够执行操作。模型根据工具描述自主决定何时调用、传什么参数：

```
// MCP Server 定义工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "query_database",
    description: "执行 SQL 查询并返回结果。支持 SELECT 语句，禁止 DDL 操作。",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "要执行的 SQL 查询语句（仅支持 SELECT）"
        },
        database: {
          type: "string",
          enum: ["users", "orders", "products"],
          description: "目标数据库名称"
        }
      },
      required: ["sql", "database"]
    }
  }]
}));

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query_database") {
    const { sql, database } = request.params.arguments;
    // 安全检查：只允许 SELECT
    if (!/^SELECT/i.test(sql.trim())) {
      return { content: [{ type: "text", text: "错误：仅支持 SELECT 查询" }] };
    }
    const results = await db.query(sql, database);
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  }
});
```

工具描述的质量直接决定了模型调用的准确性。一个好的工具描述应该包含：做什么、什么时候用、参数含义、限制条件、返回格式。

### Resources（资源）：应用控制的数据暴露

Resources 让 Server 向 Client 暴露结构化数据，但**由应用（而非模型）决定何时读取**。这是和 Tools 的关键区别——Tools 是模型主动调用，Resources 是应用主动拉取：

```
// 暴露项目文件作为资源
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "file:///project/README.md",
      name: "项目说明文档",
      mimeType: "text/markdown",
      description: "项目的 README 文件，包含架构说明和开发指南"
    },
    {
      uri: "db://users/schema",
      name: "用户表结构",
      mimeType: "application/json",
      description: "users 表的完整 Schema 定义"
    }
  ]
}));

// 动态资源模板（URI Template）
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{
    uriTemplate: "db://{database}/{table}/schema",
    name: "数据库表结构",
    description: "获取指定数据库表的 Schema"
  }]
}));
```

Resources 适合暴露配置文件、数据库 Schema、API 文档等**上下文信息**——Agent 在开始任务前先读取这些资源，了解环境和约束。

### Prompts（提示模板）：可复用的交互模式

Prompts 是预定义的提示模板，让用户通过选择模板来触发特定的交互模式：

```
// 定义代码审查提示模板
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{
    name: "code_review",
    description: "对指定文件进行代码审查",
    arguments: [
      { name: "file_path", description: "要审查的文件路径", required: true },
      { name: "focus", description: "审查重点（安全/性能/可读性）", required: false }
    ]
  }]
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name === "code_review") {
    const { file_path, focus } = request.params.arguments;
    return {
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `请对 ${file_path} 进行代码审查。
${focus ? "重点关注：" + focus : "全面审查"}
检查要点：
1. 是否有安全漏洞（SQL 注入、XSS、敏感信息泄露）
2. 错误处理是否完善
3. 命名和代码结构是否清晰
4. 是否有性能问题`
        }
      }]
    };
  }
});
```

## 传输层：从 stdio 到 Streamable HTTP

MCP 支持三种传输方式，适用于不同的部署场景：

-   **stdio**：通过标准输入/输出通信。最简单，适合本地 Server（如 Kiro 中配置的本地 MCP Server）。Host 启动 Server 进程，通过 stdin/stdout 交换 JSON-RPC 消息
-   **SSE（Server-Sent Events）**：基于 HTTP 的流式通信。适合远程 Server，Client 通过 HTTP POST 发送请求，Server 通过 SSE 流推送响应
-   **Streamable HTTP**：2025 年新增的传输方式，结合了 HTTP 的简洁和流式的灵活。支持无状态请求和有状态会话，是远程部署的推荐方案

```
// Kiro 中的 MCP Server 配置示例（stdio 传输）
// .kiro/settings/mcp.json
{
  "mcpServers": {
    "database": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "./data.db"],
      "disabled": false,
      "autoApprove": ["read_query"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
      }
    }
  }
}

// 远程 MCP Server 配置（Streamable HTTP）
{
  "mcpServers": {
    "remote-api": {
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer token-xxx"
      }
    }
  }
}
```

## 开发一个生产级 MCP Server

理论讲完，来写一个真实的 MCP Server。以"项目文档搜索"为例——让 Agent 能语义搜索项目中的 Markdown 文档：

```
// doc-search-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { glob } from "glob";
import { readFile } from "fs/promises";

const server = new Server(
  { name: "doc-search", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_docs",
      description: "在项目文档中搜索包含关键词的内容。返回匹配的文件路径和相关段落。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词或短语" },
          file_pattern: {
            type: "string",
            description: "文件匹配模式，默认 **/*.md",
            default: "**/*.md"
          },
          max_results: {
            type: "number",
            description: "最大返回结果数，默认 5",
            default: 5
          }
        },
        required: ["query"]
      }
    },
    {
      name: "list_docs",
      description: "列出项目中所有文档文件及其标题",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "搜索目录，默认项目根目录" }
        }
      }
    }
  ]
}));

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "search_docs") {
    const { query, file_pattern = "**/*.md", max_results = 5 } = args;
    const files = await glob(file_pattern, { ignore: "node_modules/**" });
    const results = [];

    for (const file of files) {
      const content = await readFile(file, "utf-8");
      if (content.toLowerCase().includes(query.toLowerCase())) {
        // 提取包含关键词的段落
        const paragraphs = content.split("\n\n");
        const matched = paragraphs
          .filter(p => p.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 2)
          .join("\n\n");
        results.push({ file, excerpt: matched.slice(0, 500) });
      }
      if (results.length >= max_results) break;
    }

    return {
      content: [{
        type: "text",
        text: results.length > 0
          ? results.map(r => `📄 ${r.file}\n${r.excerpt}`).join("\n\n---\n\n")
          : `未找到包含 "${query}" 的文档`
      }]
    };
  }

  if (name === "list_docs") {
    const dir = args?.directory || ".";
    const files = await glob(`${dir}/**/*.md`, { ignore: "node_modules/**" });
    const docs = await Promise.all(files.map(async (f) => {
      const content = await readFile(f, "utf-8");
      const title = content.match(/^#\s+(.+)/m)?.[1] || "(无标题)";
      return `- ${f}: ${title}`;
    }));
    return { content: [{ type: "text", text: docs.join("\n") }] };
  }
});

// 启动 Server
const transport = new StdioServerTransport();
await server.connect(transport);
```

配置到 Kiro 中使用：

```
// .kiro/settings/mcp.json
{
  "mcpServers": {
    "doc-search": {
      "command": "npx",
      "args": ["tsx", "./tools/doc-search-server.ts"],
      "autoApprove": ["search_docs", "list_docs"]
    }
  }
}
```

## MCP 的安全模型：信任边界与权限控制

MCP 的安全设计基于一个核心原则：**Server 不应该被无条件信任**。协议定义了清晰的信任边界：

```
信任层次：
┌─────────────────────────────────────┐
│  用户（最高信任）                      │
│  ├── Host 应用（用户信任的应用）       │
│  │   ├── MCP Client（Host 内部）     │
│  │   │   └── MCP Server（受限信任）   │
│  │   │       └── 外部服务（最低信任）  │
└─────────────────────────────────────┘

安全原则：
1. Server 不能访问 Client 未明确授权的资源
2. 工具调用需要用户确认（或预配置 autoApprove）
3. Server 之间相互隔离，不能直接通信
4. 敏感操作（写入、删除）必须有明确的用户授权
```

生产环境中的安全实践：

-   **最小权限原则**：每个 Server 只暴露完成其职责所需的最少工具。数据库 Server 只暴露查询，不暴露 DDL
-   **输入验证**：Server 端必须验证所有输入参数，不能信任 Client 传来的数据。SQL 注入、路径遍历等攻击在 MCP 场景中同样存在
-   **autoApprove 谨慎使用**：只对只读、无副作用的工具启用自动批准。写入操作应该保留用户确认
-   **环境变量隔离**：API Key 等敏感信息通过 `env` 配置传入，不要硬编码在 Server 代码中
-   **OAuth 2.1 认证**：远程 MCP Server 应使用 OAuth 2.1 进行身份验证，支持动态客户端注册和 PKCE 流程

## MCP 生态现状：2026 年的版图

MCP 的生态在 2026 年已经相当成熟。几个关键数据点：

-   **官方 Server**：Anthropic 维护的参考实现覆盖 GitHub、GitLab、Slack、Google Drive、PostgreSQL、SQLite、Puppeteer 等 20+ 服务
-   **社区 Server**：300+ 社区贡献的 Server，覆盖 AWS、Azure、Notion、Linear、Jira、Figma 等几乎所有主流工具
-   **SDK 支持**：官方 SDK 覆盖 TypeScript、Python、Java、Kotlin、C#，社区 SDK 覆盖 Go、Rust、Swift、Ruby
-   **Host 支持**：Claude Desktop、Kiro、Cursor、Windsurf、Cline、Continue 等主流 AI 开发工具全部支持 MCP

MCP 的治理也在走向标准化。2025 年底 Anthropic 将 MCP 规范提交给标准化组织，2026 年多个大厂（Google、Microsoft、AWS）加入了 MCP 的治理委员会。协议版本从 2024-11-05 演进到 2025-06-18，新增了 Streamable HTTP 传输、OAuth 2.1 认证、Elicitation（Server 主动向用户提问）等关键特性。

## MCP vs Function Calling：什么时候用哪个？

一个常见的困惑：MCP 和 OpenAI 的 Function Calling 有什么区别？什么时候该用哪个？

```
Function Calling（模型原生能力）：
├── 定义在 API 请求中，每次调用都要传
├── 工具定义和执行逻辑耦合在应用代码中
├── 适合：应用内部的业务逻辑封装
└── 局限：不可复用，换个应用要重写

MCP（标准化协议）：
├── 工具定义在独立的 Server 中
├── 一次实现，所有支持 MCP 的 Host 都能用
├── 适合：通用工具和数据源的标准化接入
└── 优势：生态复用，社区共建

实际选择：
- 业务特定逻辑（如"计算订单折扣"）→ Function Calling
- 通用工具接入（如"查 GitHub PR"）→ MCP Server
- 两者可以共存：MCP 提供基础工具，Function Calling 封装业务逻辑
```

简单来说：**MCP 是基础设施层的标准化，Function Calling 是应用层的灵活定制**。大多数生产系统会同时使用两者。

## 生产部署最佳实践

把 MCP Server 从开发环境搬到生产环境，需要关注这些工程问题：

1.  **错误处理要完善**：Server 崩溃不能影响 Host 应用。实现 graceful shutdown，捕获所有未处理异常，返回结构化错误信息而非堆栈跟踪
2.  **超时必须设置**：工具调用可能涉及外部 API，必须设置合理的超时。建议：数据库查询 5s，HTTP 请求 10s，文件操作 30s
3.  **日志和监控**：记录每次工具调用的输入、输出、耗时、错误。这是调试 Agent 行为的关键数据源
4.  **版本管理**：Server 的工具定义变更可能影响 Agent 行为。使用语义化版本号，重大变更时通知用户
5.  **资源限制**：限制单次工具调用的返回数据量（建议 < 100KB），避免撑爆 Agent 的上下文窗口
6.  **幂等性**：写入类工具应该设计为幂等操作，Agent 重试时不会产生副作用

## MCP 的未来：从工具连接到 Agent 操作系统

MCP 当前解决的是"Agent 怎么调用工具"的问题，但它的野心远不止于此。从协议演进路线可以看到几个方向：

-   **Elicitation**：Server 可以主动向用户提问，实现更复杂的交互流程（如 OAuth 授权流）
-   **Sampling**：Server 可以请求 Client 进行 LLM 推理，实现 Agent 嵌套调用
-   **Registry**：标准化的 Server 注册和发现机制，让 Agent 能自动发现可用的工具
-   **与 A2A 协同**：MCP 负责 Agent-to-Tool，A2A 负责 Agent-to-Agent，两者组合覆盖 Agent 的全部通信需求

长远来看，MCP 正在演变为 **Agent 操作系统的系统调用层**——就像 POSIX 定义了程序与操作系统的接口，MCP 定义了 Agent 与外部世界的接口。当这个接口足够成熟和标准化，Agent 的能力边界将不再受限于单个应用的集成工作量。

## 写在最后

MCP 的价值不在于它有多复杂——恰恰相反，它的设计哲学是**极致的简洁**。JSON-RPC 2.0 消息格式、三种清晰的能力原语（Tools/Resources/Prompts）、灵活的传输层选择，这些设计让任何开发者都能在一天内写出一个可用的 MCP Server。

如果你正在构建 AI Agent 应用，MCP 应该是你的第一选择——不是因为它完美，而是因为它是当前生态最大、支持最广、演进最快的 Agent 工具连接标准。先用社区现成的 Server 快速验证想法，再根据业务需求开发自定义 Server，这是最务实的路径。

> 本文内容基于 [tech-learning-and-projects](https://github.com/walterwang0x01/tech-learning-and-projects) 仓库中的 MCP 协议学习笔记，结合 Anthropic 官方文档和社区最佳实践总结。仓库中还有 MCP Server 开发模板和配置示例，欢迎参考。
