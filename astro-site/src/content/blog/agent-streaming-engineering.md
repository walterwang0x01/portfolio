---
title: "Agent Streaming 工程：从 Token 粒度到多 Agent 级联的生产实践"
date: 2025-06-25
tags: ["AI Agent", "工程化", "基础设施"]
excerpt: "流式输出不只是「逐字打印」。本文深入 SSE vs WebSocket 选型、工具调用中间状态传播、多 Agent 级联流式背压管理，给出可落地的生产架构。"
emoji: "🌊"
vip: false
draft: false
---

## 为什么 Agent Streaming 是独立工程问题

传统 LLM 应用的流式输出很简单：模型吐一个 token，前端追加一个字符。但在 Agent 场景下，一次请求可能包含多轮工具调用、子 Agent 委派、长时间异步任务。用户面对的不再是「等 3 秒出结果」，而是「等 30 秒到 3 分钟，中间不知道在干嘛」。

Agent Streaming 要解决三个核心问题：

1. **进度可见性** — 用户能实时看到 Agent 在做什么（思考、调用工具、等待外部 API）
2. **中间状态传播** — 工具调用的部分结果、子 Agent 的中间输出需要实时回传
3. **背压与取消** — 用户随时可能取消，下游慢不能拖垮上游

## 传输协议选型：SSE vs WebSocket vs HTTP Chunked

| 维度 | SSE | WebSocket | HTTP Chunked |
|------|-----|-----------|--------------|
| 方向 | 单向（服务端→客户端） | 双向 | 单向 |
| 浏览器兼容 | 原生支持 | 原生支持 | 需手动处理 |
| 断线重连 | 内置 `Last-Event-ID` | 需自行实现 | 无 |
| 代理/CDN 友好度 | 高（标准 HTTP） | 低（需 Upgrade） | 中 |
| 适合场景 | Agent 输出流 | 实时协作、双向控制 | 简单文件下载 |

**选型建议：90% 的 Agent 场景用 SSE 就够了。** 原因：

- Agent 流本质是服务端单向推送，客户端只需要发送「取消」信号（一个 HTTP abort 即可）
- SSE 天然支持断线重连和事件分类（`event:` 字段）
- 企业防火墙和 CDN 对 SSE 的兼容性远好于 WebSocket

只有当你需要客户端实时发送大量控制信号（如语音 Agent 的音频流）时，才考虑 WebSocket。

## 事件协议设计

定义一套结构化的 SSE 事件类型，是 Agent Streaming 的关键设计决策：

```typescript
// 事件类型枚举
type AgentStreamEvent =
  | { event: "token"; data: { content: string; role: "assistant" } }
  | { event: "tool_call_start"; data: { tool_id: string; name: string; arguments_partial: string } }
  | { event: "tool_call_delta"; data: { tool_id: string; arguments_partial: string } }
  | { event: "tool_result"; data: { tool_id: string; result: unknown; duration_ms: number } }
  | { event: "agent_delegate"; data: { child_agent: string; task: string } }
  | { event: "status"; data: { phase: "thinking" | "acting" | "observing"; message: string } }
  | { event: "done"; data: { usage: { prompt_tokens: number; completion_tokens: number } } }
  | { event: "error"; data: { code: string; message: string; retryable: boolean } }
```

对应的 SSE 报文：

```text
event: status
data: {"phase":"acting","message":"正在调用天气 API..."}

event: tool_call_start
data: {"tool_id":"call_abc","name":"get_weather","arguments_partial":"{\"city\":\""}

event: tool_call_delta
data: {"tool_id":"call_abc","arguments_partial":"北京\"}"}

event: tool_result
data: {"tool_id":"call_abc","result":{"temp":28,"condition":"晴"},"duration_ms":230}

event: token
data: {"content":"北京今天","role":"assistant"}

event: token
data: {"content":"28°C，晴天","role":"assistant"}

event: done
data: {"usage":{"prompt_tokens":1200,"completion_tokens":45}}
```

## 后端实现：Python FastAPI + 异步生成器

