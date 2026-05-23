---
title: "从 POC 到生产：AI Agent 上线 Checklist"
date: 2026-05-23
tags: ["AI Agent", "工程化", "Agent 架构"]
excerpt: "Demo 跑通到线上稳定运行，差的不是模型而是工程链路。一份在生产环境踩过坑后整理的 Agent 上线 checklist：从可观测、容错、成本到灰度发布的 9 个关键决策点。"
emoji: "🚀"
vip: false
draft: false
---

做 AI Agent 的团队大多卡在同一个地方：Demo 演示能跑通端到端流程，一旦放到真实流量就开始翻车。LLM 抽风、工具超时、成本飙升、线上行为难以复现……每一个都能让上线推迟一个月。

这份 checklist 来自踩过坑的经验：从一个能跑的 POC 到能扛住真实业务的 Agent，至少要补齐 9 个工程链路。**模型不是瓶颈，工程化才是。**

## 一、POC 跟生产差在哪

很多团队的 POC 阶段大概是这样的：

```python
# POC 版本的 Agent 调用
def run_agent(user_input: str) -> str:
    response = openai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": user_input}],
        tools=TOOLS,
    )
    if response.choices[0].message.tool_calls:
        result = execute_tool(response.choices[0].message.tool_calls[0])
        return summarize(result)
    return response.choices[0].message.content
```

跑通一个单 case 不难，难的是这个调用要扛住：

- 同时 1000 个用户的并发，单次请求成本控制在预算内
- 模型偶尔返回不合规 JSON 时不让整条链路崩
- 上游 API 超时、限流、500 时优雅降级
- 上线后能定位「为什么用户 A 的这次对话出了问题」
- 改一版 prompt 不会让昨天能跑的 case 今天炸掉

POC 跟生产的差距，是这 9 件事：

| 维度 | POC | 生产 |
|---|---|---|
| 错误处理 | try/except 包一层 | 分类重试 + 熔断 + 降级 |
| 可观测 | print + 日志 | 链路追踪 + 指标 + 回放 |
| 成本 | 看月底账单 | 实时预算 + 自动降级 |
| Prompt 管理 | 写在代码里 | 版本化 + AB + 回滚 |
| 数据持久化 | 内存或 SQLite | 完整对话 + 工具调用记录 |
| 灰度 | 直接全量 | 流量切分 + 快速回滚 |
| 安全 | 无 | Prompt 注入防护 + 输出过滤 |
| 性能 | 单线程 | 异步 + 缓存 + 流式 |
| 评测 | 人工抽查 | 离线评测集 + 在线指标 |

下面逐项说怎么补。

## 二、错误处理：不是包 try 就够

LLM 调用的错误不是同一种错误。把它们当成一类处理，要么过度重试浪费成本，要么该重试的没重试。

```python
from enum import Enum
import asyncio
from openai import APITimeoutError, RateLimitError, APIError

class ErrorClass(Enum):
    RETRIABLE_TRANSIENT = "retriable_transient"  # 网络抖动、5xx
    RETRIABLE_RATE_LIMIT = "retriable_rate_limit"  # 限流
    NON_RETRIABLE_INPUT = "non_retriable_input"  # context 超长、内容违规
    NON_RETRIABLE_AUTH = "non_retriable_auth"  # API key 失效
    UNKNOWN = "unknown"

def classify_error(err: Exception) -> ErrorClass:
    if isinstance(err, APITimeoutError):
        return ErrorClass.RETRIABLE_TRANSIENT
    if isinstance(err, RateLimitError):
        return ErrorClass.RETRIABLE_RATE_LIMIT
    if isinstance(err, APIError):
        if err.status_code in (401, 403):
            return ErrorClass.NON_RETRIABLE_AUTH
        if err.status_code == 400:
            return ErrorClass.NON_RETRIABLE_INPUT
        if 500 <= err.status_code < 600:
            return ErrorClass.RETRIABLE_TRANSIENT
    return ErrorClass.UNKNOWN

async def call_with_retry(fn, max_retries=3):
    for attempt in range(max_retries):
        try:
            return await fn()
        except Exception as e:
            cls = classify_error(e)
            if cls in (ErrorClass.NON_RETRIABLE_INPUT, ErrorClass.NON_RETRIABLE_AUTH):
                raise  # 立即抛，不浪费重试
            if cls == ErrorClass.RETRIABLE_RATE_LIMIT:
                await asyncio.sleep(2 ** attempt * 2)  # 限流退避更久
            else:
                await asyncio.sleep(2 ** attempt * 0.5)
    raise RuntimeError("max retries exceeded")
```

**容错三原则**：

1. **分类**：限流、超时、内容违规、认证失败要分开处理，重试策略不一样
2. **降级**：主模型失败要能降级到备用模型，比如 GPT-4o → GPT-4o-mini → 规则系统
3. **熔断**：上游 API 持续失败时主动熔断，避免雪崩。用 `pybreaker` 或 `circuit-breaker-py` 库

## 三、可观测：链路追踪是底线

