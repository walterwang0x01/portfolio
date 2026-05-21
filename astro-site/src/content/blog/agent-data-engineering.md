---
title: "Agent 数据工程：训练数据的收集、合成与质量评估"
date: 2026-05-21
tags: ["AI Agent", "数据工程", "工程化"]
excerpt: "2026 年自托管 Agent 起势，瓶颈从「调哪个 API」变成「训练数据从哪来」。本文拆 Agent 数据工程的三段流水线——线上轨迹回收、合成数据构造、质量分级评估，给一套能跑的代码骨架与决策矩阵。"
vip: false
draft: false
emoji: "🗂️"
---

2026 年做 Agent，团队的分化越来越明显。一类继续靠 Claude / GPT API 跑业务，钱花在 token 上；另一类开始把核心场景往自托管模型迁——Qwen3、DeepSeek-V3、Llama 4 这一波开源模型在工具调用上已经够用，蒸馏 + 量化后单卡能跑，长期算下来比 API 便宜一个数量级。

从「调 API」转「训自己的模型」，最先撞上的不是 GPU，是数据。一个能用的 Agent 模型，背后至少要 5 万到 50 万条高质量轨迹（trajectory），覆盖工具调用、错误恢复、多步规划。这些数据从哪来？合成数据怎么避免崩塌？怎么判断哪条轨迹能进训练集？

这不是 prompt engineering，是 **Agent 数据工程**。本文拆三段流水线：线上轨迹回收、合成数据构造、质量分级评估，给出能跑的代码骨架。

## 为什么 Agent 数据比 LLM 数据更难

通用 LLM 的训练数据是「问答对」或「文本块」，Agent 的训练数据是「轨迹」——一次任务从开始到结束的完整事件序列：

```
user_query → think → tool_call → tool_result → think → tool_call → ... → final_answer
```

一条轨迹可能几十步，token 数从几百到几十万不等。质量差的数据不是简单的「错别字」，而是：

- 工具调用参数对了但语义错了（查了订单 A 的状态，用户问的是订单 B）
- 中间步骤都对，最后一步给出错误结论
- 任务本身没意义（合成数据生成器编了个「查询 1992 年某不存在用户」的需求）
- 风格污染（Claude 生成的轨迹拿去训 Qwen，会把 Claude 的口癖学过来）

这些问题在通用文本数据里几乎不存在。Agent 数据工程的核心难点，就是用工程手段把这些隐性缺陷过滤掉。

## 第一段：线上轨迹回收

最高质量的数据来源永远是真实流量。但直接把生产日志拿来训练有几个坑：

- **PII 泄漏**：用户输入、工具返回值经常带手机号、邮箱、订单号
- **失败轨迹混入**：用户中途退出、工具超时、Agent 卡死的轨迹会污染数据
- **正例稀疏**：成功轨迹只占 30-40%，直接训会让模型对失败模式过拟合

回收流水线的最小骨架：

```python
from dataclasses import dataclass
from typing import Literal
import hashlib

@dataclass
class TrajectoryEvent:
    role: Literal["user", "assistant", "tool"]
    content: str
    tool_name: str | None = None
    tool_args: dict | None = None
    timestamp: float = 0.0

@dataclass
class Trajectory:
    session_id: str
    events: list[TrajectoryEvent]
    outcome: Literal["success", "failure", "abandoned"]
    user_feedback: int | None = None  # 1-5 评分


def collect_trajectory(session_id: str, raw_events: list[dict]) -> Trajectory | None:
    """从原始日志构造轨迹，已脱敏 + 已判定 outcome"""
    events = [
        TrajectoryEvent(
            role=e["role"],
            content=redact_pii(e["content"]),
            tool_name=e.get("tool_name"),
            tool_args=redact_args(e.get("tool_args", {})),
            timestamp=e["ts"],
        )
        for e in raw_events
    ]
    outcome = infer_outcome(events)
    if outcome == "abandoned":
        return None  # 用户中途离开的轨迹直接丢
    return Trajectory(session_id, events, outcome)


def redact_pii(text: str) -> str:
    """正则 + NER 双重脱敏"""
    text = PHONE_PATTERN.sub("<PHONE>", text)
    text = EMAIL_PATTERN.sub("<EMAIL>", text)
    text = ID_CARD_PATTERN.sub("<ID>", text)
    # NER 兜底人名、地址
    return ner_redact(text)
```

实际工程中还要加：

- **采样策略**：成功轨迹按概率下采样到 60%，失败轨迹全留（失败模式更稀缺）
- **去重**：按工具调用序列的 hash 去重，避免同一类查询占满数据集
- **隐私分级**：高敏感渠道（金融、医疗）的轨迹必须经过人工抽检才能入训练集

回收阶段一般能拿到 20%-40% 可用率，剩下的要靠合成补足。

## 第二段：合成数据的三种范式

合成数据是 2026 年 Agent 训练的主力。但用得不好会引发**模式崩塌**——模型学到了合成数据的统计特征，而非真实任务的分布。三种主流范式各有适用场景：

| 范式 | 做法 | 适合场景 | 主要风险 |
|------|------|----------|----------|
| **教师蒸馏** | 用 Claude / GPT 跑真实任务，记录轨迹作为监督信号 | 已有强模型解决该任务 | 风格污染、成本高 |
| **自博弈（Self-Play）** | 一个 LLM 扮演用户，一个扮演 Agent，互相博弈 | 对话型 Agent、谈判类任务 | 容易陷入低质循环 |
| **任务模板扩展** | 人工写种子任务，用 LLM 改写参数与情境 | 工具调用密集型任务 | 多样性受种子限制 |

教师蒸馏是最常见的起点。下面是一个能跑的最小版本：

