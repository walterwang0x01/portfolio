---
title: "Context Engineering：比 Prompt Engineering 更重要的事"
date: 2026-05-02
tags: ["Context Engineering", "AI Agent", "LLM"]
excerpt: "Prompt Engineering 只是冰山一角。真正决定 AI Agent 表现的，是你塞进上下文窗口的每一个 token。从 Anthropic 的四大策略到 Coding Agent 的实战模式，一文搞懂 Context Engineering。"
vip: false
draft: false
---
2025 年 6 月，Shopify CEO Tobi Lütke 发了一条推文："我真的很喜欢 Context Engineering 这个词，比 Prompt Engineering 好多了。它更准确地描述了核心技能：**提供恰到好处的上下文，让 LLM 有可能完成任务的艺术**。"几乎同时，Andrej Karpathy 给出了一个更技术化的类比：LLM 是 CPU，上下文窗口是 RAM，而你是操作系统——负责在正确的时间加载正确的信息。

这不是换个名字那么简单。Prompt Engineering 关注的是"怎么写一条好指令"，而 Context Engineering 关注的是**模型在推理时看到的所有信息的策划和管理**——系统提示、用户输入、工具返回值、检索结果、历史对话、记忆片段，每一个 token 都在影响模型的行为。当你的 Agent 在长任务中跑偏、在多轮对话中遗忘关键信息、在工具调用后做出错误判断时，问题往往不在模型，而在上下文。

## 从 Prompt Engineering 到 Context Engineering：范式转变

先厘清两者的关系。Prompt Engineering 是 Context Engineering 的子集，而不是替代关系：

```
Prompt Engineering（2022-2024 主流）
├── 关注点：单条提示的措辞和格式
├── 技术：Few-shot、Chain-of-Thought、角色扮演
├── 适用：单轮问答、文本生成
└── 局限：无法处理动态上下文、长任务、多工具场景

Context Engineering（2025+ 主流）
├── 关注点：模型推理时看到的所有信息
├── 技术：状态管理、选择性检索、上下文压缩、多 Agent 隔离
├── 适用：Agent 系统、长任务、生产级应用
└── 包含：Prompt Engineering + 动态上下文管理 + 信息架构
```

Anthropic 给出了正式定义：**Context Engineering 是在 LLM 推理过程中，策划和维护最优 token 集合的策略体系**。关键词是"策划"和"维护"——不是一次性写好就完事，而是在整个任务生命周期中持续管理。

为什么这个转变发生在 2025 年？因为 Agent 的崛起。当 LLM 从"回答一个问题"变成"自主执行多步任务"时，上下文管理的复杂度指数级增长。一个 Coding Agent 在修复 bug 的过程中，可能需要读取 20 个文件、执行 10 次搜索、调用 5 个工具——这些信息全部塞进上下文窗口，模型会被淹没；只保留最近几步，模型又会丢失关键上下文。**怎么在"信息过载"和"信息不足"之间找到平衡，就是 Context Engineering 的核心挑战。**

## 四大核心策略

Anthropic 在其 Context Engineering 指南中总结了四大策略，覆盖了生产级 Agent 的上下文管理全貌：

### 策略一：Write — 将状态外化

不要把所有信息都塞在上下文窗口里。让 Agent 把中间状态写到外部存储（文件、数据库、暂存区），需要时再读回来。

```
# 反模式：所有状态都在上下文窗口中
messages = [
    system_prompt,           # 2000 tokens
    user_request,            # 100 tokens
    tool_result_1,           # 5000 tokens（数据库查询结果）
    tool_result_2,           # 3000 tokens（文件内容）
    tool_result_3,           # 8000 tokens（搜索结果）
    ...                      # 上下文窗口快满了
]

# 正确做法：状态外化
def agent_step(state):
    # 将大块数据写入暂存区
    scratchpad.write("db_results", tool_result_1)
    scratchpad.write("file_content", tool_result_2)

    # 上下文中只保留摘要引用
    context = f"""
    已获取数据：
    - 数据库查询结果（{len(tool_result_1)} 字符）→ 参见 scratchpad:db_results
    - 文件内容（{len(tool_result_2)} 字符）→ 参见 scratchpad:file_content
    关键发现：{summarize(tool_result_1)}
    """
    return context
```

Claude Code 的源码揭示了这个策略的极致应用：它用文件系统作为 Agent 间的通信媒介，用 Git Worktree 隔离每个子 Agent 的工作状态。所有中间产物都在磁盘上，上下文窗口只保留"当前需要关注的信息"。

### 策略二：Select — 选择性加载

不是所有信息都值得放进上下文。选择性加载的核心是**只在需要时加载需要的信息**，而不是预先塞满。

