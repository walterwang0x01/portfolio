---
title: "Agent 多租户工程：隔离、配额与公平调度的生产实战"
date: 2026-07-14
tags: ["AI Agent", "工程化", "基础设施"]
excerpt: "单个 Agent Demo 很简单；一旦服务几十个租户，Token 账单、工具副作用和记忆泄漏会一起爆炸。本文拆解租户隔离、配额熔断与公平调度的工程落地。"
vip: false
draft: false
emoji: "🏢"
---

单租户 Agent 用一根 API Key 跑通 Demo 很容易。真正到 SaaS 或多事业线共用同一套 Agent 平台时，你会发现：**模型能力不是瓶颈，租户之间的爆炸半径才是。**

常见翻车：Tenant A 一次长上下文把整机 QPS 打满；Tenant B 的记忆向量混进 A 的检索结果；某个试用账号把 `send_email` 工具狂刷到 SMTP 限流。多租户不是「加个 `tenant_id` 字段」这么简单——它要同时管 **数据隔离、配额熔断、公平调度、成本归因**。

> 经验法则：凡是不能证明「租户 A 的故障无法拖垮租户 B」的 Agent 平台，都还不算生产级多租户。

## 多租户 Agent 要隔离什么

传统 Web 多租户主要隔离数据库行和对象存储前缀。Agent 额外多了三条高风险边界：

| 边界 | 为什么危险 | 隔离单元 |
|------|-----------|----------|
| 上下文 / 记忆 | RAG 与 long-term memory 易串租户 | `tenant_id` 硬前缀 + ACL |
| 工具副作用 | 发信、下单、写库不可逆 | 能力清单按租户签发 |
| LLM 配额 | Token / RPM 被某一户吃光 | 令牌桶 + 优先级队列 |
| 沙盒 / 文件 | 代码执行读到别的租户工件 | 每请求独立 sandbox |
| 密钥 | 工具凭据写进 prompt 或日志 | Credential Broker |

下面按「请求入口 → 配额 → 调度 → 成本」顺序落地。

## 请求模型：把 tenant 当作一等公民

所有入口（HTTP、Webhook、内部队列）先解析租户，再创建 run。不要把 `tenant_id` 塞进 prompt 当「提示」，而要作为系统元数据贯穿全程。

```python
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
import hashlib
import time


class TenantTier(str, Enum):
    FREE = "free"
    PRO = "pro"
    ENTERPRISE = "enterprise"


@dataclass(frozen=True)
class TenantQuota:
    rpm: int                 # 每分钟请求
    tpm: int                 # 每分钟 token（输入+输出粗估）
    max_tool_calls: int      # 单次 run 工具调用上限
    max_concurrency: int     # 同时 in-flight runs
    allowed_tools: frozenset[str]
    priority: int            # 调度优先级，越大越先


TIER_QUOTAS: dict[TenantTier, TenantQuota] = {
    TenantTier.FREE: TenantQuota(
        rpm=20, tpm=40_000, max_tool_calls=8, max_concurrency=2,
        allowed_tools=frozenset({"search", "calculator"}),
        priority=1,
    ),
    TenantTier.PRO: TenantQuota(
        rpm=120, tpm=400_000, max_tool_calls=40, max_concurrency=10,
        allowed_tools=frozenset({"search", "calculator", "code_exec", "email_draft"}),
        priority=5,
    ),
    TenantTier.ENTERPRISE: TenantQuota(
        rpm=600, tpm=2_000_000, max_tool_calls=120, max_concurrency=50,
        allowed_tools=frozenset({"search", "calculator", "code_exec", "email_draft", "crm_write"}),
        priority=10,
    ),
}


@dataclass
class AgentRequest:
    tenant_id: str
    tier: TenantTier
    user_id: str
    session_id: str
    message: str
    request_id: str = field(default_factory=lambda: hashlib.sha1(str(time.time()).encode()).hexdigest()[:12])

    @property
    def ns(self) -> str:
        """所有外部存储的命名空间前缀。"""
        return f"t:{self.tenant_id}"
```

