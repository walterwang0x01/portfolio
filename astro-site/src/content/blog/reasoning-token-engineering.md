---
title: "Reasoning Token 工程：让模型该想的时候想，不该想的时候闭嘴"
date: 2026-05-27
tags: ["Reasoning Model", "工程化", "LLM"]
excerpt: "o3、Claude Extended Thinking、DeepSeek R1 全面普及后，reasoning token 成了账单上最不透明的一块。让简单查询去深思 30 秒、让复杂推理被 budget 强行截断，是 2026 年最常见的两种翻车姿势。这篇讲清楚 thinking budget 怎么定、何时该跳过、怎么和 streaming 结合，以及一个能省 60% reasoning 成本的路由策略。"
emoji: "🧠"
vip: false
draft: false
---

到 2026 年，「让模型先想一会儿再说」已经不是论文里的概念，而是每个 Agent 产品都要面对的工程选择。OpenAI 的 o3 / o4 系列把 reasoning effort 直接做成 API 参数，Anthropic 的 Claude Sonnet 4.5 / Opus 4.5 把 extended thinking 暴露成可调 budget，DeepSeek R1、Qwen3、Gemini 2.5 Thinking 全部跟进。

代价是账单上多了一个之前不存在的字段：**reasoning_tokens**。它既不算 input、也不算 output（但按 output 价格计费），可以一口气吃掉 30k 个 token，把一次本来 $0.01 的请求变成 $0.5。更隐蔽的问题是：**让简单意图分类任务去深思 30 秒**和**给复杂代码 review 只给 1k thinking budget**，这两种翻车你的监控里都看不出来。

## reasoning token 到底是什么

Reasoning token 是模型在产出最终回答之前的内部思考。它不会出现在 `content` 字段里，但会出现在 usage 里，并且按 output 价格收费。

三家主流 API 的接入差别其实挺大：

```python
# OpenAI o3 / o4 系列：用 reasoning.effort
response = openai.responses.create(
    model="o3",
    reasoning={"effort": "high"},   # low / medium / high
    input=[{"role": "user", "content": "证明 √2 是无理数"}],
)
print(response.usage.reasoning_tokens)   # 单独字段

# Anthropic Claude 4.5：用 thinking.budget_tokens
response = anthropic.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=8192,
    thinking={"type": "enabled", "budget_tokens": 10000},
    messages=[{"role": "user", "content": "证明 √2 是无理数"}],
)
# response.content 里会有 type="thinking" 的 block

# DeepSeek R1：默认就开，没法关，但能拿到 reasoning_content
response = deepseek.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "证明 √2 是无理数"}],
)
print(response.choices[0].message.reasoning_content)
```

三家的语义不一样：

| 厂商      | 控制粒度          | 能否完全关闭 | 计费方式               | 是否返回思考过程 |
| --------- | ----------------- | ------------ | ---------------------- | ---------------- |
| OpenAI    | low/medium/high   | 否（用普通模型）| reasoning_tokens 按 output 价 | 默认隐藏，可申请   |
| Anthropic | budget_tokens     | 是（不传字段）| thinking_tokens 按 output 价  | 默认返回           |
| DeepSeek  | 不可控（模型固定） | 否              | reasoning_tokens 按 output 价  | 返回 reasoning_content |
| Gemini    | thinking_budget   | 是（设 0）   | 按 output 价                | 可选返回           |

> Anthropic 和 Gemini 的「设 0 关闭 thinking」是工程上最友好的设计，能在同一个模型上动态决定要不要思考。

## thinking budget 怎么定

最常见的错误是「全局给一个 budget 就完事」。reasoning 的工程价值取决于任务类型，决策矩阵更像下面这样：

| 任务类型                     | 建议 budget    | 用普通模型代价    | 启用 reasoning 收益       |
| ---------------------------- | -------------- | ----------------- | ------------------------- |
| 意图分类、简单 RAG 答复      | 0（关闭）      | 几乎无差          | 浪费 80% 成本             |
| 工具调用 / 单步 Function Call | 0-2k           | 偶尔参数错        | 边际收益小                |
| 多步 Agent 规划              | 4k-8k          | 容易陷入循环      | 显著降低重复调用次数      |
| 代码生成 / 重构              | 8k-16k         | 一次过率 60%      | 一次过率提升到 85%+       |
| 数学 / 形式化推理            | 16k-32k        | 直接答错          | 几乎是必须                |
| 长链路 debug / 根因分析      | 16k-64k        | 给不出结论        | 唯一可行方案              |

实战里更稳的姿势是**让一个轻量分类器决定 budget**：

```python
def decide_thinking_budget(user_query: str, context_size: int) -> int:
    """根据任务复杂度动态决定 thinking budget。"""
    classification = classifier.predict(user_query)   # 用 Haiku / 4o-mini

    if classification.intent in {"chitchat", "lookup", "simple_qa"}:
        return 0
    if classification.intent == "tool_call":
        return 2000
    if classification.intent == "agent_planning":
        return 8000 if context_size < 50_000 else 16_000
    if classification.intent in {"code_gen", "refactor"}:
        return 16_000
    if classification.intent in {"math", "debug", "root_cause"}:
        return 32_000
    return 4000   # 兜底
```

分类器本身用 Haiku 4.5 或 4o-mini，单次成本不到 $0.0005，但能省下平均 60% 的 reasoning 成本。

