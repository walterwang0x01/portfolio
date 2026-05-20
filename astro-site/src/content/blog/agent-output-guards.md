---
title: "Agent 输出验证层：在工具调用与副作用之间，建一道工程级护栏"
date: 2026-05-20
tags: ["AI Agent", "工程化", "Agent 架构"]
excerpt: "结构化输出只解决了「模型说什么」，没解决「该不该执行」。本文给出一套生产级 Output Guard 设计：参数校验、语义校验、副作用沙箱、补偿回滚，附 Python 实现与决策矩阵。"
emoji: "🛡️"
vip: false
draft: false
---

## 一个真实翻车场景

某 SaaS 公司上线了一个客服 Agent，工具集里包含 `refund(order_id, amount)`。一切跑得很好，直到某天 LLM 在处理一个上下文超长的会话时，把 `amount` 输出成了订单总额的 100 倍。Function Calling 协议本身完全没毛病：参数类型对、JSON Schema 校验通过、工具被正确路由。但当 Agent 把这次调用真正打到支付通道时，损失已经发生。

事后复盘的结论很简单：**结构化输出只保证了「LLM 说出来的东西能解析」，没保证「这个东西该不该执行」**。结构合法不等于语义合法，语义合法不等于副作用安全。

这就是 Output Guard 要解决的问题。

## 为什么单靠 JSON Schema 不够

我之前写过 [结构化输出工程](/portfolio/blog/structured-output-engineering)，覆盖了 JSON Mode、Structured Outputs、Outlines、BAML 这一层。但生产 Agent 的事故里，**真正出问题的几乎都不是结构层**：

| 故障类别 | JSON Schema 能拦住？ | 实际发生频率 |
| --- | --- | --- |
| 字段类型错误 | ✅ | 几乎没有了 |
| 必填字段缺失 | ✅ | 几乎没有了 |
| 数值越界（如金额超过订单） | ❌ | 高 |
| 引用不存在的 ID | ❌ | 高 |
| 跨字段不一致（start_date > end_date） | ❌ | 中 |
| 与历史调用矛盾（重复退款） | ❌ | 中 |
| 触发危险副作用（删除生产数据） | ❌ | 低但致命 |

Schema 只能描述形状，不能描述业务约束、不能描述系统状态、不能描述风险等级。所以工具调用之前必须再过一层。

## Output Guard 的四层模型

我在落地中收敛出来的稳定结构是四层，从快到慢、从无副作用到有副作用：

```
LLM tool_call → [1. 静态校验] → [2. 语义校验] → [3. 沙箱预演] → [4. 风险审批] → 真正执行
                       ↓ 失败           ↓ 失败          ↓ 失败           ↓ 拒绝
                    立刻 reject      LLM 改写       LLM 改写         走人审或降级
```

每层职责严格分离：

- **静态校验（Static）**：纯函数，不读数据库。JSON Schema、正则、范围、枚举。毫秒级。
- **语义校验（Semantic）**：读只读上下文。订单是否存在、用户是否有权限、金额是否在订单范围内。10–100ms。
- **沙箱预演（Sandbox）**：在事务中执行 + 立刻回滚，捕获预期副作用。100ms–1s。
- **风险审批（Risk）**：基于影响面打分，超阈值走人审或二次确认。同步阻塞。

不是所有工具都要走完四层。读数据的工具走到第 1 层就够，写数据的工具至少要 1+2，触及钱/权限/不可逆操作的必须四层全过。

## 用 Pydantic + 装饰器实现的最小骨架

下面是我在生产里真在跑的简化版，去掉了具体业务逻辑只保留结构。

