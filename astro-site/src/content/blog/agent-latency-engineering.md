---
title: "Agent 延迟工程：把首字时间压到 200ms 的生产打法"
date: 2026-05-29
tags: ["AI Agent", "工程化", "基础设施"]
excerpt: "2026 年 Agent 战场不再卷功能，开始卷延迟。本文拆 TTFT、ITL、E2E 三层指标，把 KV Cache、推测解码、Prefill-Decode 分离、流式工具调用串成一套生产级延迟优化打法，附决策矩阵和可复用代码骨架。"
vip: false
draft: false
emoji: "⚡"
---

2026 年再做一个对话型 Agent 已经没什么稀奇。模型选 Claude 4.5 还是 DeepSeek-V3.5、框架选 LangGraph 还是裸写——这些决策的差异肉眼难辨。真正能把用户留下来的，是另一个被长期低估的指标：**延迟**。

去年还能用「LLM 慢是天生的」搪塞过去。今年不行了。Anthropic 把 Sonnet 的首 token 时间压到 280ms，DeepSeek 在自家模型上做到 150ms，SGLang 让 70B 模型在单卡 H100 上 TTFT 跌破 200ms。用户已经被训练出新的体验阈值——超过 1 秒还没开始流式输出，就觉得「这 Agent 卡了」。

本文拆三层延迟指标，把 KV Cache、推测解码、Prefill-Decode 分离、流式工具调用串成一套生产打法。不是论文综述，是能照抄的工程清单。

## 三层延迟指标：先量化再优化

把延迟当成一个数字看是工程师常犯的错。在 Agent 场景里至少要拆三层：

| 指标 | 含义 | 用户感知 | 主要影响因素 |
|------|------|----------|--------------|
| **TTFT** (Time To First Token) | 从请求发出到第一个 token 返回 | "卡不卡" | prompt 长度、KV Cache 命中、prefill 速度 |
| **ITL** (Inter-Token Latency) | 流式输出每个 token 的间隔 | "顺不顺" | decode 阶段算力、batching 策略 |
| **E2E** (End-to-End) | 任务从开始到完成的总耗时 | "快不快" | 工具调用次数、串并行、思考 token |

不同 Agent 形态对三个指标的敏感度完全不同：

| Agent 类型 | 主指标 | 次要指标 | 主要优化方向 |
|-----------|--------|----------|--------------|
| 对话助手 | TTFT | ITL | Prompt Cache、共享 prefix |
| 推理密集（数学、代码） | E2E | TTFT | Speculative Decoding、思考 token 预算 |
| 工具型 Agent | E2E | TTFT | 并行 tool call、推测调度 |
| 长上下文 RAG | TTFT | E2E | KV Cache 复用、Chunked Prefill |
| 多模态（图像/视频） | TTFT | ITL | Vision encoder 缓存、分辨率分级 |

把这张表贴到设计文档里，先确定要打的是哪个数字，再讨论怎么打。模糊地说「我要把 Agent 做快」是没法干活的。

## 第一战场：Prompt 结构与 KV Cache

最便宜、最被忽视的一刀是 prompt 结构。LLM 推理可以把 prompt 的 KV 状态缓存下来，下次相同前缀直接跳过 prefill 阶段。Anthropic、DeepSeek、Google 三家都已默认开启 prefix cache，命中可以让 TTFT 降一个数量级。

要让 cache 命中，必须把**稳定内容放最前面，变化内容放最后面**：

```python
# ❌ 反例：用户消息夹在 system 中间，cache 永远 miss
messages = [
    {"role": "system", "content": f"你是一个客服助手。当前用户：{user_name}"},
    {"role": "user", "content": user_query},
]

# ✅ 正例：稳定 system + 稳定工具定义 + 用户上下文 + 当次输入
SYSTEM_PROMPT = "你是一个客服助手..."  # 全局常量，几千 token

messages = [
    {"role": "system", "content": SYSTEM_PROMPT},
    {"role": "user", "content": f"<context>{user_profile}</context>\n{user_query}"},
]
```

更狠一点，把工具定义、few-shot 示例、知识库片段也按「稳定度」排序。Anthropic 的 cache control 允许显式标记 cache 边界：

