---
title: "CrewAI 多 Agent 协作实战：让 AI 团队替你干活"
date: 2026-04-21
tags: ["CrewAI", "多 Agent", "Agent 框架"]
excerpt: "CrewAI 用角色扮演的方式组织多 Agent 协作，10 分钟就能搭建一个 AI 团队。从核心概念到执行模式、记忆系统、MCP 集成，一篇文章带你从入门到生产。"
vip: false
draft: false
---
你有没有想过，让一个 AI 同时扮演研究员、写手、编辑和 SEO 专家，像一个真实团队一样协作完成任务？这不是科幻，而是 **CrewAI** 正在做的事。

CrewAI 是一个角色化多 Agent 协作框架，核心理念是把 AI Agent 组织为一个"团队"（Crew），每个 Agent 扮演特定角色，按照定义好的流程协作完成复杂任务。GitHub 47.8K+ Stars，2700 万+ PyPI 下载量，20 亿+ Agent 执行次数。最新版本 v1.14.x，已完全独立于 LangChain 从零构建，原生支持 MCP 工具集成和 A2A 协议。

如果说 LangGraph 是"用图结构精细控制每一步"，那 CrewAI 就是"用角色和任务声明式地编排协作"。两者不是替代关系，而是适用于不同场景。

## 核心概念：Agent、Task、Crew

CrewAI 的 API 围绕三个核心概念展开，学习曲线极低：

-   **Agent（角色）**：定义一个 AI 角色，包括它的职责（role）、目标（goal）、背景故事（backstory）和可用工具
-   **Task（任务）**：定义一个具体任务，包括描述、期望输出、负责的 Agent，以及依赖的上游任务
-   **Crew（团队）**：把 Agent 和 Task 组装在一起，定义执行模式（顺序/层级），一键启动

来看一个最小可运行的例子——搭建一个"研究 + 写作"的两人团队：

```
from crewai import Agent, Task, Crew, Process

# 1. 定义 Agent（角色）
researcher = Agent(
    role="高级研究员",
    goal="深入研究给定主题，收集全面准确的信息",
    backstory="你是一位经验丰富的研究员，擅长从多个来源收集和分析信息",
    llm="gpt-4o",
    verbose=True,
)

writer = Agent(
    role="技术作家",
    goal="将研究成果转化为高质量的技术文章",
    backstory="你是一位专业的技术作家，擅长将复杂概念用通俗易懂的方式表达",
    llm="gpt-4o",
)

# 2. 定义 Task（任务）
research_task = Task(
    description="研究 {topic} 的最新发展趋势和关键技术",
    expected_output="一份详细的研究报告，包含关键发现和数据",
    agent=researcher,
)

writing_task = Task(
    description="基于研究报告撰写一篇技术博客文章",
    expected_output="一篇 2000 字左右的技术文章，结构清晰",
    agent=writer,
    context=[research_task],  # 依赖研究任务的输出
)

# 3. 组建 Crew（团队）并执行
crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, writing_task],
    process=Process.sequential,  # 顺序执行
    verbose=True,
)

result = crew.kickoff(inputs={"topic": "AI Agent 协议标准化"})
print(result)
```

这段代码的关键在于 `context=[research_task]`——它告诉 CrewAI，写作任务依赖研究任务的输出。框架会自动把研究结果传递给写手，你不需要手动管理数据流。

## 两种执行模式：顺序 vs 层级

CrewAI 支持两种执行模式，适用于不同的协作场景：

### 顺序执行（Sequential）

任务按定义顺序依次执行，上一个任务的输出自动作为下一个任务的输入。适合流水线式的工作流：

```
研究员 → 作家 → 编辑 → SEO 优化师

# 每个 Agent 完成自己的任务后，结果自动传递给下一个
process=Process.sequential
```

### 层级执行（Hierarchical）

框架自动创建一个 Manager Agent，由它根据任务需求动态分配工作给团队成员。适合任务之间有复杂依赖或需要动态调度的场景：

```
# Manager Agent 自动创建，负责任务分配和结果汇总
crew = Crew(
    agents=[researcher, writer, editor],
    tasks=[research_task, writing_task, review_task],
    process=Process.hierarchical,
    manager_llm="gpt-4o",  # Manager 使用的模型
)

# Manager 会根据任务描述和 Agent 能力，自主决定：
# - 哪个 Agent 执行哪个任务
# - 是否需要返工
# - 何时汇总最终结果
```

实际项目中，**顺序执行覆盖 80% 的场景**。层级执行适合任务数量多、依赖关系复杂、需要动态调度的情况。

