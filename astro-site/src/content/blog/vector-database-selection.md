---
title: "向量数据库选型实战：pgvector vs Chroma vs Pinecone，选错了代价很大"
date: 2026-04-23
tags: ["向量数据库", "RAG", "基础设施"]
excerpt: "向量数据库是 RAG 和 AI Agent 的核心基础设施，但六大主流方案各有取舍。这篇文章从实际场景出发，拆解 pgvector、Chroma、Pinecone、Qdrant、Milvus、Weaviate 的真实差异，帮你避开选型踩坑。"
vip: false
draft: false
---
你搭了一个 RAG 系统，用 Chroma 存向量，Demo 跑得很顺。然后数据量从 1 万条涨到 100 万条，查询延迟从 50ms 飙到 2 秒，过滤条件一加就更慢——这时候你才意识到，**向量数据库的选型在项目初期就决定了后期的天花板**。

2026 年，向量数据库已经从 AI 应用的辅助工具演变为关键基础设施。市场上有六个主流选择，每个都有明确的定位和适用边界。这篇文章不做泛泛的功能罗列，而是从**真实的工程决策场景**出发，帮你搞清楚：什么时候该用哪个，为什么。

## 先搞清楚：向量数据库在 RAG 中扮演什么角色

在 RAG（检索增强生成）流程中，向量数据库处于核心位置——它负责存储文档的向量表示，并在用户查询时快速找到语义最相关的内容：

```
RAG 核心流程：

文档 → 分块 → Embedding 模型 → 向量 → [向量数据库] ← 存储
                                                    ↕
用户查询 → Embedding → 相似度检索 → [向量数据库] → Top-K 结果 → LLM 生成回答
```

向量数据库的性能直接决定了三件事：**检索速度**（用户等多久）、**检索质量**（找到的内容是否相关）、**可扩展性**（数据量增长后还能不能用）。选错了，后期迁移的成本远比你想象的高。

## 六大主流方案一览

先看全景，再逐个拆解：

```
| 方案       | 类型       | 实现语言  | 混合搜索 | 扩展性 | 适用场景         |
|-----------|-----------|----------|---------|-------|-----------------|
| Chroma    | 嵌入式     | Python   | ❌      | 单机   | 原型开发、小数据量 |
| pgvector  | PG 扩展    | C        | 有限    | 单机   | 已有 PostgreSQL  |
| Pinecone  | 全托管 SaaS | -       | ✅      | 自动   | 零运维、生产 SaaS |
| Qdrant    | 自托管/云   | Rust    | ✅      | 水平   | 高性能生产环境    |
| Milvus    | 自托管/云   | Go/C++  | ✅      | 水平   | 亿级大规模数据    |
| Weaviate  | 自托管/云   | Go      | ✅      | 水平   | 语义搜索、多模态  |
```

接下来按"从简单到复杂"的顺序，逐个分析它们的核心特点和适用边界。

## Chroma：原型阶段的最佳选择

Chroma 是一个嵌入式向量数据库，用 Python 写的，零配置，`pip install chromadb` 就能用。它的定位很明确：**让你在 5 分钟内跑通 RAG 流程**。

```
import chromadb
from chromadb.utils import embedding_functions

# 创建持久化客户端
client = chromadb.PersistentClient(path="./chroma_db")

# 使用 OpenAI Embedding
ef = embedding_functions.OpenAIEmbeddingFunction(
    api_key="sk-xxx",
    model_name="text-embedding-3-small",
)

# 创建集合
collection = client.get_or_create_collection(
    name="documents",
    embedding_function=ef,
    metadata={"hnsw:space": "cosine"},  # 余弦距离
)

# 添加文档（自动向量化）
collection.add(
    documents=["AI Agent 是自主决策的智能系统", "RAG 结合检索与生成"],
    metadatas=[{"source": "doc1"}, {"source": "doc2"}],
    ids=["id1", "id2"],
)

# 查询
results = collection.query(query_texts=["什么是 Agent"], n_results=3)
```

**优势**：学习曲线极低，嵌入式运行无需部署，自动处理 Embedding，适合教学和快速验证想法。

**局限**：不支持混合搜索（向量 + 关键词），单机架构无法水平扩展，元数据过滤能力有限。当数据量超过 10 万条或需要复杂过滤时，性能会明显下降。

> 适用场景：个人项目、Demo 演示、教学、数据量 < 10 万条的小型应用。不适合生产环境。

## pgvector：已有 PostgreSQL 就用它