```python
from anthropic import Anthropic

client = Anthropic()

async def distill_trajectory(task: str, tools: list[dict]) -> Trajectory:
    """让 Claude 跑一遍任务，记录全过程作为训练轨迹"""
    messages = [{"role": "user", "content": task}]
    events = [TrajectoryEvent("user", task)]

    while True:
        resp = await client.messages.create(
            model="claude-opus-4-5",
            tools=tools,
            messages=messages,
            max_tokens=4096,
        )
        events.append(TrajectoryEvent(
            "assistant",
            content=extract_text(resp),
            tool_name=extract_tool(resp),
            tool_args=extract_args(resp),
        ))
        if resp.stop_reason == "end_turn":
            return Trajectory("synth-" + uuid4().hex, events, "success")

        # 执行工具，把结果塞回去
        tool_result = await run_tool(resp)
        events.append(TrajectoryEvent("tool", str(tool_result)))
        messages.extend(build_next_messages(resp, tool_result))
```

防止风格污染的关键是 **rewriting pass**：拿到教师模型生成的轨迹后，用一个轻量改写步骤把口癖、签名短语、过度礼貌的句式去掉，再喂给学生模型训练。这一步很多团队会跳过，结果训出来的 Qwen 张口就是 "I'd be happy to help you with that"。

## 第三段：质量分级与评估

数据回收和合成完，下一关是**分级**。不是所有轨迹都该进训练集，更不是所有轨迹该一视同仁。生产里我们用四档分级：

```python
from enum import IntEnum

class TrajectoryGrade(IntEnum):
    GOLD = 4    # 人工标注 + 多模型一致认可，用于 SFT 高质量子集
    SILVER = 3  # 自动评估通过 + 用户高评分，用于主 SFT
    BRONZE = 2  # 自动评估通过，用于 continued pretraining
    REJECT = 1  # 不进训练集


def grade_trajectory(t: Trajectory, judges: list[Judge]) -> TrajectoryGrade:
    if t.outcome == "failure":
        return TrajectoryGrade.REJECT

    # 多 judge 投票
    scores = [j.score(t) for j in judges]
    avg = sum(scores) / len(scores)
    consensus = max(scores) - min(scores) < 1.0  # 评分一致性

    if avg >= 4.5 and consensus and (t.user_feedback or 0) >= 4:
        return TrajectoryGrade.GOLD
    if avg >= 4.0 and consensus:
        return TrajectoryGrade.SILVER
    if avg >= 3.0:
        return TrajectoryGrade.BRONZE
    return TrajectoryGrade.REJECT
```

Judge 的实现有几种选择：

- **Rule-based**：检查工具调用是否合法、参数 schema 是否匹配、最终回复是否包含用户问题的关键实体
- **LLM-as-judge**：用更大的模型（如 Claude Opus）对轨迹打分，prompt 里给清楚的评分标准
- **Reward Model**：训一个专门的奖励模型，对轨迹打 0-1 分，吞吐量比 LLM judge 高一个数量级

> 关键经验：单一 judge 容易被骗。LLM judge 偏爱长回复，rule-based 抓不到语义错误，reward model 在分布外样本上不稳定。**至少两个不同范式的 judge 投票**，才能把质量评估的方差压下去。

## 一个常被忽略的环节：数据漂移监测

训练集准备好不是终点。线上分布会持续漂移——新工具上线、用户问法变化、外部 API schema 调整，都会让训练-推理分布偏离。生产里要建一个轻量的漂移监测：

```python
def detect_drift(prod_traj: list[Trajectory], train_traj: list[Trajectory]) -> dict:
    """对比生产流量和训练集的工具调用分布"""
    prod_dist = tool_call_distribution(prod_traj)
    train_dist = tool_call_distribution(train_traj)
    return {
        "kl_divergence": kl_div(prod_dist, train_dist),
        "new_tools": set(prod_dist) - set(train_dist),
        "deprecated_tools": set(train_dist) - set(prod_dist),
    }
```

KL 散度超过 0.3、或出现训练集里没有的新工具，就该触发数据补采和增量训练。很多团队第一次部署后效果好，三个月后悄悄退化，根因都是漂移没监测。

## 落地 checklist

把上面的内容浓缩成一个能直接用的清单：

- [ ] 生产日志接入轨迹回收管道，PII 脱敏在写入前完成
- [ ] outcome 标注规则明确：success / failure / abandoned 各走不同分支
- [ ] 合成数据有 rewriting pass，去除教师模型的风格特征
- [ ] 至少两类 judge 交叉打分，不依赖单一评估器
- [ ] 训练集分四档管理，GOLD / SILVER 用于 SFT，BRONZE 仅用于继续预训练
- [ ] 上线后建立工具调用分布的漂移监测，KL > 0.3 触发增量补采
- [ ] 每个数据集版本可追溯：sha + 来源比例 + 评估指标进 metadata

## 选型建议

| 团队规模 | 推荐路径 |
|---------|---------|
| 1-5 人，PoC 阶段 | 跳过自托管，先用 API + Prompt Cache 控成本 |
| 5-20 人，稳定业务 | 教师蒸馏起步，攒 1 万条轨迹后做 LoRA 微调 |
| 20+ 人，规模化场景 | 全流水线建设：回收 + 合成 + 分级 + 漂移监测 |

Agent 数据工程的本质是把 ML 团队过去十年的数据管线方法，重新套到「轨迹」这种新数据形态上。技术不新，难在工程闭环——能不能让回收、合成、评估、漂移监测每一步都可观测、可回滚、可复现。这件事做扎实了，自托管 Agent 才真正变成生产力工具，而不是 demo。