```python
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable
from pydantic import BaseModel, ValidationError


class GuardLevel(Enum):
    STATIC = 1
    SEMANTIC = 2
    SANDBOX = 3
    RISK = 4


@dataclass
class GuardResult:
    ok: bool
    reason: str = ""
    fix_hint: str = ""        # 给 LLM 看的修正提示
    risk_score: float = 0.0   # 0-1，超过阈值需要人审


class ToolGuard:
    def __init__(self, schema: type[BaseModel], required_levels: set[GuardLevel]):
        self.schema = schema
        self.required_levels = required_levels
        self._semantic_checks: list[Callable] = []
        self._sandbox_runner: Callable | None = None
        self._risk_scorer: Callable | None = None

    def semantic(self, fn: Callable):
        self._semantic_checks.append(fn)
        return fn

    def sandbox(self, fn: Callable):
        self._sandbox_runner = fn
        return fn

    def risk(self, fn: Callable):
        self._risk_scorer = fn
        return fn

    async def check(self, raw_args: dict, ctx: dict) -> GuardResult:
        # Layer 1: Static
        try:
            args = self.schema(**raw_args)
        except ValidationError as e:
            return GuardResult(False, "schema_invalid",
                               fix_hint=f"参数不合规：{e.errors()[0]['msg']}")

        # Layer 2: Semantic
        if GuardLevel.SEMANTIC in self.required_levels:
            for check in self._semantic_checks:
                r = await check(args, ctx)
                if not r.ok:
                    return r

        # Layer 3: Sandbox
        if GuardLevel.SANDBOX in self.required_levels and self._sandbox_runner:
            r = await self._sandbox_runner(args, ctx)
            if not r.ok:
                return r

        # Layer 4: Risk
        if GuardLevel.RISK in self.required_levels and self._risk_scorer:
            score = await self._risk_scorer(args, ctx)
            if score > ctx.get("risk_threshold", 0.7):
                return GuardResult(False, "needs_human_review", risk_score=score)

        return GuardResult(True)
```

注册一个真实工具：

```python
class RefundArgs(BaseModel):
    order_id: str
    amount: float

refund_guard = ToolGuard(
    schema=RefundArgs,
    required_levels={GuardLevel.STATIC, GuardLevel.SEMANTIC,
                     GuardLevel.SANDBOX, GuardLevel.RISK},
)

@refund_guard.semantic
async def order_must_exist(args: RefundArgs, ctx: dict) -> GuardResult:
    order = await ctx["db"].find_order(args.order_id)
    if not order:
        return GuardResult(False, "order_not_found",
                           fix_hint=f"订单 {args.order_id} 不存在，请先调用 search_order 确认")
    if args.amount > order.paid_amount:
        return GuardResult(False, "amount_exceeds_paid",
                           fix_hint=f"退款金额 {args.amount} 超过实付 {order.paid_amount}")
    return GuardResult(True)

@refund_guard.sandbox
async def dry_run_refund(args: RefundArgs, ctx: dict) -> GuardResult:
    async with ctx["db"].transaction() as tx:
        try:
            await tx.execute_refund(args.order_id, args.amount, dry_run=True)
            await tx.rollback()
            return GuardResult(True)
        except Exception as e:
            return GuardResult(False, "sandbox_failed", fix_hint=str(e))

@refund_guard.risk
async def score_refund(args: RefundArgs, ctx: dict) -> float:
    base = min(args.amount / 1000, 1.0)
    if ctx.get("user_complaint_count", 0) > 3:
        base *= 0.7  # 老投诉用户，降低风险分
    return base
```

## 失败如何反馈给 LLM

最容易被忽略的一点：**Guard 失败不应该是 hard error，而应该是给 LLM 的「修正信号」**。

我见过两种错误的反馈方式：

1. 直接抛异常给上层 → Agent 认为工具坏了，开始道歉打转
2. 把 `False` 塞回去 → LLM 不知道怎么改，无脑重试同样参数

正确做法是把 `fix_hint` 包装成结构化 tool result 喂回去，明确告诉 LLM 「错在哪、怎么改」：

```python
async def call_tool_with_guard(tool_name: str, args: dict, ctx: dict):
    guard = GUARDS[tool_name]
    result = await guard.check(args, ctx)

    if not result.ok:
        # 关键：作为 tool_result 返回，而不是 raise
        return {
            "role": "tool",
            "tool_name": tool_name,
            "is_error": True,
            "content": {
                "guard_rejected": True,
                "reason": result.reason,
                "fix_hint": result.fix_hint,
                "next_action": "请根据 fix_hint 调整参数后重新调用",
            },
        }

    return await EXECUTORS[tool_name](args, ctx)
```

