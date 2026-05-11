---
title: "Agent 成本工程：从月烧 $50k 到省 80% 的五把武器"
date: 2026-05-11
tags: ["AI Agent", "工程化", "LLM"]
excerpt: "同样的 Agent 产品，有的团队月账单 $50k，有的团队做到 $10k。差距不在流量，在成本工程。Prompt Cache、模型降级、Token 预算、上下文压缩、Batch API 五把武器全部打开，省 80% 不是梦。"
emoji: "💰"
vip: false
draft: false
---

2026 年的 AI Agent 产品，定价战已经进入深水区。你的竞品把订阅价砍到每月 $9.9，但你的 token 成本就占 $6。你翻开账单一看：用户一次对话平均 8 轮，每轮塞进去 12k tokens 的上下文，调的还是 Claude Sonnet 4.5——每次对话硬成本 $0.3，活跃用户一个月调 50 次，光 LLM 成本就 $15。你甚至还没算 reasoning token。

好消息是：同样一套 Agent，把成本工程做到位，**省 70%-85% 是可复现的工程结果**，不需要砍功能。

## 成本账单长什么样

先拆一笔典型 Agent 请求的账。假设一个 RAG + 工具调用的客服 Agent，单次对话 5 轮，每轮上下文 10k input tokens、500 output tokens：

| 模型                  | Input 单价   | Output 单价  | 单次对话成本 | 相对成本 |
| --------------------- | ------------ | ------------ | ------------ | -------- |
| Claude Opus 4.5       | $15 / 1M     | $75 / 1M     | $0.94        | 1.0x     |
| Claude Sonnet 4.5     | $3 / 1M      | $15 / 1M     | $0.19        | 0.20x    |
| Claude Haiku 4.5      | $0.8 / 1M    | $4 / 1M      | $0.05        | 0.05x    |
| GPT-4.1               | $2 / 1M      | $8 / 1M      | $0.12        | 0.13x    |
| GPT-4.1 mini          | $0.15 / 1M   | $0.6 / 1M    | $0.009       | 0.01x    |
| DeepSeek V3.1         | $0.27 / 1M   | $1.1 / 1M    | $0.016       | 0.02x    |

注意两件事：**Input 占了 90%+ 的成本**（因为 10k : 0.5k），**Opus 和 Haiku 差 20 倍**。成本工程的本质就是两件事：让 input 变便宜、让昂贵模型少干活。

## 武器一：Prompt Cache，能省的就别重算

Agent 场景有个结构性红利——**每轮对话 90% 的 token 是重复的**：system prompt、工具定义、RAG 检索结果、历史消息。这些内容在第二轮以后是"纯冗余"，不该按原价计费。

三家厂商的缓存机制各有差异：

| 厂商      | 缓存折扣      | 写缓存成本  | 最小长度     | TTL       |
| --------- | ------------- | ----------- | ------------ | --------- |
| Anthropic | Read 10%      | Write 125%  | 1024 tokens  | 5min/1h   |
| OpenAI    | Read 50%      | Write 100%  | 1024 tokens  | 5-10min   |
| DeepSeek  | Read 10%      | Write 100%  | 64 tokens    | 小时级    |

Anthropic 和 DeepSeek 都是 **Cache Read 只要 10%**，命中就等于打一折。但 Anthropic 的写缓存要多收 25%，意味着如果缓存只命中一次就亏，命中两次开始赚。

Anthropic 的关键在 `cache_control` 标记要打在"稳定前缀"的末尾：

```python
import anthropic

client = anthropic.Anthropic()

response = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system=[
        {
            "type": "text",
            "text": SYSTEM_PROMPT,  # 固定的角色设定
        },
        {
            "type": "text",
            "text": TOOL_DEFINITIONS,  # 几十个工具 schema
            "cache_control": {"type": "ephemeral"},  # 缓存到这里
        },
        {
            "type": "text",
            "text": RETRIEVED_DOCS,  # RAG 检索的长文档
            "cache_control": {"type": "ephemeral"},  # 再打一个点
        },
    ],
    messages=conversation_history,  # 变化部分不标记
)
```

踩过的坑：

- **标记点前后的内容必须完全一致**，多一个换行符都会 miss。用 `hash(content)` 做单元测试。
- **工具定义里塞了动态时间戳**→ 每次 hash 变，永远 miss。把时间戳挪到 user message 里。
- **一次请求最多 4 个缓存断点**，别贪心。一般放在 system/tools 末尾、RAG 结果末尾即可。

实测经验：一个跑了两周的多轮客服 Agent，打开 cache 后平均 input cost 降到 **原来的 22%**，净省 78%。

## 武器二：模型降级路由，贵模型只干贵活

不是所有请求都值得 Sonnet。一个典型 Agent 的工作流里，其实只有 **"规划"和"最终回答"** 这两步需要强推理；意图分类、工具参数抽取、结果摘要这些可以交给 Haiku 或 mini 模型。

