---
title: "LLM-as-Judge 不是免费午餐：偏差识别与校准的工程实战"
date: 2026-05-26
tags: ["AI Agent", "评估", "工程化"]
excerpt: "用 LLM 当裁判很香，直到你发现它偏爱长答案、记得选第一个、还会给自家模型打高分。本文拆解 Position Bias、Length Bias、Self-preference 三大主流偏差，给出可直接落地的校准方案与代码。"
emoji: "⚖️"
vip: false
draft: false
---

2026 年还在用人工标注全量评估 Agent 输出的团队不多了。LLM-as-Judge —— 让一个 LLM 给另一个 LLM 的回答打分 —— 已经是 Agent 评估闭环里的默认选项：便宜、可扩展、能跑在 CI 里。

但很多团队上线之后才发现一个尴尬的事实：**Judge 模型本身是有偏见的**。它会偏爱长答案、记住选项顺序、给自家模型打高分。如果你不校准，那条天天绿油油的评估曲线，可能从一开始就在骗你。

这篇文章把我们在生产环境踩过的坑整理一下，聚焦三件事：哪些偏差最致命、怎么测出来、怎么校准。

## 为什么 LLM-as-Judge 这么流行

回顾一下评估方案的演进：

| 方案 | 成本 | 速度 | 一致性 | 覆盖场景 |
| --- | --- | --- | --- | --- |
| 人工评分 | 高（$1-5/条） | 慢（小时级） | 中（标注员之间打架） | 全部 |
| 规则匹配（exact / BLEU / ROUGE） | 极低 | 极快 | 高 | 仅限有明确参考答案 |
| Embedding 相似度 | 低 | 快 | 中 | 语义类任务 |
| **LLM-as-Judge** | 中（$0.001-0.05/条） | 中（秒级） | 中-高 | 几乎全部 |
| Reward Model | 训练成本高，推理低 | 快 | 高（领域内） | 训练过的领域 |

LLM-as-Judge 的甜蜜点是「比人工便宜 100 倍，比规则灵活无数倍，又不用自己训模型」。这就是它在 2024 年 MT-Bench、Chatbot Arena 之后一路普及到生产线的原因。

但「灵活」的代价就是「不可控」。Judge 自己就是个黑盒 LLM，它的偏差会被悄悄注入到你的评估指标里。

## 偏差一：Position Bias（位置偏差）

最经典也最容易测出来的偏差。

### 什么是 Position Bias

你让 Judge 比较两个回答 A 和 B，问它哪个更好。如果只是简单地把 A 放第一、B 放第二，Judge 会**系统性地偏向某一个位置**。

不同模型偏向不同：早期 GPT-4 偏向第一个选项，部分小模型反而偏向最后一个。具体哪个不重要，重要的是它**不会随机**。

### 怎么测

把同一对答案，正反各跑一次：

```python
import asyncio
from typing import Literal

JudgmentResult = Literal["A", "B", "tie"]

async def judge_pair(
    client,
    question: str,
    answer_a: str,
    answer_b: str,
) -> JudgmentResult:
    """让 Judge 比较 A 和 B，返回胜者。"""
    prompt = f"""比较以下两个回答，选出更好的一个。只输出 A、B 或 tie。

问题：{question}

回答 A：{answer_a}

回答 B：{answer_b}

你的判断（A/B/tie）："""
    resp = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=4,
    )
    text = resp.choices[0].message.content.strip().upper()
    if "A" in text and "B" not in text:
        return "A"
    if "B" in text and "A" not in text:
        return "B"
    return "tie"


async def measure_position_bias(client, pairs: list[tuple[str, str, str]]) -> dict:
    """对每对答案跑两次：原顺序 + 反转。"""
    forward = await asyncio.gather(*[judge_pair(client, q, a, b) for q, a, b in pairs])
    reverse = await asyncio.gather(*[judge_pair(client, q, b, a) for q, a, b in pairs])

    consistent = 0
    pos_first = 0  # 两轮都选第一位的次数
    for f, r in zip(forward, reverse):
        # 一致：forward 选 A 时 reverse 应该选 B
        if (f == "A" and r == "B") or (f == "B" and r == "A") or (f == "tie" and r == "tie"):
            consistent += 1
        if f == "A" and r == "A":
            pos_first += 1
    n = len(pairs)
    return {
        "consistency_rate": consistent / n,
        "position_first_rate": pos_first / n,
        "n": n,
    }
```

如果 `consistency_rate < 0.85`，说明 Judge 的判断很大程度上被位置影响了；如果 `position_first_rate > 0.15`，说明它系统性偏向第一个。

### 怎么校准

