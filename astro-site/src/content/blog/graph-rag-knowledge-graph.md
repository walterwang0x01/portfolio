---
title: "GraphRAG 实战：当知识图谱遇上 RAG，多跳推理不再是难题"
date: 2026-04-21
tags: ["GraphRAG", "知识图谱", "RAG"]
excerpt: "传统 RAG 擅长语义匹配，却在多跳推理和全局摘要上力不从心。GraphRAG 通过引入知识图谱，让检索沿着实体关系链路进行，解锁了 RAG 的下一个能力层级。"
vip: false
draft: false
---
你用 RAG 搭了一个知识问答系统，效果还不错——直到用户问了一个这样的问题："LangGraph 的开发团队和 CrewAI 的开发团队之间有什么合作关系？"传统 RAG 傻眼了：它能分别检索到 LangGraph 和 CrewAI 的文档片段，但**无法理解实体之间的关系链路**。

这就是 **GraphRAG** 要解决的核心问题——将知识图谱（Knowledge Graph）引入 RAG 流程，让检索不再局限于"语义相似度匹配"，而是能沿着实体关系进行**多跳推理**和**跨文档全局摘要**。

## 传统 RAG 的天花板在哪里

标准 RAG 的流程是：文档分块 → 向量化 → 相似度检索 → 拼入 Prompt → LLM 生成回答。这个流程在"事实性单跳问答"上表现优秀，但有三个结构性短板：

-   **关系丢失**：文档被切成独立的 chunk 后，实体之间的关系信息被打散。"OpenAI 开发了 GPT-4o"这个关系可能分布在不同的 chunk 中
-   **多跳推理困难**：当答案需要"A → B → C"的推理链路时（比如"谁开发了 GPT-4o 的竞品？"），向量相似度搜索很难一次性找到完整链路
-   **全局摘要缺失**：问"AI Agent 领域的整体发展趋势是什么？"这类需要跨文档综合理解的问题，传统 RAG 只能返回局部片段，无法给出全局视角

```
传统 RAG 的局限：

用户问："MCP 协议的提出者还开发了哪些 AI 产品？"

检索结果：
  chunk_1: "MCP 是 Model Context Protocol 的缩写..."  ← 语义相关但没有答案
  chunk_2: "Anthropic 推出了 Claude 3.5..."           ← 有答案但未被检索到
  chunk_3: "MCP 支持 stdio 和 HTTP 传输..."           ← 语义相关但无关

问题：向量相似度无法建立 "MCP → Anthropic → Claude" 的推理链路
```

## GraphRAG 的核心思路

GraphRAG 在传统 RAG 的基础上增加了一层**知识图谱**。核心流程分为两个阶段：

### 离线构建阶段

从文档中提取实体和关系，构建知识图谱，同时保留原始的向量索引：

```
GraphRAG 索引构建：

原始文档
    │
    ├──→ 文本分块 → 向量化 → 向量数据库（传统路径）
    │
    └──→ LLM 实体/关系提取 → 知识图谱
              │
              ├── 实体节点：OpenAI、GPT-4o、Anthropic、Claude、MCP...
              ├── 关系边：开发、竞争、提出、支持...
              └── 社区检测 → 社区摘要（全局理解）
```

### 在线检索阶段

结合向量检索和图检索，获取更完整的上下文：

```
GraphRAG 检索流程：

用户问题
    │
    ├──→ 向量相似度检索 → 语义相关的文档片段
    │
    ├──→ 实体识别 → 图遍历（1-2 跳）→ 关系链路上下文
    │
    └──→ 社区摘要检索 → 全局概览信息
              │
              ▼
         合并去重 → 拼入 Prompt → LLM 生成回答
```

## 动手实现：实体关系提取

GraphRAG 的第一步是从文档中提取结构化的实体和关系。这里用 LLM 来完成：