```python
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import json
import asyncio
from typing import AsyncGenerator

app = FastAPI()

async def agent_stream(query: str, request: Request) -> AsyncGenerator[str, None]:
    """Agent 流式执行，支持取消检测"""
    
    # 发送状态事件
    yield format_sse("status", {"phase": "thinking", "message": "分析问题中..."})
    
    async for chunk in llm_client.stream_chat(query):
        # 检测客户端是否断开（背压管理的核心）
        if await request.is_disconnected():
            break
        
        if chunk.type == "text_delta":
            yield format_sse("token", {"content": chunk.text, "role": "assistant"})
        
        elif chunk.type == "tool_use_start":
            yield format_sse("tool_call_start", {
                "tool_id": chunk.tool_id,
                "name": chunk.tool_name,
                "arguments_partial": ""
            })
        
        elif chunk.type == "tool_use_delta":
            yield format_sse("tool_call_delta", {
                "tool_id": chunk.tool_id,
                "arguments_partial": chunk.partial_json
            })
        
        elif chunk.type == "tool_use_end":
            # 执行工具并流式返回结果
            yield format_sse("status", {"phase": "acting", "message": f"执行 {chunk.tool_name}..."})
            result = await execute_tool(chunk.tool_name, chunk.arguments)
            yield format_sse("tool_result", {
                "tool_id": chunk.tool_id,
                "result": result,
                "duration_ms": chunk.duration_ms
            })
    
    yield format_sse("done", {"usage": chunk.usage.dict()})


def format_sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/agent/stream")
async def stream_endpoint(request: Request):
    body = await request.json()
    return StreamingResponse(
        agent_stream(body["query"], request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # 禁用 Nginx 缓冲
        }
    )
```

## 前端消费：TypeScript EventSource 封装

```typescript
class AgentStreamClient {
  private controller: AbortController | null = null;

  async *stream(query: string): AsyncGenerator<AgentStreamEvent> {
    this.controller = new AbortController();
    
    const response = await fetch("/api/agent/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: this.controller.signal,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const block of lines) {
        if (!block.trim()) continue;
        const eventMatch = block.match(/^event: (.+)$/m);
        const dataMatch = block.match(/^data: (.+)$/m);
        if (eventMatch && dataMatch) {
          yield {
            event: eventMatch[1],
            data: JSON.parse(dataMatch[1]),
          } as AgentStreamEvent;
        }
      }
    }
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
}
```

## 多 Agent 级联流式：背压与合并

当 Agent A 委派子任务给 Agent B，B 又调用 Agent C 时，流式传播面临两个挑战：

1. **事件合并** — 子 Agent 的事件需要加上 `source` 标识，前端才能分区展示
2. **背压传播** — 如果前端消费慢（或用户取消），信号必须传播到最深层 Agent

```python
async def cascade_stream(
    parent_request: Request,
    child_streams: list[AsyncGenerator]
) -> AsyncGenerator[str, None]:
    """合并多个子 Agent 流，传播取消信号"""
    
    async def wrap_child(stream: AsyncGenerator, source: str):
        async for event in stream:
            if await parent_request.is_disconnected():
                await stream.aclose()  # 传播取消
                return
            # 给事件打上来源标签
            enriched = {**event, "source": source}
            yield format_sse(event["type"], enriched)
    
    # 并发消费所有子流
    merged = merge_async_generators([
        wrap_child(s, f"agent_{i}") for i, s in enumerate(child_streams)
    ])
    
    async for sse_chunk in merged:
        yield sse_chunk
```

## 生产环境 Checklist

| 关注点 | 做法 |
|--------|------|
| Nginx/ALB 缓冲 | 设置 `X-Accel-Buffering: no` + `proxy_buffering off` |
| 连接超时 | SSE 每 15s 发送 `:keepalive\n\n` 注释帧 |
| 断线重连 | 服务端维护 `event_id`，客户端 `Last-Event-ID` 头恢复 |
| 内存泄漏 | 客户端断开时确保 generator 被 `aclose()` |
| 可观测性 | 每个事件带 `trace_id`，链路追踪贯穿到子 Agent |
| 限流 | 按用户限制并发 SSE 连接数（建议 ≤3） |
| 前端渲染性能 | Token 事件做 16ms debounce 批量 DOM 更新 |

## 选型决策矩阵

- **简单聊天（单轮 LLM）** → 直接用 OpenAI SDK 的 `stream=True`，不需要自建
- **单 Agent + 工具调用** → SSE + 结构化事件协议，本文方案直接套用
- **多 Agent 编排** → SSE + 事件 source 标识 + 背压传播，需要 merge 层
- **语音/视频 Agent** → WebSocket（双向流），参考 OpenAI Realtime API 协议
- **超长任务（>5min）** → SSE 改为轮询 + WebSocket 通知混合模式，避免连接被中间件杀掉

流式不是可选的 UX 糖霜，而是 Agent 产品的核心基础设施。把事件协议设计好，背压管理做对，后续不管加多少 Agent 层级，流式体验都能平滑扩展。
