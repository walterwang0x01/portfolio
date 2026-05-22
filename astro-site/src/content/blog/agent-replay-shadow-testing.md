---
title: "Agent 流量回放与影子测试：从 POC 到生产的回归保障"
date: 2026-05-22
tags: ["AI Agent", "工程化", "评估"]
excerpt: "改一行 prompt 上线后炸了 40% 的工具调用——这不是段子，是 Agent 系统每周都在发生的事。本文给一套从 trace 捕获、回放引擎到影子流量的三层保障方案，让你像测后端 API 一样把 Agent 的回归卡死在 PR 阶段。"
emoji: "🎬"
vip: false
draft: false
---

## 为什么 Agent 的回归测试比传统软件难十倍

传统后端服务的回归测试有一个隐含前提：**相同输入产生相同输出**。一个 PR 改了代码，跑一遍单测和集成测试，绿了就敢上。

Agent 不行。Agent 系统至少有三个非确定性来源：

1. **LLM 本身**——同样的 prompt，temperature=0 也未必稳定（实际生产中很少真的设 0，否则探索能力下降）
2. **外部工具状态**——查询数据库、调用第三方 API，今天和昨天返回不一样
3. **Prompt 与工具的耦合**——改一句系统提示词，模型可能把工具 A 调成工具 B；加一个新工具，原本走 A 路径的任务突然走 B 路径

我自己踩过的最贵的一次：把系统提示里 "回答时尽量简洁" 改成 "回答时控制在 200 字内"，上线后线上 40% 的复杂工具链调用直接断在第一步——模型把"控制在 200 字内"理解成了"对工具返回结果摘要后再决策"，结果摘要丢了关键字段。单元测试全绿，黄金集 10 条 case 全过，靠用户投诉才发现。

这种问题用人工 review 防不住，靠堆 case 也防不住。需要一套**自动化、覆盖真实流量、PR 级别**的保障体系。

## 三层保障：金字塔结构

类比传统测试金字塔，Agent 也有自己的金字塔，但权重完全不同：

```text
       ┌────────────────────┐
       │   Shadow 流量       │  少量、长期、覆盖真实分布
       ├────────────────────┤
       │   线上 Trace 回放    │  每天千条级，PR 卡门
       ├────────────────────┤
       │   黄金集（Gold Set） │  几十到几百条，CI 必跑
       └────────────────────┘
```

| 层级 | 数据来源 | 评估方式 | 触发时机 | 解决什么问题 |
|------|----------|----------|----------|--------------|
| 黄金集 | 人工挑选+标注 | 强断言（输出包含 X、调用了 Y） | 每个 PR | 核心能力不能退化 |
| Trace 回放 | 线上脱敏后的真实流量 | 软评估（LLM-as-Judge + diff） | PR 合并前 | 真实分布不能退化 |
| Shadow 流量 | 实时镜像生产请求 | 双跑 diff + 人工抽查 | 灰度阶段 | 边缘 case + 长尾 |

下面拆每一层怎么落。

## 第一层：黄金集——最先建、最常用

黄金集是几十到几百条**人工精挑**的高价值 case，每条带强断言。它不追求覆盖真实分布，追求**核心能力不漏**。

写法上推荐用 YAML 而不是 Python 代码，让产品和 QA 也能写：

```yaml
# evals/gold/order_query_basic.yaml
id: gold-001
description: 用户查询某个订单的物流状态
input:
  user_message: "我那个 12345 订单到哪了"
  context:
    user_id: "u_test_001"
expectations:
  - type: tool_called
    tool_name: query_logistics
    args_contains:
      order_id: "12345"
  - type: response_contains
    any_of: ["运输中", "已签收", "派送中"]
  - type: response_not_contains
    forbidden: ["数据库错误", "我无法", "对不起"]
  - type: latency_p95_ms
    max: 8000
```

跑的时候用一个轻量 runner：

```python
import yaml
from pathlib import Path
from agent.runner import run_agent  # 你的 Agent 入口

def evaluate_case(case_path: Path) -> dict:
    case = yaml.safe_load(case_path.read_text())
    trace = run_agent(case["input"]["user_message"], context=case["input"].get("context"))

    failures = []
    for exp in case["expectations"]:
        if exp["type"] == "tool_called":
            calls = [c for c in trace.tool_calls if c.name == exp["tool_name"]]
            if not calls:
                failures.append(f"未调用 {exp['tool_name']}")
            elif "args_contains" in exp:
                for k, v in exp["args_contains"].items():
                    if calls[0].args.get(k) != v:
                        failures.append(f"参数 {k} 期望 {v} 实际 {calls[0].args.get(k)}")
        elif exp["type"] == "response_contains":
            if not any(s in trace.final_response for s in exp["any_of"]):
                failures.append(f"响应未命中关键词 {exp['any_of']}")
        elif exp["type"] == "response_not_contains":
            for forbidden in exp["forbidden"]:
                if forbidden in trace.final_response:
                    failures.append(f"响应出现禁用词 {forbidden}")

    return {"id": case["id"], "passed": not failures, "failures": failures}
```

