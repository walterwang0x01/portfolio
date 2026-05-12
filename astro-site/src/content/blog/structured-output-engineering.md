---
title: "结构化输出工程：JSON Mode、Structured Outputs、Outlines、BAML 全面对比"
date: 2026-05-12
tags: ["LLM", "工程化", "AI Agent"]
excerpt: "LLM 输出不可控是 Agent 工程化的头号杀手。本文从生产视角对比四种主流结构化输出方案的可靠性、延迟与开发体验，附带选型决策矩阵和落地 checklist。"
emoji: "🧩"
vip: false
draft: false
---

## 为什么结构化输出是 Agent 工程的刚需

当你的 Agent 需要调用工具、写入数据库、或驱动下游流程时，LLM 返回的必须是**可解析的结构化数据**，而不是自由文本。一次 JSON 解析失败就意味着一次用户可见的错误、一次重试开销、甚至一次数据污染。

在 2026 年的生产环境中，我们有四条主流路径来保证输出结构：

1. **JSON Mode** — 模型原生约束，只保证合法 JSON
2. **Structured Outputs** — 模型原生 schema 约束，保证符合指定 JSON Schema
3. **Outlines** — 开源受限解码（constrained decoding），在推理层面强制 schema
4. **BAML** — 编译期类型系统 + 运行时解析修复

它们解决的问题看似相同，但在可靠性、延迟、灵活性和开发体验上差异巨大。

## 四种方案原理速览

### JSON Mode

最早由 OpenAI 在 2023 年底推出，现已成为各家标配。原理是在采样阶段屏蔽会导致非法 JSON 的 token，确保输出是合法 JSON。

```python
from openai import OpenAI

client = OpenAI()
response = client.chat.completions.create(
    model="gpt-4o",
    response_format={"type": "json_object"},
    messages=[
        {"role": "system", "content": "返回 JSON 格式的用户信息，包含 name 和 age 字段"},
        {"role": "user", "content": "张三，28岁"}
    ]
)
# 保证是合法 JSON，但不保证有 name/age 字段
```

**关键限制**：只保证语法合法，不保证 schema 合规。模型可能返回 `{"user": "张三", "years": 28}` 而非你期望的 `{"name": "张三", "age": 28}`。

### Structured Outputs

OpenAI 2024 年推出、Anthropic 和 Google 随后跟进的方案。你提供完整的 JSON Schema，模型在解码时严格遵循。

```python
from pydantic import BaseModel
from openai import OpenAI

class UserInfo(BaseModel):
    name: str
    age: int
    city: str | None = None

client = OpenAI()
response = client.beta.chat.completions.parse(
    model="gpt-4o",
    response_format=UserInfo,
    messages=[
        {"role": "user", "content": "张三，28岁，住在上海"}
    ]
)
user = response.choices[0].message.parsed
# user.name == "张三", user.age == 28, user.city == "上海"
```

**关键优势**：schema 级别的保证，字段名、类型、必填/可选全部强制。首次请求有 schema 编译开销（~1s），后续请求走缓存。

### Outlines（受限解码）

开源方案，在推理引擎层面（vLLM、TGI）通过有限状态机（FSM）约束 token 采样。每一步只允许符合 schema 的 token 被选中。

```python
import outlines
from pydantic import BaseModel

class ToolCall(BaseModel):
    function_name: str
    arguments: dict[str, str]

model = outlines.models.vllm("Qwen/Qwen2.5-72B-Instruct")
generator = outlines.generate.json(model, ToolCall)

result = generator("提取函数调用：搜索北京明天的天气")
# result.function_name == "search_weather"
# result.arguments == {"city": "北京", "date": "明天"}
```

**关键优势**：100% schema 合规（数学保证），适用于任何开源模型，无需模型本身支持结构化输出。

### BAML（Boundary AI Markup Language）

类型优先的方案。你用 BAML DSL 定义输出类型，编译器生成多语言客户端，运行时解析器能修复常见的 LLM 输出瑕疵（多余逗号、缺失引号、markdown 包裹等）。

```typescript
// schema.baml
class ToolCall {
  function_name string
  arguments map<string, string>
  confidence float @description("0-1 置信度")
}

function ExtractToolCall(input: string) -> ToolCall {
  client "openai/gpt-4o"
  prompt #"
    从用户输入中提取工具调用信息。
    {{ input }}
  "#
}
```

```typescript
// 生成的 TypeScript 客户端
import { b } from './baml_client';

const result = await b.ExtractToolCall("搜索北京明天的天气");
// result: { function_name: "search_weather", arguments: {...}, confidence: 0.95 }
```

**关键优势**：编译期类型安全 + 运行时容错解析，开发体验接近传统 RPC。

## 核心维度对比