## 实战：四人内容创作团队

在我的 [CrewAI 多 Agent Demo](https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/crewai-multi-agent-demo) 项目中，搭建了一个完整的内容创作流水线：

```
用户输入主题
    │
    ▼
┌─────────────────────────────────────────────────┐
│              CrewAI Content Crew                 │
│                                                   │
│  ┌────────────┐    ┌────────────┐               │
│  │  高级研究员  │───▶│  技术作家   │               │
│  │ Researcher │    │  Writer    │               │
│  └─────┬──────┘    └─────┬──────┘               │
│        │                 │                       │
│   SerperDev         FileWrite                   │
│   WebScrape          Tool                       │
│        │                 │                       │
│        ▼                 ▼                       │
│  ┌─────────────────────────────────────────┐    │
│  │         任务上下文传递 (Context)          │    │
│  └─────────────────────────────────────────┘    │
│        │                 │                       │
│        ▼                 ▼                       │
│  ┌────────────┐    ┌────────────┐               │
│  │  内容编辑   │───▶│ SEO 优化师  │               │
│  │  Editor    │    │ Optimizer  │               │
│  └────────────┘    └─────┬──────┘               │
│                          │                       │
│  ┌─────────────────────────────────────────┐    │
│  │  Memory: 短期 + 长期 (Mem0) + 实体记忆   │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
    │
    ▼
  输出文章
```

四个 Agent 各司其职：

-   **高级研究员**：用 SerperDev 搜索引擎和 WebScrape 工具深度调研主题，收集权威资料与最新动态
-   **技术作家**：基于研究成果撰写高质量技术文章，使用 FileWrite 工具保存草稿
-   **内容编辑**：纯 LLM 推理审校文章质量，优化结构与表达，不需要外部工具
-   **SEO 优化师**：关键词优化、元数据生成，让文章对搜索引擎友好

## 工具集成：让 Agent 有手有脚

Agent 没有工具就只能"空想"。CrewAI 提供了两种工具集成方式：

### 内置工具 + 自定义工具

```
from crewai.tools import tool

# 自定义工具：用 @tool 装饰器
@tool
def count_words(text: str) -> str:
    """统计文本字数"""
    count = len(text)
    return f"文本共 {count} 字"

@tool
def analyze_keyword_density(text: str, keyword: str) -> str:
    """分析关键词密度"""
    total = len(text)
    keyword_count = text.count(keyword)
    density = (keyword_count * len(keyword) / total) * 100
    return f"关键词 '{keyword}' 密度: {density:.1f}%"

# 给 Agent 配备工具
seo_optimizer = Agent(
    role="SEO 优化师",
    goal="优化文章的搜索引擎可见性",
    tools=[count_words, analyze_keyword_density],
)
```

### MCP 工具集成

CrewAI v1.14.x 原生支持 MCP 协议，可以直接连接任何 MCP Server：

```
from crewai.tools import MCPServerAdapter

# 连接 GitHub MCP Server
mcp_tools = MCPServerAdapter(
    server_params={
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {"GITHUB_TOKEN": "ghp_xxx"},
    }
)

# Agent 自动发现 MCP Server 提供的所有工具
developer = Agent(
    role="开发者",
    goal="管理 GitHub 仓库",
    tools=mcp_tools.tools,  # 自动注册所有 MCP 工具
)
```

MCP 集成的意义在于：你不需要为每个外部服务写定制化的工具代码，只要有对应的 MCP Server，Agent 就能直接使用。

## 记忆系统：让 Agent 越用越聪明

CrewAI 内置了三层记忆系统，这是它区别于简单"多次 LLM 调用"的关键：

-   **短期记忆**：当前执行过程中的任务上下文传递。研究员的输出自动成为作家的输入
-   **长期记忆**：跨执行的经验积累。Agent 会记住之前的创作偏好、常见错误、优化策略
-   **实体记忆**：识别并记忆关键实体信息。比如记住"LangGraph 是 LangChain 团队的产品"这类事实

```
# 启用记忆系统
crew = Crew(
    agents=[researcher, writer, editor],
    tasks=[research_task, writing_task, review_task],
    memory=True,  # 一行代码启用三层记忆
    verbose=True,
)

# 第一次执行：Agent 从零开始
result1 = crew.kickoff(inputs={"topic": "MCP 协议"})

# 第二次执行：Agent 会利用之前的经验
# - 研究员记得哪些来源质量高
# - 作家记得什么写作风格受欢迎
# - 编辑记得常见的质量问题
result2 = crew.kickoff(inputs={"topic": "A2A 协议"})
```

