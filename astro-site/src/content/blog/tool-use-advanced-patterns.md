---
title: "Tool Use 高级模式：从单工具调用到生产级编排"
date: 2026-05-19
tags: ["Function Calling", "工程化", "AI Agent"]
excerpt: "Function Calling 入门只用半小时，生产化要踩半年坑。并行调用、Schema 设计、错误重试、Token 预算——这是真正决定 Agent 能不能上线的工程细节。"
vip: false
draft: false
emoji: "🛠️"
---

教程里的 Function Calling 只展示一种场景：用户问天气，LLM 调用 `get_weather`，返回结果，结束。但生产系统里你会遇到完全不同的情况：用户问"对比北京和上海未来三天天气"，LLM 应该一次发起 6 个并行调用，而不是串行 6 轮；用户问完天气又问机票，LLM 在工具结果里看到"API 限流"，要懂得退避重试而不是直接抛错。

这些问题入门教程不会讲，但它们决定了你的 Agent 能不能真的上线。本文聚焦 2026 年 Tool Use 的生产级模式：并行编排、Schema 设计陷阱、错误恢复、Token 预算控制。

## 并行调用：不只是性能优化

OpenAI、Anthropic、Gemini 都已支持 **parallel tool calling**——一次 LLM 响应里返回多个 tool_use block，应用并发执行后把所有结果拼回去。这不只是性能问题，更是模型行为问题。

```python
# 错误：串行调用，3 次往返
async def serial_query(user_q: str):
    msg = [{"role": "user", "content": user_q}]
    for _ in range(3):
        resp = await client.messages.create(model="claude-opus-4", messages=msg, tools=TOOLS)
        if resp.stop_reason != "tool_use":
            return resp.content[0].text
        # 一次只处理一个 tool_use，串行
        tool_use = next(b for b in resp.content if b.type == "tool_use")
        result = await execute_tool(tool_use)
        msg.append({"role": "assistant", "content": resp.content})
        msg.append({"role": "user", "content": [{"type": "tool_result",
                    "tool_use_id": tool_use.id, "content": result}]})

# 正确：并行执行同一轮内的所有 tool_use
async def parallel_query(user_q: str):
    msg = [{"role": "user", "content": user_q}]
    while True:
        resp = await client.messages.create(model="claude-opus-4", messages=msg, tools=TOOLS)
        if resp.stop_reason != "tool_use":
            return resp.content[0].text
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        # asyncio.gather 并发执行
        results = await asyncio.gather(*[execute_tool(t) for t in tool_uses])
        msg.append({"role": "assistant", "content": resp.content})
        msg.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": t.id, "content": r}
            for t, r in zip(tool_uses, results)
        ]})
```

实测在多城市天气、批量查询、扇形 RAG 检索这类任务上，并行能把端到端延迟从 12 秒压到 3 秒。但有个反直觉的点：**禁用并行有时反而更稳定**。OpenAI API 提供 `parallel_tool_calls: false`，因为某些场景下 LLM 会过度并行——比如它把"先查用户再下单"拆成两个并行调用，而下单本来需要先拿到用户的会员等级。

经验法则：

- 工具之间**无依赖**（多城市查询、批量翻译、并行检索）→ 开启并行
- 工具之间**有数据流**（先查 ID 再查详情）→ 关闭并行或用 prompt 明确串行约束
- 工具会**改变状态**（写数据库、发邮件、转账）→ 强制关闭，避免双花

## Schema 设计：让模型一次答对

工具 Schema 是 LLM 的"使用说明书"。Schema 写得好，模型能一次给对参数；写得差，你会陷入参数缺失、类型错误、枚举写错的死循环。

**反例**：

```json
{
  "name": "search",
  "description": "搜索",
  "parameters": {
    "type": "object",
    "properties": {
      "q": {"type": "string"},
      "type": {"type": "string"},
      "limit": {"type": "integer"}
    }
  }
}
```

`q` 是什么？`type` 有哪些枚举？`limit` 默认值多少？模型只能猜。猜错就是错误重试，重试就是 Token 成本。

**正例**：

```json
{
  "name": "search_documents",
  "description": "在知识库中搜索文档。仅当用户明确要求查找资料、检索内容或回答需要外部知识时调用；闲聊、追问已有内容时不要调用。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "搜索关键词，使用用户原始语言。中文搜索请保留专有名词。"
      },
      "doc_type": {
        "type": "string",
        "enum": ["pdf", "markdown", "code", "all"],
        "default": "all",
        "description": "限定文档类型。不确定时用 all。"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20,
        "default": 5,
        "description": "返回结果数。一般问题 5 个足够，需要全面对比时用 10-20。"
      }
    },
    "required": ["query"]
  }
}
```

Schema 设计 5 条铁律：

1. **description 要说"什么时候用"和"什么时候不用"**，不只是"是什么"
2. **每个 enum 都要给出选择条件**，不要只列名字
3. **default 写在 description 里**，多数模型不会读 JSON Schema 的 `default` 字段
4. **数值字段给 minimum/maximum**，能减少幻觉值
5. **互斥参数用 oneOf 而不是堆在 description**，模型对结构化约束的遵守度高于自然语言

## 错误恢复：让 Agent 学会自救

生产环境里工具调用失败是常态：API 限流、超时、参数错误、依赖服务挂了。处理策略分三层。