关键点：`allowed_tools` 在网关层强制裁剪，**不要**指望模型「自觉」不调用未授权工具。即便模型发出了 `crm_write`，执行层也必须拒绝。

## 配额熔断：RPM / TPM / 并发三道闸

只限 RPM 不够——Agent 一次 run 可能吃掉几十万 token。生产里至少三道闸：**请求速率、Token 预算、并发槽位**。

```python
import threading
from collections import defaultdict


class TokenBucket:
    def __init__(self, rate: float, capacity: float):
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self.updated = time.monotonic()
        self._lock = threading.Lock()

    def try_consume(self, n: float = 1.0) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self.updated
            self.updated = now
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
            if self.tokens < n:
                return False
            self.tokens -= n
            return True


class TenantQuotaGuard:
    """进程内演示实现；生产可换成 Redis + Lua 做集群一致。"""

    def __init__(self):
        self._rpm: dict[str, TokenBucket] = {}
        self._tpm: dict[str, TokenBucket] = {}
        self._inflight: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()

    def _buckets(self, tenant_id: str, q: TenantQuota):
        if tenant_id not in self._rpm:
            self._rpm[tenant_id] = TokenBucket(rate=q.rpm / 60.0, capacity=q.rpm)
            self._tpm[tenant_id] = TokenBucket(rate=q.tpm / 60.0, capacity=q.tpm)
        return self._rpm[tenant_id], self._tpm[tenant_id]

    def admit(self, req: AgentRequest, estimated_tokens: int) -> tuple[bool, str]:
        q = TIER_QUOTAS[req.tier]
        rpm, tpm = self._buckets(req.tenant_id, q)

        with self._lock:
            if self._inflight[req.tenant_id] >= q.max_concurrency:
                return False, "concurrency_exhausted"

        if not rpm.try_consume(1):
            return False, "rpm_exhausted"
        if not tpm.try_consume(estimated_tokens):
            return False, "tpm_exhausted"

        with self._lock:
            self._inflight[req.tenant_id] += 1
        return True, "ok"

    def release(self, tenant_id: str) -> None:
        with self._lock:
            self._inflight[tenant_id] = max(0, self._inflight[tenant_id] - 1)


def filter_tools(tier: TenantTier, requested: list[str]) -> list[str]:
    allowed = TIER_QUOTAS[tier].allowed_tools
    return [t for t in requested if t in allowed]
```

拒绝时返回结构化错误（`429` + `reason`），让客户端能区分「重试一会」和「升级套餐」。不要用模糊的「服务繁忙」。

## 公平调度：别让 Free 档堵死 Enterprise

配额是「能不能进门」，调度是「进门后谁先跑」。简单 FIFO 会让大量 Free 长任务饿死付费租户。加权公平队列（WFQ）更合适：高优先级租户获得更高服务份额，但仍给低优先级保留最小带宽，避免完全饿死。

```python
import heapq


@dataclass(order=True)
class ScheduledRun:
    virtual_finish: float
    enqueued_at: float
    priority: int
    request: Any = field(compare=False)


class FairScheduler:
    """简化的加权公平调度：虚拟完成时间 = now + cost / weight。"""

    def __init__(self):
        self._pq: list[ScheduledRun] = []
        self._lock = threading.Lock()

    def enqueue(self, req: AgentRequest, estimated_cost: float = 1.0) -> None:
        weight = max(1, TIER_QUOTAS[req.tier].priority)
        now = time.monotonic()
        item = ScheduledRun(
            virtual_finish=now + estimated_cost / weight,
            enqueued_at=now,
            priority=-TIER_QUOTAS[req.tier].priority,
            request=req,
        )
        with self._lock:
            heapq.heappush(self._pq, item)

    def dequeue(self) -> AgentRequest | None:
        with self._lock:
            if not self._pq:
                return None
            return heapq.heappop(self._pq).request
```

| 策略 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| 全局 FIFO | 实现简单 | Free 流量可饿死 Pro | 演示 / 单租户 |
| 严格优先级 | 付费体验最好 | Free 可能长期饿死 | 内部高优任务 |
| 加权公平 (WFQ) | 份额可控、可解释 | 要估 cost | **多租户 SaaS 默认** |
| 每租户独立队列 + worker 池 | 隔离最强 | 资源碎片化 | 超大 Enterprise 专池 |

