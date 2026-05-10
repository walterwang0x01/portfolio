---
title: "长程 Agent 工程化：跑几小时到几天的任务，怎么不翻车"
date: 2026-05-10
tags: ["AI Agent", "Agent 架构", "工程化"]
excerpt: "Demo 里的 Agent 跑 5 分钟挺好看，一旦任务周期拉到几小时甚至几天——服务重启、模型限流、预算失控、工具返回结构变了——整个链路就会连锁崩。本文从状态模型、恢复语义、预算闸门到审批分段，拆解 long-horizon Agent 的生产级工程范式。"
vip: false
draft: false
emoji: "⏳"
---

你用 LangGraph 或者 OpenAI Agents SDK 搭了一个 Agent，Demo 跑 3 分钟无比丝滑。上线之后产品说："这个流程要爬 200 个页面做竞品分析""这个代码迁移任务预计要跑 8 小时""这个 workflow 中间需要等客户签合同，可能隔三天"。这时候你发现，所有假设都崩了：服务重启丢上下文、OpenAI 限流一次整个链路重跑、token 预算超了没人拦、工具升级返回格式变了中间没人发现。

这就是 **Long-horizon Agent（长程 Agent）** 的工程挑战。它不是框架问题，是系统问题——你在做一套**可恢复、可预算、可审计**的分布式工作流，只是每个节点里跑的是 LLM 而已。

## 长程 Agent 为什么难

先定义一下：跑**超过几分钟、跨越多次 LLM 调用、至少一次外部 I/O**的任务，都算长程 Agent。典型场景：

- **研究型**：深度调研 / 竞品分析 / 法律尽调，数十到数百次搜索+总结
- **代码型**：SWE-bench 风格的仓库级重构，几十次文件编辑+编译+测试
- **业务型**：合同生成、审核、签署，需要跨天的人工审批
- **运维型**：事件调查、根因分析，要拉日志、查监控、跑脚本

这些任务的共同特征：**单次失败成本高、上下文窗口装不下、纯靠 prompt 无法推进**。于是四个工程难题绕不开：

| 挑战 | 短程 Agent 能糊过去 | 长程 Agent 必须正面解决 |
| --- | --- | --- |
| 状态 | 内存里的 messages 数组 | 持久化到 DB，跨进程/跨重启可恢复 |
| 恢复 | 失败就重跑 | 幂等 + 断点续传，不能重复花钱 |
| 预算 | 不会超 | Token/工具成本必须有闸门，否则几万美金就烧没了 |
| 审批 | 不需要 | 敏感操作要暂停等人，可能等几天 |

## 状态模型：durable execution 是唯一答案

短程 Agent 的状态模型就是一个 `messages: list[Message]`，跑完就丢。长程 Agent 必须把**图的执行位置**和**工具调用结果**都持久化，这套范式叫 **durable execution**（可持久化执行），Temporal、Inngest、Restate 都在这个坑里卷了十年，LangGraph 的 PostgresSaver、OpenAI 的 Responses API（带 previous_response_id）本质都是同一个思路。

核心契约：**每次工具调用都是一次副作用，必须可定位、可重放**。典型的持久化状态长这样：

```python
from dataclasses import dataclass
from typing import Literal
import hashlib, json

@dataclass
class StepRecord:
    step_id: str              # 稳定幂等键，决定"同一步"
    kind: Literal["llm", "tool", "approval"]
    input_hash: str           # 输入指纹，用于检测重放冲突
    output: dict | None       # 工具/LLM 的产出，None 表示还没跑完
    attempt: int              # 第几次尝试
    cost_usd: float           # 这步花了多少钱
    status: Literal["pending", "running", "done", "failed"]

def step_id_for(node: str, state_version: int, tool_args: dict) -> str:
    """幂等键 = 节点名 + 状态版本 + 工具参数指纹。
    同一个位置、同样的入参，必须命中同一条 StepRecord。"""
    payload = f"{node}:{state_version}:{json.dumps(tool_args, sort_keys=True)}"
    return hashlib.sha256(payload.encode()).hexdigest()[:16]

async def run_step(store, node, state, tool, tool_args):
    sid = step_id_for(node, state.version, tool_args)
    rec = await store.get(sid)
    if rec and rec.status == "done":
        return rec.output                    # 重放：直接返回上次结果
    rec = rec or StepRecord(sid, "tool", hash_of(tool_args), None, 0, 0.0, "pending")
    rec.status, rec.attempt = "running", rec.attempt + 1
    await store.put(rec)
    try:
        out, cost = await tool(**tool_args)
        rec.output, rec.cost_usd, rec.status = out, cost, "done"
    except Exception as e:
        rec.status = "failed"
        raise
    finally:
        await store.put(rec)
    return out
```

这段代码看起来平平无奇，但背后的生产价值是：进程崩了、pod 被回收、用户关了浏览器隔天再来，Agent 都能从上一个完成的 step 继续。**不要在 2026 年还自己用 Redis list + json.dumps 凑一个"状态保存"**，要么上 LangGraph 的 Checkpointer，要么直接用 Temporal / Inngest / Durable Objects 这类真正的 workflow runtime。

## 恢复语义：幂等键 + 工具快照

断点续传最容易翻车的地方不是框架，是**工具本身不幂等**。典型坑：

- `create_github_issue()` 重放一次就多建一个 issue
- 搜索工具同一个 query，一周后返回完全不同的结果，Agent 以为自己在一个全新的世界
- LLM 调用带了 temperature>0，重放得到不一样的推理路径

三条工程原则：

