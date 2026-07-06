---
title: "RAG 混合检索生产实战：BM25 + 向量 + Reranker + Query Rewrite 全链路"
date: 2026-07-06
tags: ["RAG", "向量数据库", "工程化"]
excerpt: "纯向量检索在专有名词和精确匹配上经常翻车。生产级 RAG 需要 BM25 稀疏检索、稠密向量、Cross-Encoder Reranker 和 Query Rewrite 四层协作——本文给出架构选型、Python 实现和落地 checklist。"
emoji: "🔍"
vip: false
draft: false
---

很多团队的 RAG 上线第一周表现惊艳，第二周就开始翻车：用户搜「Qwen3-32B INT4 显存占用」，向量检索返回一堆「大模型选型指南」；搜内部项目代号 `agenzo-ledger`，语义相近的「账本服务」文档排在真正文档后面。根因通常不是 Embedding 模型太差，而是**只靠稠密向量一条路**——它擅长语义泛化，却在精确匹配、稀有实体、数字版本号上系统性吃亏。

2026 年的生产 RAG 默认答案已经变成 **Hybrid Retrieval**：BM25 抓关键词，向量抓语义，Reranker 做精排，Query Rewrite 把用户口语翻译成检索友好查询。这篇把四层串成一条可落地的工程链路。

## 四层架构：各自解决什么问题

```
用户 Query
    │
    ▼
┌─────────────┐
│ Query Rewrite│  ← 口语 → 检索友好（可选，复杂场景必开）
└──────┬──────┘
       │
   ┌───┴───┐
   ▼       ▼
┌──────┐ ┌──────────┐
│ BM25 │ │  Vector  │   ← 双路召回（并行）
│稀疏  │ │  稠密    │
└──┬───┘ └────┬─────┘
   │          │
   └───┬──────┘
       ▼
┌─────────────┐
│  RRF 融合   │  ← Reciprocal Rank Fusion，无需调权重
└──────┬──────┘
       ▼
┌─────────────┐
│ Cross-Encoder│  ← 精排 Top-K（计算贵，只跑 20-50 条）
│   Reranker   │
└──────┬──────┘
       ▼
    Top-N → LLM 生成
```

| 层级 | 擅长 | 翻车场景 | 典型延迟 |
|------|------|---------|---------|
| BM25 | 专有名词、版本号、代码符号 | 同义词、口语化表达 | < 10ms |
| 向量 | 语义相似、跨语言 | 稀有实体、精确匹配 | 20-80ms |
| RRF 融合 | 互补两路弱点 | 两路都错时救不了 | < 1ms |
| Reranker | 精细相关性判断 | 候选集太大时太慢 | 50-200ms |
| Query Rewrite | 消歧、补全上下文 | 多一次 LLM 调用 | 200-800ms |

## Step 1：双路召回实现

下面用 Python 演示最小可用的混合召回，依赖 `rank_bm25` + `chromadb` + `sentence-transformers`：

```python
from rank_bm25 import BM25Okapi
import chromadb
from sentence_transformers import SentenceTransformer
import jieba

# 假设 chunks 已分好
chunks = [
    {"id": "c1", "text": "Qwen3-32B 在 INT4 量化后约需 18GB 显存"},
    {"id": "c2", "text": "大模型选型需综合考虑任务类型和 GPU 预算"},
    {"id": "c3", "text": "agenzo-ledger 是 Agenzo 项目的账本微服务"},
]

# --- BM25 索引 ---
tokenized = [list(jieba.cut(c["text"])) for c in chunks]
bm25 = BM25Okapi(tokenized)

def bm25_search(query: str, top_k: int = 10) -> list[tuple[str, float]]:
    tokens = list(jieba.cut(query))
    scores = bm25.get_scores(tokens)
    ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    return [(chunks[i]["id"], s) for i, s in ranked[:top_k] if s > 0]

# --- 向量索引 ---
encoder = SentenceTransformer("BAAI/bge-m3")
client = chromadb.EphemeralClient()
col = client.create_collection("docs")
col.add(
    ids=[c["id"] for c in chunks],
    documents=[c["text"] for c in chunks],
    embeddings=encoder.encode([c["text"] for c in chunks]).tolist(),
)

def vector_search(query: str, top_k: int = 10) -> list[tuple[str, float]]:
    emb = encoder.encode([query]).tolist()
    res = col.query(query_embeddings=emb, n_results=top_k)
    return list(zip(res["ids"][0], res["distances"][0]))
```

中文场景记得分词：BM25 对中文不用 jieba 基本废掉。英文文档可以直接按空格切。

## Step 2：RRF 融合——比调 alpha 权重更稳

早期混合检索常用 `score = alpha * dense + (1-alpha) * sparse`，alpha 要按数据集调参，换个领域就漂。RRF（Reciprocal Rank Fusion）只看排名不看绝对分数，工程上更省心：

```python
def reciprocal_rank_fusion(
    result_lists: list[list[tuple[str, float]]],
    k: int = 60,
) -> list[tuple[str, float]]:
    """多路召回结果按 RRF 融合。k 通常取 60，无需调参。"""
    scores: dict[str, float] = {}
    for results in result_lists:
        for rank, (doc_id, _) in enumerate(results):
            scores[doc_id] = scores.get(doc_id, 0) + 1 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)


query = "agenzo-ledger 是什么"
bm25_hits = bm25_search(query)
vec_hits = vector_search(query)
fused = reciprocal_rank_fusion([bm25_hits, vec_hits])
# fused[0] 大概率是 c3 — BM25 精确命中 + 向量语义补充
```

