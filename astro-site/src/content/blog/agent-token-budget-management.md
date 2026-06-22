---
title: "Agent Token 预算管理实战：从无限制调用到精确控制"
date: 2026-06-21
tags: ["AI Agent", "工程化", "LLM"]
excerpt: "Agent 跑飞了一次可能烧掉整月预算。本文给出一套运行时 Token 预算管理方案——预算分配、实时追踪、动态降级、熔断机制，附完整 Python 实现。"
emoji: "💰"
vip: false
draft: false
---

## 问题：Agent 的成本不可预测

传统 API 调用的成本是线性的——每个请求消耗固定 token，乘以调用次数就是总账单。但 Agent 不一样：一次执行可能触发 3 次 LLM 调用，也可能触发 30 次。当 Agent 陷入循环推理、重复调用工具、或进入错误恢复的死循环时，单次执行的成本可能是预期的 10-50 倍。

真实案例：一个代码生成 Agent 在处理复杂需求时进入了"生成 → 执行 → 报错 → 修复 → 再执行"的循环，单次任务消耗了 180K tokens（约 $2.7），而正常执行只需要 15K tokens（约 $0.2）。

**Token 预算管理**解决的就是这个问题：给每次 Agent 执行设一个"钱包"，花完就停。

## 核心架构：Budget Controller

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time


class BudgetAction(Enum):
    CONTINUE = "continue"       # 正常继续
    DOWNGRADE = "downgrade"     # 降级到更便宜的模型
    SUMMARIZE = "summarize"     # 压缩上下文后继续
    STOP = "stop"               # 立即停止，返回当前结果


@dataclass
class TokenBudget:
    """单次 Agent 执行的 Token 预算"""
    max_input_tokens: int       # 输入 token 上限
    max_output_tokens: int      # 输出 token 上限
    max_total_tokens: int       # 总 token 上限
    max_steps: int = 20         # 最大推理步数
    max_duration_sec: float = 120.0  # 最大执行时长

    # 运行时状态
    used_input: int = field(default=0, init=False)
    used_output: int = field(default=0, init=False)
    steps_taken: int = field(default=0, init=False)
    start_time: float = field(default_factory=time.time, init=False)

    @property
    def used_total(self) -> int:
        return self.used_input + self.used_output

    @property
    def remaining_total(self) -> int:
        return max(0, self.max_total_tokens - self.used_total)

    @property
    def utilization(self) -> float:
        """预算使用率 0.0 ~ 1.0"""
        return self.used_total / self.max_total_tokens

    def record_usage(self, input_tokens: int, output_tokens: int):
        self.used_input += input_tokens
        self.used_output += output_tokens
        self.steps_taken += 1

    def elapsed_sec(self) -> float:
        return time.time() - self.start_time
```

## 预算分配策略

不同类型的 Agent 任务需要不同的预算规格。关键是根据历史数据设定合理的 P95 上限：

| 任务类型 | 典型 token | 预算上限 | 降级阈值 |
|---------|-----------|---------|---------|
| 简单问答 | 2K-5K | 15K | 70% |
| 工具调用（单步） | 5K-10K | 30K | 60% |
| 多步推理 | 15K-40K | 80K | 50% |
| 代码生成+执行 | 20K-60K | 120K | 50% |
| 长任务（研究、报告） | 50K-150K | 250K | 40% |

```python
# 预算预设工厂
BUDGET_PRESETS = {
    "simple_qa": TokenBudget(
        max_input_tokens=10_000,
        max_output_tokens=5_000,
        max_total_tokens=15_000,
        max_steps=3,
        max_duration_sec=30,
    ),
    "tool_use": TokenBudget(
        max_input_tokens=20_000,
        max_output_tokens=10_000,
        max_total_tokens=30_000,
        max_steps=8,
        max_duration_sec=60,
    ),
    "complex_reasoning": TokenBudget(
        max_input_tokens=50_000,
        max_output_tokens=30_000,
        max_total_tokens=80_000,
        max_steps=15,
        max_duration_sec=90,
    ),
    "code_generation": TokenBudget(
        max_input_tokens=80_000,
        max_output_tokens=40_000,
        max_total_tokens=120_000,
        max_steps=20,
        max_duration_sec=120,
    ),
}
```

## 实时追踪与降级决策

预算控制器在每次 LLM 调用后执行决策：

```python
class BudgetController:
    """运行时预算控制器"""

    def __init__(self, budget: TokenBudget):
        self.budget = budget
        self.downgrade_triggered = False

    def check(self) -> BudgetAction:
        b = self.budget

        # 硬限制：超时或超步数 → 立即停止
        if b.elapsed_sec() > b.max_duration_sec:
            return BudgetAction.STOP
        if b.steps_taken >= b.max_steps:
            return BudgetAction.STOP

        # 硬限制：总 token 耗尽
        if b.remaining_total <= 0:
            return BudgetAction.STOP

        # 软限制：接近上限时降级
        utilization = b.utilization
        if utilization > 0.85:
            return BudgetAction.SUMMARIZE  # 压缩上下文，腾出空间
        if utilization > 0.6 and not self.downgrade_triggered:
            self.downgrade_triggered = True
            return BudgetAction.DOWNGRADE  # 切换到更便宜的模型

        return BudgetAction.CONTINUE

    def get_remaining_output_budget(self) -> int:
        """告诉模型还能生成多少 token"""
        remaining = self.budget.max_output_tokens - self.budget.used_output
        total_remaining = self.budget.remaining_total
        return min(remaining, total_remaining)
