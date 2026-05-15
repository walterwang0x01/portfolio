---
title: "Agent 设计反模式：8 个真实翻车案例与修复思路"
date: 2026-05-15
tags: ["AI Agent", "Agent 架构", "工程化"]
excerpt: "为什么 90% 的 Agent demo 上不了生产？不是模型不够强，是架构上踩了那些每次都翻车的反模式。8 个真实案例，从把 Agent 当万能锤到 prompt 越塞越长，配修复思路和落地 checklist。"
emoji: "🚧"
vip: false
draft: false
---

我过去一年 review 过几十个 Agent 项目，最大的感受是：**翻车的姿势惊人地相似**。模型从 GPT-4 换到 Claude Opus 4.5，框架从 LangChain 换到 LangGraph，但同样的坑一次一次踩进去。

这篇把高频反模式整理成 8 条，每条都有具体修复思路。读完你应该能在自己的项目里找到至少两条对得上号的。

## 反模式 1：把 Agent 当万能锤

**症状**：所有需求第一反应是"做个 Agent"。表单校验做个 Agent，定时任务做个 Agent，简单分类也做个 Agent。

**翻车现场**：某金融产品做"智能对账"。用户上传两份 Excel，Agent 应该找出差异行。技术方案是 Code Interpreter Agent + 多轮 reasoning。结果：单次对账 28 秒，准确率 91%，月成本 $8000。后来用 pandas 写了 200 行脚本，0.3 秒，准确率 100%，零成本。

**根因**：Agent 的价值在**不确定性高、规则复杂、需要自主决策**的任务。能用 if-else 写清楚的逻辑，用 LLM 是浪费。

**修复**：上 Agent 之前先过一遍这个判断：

| 任务特征                        | 用 Agent | 用代码 |
| ------------------------------- | -------- | ------ |
| 输入结构固定，规则可枚举        |          | ✅     |
| 需要理解自然语言意图            | ✅       |        |
| 操作步骤动态，依赖中间结果      | ✅       |        |
| 高吞吐、低延迟、成本敏感        |          | ✅     |
| 需要"判断"而非"匹配"            | ✅       |        |

> 一个工程化口诀：**能用规则就别用 LLM，能用单次 LLM 就别上 Agent，能用 ReAct 就别上多 Agent**。

## 反模式 2：System Prompt 越塞越长

**症状**：每次出 bad case 就往 system prompt 里加一条规则。三个月后 prompt 长到 6000 token，新加的规则和老规则互相打架。

**翻车现场**：某客服 Agent 的 prompt 里同时存在「遇到投诉立即转人工」和「优先尝试自助解决用户问题」。模型在两条规则之间反复横跳，用户体验崩坏。

**根因**：Prompt 不是日志文件，不能只追加不重构。规则数量到 15 条以上，LLM 的 instruction following 能力会显著下降，尤其是 Sonnet 级以下模型。

**修复**：

1. 规则达到 10 条时强制重构，分组+优先级排序
2. 互斥规则用条件分支表达（"如果 X 则 A，否则 B"），不要写成两条独立指令
3. 把"动态规则"从 prompt 拆出来，做成工具或 RAG 召回
4. 对每条规则写一个 eval case，删除规则前先跑一遍，确认确实无用

```python
# 反例：规则全堆在 system 里
SYSTEM = """
你是客服助手。规则：
1. 遇到投诉立即转人工
2. 优先自助解决
3. 不要承诺退款
4. 退款审批走 refund_tool
5. ...（再 30 条）
"""

# 正例：规则模块化
SYSTEM = """
你是客服助手。流程：
1. 先用 classify_intent 判断意图类别
2. 根据返回的 playbook_id 调 get_playbook 拿到当前场景的处理流程
3. 严格按 playbook 执行
"""
```

## 反模式 3：盲目追求多 Agent

**症状**：看了 CrewAI / AutoGen 的 demo，立刻把单个 Agent 拆成 Planner + Researcher + Writer + Reviewer 四个角色，期待"协作产生奇迹"。

