---
title: "多 Agent 架构模式：Supervisor、Swarm、Hierarchical 到底怎么选"
date: 2026-05-07
tags: ["多 Agent", "LangGraph", "架构设计"]
excerpt: "单个 Agent 搞不定的复杂任务，需要多 Agent 协作。本文系统梳理 Supervisor、Swarm、Hierarchical 三大主流架构的适用场景、实现方式和取舍，并用 LangGraph 给出可运行示例。"
vip: false
draft: false
---

单个 Agent 上下文越塞越长、工具越挂越多之后，你会发现它开始"精神分裂"：该检索的时候去写代码，该调用工具的时候胡编参数。这通常不是模型不够强，而是**职责边界不清**。

解决办法不是把 prompt 写得更长，而是拆成多个 Agent，每个 Agent 只干一件事。但多个 Agent 怎么组织、谁调度谁、状态怎么共享，这些问题就构成了多 Agent 系统的架构设计。

2026 年主流的多 Agent 架构可以归纳为三种：**Supervisor（中心调度）**、**Swarm（去中心化交接）**、**Hierarchical（分层嵌套）**。这篇文章用 LangGraph 的实现思路把它们讲清楚，并给出选型建议。

## 为什么要上多 Agent

先明确一个前提：**能用单 Agent 解决的问题，不要上多 Agent**。多 Agent 系统引入的复杂度是非线性的——调试难度、Token 成本、延迟、失败模式都会成倍增加。

真正适合多 Agent 的场景大致有三类：

- **技能明显异构**：调研、写作、审校、SEO 这种需要不同"人设"和工具集的任务
- **上下文冲突**：同一个 Agent 同时处理用户对话、数据库查询、代码生成，上下文互相干扰
- **并行提速**：多个独立子任务可以并发执行，比如同时爬取 10 个信息源

如果你的问题只是"工具太多"，优先考虑工具分组和动态工具加载，而不是拆 Agent。

## Supervisor：中心调度模式

Supervisor 模式有一个"主管" Agent，负责接收用户请求、决定交给哪个下属 Agent 处理、收集结果后返回给用户。下属 Agent 之间互不通信，都只听主管的。

```
           +-------------+
   用户 -->| Supervisor  |<-- 最终答复
           +------+------+
                  |
        +---------+---------+
        |         |         |
     Agent A   Agent B   Agent C
    (检索)    (写作)    (代码)
```

LangGraph 里的典型实现：

```python
from langgraph.prebuilt import create_react_agent
from langgraph.graph import StateGraph, END
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o")

# 1. 下属 Agent（每个只有自己的工具集）
researcher = create_react_agent(llm, tools=[tavily_search])
coder = create_react_agent(llm, tools=[python_repl])

# 2. Supervisor：用 LLM 做路由决策
def supervisor(state):
    prompt = f"""根据当前对话决定下一步：
    - researcher: 需要检索信息
    - coder: 需要写或执行代码
    - FINISH: 已有足够信息回答用户

    对话历史：{state['messages']}
    只返回一个词。"""
    next_agent = llm.invoke(prompt).content.strip()
    return {"next": next_agent}

# 3. 组装图
graph = StateGraph(AgentState)
graph.add_node("supervisor", supervisor)
graph.add_node("researcher", researcher)
graph.add_node("coder", coder)
graph.add_conditional_edges("supervisor", lambda s: s["next"],
                             {"researcher": "researcher", "coder": "coder", "FINISH": END})
graph.add_edge("researcher", "supervisor")
graph.add_edge("coder", "supervisor")
graph.set_entry_point("supervisor")
```

**优点**：路由集中、行为可预测、易调试。Supervisor 的 prompt 一改，整体策略就跟着改。

**缺点**：每次路由都要过一次 LLM，延迟和成本都上涨；Supervisor 容易成为瓶颈和单点故障。

适合客服分流、研究助手、结构相对固定的工单处理类任务。

## Swarm：去中心化交接模式

Swarm 模式没有主管。每个 Agent 都可以直接把控制权"交接（handoff）"给另一个 Agent，就像一群工蜂根据任务性质互相传递。OpenAI 的 Swarm 库和 LangGraph 的 `langgraph-swarm` 都是这个思路。

```
   用户 --> Agent A --handoff--> Agent B --handoff--> Agent C --> 用户
                     <---handoff---            <---handoff---
```

核心抽象是把 handoff 当成一个"工具"：Agent 调用这个工具，系统就切换活跃 Agent，并把对话历史和状态一起传过去。

