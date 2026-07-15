---
title: "Least Autonomy 工程：Agent 什么时候该闭嘴不行动"
date: 2026-07-15
tags: ["AI Agent", "工程化", "Agent 架构"]
excerpt: "2026 年 AgentAbstain / Agentic Abstention 表明：前沿 Agent 的 Paired Accuracy 仍卡在 60%。本文给出可落地的弃权（abstention）策略层——何时拒做、何时追问、何时早停，以及如何评测。"
emoji: "🛑"
vip: false
draft: false
---

## 行动偏差才是生产事故的默认原因

团队上线 Agent 时，通常优化的是「任务成功率」：有没有把邮箱发出去、订单改没改对、PR 创没创成。但 2026 年中旬陆续出现的 **Agentic Abstention** 与 **AgentAbstain** 研究表明：真正拉开生产可靠性的，往往不是「更会做事」，而是「更会收手」。

AgentAbstain 在 42 个可执行 MCP 沙箱、263 组成对任务上评了 17 个前沿模型：最好的 **Paired Accuracy 只有约 59.5%**，13/17 的模型甚至过不了 50%。更糟的是一种特有失败模式——**事后弃权（post-hoc abstention）**：先把 `send_email` / `delete_file` 这类 commit 工具跑完，再在回复里写「建议暂缓」。口头拒绝了，状态已经改了。

> Agentic Abstention 是一个顺序决策问题：每一步都可以「继续搜集信息 / 作答 / 弃权」。关键点不只是会不会 abstain，而是 **什么时候** abstain——晚一拍就等于多付了无效 tool call，甚至造成不可逆副作用。

这和三篇已有文章的分工不同：

| 主题 | 决策时机 | 解决什么 |
|------|----------|----------|
| [何时不该用 Agent](/portfolio/blog/when-not-to-use-agent) | 立项/架构期 | 整条链路该不该交给 LLM |
| [HITL 工程](/portfolio/blog/human-in-the-loop-agent-engineering) | 运行中断点 | 人审后继续 / 否决 |
| [Output Guard](/portfolio/blog/agent-output-guards) | 单次 tool call 前 | 参数与语义是否合法 |
| **本文：Abstention / Least Autonomy** | 整条轨迹任意步 | 任务本身是否仍值得继续行动 |

Least Autonomy 的工程定义很简单：**默认不做；只有证据够、权限够、环境状态可达成时才升级为行动**。弃权不是弱模型，是更强的控制面。权限清单回答「允不允许调用某工具」；弃权策略回答「此刻这件事还该不该继续推」。你给了 Agent `refund` 权限，不代表在证据冲突时它应该立刻调用——那是 Least Autonomy 要拦住的升级，而不是 IAM 的职责。

## 弃权触发器：执行前 vs 运行中

AgentAbstain 把触发器分成两相、八类。生产落地不必照搬论文标签，但相位区分必须进架构：

| 相位 | 典型触发 | 可观测面 | 错误代价 |
|------|----------|----------|----------|
| **Pre-execution** | 缺参、意图歧义、约束冲突、高风险、工具缺口 | 用户指令 + tool schema | 拒绝得早 → 几乎无副作用 |
| **Runtime** | 工具失败、证据冲突、目标不存在、风险涌现 | tool 返回 / 环境观测 | 弃权偏晚 → 空转成本 + commit 风险 |

「看起来可行，直到环境告诉你不行」——例如购物指令要求不存在的 SKU、终端里缺前置依赖——是及时弃权最难的一类。论文侧一个稳健结论是：**模型变大更多改善最终 recall，未必改善 timely abstention**；靠堆 scale 治不好晚弃权。

工程上把决策压成四态，而不是二元「做 / 不做」：

```text
GATHER  → 还能用 lookup/verify 降低不确定性，禁止 commit
ACT     → 证据与权限达标，允许 commit 级工具
CLARIFY → 信息缺口无法从环境恢复，向用户追问后停
ABSTAIN → 不可行 / 冲突 / 超权限，明确拒绝并说明触发器
```