```
# 反模式：预加载所有可能用到的信息
context = load_all_project_files()  # 可能有几万行代码
context += load_all_docs()          # 所有文档
context += load_user_history()      # 完整历史

# 正确做法：按需检索
def build_context(user_query, current_task):
    context_parts = []

    # 1. 始终包含：系统提示 + 当前任务描述
    context_parts.append(system_prompt)
    context_parts.append(current_task)

    # 2. 按需检索：只加载与当前任务相关的信息
    if needs_code_context(current_task):
        relevant_files = search_codebase(current_task, top_k=5)
        context_parts.append(format_code_context(relevant_files))

    if needs_history(current_task):
        relevant_history = search_memory(user_query, top_k=3)
        context_parts.append(format_history(relevant_history))

    # 3. RAG 检索：语义相关的知识片段
    rag_results = vector_search(user_query, top_k=5)
    context_parts.append(format_rag_results(rag_results))

    return assemble_context(context_parts)
```

Kiro 的 Steering 文件机制就是 Select 策略的典型实现：通过 `fileMatch` 条件，只在读取特定类型文件时才加载对应的规范文档，而不是每次都把所有规范塞进上下文。

### 策略三：Compress — 压缩累积信息

长任务中，上下文会不断累积。如果不压缩，要么撑爆窗口，要么被迫丢弃早期信息。压缩的核心是**保留决策，丢弃细节**。

```
# Claude Code 的五级压缩策略（从轻到重）

Level 1: Microcompact
  # 基于时间，清除旧的工具调用结果，保留决策
  # "搜索了 20 个文件，找到 bug 在 utils.py 第 42 行"
  # → 保留 "bug 在 utils.py:42"，丢弃搜索过程

Level 2: Context Collapse
  # 上下文过长时，摘要压缩对话片段
  # 10 轮对话 → 3 句话摘要

Level 3: Session Memory
  # 主动提取关键上下文到持久化文件
  # "用户偏好 TypeScript，项目用 Vite 构建"

Level 4: Full Compact
  # /compact 命令，摘要整个对话历史
  # 完整会话 → 结构化摘要

Level 5: PTL Truncation
  # 最后手段，丢弃最早的消息组
  # 保留系统提示 + 最近 N 轮
```

压缩中最巧妙的技术是 Claude Code 的 `cache_edits` 机制：传统做法是删除旧消息，但这会破坏 Prompt Cache 的连续性，导致后续请求全部缓存未命中（成本增加 10 倍）。Claude Code 的做法是**标记旧消息为 "skip"**——模型不再看到这些消息，但缓存前缀不断裂。这个设计让数小时的长会话在清除数百条旧消息后，响应速度几乎不受影响。

### 策略四：Isolate — 多 Agent 上下文隔离

当任务复杂到需要多个 Agent 协作时，每个 Agent 应该有自己独立的上下文空间，而不是共享一个巨大的上下文窗口。

```
# 反模式：所有 Agent 共享上下文
shared_context = []  # 所有 Agent 的信息都在这里，互相干扰

# 正确做法：上下文隔离
class AgentContext:
    def __init__(self, agent_role, shared_state_ref):
        self.system_prompt = load_role_prompt(agent_role)
        self.local_messages = []        # 私有对话历史
        self.shared_state = shared_state_ref  # 只读共享状态

    def build_context(self):
        return [
            self.system_prompt,
            self.get_relevant_shared_state(),  # 只取需要的共享信息
            *self.local_messages[-10:],         # 最近 10 轮私有对话
        ]

# 每个 Agent 有独立上下文，通过共享状态协调
research_agent = AgentContext("researcher", shared_state)
writer_agent = AgentContext("writer", shared_state)
reviewer_agent = AgentContext("reviewer", shared_state)
```

Claude Code 的 Swarm 模式将隔离做到了极致：每个子 Agent 在独立的 Git Worktree 中工作，通过文件系统传递消息，共享 Prompt Cache 但不共享上下文内容。这样即使并行运行 5 个 Agent，每个 Agent 的上下文都保持精简和聚焦。

## Coding Agent 中的 Context Engineering 实战

Coding Agent 是 Context Engineering 最复杂的应用场景之一。Martin Fowler 的团队总结了 Coding Agent 中的上下文工程实践，核心分为三层：

### 第一层：静态配置（Rules / Steering）

通过配置文件预定义 Agent 的行为规范，每次推理时自动注入。这是最高杠杆的上下文控制手段：

```
# Kiro Steering 文件示例（.kiro/steering/python-conventions.md）
---
inclusion: fileMatch
fileMatchPattern: "**/*.py"
---

# Python 代码规范
- 使用 snake_case 命名
- 绝对导入 from app.xxx
- 异步函数优先
- 类型注解必须完整

# 项目特定约定
- ORM 使用 SQLAlchemy 2.0 async
- API 响应统一用 ResponseModel 包装
- 错误处理使用自定义 BusinessException
```

