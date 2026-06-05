---
title: "MCP Server 生产实战：鉴权、限流、远程部署与 Registry 落地指南"
date: 2026-06-05
tags: ["MCP", "AI Agent", "基础设施"]
excerpt: "把 MCP Server 从 demo 搬到生产环境，要过鉴权、限流、远程传输、服务发现四道关。本文给出每道关的工程方案、代码示例和踩坑记录。"
emoji: "🔌"
vip: false
draft: false
---

本地跑一个 MCP Server 只需要十行代码——接上 stdio，工具就能被 Agent 调用。但当你要把它开放给团队、部署到远程服务器、接入多个 Client 时，问题才真正开始：谁能调？调多快？怎么注册发现？传输层用什么？

这篇文章解决的就是 **MCP Server 从 demo 到生产** 的四个核心工程问题。

## 生产环境的四道关

| 关卡 | 本地 demo | 生产要求 |
|------|----------|---------|
| 鉴权 | 无，stdio 天然隔离 | OAuth 2.1 / API Key / mTLS |
| 限流 | 无，单用户 | 按 client、按 tool 粒度限流 |
| 传输 | stdio（本地进程） | Streamable HTTP / SSE（远程） |
| 发现 | 手动配 JSON | Registry 自动注册 + 发现 |

下面逐一拆解。

## 鉴权：OAuth 2.1 是官方答案

MCP 规范从 2025-03-26 版本起明确：远程 MCP Server **必须**实现 OAuth 2.1 授权流程。核心流程如下：

```
Client                          MCP Server                    Auth Server
  │                                │                              │
  ├── GET /.well-known/oauth-authorization-server ──────────────▶│
  │◀─────────────── 返回 authorization_server metadata ──────────│
  │                                │                              │
  ├── Authorization Request ──────────────────────────────────────▶│
  │◀─────────────── Authorization Code ───────────────────────────│
  │                                │                              │
  ├── Token Request ──────────────────────────────────────────────▶│
  │◀─────────────── Access Token + Refresh Token ─────────────────│
  │                                │                              │
  ├── MCP Request + Bearer Token ─▶│                              │
  │◀─── Response ─────────────────│                              │
```

用 Python + FastAPI 实现 Bearer Token 校验中间件：

```python
from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware
import httpx

class MCPAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, jwks_url: str, required_scopes: list[str]):
        super().__init__(app)
        self.jwks_url = jwks_url
        self.required_scopes = required_scopes

    async def dispatch(self, request: Request, call_next):
        # MCP 规范：非 MCP 端点不拦截
        if not request.url.path.startswith("/mcp"):
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(401, detail="Missing Bearer token")

        token = auth[7:]
        claims = await self._verify_token(token)

        # 检查 scope
        token_scopes = set(claims.get("scope", "").split())
        if not token_scopes.issuperset(self.required_scopes):
            raise HTTPException(403, detail="Insufficient scope")

        request.state.user = claims.get("sub")
        return await call_next(request)

    async def _verify_token(self, token: str) -> dict:
        """用 JWKS 验证 JWT 签名，生产环境缓存公钥"""
        import jwt as pyjwt
        async with httpx.AsyncClient() as client:
            resp = await client.get(self.jwks_url)
            jwks = resp.json()
        # 简化示例，生产需缓存 + 错误处理
        return pyjwt.decode(token, jwks, algorithms=["RS256"])
```

> **实战建议**：如果你的场景是内部工具（无需三方授权），可以退化为 API Key + HMAC 签名方案，但仍建议走 Bearer Token 格式以保持与 MCP Client 的兼容性。

## 限流：按 Client × Tool 粒度控制

Agent 调用 MCP Tool 的请求模式与人类 API 调用完全不同——一次任务可能在几秒内连续调用同一个 tool 几十次。经典的全局 QPS 限流不够用，需要 **二维限流**：

```python
from dataclasses import dataclass
from redis.asyncio import Redis

@dataclass
class RateLimitRule:
    client_id: str
    tool_name: str
    max_calls: int       # 时间窗口内最大调用次数
    window_seconds: int  # 滑动窗口大小

class ToolRateLimiter:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def check(self, rule: RateLimitRule) -> bool:
        """滑动窗口计数器，返回 True 表示允许通过"""
        import time
        key = f"mcp:ratelimit:{rule.client_id}:{rule.tool_name}"
        now = time.time()
        pipe = self.redis.pipeline()
        # 移除窗口外的请求
        pipe.zremrangebyscore(key, 0, now - rule.window_seconds)
        # 当前窗口内的请求数
        pipe.zcard(key)
        # 添加当前请求
        pipe.zadd(key, {str(now): now})
        pipe.expire(key, rule.window_seconds + 10)
        results = await pipe.execute()
        current_count = results[1]
        return current_count < rule.max_calls
```

生产配置建议：

| Tool 类型 | 限流策略 | 理由 |
|-----------|---------|------|
| 只读查询（search、get） | 60 次/分/client | Agent 探索阶段调用频繁 |
| 写操作（create、update） | 10 次/分/client | 防止 Agent 幻觉导致批量写入 |
| 高成本操作（LLM 调用、外部 API） | 5 次/分/client | 控制下游成本 |

被限流时返回标准 MCP 错误：

```python
{
    "jsonrpc": "2.0",
    "id": "req-123",
    "error": {
        "code": -32029,
        "message": "Rate limit exceeded",
        "data": {"retry_after_seconds": 12}
    }
}
```

## 远程传输：Streamable HTTP 替代 SSE