```python
from langgraph_swarm import create_swarm, create_handoff_tool

handoff_to_billing = create_handoff_tool(
    agent_name="billing",
    description="当用户询问订单、发票、退款时调用",
)
handoff_to_tech = create_handoff_tool(
    agent_name="tech_support",
    description="当用户遇到产品故障、报错、配置问题时调用",
)

triage = create_react_agent(llm, tools=[handoff_to_billing, handoff_to_tech],
                            name="triage")
billing = create_react_agent(llm, tools=[query_order, refund, handoff_to_tech],
                             name="billing")
tech_support = create_react_agent(llm, tools=[read_logs, restart_service, handoff_to_billing],
                                   name="tech_support")

swarm = create_swarm(
    agents=[triage, billing, tech_support],
    default_active_agent="triage",
)
```

这种设计有个很棒的特性：**用户下一轮对话会直接进入上一次的活跃 Agent**。比如用户上轮在 billing 解决了退款问题，这轮再问"这个订单我还能改地址吗"，就不用再经过 triage，billing 直接接住。

**优点**：无中心瓶颈，专业 Agent 之间可以直接对话；对话连贯性好，符合"谁在处理谁接着说"的直觉。

**缺点**：全局行为更难推理，容易出现无限 handoff；需要给每个 Agent 明确的"什么时候交出去"的指令，否则会抢戏。

适合多域客服、销售与技术分工、角色边界清晰的对话场景。

## Hierarchical：分层嵌套模式

当任务真的很大——比如"帮我做一份行业分析报告"——单层 Supervisor 已经 hold 不住时，就需要分层。上层 Supervisor 把任务拆给下层的 Supervisor，每个下层 Supervisor 再管着自己的一组 Worker Agent。

```
                 顶层 Supervisor
                /               \
        调研 Supervisor      写作 Supervisor
        /      |      \       /         \
    网页搜    PDF阅读  数据   大纲生成   段落撰写
```

LangGraph 的实现用**子图（subgraph）**组合：每个下层团队本身是一个完整的 StateGraph，被当作一个节点挂到上层图里。

```python
# 调研团队（子图）
research_team = StateGraph(TeamState)
research_team.add_node("supervisor", research_supervisor)
research_team.add_node("web_searcher", web_agent)
research_team.add_node("pdf_reader", pdf_agent)
# ... 团队内部路由
research_graph = research_team.compile()

# 写作团队（子图）
writing_graph = build_writing_team()

# 顶层图：把子图当节点
top = StateGraph(TopState)
top.add_node("research_team", research_graph)
top.add_node("writing_team", writing_graph)
top.add_node("top_supervisor", top_supervisor)
top.add_conditional_edges("top_supervisor", route_top_level)
```

**优点**：天然符合组织分工；每个团队有独立的状态空间，互不干扰；可以复用成熟的团队组合不同场景。

**缺点**：层级越深，端到端延迟越大；跨团队传递状态要精心设计，否则信息在层级间衰减。

适合大型研究报告、代码项目（架构师 → 前端 Lead / 后端 Lead → 具体工程师）、企业级知识工作流水线。

## 三种模式对比

下面这张表是实际项目里最常用的选型依据：

| 维度 | Supervisor | Swarm | Hierarchical |
|---|---|---|---|
| 控制流 | 集中 | 分布 | 分层集中 |
| 路由决策 | Supervisor LLM | Agent 自主 handoff | 各层 Supervisor |
| 状态共享 | 全局 state | 交接时传递 | 子图局部 + 顶层全局 |
| Token 成本 | 中（每次过 Supervisor） | 低（直接对话） | 高（多层路由） |
| 可调试性 | 好 | 差 | 中 |
| 适用规模 | 3-8 个 Agent | 3-6 个 Agent | 10+ 个 Agent |
| 代表场景 | 研究助手、工单分流 | 多域客服 | 大型报告、代码项目 |

## 落地时容易踩的坑

不管选哪种模式，下面几点在生产环境里都绕不开：

- **状态爆炸**：多个 Agent 往同一个 state 里塞 message，上下文窗口很快被耗尽。必须做消息裁剪或摘要，只保留对当前 Agent 有用的那段
- **无限循环**：Agent A 把任务扔给 B，B 觉得不归自己管又扔回 A。一定要设置最大步数和循环检测
- **工具污染**：下属 Agent 的工具集不要互相重叠。工具越少，Agent 决策越准
- **错误传播**：下游 Agent 失败时，Supervisor 要有重试或降级策略，不能整个流程挂掉
- **观测**：多 Agent 的调用链比单 Agent 复杂得多，LangSmith、LangFuse 这类可观测性平台几乎是必需品

> 多 Agent 不是银弹。架构模式只是工具，真正决定系统质量的是你对任务的拆解——哪些职责该分、哪些信息该传、哪些决策该谁做。

从工程实践看，大部分团队应该从 **Supervisor** 起步，跑顺了再按需演进到 Swarm 或 Hierarchical。先把一个 Agent 做扎实，再让它们协作，这才是可持续的路径。