## reasoning 模型的三个反模式

**反模式一：reasoning 套 reasoning**。在 Agent 编排里让 o3 调一个由 o3 实现的 sub-agent，每一层都开 high effort。一次用户请求触发 5 次 reasoning 调用，单次账单飙到 $3，延迟 90 秒。修法是分层：编排层用 reasoning 模型，工具实现用普通模型。

**反模式二：thinking 当上下文塞回去**。有人把上一轮的 thinking 内容拼到下一轮 messages 里，期望模型「接着想」。Anthropic 文档里专门提醒过：thinking block 在多轮里**只能用 API 提供的 signature 透传**，自己拼接会让模型认为这是用户输入，反而污染推理。

**反模式三：用 reasoning 模型做实时流式聊天**。reasoning 阶段是阻塞的，用户最多看到 30 秒的「正在思考...」。如果产品定位是聊天，要么换模型，要么把 reasoning 隔离到后台 job 里：

```python
# 错：用户对着 chat 框等 30 秒
async def chat_handler(query):
    return await openai.responses.create(
        model="o3", reasoning={"effort": "high"}, input=query
    )

# 对：streaming 立刻给反馈，reasoning 流式展示
async def chat_handler(query):
    stream = await anthropic.messages.stream(
        model="claude-sonnet-4-5",
        thinking={"type": "enabled", "budget_tokens": 8000},
        messages=[{"role": "user", "content": query}],
    )
    async for event in stream:
        if event.type == "content_block_delta":
            if event.delta.type == "thinking_delta":
                yield {"channel": "thinking", "text": event.delta.thinking}
            elif event.delta.type == "text_delta":
                yield {"channel": "answer", "text": event.delta.text}
```

前端把 thinking 渲染成可折叠的灰色区域，answer 走主聊天流。这是 ChatGPT、Claude 桌面端、Cursor 都在用的范式：让用户「看见思考」反而比「等到结果」体验好得多。

## 成本与延迟的 Pareto 工程

reasoning token 在账单上的隐蔽性来自它的**方差**。同样的 prompt，o3 medium effort 可能产出 800 个 reasoning token，也可能产出 8000 个，完全取决于模型对问题难度的内部判断。这意味着传统的「按 token 数估算成本」在 reasoning 场景下会失效。

工程上有三件事必须做：

1. **per-request budget hard cap**：在 API 层强制 `max_thinking_tokens`，避免单次请求失控吃掉一天预算。
2. **reasoning 命中率监控**：记录「启用 reasoning 的请求里，最终答案是否优于不启用」。一个常见的发现是 30%+ 的 reasoning 请求其实没收益，可以下推给路由器关闭。
3. **回退策略**：reasoning 模型超时（>60s）自动降级到非 reasoning 模型，并标记这个 query 进入离线分析队列。

```python
async def call_with_fallback(query, complex_task: bool):
    if not complex_task:
        return await call_haiku(query)

    try:
        return await asyncio.wait_for(
            call_with_reasoning(query, budget=16_000),
            timeout=45,
        )
    except asyncio.TimeoutError:
        log_to_offline_queue(query, reason="reasoning_timeout")
        return await call_sonnet_no_thinking(query)
```

这个模式在生产里能把 P99 延迟从 90s 压到 50s，而代价只是少数极端难题降到普通模型回答。

## reasoning vs 多步 Agent 编排：到底谁取代谁

2026 年最常被问的问题是「既然 reasoning 模型自己会想，那还要不要 multi-step Agent」。短答：**互补，不互斥**。

| 维度       | Reasoning 模型           | Multi-step Agent             |
| ---------- | ------------------------ | ---------------------------- |
| 适合问题    | 闭合的认知任务           | 开放的、需要外部信息的任务  |
| 工具调用    | 单轮内有限               | 天然支持几十轮               |
| 可观测性    | 思考过程黑盒              | 每一步都能 trace             |
| 状态管理    | 无（单次调用）           | 持久化 / 长链路               |
| 失败恢复    | 整个调用重试             | 单步重试 / 回滚              |

复杂的 Agent 系统里两者的关系是：**编排层用 Agent loop 管状态和工具，单点关键决策（plan、code-gen、root-cause）用 reasoning 模型**。把 reasoning 当成 Agent 的「核武器」，只在确实需要的时候按下按钮。

## 落地 checklist

- [ ] reasoning 模型的调用必须经过路由层，不在业务代码里硬编码 model name
- [ ] 每个调用点显式声明 `thinking_budget`，0 也要写明（避免「忘了关」）
- [ ] reasoning 模型一律配 timeout 和 fallback，禁止裸调
- [ ] `reasoning_tokens` 字段进监控大盘，按场景维度看 P50 / P95 / P99
- [ ] 不在用户对话首屏走 reasoning，要么 streaming 展示 thinking，要么放到后台 job
- [ ] thinking 内容不参与下一轮 context（除非 API 明确支持透传 signature）
- [ ] 每月跑一次「reasoning 收益审计」：随机抽 1000 个 reasoning 请求，对照不开 reasoning 的版本看准确率差，差距 < 5% 的场景果断关闭

reasoning model 不是「更聪明的模型」，它是一个**用钱和延迟换质量**的开关。工程上能不能做好，关键不在选哪家，而在能不能在每个调用点回答清楚：这次的钱花得值不值。