MCP 规范经历了传输层演进：stdio（本地）→ SSE（远程 v1）→ **Streamable HTTP**（当前推荐）。

Streamable HTTP 的核心设计：

- 单一 HTTP 端点（`POST /mcp`），既接收请求也推送通知
- 普通请求 → 返回 `application/json`
- 需要流式响应 → 返回 `text/event-stream`（SSE）
- Client 通过 `Accept` header 声明能力

```typescript
// TypeScript 实现 Streamable HTTP 服务端（基于 @modelcontextprotocol/sdk）
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

const app = express();
app.use(express.json());

// 会话管理：每个 client 连接一个 transport 实例
const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;

  if (!sessionId && isInitializeRequest(req.body)) {
    // 新会话：创建 transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    const server = new McpServer({ name: "prod-server", version: "1.0.0" });
    // 注册 tools...
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } else {
    // 已有会话：路由到对应 transport
    const transport = sessions.get(sessionId);
    if (!transport) { res.status(404).send("Session not found"); return; }
    await transport.handleRequest(req, res, req.body);
  }
});

app.listen(3000);
```

> **避坑**：Streamable HTTP 的 session 是有状态的。如果部署多实例，需要 sticky session（基于 `Mcp-Session-Id` header）或将 session 状态存入 Redis。

## 服务发现：MCP Registry 模式

当团队有 10+ 个 MCP Server 时，手工维护每个 Client 的 `mcp.json` 配置不现实。Registry 解决的问题：

1. **注册**：Server 启动时上报元数据（名称、端点、tools schema）
2. **发现**：Client 查询 Registry 获取可用 Server 列表
3. **健康检查**：定期探活，自动剔除不可用 Server

一个最小 Registry 的数据模型：

```python
from pydantic import BaseModel
from datetime import datetime

class MCPServerRegistration(BaseModel):
    name: str                          # 唯一标识
    endpoint: str                      # Streamable HTTP 端点
    description: str
    tools: list[dict]                  # Tool schema 快照
    auth_type: str                     # "oauth2" | "api_key" | "none"
    scopes_required: list[str]         # 调用所需 OAuth scope
    registered_at: datetime
    last_heartbeat: datetime
    tags: list[str]                    # 用于分类筛选

class RegistryAPI:
    """Registry 核心接口"""

    async def register(self, server: MCPServerRegistration) -> str:
        """注册或更新 Server，返回 registration_id"""
        ...

    async def discover(
        self, tags: list[str] | None = None, tool_name: str | None = None
    ) -> list[MCPServerRegistration]:
        """按标签或 tool 名称发现 Server"""
        ...

    async def heartbeat(self, name: str) -> bool:
        """心跳续约，超时未续约自动下线"""
        ...
```

Client 侧的 **动态发现 + 缓存** 策略：

```python
class DynamicMCPClient:
    def __init__(self, registry_url: str, cache_ttl: int = 300):
        self.registry_url = registry_url
        self.cache_ttl = cache_ttl
        self._cache: dict[str, MCPServerRegistration] = {}
        self._cache_time: float = 0

    async def get_server(self, tool_name: str) -> MCPServerRegistration:
        """根据 tool 名称找到对应 Server，带本地缓存"""
        import time
        if time.time() - self._cache_time > self.cache_ttl:
            servers = await self._fetch_from_registry()
            self._cache = {t: s for s in servers for t in self._tool_names(s)}
            self._cache_time = time.time()
        return self._cache.get(tool_name)
```

## 部署架构全景

把四道关组合起来，生产级 MCP Server 的部署架构：

```
┌─────────────────────────────────────────────────────────────┐
│                       MCP Client                             │
│  (Claude / GPT / 自研 Agent)                                 │
└────────────────────────────┬────────────────────────────────┘
                             │ Streamable HTTP + Bearer Token
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   API Gateway / Nginx                         │
│  • TLS 终止  • OAuth Token 校验  • 全局限流                    │
└────────────────────────────┬────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ MCP Srv A│   │ MCP Srv B│   │ MCP Srv C│
      │ (DB 查询) │   │ (文件操作) │   │ (外部 API)│
      └─────┬────┘   └─────┬────┘   └─────┬────┘
            │               │               │
            ▼               ▼               ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │  MySQL   │   │  S3/OSS  │   │ 第三方 API│
      └──────────┘   └──────────┘   └──────────┘

              Registry（Consul / 自研）
              • 注册  • 发现  • 健康检查
```

## 落地 Checklist

把 MCP Server 推上生产前，逐项确认：

- [ ] **鉴权**：远程 Server 实现了 OAuth 2.1 或等效 Bearer Token 方案
- [ ] **HTTPS**：所有远程 MCP 通信走 TLS，禁止明文 HTTP
- [ ] **限流**：按 client × tool 粒度配置，写操作更严格
- [ ] **超时**：tool 执行设硬超时（建议 30s），防止 Agent 卡死
- [ ] **传输**：远程场景用 Streamable HTTP，本地开发保留 stdio
- [ ] **会话亲和**：多实例部署时 sticky session 或共享 session store
- [ ] **Registry**：3 个以上 Server 就值得搭建，自动注册 + 健康检查
- [ ] **日志**：每次 tool 调用记录 client_id、tool_name、耗时、结果状态
- [ ] **错误码**：限流 / 鉴权失败返回标准 JSON-RPC error，包含 retry 建议
- [ ] **灰度**：新 Server 先对内部 Agent 开放，观察一周再全量

> 从 stdio 跑通一个 demo 到生产可用，真正的工作量在鉴权和运维。先把鉴权 + 限流做对，其余可以渐进迭代。
