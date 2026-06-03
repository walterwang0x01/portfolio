---
title: "工具太多塞不下：Agent 动态工具检索实战"
date: 2026-06-03
tags: ["AI Agent", "工程化", "MCP"]
excerpt: "MCP 生态爆发后，一个 Agent 接入几百个工具是常态。但把 300 个工具 Schema 全塞进 context，既烧钱又让模型选错。动态工具检索是 2026 年绕不开的工程问题——这篇讲清楚怎么做。"
vip: false
draft: false
emoji: "🔧"
---

教程里的 Agent 永远只有 3 个工具：查天气、算数、搜网页。但真实生产系统接了 MCP 之后，工具数量会失控——一个企业内部 Agent 同时挂着 Jira、GitHub、Slack、数据库查询、内部 CRM、报销系统，轻松突破 200 个工具定义。

这时候你会撞上两堵墙。第一堵是**钱**：每个工具的 JSON Schema 平均 200-500 token，300 个工具就是 6-15 万 token，每一轮对话都要重新发一遍（即使有 prompt cache，首次写入和缓存失效的成本依然存在）。第二堵是**准确率**：模型在 300 个工具里选对一个的概率，远低于在 10 个相关工具里选。研究和生产数据都反复证明，工具数量超过 30-50 个之后，工具选择准确率断崖式下跌。

解法就是**动态工具检索（Tool Retrieval）**：不再把全量工具塞给模型，而是先根据用户意图检索出 Top-K 个相关工具，只把这几个的 Schema 注入 context。本质上就是把 RAG 那一套搬到工具上。本文讲清楚怎么落地。

## 为什么"全量注入"撑不住

先用数据说话。假设单工具 Schema 平均 300 token：

| 工具数量 | Schema 总 token | 选择准确率（实测经验值） | 单轮额外成本* |
|---|---|---|---|
| 10 | 3,000 | ~95% | 可忽略 |
| 50 | 15,000 | ~82% | 中等 |
| 150 | 45,000 | ~68% | 高 |
| 300 | 90,000 | ~55% | 非常高 |

> *成本指每轮把工具定义发给模型的输入 token 开销。即便命中 prompt cache 能打 1 折，缓存失效（工具列表变化、TTL 过期）后仍需全额重写。

准确率下降的根因不是模型笨，而是**注意力稀释**和**语义混淆**。当 context 里同时存在 `search_jira_issues`、`search_github_issues`、`search_linear_tickets` 这种高度相似的工具，模型很容易选错。工具越多，这种"近义工具"越多，干扰越强。

所以核心思路就一句话：**让模型每次只看到它真正需要的那几个工具。**

## 方案一：向量检索工具（Tool RAG）

最直接的做法——把每个工具的描述向量化，存进向量库，运行时用用户 query 检索 Top-K。

```python
import numpy as np
from openai import OpenAI

client = OpenAI()

class ToolRetriever:
    def __init__(self, tools: list[dict]):
        self.tools = tools
        # 把工具名 + 描述拼成检索文本，预先 embed
        texts = [self._tool_to_text(t) for t in tools]
        self.embeddings = self._embed(texts)  # shape: (n_tools, dim)

    def _tool_to_text(self, tool: dict) -> str:
        # 关键：name + description + 参数名都进检索文本
        params = " ".join(tool["input_schema"].get("properties", {}).keys())
        return f"{tool['name']}: {tool['description']}. 参数: {params}"

    def _embed(self, texts: list[str]) -> np.ndarray:
        resp = client.embeddings.create(
            model="text-embedding-3-small", input=texts
        )
        return np.array([d.embedding for d in resp.data])

    def retrieve(self, query: str, k: int = 8) -> list[dict]:
        q_emb = self._embed([query])[0]
        # 余弦相似度
        sims = self.embeddings @ q_emb / (
            np.linalg.norm(self.embeddings, axis=1) * np.linalg.norm(q_emb)
        )
        top_idx = np.argsort(sims)[::-1][:k]
        return [self.tools[i] for i in top_idx]
```

运行时只把检索结果注入：

```python
retriever = ToolRetriever(ALL_TOOLS)  # 启动时构建一次

async def chat(user_query: str):
    relevant_tools = retriever.retrieve(user_query, k=8)
    resp = await client.messages.create(
        model="claude-opus-4",
        messages=[{"role": "user", "content": user_query}],
        tools=relevant_tools,  # 只发 8 个，不是 300 个
    )
    return resp
```

这套方案能把 300 个工具的 context 从 9 万 token 压到 2400 token，立竿见影。但它有三个坑，下面逐个拆。

## 三个必踩的坑

**坑一：纯语义检索召回不稳。** 用户说"把这个 bug 转给后端团队"，语义上离 `assign_issue` 很近，但离 `create_jira_ticket` 也不远。纯向量检索在近义工具上区分度差。解法是**混合检索**——向量召回 + 关键词（BM25）召回，再融合排序：