```
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate

llm = ChatOpenAI(model="gpt-4o", temperature=0)

extraction_prompt = ChatPromptTemplate.from_template("""
从以下文本中提取实体和关系，以 JSON 格式输出。

文本：{text}

输出格式：
{{
  "entities": [
    {{"name": "实体名", "type": "类型", "description": "描述"}}
  ],
  "relationships": [
    {{"source": "实体A", "target": "实体B", "relation": "关系", "description": "描述"}}
  ]
}}
""")

text = """OpenAI 开发了 GPT-4o 模型，该模型支持多模态输入。
Anthropic 推出了 Claude 3.5，在代码生成方面表现优秀。
Anthropic 还提出了 MCP 协议，用于标准化 AI Agent 的工具连接。"""

result = (extraction_prompt | llm).invoke({"text": text})
print(result.content)
# 提取出：OpenAI→开发→GPT-4o, Anthropic→推出→Claude 3.5,
#         Anthropic→提出→MCP 等结构化关系
```

提取质量直接决定了 GraphRAG 的效果。实践中建议：对同一段文本做 2-3 次提取（`max_gleanings`），合并去重后入库，能显著提升召回率。

## Neo4j 存储与图查询

提取出的实体和关系需要存入图数据库。Neo4j 是最成熟的选择：

```
from neo4j import GraphDatabase

driver = GraphDatabase.driver(
    "bolt://localhost:7687", auth=("neo4j", "password")
)

def create_knowledge_graph(entities, relationships):
    """将提取的实体和关系存入 Neo4j"""
    with driver.session() as session:
        # 创建实体节点
        for entity in entities:
            session.run(
                "MERGE (e:Entity {name: $name}) "
                "SET e.type = $type, e.description = $desc",
                name=entity["name"],
                type=entity["type"],
                desc=entity["description"],
            )
        # 创建关系边
        for rel in relationships:
            session.run(
                """MATCH (a:Entity {name: $source}), (b:Entity {name: $target})
                   MERGE (a)-[r:RELATES {type: $relation}]->(b)
                   SET r.description = $desc""",
                source=rel["source"], target=rel["target"],
                relation=rel["relation"], desc=rel["description"],
            )

# 多跳图查询：找到实体的 1-2 跳关系
def graph_query(question: str) -> list:
    entities = extract_entities(question)  # 先从问题中提取实体
    with driver.session() as session:
        result = session.run("""
            MATCH (e:Entity)-[r*1..2]-(related:Entity)
            WHERE e.name IN $entities
            RETURN e.name AS source,
                   [rel IN r | type(rel)] AS relations,
                   related.name AS target,
                   related.description AS description
            LIMIT 20
        """, entities=entities)
        return [record.data() for record in result]
```

关键在于 `r*1..2` 这个语法——它让查询沿着关系边走 1 到 2 跳，这就是多跳推理的实现基础。

## Microsoft GraphRAG：开箱即用的方案

如果不想从零搭建，微软开源的 GraphRAG 框架提供了完整的端到端方案。它的核心创新是引入了**社区检测**机制：

```
# 安装：pip install graphrag

# 1. 初始化项目
# graphrag init --root ./my_project

# 2. 核心配置 settings.yaml
# llm:
#   model: gpt-4o
# chunks:
#   size: 300
#   overlap: 100
# entity_extraction:
#   max_gleanings: 1      # 多次提取提升召回率
# community_reports:
#   max_length: 2000      # 社区摘要长度

# 3. 构建索引（自动完成实体提取、关系构建、社区检测）
# graphrag index --root ./my_project

# 4. 两种查询模式
# 局部查询：特定实体相关的精确问答
# graphrag query --method local --query "MCP 协议的核心特点"

# 全局查询：跨文档的全局摘要
# graphrag query --method global --query "AI Agent 的发展趋势"
```

微软 GraphRAG 的**社区检测**是它区别于简单"图 + RAG"的关键。它使用 Leiden 算法将知识图谱中的实体聚类为社区，然后为每个社区生成摘要。当用户问全局性问题时，系统检索的是社区摘要而不是原始文档片段，这就解决了传统 RAG 无法做全局摘要的问题。