### 层 1：协议层重试

幂等的读操作直接重试，不让 LLM 知道：

```python
@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
async def execute_idempotent_tool(tool_call):
    return await tool_registry.run(tool_call.name, tool_call.input)
```

### 层 2：把错误喂给 LLM 让它修

参数错误、业务校验失败这类，让 LLM 看到错误并自我纠正：

```python
try:
    result = await execute_tool(tool_call)
    content = json.dumps(result)
    is_error = False
except ValidationError as e:
    content = f"参数错误：{e.message}。请检查参数格式后重试。"
    is_error = True
except RateLimitError:
    content = "服务限流，请稍后重试，建议等待 5 秒后再调用。"
    is_error = True

msg.append({"role": "user", "content": [{
    "type": "tool_result",
    "tool_use_id": tool_call.id,
    "content": content,
    "is_error": is_error,
}]})
```

注意 Anthropic 的 `is_error: true` 字段——它会让模型在后续推理时把这次调用当作失败案例，避免相同参数原地重试。OpenAI 没这个字段，但你可以在 content 里写 `[ERROR]` 前缀达到类似效果。

### 层 3：熔断与降级

同一个工具连续失败 N 次，应用层应该跳出循环，要么 fallback 到备用工具，要么直接告诉用户失败原因。**永远要给 Agent loop 设一个最大轮次上限**，否则模型会陷入"调用失败 → 换参数 → 再失败"的死循环烧光预算。

## 错误处理策略对比

| 错误类型 | 处理层 | 示例 | LLM 是否感知 |
|---------|-------|------|------------|
| 网络抖动、5xx | 协议层 | API 超时 | 否 |
| 限流（短时） | 协议层 + 退避 | 429 Too Many Requests | 否（自动等待） |
| 限流（长时） | 喂给 LLM | 配额耗尽 | 是，让它选备用工具 |
| 参数校验失败 | 喂给 LLM | 缺字段、枚举错 | 是，让它纠正 |
| 业务规则失败 | 喂给 LLM | 余额不足 | 是，触发新逻辑 |
| 工具不存在 | 应用层修复 | Schema 漂移 | 否，直接报错 |
| 连续失败 N 次 | 熔断 | Loop 死循环 | 是，明确告知放弃 |

## Token 预算：别让工具吃光上下文

最容易被忽视的成本黑洞：工具结果体积。一次 SQL 查询返回 50 行 JSON，看起来没什么；连续 10 轮 tool_use 后，对话历史能膨胀到 50K token。每多一轮，前面所有结果都要重传一次。

三个实战技巧：

**1. 工具内做截断和摘要**：

```python
def search_documents(query: str, limit: int = 5):
    results = vector_store.search(query, k=limit)
    return [{
        "id": r.id,
        "title": r.title,
        "snippet": r.content[:200],  # 截断
        "score": round(r.score, 3),
    } for r in results]
```

**2. 大对象用引用而不是内联**：

```python
# 别这样
def fetch_user_data(user_id: str):
    return {"profile": {...}, "orders": [...300 items...]}  # 50KB

# 这样
def fetch_user_data(user_id: str):
    cache_key = cache.put({"profile": {...}, "orders": [...]})
    return {
        "summary": "用户共 300 个订单，最近 30 天下单 12 次",
        "data_ref": cache_key,
        "hint": "如需具体订单详情，调用 query_orders(ref, filter)",
    }
```

**3. Prompt Cache 配合工具定义**：把 tools 数组放进 cache_control 段，工具定义部分零成本复用。在 10 轮对话的 Agent 上能省 60% 输入 Token。

## 工具命名与组织

工具数量超过 15 个就开始有"选择困难症"：模型在多个相似工具间犹豫，调用准确率掉 20%+。两个解法：

- **分层工具**（Hierarchical Tools）：先暴露 `list_capabilities` 让 LLM 自查，再动态加载工具子集
- **Tool Namespace**：工具命名带前缀（`db_query`、`db_insert`、`crm_lookup`），description 里强调"所有 db_ 开头的工具操作内部数据库"

Anthropic 在 Claude 3.5 之后正式支持 **tool_choice: "any"** 强制工具调用模式，配合 `disable_parallel_tool_use` 能精确控制路由器型 Agent 的行为，比 prompt 工程稳得多。

## 落地 Checklist

把 Tool Use 做到生产可用，逐项核对：

- [ ] 工具 Schema 的 description 包含"何时用"+"何时不用"
- [ ] 所有 enum 字段在 description 里说明每个值的选择条件
- [ ] 幂等读操作支持协议层自动重试（指数退避）
- [ ] 写操作和有状态操作禁用 parallel_tool_calls
- [ ] 工具错误会通过 is_error 或 [ERROR] 前缀传回 LLM
- [ ] Agent loop 有最大轮次上限（建议 10-15 轮）
- [ ] 单个工具结果做了截断或摘要（建议 < 2K token）
- [ ] 大对象用引用机制，避免反复传输
- [ ] tools 数组接入 Prompt Cache
- [ ] 工具数量 > 10 时考虑分层加载或 namespace
- [ ] 监控埋点：每个工具的成功率、平均延迟、平均 Token 占用

Function Calling 入门只需半小时，工程化要踩半年坑。这些细节单独看都不起眼，叠加起来就是"Demo 能跑"和"生产稳定"的距离。
