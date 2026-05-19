---
title: "LangGraph 实战：用图结构构建生产级 AI Agent 工作流"
date: 2026-04-21
tags: ["LangGraph", "Agent 框架", "工作流"]
excerpt: "LangGraph 把 Agent 工作流建模为有向图，让你对每一步执行拥有精细控制。从核心概念到状态持久化、人机协作、子图拆分，一篇文章带你从 Demo 走向生产。"
vip: false
draft: false
---
你用 ReAct 模式搭了一个 Agent，Demo 跑得很顺——直到产品经理说："这个操作涉及资金，需要人工审批""用户中途关掉浏览器，回来要能接着聊""这个流程有三个分支，走哪条取决于用户的会员等级"。这时候你发现，简单的 while 循环 + tool calling 根本撑不住。

这就是 **LangGraph** 要解决的问题。它由 LangChain 团队推出，核心思路是**把 Agent 工作流建模为有向图**——节点是处理步骤，边是流转逻辑，状态在节点间共享传递。2025 年 10 月发布 1.0 GA，目前版本 1.1.3+，月下载量超过 9000 万，Uber、JP Morgan、LinkedIn、Klarna 等企业已在生产环境部署。

## 为什么需要图结构

传统 Agent 框架大多是线性或循环结构：LLM 思考 → 调用工具 → 拿到结果 → 继续思考。这在简单场景下够用，但生产环境中的工作流往往是**非线性**的：

```
简单 Agent（线性循环）：
  用户输入 → LLM → 工具 → LLM → 工具 → ... → 输出

生产级 Agent（图结构）：
  用户输入
      │
      ▼
  ┌─────────┐
  │ 意图路由  │ ← 根据用户意图走不同分支
  └────┬────┘
       │
  ┌────┼────────────┐
  ▼    ▼             ▼
┌────┐┌──────┐  ┌─────────┐
│RAG ││MCP   │  │ 人工审批  │ ← 敏感操作需要审批
│检索 ││工具  │  │         │
└──┬─┘└──┬───┘  └────┬────┘
   │     │           │
   └─────┴─────┬─────┘
               ▼
          ┌─────────┐
          │ LLM 生成 │ ← 整合所有结果
          └─────────┘
```

图结构的优势在于：你可以精确控制每一步的执行逻辑、在任意节点暂停等待人工介入、在任意时刻保存和恢复状态。这些能力是生产级 Agent 的刚需。

## 核心概念：State、Node、Edge

LangGraph 的 API 围绕三个核心概念展开：

-   **State（状态）**：在所有节点间共享的数据结构，定义了 Agent 在执行过程中需要维护的信息
-   **Node（节点）**：图中的处理单元，每个节点是一个 Python 函数，接收当前状态、返回状态更新
-   **Edge（边）**：定义节点之间的流转逻辑，支持固定边和条件边

来看一个最小可运行的例子：

```
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated
from operator import add
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

# 1. 定义状态：messages 列表使用 add 操作符累加
class AgentState(TypedDict):
    messages: Annotated[list, add]

# 2. 定义节点函数
llm = ChatOpenAI(model="gpt-4o")

def call_model(state: AgentState) -> dict:
    """调用 LLM 生成回复"""
    response = llm.invoke(state["messages"])
    return {"messages": [response]}

# 3. 定义路由逻辑
def should_continue(state: AgentState) -> str:
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END

# 4. 构建图
graph = StateGraph(AgentState)
graph.add_node("agent", call_model)
graph.add_node("tools", ToolNode(tools))

graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", should_continue,
    {"tools": "tools", END: END})
graph.add_edge("tools", "agent")  # 工具执行完回到 agent

# 5. 编译并运行
app = graph.compile()
result = app.invoke({
    "messages": [HumanMessage(content="北京今天天气怎么样？")]
})
```

这段代码的关键在于 `Annotated[list, add]`——它告诉 LangGraph，当节点返回新的 messages 时，不是覆盖而是**追加**到现有列表。这个 reducer 机制是 LangGraph 状态管理的核心。

## 条件路由：让 Agent 学会走不同的路

生产环境中，Agent 需要根据用户意图走不同的处理分支。LangGraph 的条件边让这件事变得很自然：

```
def route_by_intent(state: AgentState) -> str:
    """根据用户意图路由到不同处理节点"""
    last_message = state["messages"][-1].content.lower()

    if any(kw in last_message for kw in ["查询", "搜索", "找"]):
        return "rag_node"       # 走 RAG 检索
    elif any(kw in last_message for kw in ["执行", "操作", "创建"]):
        return "tool_node"      # 走工具调用
    elif any(kw in last_message for kw in ["转账", "删除", "授权"]):
        return "approval_node"  # 走人工审批
    else:
        return "generate_node"  # 直接生成回复

graph.add_conditional_edges("router", route_by_intent, {
    "rag_node": "rag_node",
    "tool_node": "tool_node",
    "approval_node": "approval_node",
    "generate_node": "generate_node",
})
```

实际项目中，路由逻辑通常不是简单的关键词匹配，而是用 LLM 做意图分类。但核心模式是一样的：**条件边 + 路由函数**。