`CLARIFY` 与 `ABSTAIN` 都算「不继续行动」：前者把球抛回用户，后者宣告任务放弃。别把两者混成一句「我无法完成」——对产品与审计，原因码必须分叉。

## Least Autonomy 策略层：可运行的决策核

权限边界解决的是「能不能做」；弃权策略解决的是「该不该做」。两者正交，建议合成一个统一的 `AutonomyGate`，挂在 router 与 tool executor 之间。

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Decision(str, Enum):
    GATHER = "gather"
    ACT = "act"
    CLARIFY = "clarify"
    ABSTAIN = "abstain"


class ToolKind(str, Enum):
    LOOKUP = "lookup"    # 只读
    VERIFY = "verify"    # 校验门
    COMMIT = "commit"    # 改状态


@dataclass
class Observation:
    tool: str
    kind: ToolKind
    ok: bool
    payload: dict[str, Any] = field(default_factory=dict)
    signals: list[str] = field(default_factory=list)  # 如 missing_target


@dataclass
class GateState:
    missing_required: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    authority_ok: bool = True
    risk_score: float = 0.0          # 0~1
    gather_budget: int = 3           # 剩余可搜集步数
    commit_budget: int = 1           # 剩余可提交步数
    observations: list[Observation] = field(default_factory=list)

    @property
    def saw_missing_target(self) -> bool:
        return any("missing_target" in o.signals for o in self.observations)

    @property
    def saw_conflicting_evidence(self) -> bool:
        return any("conflict" in o.signals for o in self.observations)


RISK_ACT_THRESHOLD = 0.35
RISK_CLARIFY_THRESHOLD = 0.7


def autonomy_decide(state: GateState, next_kind: ToolKind) -> Decision:
    """Least Autonomy：默认降档；只有证据与预算都够才升到 ACT。"""
    if state.conflicts or state.saw_conflicting_evidence:
        return Decision.ABSTAIN

    if not state.authority_ok:
        return Decision.ABSTAIN

    if state.missing_required:
        # 环境凑不齐 → CLARIFY；还能查 → GATHER
        if state.gather_budget > 0 and next_kind != ToolKind.COMMIT:
            return Decision.GATHER
        return Decision.CLARIFY

    if state.saw_missing_target:
        return Decision.ABSTAIN

    if state.risk_score >= RISK_CLARIFY_THRESHOLD:
        return Decision.CLARIFY

    if next_kind == ToolKind.COMMIT:
        if state.commit_budget <= 0:
            return Decision.ABSTAIN
        if state.risk_score > RISK_ACT_THRESHOLD:
            return Decision.CLARIFY
        if state.gather_budget > 0 and not _verified_enough(state):
            return Decision.GATHER
        return Decision.ACT

    if state.gather_budget <= 0 and next_kind == ToolKind.LOOKUP:
        return Decision.ABSTAIN  # 再搜也没用，停

    return Decision.GATHER if next_kind != ToolKind.COMMIT else Decision.ACT


def _verified_enough(state: GateState) -> bool:
    verifies = [o for o in state.observations if o.kind == ToolKind.VERIFY and o.ok]
    return len(verifies) >= 1


# --- demo：运行时发现目标不存在，应早停而不是硬搜 ---
if __name__ == "__main__":
    s = GateState(authority_ok=True, risk_score=0.2, gather_budget=2, commit_budget=1)
    s.observations.append(
        Observation("search_sku", ToolKind.LOOKUP, True, signals=["missing_target"])
    )
    assert autonomy_decide(s, ToolKind.COMMIT) == Decision.ABSTAIN
    print("ok: missing target → ABSTAIN before commit")
```

要点：

1. **Lookup / Verify / Commit 三分工具**——和 AgentAbstain 的工具分类一致。弃权策略只对 `COMMIT` 严格；对 `LOOKUP` 用预算熄灭空转。
2. **默认是 GATHER 或降档**，不是默认 ACT。这就是 Least Autonomy：升级需要正向条件，不是缺省成立。
3. **冲突与缺目标是硬 ABSTAIN**，不要指望「再试一次工具」赌运气——论文里 Conflicting Evidence / Conflicting Constraints 正是成对准确率最差的几档。

TypeScript 侧可以对称成拦截器，挂在工具调度器上：

```typescript
type ToolKind = "lookup" | "verify" | "commit";
type Decision = "gather" | "act" | "clarify" | "abstain";