```python
from dataclasses import dataclass

@dataclass
class RoutingPolicy:
    """按任务类型选模型"""
    intent_classify: str = "claude-haiku-4-5"   # 分类任务，Haiku 绰绰有余
    param_extract: str = "gpt-4.1-mini"         # 结构化输出，mini 稳
    planning: str = "claude-sonnet-4-5"         # 规划要推理，Sonnet
    final_answer: str = "claude-sonnet-4-5"     # 面向用户，质量门槛高
    summarize: str = "deepseek-v3"              # 纯压缩，开源模型

async def route(task_type: str, messages: list) -> str:
    model = getattr(RoutingPolicy(), task_type)
    return await llm_call(model, messages)
```

降级的安全网是 **"质量门控 + 自动回退"**：Haiku 跑完先让一个轻量 judge 打个分，分数低于阈值就自动重跑 Sonnet。实际拦截率只有 3%-5%，但心里踏实。

## 武器三：Token 预算，给每个请求画个圈

没预算控制的 Agent 会在一次 runaway loop 里烧掉你一天的 profit。给每个 session 和每个工具调用设硬预算：

```python
class TokenBudget:
    def __init__(self, session_limit: int, tool_limit: int):
        self.session_limit = session_limit
        self.tool_limit = tool_limit
        self.session_used = 0

    def check_tool_call(self, estimated: int):
        if estimated > self.tool_limit:
            raise BudgetExceeded(f"单次工具调用超 {self.tool_limit}")
        if self.session_used + estimated > self.session_limit:
            raise BudgetExceeded(f"session 预算耗尽")

    def record(self, used: int):
        self.session_used += used
```

配合 `max_tokens` 参数的硬截断，就不会出现 Agent 连续输出 30k token 把 context 撑爆再崩溃的惨剧。

## 武器四：上下文压缩，别让历史拖垮每一轮

多轮对话到第 10 轮，历史消息已经 40k token 了。继续全量塞，每一轮都在为"用户 5 分钟前问过什么"付费。

三种渐进式压缩策略：

1. **Sliding Window**：只保留最近 N 轮 + system。适合无状态问答。
2. **Summary Buffer**：前面的对话压缩成一段 summary，最近几轮保留原文。适合任务型对话。
3. **Semantic Recall**：历史全部入向量库，每轮只检索 top-k 相关片段塞进去。适合长期记忆场景。

一个实测数字：一个平均 15 轮的任务型 Agent，从"全量历史"改成"Summary + 最近 3 轮"后，第 10 轮起的 input tokens 从 38k 降到 9k，成本省 **76%**，任务完成率几乎没变（从 91% 到 89%）。

## 武器五：Batch API，异步任务打五折

所有离线生成任务——数据标注、批量总结、离线评测——都该走 Batch API。OpenAI 和 Anthropic 的 Batch 都是 **50% 折扣 + 24h 内返回**。

一个实用模式是"推理降级到 Batch"：用户请求里不紧急的后置任务（比如事后总结对话、生成标签、离线质检），不要在同步链路里烧钱，扔进 Batch 队列。

## 怎么选，给张决策矩阵

| 场景                           | 首选武器                          | 预期节省 |
| ------------------------------ | --------------------------------- | -------- |
| 多轮对话 Agent                 | Prompt Cache + 上下文压缩         | 60%-80%  |
| 大量短请求（分类、抽取）       | 模型降级到 Haiku/mini             | 80%-95%  |
| 长文档处理                     | Cache + Batch API                 | 70%-85%  |
| Runaway 风险高的 ReAct Agent   | Token 预算 + max_tokens 硬截断    | 防失控   |
| 高并发、成本压力大的 SaaS      | 五把武器全开 + 自托管小模型兜底   | 70%+     |

## 落地 Checklist

- [ ] 所有 LLM 调用统一走一层 gateway，打印 `input_tokens / output_tokens / cached_tokens / cost_usd`
- [ ] Dashboard 按 `user_id / endpoint / model` 拆账，每天自动出报表
- [ ] System prompt + tool definitions 打 cache 断点，写测试保证 prefix 稳定
- [ ] 按任务类型配置模型路由表，非核心步骤默认用 Haiku/mini
- [ ] 每个 session 和每个 tool call 设 token 预算，超预算触发告警
- [ ] 历史消息超过 N 轮启动 summary buffer
- [ ] 所有非同步任务迁移到 Batch API
- [ ] 每周 review cost per user / cost per successful task 两个指标

成本工程不是"能跑就行"的 nice-to-have，而是决定你的 Agent 产品能不能活到明年的底层能力。钱省下来的不只是账单，是你能给用户定更低的价、能在产品里多加几次重试、能让 Agent 敢干更多活。