关键设计：`fileMatch` 条件加载。只有当 Agent 读取 Python 文件时，Python 规范才会被注入上下文。这避免了"所有规范一股脑塞进去"导致的上下文污染。

### 第二层：动态检索（RAG + 代码搜索）

Agent 在执行任务时，动态检索相关的代码片段、文档和历史记录：

-   **代码库搜索**：基于 AST 解析和语义搜索，找到与当前任务相关的函数、类、模块
-   **文档检索**：从项目文档、API 文档中检索相关信息
-   **历史检索**：从 Git 历史中找到相关的变更记录和 PR 讨论

### 第三层：运行时管理（压缩 + 缓存）

在长任务执行过程中，持续管理上下文的大小和质量：

-   **工具结果压缩**：搜索返回 100 个结果，只保留最相关的 5 个
-   **对话历史压缩**：早期的探索性对话压缩为摘要，保留最终决策
-   **缓存优化**：确保上下文前缀稳定，最大化 Prompt Cache 命中率

## Prompt Cache 经济学：Context Engineering 的隐藏维度

Context Engineering 不只是关于"效果"，还关于"成本"。以 Claude Opus 为例：

```
标准输入：$15 / 百万 token
缓存命中：$1.5 / 百万 token  ← 90% 折扣
缓存写入：$18.75 / 百万 token

关键推论：
- 每次缓存未命中，成本增加 10 倍
- 上下文前缀越稳定，缓存命中率越高
- 频繁修改系统提示 = 频繁缓存失效 = 成本飙升

实际影响（以 10 万次 Agent 调用为例）：
- 缓存命中率 90%：约 $2,850
- 缓存命中率 50%：约 $9,750
- 缓存命中率 10%：约 $16,650

差距：5.8 倍
```

这意味着 Context Engineering 的一个重要目标是**保持上下文前缀的稳定性**。Claude Code 源码中追踪了 14 种缓存失效向量，工具列表的排序经过精心设计——内置工具作为连续前缀，MCP 工具追加在后，这样新增 MCP 工具不会破坏内置工具的缓存。

## 实战清单：你的 Agent 上下文健康吗？

在构建或优化 Agent 时，用这个清单检查你的 Context Engineering 是否到位：

-   **系统提示**：是否清晰定义了 Agent 的角色、能力边界和行为规范？是否避免了冗余信息？
-   **工具定义**：工具描述是否精确？参数 Schema 是否完整？工具数量是否过多（建议 < 20）？
-   **检索质量**：RAG 检索结果是否经过 Reranking？是否有相关性阈值过滤？
-   **历史管理**：长对话是否有压缩策略？是否保留了关键决策而丢弃了探索过程？
-   **工具结果**：工具返回值是否经过截断和摘要？大块数据是否外化到暂存区？
-   **缓存友好**：上下文前缀是否稳定？是否避免了不必要的系统提示修改？
-   **隔离性**：多 Agent 场景下，每个 Agent 是否有独立的上下文空间？
-   **可观测性**：是否能看到每次推理的完整上下文？是否监控了 token 使用量和缓存命中率？

## Context Engineering 的未来：从手动到自动

2026 年的 Context Engineering 仍然高度依赖开发者的手动设计。但趋势已经很明确——**上下文管理正在从"开发者手动编排"走向"框架自动优化"**：

-   **自适应压缩**：根据任务类型和上下文使用模式，自动选择压缩策略和时机
-   **智能检索**：不再依赖固定的 top-k 检索，而是根据任务需求动态调整检索策略和数量
-   **缓存感知编排**：Agent 框架自动优化上下文排列，最大化缓存命中率
-   **上下文预算管理**：给每个 Agent 分配 token 预算，框架自动在预算内优化信息密度

Anthropic 的 Managed Agents 和 LangGraph 的 Context Engineering 模块都在朝这个方向发展。但在框架完全自动化之前，理解 Context Engineering 的原理和策略，仍然是构建高质量 Agent 的核心技能。

## 写在最后

Context Engineering 不是一个新概念，而是对我们一直在做的事情的更准确命名。每次你调整系统提示、优化 RAG 检索、压缩对话历史、设计工具描述时，你都在做 Context Engineering。

但把它作为一个独立的工程学科来对待，意味着你需要**系统性地思考模型看到的每一个 token**——不是写完 Prompt 就完事，而是在整个 Agent 生命周期中持续管理上下文的质量、大小和成本。

记住 Karpathy 的类比：你是操作系统，上下文窗口是 RAM。好的操作系统不会把所有数据都加载到内存里，而是在正确的时间加载正确的数据。Context Engineering 就是这门艺术。

> 本文内容基于 [tech-learning-and-projects](https://github.com/walterwang0x01/tech-learning-and-projects) 仓库中的 Context Engineering 学习笔记，结合 Anthropic、LangChain、Martin Fowler 等权威来源的最新实践总结。