pgvector 是 PostgreSQL 的向量搜索扩展。如果你的项目已经在用 PostgreSQL，它是最务实的选择——**不需要引入新的数据库组件**，一个 `CREATE EXTENSION vector` 就搞定。

```
-- 启用扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 创建表（向量和业务数据在同一张表）
CREATE TABLE documents (
    id SERIAL PRIMARY KEY,
    content TEXT,
    metadata JSONB,
    embedding vector(1536)  -- 1536 维向量
);

-- 创建 HNSW 索引（推荐，比 IVFFlat 更快）
CREATE INDEX ON documents
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 相似度搜索 + SQL 过滤（这是 pgvector 的杀手锏）
SELECT content,
       1 - (embedding <=> query_vector::vector) AS similarity
FROM documents
WHERE metadata->>'category' = 'ai-agent'
  AND created_at > '2026-01-01'
ORDER BY embedding <=> query_vector::vector
LIMIT 5;
```

**杀手锏**：向量搜索和 SQL 查询在同一个事务中完成。你可以用 `WHERE`、`JOIN`、`GROUP BY` 等所有 SQL 能力来过滤和聚合向量搜索结果，这是专用向量数据库做不到的。

**局限**：单机架构，向量规模超过千万级后性能下降明显。混合搜索（向量 + 全文检索）需要额外配置 `tsvector`，不如 Qdrant/Weaviate 原生支持来得方便。

> 适用场景：已有 PostgreSQL 基础设施、数据量 < 500 万条、需要向量搜索与业务查询联动的场景。

## Pinecone：花钱买省心

Pinecone 是唯一的纯 SaaS 全托管方案。你不需要管服务器、不需要调参数、不需要操心扩容——**给钱就行**。

它的核心价值不在于性能最强（不是），而在于**运维成本为零**。对于没有专职基础设施团队的创业公司或 SaaS 产品，这个价值是实打实的。

**优势**：全托管零运维，自动扩展，支持混合搜索（稠密 + 稀疏向量），Serverless 模式按用量计费，适合流量波动大的场景。

**局限**：数据存在第三方（合规敏感行业可能不接受），成本随数据量线性增长（大规模场景下比自托管贵很多），供应商锁定风险。

> 适用场景：创业公司、SaaS 产品、没有基础设施团队、对数据合规要求不高的场景。

## Qdrant：性能与易用性的平衡点

Qdrant 用 Rust 实现，在性能和 API 易用性之间找到了很好的平衡。它是目前**中等规模生产环境**（百万到千万级向量）的最佳选择之一。

```
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct,
    Filter, FieldCondition, MatchValue,
)

client = QdrantClient(host="localhost", port=6333)

# 创建集合（支持多向量字段）
client.create_collection(
    collection_name="knowledge_base",
    vectors_config={
        "dense": VectorParams(size=1536, distance=Distance.COSINE),
    },
    sparse_vectors_config={
        "sparse": {},  # BM25 稀疏向量，用于关键词匹配
    },
)

# 混合搜索：向量语义 + 关键词匹配 + 元数据过滤
results = client.query_points(
    collection_name="knowledge_base",
    prefetch=[
        {"query": dense_vector, "using": "dense", "limit": 20},
        {"query": sparse_vector, "using": "sparse", "limit": 20},
    ],
    query={"fusion": "rrf"},  # Reciprocal Rank Fusion 融合排序
    query_filter=Filter(must=[
        FieldCondition(key="source", match=MatchValue(value="official_docs"))
    ]),
    limit=5,
)
```

**核心优势**：Rust 实现带来的高性能和低内存占用；原生混合搜索（RRF 融合）；丰富的过滤条件（嵌套、范围、地理位置）；支持水平扩展。

**局限**：社区规模不如 Milvus，企业级功能（RBAC、审计日志）需要付费版。

> 适用场景：需要高性能 + 混合搜索的生产环境，数据量在百万到千万级，团队有基本的运维能力。

## Milvus 和 Weaviate：大规模与多模态

简要提两个适用于特定场景的方案：

-   **Milvus**：分布式架构，支持 GPU 加速，专为**亿级向量**设计。如果你的数据量在千万级以上，Milvus 几乎是唯一的开源选择。代价是部署和运维复杂度高（依赖 etcd、MinIO、Pulsar 等组件）
-   **Weaviate**：模块化架构，原生支持**多模态**（文本、图片、音频的向量可以存在同一个集合中）。如果你的应用涉及图片搜索或跨模态检索，Weaviate 是最自然的选择

## 选型决策树：三个问题定方案

不需要看完所有文档，回答三个问题就能锁定方案：

