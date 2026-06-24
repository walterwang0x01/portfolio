---
title: "Eval-Driven Development：用评估驱动 AI Agent 开发"
date: 2025-06-24
tags: ["AI Agent", "评估", "工程化"]
excerpt: "当传统单元测试无法覆盖 LLM 的非确定性输出时，Eval-Driven Development 提供了一套以评估用例为核心驱动力的开发方法论——让每次 prompt 修改都有量化反馈，让 Agent 质量回归可追溯。"
emoji: "📐"
vip: false
draft: false
---

## 为什么需要 Eval-Driven Development

传统软件开发有 TDD（测试驱动开发）：写测试 → 写代码 → 测试通过。但 AI Agent 的输出是非确定性的——同一个 prompt，不同时刻的响应可能不同。这让经典的 `assertEqual` 失效了。

Eval-Driven Development（EDD）的核心思想是：**把评估用例当作开发的第一等公民**。每次改 prompt、换模型、调参数之前，先定义「什么算好」，再改代码，最后用 eval 套件量化验证。

这不是"上线后做评估"，而是**开发循环内置评估**——类似于 TDD 之于代码，EDD 之于 Agent。

## EDD 与传统方法的对比

| 维度 | TDD（传统软件） | 事后评估 | Eval-Driven Development |
|------|------|------|------|
| 评估时机 | 开发中 | 上线后 | 开发中 |
| 覆盖对象 | 确定性逻辑 | LLM 输出 | LLM 输出 |
| 反馈速度 | 秒级 | 天级 | 分钟级 |
| 驱动力 | 测试用例 | 线上指标 | Eval 用例集 |
| 回归检测 | ✅ 精确 | ❌ 滞后 | ✅ 量化 |

## 核心工作流

EDD 的开发循环分为四步：

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ 1. 定义 Eval │────▶│ 2. 改 Prompt │────▶│ 3. 跑 Eval  │────▶│ 4. 对比基线 │
│    用例集    │     │   /模型/参数  │     │   Suite     │     │   决策合并  │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
       ▲                                                            │
       └────────────────────────────────────────────────────────────┘
```

## 实战：构建一个 Eval 套件

以一个客服 Agent 为例，我们用 Python 构建最小 EDD 框架：

```python
# eval_suite.py
import json
import asyncio
from dataclasses import dataclass
from openai import AsyncOpenAI

@dataclass
class EvalCase:
    """一条评估用例"""
    input: str           # 用户输入
    criteria: list[str]  # 评估标准（自然语言描述）
    tags: list[str] = None

@dataclass 
class EvalResult:
    case: EvalCase
    output: str
    scores: dict[str, float]  # criteria -> 0.0~1.0
    passed: bool

# 评估用例集——开发前先写好
EVAL_CASES = [
    EvalCase(
        input="我的订单 #12345 到哪了？",
        criteria=[
            "回复中包含查询订单状态的具体动作",
            "语气礼貌且专业",
            "没有编造物流信息",
        ],
        tags=["order-query"],
    ),
    EvalCase(
        input="你们这个产品是垃圾",
        criteria=[
            "不与用户对骂",
            "表达理解和歉意",
            "引导用户描述具体问题",
        ],
        tags=["complaint"],
    ),
]

async def judge(output: str, criteria: list[str], client: AsyncOpenAI) -> dict[str, float]:
    """LLM-as-Judge 打分"""
    prompt = f"""你是一个严格的评估专家。根据以下标准对 AI 回复评分。
    
AI 回复：
{output}

评分标准（每条 0-1 分）：
{json.dumps(criteria, ensure_ascii=False)}

返回 JSON：{{"scores": [0.0~1.0, ...]}}"""
    
    resp = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
    )
    data = json.loads(resp.choices[0].message.content)
    return {c: s for c, s in zip(criteria, data["scores"])}

async def run_eval(agent_fn, cases: list[EvalCase], threshold: float = 0.7):
    """运行完整 eval 套件"""
    client = AsyncOpenAI()
    results = []
    
    for case in cases:
        output = await agent_fn(case.input)
        scores = await judge(output, case.criteria, client)
        avg_score = sum(scores.values()) / len(scores)
        results.append(EvalResult(
            case=case, output=output,
            scores=scores, passed=avg_score >= threshold,
        ))
    
    passed = sum(1 for r in results if r.passed)
    print(f"\n{'='*50}")
    print(f"Eval Results: {passed}/{len(results)} passed (threshold={threshold})")
    for r in results:
        status = "✅" if r.passed else "❌"
        avg = sum(r.scores.values()) / len(r.scores)
        print(f"  {status} [{avg:.2f}] {r.case.input[:30]}...")
    
    return results
