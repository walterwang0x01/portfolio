---
title: "Human-in-the-Loop Agent 工程：让 AI 自主但不失控"
date: 2026-06-02
tags: ["AI Agent", "工程化", "Agent 架构"]
excerpt: "Agent 越自主越危险。本文拆解生产级 HITL 编排的 5 种模式——从简单确认到多人审批链，附 LangGraph 和 CrewAI 的完整实现。"
emoji: "🧑‍✈️"
vip: false
draft: false
---

## 为什么 Agent 需要人类兜底

2026 年的 Agent 已经能自主完成复杂任务链：查数据库、调 API、写代码、发邮件。但"能做"不等于"该做"——一个没有人类审批节点的 Agent，本质上是一颗定时炸弹。

真实案例：某电商公司的客服 Agent 在凌晨 3 点自动批准了一笔 $50,000 的退款，因为它"理解"了客户的投诉逻辑。技术上没 bug，业务上是灾难。

Human-in-the-Loop（HITL）不是给 Agent 加限制，而是给它加**判断力的外部校准**。核心问题是：在哪里插入人类、怎么插入、插入后如何恢复执行。

## 5 种 HITL 编排模式

| 模式 | 适用场景 | 延迟容忍 | 实现复杂度 |
|------|----------|----------|-----------|
| 同步确认 | 单步高风险操作 | 秒级 | ⭐ |
| 异步审批 | 多步工作流中的关键节点 | 分钟~小时 | ⭐⭐ |
| 升级链 | 分级授权（金额/权限） | 分钟级 | ⭐⭐⭐ |
| 批量审核 | 大量同类决策 | 小时级 | ⭐⭐ |
| 影子模式 | 上线前验证 Agent 决策质量 | 无阻塞 | ⭐⭐⭐ |

### 模式 1：同步确认

最简单的模式——Agent 执行到关键步骤时暂停，等人类点"确认"或"拒绝"。

```python
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Literal

class AgentState(TypedDict):
    task: str
    plan: str
    human_approval: str | None
    result: str | None

def plan_node(state: AgentState) -> dict:
    # Agent 生成执行计划
    plan = llm.invoke(f"为以下任务生成执行计划: {state['task']}")
    return {"plan": plan.content}

def execute_node(state: AgentState) -> dict:
    # 只有审批通过才执行
    result = llm.invoke(f"执行计划: {state['plan']}")
    return {"result": result.content}

def should_execute(state: AgentState) -> Literal["execute", "end"]:
    if state.get("human_approval") == "approved":
        return "execute"
    return "end"

# 构建图：plan → (中断等待人类) → execute
graph = StateGraph(AgentState)
graph.add_node("plan", plan_node)
graph.add_node("execute", execute_node)
graph.add_edge("plan", "execute")
graph.add_conditional_edges("execute", should_execute)

# 关键：在 plan 之后设置中断点
app = graph.compile(
    checkpointer=MemorySaver(),
    interrupt_after=["plan"]  # plan 完成后暂停
)
```

调用方恢复执行时注入人类决策：

```python
# 第一次调用：执行到 plan 后暂停
config = {"configurable": {"thread_id": "task-001"}}
result = app.invoke({"task": "删除过期用户数据"}, config)
# result["plan"] = "1. 查询 90 天未登录用户 2. 备份数据 3. 执行删除"

# 人类审批后恢复
app.update_state(config, {"human_approval": "approved"})
final = app.invoke(None, config)  # 从中断点继续
```

### 模式 2：异步审批（生产级）

同步确认要求人类实时在线，生产环境更常见的是异步模式：Agent 提交审批请求，人类在任意时间处理。

```python
import asyncio
from datetime import datetime, timedelta

class ApprovalRequest:
    def __init__(self, agent_id: str, action: str, context: dict,
                 timeout: timedelta = timedelta(hours=4)):
        self.id = f"apr_{agent_id}_{datetime.now().timestamp()}"
        self.action = action
        self.context = context
        self.deadline = datetime.now() + timeout
        self.status = "pending"  # pending | approved | rejected | expired

class ApprovalService:
    """审批服务：对接 Slack/飞书/邮件通知"""

    def __init__(self, store, notifier):
        self.store = store  # Redis/DB 持久化
        self.notifier = notifier  # 通知渠道

    async def request_approval(self, req: ApprovalRequest) -> str:
        await self.store.save(req)
        await self.notifier.send(
            channel="agent-approvals",
            message=f"🤖 Agent 请求审批\n"
                    f"操作: {req.action}\n"
                    f"上下文: {req.context}\n"
                    f"截止: {req.deadline.isoformat()}\n"
                    f"回复 /approve {req.id} 或 /reject {req.id}"
        )
        return req.id

    async def wait_for_decision(self, req_id: str,
                                 poll_interval: float = 5.0) -> str:
        """轮询等待人类决策，超时自动拒绝"""
        while True:
            req = await self.store.get(req_id)
            if req.status != "pending":
                return req.status
            if datetime.now() > req.deadline:
                await self.store.update(req_id, status="expired")
                return "expired"
            await asyncio.sleep(poll_interval)
```

### 模式 3：升级链

不同风险等级对应不同审批人。这是金融、医疗场景的标配：