```python
def hybrid_retrieve(self, query: str, k: int = 8) -> list[dict]:
    vec_hits = self._vector_search(query, k=20)   # 语义召回
    kw_hits = self._bm25_search(query, k=20)       # 关键词召回
    # RRF（Reciprocal Rank Fusion）融合
    scores = {}
    for rank, tool in enumerate(vec_hits):
        scores[tool["name"]] = scores.get(tool["name"], 0) + 1 / (60 + rank)
    for rank, tool in enumerate(kw_hits):
        scores[tool["name"]] = scores.get(tool["name"], 0) + 1 / (60 + rank)
    ranked = sorted(scores.items(), key=lambda x: -x[1])[:k]
    return [self._by_name(name) for name, _ in ranked]
```

**坑二：多步任务中途需要新工具。** 用户第一句"帮我查下这周的销售数据"检索到了 `query_database`，但模型执行后发现要"生成图表并发到 Slack"——这俩工具第一轮没被检索进来。解法是**每轮重新检索**：把最近的对话历史 + 当前模型的"意图"作为检索 query，而不是只用首句。更进一步可以引入一个 `search_tools` 元工具，让模型在需要时主动检索：

```python
SEARCH_TOOLS_META = {
    "name": "search_tools",
    "description": "当现有工具无法完成任务时，用自然语言描述你需要的能力，检索更多工具",
    "input_schema": {
        "type": "object",
        "properties": {"capability": {"type": "string", "description": "需要的能力描述"}},
        "required": ["capability"],
    },
}
# 模型调用 search_tools 后，把检索结果作为新工具追加进下一轮 tools 列表
```

这是 Anthropic 在 MCP 场景里推的 **Tool Search Tool** 模式——模型自己决定什么时候需要更多工具，而不是系统盲目预测。

**坑三：检索质量无法保证 100%。** 万一相关工具没被召回，模型就彻底没法完成任务。所以一定要**保底**：高频核心工具常驻 context（不参与检索，永远在场），只对长尾工具做检索。一个实用的分层策略：

```python
def build_tools(query: str) -> list[dict]:
    core = CORE_TOOLS          # 5-10 个高频工具，常驻
    retrieved = retriever.hybrid_retrieve(query, k=8)
    # 去重合并，core 优先
    seen = {t["name"] for t in core}
    extra = [t for t in retrieved if t["name"] not in seen]
    return core + extra
```

## 方案二：分层 / 命名空间路由

当工具天然按系统分组（Jira 一组、GitHub 一组、数据库一组），可以用**两段式路由**替代向量检索：先让一个轻量模型（或规则）判断"该用哪个系统"，再加载那个系统的工具。

```python
async def route_then_act(user_query: str):
    # 第一段：用小模型判断命名空间，便宜又快
    namespace = await classify_namespace(
        user_query, options=["jira", "github", "database", "slack"]
    )
    tools = TOOLS_BY_NAMESPACE[namespace]  # 只加载这一组
    return await client.messages.create(
        model="claude-opus-4",
        messages=[{"role": "user", "content": user_query}],
        tools=tools,
    )
```

它的好处是**确定性强、可解释**——不像向量检索那样玄学。坏处是处理不了跨系统任务（"把 GitHub 的 issue 同步到 Jira"），需要支持多命名空间。实践中常和向量检索结合：路由缩小范围，检索精排。

## 怎么选：决策矩阵

| 维度 | 全量注入 | 向量检索（Tool RAG） | 分层路由 |
|---|---|---|---|
| 适用工具数 | < 30 | 50 - 1000+ | 工具天然分组 |
| context 成本 | 高 | 低 | 低 |
| 选择准确率 | 工具多则差 | 中-高（依赖检索质量） | 高（组内） |
| 跨系统任务 | 原生支持 | 支持 | 需特殊处理 |
| 实现复杂度 | 最低 | 中 | 中 |
| 可解释性 | 高 | 低 | 高 |

一句话总结选型逻辑：**工具少于 30 个别折腾，直接全量注入**；超过 50 个且无明显分组，上向量检索 + 核心工具常驻；工具天然按系统分组，用分层路由打底、向量检索精排。

## 落地 checklist

真正上线前，对照这几条自查：

- **核心工具常驻**：把 Top 5-10 高频工具固定在 context，不参与检索，避免漏召回直接导致任务失败。
- **混合检索而非纯向量**：向量 + BM25 + RRF 融合，应对近义工具。工具描述写得越具体（动词 + 对象 + 场景），检索越准。
- **每轮重检索或加 `search_tools` 元工具**：别只用首句检索，多步任务会在中途需要新工具。
- **检索结果可观测**：记录每次检索的 Top-K 和模型最终选了哪个，离线分析"该召回却没召回"的 case，持续优化工具描述。
- **配合 prompt cache**：核心工具放在 prompt 靠前的稳定位置以命中缓存，检索出的动态工具放后面，减少缓存失效面。
- **设置降级**：检索服务挂了，要能回退到"全量注入核心工具组"，而不是整个 Agent 瘫痪。

工具检索的本质，是承认"上下文是有限且昂贵的资源"。把 RAG 的工程经验迁移过来——召回、排序、融合、降级、可观测——你就能让 Agent 在挂着几百个工具的情况下，依然又快又准。这是 MCP 时代 Agent 工程的一道必答题。