1. **幂等键在调用方生成**：像上面 `step_id_for` 那样把"逻辑意图"哈希成稳定 ID。写操作的工具（建 issue、发邮件、扣款）必须接受 `idempotency_key` 参数，服务端去重。
2. **读操作要快照**：搜索、抓页面、查数据库这些"读世界"的动作，结果要存进 `StepRecord.output`，重放时直接用快照，不要再访问外部世界——否则 Agent 的推理基础就变了。
3. **LLM 调用尽量 temperature=0**：至少在状态机关键节点（路由、审批判定）用确定性设置，便于复现和审计。

## 预算闸门：不要等账单来了才发现

一个跑 6 小时的 Agent，如果没有预算闸门，踩到一个死循环能把你一周的 API 额度烧光。预算是一等公民，不是"日志里看看"。

```python
class BudgetTripwire:
    def __init__(self, usd_max: float, tokens_max: int, wall_clock_s: int):
        self.usd_max, self.tokens_max, self.wall_max = usd_max, tokens_max, wall_clock_s
        self.usd, self.tokens, self.started_at = 0.0, 0, time.time()

    def record(self, *, usd: float = 0, tokens: int = 0):
        self.usd += usd
        self.tokens += tokens
        if self.usd > self.usd_max:
            raise BudgetExceeded(f"cost budget blown: ${self.usd:.2f} > ${self.usd_max}")
        if self.tokens > self.tokens_max:
            raise BudgetExceeded(f"token budget blown: {self.tokens} > {self.tokens_max}")
        if time.time() - self.started_at > self.wall_max:
            raise BudgetExceeded(f"wall clock exceeded: {self.wall_max}s")

    def remaining_ratio(self) -> float:
        return min(
            1 - self.usd / self.usd_max,
            1 - self.tokens / self.tokens_max,
            1 - (time.time() - self.started_at) / self.wall_max,
        )
```

闸门有三个刻度（美元、token、墙钟），触发就抛异常。配合 `remaining_ratio()` 还能做**动态降级**——剩余预算低于 20% 时，自动把子 Agent 从 Claude Opus 切成 Haiku、把搜索上限从 50 调到 10、把并发从 8 降到 2。这比硬中断用户体验好得多。

## 审批和分段运行：从进程思维到工单思维

当流程要等"人"的时候——合同审批、客户确认、外部数据到达——Agent 就不再是一个"跑完的进程"，而是一个**状态机 + 工单系统**。关键设计：

- **触发审批 = 持久化 + 发通知**，不是 `time.sleep()`，进程应该直接结束
- **恢复由外部事件驱动**：审批者点了"通过"，webhook 进来，workflow runtime 唤醒对应的 thread_id
- **超时有兜底**：48 小时没人审批，自动降级到默认路径或升级给值班人

实现上，LangGraph 的 `interrupt()` 把前两条做成了原语，Temporal 的 `workflow.await_signal()` 也是同一个模式。自己造的话，至少得有一张 `pending_approvals` 表 + 一个能被外部事件唤醒的队列，别想着在进程里阻塞。

## 编排层选型矩阵

长程 Agent 的编排层选型决定了 80% 的工程体感。常见四类方案对比：

| 方案 | 状态持久化 | 恢复语义 | 审批原语 | 适合场景 |
| --- | --- | --- | --- | --- |
| 自建 Redis + cron | 手写 | 全重跑 | 自己拼 | 不建议，除非团队有 workflow 经验 |
| LangGraph + Postgres | 内置 Checkpointer | 节点级断点续传 | `interrupt()` | 以 LLM 为中心、图结构清晰的 Agent |
| Temporal / Inngest | 内置 event sourcing | activity 级幂等重放 | signal / wait | 混合工作流（Agent + 大量传统服务编排） |
| OpenAI Responses API + 前端 | 服务端托管 | `previous_response_id` 续跑 | 应用层自己实现 | 轻量对话型长程任务、无复杂分支 |

**一句话选型**：纯 Agent 图 → LangGraph；Agent 混大量传统服务 → Temporal；前端驱动的轻量续聊 → Responses API；别自建。

## 反模式：生产里踩过的坑

- **把所有历史塞进 context**：长程任务消息会爆。用 scratchpad + 分层摘要，只在当前决策需要的上下文喂给模型。
- **子 Agent 递归无预算**：主 Agent 调子 Agent，子 Agent 再调子子 Agent，没预算继承就炸。预算要沿链路传递并收缩。
- **工具 schema 变更不做版本**：一个工具升级了参数，重放 3 天前的 StepRecord 就挂了。工具要带 `version`，恢复时 schema 不匹配要触发人工介入。
- **没有"停止"按钮**：用户中途反悔无法终止。状态机必须有 `cancel_requested` 位，每个节点开头检查一次。

## 落地 checklist

在 Agent 上生产之前，对照这张清单过一遍：

- [ ] 状态持久化到外部存储（DB / workflow runtime），不依赖进程内存
- [ ] 每个工具调用都有稳定幂等键，写操作带 `idempotency_key`
- [ ] 读操作结果做快照，重放不再请求外部世界
- [ ] 预算闸门：美元、token、墙钟三把锁，任何一把触发都能优雅降级
- [ ] 审批节点用持久化 + 事件唤醒，不要阻塞进程
- [ ] 有 `cancel_requested` 和超时兜底，用户和系统都能叫停
- [ ] 工具带版本号，schema 变更能被检测到
- [ ] 全链路有 trace，能回答"这个任务昨晚 3 点在哪一步花了 17 美金"

长程 Agent 的工程水位，不取决于你用了多时髦的模型，而取决于你把**可恢复性**和**预算可控性**做到了第几层。2026 年谁家 Agent 能稳定跑 8 小时完成真实业务，谁就赢了。