**翻车现场**：某 SEO 内容生成产品。四 Agent 协作写一篇 800 字稿子，平均耗时 4 分钟、成本 $0.6。换成单 Agent + 结构化输出，35 秒、$0.05，质量评分还高了 8%。

**根因**：多 Agent 的代价是**通信开销**和**误差累积**。每多一次 Agent 间对话就多一次幻觉机会，上下文也在 Agent 之间被压缩、改写、丢失。多 Agent 真正适用的场景非常有限：长任务、需要并行、需要不同权限边界。

**修复**：拆 Agent 之前问三个问题：

- 这些子任务能在单个 prompt 里讲清楚吗？能就别拆
- 子任务之间是顺序还是并行？顺序的优先用 chain of thought
- 拆出去的 Agent 需要独立的工具集或权限吗？不需要就别拆

更系统的判断方法见之前那篇《[多 Agent 架构模式](./multi-agent-architecture-patterns)》。

## 反模式 4：Tool 失败被默默吞掉

**症状**：工具调用 try/except 一把抓，return `"操作完成"`。LLM 拿到这个返回继续往下推理，最后给用户一个"已为您安排"的假象。

**翻车现场**：某行程助手 Agent 的订机票工具因为支付网关超时失败，但被 catch 后返回了 "booking confirmed"。用户到机场才发现没票。

**根因**：LLM 完全相信工具返回的内容。一旦给它假成功信号，整个推理链都是错的，且非常难追溯。

**修复**：

```python
# 反例
def book_flight(...):
    try:
        result = airline_api.book(...)
        return "预订成功"
    except Exception:
        return "预订成功"  # 灾难

# 正例：明确区分成功 / 失败 / 不确定
def book_flight(...) -> dict:
    try:
        result = airline_api.book(...)
        return {
            "status": "success",
            "booking_id": result.id,
            "details": result.summary,
        }
    except PaymentTimeout as e:
        return {
            "status": "uncertain",
            "error": "支付网关超时，订单状态未确认",
            "next_action": "调用 check_booking 验证状态，不要重复下单",
        }
    except Exception as e:
        return {"status": "failed", "error": str(e)}
```

工具的返回值就是 Agent 的现实。**让现实保持真实**。

## 反模式 5：上下文无限增长

**症状**：每轮把所有历史消息原样塞回去，第 20 轮上下文已经 80k token，模型既慢又贵且开始遗忘早期信息。

**翻车现场**：某编程 Agent 在长任务里第 15 轮开始忘记最初的需求，开始反复改同一个文件。账单同比多了 6 倍。

**根因**：Naive 的「append-only history」是早期 demo 的偷懒做法。生产 Agent 必须有上下文管理策略。

**修复**（按工程量从低到高）：

1. **滑动窗口 + 摘要**：保留最近 N 轮原文，更早的轮次摘要为 1-2 句
2. **结构化记忆**：把"事实"（用户偏好、已确认的信息）抽到 memory，不放在历史里
3. **Tool 结果裁剪**：长 tool 返回（如全文搜索结果）只保留摘要 + 引用 ID，需要细节时再调 fetch
4. **Token 预算硬约束**：超过阈值强制压缩，不是"等到崩了再说"

参考之前那篇《[Context Engineering 完全指南](./context-engineering-guide)》。

## 反模式 6：用 Opus 调度 Opus

**症状**：Planner 用 Opus，每个子 Agent 也用 Opus，做的还是抓 URL、解析 JSON 这种低门槛任务。

**翻车现场**：某研究 Agent 跑一次 deep research 烧 $4，其中 70% 的 token 花在子 Agent 调 search、fetch、extract 这些不需要 reasoning 的步骤。

**根因**：好钢用在刀刃上的反面。Planner 需要 reasoning，叶子节点不需要。

**修复**：分层模型选型。