CI 里跑全量，挂一条都不让 merge。**关键纪律**：每次线上 P0/P1 故障，复盘后必须把场景加进黄金集，永远不让同一个坑踩两次。

## 第二层：线上 Trace 回放——真实分布的护城河

黄金集的死穴是**写出来的人不知道用户真实怎么提问**。线上 trace 回放就是用真实流量来兜底。

### Trace schema 设计

捕获 trace 时不能只存 prompt 和 response，要存够"重放"用的所有依赖：

```python
from dataclasses import dataclass, field
from typing import Any

@dataclass
class ToolInvocation:
    name: str
    args: dict
    result: Any  # 必须存原始返回，回放时直接 mock 掉
    duration_ms: int
    error: str | None = None

@dataclass
class AgentTrace:
    trace_id: str
    timestamp: str
    user_message: str
    user_id_hash: str  # 脱敏后的用户标识
    context: dict      # 业务上下文（订单、会话历史等）
    model: str
    model_params: dict # temperature / top_p / system_prompt_hash
    tool_invocations: list[ToolInvocation]
    final_response: str
    total_tokens: int
    business_outcome: str | None = None  # 用户后续行为：满意/转人工/重问
```

注意 `tool_invocations` 里的 `result` 必须存——回放时如果还去真打第三方 API，结果非确定，根本没法对比。我们要的是**给定相同的工具返回，新代码会做出怎样不同的决策**。

### 脱敏与采样

线上日志直接拿来用会出合规事故。一定要做：

- **PII 替换**：手机号、邮箱、地址、身份证号正则匹配后脱敏成稳定占位符（同一个号映射到同一个 fake，保留一致性）
- **采样策略**：不要全量存（成本爆炸），按业务结果分层采样——失败 case 100%、低满意度 case 50%、正常 case 1%
- **保留期**：30 天滚动，过期自动删除

### 回放引擎

回放时把 LLM 调用照常走（用新代码），把工具调用从原 trace 直接取结果，不再真打：

```python
class ReplayHarness:
    """回放引擎：用历史 trace 喂给新代码，对比行为差异。"""

    def __init__(self, trace: AgentTrace):
        self.trace = trace
        self._tool_results = {
            (t.name, json.dumps(t.args, sort_keys=True)): t.result
            for t in trace.tool_invocations
        }
        self._unmatched_calls: list[tuple[str, dict]] = []

    def mock_tool(self, name: str, args: dict) -> Any:
        key = (name, json.dumps(args, sort_keys=True))
        if key in self._tool_results:
            return self._tool_results[key]
        # 新代码调了原 trace 没出现过的工具组合，记下来
        self._unmatched_calls.append((name, args))
        # 返回一个合理的"未知"占位让 Agent 继续跑
        return {"status": "unknown", "_replay_unmatched": True}

    def run(self) -> "ReplayResult":
        new_trace = run_agent(
            self.trace.user_message,
            context=self.trace.context,
            tool_executor=self.mock_tool,  # 注入 mock
        )
        return ReplayResult(
            original=self.trace,
            new=new_trace,
            unmatched_calls=self._unmatched_calls,
        )
```

### Diff 评估：什么算"退化"

回放完拿到新旧两条 trace，怎么判断新版本变差了？这一步是难点。

我用三类信号组合判断：

```python
def evaluate_diff(result: ReplayResult) -> dict:
    orig, new = result.original, result.new
    signals = {}

    # 1. 工具调用集合差异（强信号）
    orig_tools = {t.name for t in orig.tool_invocations}
    new_tools = {t.name for t in new.tool_invocations}
    signals["tools_dropped"] = orig_tools - new_tools
    signals["tools_added"] = new_tools - orig_tools

    # 2. 响应语义相似度（弱信号，仅参考）
    signals["response_cosine"] = cosine_sim(
        embed(orig.final_response), embed(new.final_response)
    )

    # 3. LLM-as-Judge 判定（关键）
    judge_prompt = f"""
原响应：{orig.final_response}
新响应：{new.final_response}
用户问题：{orig.user_message}

新响应相对于原响应是【更好/相当/更差/明显错误】中的哪一种？
只输出标签和一句话理由。
"""
    signals["judge_verdict"] = call_judge_model(judge_prompt)

    # 4. 关键字段是否丢失（强信号）
    orig_entities = extract_entities(orig.final_response)  # 订单号/金额/时间
    new_entities = extract_entities(new.final_response)
    signals["entities_lost"] = orig_entities - new_entities

    return signals
```

