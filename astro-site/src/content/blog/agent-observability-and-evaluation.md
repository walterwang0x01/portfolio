---
title: "Agent 可观测性与评估：让你的 AI Agent 不再是黑盒"
date: 2026-05-03
tags: ["AI Agent", "可观测性", "评估"]
excerpt: "Agent 上线后最怕的不是它出错，而是你不知道它为什么出错。从 Tracing 链路追踪到 LLM-as-Judge 评估，从测试金字塔到 Eval-Driven Development，一文搞懂如何让 Agent 系统透明、可测、可信赖。"
vip: false
draft: false
---
你花了两周搭好一个 AI Agent，Demo 跑得很顺，上线后却频繁"抽风"——有时回答离谱，有时工具调不通，有时莫名其妙地绕圈子。你打开日志，只看到一堆 token 进进出出，完全不知道问题出在哪。

这不是个例。**Agent 系统最大的工程挑战不是让它跑起来，而是让它可观测、可评估、可持续迭代。**传统软件有成熟的 APM、单元测试、CI/CD 流水线，但 Agent 系统的非确定性本质让这些经典方法论几乎全部失效。你需要一套全新的工程体系。

## 为什么 Agent 可观测性如此重要

传统 Web 服务的可观测性围绕三大支柱：Metrics（指标）、Logging（日志）、Tracing（链路追踪）。Agent 系统同样需要这三者，但维度完全不同：

```
┌─────────────────────────────────────────┐
│           Agent 可观测性                  │
├──────────┬──────────┬──────────────────┤
│  Tracing  │ Metrics  │  Logging         │
│  链路追踪  │ 指标监控  │  日志记录        │
├──────────┼──────────┼──────────────────┤
│ Trace/Span│ Token 用量│ 输入/输出日志     │
│ 调用链路  │ 延迟 P99  │ 错误日志         │
│ 工具调用  │ 成本统计  │ 审计日志         │
└──────────┴──────────┴──────────────────┘
```

传统服务的一次请求通常是线性的：收到请求 → 查数据库 → 返回响应。但 Agent 的一次任务可能涉及 **5-10 步工具调用**，每一步都可能分叉、重试、甚至回溯。如果没有完整的链路追踪，你根本无法定位"Agent 在第 3 步选错了工具"还是"第 5 步的工具返回了脏数据"。

更关键的是**成本**。一个设计不当的 Agent 可能在一次任务中消耗数万 token，而你浑然不觉。Anthropic 内部在开发 Claude Code 时发现，低效的测试和调试循环产生了约 25 万次 API 调用的浪费。没有可观测性，你连"钱花在哪了"都不知道。

## 链路追踪：Agent 的 X 光片

链路追踪是 Agent 可观测性的核心。它让你看到 Agent 每一步的决策过程：调用了什么工具、传了什么参数、花了多少 token、耗时多久。

### LangFuse：自托管的追踪平台

LangFuse 是目前最流行的开源 LLM 可观测性平台，支持自托管部署，数据完全可控：

```
from langfuse.decorators import observe, langfuse_context

@observe()  # 自动追踪函数调用
def rag_pipeline(question: str) -> str:
    # 检索阶段
    docs = retrieve_documents(question)

    # 记录检索元数据
    langfuse_context.update_current_observation(
        metadata={"retrieved_docs": len(docs)}
    )

    # 生成阶段
    answer = generate_answer(question, docs)
    return answer

@observe(as_type="generation")
def generate_answer(question: str, docs: list) -> str:
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{
            "role": "user",
            "content": f"上下文：{docs}\n问题：{question}"
        }],
    )
    # 自动记录 token 用量和成本
    langfuse_context.update_current_observation(
        usage={
            "input": response.usage.prompt_tokens,
            "output": response.usage.completion_tokens
        },
        model="gpt-4o",
    )
    return response.choices[0].message.content
```

通过 `@observe()` 装饰器，每次函数调用都会自动生成 Span，形成完整的调用链路。你可以在 LangFuse 控制台中看到每个 Span 的输入、输出、耗时和 token 消耗。

### 手动创建 Trace 实现精细控制

对于需要更精细控制的场景，可以手动创建 Trace 和 Span：

```
from langfuse import Langfuse

langfuse = Langfuse()

# 创建顶层 Trace
trace = langfuse.trace(
    name="customer-service",
    user_id="user-123"
)

# 检索步骤的 Span
retrieval_span = trace.span(
    name="retrieval",
    input={"query": "退货政策"}
)
docs = retriever.invoke("退货政策")
retrieval_span.end(output={"doc_count": len(docs)})

# LLM 调用的 Generation
generation = trace.generation(
    name="answer-generation",
    model="gpt-4o",
    input=[{"role": "user", "content": "退货政策是什么？"}],
)
response = llm.invoke(...)
generation.end(
    output=response.content,
    usage={"input": 150, "output": 200},
    metadata={"temperature": 0.7},
)

# 用户满意度评分
trace.score(name="user_satisfaction", value=0.9)
```

