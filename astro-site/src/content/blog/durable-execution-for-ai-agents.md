---
title: "Agent 别再用 Cron 跑：Durable Execution 四家引擎选型与实战"
date: 2026-05-28
tags: ["AI Agent", "工程化", "基础设施"]
excerpt: "Long-horizon Agent 上线第一周，进程重启那一刻你就知道为什么要 Durable Execution 了：执行到一半的工作流没了、扣过的钱再扣一次、人工审批永远等不来。本文对比 Temporal、Inngest、DBOS、Restate 四家耐久执行引擎在 Agent 场景的差异，给出一套迁移策略和落地 checklist，附 Python 端到端代码。"
vip: false
draft: false
emoji: "⚙️"
---

去年帮一个朋友看他的简历筛选 Agent。流程不算复杂：拉简历、调三次 LLM 评分、给猎头发 Slack 等审批、通过后写回 ATS。线下跑一切正常，上线第三天部署滚动更新，正在跑的 80 多个工作流全没了——状态丢一半，Slack 已经发出去的审批没人接，候选人那边一脸懵。

这是典型的 "把 Agent 当 HTTP 服务" 的代价。Agent 的执行特征和传统请求-响应完全不同：

- **持续时间长**：从分钟到天，跨多次部署
- **外部副作用多**：发邮件、扣款、调用昂贵 LLM
- **存在等待环节**：人工审批、外部 webhook、定时唤醒
- **失败要精确恢复**：不能让一个已经发出去的邮件再发一次

这就是 Durable Execution 解决的问题，也是 2026 年 AI Agent 上生产最容易被低估的基础设施层。

## Durable Execution 在解什么

把一个 Agent 工作流想象成"一段会暂停几小时、跨进程重启、还能从中间继续跑"的代码。Durable Execution 引擎做四件事：

1. **状态持久化**：每一步执行结果落库，进程死了重启能接着跑
2. **幂等回放**：同一步重复执行只产生一次副作用
3. **等待原语**：`sleep(7天)`、`waitForEvent("approval")` 这种调用是合法的
4. **可观测**：每个工作流的所有历史步骤都能查到、能重放调试

它和 LangGraph 的 `checkpointer` 不是一个层级。LangGraph 处理的是"agent 内部状态图"，Durable Execution 处理的是"整段业务工作流的执行容器"。两者可以叠加：LangGraph 跑在 Temporal Activity 里。

引擎的核心模型有两类：

- **Replay 模型**（Temporal、Restate）：每次进程恢复，工作流代码从头重跑，但每个 step 从历史日志读结果，不再实际执行。优点是开发者写代码像写普通函数；代价是工作流代码必须是确定性的。
- **Event-Driven 模型**（Inngest、DBOS）：每个 step 是独立事件，引擎按 step 调度。心智更接近事件循环，但失去了"线性代码"的可读性。

## 四家引擎核心对比

我把四家文档撸一遍，把对 AI Agent 场景关键的维度做成对比表。

| 维度 | Temporal | Inngest | DBOS | Restate |
|------|----------|---------|------|---------|
| 部署模型 | 自托管 / Cloud | SaaS 为主，自托管可选 | Postgres 内嵌 / Cloud | 自托管 / Cloud |
| 编程模型 | Replay（强确定性） | Event step | Postgres 事务 step | Replay（弱确定性） |
| Python SDK 成熟度 | ★★★★★ | ★★★★（2025 GA） | ★★★★ | ★★★（2025 GA） |
| TypeScript SDK | ★★★★ | ★★★★★ | ★★★ | ★★★★ |
| AI 工作流原语 | 通用 | step.ai.infer 内建 | 通用 | 通用 |
| 人工审批等待 | Signal | waitForEvent | recv() | Awakeable |
| 调试 / 重放 UI | 强（事件历史完整） | 强（每个 run 可重放） | 强（SQL 直查） | 中等 |
| 入门门槛 | 高 | 低 | 低 | 中 |
| 自托管成本 | 高（ES + Cassandra） | 低 | 极低（一张 PG） | 中 |

几个对 Agent 团队真正重要的差异：

**Temporal** 是工业级方案，Uber/Snap 在用。强项是任意复杂度的工作流都撑得住，调试体验最好。代价是基础设施重，自己跑要 Postgres + Elasticsearch + Cassandra（或 Cloud 一年至少几万美金），团队学习曲线陡。

**Inngest** 是 AI 时代起来的新势力，开发者体验最好。`step.ai.infer()` 直接做 LLM 调用的重试和缓存，AgentKit 把 multi-agent 编排原语包好。Python SDK 在 2025 年 GA，对小团队和 SaaS 产品最友好。代价是核心调度走他们的 SaaS，自托管选项功能受限。

