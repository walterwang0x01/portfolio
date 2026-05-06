---
title: "Function Calling 实战：让 LLM 操作真实世界"
date: 2026-04-20
tags: ["Function Calling", "LLM"]
excerpt: "Function Calling 是 AI Agent 从'能说'到'能做'的关键技术。从 OpenAI 到 Claude 的实现差异，到并行调用、流式处理的生产级实践。"
vip: false
draft: false
---
LLM 本质上只能生成文本。但通过 **Function Calling**（函数调用），LLM 可以"操作"真实世界——查询数据库、发送邮件、调用 API、操作文件系统。这是 AI Agent 从"能说"到"能做"的关键跳跃。

Function Calling 的核心思路很简单：你告诉 LLM 有哪些工具可用（工具名称、参数定义），LLM 根据用户请求判断是否需要调用工具，如果需要就生成调用参数，你执行工具后把结果返回给 LLM，LLM 再整合生成最终回答。

## 核心流程

```
用户请求 → LLM 判断是否需要工具 → 生成工具调用参数
    → 执行工具 → 结果返回 LLM → 生成最终回答

┌──────┐    ┌──────┐    ┌──────┐    ┌──────┐
│ User │ →  │ LLM  │ →  │ Tool │ →  │ LLM  │ → 最终回答
│      │    │判断+参数│   │ 执行  │    │ 整合  │
└──────┘    └──────┘    └──────┘    └──────┘
```

注意：**LLM 本身不执行工具**，它只是生成"我想调用 get\_weather，参数是 city=北京"这样的结构化输出。实际执行是你的代码负责的。这个设计保证了安全性——你可以在执行前做权限检查、参数校验、审计日志。

## OpenAI Function Calling 实战

```
from openai import OpenAI
import json

client = OpenAI()

# 定义工具（JSON Schema 格式）
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "获取指定城市的天气信息",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["city"]
        }
    }
}]

# 第一轮：LLM 决定调用工具
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "北京今天天气怎么样？"}],
    tools=tools,
    tool_choice="auto"  # auto / required / none
)

message = response.choices[0].message
if message.tool_calls:
    tool_call = message.tool_calls[0]
    args = json.loads(tool_call.function.arguments)
    result = get_weather(**args)  # 你的代码执行工具

    # 第二轮：将结果返回 LLM 整合
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "user", "content": "北京今天天气怎么样？"},
            message,
            {"role": "tool", "tool_call_id": tool_call.id,
             "content": json.dumps(result)}
        ]
    )
    print(response.choices[0].message.content)
```

## Claude Function Calling 的差异

Claude 的实现和 OpenAI 有几个关键差异：

-   **参数定义**：Claude 用 `input_schema` 而不是 `parameters`
-   **响应结构**：Claude 用 content-block 架构，工具调用和文本响应清晰分离
-   **可靠性**：2026 Q1 评测中，Claude 工具调用可靠性评分 8.4/10，领先 OpenAI 的 6.3/10

```
import anthropic

client = anthropic.Anthropic()

tools = [{
    "name": "query_database",
    "description": "查询数据库获取信息",
    "input_schema": {  # 注意：不是 parameters
        "type": "object",
        "properties": {
            "sql": {"type": "string", "description": "SQL 查询语句"},
            "database": {"type": "string", "description": "数据库名称"}
        },
        "required": ["sql"]
    }
}]

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    tools=tools,
    messages=[{"role": "user", "content": "查询上月销售额最高的产品"}]
)

# Claude 的 content-block 架构
for block in response.content:
    if block.type == "tool_use":
        result = execute_sql(block.input["sql"])
        # 返回结果继续对话...
```

## 并行工具调用

当用户问"北京和上海今天天气怎么样？"时，LLM 可以一次返回两个工具调用，你可以并行执行它们：

```
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "北京和上海天气怎么样？"}],
    tools=tools,
    parallel_tool_calls=True  # 启用并行
)

# message.tool_calls 包含多个调用
# [ToolCall("get_weather", {"city":"北京"}),
#  ToolCall("get_weather", {"city":"上海"})]

import asyncio

async def execute_parallel(tool_calls):
    tasks = [asyncio.create_task(
        async_get_weather(**json.loads(tc.function.arguments))
    ) for tc in tool_calls]
    return await asyncio.gather(*tasks)
```

并行调用能显著降低延迟。如果两个工具各需要 1 秒，串行需要 2 秒，并行只需要 1 秒。

## 多模型对比

不同模型在 Function Calling 上的能力差异：

-   **最大工具数**：OpenAI 128 个、Gemini 128 个、Claude 64 个
-   **工具可靠性**：Claude 8.4/10 > Gemini 7.9/10 > OpenAI 6.3/10
-   **并行调用**：三家都支持
-   **流式调用**：三家都支持，但实现方式不同

## 生产环境最佳实践

1.  **工具描述要精确**：LLM 根据 description 决定何时调用工具，模糊的描述会导致误调用或漏调用
2.  **参数校验不可少**：LLM 生成的参数可能不合法（比如 SQL 注入），执行前必须校验
3.  **设置超时和重试**：工具执行可能失败或超时，需要有兜底策略
4.  **记录审计日志**：每次工具调用都应该记录，便于调试和安全审计
5.  **控制工具数量**：工具太多会增加 token 消耗和降低选择准确率，建议根据用户意图动态选择工具子集
6.  **用 `tool_choice` 控制行为**：`auto`（LLM 自行判断）、`required`（强制调用）、`none`（禁止调用），根据场景选择

## Function Calling vs MCP

Function Calling 是模型层面的能力，MCP 是协议层面的标准。两者的关系：

-   **Function Calling**：定义了 LLM 如何生成工具调用参数和处理返回结果
-   **MCP**：定义了 AI 应用如何发现和连接外部工具服务
-   **实际使用**：MCP Server 暴露工具定义 → AI 应用将其转换为 Function Calling 格式 → LLM 生成调用 → 通过 MCP 协议执行

简单说：Function Calling 是"LLM 怎么调工具"，MCP 是"工具怎么被发现和连接"。

> Function Calling 是 AI Agent 的基石能力。掌握了它，你就理解了 Agent 如何与真实世界交互。我的 [GitHub 仓库](https://github.com/WalterHandsome/tech-learning-and-projects) 中有 4 篇工具与 Function Calling 的深度笔记，覆盖机制原理、MCP Server 开发、工具编排与安全。
