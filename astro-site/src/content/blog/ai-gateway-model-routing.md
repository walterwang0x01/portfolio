---
title: "AI 网关与模型路由：生产级 Agent 的流量调度中枢"
date: 2026-05-04
tags: ["AI 网关", "模型路由", "LLM 工程"]
excerpt: "当你的 Agent 同时调用 GPT-4o、Claude、Gemini 和开源模型时，谁来统一管理 API Key、负载均衡、故障切换和成本控制？AI 网关就是答案。深度对比 LiteLLM、Portkey、Vercel AI Gateway 三大方案。"
vip: false
draft: false
---
你的 Agent 项目终于要上生产了。开发阶段用的是 GPT-4o，效果不错。但产品经理说："Claude 在某些场景下效果更好，能不能混着用？"运维同事问："万一 OpenAI 挂了怎么办？"财务说："这个月 API 费用超预算了，能不能自动切便宜的模型？"

你发现自己需要在代码里写一堆 `if model == "gpt-4o"` 的分支逻辑，每个模型的 API 格式还不一样，错误处理各有各的坑。**这就是 AI 网关要解决的问题。**

AI 网关（AI Gateway）是 LLM 应用和模型提供商之间的代理层，统一处理认证、路由、负载均衡、故障切换、成本控制和可观测性。它之于 LLM 应用，就像 Nginx 之于 Web 服务——你不会让每个后端服务自己处理 SSL 和限流，同样也不该让每个 Agent 自己管理模型调用。

## 为什么需要 AI 网关

先看一个没有网关时的典型痛点清单：

```
┌─────────────────────────────────────────────────┐
│              没有 AI 网关的世界                    │
├─────────────────────────────────────────────────┤
│ 🔑 API Key 散落在各个服务的 .env 里               │
│ 🔄 OpenAI 限流了，整个系统跟着挂                   │
│ 💰 月底才发现某个 Agent 烧了 $2000                 │
│ 📊 不知道哪个模型的延迟最高、错误最多               │
│ 🔀 想换模型要改代码、重新部署                       │
│ 🛡️ 没有统一的 PII 过滤和内容审核                   │
└─────────────────────────────────────────────────┘
```

AI 网关把这些横切关注点从业务代码中抽离出来，集中管理：

-   **统一接口**：所有模型用同一套 OpenAI 兼容 API 调用，切换模型只改配置不改代码
-   **故障切换**：主模型超时或报错时，自动 fallback 到备用模型
-   **负载均衡**：多个 API Key 轮询，突破单 Key 的 RPM/TPM 限制
-   **成本控制**：实时追踪 token 消耗，按模型/用户/项目维度统计
-   **可观测性**：统一的请求日志、延迟指标、错误率监控

## 三大方案横向对比

目前主流的 AI 网关方案有三个：**LiteLLM**（开源自托管）、**Portkey**（商业 SaaS + 开源网关）、**Vercel AI SDK**（前端友好的轻量方案）。它们的定位和适用场景差异很大：

```
┌──────────────┬──────────────┬──────────────┬──────────────┐
│   维度        │  LiteLLM     │  Portkey     │ Vercel AI SDK│
├──────────────┼──────────────┼──────────────┼──────────────┤
│ 部署方式      │ 自托管       │ SaaS / 自托管 │ SDK 集成      │
│ 支持模型数    │ 100+         │ 250+         │ 20+          │
│ 核心优势      │ 开源免费     │ 企业级治理    │ 前端流式体验  │
│ 统一 API      │ ✅ OpenAI 兼容│ ✅ OpenAI 兼容│ ✅ 统一接口   │
│ 故障切换      │ ✅           │ ✅           │ ⚠️ 需手动     │
│ 负载均衡      │ ✅           │ ✅           │ ❌           │
│ 成本追踪      │ ✅           │ ✅ 高级      │ ⚠️ 基础      │
│ 语义缓存      │ ✅           │ ✅           │ ❌           │
│ 内容审核      │ ⚠️ 需集成    │ ✅ 内置      │ ❌           │
│ 适合场景      │ 后端/Agent   │ 企业级生产   │ 全栈 Web 应用 │
│ 学习曲线      │ 低           │ 中           │ 低           │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

## LiteLLM：开源世界的瑞士军刀

LiteLLM 是目前最流行的开源 AI 网关，核心卖点是**用 OpenAI 的 API 格式调用 100+ 模型**。无论你用的是 Claude、Gemini、Mistral 还是本地部署的 Ollama，代码写法完全一样：

```
from litellm import completion