```

## 集成到开发流程

关键是让 eval 跑得足够快，快到能嵌入日常开发循环：

```python
# run_evals.py — 开发时直接跑
import asyncio
from eval_suite import EVAL_CASES, run_eval
from my_agent import handle_message  # 你的 Agent 入口

async def main():
    results = await run_eval(handle_message, EVAL_CASES)
    
    # 生成对比报告
    failed = [r for r in results if not r.passed]
    if failed:
        print("\n⚠️  以下用例未通过：")
        for r in failed:
            print(f"  输入: {r.case.input}")
            print(f"  输出: {r.output[:100]}...")
            for criterion, score in r.scores.items():
                if score < 0.7:
                    print(f"    ❌ {criterion}: {score:.2f}")
        exit(1)  # CI 中作为门禁

if __name__ == "__main__":
    asyncio.run(main())
```

在 CI/CD 中配置为门禁：

```yaml
# .github/workflows/eval-gate.yml
name: Eval Gate
on:
  pull_request:
    paths: ["prompts/**", "agent/**"]

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements.txt
      - run: python run_evals.py
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Eval 用例的设计原则

写好 eval 用例是 EDD 成败的关键。几条实践原则：

**1. 分层设计**

```
Level 1: 安全性（不泄露隐私、不输出有害内容）
Level 2: 正确性（回答是否准确、是否调用了正确工具）
Level 3: 质量（语气、格式、简洁度）
```

**2. 从真实失败中沉淀**

每次线上发现 bad case，立刻加入 eval 套件。这是最有价值的用例来源。

**3. 覆盖边界而非铺量**

50 条覆盖关键边界的 eval，远胜 500 条重复场景。重点覆盖：
- 对抗性输入（prompt injection 尝试）
- 边界 case（空输入、超长输入、多语言混杂）
- 模型容易犯错的场景（数字计算、日期推理）

## 工具链选型

| 工具 | 定位 | 适用场景 |
|------|------|------|
| Braintrust | 端到端 eval 平台 | 团队协作、版本对比、在线 playground |
| Promptfoo | CLI 优先的 eval 工具 | 本地开发、CI 集成、多模型对比 |
| DeepEval | Python SDK | pytest 风格集成、自定义 metric |
| LangSmith | 观测 + eval | 已用 LangChain 的团队 |
| 自建（如上文） | 轻量灵活 | 早期项目、定制需求强 |

**选型建议**：早期用 Promptfoo 或自建（快速迭代），团队 >3 人后迁移到 Braintrust 获得协作和版本管理能力。

## 常见陷阱

**陷阱 1：Eval 太慢，开发者不愿跑**

解法：分级——快速 eval（10 条核心用例，<30s）日常跑，完整 eval（200+ 条）CI 跑。

**陷阱 2：LLM-as-Judge 自身不稳定**

解法：对 judge 的 prompt 也做 eval（meta-eval），固定 judge 模型版本，设置 temperature=0。

**陷阱 3：分数高但用户体验差**

解法：定期用真实用户反馈校准 eval 标准，把 NPS/CSAT 变化反映到 criteria 权重中。

## 落地 Checklist

- [ ] 在写/改 prompt 之前，先写至少 5 条 eval 用例
- [ ] Eval 套件分快/慢两档：快档 <30s 本地跑，慢档 CI 跑
- [ ] 每条 eval 用例有明确的评分标准（criteria），不是模糊的"回答好"
- [ ] PR 涉及 prompt 变更时，CI 自动跑 eval 并在 PR comment 中贴分数对比
- [ ] 线上 bad case 48h 内沉淀为 eval 用例
- [ ] Judge prompt 每月 review 一次，确保评分标准与业务目标对齐
- [ ] 维护 eval 分数基线，任何合并不允许低于基线 5% 以上

## 结语

EDD 不是银弹，但它解决了 AI Agent 开发中最痛的问题：**改了 prompt 不知道有没有变好**。把评估从"上线后才看"前移到"开发中就跑"，你会发现 Agent 的迭代速度和质量稳定性同时提升。

从今天开始，下次改 prompt 之前，先问自己：我的 eval 用例准备好了吗？