## 状态持久化：用户关掉浏览器也不怕

这是 LangGraph 最实用的生产级特性之一。通过 Checkpointer，Agent 的完整状态可以持久化到数据库，用户随时可以恢复对话：

```
from langgraph.checkpoint.memory import MemorySaver
from langgraph.checkpoint.postgres import PostgresSaver

# 开发环境：内存检查点
memory = MemorySaver()
app = graph.compile(checkpointer=memory)

# 生产环境：PostgreSQL 检查点
checkpointer = PostgresSaver.from_conn_string(
    "postgresql://user:pass@localhost:5432/agent_db"
)
app = graph.compile(checkpointer=checkpointer)

# 使用 thread_id 维护会话
config = {"configurable": {"thread_id": "user-123"}}

# 第一轮对话
result = app.invoke(
    {"messages": [HumanMessage("帮我查一下上个月的销售数据")]},
    config
)

# 用户关掉浏览器...第二天回来继续
result = app.invoke(
    {"messages": [HumanMessage("按地区拆分一下")]},
    config  # 同一个 thread_id，自动恢复上下文
)
```

Checkpointer 不仅保存消息历史，还保存**图的执行位置**。如果 Agent 在人工审批节点暂停了，用户第二天回来审批通过后，图会从暂停的位置继续执行，而不是从头开始。

## 人机协作：敏感操作必须有人把关

当 Agent 要执行转账、删除数据、发送邮件等敏感操作时，你不会希望它自己做决定。LangGraph 的 `interrupt` 机制让人工审批变得优雅：

```
from langgraph.types import interrupt, Command

def sensitive_action(state: AgentState) -> dict:
    """需要人工审批的敏感操作"""
    action = state["pending_action"]

    # 中断执行，等待人工审批
    approval = interrupt({
        "action": action,
        "message": f"是否批准执行: {action['name']}？",
        "risk_level": "high"
    })

    if approval == "approved":
        result = execute_action(action)
        return {"messages": [AIMessage(content=f"已执行: {result}")]}
    else:
        return {"messages": [AIMessage(content="操作已取消")]}

# 编译时声明哪些节点需要中断
app = graph.compile(
    checkpointer=checkpointer,
    interrupt_before=["sensitive_action"]
)

# 执行到 sensitive_action 时自动暂停
result = app.invoke(input_data, config)
# result 包含中断信息，前端展示审批界面

# 用户审批通过后，恢复执行
result = app.invoke(Command(resume="approved"), config)
```

这个模式在金融、医疗、企业办公等场景中非常常见。关键点是 `interrupt` 会将当前状态完整保存到 Checkpointer，审批可以是几秒后也可以是几天后。

## 子图拆分：管理复杂工作流

当工作流变得复杂时，把所有逻辑塞在一个图里会变得难以维护。LangGraph 支持子图（Subgraph），让你像拆分函数一样拆分工作流：

```
# 研究子图：负责信息收集和分析
research_graph = StateGraph(ResearchState)
research_graph.add_node("search", search_node)
research_graph.add_node("analyze", analyze_node)
research_graph.add_edge("search", "analyze")
research_subgraph = research_graph.compile()

# 写作子图：负责内容生成和审校
writing_graph = StateGraph(WritingState)
writing_graph.add_node("draft", draft_node)
writing_graph.add_node("review", review_node)
writing_graph.add_conditional_edges("review", quality_check,
    {"pass": END, "revise": "draft"})
writing_subgraph = writing_graph.compile()

# 主图：组合子图
main_graph = StateGraph(MainState)
main_graph.add_node("research", research_subgraph)
main_graph.add_node("writing", writing_subgraph)
main_graph.add_edge(START, "research")
main_graph.add_edge("research", "writing")
app = main_graph.compile()
```

子图的好处不只是代码组织——每个子图可以独立测试、独立复用。比如研究子图可以同时被"写文章"和"做报告"两个主图使用。

## 实战架构：LangGraph + MCP + RAG

在我的 [LangGraph + MCP Agent Demo](https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/langgraph-mcp-agent-demo) 项目中，完整展示了一个生产级 Agent 的架构：

```
用户请求
    │
    ▼
┌─────────────────────────────────────────────┐
│              LangGraph 工作流                  │
│                                               │
│  ┌──────┐    ┌──────┐    ┌───────────────┐  │
│  │ 路由  │───▶│ RAG  │───▶│   LLM 生成    │  │
│  │ Node │    │ Node │    │    Node       │  │
│  └──┬───┘    └──────┘    └───────────────┘  │
│     │                                        │
│     ├───▶┌──────────┐    ┌───────────────┐  │
│     │    │ MCP 工具  │───▶│  结果整合      │  │
│     │    │   Node   │    │    Node       │  │
│     │    └──────────┘    └───────────────┘  │
│     │                                        │
│     └───▶┌──────────┐                       │
│          │ 人工审批  │  ← 敏感操作           │
│          │   Node   │                       │
│          └──────────┘                       │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │  State: messages + context + memory     │ │
│  │  Checkpointer: PostgreSQL               │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
    │                           │
    ▼                           ▼
┌─────────┐              ┌──────────┐
│ ChromaDB │              │ MCP      │
│ (向量库)  │              │ Servers  │
└─────────┘              └──────────┘
```