线上一旦出问题，「为什么这次对话失败了」这个问题要能在 5 分钟内回答。少了链路追踪，调试就是猜。

最低要求：每次 Agent 执行记录一条 trace，包含完整的工具调用和模型响应。

```python
from langfuse import Langfuse
from langfuse.decorators import observe

langfuse = Langfuse()

@observe(name="agent_run")
async def run_agent(user_input: str, user_id: str) -> str:
    langfuse.update_current_trace(user_id=user_id, input=user_input)

    messages = [{"role": "user", "content": user_input}]
    for step in range(MAX_STEPS):
        response = await llm_call(messages)
        if not response.tool_calls:
            return response.content

        for call in response.tool_calls:
            tool_result = await execute_tool_traced(call)
            messages.append({"role": "tool", "content": tool_result})

@observe(name="tool_call", as_type="tool")
async def execute_tool_traced(call):
    return await execute_tool(call)
```

Langfuse / LangSmith / Arize Phoenix 都能开箱用。挑一个的关键不是功能，是**团队是否会真的去看**。如果选了重型方案但工程师懒得登录，等于没接。

除了 trace，要打的指标至少有：

- 单次 Agent 执行的 P50 / P95 / P99 延迟
- 工具调用成功率（按工具分组）
- 单次执行的 token 消耗分布
- 「Agent 决定不用工具直接回答」的比例（突然飙高通常是 prompt 出问题了）

## 四、成本：实时预算比月底账单重要

GPT-4o 一次推理 0.05 美金看着不多，1000 个并发用户每人 5 轮对话就是 250 美金，一天就能花掉一个工程师的工资。

成本控制的关键是**实时**而不是事后。三个动作：

```python
class TokenBudget:
    def __init__(self, daily_limit_usd: float):
        self.daily_limit = daily_limit_usd
        self.redis_key = f"token_budget:{date.today()}"

    async def check_and_consume(self, estimated_cost: float) -> bool:
        current = float(await redis.get(self.redis_key) or 0)
        if current + estimated_cost > self.daily_limit:
            return False
        await redis.incrbyfloat(self.redis_key, estimated_cost)
        await redis.expire(self.redis_key, 86400)
        return True

async def smart_route(user_input: str, complexity: str) -> str:
    # 简单问题直接降级到小模型
    if complexity == "simple":
        return await call_model("gpt-4o-mini", user_input)

    # 复杂问题先看预算
    budget = TokenBudget(daily_limit_usd=500)
    if not await budget.check_and_consume(estimated_cost=0.05):
        # 预算告急，降级
        return await call_model("gpt-4o-mini", user_input)

    return await call_model("gpt-4o", user_input)
```

省钱组合拳：

- **Prompt Cache**：长 system prompt 上 cache，Anthropic / OpenAI 都支持
- **模型分层**：意图识别用小模型，复杂推理才上大模型
- **流式终止**：用户能在生成中途确认答案就提前终止，省后续 token
- **结果缓存**：相同输入的工具调用结果用 Redis 缓存

## 五、Prompt 管理：别再写在代码里

Prompt 写在代码里有三个致命问题：改 prompt 要发版、没法 AB、出问题没法快速回滚。

生产级方案是 prompt 存配置中心或者数据库，按 key + version 拉取：

```python
@dataclass
class PromptVersion:
    key: str
    version: str
    content: str
    model: str
    temperature: float
    created_at: datetime

class PromptManager:
    async def get(self, key: str, user_id: str = None) -> PromptVersion:
        # 灰度规则：5% 用户走新版本
        if user_id and hash(user_id) % 100 < 5:
            return await self.get_version(key, "v2")
        return await self.get_version(key, "v1")  # 默认稳定版
```

配套要有的：

1. **版本对比**：新旧 prompt 在同一批 case 上的输出差异
2. **回滚机制**：出问题时一行配置改回旧版本
3. **离线评测集**：新 prompt 上线前在 200-500 条历史 case 上跑一遍

工具选型：自建（轻量）、Langfuse Prompts、PromptLayer、Vellum 都行。团队小就别上重的，一个 Postgres 表就够。

## 六、灰度发布：别再全量上线

LLM 的输出对 prompt 改动极度敏感。改一个词都可能让模型行为变化。全量上线 = 把整个 Agent 当赌注。

最低限度的灰度：

```python
class GradualRollout:
    def __init__(self, feature_key: str):
        self.key = feature_key

    async def is_enabled(self, user_id: str) -> bool:
        config = await self.load_config()  # 从配置中心拉
        if config["status"] == "disabled":
            return False
        if config["status"] == "all":
            return True
        # canary: 按 user_id hash 切 N%
        return hash(user_id) % 100 < config["percentage"]
```

灰度路径建议：

```
内部测试（公司内部账号）
  → 1% 真实用户
  → 5% 一天观察
  → 25% 一天观察
  → 50%
  → 100%
```

每一档卡 24 小时观察，看核心指标（成功率、延迟、用户反馈）有没有异常。任何一档异常立刻回滚。

