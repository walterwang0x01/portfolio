---
title: "RAG 从入门到进阶：让 LLM 拥有你的私有知识库"
date: 2026-04-18
tags: ["RAG", "向量数据库"]
excerpt: "RAG 是让 LLM 突破训练数据限制的关键技术。从基础架构到高级优化策略，一篇文章带你掌握 RAG 的核心要点。"
vip: false
draft: false
---
LLM 的知识有截止日期，也不了解你的私有数据。**RAG（Retrieval-Augmented Generation，检索增强生成）**就是解决这个问题的核心技术——先从知识库中检索相关信息，再把检索结果作为上下文送给 LLM 生成回答。

RAG 是目前 AI Agent 应用中使用最广泛的技术之一，几乎每个企业级 Agent 都离不开它。

## RAG 基础架构

一个标准的 RAG 系统包含两个阶段：

### 离线索引阶段

```
原始文档 → 文档加载 → 文本分块 → 向量化（Embedding） → 存入向量数据库

# 示例：用 LangChain 构建索引
from langchain_community.document_loaders import DirectoryLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma

# 1. 加载文档
loader = DirectoryLoader("./notes", glob="**/*.md")
docs = loader.load()

# 2. 分块
splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)
chunks = splitter.split_documents(docs)

# 3. 向量化并存储
vectorstore = Chroma.from_documents(
    documents=chunks,
    embedding=OpenAIEmbeddings(),
    persist_directory="./chroma_db"
)
```

### 在线检索阶段

```
用户提问 → 问题向量化 → 向量相似度搜索 → 取 Top-K 结果 → 拼入 Prompt → LLM 生成回答

# 示例：检索并生成
retriever = vectorstore.as_retriever(search_kwargs={"k": 3})
relevant_docs = retriever.invoke("MCP 协议的核心架构是什么？")

prompt = f"""基于以下参考资料回答问题：

{format_docs(relevant_docs)}

问题：MCP 协议的核心架构是什么？"""

response = llm.invoke(prompt)
```

## 文本分块策略

分块是 RAG 中最容易被低估但影响最大的环节：

-   **固定大小分块**：简单粗暴，按字符数切分。适合结构均匀的文档
-   **递归分块**：按段落 → 句子 → 字符逐级切分，保持语义完整性。**推荐作为默认选择**
-   **语义分块**：用 Embedding 计算相邻句子的语义相似度，在语义断裂处切分。效果最好但成本较高
-   **文档结构分块**：按 Markdown 标题、HTML 标签等文档结构切分。适合结构化文档

> 经验法则：chunk\_size 设为 500-1000 个字符，chunk\_overlap 设为 chunk\_size 的 10%-20%。但最终要根据你的数据和场景调优。

## 向量数据库选型

三个主流选择的快速对比：

-   **Chroma**：轻量级，嵌入式，Python 原生。适合原型开发和小规模应用
-   **pgvector**：PostgreSQL 扩展，SQL 查询 + 向量搜索一体化。适合已有 PG 基础设施的团队
-   **Pinecone**：全托管云服务，开箱即用。适合不想运维的团队，但成本较高

个人建议：**原型用 Chroma，生产用 pgvector**。pgvector 的优势在于你不需要引入新的基础设施，直接在现有 PostgreSQL 上加个扩展就行。

## 高级 RAG 优化策略

### 1\. 查询改写（Query Rewriting）

用户的原始问题往往不适合直接做向量检索。可以用 LLM 先改写查询：

```
# 多查询策略：一个问题生成多个检索查询
def multi_query_retrieve(question: str) -> list:
    queries = llm.invoke(f"""
        请为以下问题生成 3 个不同角度的检索查询：
        问题：{question}
    """)
    all_docs = []
    for q in queries:
        all_docs.extend(retriever.invoke(q))
    return deduplicate(all_docs)
```

### 2\. 重排序（Re-ranking）

向量相似度搜索的结果不一定是最相关的。用 Cross-Encoder 模型对初步检索结果做重排序，能显著提升准确率。

### 3\. 混合检索（Hybrid Search）

结合向量检索（语义匹配）和关键词检索（BM25 精确匹配），取两者的交集或并集。对于包含专有名词、代码、ID 等精确信息的场景特别有效。

### 4\. GraphRAG

当你的知识库中实体之间有复杂关系时（比如"A 依赖 B，B 被 C 替代了"），传统 RAG 很难处理多跳推理。GraphRAG 通过构建知识图谱，让检索能沿着关系链路进行。这是 RAG 的前沿方向。

## RAG 评估

怎么知道你的 RAG 系统好不好？关注这几个指标：

-   **检索召回率**：相关文档是否被检索到了
-   **检索精确率**：检索到的文档中有多少是真正相关的
-   **答案忠实度**：生成的回答是否忠于检索到的内容（不是幻觉）
-   **答案相关性**：生成的回答是否真正回答了用户的问题

推荐使用 RAGAS 框架做自动化评估，它提供了上述指标的标准化计算方法。

> RAG 看似简单，但要做好需要在分块、检索、重排序、生成每个环节都精心调优。我的 [GitHub 仓库](https://github.com/WalterHandsome/tech-learning-and-projects) 中有 4 篇 RAG 进阶笔记，从基础架构到 GraphRAG 都有覆盖。