```python
from dataclasses import dataclass

@dataclass
class EscalationRule:
    condition: str      # 触发条件表达式
    approver_role: str  # 审批角色
    timeout_minutes: int
    fallback: str       # 超时后行为: "reject" | "escalate_up"

ESCALATION_CHAIN = [
    EscalationRule(
        condition="amount < 1000",
        approver_role="team_lead",
        timeout_minutes=30,
        fallback="reject"
    ),
    EscalationRule(
        condition="1000 <= amount < 10000",
        approver_role="manager",
        timeout_minutes=60,
        fallback="escalate_up"
    ),
    EscalationRule(
        condition="amount >= 10000",
        approver_role="director",
        timeout_minutes=120,
        fallback="reject"
    ),
]

async def route_approval(action: dict, chain: list[EscalationRule]) -> str:
    """按规则链路由到正确的审批人"""
    for rule in chain:
        if eval_condition(rule.condition, action):
            result = await request_and_wait(
                action=action,
                role=rule.approver_role,
                timeout=rule.timeout_minutes
            )
            if result == "expired" and rule.fallback == "escalate_up":
                continue  # 超时升级到下一级
            return result
    return "rejected"  # 没有匹配规则，默认拒绝
```

## 状态持久化：中断后如何恢复

HITL 最大的工程挑战不是"暂停"，而是"恢复"。Agent 可能在中断期间经历：
- 服务重启
- 上下文窗口过期
- 外部状态变化（数据库数据已更新）

关键设计原则：**中断时序列化完整状态，恢复时重建而非回忆**。

```typescript
// TypeScript 示例：基于 checkpoint 的状态恢复
interface AgentCheckpoint {
  threadId: string;
  nodeId: string;           // 中断在哪个节点
  state: Record<string, unknown>;  // 完整状态快照
  pendingActions: Action[]; // 待执行的动作队列
  createdAt: Date;
  expiresAt: Date;          // 状态有效期
}

class CheckpointStore {
  constructor(private redis: Redis) {}

  async save(checkpoint: AgentCheckpoint): Promise<void> {
    const ttl = Math.floor(
      (checkpoint.expiresAt.getTime() - Date.now()) / 1000
    );
    await this.redis.setex(
      `checkpoint:${checkpoint.threadId}`,
      ttl,
      JSON.stringify(checkpoint)
    );
  }

  async restore(threadId: string): Promise<AgentCheckpoint | null> {
    const data = await this.redis.get(`checkpoint:${threadId}`);
    if (!data) return null;

    const checkpoint = JSON.parse(data) as AgentCheckpoint;

    // 关键：检查状态是否仍然有效
    if (new Date() > checkpoint.expiresAt) {
      await this.redis.del(`checkpoint:${threadId}`);
      return null; // 过期状态不可恢复，需要重新执行
    }
    return checkpoint;
  }
}
```

## 影子模式：上线前的安全网

在 Agent 正式接管决策前，用影子模式并行运行：Agent 做决策但不执行，人类做真实决策，事后对比差异。

```python
class ShadowModeRunner:
    """影子模式：Agent 决策 vs 人类决策的对比评估"""

    def __init__(self, agent, metrics_store):
        self.agent = agent
        self.metrics = metrics_store

    async def run(self, task: dict) -> dict:
        # Agent 生成决策（不执行）
        agent_decision = await self.agent.decide(task)

        # 记录 Agent 决策，等待人类真实决策
        record = {
            "task_id": task["id"],
            "agent_decision": agent_decision,
            "human_decision": None,  # 人类稍后填入
            "agreement": None,
            "timestamp": datetime.now()
        }
        await self.metrics.save(record)

        return agent_decision

    async def evaluate(self, days: int = 7) -> dict:
        """评估 Agent 与人类决策的一致率"""
        records = await self.metrics.query(last_days=days)
        total = len(records)
        agreed = sum(1 for r in records if r["agreement"] is True)

        return {
            "total_decisions": total,
            "agreement_rate": agreed / total if total > 0 else 0,
            "disagreements": [
                r for r in records if r["agreement"] is False
            ]
        }
```

当一致率稳定在 95% 以上，且剩余 5% 的分歧都是"Agent 更保守"而非"Agent 更激进"时，可以逐步放开自主权。

## 决策矩阵：何时用哪种模式

| 场景特征 | 推荐模式 | 理由 |
|----------|----------|------|
| 不可逆操作（删除、转账） | 同步确认 | 执行前必须有人确认 |
| 多步工作流中的关键节点 | 异步审批 | 不阻塞前序步骤 |
| 涉及金额/权限分级 | 升级链 | 风险与审批级别匹配 |
| 批量处理（100+ 同类决策） | 批量审核 | 人类抽检而非逐条审 |
| 新 Agent 上线验证 | 影子模式 | 零风险积累信任 |
| 已验证 Agent + 低风险操作 | 无 HITL | 信任已建立，全自主 |

## 落地 Checklist

1. **定义风险分级** — 列出 Agent 所有可能的动作，按影响范围和可逆性分为 P0-P3
2. **P0 动作强制 HITL** — 不可逆 + 高影响的操作必须有人类审批
3. **选择持久化方案** — LangGraph MemorySaver（开发）→ PostgreSQL/Redis（生产）
4. **设计超时策略** — 审批超时 = 自动拒绝（安全默认），而非自动通过
5. **接入通知渠道** — Slack/飞书 Bot 推送审批请求，支持一键操作
6. **实现影子模式** — 新 Agent 先跑 1-2 周影子，积累决策对比数据
7. **监控审批延迟** — 如果平均审批时间 > 30 分钟，说明流程设计有问题
8. **渐进放权** — 影子模式一致率 > 95% 的动作类型，逐步移除 HITL

HITL 不是 Agent 能力不足的补丁，而是生产系统的标准安全层。就像代码需要 code review、部署需要审批一样，Agent 的关键决策需要人类校准。目标不是永远依赖人类，而是通过影子模式和数据积累，让信任可量化、放权有依据。