这个架构的核心设计决策：

-   **路由节点**用 LLM 做意图分类，根据结果走 RAG 检索、MCP 工具调用或人工审批分支
-   **RAG 节点**集成了混合检索（向量 + BM25）和 Reranker 重排序
-   **MCP 工具节点**通过 MCP 协议连接外部工具（数据库查询、文件操作、GitHub 等），工具自动发现和注册
-   **人工审批节点**使用 `interrupt` 机制，通过 WebSocket 推送审批请求到前端
-   **PostgreSQL Checkpointer** 保证会话状态持久化，支持断点续传

## 流式输出：让用户不用干等

生产环境中，Agent 的执行可能需要几秒甚至几十秒。流式输出让用户能实时看到 Agent 的思考过程：

```
# LangGraph 原生支持流式输出
async for event in app.astream_events(
    {"messages": [HumanMessage("分析一下最近的销售趋势")]},
    config,
    version="v2"
):
    kind = event["event"]
    if kind == "on_chat_model_stream":
        # LLM 生成的 token 流
        print(event["data"]["chunk"].content, end="", flush=True)
    elif kind == "on_tool_start":
        # 工具开始调用
        print(f"\n🔧 正在调用工具: {event['name']}...")
    elif kind == "on_tool_end":
        # 工具调用完成
        print(f"✅ 工具调用完成")
```

配合 FastAPI 的 WebSocket 或 SSE，可以把这些事件实时推送到前端，实现类似 ChatGPT 的打字机效果。

## 测试策略：图结构的测试比你想的简单

LangGraph 的图结构天然适合单元测试——每个节点是独立函数，可以单独测试：

```
import pytest

# 测试单个节点
def test_router_node():
    state = {"messages": [HumanMessage("帮我查一下文档")]}
    result = route_by_intent(state)
    assert result == "rag_node"

# 测试完整工作流
def test_full_workflow():
    app = graph.compile(checkpointer=MemorySaver())
    config = {"configurable": {"thread_id": "test-001"}}
    result = app.invoke(
        {"messages": [HumanMessage("你好")]},
        config
    )
    assert len(result["messages"]) >= 2
    assert result["messages"][-1].content  # 有回复

# 测试状态恢复
def test_state_recovery():
    memory = MemorySaver()
    app = graph.compile(checkpointer=memory)
    config = {"configurable": {"thread_id": "test-002"}}

    # 第一轮
    app.invoke({"messages": [HumanMessage("记住我叫张三")]}, config)
    # 第二轮：应该记得上下文
    result = app.invoke({"messages": [HumanMessage("我叫什么？")]}, config)
    assert "张三" in result["messages"][-1].content
```

## LangGraph 的适用边界

LangGraph 不是万能的。了解它的适用边界和了解它的能力一样重要：

```
你的场景适合 LangGraph 吗？

├── 需要精细的流程控制（条件分支、循环、并行）
│   └── ✅ LangGraph 的核心优势
│
├── 需要人工审批 / 断点续传
│   └── ✅ interrupt + Checkpointer 完美支持
│
├── 需要可观测性和调试
│   └── ✅ LangSmith 集成 + 图可视化
│
├── 简单的单轮问答 / 工具调用
│   └── ⚠️ 杀鸡用牛刀，OpenAI SDK 更轻量
│
├── 多角色协作（研究员 + 写手 + 编辑）
│   └── ⚠️ CrewAI 更直觉，LangGraph 也能做但代码量更大
│
└── 学习曲线敏感
    └── ⚠️ LangGraph 概念较多（State、Node、Edge、Checkpointer、interrupt）
        需要一定的学习投入
```

简单说：**如果你的 Agent 工作流有分支、有审批、有状态恢复的需求，LangGraph 是目前最成熟的选择。**如果只是简单的工具调用，用 OpenAI Agents SDK 或直接写 Function Calling 就够了。

## 写在最后

LangGraph 的核心价值不在于它让 Agent 更"智能"，而在于它让 Agent 更"可控"。在生产环境中，可控性比智能性更重要——你需要知道 Agent 在每一步做了什么、为什么这么做、出了问题怎么回滚。图结构 + 状态持久化 + 人机协作，这三个特性组合在一起，让 LangGraph 成为了从 Demo 走向生产的关键桥梁。

如果你准备动手，建议从官方的 [LangGraph Tutorials](https://langchain-ai.github.io/langgraph/tutorials/) 开始，然后参考我的 [LangGraph + MCP Agent Demo](https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/langgraph-mcp-agent-demo) 看一个完整的生产级实现。

> 我的 [GitHub 仓库](https://github.com/walterwang0x01/tech-learning-and-projects) 中有 8 篇 Agent 框架深度笔记和 2 个可运行的实战项目，覆盖 LangGraph、CrewAI、OpenAI SDK、Google ADK、AWS Strands 等主流框架的完整对比。