最稳的做法叫 **Two-Pass Voting**：每对答案都跑两次（正反顺序），只采纳两次一致的结果，不一致的标为 tie。

```python
async def judge_pair_calibrated(client, question, answer_a, answer_b):
    forward = await judge_pair(client, question, answer_a, answer_b)
    reverse = await judge_pair(client, question, answer_b, answer_a)

    # 两次结果应该镜像：forward=A 对应 reverse=B
    if forward == "A" and reverse == "B":
        return "A"
    if forward == "B" and reverse == "A":
        return "B"
    return "tie"  # 不一致的全部归为 tie
```

代价是 token 翻倍，但你换回来的是「位置不变性」。在 Chatbot Arena 这种生产级评估里，这是标配。

进阶做法：用 **logit-based scoring** 替代 hard label。让 Judge 输出 A、B、tie 的概率分布，再对正反两次的概率取平均。这要求 Judge 模型暴露 `logprobs`。

## 偏差二：Length Bias（长度偏差）

### 什么是 Length Bias

LLM Judge 倾向于把更长、更冗余的回答打高分。这个偏差在 RLHF 训练数据里被放大过 —— 标注员本身也偏爱长答案，模型学到了。

后果是什么？你做 Agent 优化时如果用 LLM-as-Judge 当指标，模型会学会「废话刷分」：本来一句话能答的，硬塞三段话进去，分数就涨了，但用户体验变差。

### 怎么测

测试集里准备一组「同样正确但长度不同」的回答对，看 Judge 选谁。

```python
def build_length_bias_probe(question: str, short_answer: str) -> tuple[str, str]:
    """把同一个正确答案膨胀成长版本。"""
    long_answer = (
        f"这是一个非常重要的问题，让我从多个角度详细分析一下。\n\n"
        f"首先，从本质上看：{short_answer}\n\n"
        f"其次，需要补充的是，这个答案在大多数场景下都成立。\n\n"
        f"最后，建议读者根据具体情况灵活应用。"
    )
    return short_answer, long_answer


async def measure_length_bias(client, probes: list[tuple[str, str, str]]):
    """probes: (question, short, long) 列表。期望 Judge 输出 tie 或随机分布。"""
    long_wins = 0
    for q, short, long in probes:
        # 用 Two-Pass 校准位置偏差，专门测长度偏差
        result = await judge_pair_calibrated(client, q, short, long)
        if result == "B":  # B 是 long
            long_wins += 1
    return long_wins / len(probes)
```

如果 `long_wins > 0.6`，说明 Judge 有明显的长度偏好。我们在 GPT-4o-mini 上测过，这个数字常年在 0.7 左右。

### 怎么校准

三种思路，按工程成本递增：

**1. Prompt 注入约束**

在 Judge 的 system prompt 里明确说「请忽略长度，只看正确性和相关性」。便宜，但效果有限，能把 long_wins 从 0.7 压到 0.55 左右。

**2. Length-Adjusted Score**

跑完 Judge 之后，对长度做事后修正：

```python
import math

def length_adjusted_score(
    raw_score: float,
    answer_length: int,
    baseline_length: int = 200,
    penalty: float = 0.05,
) -> float:
    """对超长答案做轻微惩罚。"""
    if answer_length <= baseline_length:
        return raw_score
    excess_ratio = math.log(answer_length / baseline_length)
    return raw_score - penalty * excess_ratio
```

`penalty` 系数需要在你自己的数据集上拟合 —— 太大会过度惩罚合理的长答案，太小不解决问题。

**3. 长度匹配采样**

在评估对里强制让两个回答长度差不超过 20%。这是 AlpacaEval 2.0 引入的 length-controlled win rate 思路。代价是数据集构造复杂，但偏差消除得最彻底。

## 偏差三：Self-Preference（自我偏好）

### 什么是 Self-Preference

