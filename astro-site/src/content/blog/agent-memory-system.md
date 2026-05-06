---
title: "AI Agent 记忆系统：从「金鱼记忆」到「过目不忘」的工程实践"
date: 2026-04-24
tags: ["AI Agent", "记忆系统", "Agent 框架"]
excerpt: "没有记忆的 Agent 就是一条金鱼——每次对话都从零开始。这篇文章从记忆架构设计出发，拆解短期/长期/图记忆的工程实现，对比 Mem0、Letta、Zep、LangMem 四大框架，帮你为 Agent 装上真正的大脑。"
vip: false
draft: false
---
你搭了一个 AI Agent，Demo 演示很惊艳。然后用户第二天回来说"继续昨天的话题"，Agent 一脸茫然——它什么都不记得了。

这不是 LLM 的问题，而是**你没有给 Agent 设计记忆系统**。LLM 本身是无状态的，每次推理都是独立的。上下文窗口看起来像"记忆"，但它只是当前请求的输入缓冲区，关掉窗口就没了。

2026 年，Agent 记忆已经从"锦上添花"变成了**生产级 Agent 的必备基础设施**。这篇文章从工程视角出发，帮你搞清楚：Agent 需要什么样的记忆、怎么实现、用什么框架。

## 为什么 Agent 需要记忆？

先看一个对比：

```
没有记忆的 Agent：
用户："我叫张三，是 Python 开发者"
Agent："你好张三！"
用户："帮我推荐技术书"
Agent："请问你是做什么方向的？"  ← 刚说过的信息就忘了

有记忆的 Agent：
用户："帮我推荐技术书"
Agent：（检索记忆：张三，Python 开发者，在学 AI Agent）
Agent："基于你的 Python 背景和 AI Agent 学习方向，推荐..."
```

记忆让 Agent 具备三个关键能力：

-   **个性化**：记住用户偏好、历史行为，提供定制化服务
-   **连续性**：跨会话保持上下文，不需要用户重复说明
-   **学习能力**：从历史交互中积累经验，持续改进

## 记忆系统的三层架构

类比人类的记忆机制，Agent 的记忆系统可以分为三层：

```
┌─────────────────────────────────────────┐
│            Agent 记忆系统                 │
├──────────────┬──────────────────────────┤
│   短期记忆    │       长期记忆            │
│ Short-term   │     Long-term            │
├──────────────┼────────────┬─────────────┤
│ 对话缓冲     │ 向量记忆    │ 图记忆       │
│ 对话摘要     │ 经验存储    │ 实体关系     │
│ 滑动窗口     │ 语义检索    │ 时序追踪     │
└──────────────┴────────────┴─────────────┘
```

### 第一层：短期记忆——对话上下文管理

短期记忆解决的是**当前会话内**的上下文保持问题。最直接的方式是把完整对话历史塞进上下文窗口，但这在长对话中会迅速撑爆 token 限制。

三种常用策略：

-   **滑动窗口**：只保留最近 N 轮对话，简单粗暴但会丢失早期信息
-   **摘要压缩**：用 LLM 将旧对话压缩为摘要，保留关键信息的同时节省 token
-   **中间截断**：保留开头（系统提示 + 最早几轮）和结尾（最近几轮），截断中间部分

```
# 渐进式摘要压缩——生产环境推荐方案
class ConversationCompressor:
    def __init__(self, llm, compress_threshold=15):
        self.llm = llm
        self.compressed_summary = ""
        self.recent_messages = []
        self.compress_threshold = compress_threshold

    async def add_and_compress(self, message):
        self.recent_messages.append(message)
        if len(self.recent_messages) > self.compress_threshold:
            to_compress = self.recent_messages[:10]
            prompt = f"""当前摘要：{self.compressed_summary}
新对话内容：{to_compress}
请更新摘要，保留关键信息（用户偏好、决策、重要数据）："""
            result = await self.llm.ainvoke(prompt)
            self.compressed_summary = result.content
            self.recent_messages = self.recent_messages[10:]
```

这种方案的好处是**记忆容量理论上无限**——旧对话不断被压缩为摘要，新对话持续追加，token 消耗始终可控。

### 第二层：长期记忆——向量语义检索

长期记忆解决的是**跨会话**的信息持久化问题。核心思路是把重要信息向量化后存入向量数据库，需要时通过语义搜索召回。

```
# 基于向量的长期记忆
class VectorMemory:
    def __init__(self):
        self.store = Chroma(
            collection_name="agent_memory",
            embedding_function=OpenAIEmbeddings(
                model="text-embedding-3-small"
            ),
        )

    def store_memory(self, content, metadata=None):
        """存储记忆"""
        self.store.add_texts(
            texts=[content],
            metadatas=[metadata or {}],
        )

    def recall(self, query, k=5):
        """语义检索相关记忆"""
        docs = self.store.similarity_search(query, k=k)
        return [doc.page_content for doc in docs]

# 使用
memory = VectorMemory()
memory.store_memory("用户偏好：喜欢简洁的代码风格", {"type": "preference"})
memory.store_memory("上次讨论了 RAG 架构设计", {"type": "topic"})
relevant = memory.recall("代码风格建议")  # 语义匹配，不需要精确关键词
```

