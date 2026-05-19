---
title: "AI Agent 框架选型：LangGraph vs CrewAI vs OpenAI SDK 实战对比"
date: 2026-04-18
tags: ["Agent 框架", "LangGraph"]
excerpt: "面对十几个 AI Agent 框架，到底该选哪个？基于实际项目经验，从架构设计、开发体验、生产就绪度三个维度做横向对比。"
vip: false
draft: false
---
AI Agent 框架在 2025-2026 年经历了一轮爆发式增长：LangGraph、CrewAI、OpenAI Agents SDK、Google ADK、AWS Strands、Mastra、AG2……面对这么多选择，开发者最常问的问题就是：**我该用哪个？**

这篇文章基于我实际使用这些框架构建项目的经验，从三个核心维度做对比，帮你做出选型决策。

## 三大主流框架速览

### LangGraph（LangChain 团队）

核心理念：**把 Agent 工作流建模为有向图**。每个节点是一个处理步骤，边定义了流转逻辑，状态在节点间共享和传递。

-   最大优势：精细的流程控制、内置持久化和人机协作
-   适合场景：复杂多步骤工作流、需要人工审批的业务流程
-   学习曲线：中等偏高，需要理解图、状态、检查点等概念

### CrewAI

核心理念：**用角色扮演的方式组织多 Agent 协作**。定义 Agent（角色）、Task（任务）、Crew（团队），框架自动编排执行。

-   最大优势：上手极快、代码直觉、多 Agent 协作开箱即用
-   适合场景：内容生成流水线、研究分析、多角色协作任务
-   学习曲线：低，10 分钟就能跑起来

### OpenAI Agents SDK

核心理念：**极简主义，围绕 OpenAI 模型能力设计**。核心概念只有 Agent、Handoff、Guardrail 三个。

-   最大优势：极简 API、与 OpenAI 生态深度集成、内置 tracing
-   适合场景：以 OpenAI 模型为主的项目、快速原型
-   学习曲线：最低

## 核心维度对比

### 1\. 架构灵活性

```
# LangGraph：显式定义图结构
from langgraph.graph import StateGraph

graph = StateGraph(AgentState)
graph.add_node("research", research_node)
graph.add_node("write", write_node)
graph.add_node("review", review_node)
graph.add_edge("research", "write")
graph.add_conditional_edges("review", quality_check,
    {"pass": END, "revise": "write"})

# CrewAI：声明式定义角色和任务
from crewai import Agent, Task, Crew

researcher = Agent(role="研究员", goal="深度调研主题")
writer = Agent(role="写手", goal="撰写高质量文章")
crew = Crew(agents=[researcher, writer],
            tasks=[research_task, write_task],
            process=Process.sequential)

# OpenAI SDK：最简 Agent 定义
from agents import Agent, handoff

researcher = Agent(name="researcher",
    instructions="你是一个研究助手")
writer = Agent(name="writer",
    instructions="你是一个技术写手",
    handoffs=[handoff(researcher)])
```

**结论**：需要精细控制流程选 LangGraph，快速搭建多角色协作选 CrewAI，追求极简选 OpenAI SDK。

### 2\. 生产就绪度

-   **LangGraph**：最成熟。内置状态持久化（CheckPointer）、人机协作（interrupt）、流式输出、LangSmith 可观测性。有 LangGraph Platform 提供托管部署
-   **CrewAI**：中等。有 CrewAI Enterprise 提供托管，但自部署时状态管理和错误恢复需要自己处理
-   **OpenAI SDK**：基础。内置 tracing，但持久化、人机协作等需要自己实现

### 3\. 模型灵活性

-   **LangGraph**：通过 LangChain 支持几乎所有模型提供商
-   **CrewAI**：支持 OpenAI、Anthropic、本地模型等多种选择
-   **OpenAI SDK**：默认绑定 OpenAI，可以通过自定义 Provider 接入其他模型，但不是一等公民体验

## 选型决策树

```
你的项目需要什么？
│
├── 复杂工作流 + 人工审批 + 状态持久化
│   └── ✅ LangGraph
│
├── 多角色协作 + 快速出原型
│   └── ✅ CrewAI
│
├── 简单 Agent + OpenAI 生态
│   └── ✅ OpenAI Agents SDK
│
├── Java/Spring 生态
│   └── ✅ Spring AI
│
├── TypeScript/前端优先
│   └── ✅ Vercel AI SDK / Mastra
│
└── AWS 深度集成
    └── ✅ AWS Strands Agents
```

## 我的实战选择

在我的两个实战项目中：

-   **LangGraph + MCP Agent Demo**：选了 LangGraph，因为需要 RAG 检索 + MCP 工具调用 + 人工审批的复杂工作流
-   **CrewAI 多 Agent Demo**：选了 CrewAI，因为是内容创作流水线，多角色协作是核心需求

没有最好的框架，只有最适合你场景的框架。建议先明确你的核心需求，再做选择。

> 我在 [GitHub 仓库](https://github.com/walterwang0x01/tech-learning-and-projects) 中有 8 篇框架深度对比笔记和 2 个可运行的实战项目，覆盖了 LangGraph、CrewAI、OpenAI SDK、Google ADK、AWS Strands 等主流框架。
