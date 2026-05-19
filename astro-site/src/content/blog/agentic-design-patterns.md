---
title: "Agentic 设计模式实战：从 Prompt Chaining 到多 Agent 协作的架构指南"
date: 2026-04-30
tags: ["Agentic 设计模式", "Agent 架构", "LangGraph"]
excerpt: "构建 AI Agent 不是调一次 API 就完事。Anthropic 总结了 5 种 Workflow 模式和自主 Agent 模式，本文用代码拆解每种模式的适用场景、实现方式和选型决策框架。"
vip: false
draft: false
---
很多人以为构建 AI Agent 就是给 LLM 加几个工具调用。实际上，**Agent 的核心不在模型，而在编排**——你怎么组织 LLM 的调用顺序、怎么处理中间结果、怎么在失败时恢复，这些决定了 Agent 能不能从 Demo 走向生产。

Anthropic 在 "Building Effective Agents" 指南中提出了一个关键区分：**Workflow（工作流）和 Agent（自主体）是两种不同的 Agentic 系统**。Workflow 按预定义路径编排 LLM 调用，可预测、可控；Agent 让模型自主决策执行路径，灵活但不确定性更高。大多数生产系统需要的是 Workflow，而不是完全自主的 Agent。

本文基于 [tech-learning-and-projects](https://github.com/walterwang0x01/tech-learning-and-projects) 仓库中的 Agentic 设计模式学习笔记，用代码拆解每种模式的实现方式和适用场景。

## 先搞清楚：Workflow vs Agent

这是选型的第一个分叉点。两者的核心区别在于**控制权在谁手里**：

-   **Workflow**：开发者定义执行路径，LLM 按固定流程调用。可预测、易调试、成本可控。
-   **Agent**：LLM 自主决定下一步做什么、用什么工具。灵活、适应性强，但调试复杂、成本难控。

Anthropic 的核心原则是：**从简单开始，仅在必要时增加复杂度**。如果 Prompt Chaining 能解决问题，就不要上多 Agent 系统。

## 模式一：Prompt Chaining（提示链）

最简单的模式：把任务拆成多步，前一步的输出作为后一步的输入，中间可以插入验证门控。

```
# 提示链：生成 → 验证 → 优化
def prompt_chaining(topic: str) -> dict:
    # 步骤1：生成初稿
    draft = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"写一篇关于 {topic} 的技术博客大纲"}]
    ).content[0].text

    # 门控：验证质量
    validation = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=256,
        messages=[{"role": "user", "content": f"评估大纲质量，回答 PASS 或 FAIL：\n{draft}"}]
    ).content[0].text

    if "FAIL" in validation.upper():
        return {"status": "rejected", "draft": draft}

    # 步骤2：扩展为完整文章
    article = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=4096,
        messages=[{"role": "user", "content": f"基于大纲写完整文章：\n{draft}"}]
    ).content[0].text

    return {"status": "success", "article": article}
```

**适用场景**：线性流程，每一步的输入输出明确。比如"生成文案 → 审核合规 → 翻译多语言"。门控机制是关键——它让你在流程中间就能拦截低质量输出，而不是等到最后才发现问题。

## 模式二：Routing（路由分发）

对输入进行分类，路由到不同的专业处理器。每个处理器有自己的 System Prompt，专注于一类任务。

```
# 路由：分类 → 分发到专业处理器
def routing_workflow(user_input: str) -> str:
    # 分类器
    category = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=50,
        messages=[{"role": "user", "content": f"""将请求分类为：
code_help / general_qa / creative_writing
请求：{user_input}
只输出类别名称。"""}]
    ).content[0].text.strip()

    # 专业处理器（不同的 System Prompt）
    handlers = {
        "code_help": "你是资深程序员，提供精确的代码解决方案。",
        "general_qa": "你是知识渊博的助手，提供准确简洁的回答。",
        "creative_writing": "你是创意写作专家，文笔优美富有想象力。",
    }

    system_prompt = handlers.get(category, handlers["general_qa"])
    return client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=2048,
        system=system_prompt,
        messages=[{"role": "user", "content": user_input}]
    ).content[0].text
```

**适用场景**：输入类型多样，不同类型需要不同的处理策略。比如客服系统中，技术问题、退款请求、产品咨询需要不同的处理逻辑。路由的好处是**关注点分离**——每个处理器只需要做好一件事。

## 模式三：Parallelization（并行化）

将任务拆分为独立子任务并行处理，或者多次生成后投票取最优。这是提升吞吐量和输出质量的利器。

```
import asyncio
from anthropic import AsyncAnthropic

async_client = AsyncAnthropic()

# 并行分段：同时生成文章各部分
async def parallel_sectioning(topic: str) -> dict:
    sections = ["引言", "核心概念", "实践案例", "总结"]

    async def generate_section(section: str) -> str:
        resp = await async_client.messages.create(
            model="claude-sonnet-4-6-20260401",
            max_tokens=1024,
            messages=[{"role": "user",
                       "content": f"为 {topic} 文章写 {section} 部分"}]
        )
        return resp.content[0].text

    results = await asyncio.gather(
        *[generate_section(s) for s in sections]
    )
    return dict(zip(sections, results))
```

**适用场景**：子任务之间没有依赖关系，可以同时执行。比如同时搜索多个数据源、同时生成文章的不同章节。另一个变体是**投票模式**——对同一个问题生成 3 次答案，取多数一致的结果，用于提高关键决策的可靠性。

## 模式四：Orchestrator-Workers（编排-工作者）

中央编排 LLM 动态分解任务，委派给工作者 LLM 执行，最后合并结果。和并行化的区别在于：**子任务不是预定义的，而是由编排者根据输入动态生成的**。

```
import json

def orchestrator_workers(task: str) -> dict:
    # 编排者：动态分解任务
    plan = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"""将任务分解为子任务，输出 JSON 数组：
任务：{task}
格式：[{{"id": 1, "subtask": "描述", "type": "research|code|write"}}]"""}]
    ).content[0].text

    subtasks = json.loads(plan)

    # 工作者：执行各子任务
    results = {}
    for st in subtasks:
        worker_resp = client.messages.create(
            model="claude-sonnet-4-6-20260401",
            max_tokens=2048,
            messages=[{"role": "user",
                       "content": f"执行以下任务：{st['subtask']}"}]
        ).content[0].text
        results[st["id"]] = worker_resp

    # 编排者：合并结果
    synthesis = client.messages.create(
        model="claude-sonnet-4-6-20260401",
        max_tokens=4096,
        messages=[{"role": "user", "content":
            f"合并子任务结果为完整输出：\n{json.dumps(results, ensure_ascii=False)}"}]
    ).content[0].text

    return {"plan": subtasks, "result": synthesis}
```

**适用场景**：任务复杂度不确定，需要根据输入动态决定拆分方式。比如"帮我重构这个模块"——编排者先分析代码结构，再决定拆成哪些子任务。

## 模式五：Evaluator-Optimizer（评估-优化循环）

一个 LLM 生成，另一个评估，循环迭代直到满足质量标准。这是**反思（Reflection）模式**的工程化实现。

```
def evaluator_optimizer(task: str, max_iterations: int = 3) -> str:
    current_output = ""

    for i in range(max_iterations):
        # 生成器
        gen_prompt = (f"任务：{task}" if i == 0
            else f"任务：{task}\n上次输出：{current_output}\n改进建议：{feedback}\n请改进。")
        current_output = client.messages.create(
            model="claude-sonnet-4-6-20260401",
            max_tokens=2048,
            messages=[{"role": "user", "content": gen_prompt}]
        ).content[0].text

        # 评估器
        eval_resp = client.messages.create(
            model="claude-sonnet-4-6-20260401",
            max_tokens=512,
            messages=[{"role": "user", "content":
                f"评估输出质量（1-10分）：\n任务：{task}\n输出：{current_output}\n格式：SCORE: X\nFEEDBACK: ..."}]
        ).content[0].text

        score = int(eval_resp.split("SCORE:")[1].split("\n")[0].strip())
        feedback = eval_resp.split("FEEDBACK:")[1].strip()

        if score >= 8:
            break  # 质量达标，退出循环

    return current_output
```

**适用场景**：对输出质量要求高，且有明确的评估标准。比如代码生成后自动跑测试、文案生成后检查品牌合规。关键是**设置退出条件**——分数阈值和最大迭代次数，避免无限循环。

## 自主 Agent：ReAct 循环

当任务足够开放、无法预定义流程时，才需要自主 Agent。Agent 在循环中自主决定使用什么工具，直到完成任务或达到轮次上限。

```
def autonomous_agent(task: str, max_turns: int = 10) -> str:
    messages = [{"role": "user", "content": task}]

    for _ in range(max_turns):
        response = client.messages.create(
            model="claude-sonnet-4-6-20260401",
            max_tokens=4096,
            tools=tools,
            messages=messages,
        )

        # 无工具调用 → 任务完成
        if response.stop_reason == "end_turn":
            return next(
                b.text for b in response.content if b.type == "text"
            )

        # 执行工具调用
        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = execute_tool(block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result
                })
        messages.append({"role": "user", "content": tool_results})

    return "达到最大轮次限制"
```

自主 Agent 的风险在于**不可预测性**——你不知道它会调用多少次工具、花多少 Token。生产环境中必须设置轮次上限、Token 预算和护栏（Guardrails）。

## 选型决策框架

面对一个具体任务，怎么选模式？按这个决策路径走：

-   **流程固定、步骤明确？** → Prompt Chaining
-   **输入类型多样，需要分类处理？** → Routing
-   **子任务独立，可以同时跑？** → Parallelization
-   **任务复杂，需要动态拆分？** → Orchestrator-Workers
-   **对输出质量要求高，需要迭代？** → Evaluator-Optimizer
-   **任务开放，无法预定义流程？** → 自主 Agent（ReAct）

一个实用的经验法则：**如果你能画出流程图，就用 Workflow；如果画不出来，才考虑 Agent**。

## 生产环境中的关键补充模式

除了 Anthropic 的五种核心模式，生产环境还需要几个补充模式：

-   **Human-in-the-Loop（人机协作）**：在高风险操作前暂停，等待人工审批。LangGraph 的 `interrupt()` 原生支持这个模式。
-   **Guardrails（护栏）**：在 Agent 输入/输出处设置安全检查——PII 检测、Prompt 注入防御、输出合规过滤。
-   **Fallback（降级）**：主 Agent 失败时降级到简化版本，再失败则升级给人工。三层防线确保服务可用性。
-   **Checkpoint（检查点）**：长时间运行的工作流需要持久化中间状态，服务重启后能从断点恢复。LangGraph 支持 PostgreSQL/Redis 检查点。

## 2026 年的新趋势：从自建到托管

2026 年 Agent 设计模式领域最大的变化是**运行时托管化**。Anthropic 推出 Managed Agents，将 Agent 从"开发者自建 harness"升级为"平台托管运行时"。开发者只需定义 Agent 的指令、工具和约束，运行时由平台维护。

这背后的逻辑是：harness（Agent 运行时）中编码的假设会随模型进步而过时。当模型从 Sonnet 升级到 Opus，原来精心调优的重试策略、上下文压缩逻辑可能反而成为瓶颈。把 harness 交给平台，让它随模型升级自动优化，是更可持续的方案。

另一个趋势是 **Cartesian Cut 理论**（arXiv 2604.07745）提出的三条设计路径：Bounded Services（有界服务）、Cartesian Agents（笛卡尔 Agent）、Integrated Agents（集成 Agent）。当前主流框架几乎都属于 Cartesian Agents——通过符号接口（工具调用、状态）将 LLM 与运行时耦合。这带来了模块化和可审计性，但也引入了接口瓶颈。

## 写在最后

设计模式不是银弹，而是工具箱。最好的 Agent 架构不是用了最复杂的模式，而是用了**最匹配问题的模式**。Prompt Chaining 能解决的问题，不要上 Orchestrator-Workers；Workflow 能搞定的场景，不要上自主 Agent。

记住 Anthropic 的核心原则：从简单开始，仅在必要时增加复杂度。

> 本文内容基于 [tech-learning-and-projects](https://github.com/walterwang0x01/tech-learning-and-projects) 仓库中的 Agentic 设计模式学习笔记，包含更详细的代码示例和框架对比。