```python
response = anthropic.messages.create(
    model="claude-sonnet-4-5",
    system=[
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": TOOL_DEFINITIONS, "cache_control": {"type": "ephemeral"}},
    ],
    messages=messages,
)
```

实测一个 8k token 的客服 system prompt，命中 cache 后 TTFT 从 1.4s 降到 290ms，输入 token 价格也降到 1/10。这是个稳赚的动作，没做就是把钱当垃圾扔。

> 关键结论：Prompt 结构本身就是延迟优化的最大杠杆点。在写任何一行推理优化代码之前，先把 cache 命中率打到 80% 以上。

## 第二战场：推理引擎与解码策略

自托管模型的延迟竞赛集中在三个引擎：vLLM、SGLang、TensorRT-LLM。三家在 2026 年的差异已经从「快不快」变成「在哪种负载下快」：

| 引擎 | 强项 | 弱项 | 适合场景 |
|------|------|------|----------|
| vLLM | 生态成熟、社区大 | Agent 多轮 prefix cache 较弱 | 通用 LLM 服务 |
| SGLang | RadixAttention、structured output | 部署比 vLLM 复杂 | Agent、工具调用密集型 |
| TensorRT-LLM | 极致单机吞吐 | 编译耗时、迭代慢 | 固定模型大规模部署 |

如果你的负载是 Agent（同一 session 反复用相似上下文调模型），SGLang 的 RadixAttention 会自动把多轮对话的公共 prefix 复用，TTFT 经常只剩 vLLM 的 30%。

第二把刀是 **Speculative Decoding（推测解码）**：用一个小模型先猜 N 个 token，大模型一次性验证，命中就省 N-1 次 forward。在代码生成、长文本生成场景命中率能到 70%+，端到端速度提升 2-3 倍。

```python
# vLLM 启用推测解码
from vllm import LLM, SamplingParams

llm = LLM(
    model="meta-llama/Llama-3.3-70B-Instruct",
    speculative_model="meta-llama/Llama-3.2-1B-Instruct",  # 小草稿模型
    num_speculative_tokens=5,
    use_v2_block_manager=True,
)
```

第三把刀是 **Prefill-Decode 分离架构**。Prefill 阶段是计算密集（吃 GPU），Decode 阶段是访存密集（吃显存带宽）。把它们放同一张卡上跑，互相抢资源，整体效率低。2025 年下半年起 DistServe、SGLang Disaggregated 把两个阶段拆到不同节点：

- Prefill 节点：A100/H100，处理长 prompt 的初次计算
- Decode 节点：L40S/A10，专心做 token-by-token 生成

实测在 RAG 这种「输入长、输出短」的负载下，整体吞吐能涨 2.4 倍，TTFT 不变甚至更低。

## 第三战场：工具调用要并行，工具结果要流式

Agent 慢，70% 的时间不是花在 LLM 上，是花在工具上。先看一段最常见的反例：

```python
# ❌ 串行 tool call，时间叠加
async def handle_query(query: str):
    user = await fetch_user(query)         # 200ms
    orders = await fetch_orders(user.id)   # 300ms
    weather = await fetch_weather(user.city)  # 400ms
    return synthesize(user, orders, weather)  # 总计 ~900ms
```

三个工具之间没有依赖（除了 user → orders 和 user → weather 都需要 user），完全可以并行：

```python
# ✅ 并行 + 依赖图调度
import asyncio

async def handle_query(query: str):
    user = await fetch_user(query)  # 200ms
    orders, weather = await asyncio.gather(
        fetch_orders(user.id),
        fetch_weather(user.city),
    )  # max(300, 400) = 400ms
    return synthesize(user, orders, weather)  # 总计 ~600ms
```

更进一步：很多 Agent 框架已经支持**工具调用流式**——LLM 可以一边输出 `<tool_call>` 的 JSON，主程序边解析边发起调用，不必等模型完整返回工具调用块再执行。Anthropic 的 fine-grained tool streaming、OpenAI 的 parallel tool call 都是这个方向。