| 角色            | 推荐模型               | 理由                  |
| --------------- | ---------------------- | --------------------- |
| Planner / Critic | Opus / Sonnet 4.5      | 需要复杂规划和反思    |
| Worker / Tool 调用 | Haiku 4.5 / GPT-4.1 mini | 任务明确、追求速度     |
| 分类 / 路由     | Haiku 4.5 / DeepSeek V3 | 极致便宜，准确率够用  |
| 嵌入 / 摘要     | 专用 embedding / 小模型 | 不需要通用模型        |

具体落地见《[Agent 成本工程](./agent-cost-engineering)》。

## 反模式 7：没有降级路径

**症状**：模型 API 一抖动整个产品就挂。Anthropic 限流了，整个 Agent 不可用。

**翻车现场**：某 to C 产品依赖 Claude，去年 12 月底 Anthropic 几次 region 限流，产品 SLA 直接破线，被用户在社交媒体挂了一周。

**根因**：把唯一外部依赖当成基础设施。

**修复**：

- 至少接两家 LLM 供应商，主备切换在 Gateway 层做
- 关键路径准备「无 LLM 兜底」：拿不到模型回复时，能给一个保守的规则化回答
- 工具调用同样要有降级：搜索 API 挂了就用本地索引、缓存的旧结果
- 演练：每月主动断一次主供应商，验证降级路径真的能跑

## 反模式 8：没有 Eval 就上线

**症状**：上线靠"我自己试了几个 case 都对"，发版靠"模型升级了肯定更好"。出了问题没法定位是哪个改动引入的。

**翻车现场**：某 Agent 升级 prompt 后准确率从 88% 掉到 71%，两周后才被用户投诉发现。回滚时已经叠加了 3 次 commit，定位用了一整天。

**根因**：把 Agent 当成"写完就行"的代码，而不是"持续验证"的系统。

**修复**：上线前最低门槛是这套：

```python
# 一个最小可用 eval 框架
TEST_CASES = [
    {"input": "...", "expected_tools": ["search", "summarize"], "expected_answer_contains": [...]},
    # 50-200 条覆盖典型场景的 case
]

def evaluate(agent, cases):
    metrics = {"correct": 0, "tool_match": 0, "p95_latency": 0, "avg_cost": 0}
    for case in cases:
        result = agent.run(case["input"])
        # 评估工具调用、最终答案、延迟、成本
        ...
    return metrics

# CI 里跑：每次 prompt 或代码改动都执行
```

工具选型：开源的 [Promptfoo](https://www.promptfoo.dev/)、[Langfuse](https://langfuse.com/)，商业的 Braintrust、Arize Phoenix。具体方法论见《[Agent 可观测性与评估](./agent-observability-and-evaluation)》。

## 反模式速查表

| 反模式             | 代价                | 修复优先级 |
| ------------------ | ------------------- | ---------- |
| Agent 当万能锤     | 成本 10-100 倍      | P0         |
| Prompt 无限追加    | 准确率持续下降      | P0         |
| 盲目多 Agent       | 延迟和成本翻倍      | P1         |
| Tool 失败吞掉      | 用户信任崩盘        | P0         |
| 上下文无限增长     | 慢、贵、健忘        | P0         |
| Opus 调 Opus       | 成本浪费 50%+       | P1         |
| 无降级路径         | 单点故障            | P1         |
| 无 Eval 上线       | 回归无感知          | P0         |

## 上线前 Checklist

最后给一份可以直接贴进 PR 模板的 checklist：

- [ ] 这个需求**真的**需要 Agent 吗？规则方案对比过了吗？
- [ ] System prompt 是否结构化、是否定期重构？
- [ ] 是否每个工具都明确区分 success / uncertain / failed？
- [ ] 是否有上下文管理策略（窗口、摘要、记忆抽取）？
- [ ] 是否分层模型选型（Planner 大、Worker 小）？
- [ ] 是否有降级路径（备用模型、规则兜底）？
- [ ] 是否有 ≥50 条覆盖典型场景的 eval case？
- [ ] 是否有线上观测（trace、token、错误率）？

> 大多数 Agent 项目失败不是输给了模型，而是输给了这些每次都不做、每次都翻车的工程基础。先把反模式清干净，再谈智能。