```

## 模型降级链

当预算使用率超过阈值时，自动切换到更便宜的模型：

```python
MODEL_CHAIN = [
    {"model": "claude-sonnet-4-20250514", "cost_per_1k_input": 0.003, "cost_per_1k_output": 0.015},
    {"model": "claude-haiku-3-20250101", "cost_per_1k_input": 0.0008, "cost_per_1k_output": 0.004},
    {"model": "gpt-4o-mini", "cost_per_1k_input": 0.00015, "cost_per_1k_output": 0.0006},
]


class ModelSelector:
    def __init__(self):
        self.current_index = 0

    def current_model(self) -> str:
        return MODEL_CHAIN[self.current_index]["model"]

    def downgrade(self) -> Optional[str]:
        if self.current_index < len(MODEL_CHAIN) - 1:
            self.current_index += 1
            return self.current_model()
        return None  # 已是最便宜的模型
```

## Agent 执行循环集成

把预算控制器嵌入 Agent 的主循环：

```python
async def run_agent_with_budget(
    task: str,
    budget_preset: str = "tool_use",
) -> dict:
    budget = BUDGET_PRESETS[budget_preset]
    controller = BudgetController(budget)
    model_selector = ModelSelector()
    messages = [{"role": "user", "content": task}]
    final_result = None

    while True:
        # 预算检查
        action = controller.check()

        if action == BudgetAction.STOP:
            break
        elif action == BudgetAction.DOWNGRADE:
            new_model = model_selector.downgrade()
            if new_model:
                print(f"[Budget] 降级到 {new_model}")
        elif action == BudgetAction.SUMMARIZE:
            messages = await compress_context(messages)

        # 限制本次调用的 max_tokens
        max_tokens = min(4096, controller.get_remaining_output_budget())

        # LLM 调用
        response = await call_llm(
            model=model_selector.current_model(),
            messages=messages,
            max_tokens=max_tokens,
        )

        # 记录消耗
        budget.record_usage(
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )

        # 处理响应（工具调用 or 最终回答）
        if response.stop_reason == "end_turn":
            final_result = response.content
            break
        else:
            messages = update_messages(messages, response)

    return {
        "result": final_result,
        "budget_used": budget.used_total,
        "budget_max": budget.max_total_tokens,
        "utilization": f"{budget.utilization:.1%}",
        "steps": budget.steps_taken,
        "model_downgrades": model_selector.current_index,
    }
```

## 上下文压缩：腾出预算空间

当预算紧张但任务还没完成时，压缩历史消息是比直接停止更好的选择：

```python
async def compress_context(messages: list[dict]) -> list[dict]:
    """用小模型压缩对话历史，保留关键信息"""
    if len(messages) <= 3:
        return messages  # 太短不压缩

    # 保留首尾，压缩中间
    first = messages[0]   # 原始任务
    last = messages[-1]   # 最新一轮
    middle = messages[1:-1]

    summary = await call_llm(
        model="gpt-4o-mini",  # 用最便宜的模型做压缩
        messages=[{
            "role": "user",
            "content": f"压缩以下对话为关键要点摘要（保留工具调用结果和决策）:\n{middle}"
        }],
        max_tokens=500,
    )

    return [
        first,
        {"role": "assistant", "content": f"[历史摘要] {summary.content}"},
        last,
    ]
```

## 监控与告警

预算管理不只是控制单次执行，还需要聚合视角：

```python
# 简易成本追踪（生产中接入 Prometheus / Langfuse）
from collections import defaultdict

class CostTracker:
    def __init__(self):
        self.daily_cost = defaultdict(float)
        self.daily_limit = 50.0  # 每日硬上限 $50

    def record(self, tokens: int, model: str, date: str):
        cost_rate = next(
            m["cost_per_1k_input"] for m in MODEL_CHAIN if m["model"] == model
        )
        cost = (tokens / 1000) * cost_rate
        self.daily_cost[date] += cost

        if self.daily_cost[date] > self.daily_limit * 0.8:
            self.alert(f"日成本已达 ${self.daily_cost[date]:.2f}，接近上限")

    def alert(self, msg: str):
        # 发到 Slack / 飞书 / PagerDuty
        print(f"[ALERT] {msg}")
```

## 决策矩阵：选择你的预算策略

| 场景 | 建议策略 | 理由 |
|------|---------|------|
| ToC 聊天产品 | 硬上限 + 快速熔断 | 用户不愿等，成本敏感 |
| 内部工具 Agent | 宽松预算 + 降级链 | 质量优先，可以慢一点 |
| 批处理 Agent | 总预算池 + 任务间均分 | 单任务可以多用，但总量要控 |
| 实时 Agent（客服） | 严格步数限制 | 响应时间是硬约束 |
| 研究型 Agent | 高上限 + 告警不熔断 | 允许深度探索，但要可见 |

## 落地 Checklist

1. **基线数据**：先跑 1-2 周不限预算，收集每种任务的 P50/P95 token 消耗
2. **设预算**：P95 × 1.5 作为初始预算上限
3. **降级链**：至少准备 2 级降级模型（主力 → 中端 → 廉价）
4. **压缩策略**：实现上下文压缩，作为"预算快用完"的应急手段
5. **监控面板**：每日/每小时成本曲线、预算命中率（多少次执行触发了降级/停止）
6. **迭代调优**：每周看一次"被预算截断"的请求，判断是预算太紧还是 Agent 逻辑有 bug

Token 预算管理不是一次性工程，而是持续运营。关键指标是**预算命中率**——如果超过 20% 的请求触发了降级或停止，说明要么预算太紧，要么 Agent 的 prompt/逻辑需要优化。