# 调用 OpenAI
response = completion(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}]
)

# 切换到 Claude，代码结构完全不变
response = completion(
    model="claude-sonnet-4-20250514",
    messages=[{"role": "user", "content": "你好"}]
)

# 甚至本地 Ollama 模型
response = completion(
    model="ollama/llama3",
    messages=[{"role": "user", "content": "你好"}],
    api_base="http://localhost:11434"
)
```

这意味着你的 Agent 代码里不需要写任何模型特定的逻辑。想换模型？改一个字符串就行。

### LiteLLM Proxy：生产级网关服务

LiteLLM 不只是一个 Python SDK，它还提供了一个独立的 Proxy Server，可以作为所有 LLM 请求的统一入口：

```
# config.yaml - LiteLLM Proxy 配置
model_list:
  - model_name: "gpt-4o"        # 你的应用使用的模型名
    litellm_params:
      model: "gpt-4o"           # 实际调用的模型
      api_key: "sk-xxx"
  
  - model_name: "gpt-4o"        # 同名模型，多 Key 负载均衡
    litellm_params:
      model: "gpt-4o"
      api_key: "sk-yyy"
  
  - model_name: "claude-sonnet"
    litellm_params:
      model: "claude-sonnet-4-20250514"
      api_key: "sk-ant-xxx"

# 故障切换：gpt-4o 失败时自动切到 claude-sonnet
router_settings:
  routing_strategy: "simple-shuffle"  # 负载均衡策略
  num_retries: 2
  fallbacks: [
    {"gpt-4o": ["claude-sonnet"]}
  ]

# 成本预算：每天最多花 $50
general_settings:
  max_budget: 50
  budget_duration: "1d"
```

启动 Proxy 后，所有服务只需要把 `base_url` 指向 LiteLLM Proxy，就能享受负载均衡、故障切换和成本控制：

```
# 所有服务统一通过 Proxy 调用
import openai

client = openai.OpenAI(
    base_url="http://litellm-proxy:4000",  # 指向 Proxy
    api_key="sk-your-proxy-key"             # Proxy 的虚拟 Key
)

# 应用代码完全不感知底层用的是哪个模型/哪个 Key
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "分析这段代码"}]
)
```

## Portkey：企业级 AI 治理平台

如果说 LiteLLM 是"开发者的瑞士军刀"，Portkey 就是"企业的 AI 管控中心"。它在网关能力之上，增加了**治理、合规、团队协作**等企业级功能。

Portkey 的核心概念是 **Virtual Key** 和 **Gateway Config**：

```
from portkey_ai import Portkey

# 初始化 Portkey 客户端
portkey = Portkey(
    api_key="YOUR_PORTKEY_API_KEY",
    virtual_key="openai-virtual-key-xxx"  # 虚拟 Key，隐藏真实 API Key
)

# 调用方式和 OpenAI SDK 完全一致
response = portkey.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}]
)
```

Portkey 的杀手级功能是 **Gateway Config**，用 JSON 声明式地定义复杂的路由策略：

```
{
  "strategy": {
    "mode": "fallback"
  },
  "targets": [
    {
      "virtual_key": "openai-key",
      "override_params": { "model": "gpt-4o" },
      "retry": { "attempts": 2, "on_status_codes": [429, 500] }
    },
    {
      "virtual_key": "anthropic-key",
      "override_params": { "model": "claude-sonnet-4-20250514" }
    },
    {
      "virtual_key": "azure-key",
      "override_params": { "model": "gpt-4o" }
    }
  ]
}
```

这段配置的含义是：优先用 OpenAI GPT-4o，遇到 429（限流）或 500 错误时重试 2 次，如果还是失败就切到 Claude，Claude 也挂了就用 Azure OpenAI。**整个过程对应用代码完全透明。**

### Portkey 的企业级特性

-   **Guardrails（护栏）**：在请求到达模型之前，自动检测 PII（个人信息）、有害内容、Prompt 注入，不合规的请求直接拦截
-   **语义缓存**：语义相似的请求命中缓存，减少重复调用，节省成本
-   **团队管理**：按团队/项目分配预算，设置 RPM/TPM 限额，审计每个成员的用量
-   **A/B 测试**：按权重将流量分配到不同模型，用真实数据对比效果

## Vercel AI SDK：前端开发者的最佳选择

Vercel AI SDK 的定位和前两者不同——它不是独立的网关服务，而是一个**嵌入应用代码的 SDK**，专注于解决全栈 Web 应用中的 LLM 集成问题，尤其是流式响应和前端渲染。

```
// Next.js API Route - 统一的模型调用
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// 切换模型只需要换 provider
const result = await generateText({
  model: openai('gpt-4o'),
  // model: anthropic('claude-sonnet-4-20250514'),
  // model: google('gemini-2.0-flash'),
  prompt: '解释什么是 AI 网关',
});