## 图 + 向量混合检索：最佳实践

生产环境中，最有效的方案是将图检索和向量检索结合起来：

```
from langchain_community.graphs import Neo4jGraph
from langchain_community.vectorstores import Neo4jVector
from langchain_openai import OpenAIEmbeddings

# Neo4j 同时支持图查询和向量搜索
graph = Neo4jGraph(
    url="bolt://localhost:7687",
    username="neo4j", password="password"
)

vector_store = Neo4jVector.from_existing_graph(
    embedding=OpenAIEmbeddings(model="text-embedding-3-small"),
    node_label="Entity",
    text_node_properties=["name", "description"],
    embedding_node_property="embedding",
)

def hybrid_graph_retrieval(question: str) -> str:
    """图 + 向量混合检索"""
    # 1. 向量相似度检索（语义匹配）
    vector_results = vector_store.similarity_search(question, k=5)

    # 2. 图结构检索（关系遍历）
    graph_results = graph.query("""
        MATCH (e:Entity)-[r]->(related)
        WHERE e.name CONTAINS $keyword
        RETURN e.name, type(r), related.name, related.description
        LIMIT 10
    """, params={"keyword": extract_keyword(question)})

    # 3. 合并去重，构建上下文
    context = merge_and_deduplicate(vector_results, graph_results)
    return context
```

这种混合方案的优势在于：向量检索负责语义匹配（找到"说法不同但意思相近"的内容），图检索负责关系推理（找到"语义不相似但逻辑相关"的内容）。两者互补，覆盖面远超单一方案。

## 什么时候该用 GraphRAG

GraphRAG 不是银弹，它的构建成本（LLM 提取实体的 token 消耗）和维护成本（图谱更新）都比传统 RAG 高。选型建议：

```
你的场景适合哪种 RAG？

├── 单文档事实性问答、实体关系简单
│   └── ✅ 传统 RAG 足够（向量检索 + Reranking）
│
├── 多实体关系复杂（医疗、法律、金融、技术文档）
│   └── ✅ GraphRAG
│
├── 需要多跳推理（"A 的合作伙伴的竞品是什么？"）
│   └── ✅ GraphRAG
│
├── 需要跨文档全局摘要（"这个领域的整体趋势？"）
│   └── ✅ GraphRAG（社区摘要机制）
│
└── 知识库更新频繁、实时性要求高
    └── ⚠️ 谨慎使用 GraphRAG（图谱重建成本高）
    └── 考虑增量更新策略或传统 RAG + 查询改写
```

## GraphRAG 的成本与优化

GraphRAG 最大的成本在于索引构建阶段——每个文档 chunk 都需要调用 LLM 提取实体和关系。几个实用的优化策略：

1.  **分层提取**：先用小模型（如 GPT-4o-mini）做粗提取，再用大模型对高价值文档做精提取
2.  **增量更新**：新文档只提取新增实体和关系，与现有图谱合并，避免全量重建
3.  **社区缓存**：社区摘要生成后缓存，只在图谱结构显著变化时重新生成
4.  **选择性构建**：不是所有文档都需要 GraphRAG，对关系密集的核心文档用 GraphRAG，其余用传统 RAG

## 写在最后

GraphRAG 代表了 RAG 技术的一个重要演进方向：从"基于语义相似度的被动检索"走向"基于知识结构的主动推理"。它不会替代传统 RAG，而是在特定场景下提供了传统 RAG 无法达到的能力——多跳推理、全局摘要、关系感知。

如果你的知识库中实体关系复杂、用户经常问需要跨文档推理的问题，GraphRAG 值得认真评估。从微软的开源框架开始，搭一个 POC 验证效果，再决定是否投入生产。

> 我的 [GitHub 仓库](https://github.com/WalterHandsome/tech-learning-and-projects) 中有 4 篇 RAG 进阶笔记，从基础架构、向量数据库选型、高级 RAG 策略到 GraphRAG 知识图谱，完整覆盖 RAG 技术栈的各个层面。