**DBOS** 玩了个聪明的路线：状态全存在你已有的 Postgres 里，没有额外组件。一个轻量库 + 一张表就能跑，运维成本接近零。适合"不想再加一个新基础设施"的团队，缺点是大规模并发吞吐不如 Temporal。

**Restate** 把 Replay 模型做得轻量，Rust 实现的单二进制服务。性能强，但生态比 Temporal 年轻得多，Python SDK 还在补特性。

## 实战：把简历筛选 Agent 改造成 Durable Workflow

下面用 Inngest Python SDK 写一个简化版本。任务是：拉简历 → LLM 多步评分 → Slack 审批 → 写回 ATS。

```python
import inngest
from anthropic import AsyncAnthropic

client = inngest.Inngest(app_id="recruit-agent")
llm = AsyncAnthropic()

@client.create_function(
    fn_id="screen-candidate",
    trigger=inngest.TriggerEvent(event="candidate/submitted"),
)
async def screen_candidate(ctx: inngest.Context, step: inngest.Step):
    candidate_id = ctx.event.data["candidate_id"]

    # Step 1: 拉简历，幂等
    resume = await step.run(
        "fetch-resume",
        lambda: ats_client.get_resume(candidate_id),
    )

    # Step 2: LLM 评分，失败自动重试，结果落库
    score = await step.run(
        "llm-score",
        lambda: score_resume(resume),
    )

    if score < 60:
        await step.run("reject", lambda: ats_client.reject(candidate_id))
        return {"status": "rejected", "score": score}

    # Step 3: 发 Slack 审批，等待外部事件，最长等 7 天
    await step.run(
        "request-approval",
        lambda: slack.send_approval(candidate_id, score),
    )

    approval = await step.wait_for_event(
        "wait-approval",
        event="candidate/approved",
        timeout="7d",
        if_=f"async.data.candidate_id == '{candidate_id}'",
    )

    if approval is None:  # 超时
        await step.run("expire", lambda: ats_client.expire(candidate_id))
        return {"status": "timeout"}

    # Step 4: 写回 ATS，幂等
    await step.run(
        "write-ats",
        lambda: ats_client.advance_stage(candidate_id, "interview"),
    )
    return {"status": "advanced"}
```

关键点：

- 每个 `step.run()` 的结果都会持久化。进程崩溃重启后，已执行的 step 不会重跑，直接读历史结果继续。
- `step.wait_for_event()` 返回前，Python 进程不需要保持活着——引擎会在事件到达时把工作流从某个空闲 worker 上恢复。
- 任何 step 抛异常会按指数退避自动重试，重试期间不会触发后面的 step。
- 想换 Temporal？把 `step.run` 换成 `workflow.execute_activity`，骨架是一样的，差别在 wait/signal 的写法。

## LLM 调用怎么处理

Agent 工作流里 LLM 调用占了大半。三个推荐做法：

**单独 step 包裹**。哪怕一个简单的 LLM 调用也包成 step，让引擎记录入参出参。出问题能直接看到当时的 prompt 和 completion。

**结合 Prompt Cache**。Anthropic / OpenAI 的 prompt cache TTL 大约几分钟，但 step 重试可能跨小时。先把命中过的 cache_creation_token 记下来，重试时优先复用相同 system prompt 的 cache breakpoint。

**温度敏感的步骤要落 seed**。Replay 模型下，如果一个 step 的输入相同但 LLM 输出不同，会破坏确定性。Inngest 这类 event 模型不受影响；Temporal 必须把 LLM 调用放在 Activity 里（Activity 不要求确定性）。

## 选型建议

按团队画像给三套推荐：

- **小团队 / SaaS 产品 / 节奏快**：Inngest。AgentKit + step.ai 让你 1 天就能把整个 Agent 工作流跑起来。
- **已有 Postgres / 不想加新基础设施**：DBOS。引入一个库，一张表，状态就持久了。
- **大规模生产 / 多语言 / 复杂工作流**：Temporal。学习成本是值得的。

## 落地 checklist

- 把所有有副作用的步骤（发钱、发邮件、写 DB）显式包成 step
- 给每个 step 加 idempotency key，外部调用用候选人 ID + step 名做 dedup
- 等待人工审批的工作流要有超时分支，不要假设审批一定会来
- LLM 调用单独成 step，记录 prompt + completion
- 工作流版本化（Temporal 用 patched，Inngest 用 fn_id 后缀），上线后旧版本工作流要继续跑完
- 给关键工作流加监控：执行时长 P95、step 失败率、wait 超时率
- 部署滚动更新前，先在 staging 跑一次"故意 kill worker"演练

把这套基础设施搭上之后，前面那个简历 Agent 不会再因为重启丢工作流。从"Cron + DB 标志位"升级到 Durable Execution，是 long-horizon Agent 从 demo 走向生产的分水岭。