interface AutonomyState {
  missingRequired: string[];
  conflicts: string[];
  authorityOk: boolean;
  riskScore: number;
  gatherBudget: number;
  commitBudget: number;
  flags: Set<"missing_target" | "conflict">;
}

export function decideAutonomy(
  state: AutonomyState,
  nextKind: ToolKind
): Decision {
  if (state.conflicts.length || state.flags.has("conflict")) return "abstain";
  if (!state.authorityOk) return "abstain";
  if (state.flags.has("missing_target")) return "abstain";
  if (state.missingRequired.length) {
    return state.gatherBudget > 0 && nextKind !== "commit" ? "gather" : "clarify";
  }
  if (state.riskScore >= 0.7) return "clarify";
  if (nextKind === "commit") {
    if (state.commitBudget <= 0) return "abstain";
    if (state.riskScore > 0.35) return "clarify";
    return "act";
  }
  return state.gatherBudget > 0 ? "gather" : "abstain";
}
```

Gate 返回 `clarify` / `abstain` 时，把原因码写进 trace（`trigger=missing_target` 等），再映射成对用户可见的文案。评估与审计都读同一份原因码，不要只靠自然语言回复。

## 评测：别再用「成功率」自欺

成本工程看的是 $/token；弃权工程必须看决策边界。直接借 AgentAbstain 的成对思路做影子评测：

| 指标 | 定义 | 工程用途 |
|------|------|----------|
| Act Accuracy | should-act 任务是否执行了关键 commit | 防过度拒绝 |
| Abstain Accuracy | should-abstain 是否未执行关键 commit 且明确拒绝/追问 | 防欠拒绝 |
| **Paired Accuracy** | 同一扰动对两侧都对 | 主指标；恒行动/恒拒绝都 ≤50% |
| Timely Abstention | 在发现触发器后的 N 步内停 | 管空转与晚弃权 |
| Post-hoc Abstention Rate | 已 commit 却在文本里「拒绝」的比例 | 必须压到 ≈0 |

最小评测 harness：

```python
from dataclasses import dataclass


@dataclass
class PairResult:
    act_ok: bool
    abstain_ok: bool
    abstain_steps_after_trigger: int | None
    committed_then_refused: bool


def paired_accuracy(rows: list[PairResult]) -> float:
    return sum(r.act_ok and r.abstain_ok for r in rows) / max(len(rows), 1)


def timely_rate(rows: list[PairResult], max_lag: int = 1) -> float:
    eligible = [r for r in rows if r.abstain_steps_after_trigger is not None]
    if not eligible:
        return 0.0
    return sum(r.abstain_steps_after_trigger <= max_lag for r in eligible) / len(eligible)
```

上线门槛建议（客服 / 运维类 Agent）：

- Paired Accuracy ≥ 0.75（用自家任务对，不要拿通用榜当 KPI）
- Post-hoc Abstention Rate = 0（硬门禁：commit 后禁止再判为「成功弃权」）
- Timely Abstention：触发后 ≤1 个额外 tool call

Concurrent 的 Agentic Abstention 工作还展示了 **convolve**：把历史轨迹蒸馏成可复用的 stopping rules，追加进 context，WebShop 上及时弃权召回可从约 27% 拉到约 57%，且无需改权重。生产等价物是：把每次误行动工单写成「若观测到 X 信号 → 强制 ABSTAIN/CLARIFY」规则，塞进 system / skill，而不是指望下一次模型「记住了」。

### 把 stopping rules 版本化

规则本身应该当代码管：进 git、可 diff、可灰度。最小形态如下——每周从误行动样本里抽 3～5 条，用确定性匹配压过 prompt「请自行判断」：

```python
STOPPING_RULES = [
    {
        "id": "sku-empty-v1",
        "when": {"signal": "missing_target", "tool_prefix": "search_"},
        "then": "abstain",
        "message": "当前目录/库存中不存在匹配目标，停止继续搜索与下单。",
    },
    {
        "id": "refund-conflict-v2",
        "when": {"signal": "conflict", "domain": "refund"},
        "then": "abstain",
        "message": "订单状态与退款资格证据冲突，需人工核对后再处理。",
    },
]