## 七、安全：Prompt 注入是默认威胁

凡是接受外部输入（用户消息、网页内容、文件、工具结果）的 Agent，都要假设输入会包含恶意 prompt。

最低限度的防护：

```python
INJECTION_PATTERNS = [
    r"ignore (previous|all|above) (instructions|prompts)",
    r"you are now (a |an )?",
    r"system\s*:",
    r"<\|.*?\|>",  # 各种特殊 token
]

def sanitize_input(text: str) -> str:
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            log_security_event("possible_injection", text[:200])
    # 不直接拒绝，但加上明确边界标记
    return f"<user_input>\n{text}\n</user_input>"

# 工具返回结果同样处理
def sanitize_tool_output(output: str, tool_name: str) -> str:
    return f"<tool_result tool=\"{tool_name}\">\n{output}\n</tool_result>"
```

更深的防护：

- **权限隔离**：Agent 用的工具按用户角色限权，普通用户的 Agent 不能调用管理员 API
- **输出过滤**：模型输出过一遍敏感信息检测（PII、密钥、违规词）
- **沙盒执行**：代码执行类工具必须在沙盒里跑（E2B、Modal Sandbox）

## 八、性能：异步 + 流式是默认

同步阻塞调 LLM 是浪费。一次 GPT-4o 调用 3-10 秒，期间这个 worker 啥也干不了。生产 Agent 必须全链路异步：

```python
import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI()

async def stream_agent(user_input: str):
    """流式输出 + 并行工具调用"""
    stream = await client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": user_input}],
        tools=TOOLS,
        stream=True,
    )

    tool_calls = []
    async for chunk in stream:
        delta = chunk.choices[0].delta
        if delta.content:
            yield delta.content  # 边生成边返回给前端
        if delta.tool_calls:
            tool_calls.extend(delta.tool_calls)

    if tool_calls:
        # 多个工具并行调用，不要串行
        results = await asyncio.gather(*[
            execute_tool(call) for call in tool_calls
        ])
        # 继续下一轮...
```

性能优化的优先级：

1. 流式输出（用户感知延迟下降 60%）
2. 工具并行调用（多工具场景延迟减半）
3. Prompt Cache（长 prompt 场景延迟降 80%）
4. 模型预热（serverless 部署消除冷启动）

## 九、评测：上线前后都要有评测集

「这版 prompt 比上版好吗」这个问题没有评测集就只能猜。生产 Agent 必备：

- **离线评测集**：50-500 条标注好的 case，每次发版前跑一遍
- **在线评测**：线上请求按规则采样，标注后入评测集
- **回归测试**：核心流程的 golden case，任何一条退化都拒绝上线

```python
async def evaluate_version(prompt_version: str, eval_set: list[Case]) -> EvalReport:
    results = []
    for case in eval_set:
        actual = await run_agent_with_prompt(case.input, prompt_version)
        results.append({
            "case_id": case.id,
            "expected": case.expected,
            "actual": actual,
            "score": llm_judge(case.expected, actual),  # LLM-as-judge
        })

    return EvalReport(
        version=prompt_version,
        accuracy=sum(r["score"] for r in results) / len(results),
        failures=[r for r in results if r["score"] < 0.7],
    )
```

LLM-as-judge 比纯字符串匹配靠谱，但要注意 judge 模型本身的偏差。重要场景至少要人工抽查 10%。

## 十、上线 Checklist

按优先级排，从必备到锦上添花：

**P0 - 不做就别上线**

- [ ] 错误分类 + 重试 + 降级
- [ ] 链路追踪（每次执行有 trace）
- [ ] 实时成本监控 + 日预算上限
- [ ] Prompt 版本化 + 一键回滚
- [ ] 灰度发布机制（至少 1% / 10% / 100% 三档）
- [ ] 离线评测集（50+ case）
- [ ] Prompt 注入基础防护

**P1 - 上线第一周补齐**

- [ ] 异步 + 流式输出
- [ ] 工具并行调用
- [ ] Prompt Cache
- [ ] 在线评测采样
- [ ] 工具沙盒（如有代码执行）
- [ ] 输出过滤（PII / 敏感词）

**P2 - 持续优化**

- [ ] 多模型路由（按问题复杂度选模型）
- [ ] 用户反馈闭环（点踩标记自动入评测集）
- [ ] AB 测试框架
- [ ] 自动化回归测试

## 落地建议

新团队最常见的错误是想一次做齐所有 P0 + P1，结果上线无限推迟。务实路径：

1. **第一周**：补齐 P0 中的可观测性、错误处理、灰度
2. **第二周**：上线 1% 用户，观察 trace，补齐评测集
3. **第三周**：5% → 25% → 50%，每档卡 24 小时
4. **第四周**：100% 上线，开始迭代 P1

记住一个事实：**模型每半年就会更新一代，但工程链路一旦建好，可以服役多年**。把工程地基打好，换模型只是改个配置。

POC 到生产的距离，不是模型换得够不够新，而是这 9 件事做得够不够扎实。
