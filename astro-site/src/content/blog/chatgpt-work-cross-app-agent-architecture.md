---
title: "ChatGPT Work 启示录：跨应用长时运行 Agent 的工程架构怎么搭"
date: 2026-07-10
tags: ["AI Agent", "Agent 架构", "工程化"]
excerpt: "OpenAI 把 ChatGPT Work 推给所有用户：连 Slack、Gmail、Drive，能连续跑几小时的跨应用 Agent。这不是产品新闻，而是长时 Agent 从 Demo 走向生产的架构信号——本文拆解状态、权限、工具编排三层设计。"
emoji: "🧩"
vip: false
draft: false
---

OpenAI 在 2026 年 7 月把 **ChatGPT Work** 全量开放：桌面端对所有用户（含 Free）可用，Pro / Enterprise 在网页和移动端优先。它和 Codex 共享同一套 agentic 底座，但面向不写代码的人——连上 Slack、Gmail、Google Drive、日历和 CRM 之后，能跨应用读文件、写文档、做表格、发邮件，**单次任务可以连续跑几个小时**。

如果你在做企业内部的「通用办公 Agent」，ChatGPT Work 不是要对标的 UI，而是要对标的**架构假设**：用户给的是目标而不是步骤，Agent 自己拆任务、选工具、在多个 SaaS 之间搬运上下文，并且能在中断后恢复。下面按工程视角拆三层。

## 三层架构：目标层 / 编排层 / 连接器层

| 层级 | 职责 | ChatGPT Work 的做法 | 自研时常见坑 |
|------|------|---------------------|-------------|
| 目标层 | 接收用户意图，拆成可追踪子目标 | 自然语言目标 + 进度可见 | 只接受单轮 prompt，无法表达「做到哪了」 |
| 编排层 | 选工具、管理状态、错误恢复、审批 | 内置 harness，长时 loop + 检查点 | 无状态 ReAct，一轮失败全盘重来 |
| 连接器层 | OAuth、API、MCP、桌面自动化 | 预置 Slack/Gmail/Drive 等连接器 | 每个集成手写 adapter，权限散落 |

关键洞察：**长时 Agent 的难点不在模型智商，而在编排层**。模型再强，没有持久化任务图和连接器权限治理，也只能做「一问一答」。

## 编排层：任务图 + 检查点

长时任务必须把工作流建模为**有向任务图**，而不是线性对话：

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

class StepStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_HUMAN = "waiting_human"
    DONE = "done"
    FAILED = "failed"

@dataclass
class AgentStep:
    id: str
    tool: str
    input: dict[str, Any]
    status: StepStatus = StepStatus.PENDING
    output: Any | None = None
    retry_count: int = 0

@dataclass
class LongHorizonRun:
    goal: str
    steps: list[AgentStep] = field(default_factory=list)
    checkpoint_id: str | None = None

    def next_runnable(self) -> AgentStep | None:
        for s in self.steps:
            if s.status in (StepStatus.PENDING, StepStatus.FAILED) and s.retry_count < 3:
                return s
        return None

    def to_checkpoint(self) -> dict:
        return {
            "goal": self.goal,
            "checkpoint_id": self.checkpoint_id,
            "steps": [
                {"id": s.id, "tool": s.tool, "status": s.status.value, "output": s.output}
                for s in self.steps
            ],
        }
```

每次工具调用后把 `to_checkpoint()` 写入 Redis / Postgres。进程崩溃或用户隔天回来，从最近检查点恢复，只重跑 `FAILED` 或 `PENDING` 步骤——这和 LangGraph checkpoint、Temporal workflow 是同一类问题。

## 连接器层：权限要「按任务」而不是「按用户永久授权」

ChatGPT Work 预置了主流 SaaS 连接器，企业版背后还有 Microsoft 365 Copilot 同一套 GPT-5.6 底座。自研时建议：

1. **连接器注册表**：每个连接器声明 scopes、速率限制、是否支持写操作
2. **任务级 scope**：用户说「整理本周销售邮件」，只申请 Gmail `readonly` + Sheets `write`，而不是全局 `mail.google.com/*`
3. **人工审批门**：发外部邮件、改 CRM 记录、删文件三类操作强制 `WAITING_HUMAN`

```typescript
type ConnectorScope = "read" | "write" | "admin";

interface ConnectorGrant {
  connectorId: string;
  scopes: ConnectorScope[];
  expiresAt: string; // 任务结束即失效，不做永久 refresh
}

function planGrants(goal: string, connectors: string[]): ConnectorGrant[] {
  // 由 planner 根据目标推导最小权限，安全团队可 override
  return connectors.map((id) => ({
    connectorId: id,
    scopes: goal.includes("发送") || goal.includes("更新")
      ? ["read", "write"]
      : ["read"],
    expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  }));
}
```

这和 MCP EMA 的企业 IdP 统一授权是互补关系：EMA 解决「员工能否接入 Server」，任务级 scope 解决「这次任务能用多大权限」。

## 与 Coding Agent 的边界

ChatGPT Work 和 Codex 共享底座，但产品边界清晰：

- **Codex**：仓库、CI、PR、代码审查——变更可 diff、可回滚
- **ChatGPT Work**：文档、表格、邮件、日历——输出物偏「业务交付物」

自研时不要把两套 harness 硬塞进一个 Agent。代码变更需要 git branch + test gate；办公交付物需要版本历史 + 人工签收。混在一个 loop 里，失败回滚成本差两个数量级。

## 落地 Checklist

- [ ] 任务图持久化：支持中断恢复，不依赖单进程内存
- [ ] 连接器最小权限：按任务申请 scope，任务结束吊销
- [ ] 写操作审批门：外发、删除、付款类步骤必须人工确认
- [ ] 进度可观测：用户能看到「正在读 Drive / 正在写 Slides」，不是黑盒转圈
- [ ] Token / 成本预算：长时 loop 设硬上限，避免.harness 经济学失控
- [ ] 输出物版本化：每次交付保留快照，方便对比和撤销
- [ ] 与 Coding Agent 分 harness：代码与办公交付物走不同安全策略

ChatGPT Work 把「几小时跨应用 Agent」从实验室推向了默认选项。你的系统如果还停在单轮 tool call demo，下一步不是换更大的模型，而是把**任务图、检查点、连接器治理**这三件套补齐。