判定规则：

- 工具集合丢失 + 实体丢失 + judge 说「明显错误」→ **硬失败**，PR 卡住
- 仅 judge 说「更差」但实体没丢 → **告警**，需要 review 但不卡 PR
- 仅响应余弦相似度低 → **忽略**（Agent 改写答案是常态）

### CI 集成

PR 流水线里跑 200~500 条采样回放（黄金集那些场景多权重，长尾少权重）。我们的实测：完整跑一轮约 8 分钟，能拦下黄金集漏掉的 70% 退化。

## 第三层：Shadow 流量——上线前的最后一道闸

黄金集和回放都是离线的，shadow 是**生产环境实时双跑**：把线上请求镜像一份给新版本，结果不返回给用户，只记录用于对比。

```python
@app.post("/agent/chat")
async def chat(req: ChatRequest, bg: BackgroundTasks):
    # 主路径：现网版本
    primary_resp = await primary_agent.run(req)

    # 影子路径：异步触发，不阻塞主链路
    if shadow_enabled(req.user_id, ratio=0.05):  # 5% 采样
        bg.add_task(run_shadow, req, primary_resp)

    return primary_resp


async def run_shadow(req: ChatRequest, primary: AgentResponse):
    try:
        async with timeout(30):  # 影子超时不拖累系统
            shadow_resp = await shadow_agent.run(req)
        await diff_logger.log({
            "trace_id": req.trace_id,
            "primary": primary.to_dict(),
            "shadow": shadow_resp.to_dict(),
            "diff": compute_diff(primary, shadow_resp),
        })
    except Exception as e:
        # 影子挂了不能影响主流程，吃掉异常 + 告警
        logger.warning("shadow_failed", trace_id=req.trace_id, error=str(e))
```

注意几个工程坑：

- **写操作绝对不能进 shadow**——发邮件、扣款、改数据库这些工具必须在 shadow 模式下短路成 mock，否则会发两遍邮件
- **第三方限流**——shadow 流量也消耗配额，OpenAI 的 RPM 是按账户算的，shadow 跑大了主流程就 429 了，要走独立 key
- **结果不能回写**——shadow 产生的对话历史、用户画像都不能写回主存储

Shadow 跑 24~48 小时，用 LLM-as-Judge 跑 diff，人工抽查异常样本。如果差异分布稳定（比如新版工具调用次数减少 15% 且 judge 判定不差），就可以灰度。

## 真实案例：prompt 一行改动炸了 40% 工具链

回到开头那个例子。如果当时有这套体系：

1. **黄金集**：可能漏掉，因为简单 case 改字数没事
2. **Trace 回放**：会捕到——回放 200 条复杂工具链 case，会发现 80 条左右 `tools_dropped` 出现 `query_user_profile` `fetch_order_history` 这些工具消失，judge 判定「更差」。**直接卡 PR**
3. **Shadow**：兜底——即使前两层漏了，灰度时 shadow diff 会显示工具调用数量分布偏移，运维告警

真实部署后，我们组的 Agent 服务**从平均一周一次线上回滚降到两个月一次**，且回滚都是黄金集和回放都判定「相当」、灰度后才发现的真长尾问题。

## 落地 Checklist

按优先级落地，不要一上来铺全套：

- [ ] **第 1 周**：定义 `AgentTrace` schema，所有 Agent 调用强制写 trace
- [ ] **第 2 周**：建 30 条黄金集，CI 跑通，挂一条卡 PR
- [ ] **第 3-4 周**：上 trace 采集 + 脱敏管道，每天采样存 1000 条
- [ ] **第 5 周**：实现回放引擎，PR 流水线跑 200 条
- [ ] **第 6 周**：定义 diff 评估规则，调 judge prompt 直到 false positive < 10%
- [ ] **第 7-8 周**：上 shadow 流量（5% 采样起步），写 diff 看板
- [ ] **持续**：每次线上故障复盘后必须沉淀到黄金集

不要等回放和 shadow 都完美才上——**先有黄金集 + trace schema，剩下的边跑边补**。这套体系的边际价值在第二层之后开始爆发，但第一层和 schema 是不能省的地基。

Agent 的工程化和传统服务最大的区别：**bug 不是 crash，是悄悄变蠢**。回归测试体系不到位，就是在用线上用户当 QA。早点把这套搭起来，下次改 prompt 才能睡得着觉。