| 维度 | JSON Mode | Structured Outputs | Outlines | BAML |
|------|-----------|-------------------|----------|------|
| Schema 合规保证 | ❌ 仅语法 | ✅ 强保证 | ✅ 数学保证 | ⚠️ 解析修复 |
| 首次延迟 | 无额外 | +0.5-1s（编译） | 无额外 | 无额外 |
| 推理延迟影响 | 极小 | 小 | 中等（FSM 开销） | 无（后处理） |
| 模型要求 | 主流 API | 特定 API | 任意开源模型 | 任意模型 |
| 嵌套/递归 schema | ❌ | ⚠️ 有限制 | ✅ | ✅ |
| 枚举/联合类型 | ❌ | ✅ | ✅ | ✅ |
| 容错能力 | ❌ | ❌ 严格拒绝 | ❌ 严格拒绝 | ✅ 自动修复 |
| 自托管支持 | 需模型支持 | 需模型支持 | ✅ 原生 | ✅ 任意后端 |
| 多语言 SDK | 各厂商 SDK | 各厂商 SDK | Python | TS/Python/Ruby |

## 生产环境中的真实陷阱

### 陷阱 1：Structured Outputs 的 schema 限制

OpenAI 的 Structured Outputs 不支持所有 JSON Schema 特性。`additionalProperties` 必须为 `false`，不支持 `patternProperties`，递归深度有限。这意味着你不能直接用一个通用的 JSON Schema 验证器生成的 schema。

```python
# ❌ 这会被拒绝
schema = {
    "type": "object",
    "properties": {"data": {"type": "object"}},  # 缺少 properties 定义
    "additionalProperties": True  # 不允许
}

# ✅ 必须完全展开
schema = {
    "type": "object",
    "properties": {
        "data": {
            "type": "object",
            "properties": {"key": {"type": "string"}, "value": {"type": "string"}},
            "required": ["key", "value"],
            "additionalProperties": False
        }
    },
    "required": ["data"],
    "additionalProperties": False
}
```

### 陷阱 2：Outlines 的性能退化

当 schema 复杂度上升（深层嵌套、大枚举），FSM 状态数爆炸，推理速度显著下降。实测 Qwen2.5-72B 在 10 层嵌套 schema 下，吞吐量下降约 40%。

### 陷阱 3：BAML 的解析修复不是万能的

BAML 的容错解析能处理 90%+ 的常见问题，但对于语义错误（字段值填错位置）无能为力。它修复的是格式，不是语义。

## 选型决策矩阵

```
你用 API 还是自托管模型？
├── API（OpenAI / Anthropic / Google）
│   ├── 需要 100% schema 合规？
│   │   ├── 是 → Structured Outputs
│   │   └── 否 → JSON Mode + Pydantic 验证 + 重试
│   └── 需要跨模型统一接口？
│       └── 是 → BAML
└── 自托管（vLLM / TGI）
    ├── 模型支持 Structured Outputs？
    │   ├── 是 → 用模型原生能力
    │   └── 否 → Outlines
    └── 需要最大吞吐量？
        ├── 是 → JSON Mode + 后验证（避免 FSM 开销）
        └── 否 → Outlines
```

## 混合策略：生产环境的最佳实践

在真实的 Agent 系统中，单一方案往往不够。推荐分层策略：

```python
from pydantic import BaseModel, ValidationError
from openai import OpenAI
import json

class ToolCallSchema(BaseModel):
    function_name: str
    arguments: dict[str, str]

async def extract_tool_call(user_input: str) -> ToolCallSchema:
    client = OpenAI()

    # 第一层：尝试 Structured Outputs（最可靠）
    try:
        response = client.beta.chat.completions.parse(
            model="gpt-4o",
            response_format=ToolCallSchema,
            messages=[{"role": "user", "content": user_input}]
        )
        return response.choices[0].message.parsed
    except Exception:
        pass

    # 第二层：降级到 JSON Mode + Pydantic 验证
    response = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": f"返回 JSON，schema: {ToolCallSchema.model_json_schema()}"},
            {"role": "user", "content": user_input}
        ]
    )
    raw = json.loads(response.choices[0].message.content)

    # 第三层：Pydantic 宽松解析（字段别名、类型转换）
    return ToolCallSchema.model_validate(raw)
```

这种分层降级策略在生产中能将结构化输出的成功率从 95% 提升到 99.9%+。

## 落地 Checklist

- [ ] **明确 schema 复杂度**：简单平铺 → JSON Mode 够用；嵌套/枚举/联合类型 → 必须 Structured Outputs 或 Outlines
- [ ] **测量首次延迟预算**：Structured Outputs 首次编译约 0.5-1s，对实时场景需预热
- [ ] **建立 schema 版本管理**：输出 schema 变更等同于 API breaking change，需要版本控制
- [ ] **实现降级链路**：Structured Outputs → JSON Mode → 自由文本 + 正则提取
- [ ] **监控解析成功率**：低于 99% 就该排查 prompt 或 schema 设计问题
- [ ] **自托管场景评估 FSM 开销**：Outlines 在复杂 schema 下的吞吐量损失是否可接受
- [ ] **考虑 BAML 的场景**：多模型切换频繁、需要跨语言类型安全时，BAML 的 ROI 最高
- [ ] **端到端测试**：用真实 LLM 输出（而非 mock）跑 schema 验证，捕获边界 case