```typescript
// TypeScript：工具调用流式分发
const stream = await client.messages.stream({
  model: "claude-sonnet-4-5",
  tools: TOOLS,
  messages,
});

const pending = new Map<string, Promise<any>>();

stream.on("inputJson", (chunk, snapshot) => {
  const toolCall = parsePartialToolCall(snapshot);
  if (toolCall && toolCall.complete && !pending.has(toolCall.id)) {
    // 工具调用 JSON 一旦完整，立即发起，不等整个 message 结束
    pending.set(toolCall.id, executeTool(toolCall));
  }
});

await stream.finalMessage();
const results = await Promise.all(pending.values());
```

在调用 3+ 工具的 Agent 任务里，光这一招通常能把 E2E 砍掉 30-40%。

## 第四战场：编排层的推测调度

最反直觉的一招——在用户还没说完之前就开始干活。

举个例子：客服 Agent 收到用户输入，常见流程是「LLM 决定调哪个工具 → 等响应」。但 80% 的客服请求都会触发其中一两个工具（查订单、查物流）。完全可以在 LLM 还在思考时，**先并发预取这两个高频工具的数据**，等 LLM 真选了再用，没选就丢弃：

```python
async def speculative_handler(query: str):
    # 先发起预取
    speculative_tasks = {
        "orders": asyncio.create_task(fetch_recent_orders(query)),
        "shipping": asyncio.create_task(fetch_shipping_status(query)),
    }

    # LLM 同时在思考要调什么工具
    decision = await llm_route(query)

    if decision.tool in speculative_tasks:
        # 命中！直接用预取结果
        result = await speculative_tasks[decision.tool]
    else:
        result = await execute_tool(decision)

    # 取消未命中的预取，避免浪费
    for name, task in speculative_tasks.items():
        if name != decision.tool:
            task.cancel()

    return synthesize(result)
```

这是「用算力换延迟」的典型套路。在请求量不高、单次任务昂贵的客服/法律/医疗 Agent 里非常划算；在高 QPS 场景要小心，预取本身可能把数据库打挂。

## 监控、回归与延迟预算

延迟优化最容易翻车的地方是**改完一时爽，三个月后回归**。Prompt 改个字段、工具加个参数、模型换个版本，TTFT 默默涨 800ms 没人发现。

最低成本的兜底是把延迟当成 SLI 进 CI：

```python
# 简化版延迟回归测试
import pytest, time

CASES = [
    ("订单查询", "查一下我昨天的订单"),
    ("物流追踪", "我的快递到哪了"),
]

@pytest.mark.parametrize("name,query", CASES)
def test_ttft_budget(name, query):
    t0 = time.perf_counter()
    stream = agent.stream(query)
    next(stream)  # 拿到第一个 token
    ttft = (time.perf_counter() - t0) * 1000
    assert ttft < 500, f"{name} TTFT {ttft:.0f}ms 超出预算 500ms"
```

线上要分别打 p50 / p95 / p99 三档。p50 看健康，p95 看 SLA，p99 看极端 case。Langfuse、LangSmith、自建 OTel + Prometheus 都能做，关键是**有人盯**。我见过太多团队接了可观测，但报表没人看，等到用户投诉才发现 p99 已经从 2 秒涨到 12 秒。

## 落地 checklist

回到开头的承诺。如果你只能从这篇文章带走一份清单：

1. 先量化：分别测 TTFT、ITL、E2E，确认要打的数字
2. 重排 prompt：稳定内容前置，命中 prefix cache 到 80%+
3. 选对推理引擎：Agent 负载首选 SGLang，固定大模型选 TensorRT-LLM
4. 长输出场景开 Speculative Decoding，草稿模型选目标的 1/30 大小
5. RAG 场景上 Prefill-Decode 分离
6. 工具调用并行化，能并就别串
7. 启用工具调用流式，让 tool 不阻塞 message
8. 高频路径加推测调度，用算力换延迟
9. 把 TTFT 预算写进 CI，别让回归静默发生
10. p50/p95/p99 三档监控，定期复盘

延迟工程不是高大上的科研，是把这十条踏踏实实跑一遍。做完之后再回头看，你会发现 Agent 的体验提升远比换个更大的模型更有感。
