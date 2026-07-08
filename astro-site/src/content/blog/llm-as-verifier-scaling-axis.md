---
title: "LLM-as-a-Verifier：把「验证能力」做成 Agent 的第四条扩展轴"
date: 2026-07-08
tags: ["AI Agent", "评估", "工程化"]
excerpt: "预训练、后训练、测试时算力之后，验证（verification）正在成为第四条扩展轴。本文拆解 LLM-as-a-Verifier 框架：如何用 verifier agent 替代硬编码规则，在工具调用、代码生成、研究流水线里落地细粒度反馈。"
emoji: "✅"
vip: false
draft: false
---

预训练扩数据、后训练扩对齐、测试时扩推理——过去两年 Agent 能力的增长，基本逃不出这三根轴。arXiv 新论文 *LLM-as-a-Verifier: A General-Purpose Verification Framework* 提出了第四条：**verification**，也就是让模型（或专门的 verifier agent）对中间产物做可扩展的质量把关，而不是写死在 if-else 里。

这和「输出护栏」有关，但视角不同：Output Guard 解决的是 **该不该执行**；Verifier 解决的是 **每一步是否达标、哪里不达标、怎么改**。对长链路 Agent（编码、研究、数据分析）来说，后者往往决定迭代效率。

## 为什么验证需要单独成轴

典型 Agent 循环是：计划 → 调工具 → 观察 → 再计划。失败模式通常不是最后一步爆炸，而是 **中间步骤悄悄偏离**：

| 阶段 | 常见静默失败 | 硬编码规则能覆盖？ |
|------|-------------|------------------|
| 检索 | 引用了过时文档 | 部分（日期阈值） |
| 代码生成 | 能跑但逻辑错 | 难（需语义判断） |
| 数据分析 | 图表与结论不一致 | 很难 |
| 多步推理 | 前后矛盾 | 几乎不行 |

规则引擎在「形状校验」上很强（JSON Schema、类型、范围），但对 **语义正确性、跨步一致性、领域规范** 很快触顶。用 LLM 做 verifier 的价值在于：同一套接口可以验证检索相关性、代码行为、论证链条——**验证任务本身可扩展**，而不必为每个工具写一套专用断言。

## LLM-as-a-Verifier 框架长什么样

论文给出的抽象很干净，落地时可以映射成三层：

```
Producer Agent          Verifier Agent              Environment
     │                        │                          │
     ├── 产出 artifact ──────▶│                          │
     │                        ├── 细粒度反馈（pass/fail + 理由）│
     │◀─── revision hints ────│                          │
     ├── 修订后重试 ──────────────────────────────────────▶│
     │                        │                          │
     └── 达到验证阈值 ────────▶│── 放行 ─────────────────▶│
```

**Producer** 负责生成（代码、SQL、摘要、计划）。**Verifier** 只读 artifact + 约束规范，输出结构化判定。关键设计点：

1. **验证与生成解耦**——verifier 可以用更小、更便宜的模型，甚至不同厂商，降低「自己批改自己作业」的偏差
2. **反馈必须可操作**——不是「质量不好」，而是「第 3 步引用的 metric 与表头不一致，应改为 …」
3. **可组合**——多个 verifier 串联（语法 → 安全 → 业务），类似 CI pipeline

## 最小可运行示例：工具调用前的 Verifier

下面是一个 Python 骨架，在 function call 执行前插入 verifier（与 Output Guard 互补）：

```python
from dataclasses import dataclass
from typing import Any
import json

@dataclass
class Verdict:
    ok: bool
    score: float
    issues: list[str]
    suggestions: list[str]

VERIFIER_SYSTEM = """你是工具调用验证器。只根据「工具定义」「参数」「业务约束」判断。
输出 JSON：{"ok": bool, "score": 0-1, "issues": [], "suggestions": []}
不要执行工具，不要编造未给出的上下文。"""

def verify_tool_call(
    client,
  *,
    tool_name: str,
    arguments: dict[str, Any],
    policy: str,
    model: str = "claude-haiku-4-5",
) -> Verdict:
    payload = {
        "tool": tool_name,
        "arguments": arguments,
        "policy": policy,
    }
    resp = client.messages.create(
        model=model,
        max_tokens=512,
        system=VERIFIER_SYSTEM,
        messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    )
    data = json.loads(resp.content[0].text)
    return Verdict(
        ok=bool(data["ok"]),
        score=float(data["score"]),
        issues=list(data.get("issues", [])),
        suggestions=list(data.get("suggestions", [])),
    )

def run_with_verification(agent, tool_call: dict, policy: str, max_retries: int = 2):
    for attempt in range(max_retries + 1):
        verdict = verify_tool_call(
            agent.client,
            tool_name=tool_call["name"],
            arguments=tool_call["arguments"],
            policy=policy,
        )
        if verdict.ok and verdict.score >= 0.85:
            return agent.execute(tool_call)
        tool_call["arguments"] = agent.revise(tool_call, verdict.suggestions)
    raise RuntimeError(f"Verifier blocked: {verdict.issues}")
```