经验值：双路各召回 Top-20，RRF 融合后取 Top-30 送给 Reranker。

## Step 3：Cross-Encoder Reranker

Bi-Encoder（向量检索）把 query 和 document 分别编码再算相似度，快但精度有限。Cross-Encoder 把 `(query, document)` 拼在一起过 Transformer，精度高但只能跑小候选集。

```python
from sentence_transformers import CrossEncoder

reranker = CrossEncoder("BAAI/bge-reranker-v2-m3")

def rerank(query: str, candidates: list[dict], top_n: int = 5) -> list[dict]:
    pairs = [(query, c["text"]) for c in candidates]
    scores = reranker.predict(pairs)
    ranked = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)
    return [c for c, _ in ranked[:top_n]]

# 把 fused 的 doc_id 还原成 chunk 对象后调用
id_to_chunk = {c["id"]: c for c in chunks}
candidate_chunks = [id_to_chunk[did] for did, _ in fused[:30]]
final = rerank(query, candidate_chunks, top_n=3)
```

Reranker 选型参考：

| 模型 | 语言 | 延迟 (pair) | 适用 |
|------|------|------------|------|
| bge-reranker-v2-m3 | 中英 | ~15ms | 通用首选 |
| jina-reranker-v2 | 多语言 | ~12ms | 跨语言场景 |
| Cohere rerank-v3 | API | 网络延迟 | 不想自托管 |
| ms-marco-MiniLM | 英文 | ~5ms | 纯英文、低延迟 |

## Step 4：Query Rewrite——什么时候值得开

Query Rewrite 用 LLM 把用户口语改写成检索友好查询，典型场景：

- **多轮对话**：用户说「那个量化方案呢？」→ 改写为「Qwen3-32B INT4 量化显存占用」
- **消歧**：「ledger 服务」→ 改写为「agenzo-ledger 微服务架构」
- **HyDE**（Hypothetical Document Embedding）：让 LLM 先生成一段「理想答案」，用这段假想文档去向量检索

```python
from openai import OpenAI

client = OpenAI()

REWRITE_PROMPT = """你是检索查询优化器。根据对话历史和用户最新问题，
输出一个独立的、适合搜索引擎的查询（一行，不要解释）。

对话历史：
{history}

用户问题：{query}

检索查询："""

def rewrite_query(history: str, query: str) -> str:
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{
            "role": "user",
            "content": REWRITE_PROMPT.format(history=history, query=query),
        }],
        max_tokens=64,
        temperature=0,
    )
    return resp.choices[0].message.content.strip()
```

**什么时候不开 Rewrite**：单轮问答、查询本身已经很具体、延迟预算 < 500ms。Rewrite 多一次 LLM 调用，简单场景 ROI 不高。

## 生产环境的三个常见坑

### 1. 分块策略比检索算法影响更大

表格、代码块、列表被 RecursiveCharacterTextSplitter 从中间切断后，BM25 和向量都检索不到完整信息。生产建议：

- Markdown 按标题层级切（`##` 为边界）
- 代码块保持完整，不跨 chunk
- 每个 chunk 头部注入面包屑：`[文档名 > 章节名]`

### 2. Reranker 候选集不是越大越好

超过 50 条候选，Reranker 延迟线性增长但精度提升边际递减。双路各 Top-20 → RRF Top-30 → Rerank Top-5 是多数场景的最优平衡点。

### 3. 评测要分「召回」和「端到端」

| 评测层级 | 指标 | 工具 |
|---------|------|------|
| 召回 | Recall@K、MRR | 标注 query-doc 对，跑检索不看生成 |
| Rerank | NDCG@5 | Rerank 前后对比 |
| 端到端 | 答案正确率、幻觉率 | RAGAS / 自建 LLM-as-Judge |

只测端到端会把问题甩给 LLM——召回没召到，生成再好也没用。

## 选型建议

| 你的场景 | 推荐配置 |
|---------|---------|
| < 1 万文档、延迟敏感 | BM25 + 向量 + RRF，跳过 Reranker |
| 中英文混合、专有名词多 | 全四层 + jieba 分词 + bge-m3 |
| 多轮对话 Agent | 加 Query Rewrite + 对话历史窗口 |
| 纯英文技术文档 | BM25Okapi + e5-large + ms-marco reranker |
| 不想自托管 | Cohere embed + Cohere rerank API |

## 落地 Checklist

- [ ] 文档分块按 Markdown 结构切，chunk 带面包屑前缀
- [ ] BM25 中文分词（jieba / pkuseg）已接入
- [ ] 向量模型与 Reranker 语言域匹配（不要英文 embed + 中文 query）
- [ ] 双路召回 + RRF 融合，召回阶段有 Recall@10 基线
- [ ] Reranker 候选集 ≤ 50，输出 Top-5 给 LLM
- [ ] Query Rewrite 仅在多轮/消歧场景开启，有 fallback 直通
- [ ] 检索链路各阶段延迟可观测（BM25 / vector / rerank 分段打点）
- [ ] 每周抽检 20 条 query，对比「仅向量」vs「混合」的答案质量

纯向量 RAG 是 Demo 阶段的捷径，混合检索才是生产阶段的默认配置。四层架构看起来复杂，但每一层解决的是不同维度的失败模式——**BM25 保底精确匹配，向量兜底语义泛化，Reranker 做最后 10% 的精度提升，Rewrite 处理多轮上下文**。先把双路召回 + RRF 跑通，再按需加 Reranker 和 Rewrite，是最稳的演进路径。