生产环境中，可以集成 Mem0 作为长期记忆后端，实现跨会话的持久化记忆存储。

## 多 Agent 架构模式选型

CrewAI 的顺序/层级执行只是多 Agent 架构的两种模式。了解完整的模式谱系，有助于你在不同场景下做出正确选择：

```
多 Agent 架构模式：

├── Supervisor（主管模式）
│   一个主管 Agent 分配任务，子 Agent 执行
│   ✅ 简单可控  ⚠️ 主管是瓶颈
│   → CrewAI hierarchical / LangGraph
│
├── Sequential（顺序模式）
│   任务按固定顺序流水线执行
│   ✅ 最简单  ⚠️ 不灵活
│   → CrewAI sequential
│
├── Swarm（群体模式）
│   Agent 之间通过 Handoff 自主交接，无中心调度
│   ✅ 灵活自主  ⚠️ 难以调试
│   → OpenAI Agents SDK
│
└── Network（网络模式）
    所有 Agent 可以互相通信
    ✅ 最灵活  ⚠️ 消息爆炸
    → 自定义实现
```

**选型建议**：80% 的场景用顺序模式就够了。只有当任务之间有复杂的动态依赖时，才需要考虑层级或 Swarm 模式。

## CrewAI vs LangGraph：什么时候选谁

这是最常被问到的问题。两者的核心差异在于**抽象层级**：

-   **CrewAI**：高层抽象，声明式。你定义"谁做什么"，框架负责"怎么做"。上手快，代码量少，但对执行细节的控制有限
-   **LangGraph**：低层抽象，命令式。你定义"每一步怎么走"，拥有完全的控制权。学习曲线高，但能处理任意复杂的工作流

```
你的场景适合哪个？

├── 多角色协作（研究 + 写作 + 审校）
│   └── ✅ CrewAI（天然适合角色化协作）
│
├── 复杂工作流 + 条件分支 + 循环
│   └── ✅ LangGraph（图结构精细控制）
│
├── 需要人工审批 / 断点续传
│   └── ✅ LangGraph（interrupt + Checkpointer）
│
├── 快速原型 / 内容生成流水线
│   └── ✅ CrewAI（10 分钟出结果）
│
└── 两者都需要？
    └── ✅ 组合使用：CrewAI 做子任务编排
        LangGraph 做顶层工作流控制
```

在我的实际项目中，内容创作流水线用 CrewAI，因为它天然适合"多角色按顺序协作"的场景；而 RAG + MCP + 人工审批的复杂 Agent 用 LangGraph，因为需要精细的流程控制和状态持久化。

## 生产环境注意事项

CrewAI 从 Demo 到生产，有几个关键点需要注意：

1.  **成本控制**：多 Agent 意味着多次 LLM 调用。一个 4 Agent 的 Crew 执行一次可能消耗 10-20 次 LLM 调用。建议用 `max_iter` 限制每个 Agent 的最大迭代次数，用 `max_rpm` 控制 API 调用频率
2.  **错误处理**：某个 Agent 失败时，整个 Crew 会中断。生产环境中需要加入重试机制和降级策略
3.  **可观测性**：开启 `verbose=True` 在开发阶段很有用，但生产环境建议集成 LangSmith 或 AgentOps 做结构化的执行追踪
4.  **Agent 描述质量**：`role`、`goal`、`backstory` 的描述质量直接影响 Agent 的表现。模糊的描述会导致 Agent "不知道自己该干什么"
5.  **任务粒度**：任务拆分太粗，Agent 容易跑偏；拆分太细，上下文传递的信息损失增大。建议每个任务有明确的输入、输出和验收标准

## 写在最后

CrewAI 的核心价值在于**降低了多 Agent 协作的门槛**。你不需要理解图结构、状态管理、消息传递这些底层概念，只需要想清楚"我需要哪些角色、每个角色做什么任务、任务之间什么顺序"，框架帮你搞定剩下的事。

对于内容生成、研究分析、数据处理这类"多角色流水线"场景，CrewAI 是目前最高效的选择。如果你的需求更复杂（条件分支、人工审批、状态持久化），可以考虑 LangGraph，或者两者组合使用。

> 我的 [GitHub 仓库](https://github.com/walterwang0x01/tech-learning-and-projects) 中有一个完整的 [CrewAI 多 Agent Demo](https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/crewai-multi-agent-demo) 项目，展示了四人内容创作团队的完整实现，以及 3 篇多 Agent 系统的深度笔记，覆盖架构模式、通信协调和人机协作。