这种方式让你可以为每个关键步骤打上标签、记录元数据，甚至关联用户反馈评分，形成从"用户提问"到"满意度评价"的完整闭环。

## 成本监控：别让 Agent 悄悄烧钱

Agent 的成本结构和传统服务完全不同。一次简单的问答可能只消耗几百 token，但一次复杂的多步任务可能消耗数万 token。更隐蔽的是 **Prompt Cache 的经济学**：

```
# 以 Claude Opus 为例的成本对比
标准输入：$15 / 百万 token
缓存命中：$1.5 / 百万 token  ← 90% 折扣
缓存写入：$18.75 / 百万 token

# 关键推论
# 每次缓存未命中，成本增加 10 倍
# 上下文前缀越稳定，缓存命中率越高
```

一个实用的成本监控方案是在每次 LLM 调用时记录 token 用量，并按模型定价实时计算成本：

```
from dataclasses import dataclass, field
from collections import defaultdict

@dataclass
class ModelPricing:
    input_per_1k: float
    output_per_1k: float
    cached_input_per_1k: float = 0.0

PRICING = {
    "claude-sonnet-4": ModelPricing(0.003, 0.015, 0.0003),
    "gpt-4o": ModelPricing(0.0025, 0.01, 0.00125),
    "gpt-4o-mini": ModelPricing(0.00015, 0.0006, 0.000075),
}

def calculate_cost(model, input_tokens, output_tokens, cached_tokens=0):
    pricing = PRICING[model]
    fresh_input = input_tokens - cached_tokens
    return (
        (fresh_input / 1000) * pricing.input_per_1k
        + (cached_tokens / 1000) * pricing.cached_input_per_1k
        + (output_tokens / 1000) * pricing.output_per_1k
    )
```

建议设置**成本告警阈值**：单次任务超过 $0.50 或单用户日消耗超过 $5.00 时触发告警。这能帮你在"Agent 陷入死循环疯狂调用 LLM"时及时止损。

## Agent 测试金字塔：从单元测试到端到端评估

Agent 测试的最大挑战是**非确定性**。相同的输入，Agent 可能给出语义相同但字面完全不同的输出。传统的 `assert output == expected` 直接失效。

解决方案是构建一个分层的测试金字塔：

```
            /  E2E Eval  \           ← 最贵，最慢，最真实
           / Integration   \         ← 真实 LLM + Mock 外部服务
          /  Component      \        ← Mock LLM + 真实工具逻辑
         /   Unit Tests      \       ← 纯确定性，无 LLM 调用
        ──────────────────────
```

| 层级 | LLM 调用 | 速度 | 成本/次 | 占比建议 |
| --- | --- | --- | --- | --- |
| 单元测试 | Mock | <1s | $0 | 60% |
| 组件测试 | Mock | <5s | $0 | 20% |
| 集成测试 | 真实 | 5-30s | $0.01-0.10 | 15% |
| E2E Eval | 真实 | 30s-5min | $0.10-1.00 | 5% |

**核心原则：尽可能把测试下推到金字塔底部。**能用单元测试验证的逻辑，绝不用集成测试。

### 底层：单元测试覆盖确定性逻辑

所有不依赖 LLM 的逻辑都应该用传统单元测试覆盖：工具输入 Schema 验证、权限规则匹配、输出解析器、成本计算等。这些测试运行快、成本零、可靠性高。

```
# 工具输入 Schema 验证示例
class TestDatabaseQueryInput:
    def test_reject_dangerous_delete_without_where(self):
        with pytest.raises(ValueError, match="危险操作"):
            DatabaseQueryInput(sql="DELETE FROM users")

    def test_allow_delete_with_where(self):
        query = DatabaseQueryInput(
            sql="DELETE FROM users WHERE id = 1"
        )
        assert "DELETE" in query.sql
```

### 中层：Mock LLM 测试工具路由

组件测试的核心思路是用 Mock LLM 替代真实模型，验证 Agent 的工具选择和编排逻辑是否正确：

```
class MockLLM:
    """可编程的 Mock LLM，按顺序返回预设响应"""
    def __init__(self, responses):
        self._responses = responses
        self._call_index = 0

    async def ainvoke(self, messages, tools=None):
        response = self._responses[self._call_index]
        self._call_index += 1
        return response

# 测试：天气查询应该调用天气工具
mock_llm = MockLLM(responses=[
    MockLLMResponse(tool_calls=[
        MockToolCall(name="get_weather", arguments={"city": "北京"})
    ]),
    MockLLMResponse(content="北京今天晴天，28°C"),
])
agent = AgentExecutor(llm=mock_llm, tools=["get_weather"])
result = await agent.run("北京天气怎么样？")
```

### 顶层：模糊断言对抗非确定性

集成测试使用真实 LLM，但需要用模糊断言替代精确匹配：