def match_stopping_rule(obs_signals: set[str], tool: str, domain: str) -> dict | None:
    for rule in STOPPING_RULES:
        w = rule["when"]
        if w.get("signal") not in obs_signals:
            continue
        if "tool_prefix" in w and not tool.startswith(w["tool_prefix"]):
            continue
        if "domain" in w and w["domain"] != domain:
            continue
        return rule
    return None
```

上线前用 should-abstain 影子流量回放：规则命中后若仍出现 commit，直接判回归失败。规则库膨胀时按 `domain` 分片加载，避免把整本 playbook 塞进每次请求的 context。

## 与权限、HITL、Guard 的接线方式

一条可维护的请求路径：

```text
User goal
  → Intent normalize（缺参？冲突？）        → CLARIFY / ABSTAIN
  → Authority check（角色/租户/额度）       → ABSTAIN
  → Planner（只允许 LOOKUP/VERIFY 先跑）
  → AutonomyGate(per tool)                 → GATHER / ACT / …
  → Output Guard（结构 + 语义）            → reject + fix_hint
  → Executor
  → 若 risk 超阈且未弃权                 → HITL interrupt
```

常见踩坑：

1. **只靠 prompt「不确定就别做」**——AgentAbstain 证明 compliance bias 很强；没有预算与硬 gate，模型会边做边犹豫。
2. **把弃权做成安全拒绝的子集**——恶意指令该拒，合法但不可行任务也该停；两套原因码、一套执行路径。
3. **晚停当成功**——最终口头弃权了，前面已经扫了 20 次无结果搜索，账单和延迟已经花了。KPI 必须含 timely。
4. **HITL 代替弃权**——把「明显不可行」一律丢给人，只会制造审核垃圾。不可恢复缺口用 ABSTAIN，可恢复但高风险用 HITL。
5. **用任务成功率倒逼弃权策略**——在成对评测里恒行动也能刷高 should-act 一侧；没有 Paired Accuracy，团队会系统性地奖励「先干再说」。

如果只改一行架构原则，改这一行就够：把 Agent 的默认策略从「尽量完成用户目标」改成「在证据未闭合前，优先保全环境状态」。目标完成率仍然重要，但必须和弃权校准一起看——否则你优化的是一个会把歧义任务硬做成脏数据的机器。

## 落地 Checklist

- [ ] 工具清单标好 `lookup | verify | commit`，commit 默认经 AutonomyGate
- [ ] 决策四态落地：`GATHER / ACT / CLARIFY / ABSTAIN`，原因码进 trace
- [ ] 建至少 30 组成对影子任务（同环境、单点扰动），算 Paired Accuracy
- [ ] CI 门禁：`post_hoc_abstention_rate == 0`
- [ ] gather/commit 设硬预算；超预算自动 ABSTAIN，禁止「再试一下」
- [ ] 把误行动工单蒸馏成 stopping rules，版本化进 Prompt/Skill（convolve 工程化）
- [ ] 产品文案区分「需要你补充信息」与「该任务在当前环境不可完成」
- [ ] 与 [Output Guard](/portfolio/blog/agent-output-guards)、[HITL](/portfolio/blog/human-in-the-loop-agent-engineering) 串联，不要互相替代

**选型建议**：内部只读助手可先做 Pre-execution 弃权（缺参 / 工具缺口）；一旦有 commit 副作用，必须上 Runtime 触发器 + 成对评测 + post-hoc 硬门禁。Least Autonomy 不是让 Agent 更胆小，而是让「继续行动」成为需要证据证明的特权。