经验值：fix_hint 写得越具体，LLM 一次性改对的概率越高。我的内部统计是 hint 包含「具体字段 + 实际值 + 期望范围」时，二次调用成功率从 ~55% 提升到 ~92%。

## 沙箱预演的工程取舍

第 3 层是最纠结的一层。完整沙箱（容器/虚拟机）成本太高，纯 mock 又不够真。三种主流策略：

| 策略 | 真实度 | 延迟 | 实现成本 | 适合场景 |
| --- | --- | --- | --- | --- |
| 事务回滚 | 高 | 低 | 低 | 数据库写操作 |
| 影子环境 | 中高 | 中 | 中 | API 调用、外部系统 |
| 纯 mock | 低 | 极低 | 低 | 内部纯函数工具 |
| E2B/Modal 沙箱 | 极高 | 高 | 高 | 代码执行、文件操作 |

绝大多数业务工具（CRUD、订单、消息）用事务回滚就够。代码执行类工具走 E2B 这种独立沙箱。**最容易出问题的是「外部第三方 API」——它们没事务，回滚靠补偿，必须额外写补偿逻辑**，这部分在下一节展开。

## 已执行后的补偿与回滚

Guard 不是万能的。即使前置校验全过，工具真执行时仍可能失败（比如下游服务超时）。这时候需要补偿模式（Compensation）：

```python
@dataclass
class Compensation:
    tool_name: str
    args: dict
    why: str

class AgentSession:
    def __init__(self):
        self.executed: list[tuple[str, dict, Any]] = []
        self.compensations: list[Compensation] = []

    async def execute(self, tool_name, args, ctx):
        result = await call_tool_with_guard(tool_name, args, ctx)
        if not result.get("is_error"):
            self.executed.append((tool_name, args, result))
            comp = COMPENSATION_MAP.get(tool_name)
            if comp:
                self.compensations.append(comp(args, result))
        return result

    async def rollback(self, reason: str):
        for comp in reversed(self.compensations):
            try:
                await EXECUTORS[comp.tool_name](comp.args, ctx={"reason": reason})
            except Exception as e:
                # 补偿失败要告警，不能再补偿
                logger.error("compensation_failed", comp=comp, error=e)
```

注册补偿：

```python
COMPENSATION_MAP = {
    "send_message": lambda args, result: Compensation(
        "delete_message", {"message_id": result["message_id"]},
        why="agent rolled back",
    ),
    "create_order": lambda args, result: Compensation(
        "cancel_order", {"order_id": result["order_id"]}, why="agent rolled back",
    ),
}
```

> 一条经验：**补偿不是回滚，是另一个独立的业务动作**。`send_message` 的补偿不是删除消息（用户已经读了），而是发一条更正消息。设计补偿时要从用户视角想，不是从数据库视角。

## 落地 Checklist

写完一个 Agent 的 Output Guard 体系前，逐条对照：

- [ ] 每个工具都明确标注了所需的 Guard 等级（1/2/3/4）
- [ ] 涉及钱、权限、不可逆操作的工具至少包含 Layer 2+3
- [ ] Guard 失败返回 `fix_hint`，不抛异常
- [ ] `fix_hint` 包含字段名、实际值、期望约束三要素
- [ ] 有副作用的工具都注册了对应的 Compensation
- [ ] 补偿失败有独立告警通道（不能依赖再次补偿）
- [ ] Risk 阈值可配置，能按租户/用户分群调
- [ ] Guard 决策全部进 trace，便于事后审计
- [ ] 单元测试覆盖每条 Semantic 规则的正负样本
- [ ] 端到端有「LLM 故意输出非法参数」的对抗测试

## 选型建议

如果你刚开始：先写 Layer 1 + Layer 2，95% 的事故能挡住，工程成本最低。等流量上来、出过一两次有损事件再加 Layer 3+4，不要一上来就上重武器。

如果你的 Agent 涉及金融、医疗、企业 IT 这类强合规场景：四层从一开始就要齐全，并且 Risk 层接入人审工作流。**Output Guard 不是性能负担，是 Agent 上线的入场券**。

Agent 工程的成熟度，最终就体现在 LLM 和真实世界之间的这道护栏上。