> 经验：粗估 `estimated_cost` 时，用「历史同工具路径的 p50 token」即可，不必追求精确到单 token——调度对相对权重敏感，对绝对值不敏感。

## 数据与记忆：命名空间必须硬编码

语义缓存、向量库、会话状态只要漏掉 `tenant_id`，就会变成跨租户泄漏。规则只有一条：**所有读写路径的 key / filter 都必须带命名空间，且由服务端注入，不信任模型或客户端传入的「租户声明」。**

```python
def memory_key(req: AgentRequest, kind: str, key: str) -> str:
    # kind: session | long_term | cache
    return f"{req.ns}:{kind}:{key}"


def vector_filter(req: AgentRequest) -> dict[str, Any]:
    # 伪代码：写入向量库 metadata 时强制带 tenant_id
    return {"must": [{"key": "tenant_id", "match": {"value": req.tenant_id}}]}


def run_agent(req: AgentRequest, guard: TenantQuotaGuard, tools: list[str]) -> dict[str, Any]:
    ok, reason = guard.admit(req, estimated_tokens=4_000)
    if not ok:
        return {"status": 429, "error": reason}

    try:
        safe_tools = filter_tools(req.tier, tools)
        # 伪调用：真实系统里把 ns / filter 注入 retriever 与 tool runtime
        ctx_key = memory_key(req, "session", req.session_id)
        return {
            "status": 200,
            "request_id": req.request_id,
            "tools": safe_tools,
            "context_key": ctx_key,
            "vector_filter": vector_filter(req),
        }
    finally:
        guard.release(req.tenant_id)


# --- 可运行自检 ---
if __name__ == "__main__":
    guard = TenantQuotaGuard()
    req = AgentRequest(
        tenant_id="acme",
        tier=TenantTier.PRO,
        user_id="u1",
        session_id="s1",
        message="总结本周工单",
    )
    out = run_agent(req, guard, tools=["search", "crm_write", "code_exec"])
    assert out["status"] == 200
    assert "crm_write" not in out["tools"]          # Pro 档无 CRM 写权限
    assert out["context_key"].startswith("t:acme:")
    print("ok:", out)
```

把上面片段存成脚本直接跑，应打印 `ok:` 且 `crm_write` 被剥离。这就是多租户的最小验收：**权限裁剪 + 命名空间强制**。

## Credential Broker：别让密钥进 Prompt

多租户里第二常见的事故，不是串数据，而是 **租户 B 的 API Key 出现在租户 A 的 trace 或模型上下文里**。工具需要凭据时，应走短时换票，而不是把长寿命密钥塞进环境变量给所有 worker 共用。