```
# ❌ 传统断言：永远会失败
assert result == "机器学习是人工智能的一个分支..."

# ✅ 模糊断言：检查语义而非字面
assert any(kw in result for kw in ["机器学习", "ML"])
assert len(result) > 50
assert llm_judge(result, criteria="准确性") >= 0.8
```

对于非确定性特别强的场景，可以用**统计断言**——多次运行取多数结果：

```
async def assert_with_majority(agent_fn, query, check_fn, runs=5):
    results = [check_fn(await agent_fn(query)) for _ in range(runs)]
    pass_rate = sum(results) / len(results)
    assert pass_rate >= 0.8  # 5 次中至少 4 次正确
```

## LLM-as-Judge：让 AI 评判 AI

当输出太复杂、无法用关键词或正则匹配时，可以用另一个 LLM 作为评判者。这就是 **LLM-as-Judge** 模式：

```
async def llm_judge(task, agent_output, judge_model="gpt-4o"):
    prompt = f"""你是 AI Agent 评估专家。请评分（0-1）：

任务：{task}
Agent 输出：{agent_output}

评分标准：
- 1.0: 完全正确，信息完整
- 0.8: 基本正确，有小瑕疵
- 0.6: 部分正确，缺少关键信息
- 0.4: 方向正确但有明显错误
- 0.0: 完全错误

只输出数字："""
    score = await judge_llm.ainvoke(prompt)
    return float(score.content.strip())
```

LLM-as-Judge 的优势是能理解语义，但也有局限：评判模型本身可能有偏见，且每次评估都有额外成本。建议用 **GPT-4o 作为 Judge 评估 GPT-4o-mini 的输出**——用更强的模型评判更弱的模型，可信度更高。

## RAGAS：RAG 系统的专业评估框架

如果你的 Agent 包含 RAG 组件，RAGAS 是目前最成熟的评估框架。它提供四个核心指标：

-   **Faithfulness（忠实度）**：回答是否基于检索到的上下文，而非模型幻觉
-   **Answer Relevancy（答案相关性）**：回答是否切题
-   **Context Precision（上下文精确度）**：检索到的文档是否相关
-   **Context Recall（上下文召回率）**：是否检索到了所有必要的信息

```
from ragas import evaluate
from ragas.metrics import (
    faithfulness, answer_relevancy,
    context_precision, context_recall
)

results = evaluate(
    dataset=eval_data,
    metrics=[
        faithfulness,
        answer_relevancy,
        context_precision,
        context_recall,
    ],
)
# {'faithfulness': 0.92, 'answer_relevancy': 0.88,
#  'context_precision': 0.85, 'context_recall': 0.90}
```

这四个指标覆盖了 RAG 系统的两大核心环节：**检索质量**（Precision + Recall）和**生成质量**（Faithfulness + Relevancy）。如果 Faithfulness 低，说明模型在"编造"答案；如果 Context Recall 低，说明检索器漏掉了关键文档。

## Eval-Driven Development：评估驱动开发

Anthropic 在开发 Claude Code 时总结出一套方法论：**Eval-Driven Development (EDD)**。核心思路是把评估放在开发流程的最前面，而不是最后面：

1.  **构建原型工具**：先有一个能跑的最小 Agent
2.  **设计评估任务**：基于真实场景，不是玩具示例
3.  **运行评估**：Agent 循环 + 工具调用 + 结果验证
4.  **分析结果**：Agent 在哪里卡住？哪些工具调用失败？
5.  **优化工具描述和 Prompt**：甚至让 Agent 自己分析日志并优化
6.  **重复 3-5 直到性能达标**
7.  **用留出测试集验证**：防止过拟合

> 关键洞察：Anthropic 发现让 Claude 分析评估日志并自动优化工具描述，效果甚至超过人类专家手写的工具定义。

EDD 的本质是把 Agent 开发从"凭感觉调 Prompt"变成"用数据驱动迭代"。每次改动都有评估数据支撑，每次优化都可以量化效果。

## 实战建议：从零搭建 Agent 可观测体系

如果你正在开发 Agent 系统，建议按以下优先级逐步搭建可观测体系：

1.  **第一步：接入链路追踪**（Day 1 就做）。推荐 LangFuse 自托管，或 LangSmith 云服务。确保每次 LLM 调用都有 Trace。
2.  **第二步：成本监控**。记录每次调用的 token 用量，设置日/周成本告警。
3.  **第三步：单元测试覆盖确定性逻辑**。Schema 验证、权限检查、输出解析——这些不需要 LLM，用传统测试即可。
4.  **第四步：构建 Eval 数据集**。从真实用户场景中提取 20-50 个评估任务，覆盖核心功能和边界情况。
5.  **第五步：CI 集成**。单元测试和组件测试跑在每次 PR，集成测试和 E2E Eval 跑在每日构建。

Agent 系统的工程化还在早期阶段，工具和方法论都在快速演进。但有一点是确定的：**没有可观测性的 Agent 就是一个黑盒，而黑盒不属于生产环境。**