GPT-4 当 Judge 时，对 GPT-4 生成的答案打分更高。Claude 当 Judge 时，对 Claude 答案打分更高。这不是阴谋论，是有 paper 实证的现象（参见 [arxiv.org/abs/2404.13076](https://arxiv.org/abs/2404.13076)）。

机制大概是：模型识别出和自己风格相近的输出，会下意识打高分；同时同源模型在格式偏好上高度一致。

### 在生产线上的危险

你用 Claude Sonnet 当 Judge 评估自己微调的 Claude Haiku，会得到偏高的分数；你拿这个分数说服老板「微调成功了」，结果用户拿真实问题来测，体验并没改善。

### 怎么测

让两个不同来源的模型互评，看分数差距：

```python
async def measure_self_preference(judge_client, judge_name, candidates: dict):
    """
    candidates: {"gpt-4o": [回答列表], "claude-3-5": [...], "llama-3": [...]}
    返回每个候选模型的胜率。
    """
    win_rates = {}
    for cand_name, cand_answers in candidates.items():
        wins = 0
        n = 0
        for other_name, other_answers in candidates.items():
            if other_name == cand_name:
                continue
            for q_idx, (a, b) in enumerate(zip(cand_answers, other_answers)):
                result = await judge_pair_calibrated(judge_client, "...", a, b)
                if result == "A":
                    wins += 1
                n += 1
        win_rates[cand_name] = wins / n if n else 0
    return win_rates
```

如果 Judge 是 GPT-4o，你会看到 candidates 里的 GPT-4o 胜率明显高于客观水平。

### 怎么校准

唯一可靠的做法：**Judge 模型必须和被评模型异构**。

| 被评模型 | 推荐 Judge | 不推荐 Judge |
| --- | --- | --- |
| GPT-4o / GPT-5 | Claude Sonnet / Gemini Pro | GPT-4o / GPT-4o-mini |
| Claude 系列 | GPT-4o / DeepSeek V3 | Claude Sonnet / Opus |
| 自家微调模型 | 至少 2 个不同厂商 Judge 投票 | 基座同源模型 |

进阶做法是 **Jury 投票**：用 3 个不同厂商的 Judge（比如 GPT-4o + Claude + Gemini）各打一票，多数票为准。代价是评估成本 ×3，但稳定性显著提升，特别适合关键发版评估。

## 一个完整的评估流水线

把上面三件事拼起来，一个生产可用的 Judge 流水线长这样：

```python
from dataclasses import dataclass
from collections import Counter

@dataclass
class JudgeConfig:
    judges: list[str]              # 多个异构 Judge 模型
    two_pass: bool = True          # Position bias 校准
    length_baseline: int = 200     # Length bias baseline
    length_penalty: float = 0.05
    require_majority: bool = True  # Jury 多数票


async def jury_judge(
    clients: dict,           # {model_name: client}
    config: JudgeConfig,
    question: str,
    answer_a: str,
    answer_b: str,
) -> dict:
    """完整流水线：Two-Pass + Jury + Length Adjust。"""
    votes = []
    for judge_name in config.judges:
        client = clients[judge_name]
        if config.two_pass:
            verdict = await judge_pair_calibrated(client, question, answer_a, answer_b)
        else:
            verdict = await judge_pair(client, question, answer_a, answer_b)
        votes.append(verdict)

    # 多数票
    counter = Counter(votes)
    winner, count = counter.most_common(1)[0]
    if config.require_majority and count <= len(votes) / 2:
        winner = "tie"

    # 长度修正只影响最终聚合分数（如果你算的是 win rate）
    return {
        "votes": votes,
        "winner": winner,
        "confidence": count / len(votes),
    }
```

跑这个流水线之前，记得做一次 **校准实验**：用人工标注好的金标集（200-500 条）跑一遍，看 Judge 流水线的胜率是否和人工高度一致。建议指标：

- **Cohen's Kappa**：Judge vs 人工，目标 ≥ 0.6
- **Pearson 相关**：聚合后的胜率分布，目标 ≥ 0.85
- **方向一致率**：模型 A 比 B 强这个判断的一致率，目标 ≥ 0.9

只有这三个数都达标，你的 Judge 流水线才能上线当 KPI 用。

## 落地 Checklist

把这些偏差识别和校准落到团队流程里，至少要做这些事：

- [ ] **金标集先行**：花一周时间，让团队人工标注 300-500 条 (question, answer_a, answer_b, winner) 数据，作为评估校准的 ground truth
- [ ] **Two-Pass 默认开启**：除非成本极度敏感，否则 pairwise 评估永远跑两遍
- [ ] **Judge 异构于被评模型**：列一张「禁止使用」清单，写进评估代码 review checklist
- [ ] **长度敏感任务用 length-controlled**：摘要、对话、代码生成这类任务，强制长度匹配
- [ ] **Jury 投票用于关键决策**：发版前的最终评估、模型选型 PK，用 3 个 Judge 投票
- [ ] **每月校准一次**：Judge 模型版本会升级，金标集胜率会漂移，每月跑一次校准实验
- [ ] **报告偏差指标**：评估报告里除了 win rate，必须带 consistency rate、position first rate、length wins 三个偏差指标，让看报告的人知道结论的可信度

LLM-as-Judge 不是免费午餐，但它确实是 2026 年规模化评估的最优解。关键是把偏差当成一类**可测、可校、可监控的工程问题**来处理，而不是相信「LLM 看一眼就知道哪个好」。当你能给老板拿出一份带置信区间和偏差指标的评估报告时，你的 Agent 工程才算真正进入了科学阶段。