向量记忆的优势是**语义理解**——用户问"编码习惯"也能匹配到"代码风格偏好"。但它也有局限：不擅长追踪实体间的关系和时间变化。

### 第三层：图记忆——实体关系与时序追踪

图记忆用知识图谱追踪实体间的关系，并感知时间变化。这是向量记忆做不到的：

```
# 图记忆自动提取实体和关系
m.add("张三是 AI 团队的负责人，他管理李四和王五", user_id="org")
m.add("李四负责 RAG 模块开发", user_id="org")
m.add("张三下周要离职，李四接任负责人", user_id="org")

# 图记忆构建的知识图谱：
# 张三 --[管理]--> 李四（已过期）
# 张三 --[管理]--> 王五（已过期）
# 李四 --[负责]--> RAG 模块
# 李四 --[接任]--> AI 团队负责人（当前有效）

# 时序感知：知道"张三管理李四"已经是历史事实
```

图记忆在需要**多跳推理**的场景中特别有价值。比如用户问"谁现在负责 RAG 模块的上级是谁"，向量搜索很难回答，但图记忆可以沿着关系链推理出来。

## 四大记忆框架对比

2026 年，Agent 记忆领域有四个主流框架，各有明确定位：

```
| 框架     | 定位           | 记忆管理方式    | 图记忆 | 时序感知 | 学习曲线 |
|---------|---------------|---------------|-------|---------|---------|
| Mem0    | 通用记忆层      | 框架自动提取    | ✅ 云  | ✅      | 低      |
| Letta   | 有状态Agent运行时| Agent自主管理   | ❌    | ❌      | 中高    |
| Zep     | 上下文工程平台   | 自动提取+图谱   | ✅    | ✅ 核心  | 低      |
| LangMem | LangGraph记忆库 | 自动/工具      | ❌    | ❌      | 中      |
```

### Mem0：最快上手的通用记忆层

Mem0 的定位是"给任何 LLM 应用加记忆"，API 极简，5 分钟集成：

```
from mem0 import Memory

m = Memory()

# 添加记忆（自动提取关键信息）
m.add("我是 Python 后端开发者，喜欢用 FastAPI", user_id="alice")
m.add("我正在学习 AI Agent，用的是 LangGraph", user_id="alice")

# 搜索相关记忆
results = m.search("她用什么技术栈？", user_id="alice")
# → ["Python 后端开发者，使用 FastAPI",
#    "正在学习 LangGraph"]
```

Mem0 v2.0 的新算法在 LoCoMo 基准上从 71.4 提升到 91.6，Agent 记忆召回率从 46% 提升到 100%，同时 token 消耗降低 3-4 倍。它还支持 user / agent / session 三级记忆隔离，以及 MCP 集成（9 个记忆工具）。

**适用场景**：快速为现有 Agent 添加记忆能力，不想引入复杂基础设施。

### Letta：Agent 自己管理自己的记忆

Letta（前身 MemGPT）的核心理念来自操作系统——Agent 通过"系统调用"自主读写记忆，就像程序管理内存一样：

```
# Letta 的三层记忆架构（类比操作系统）
# CPU 寄存器  ←→  System Prompt（固定指令）
# L1 Cache   ←→  Core Memory（核心记忆，上下文窗口内）
# RAM        ←→  Recall Memory（回忆记忆，近期对话索引）
# 磁盘       ←→  Archival Memory（归档记忆，向量数据库）

# Agent 通过函数调用自主管理记忆：
# core_memory_append("human", "正在学习 Rust")
# core_memory_replace("human", "职业：工程师", "职业：AI工程师")
# archival_memory_insert("项目使用 K8s 部署，500+ 节点")
# archival_memory_search("项目架构")
```

Letta 最新的 Memory Omni-Tool 允许 Agent 动态创建和删除记忆块，不再局限于固定的记忆架构。它还提供 ADE（Agent Development Environment）可视化界面，可以实时查看 Agent 的内部思考过程和记忆状态。

**适用场景**：需要 Agent 深度自主管理记忆的场景，比如长期陪伴型助手、个性化教学 Agent。

### Zep：时序感知的知识图谱记忆

Zep 的核心引擎 Graphiti 是一个时序感知的知识图谱引擎，它不只记住事实，还追踪事实的**时间有效性**：

```
# Zep 自动提取事实并追踪时间变化
zep.memory.add(session_id="s1", messages=[
    {"role_type": "user", "content": "我刚从阿里跳槽到字节，做 AI 平台"},
])

# Zep 自动生成带时间戳的事实：
# {"fact": "Alice 在字节跳动工作", "created_at": "2026-04-24"}
# {"fact": "Alice 之前在阿里巴巴", "valid_until": "2026-04-24"}
# → 知道"在阿里工作"已经是历史事实
```

Zep 已经从单纯的记忆层升级为"上下文工程平台"，结合 Graph RAG、时序图谱和自动化上下文组装。Graphiti 引擎开源，支持 MCP Server 集成。