```typescript
type Lease = { token: string; expiresAt: number; scopes: string[] };

/** 按租户签发短寿命工具凭据；模型只看见 tool name，看不见 secret */
async function issueToolCredential(
  tenantId: string,
  tool: string,
  scopes: string[],
): Promise<Lease> {
  const res = await fetch("https://broker.internal/v1/lease", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: tenantId,
      tool,
      scopes,
      ttl_seconds: 60,
    }),
  });
  if (!res.ok) throw new Error(`broker_denied:${res.status}`);
  return res.json() as Promise<Lease>;
}

async function invokeTool(
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
) {
  // 真实实现：把 headers.authorization 交给工具 runtime，切勿回传给模型
  return { tool, args, ok: true, authScheme: headers.authorization?.slice(0, 12) };
}

async function runToolWithLease(
  tenantId: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const lease = await issueToolCredential(tenantId, tool, ["write"]);
  try {
    return await invokeTool(tool, args, {
      authorization: `Bearer ${lease.token}`,
    });
  } finally {
    // 可选：主动吊销，缩短泄露窗口
    await fetch(`https://broker.internal/v1/lease/${lease.token}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }
}
```

实践约束：Broker 校验「租户 × 工具 × scopes」三维授权；日志只记 `lease_id` / `tool` / `tenant_id`，永远不记 token 明文；Agent 的 system prompt 里禁止打印环境变量与 headers。

## 吵闹邻居：四类真实故障模式

上线后你会反复碰到这些模式，最好提前写进演练脚本：

1. **上下文轰炸机**：某租户反复上传超长文档，单次 run 预估 token 飙到数十万 → 靠 TPM 闸 + 单次 `max_input_tokens` 双卡。
2. **工具死循环**：模型在错误恢复里反复调用同一写工具 → `max_tool_calls` + 工具侧幂等键（`Idempotency-Key: tenant+hash(args)`）。
3. **缓存投毒误伤**：语义缓存未带 `tenant_id`，A 的答案被 B 命中 → 缓存 key 强制命名空间（这是红线，不是优化）。
4. **共享上游限流**：所有租户打同一模型账号，一家吃满 429 连坐 → 模型路由按租户分 API Key 池，或至少分优先级队列。

混沌演练最低标准：用脚本把 Free 档打到配额上限，同时打 Enterprise 合成流量，断言 Enterprise 的成功率与 p95 延迟仍达标；再故意注入跨租户向量查询，断言过滤后命中数为 0。

## 成本归因与账单可解释

多租户的最后一块板是账单。没有 per-tenant 归因，你无法做套餐定价，也无法在某租户 TPM 告警时定位根因。最低标准：

1. 每次 LLM / Embedding / Rerank 调用带上 `tenant_id`、`request_id`、`model`、`prompt_tokens`、`completion_tokens`。
2. 工具调用单独记账（沙盒秒数、第三方 API 次数），不要只盯模型。
3. 日/周聚合写入计量表，套餐超限时触发「降级模型 / 只读工具」而不是静默继续烧钱。
4. 对内暴露「本租户今日 top 贵会话」看板，方便客户自己收敛浪费的 Agent 用法。

| 指标 | 采集点 | 用途 |
|------|--------|------|
| TPM / RPM | 配额网关 | 限流与告警 |
| $/租户 / 日 | 计费流水 | 套餐与对账 |
| 工具失败率 | Tool Runtime | 发现某户恶意或坏集成 |
| p95 队列等待 | 调度器 | 调整权重与专池 |
| 跨租户检索命中数 | 记忆 / RAG 层 | 应为恒 0 的安全哨兵 |

## 选型建议与落地 Checklist

**什么时候必须上多租户机制？**

- 你在卖「Agent 能力」给多个客户或内部事业线共用同一控制面；
- 工具具备不可逆副作用（写 CRM、发邮件、改权限）；
- 单租户已经能打满模型 RPM，或账单里出现「说不清是谁花的」。

**什么时候可以先不做全套 WFQ？**

- 内部单团队、流量小：`tenant_id` 命名空间 + 粗粒度 RPM 就够；
- 每个 Enterprise 客户已是独立部署：用「专池」替代精细公平调度。

落地 checklist：

- [ ] **入口强制解析 `tenant_id`**，写入 trace / log / span 属性，禁止仅靠 prompt 声明
- [ ] **RPM + TPM + 并发** 三道闸，拒绝原因可机器解析
- [ ] **工具能力按套餐签发**，执行层二次校验，模型输出不可绕过
- [ ] **记忆 / 向量 / 缓存 key 带命名空间**，检索 filter 由服务端注入
- [ ] **密钥走 Credential Broker**，工具运行时短时换票，不进 prompt / 日志
- [ ] **调度用加权公平或专池**，避免 FIFO 饿死付费租户
- [ ] **成本流水按租户归因**，超限可降级模型或只读工具
- [ ] **吵闹邻居混沌演练**：打满 Free 档，确认 Enterprise SLO 仍达标；跨租户检索命中恒为 0

多租户 Agent 平台的目标不是「更多功能」，而是 **可证明的爆炸半径**：任一租户的暴走，最多烧掉自己的配额，而不是整个平台。先把命名空间和配额闸门做硬，再谈更漂亮的套餐与调度算法。