```
问题 1：你现在是什么阶段？
├── 原型验证 / 学习
│   └── → Chroma（零配置，5 分钟上手）
└── 生产环境
    │
    问题 2：你已有什么基础设施？
    ├── 已有 PostgreSQL，数据量 < 500 万
    │   └── → pgvector（零新增组件）
    ├── 不想管服务器
    │   └── → Pinecone（全托管 SaaS）
    └── 愿意自己部署
        │
        问题 3：数据规模多大？
        ├── 百万 ~ 千万级
        │   └── → Qdrant（性能 + 易用性最佳平衡）
        └── 亿级以上
            └── → Milvus（分布式，GPU 加速）
```

这个决策树覆盖了 90% 的场景。剩下 10% 的特殊需求（多模态搜索选 Weaviate，GraphQL 生态选 Weaviate）按具体情况判断。

## 混合搜索：生产环境的标配

纯向量搜索有一个常被忽视的问题：**它对精确关键词匹配不敏感**。用户搜"MCP 协议"，向量搜索可能返回"Agent 通信标准"（语义相关但没提到 MCP），而漏掉标题就是"MCP 协议详解"的文档。

解决方案是混合搜索——同时使用**稠密向量**（语义匹配）和**稀疏向量**（关键词匹配），用 RRF（Reciprocal Rank Fusion）融合排序：

```
混合搜索流程：

用户查询："MCP 协议的传输方式"
    │
    ├── 稠密向量检索（语义）→ 找到"Agent 工具连接标准"、"协议传输层设计"
    │
    ├── 稀疏向量检索（BM25）→ 找到"MCP 协议详解"、"MCP stdio 传输"
    │
    └── RRF 融合排序 → 综合排名，两种检索的优势互补
                    → 最终结果既语义相关，又包含精确关键词匹配
```

Qdrant、Pinecone、Weaviate、Milvus 都原生支持混合搜索。pgvector 需要手动组合 `vector` 和 `tsvector`。Chroma 不支持。这也是为什么**生产环境不建议用 Chroma**的重要原因之一。

## 性能优化：三个立竿见影的技巧

1.  **选对索引类型**：HNSW（Hierarchical Navigable Small World）是目前最主流的近似最近邻索引，在召回率和速度之间有很好的平衡。pgvector 中用 `CREATE INDEX USING hnsw`，Qdrant 和 Milvus 默认就是 HNSW
2.  **降维**：OpenAI 的 `text-embedding-3-small` 输出 1536 维，但很多场景下降到 512 维或 256 维，召回率只下降 1-2%，而存储和查询速度提升 3-6 倍。Pinecone 和 Qdrant 都支持在查询时指定维度
3.  **预过滤 vs 后过滤**：如果你的查询总是带元数据过滤条件（比如 `category = 'ai-agent'`），确保数据库在向量搜索**之前**就过滤掉不相关的数据（预过滤），而不是先搜索再过滤（后过滤）。Qdrant 和 Milvus 默认是预过滤，pgvector 需要注意查询计划

## 迁移成本：选型时最容易忽略的因素

向量数据库的迁移成本比你想象的高。不只是数据搬迁——你还需要：

-   重新生成所有向量（如果 Embedding 模型或维度变了）
-   重写所有查询逻辑（每个数据库的 API 完全不同）
-   重新调优索引参数（HNSW 的 `m` 和 `ef` 参数在不同数据库上表现不同）
-   重新做性能基准测试

所以，**选型时多花一天做调研，比上线后花一周做迁移划算得多**。如果你不确定未来的数据规模，建议直接从 Qdrant 或 pgvector 开始，而不是从 Chroma 开始再迁移。

## 写在最后

向量数据库选型没有"最好的"，只有"最适合你当前场景的"。但有一条通用建议：**不要在原型阶段做生产级的选型，也不要在生产环境用原型级的工具**。

如果你刚开始学 RAG，用 Chroma 快速上手，理解核心流程。当你准备上生产时，根据团队的基础设施和数据规模，在 pgvector、Qdrant、Pinecone 中选一个。亿级数据才需要考虑 Milvus。

> 我的 [GitHub 仓库](https://github.com/WalterHandsome/tech-learning-and-projects) 中有完整的向量数据库选型笔记和 RAG 进阶系列（4 篇），覆盖 RAG 架构、向量数据库对比、高级检索策略和 GraphRAG，以及可运行的 [RAG + LLM Agent 平台](https://github.com/WalterHandsome/tech-learning-and-projects/tree/main/rag-llm-agent-platform) 实战项目。