// 流式响应 - 前端实时渲染
import { streamText } from 'ai';

const result = streamText({
  model: openai('gpt-4o'),
  prompt: '写一篇关于 AI 网关的文章',
});

// 前端直接消费流
return result.toDataStreamResponse();
```

Vercel AI SDK 的优势在于**前端体验**：内置的 `useChat` Hook 让你几行代码就能实现流式聊天界面，自动处理加载状态、错误重试和消息管理。但它缺少负载均衡、语义缓存等网关级功能，更适合中小型项目或作为前端层的补充。

## 生产环境选型建议

选哪个方案取决于你的团队规模、技术栈和核心需求：

-   **个人项目 / 小团队 + Python 后端**：LiteLLM SDK 直接集成，零部署成本，够用
-   **中型团队 + 多服务调用 LLM**：部署 LiteLLM Proxy 作为统一网关，配合 PostgreSQL 做用量统计
-   **企业级 + 合规要求**：Portkey SaaS 或自托管，利用其治理、审计、Guardrails 能力
-   **全栈 Web 应用 + Next.js**：Vercel AI SDK 做前端集成，后端可搭配 LiteLLM Proxy
-   **混合架构**：LiteLLM Proxy（后端网关）+ Vercel AI SDK（前端流式）是一个常见的组合

## 实战：为 Agent 系统搭建网关

以一个典型的 Agent 系统为例，展示如何用 LiteLLM Proxy 搭建生产级网关：

```
# docker-compose.yaml
services:
  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    ports:
      - "4000:4000"
    volumes:
      - ./litellm-config.yaml:/app/config.yaml
    command: ["--config", "/app/config.yaml"]
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/litellm
      - LITELLM_MASTER_KEY=sk-master-xxx
    depends_on:
      - db
      - redis

  db:
    image: postgres:16
    environment:
      POSTGRES_DB: litellm
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass

  redis:
    image: redis:7-alpine
```

部署完成后，你的 Agent 系统架构变成：

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Agent 服务  │────▶│ LiteLLM Proxy│────▶│  OpenAI     │
│  (FastAPI)  │     │  :4000       │  │  │  Claude     │
└─────────────┘     │              │  │  │  Gemini     │
┌─────────────┐     │  负载均衡     │  │  │  Ollama     │
│  RAG 服务   │────▶│  故障切换     │──┘  └─────────────┘
│             │     │  成本控制     │
└─────────────┘     │  请求日志     │     ┌─────────────┐
┌─────────────┐     │              │────▶│  PostgreSQL  │
│  前端 BFF   │────▶│              │     │  (用量统计)  │
└─────────────┘     └──────────────┘     └─────────────┘
```

所有 LLM 请求都经过网关，你可以在一个地方看到全局的 token 消耗、模型延迟、错误率，还能随时调整路由策略而不需要改任何业务代码。

## 关键实践总结

> AI 网关不是"有了更好"，而是生产级 Agent 系统的必备基础设施。就像你不会在生产环境裸跑 HTTP 服务一样，也不该让每个服务直接调用模型 API。

几个关键实践：

-   **Day 1 就用网关**：即使只用一个模型，统一入口也能让你随时切换，避免后期重构
-   **设置成本预算**：按天/周/月设置上限，防止 Agent 死循环烧钱
-   **配置故障切换**：至少准备一个备用模型，OpenAI 的 SLA 不是 100%
-   **监控 P99 延迟**：模型响应时间波动很大，P99 比平均值更能反映真实体验
-   **语义缓存要谨慎**：对话场景不适合缓存，但知识问答、代码生成等幂等场景可以大幅降本

AI 网关是 Agent 工程化的关键一环。选对方案、配好策略，你的 Agent 系统才能在生产环境中稳定、高效、可控地运行。