注意 verifier 用的是 **独立 system prompt + 结构化输出**，而不是让主 agent 自问「我这样对吗」。

## 与 Output Guard、Eval、Judge 怎么分工

博客里已经写过 [Agent 输出验证层](/portfolio/blog/agent-output-guards) 和 [LLM-as-Judge 偏差校准](/portfolio/blog/llm-as-judge-bias-calibration)。三者容易混，一张表理清：

| 机制 | 触发时机 | 主要问题 | 典型输出 |
|------|---------|---------|---------|
| Output Guard | 副作用执行前 | 会不会造成不可接受损失？ | allow / deny / escalate |
| LLM-as-a-Verifier | 每步 artifact 完成后 | 这一步是否满足规范？ | pass + 修订建议 |
| LLM-as-Judge | 离线评测 / 抽检 | 整体质量如何排名？ | 分数 + 评语 |

生产上的推荐组合：

- **在线**：Guard（硬边界）+ Verifier（软迭代）
- **离线**：Judge 做 benchmark + Verifier 规则蒸馏回小型分类器（降本）

## 选型建议：什么时候上 Verifier，什么时候别上

| 场景 | 建议 | 原因 |
|------|------|------|
| 单步问答、无工具 | 通常不需要 | 延迟和成本不划算 |
| 3～10 步工具链 | 强烈建议 | 错误在中间步累积 |
| 编码 Agent | 建议 + 单元测试 verifier | 语义 + 行为双重验证 |
| 研究 / 报告 Agent | 建议 + 引用 verifier | 幻觉集中在引用链 |
| 高 QPS 客服 | 谨慎 | 用小型专用 verifier 或采样验证 |

**落地 checklist：**

- [ ] 列出 Producer 产出的 artifact 类型（代码块、SQL、JSON 计划、检索摘要…）
- [ ] 为每类写 1 页「验证规范」，作为 verifier 的 policy 输入
- [ ] Verifier 模型与 Producer 模型分离，记录分歧率
- [ ] 把 `verdict.issues` 回流到 trace 系统，作为 [trace 挖掘](/portfolio/blog/agent-observability-and-evaluation) 的训练信号
- [ ] 设定最大修订轮次，防止 verifier ↔ producer 空转

## 第四条轴与本周行业信号

本周简报里，LangChain 强调 **improving agents is a data mining problem**——从 trace 挖信号、用 eval 当训练数据；Google Managed Agents 则把长任务放到 **background execution**。验证能力正好是中间的粘合剂：

- background job 跑 20 分钟，不可能全靠人盯
- verifier 把「可自动驳回的烂中间态」挡在流水线里
- 被驳回的 case 天然带标签，喂给下一轮 harness 调优

如果把预训练当「知识」，后训练当「偏好」，测试时计算当「思考时间」，那验证就是 **「质量梯度」**——告诉系统哪一步该重跑、哪一步该升级模型、哪一步该叫人。

## 总结

LLM-as-a-Verifier 不是再写一个 Judge 打分脚本，而是把 **可扩展的验证接口** 嵌进 Agent 循环。对 Walter 这类做 LangGraph / MCP 编排的开发者，最值得先试的两个点：

1. **高风险 tool call 前**加 verifier（和 Output Guard 并联）
2. **多步研究 / 编码任务**里，每步 artifact 强制过 verifier 再进 checkpoint

先从小模型 verifier 跑通闭环，再考虑把高频 failure pattern 蒸馏成规则——这比一上来堆 Judge 评测便宜，也比纯 prompt「请仔细检查」可靠。

---

*参考论文：[arXiv:2607.05391 LLM-as-a-Verifier](https://arxiv.org/abs/2607.05391)；关联本周 Agent 评测与 trace 挖掘动态。*