**适用场景**：需要时序感知和实体关系追踪的场景，比如 CRM Agent、企业知识管理。

### LangMem：LangGraph 生态的原生选择

如果你已经在用 LangGraph，LangMem 是最自然的记忆方案。它支持三种记忆类型：

-   **语义记忆（Semantic）**：事实和知识，如"用户精通 Python"
-   **程序记忆（Procedural）**：学到的规则，如"回答时使用中文"
-   **情景记忆（Episodic）**：具体经历，如"上次帮用户调试了 OOM 问题"

LangMem 与 LangGraph 的 State 和 Store 机制深度集成，记忆的读写可以直接嵌入图节点中。

**适用场景**：已经使用 LangGraph 构建 Agent，需要原生记忆支持。

## 选型决策树

回答两个问题就能锁定方案：

```
问题 1：你用什么 Agent 框架？
├── LangGraph
│   └── → LangMem（原生集成，零额外依赖）
└── 其他框架 / 自研
    │
    问题 2：你需要什么级别的记忆能力？
    ├── 快速添加基础记忆
    │   └── → Mem0（API 最简，5 分钟集成）
    ├── 时序感知 + 实体图谱
    │   └── → Zep / Graphiti（时序知识图谱）
    └── Agent 自主管理记忆
        └── → Letta（OS 式记忆架构）
```

## 生产环境的记忆设计模式

框架选好了，还有几个工程问题需要解决：

### 1\. 记忆的分层检索

生产环境中，不要只用单一记忆源。推荐的模式是**多源融合检索**：

```
class MemoryRetriever:
    """综合记忆检索：结合多种记忆源"""
    def __init__(self, summary_mem, vector_mem, entity_mem):
        self.summary = summary_mem
        self.vector = vector_mem
        self.entity = entity_mem

    def retrieve(self, query):
        context_parts = []
        # 1. 实体记忆（精确匹配）
        entity_ctx = self.entity.get_context()
        if entity_ctx:
            context_parts.append(entity_ctx)
        # 2. 向量记忆（语义相关）
        relevant = self.vector.recall(query, k=3)
        if relevant:
            context_parts.append("相关记忆：\n" + "\n".join(relevant))
        # 3. 对话摘要（全局上下文）
        summary = self.summary.get_context()
        if summary:
            context_parts.append(summary)
        return "\n\n".join(context_parts)
```

### 2\. 记忆的生命周期管理

记忆不是存了就完事。你需要考虑：

-   **过期清理**：用户偏好会变，旧记忆需要标记为历史或删除
-   **冲突解决**：用户说"我换了工作"，新记忆要覆盖旧记忆
-   **隐私合规**：用户要求删除数据时，记忆系统必须支持彻底清除
-   **容量控制**：设置记忆上限，定期合并和压缩低价值记忆

### 3\. 记忆的可观测性

你需要能回答这些问题：Agent 记住了什么？为什么召回了这条记忆？记忆是否准确？建议在记忆系统中加入日志和审计能力，记录每次记忆的写入、更新、检索和删除操作。

## 经验回放：让 Agent 从历史中学习

记忆系统的高级用法是**经验回放（Experience Replay）**——记录 Agent 的成功和失败经验，在遇到类似任务时自动参考：

```
class ExperienceStore:
    def record(self, task, plan, result, success, feedback=""):
        """记录一次执行经验"""
        text = f"任务：{task}\n方案：{plan}\n" \
               f"结果：{'成功' if success else '失败'}\n经验：{feedback}"
        self.store.add_texts(texts=[text], metadatas=[{
            "task": task, "success": success,
            "timestamp": datetime.now().isoformat(),
        }])

    def recall_similar(self, task, k=3, success_only=True):
        """检索类似任务的历史经验"""
        filter_dict = {"success": True} if success_only else None
        return self.store.similarity_search(task, k=k, filter=filter_dict)

# 新任务时自动参考历史经验
past = exp_store.recall_similar("分析用户行为数据")
# → 找到"分析销售数据"的成功经验：用 pandas groupby 比循环快 10 倍
```

经验回放让 Agent 具备了**持续学习**的能力——不是通过微调模型，而是通过积累和检索结构化的执行经验。

## 写在最后

记忆系统是 Agent 从"Demo 玩具"进化为"生产工具"的关键一步。没有记忆的 Agent 永远停留在"一次性对话"的层面，有了记忆，Agent 才能真正理解用户、积累经验、持续进化。

建议的落地路径：**先用 Mem0 或 LangMem 快速加上基础记忆 → 验证业务价值 → 根据需求升级到 Zep（时序图谱）或 Letta（自主管理）**。不要一上来就搭最复杂的架构，记忆系统的价值需要在真实用户交互中才能体现。

> 我的 [GitHub 仓库](https://github.com/WalterHandsome/tech-learning-and-projects) 中有完整的 Agent 记忆系统学习笔记（6 篇），覆盖短期/长期记忆、对话管理、Mem0/Letta/Zep/LangMem 四大框架详解，以及知识库与经验学习的工程实践。
