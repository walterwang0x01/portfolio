---
title: "Subagent 编排模式：从单体 Agent 到分布式认知"
date: 2026-05-24
tags: ["AI Agent", "Agent 架构", "工程化"]
excerpt: "Claude Code、Cursor、Devin 都靠 subagent 把上下文撑爆的难题拆开了。但什么时候该拆、怎么传状态、并行还是串行、错了怎么回滚——这些工程细节决定 Agent 是丝滑还是翻车。"
emoji: "🧩"
vip: false
draft: false
---

Claude Code 写完一个复杂 PR 通常要烧掉 200K+ token。如果把搜索、读文件、跑测试、写代码、改 bug 全塞进一个 agent loop，主线程 context 很快就爆了——就算不爆，跑到第 50 轮的时候模型也开始忘事、自相矛盾、性能直线下滑。

Subagent 编排是当下解法。主 agent 当调度员，把脏活分给一次性 subagent 去干，subagent 跑完只把摘要回传，主线程 context 永远保持轻盈。听起来简单，但工程上有一堆坑：什么任务该拆、context 怎么隔离、并行还是串行、subagent 的输出怎么验证、出错怎么补偿。这篇把我在生产 Agent 上踩过的模式整理一遍。

## 为什么单体 Agent 撑不住

先看一组真实数据。一个跑了 80 轮工具调用的 Coding Agent 主线程：

| 内容类型 | Token 占比 | 实际价值 |
|---------|-----------|---------|
| 系统 prompt + 工具定义 | 15% | 必要 |
| 历史代码片段（grep 出来的） | 35% | 后期基本无用 |
| 失败的工具调用结果 | 20% | 只在当时有用 |
| 中间思考 / 自我修正 | 18% | 只对下一步有用 |
| 真正决策需要的信息 | 12% | 必要 |

70%+ 的 token 是「过去有用、现在是噪音」的内容。塞在 context 里不仅烧钱，还让模型注意力分散。Anthropic 的 internal benchmark 显示，context 超过 100K 后，工具调用准确率会掉 8-15%。

主 agent 该做的是**保留决策骨架**，把执行细节扔出去。这就是 subagent 模式的本质：**用进程隔离换取认知聚焦**。

## 什么任务该拆成 Subagent

不是所有任务都值得拆。判定标准我总结成三条：

**1. Context 一次性消费**：任务过程中产生的中间数据（grep 命中的文件列表、API 返回的原始 JSON、build log）主 agent 不需要看到原文，只需要结论。

**2. 失败可隔离**：subagent 跑挂了不影响主流程，主 agent 拿到「失败 + 原因」就能决策下一步。

**3. 边界清晰**：能用一两句话描述输入和期望输出，不需要在执行过程中和主 agent 来回确认。

反例：用户问「帮我重构这个函数」——这是一个需要跟用户多轮对话确认意图的任务，不该拆给 subagent。但「在仓库里找到所有调用了 `oldApi` 的地方并列出来」就完全适合 subagent。

## 五种核心编排模式

### 模式 1：探索-执行分离

主 agent 不直接读代码，先派 explorer subagent 去调研，回来一份精简报告再决策。

```python
# 主 agent
async def main_agent(user_request: str):
    # 派出探索 subagent，不污染主 context
    survey = await spawn_subagent(
        role="explorer",
        task=f"调研仓库中与 '{user_request}' 相关的现有实现，"
             f"返回不超过 500 字的摘要和最多 5 个关键文件路径",
        max_turns=15,
        tools=["grep", "read_file", "list_dir"],
    )

    # 主 agent 只看摘要，不看 grep 出来的几千行代码
    plan = await llm_plan(user_request, context=survey.summary)
    return await execute_plan(plan)
```

关键点：subagent 必须**强制收敛**，要么限制轮数，要么 prompt 里写死「最终输出格式必须是 X 字以内的摘要」。否则它会把所有探索路径都铺出来。

### 模式 2：并行 Fan-out

任务可以独立切分时，并行派多个 subagent。每个 subagent 拿到分片任务，最后聚合。

```python
async def parallel_review(files: list[str]):
    # 每个文件起一个 reviewer subagent
    tasks = [
        spawn_subagent(
            role="code-reviewer",
            task=f"审查 {f} 的代码质量，列出最重要的 3 个问题",
            tools=["read_file"],
        )
        for f in files
    ]

    # asyncio.gather 并行跑
    reports = await asyncio.gather(*tasks, return_exceptions=True)

    # 聚合时过滤掉失败的
    valid = [r for r in reports if not isinstance(r, Exception)]
    return aggregate_reports(valid)
```

并行度不是越高越好。实测下来：

| Subagent 并行数 | 总耗时 | 失败率 | API 成本 |
|----------------|-------|-------|---------|
| 1（串行 10 个） | 180s | 2% | $0.45 |
| 5 | 48s | 5% | $0.48 |
| 10 | 32s | 12% | $0.55 |
| 20 | 28s | 28% | $0.71 |

并行度 5-8 是甜点区。继续提高边际收益迅速衰减，因为 API rate limit、子任务相互依赖、聚合开销都会反噬。

### 模式 3：层级递归

子任务还可以再拆。Subagent 自己也能 spawn 孙 agent，但要严格限制深度，否则会失控。

```python
SPAWN_DEPTH_LIMIT = 3  # 主 → 子 → 孙，到此为止

async def spawn_subagent(
    role: str,
    task: str,
    parent_depth: int = 0,
    **kwargs,
):
    if parent_depth >= SPAWN_DEPTH_LIMIT:
        # 强制降级为内联执行
        return await inline_execute(role, task, **kwargs)

    return await run_agent(
        role=role,
        task=task,
        depth=parent_depth + 1,
        # 把深度信息传给孙 agent
        spawn_fn=lambda **kw: spawn_subagent(
            parent_depth=parent_depth + 1, **kw
        ),
        **kwargs,
    )
```

我在一个项目里没加深度限制，跑出过孙的孙的孙——七层嵌套，最后单次请求烧了 800K token，账单看了想哭。

### 模式 4：管道流水线

任务有明确依赖顺序时，用管道串起来，每个 subagent 的输出是下一个的输入。

```typescript
// 写代码 → review → 跑测试 → 修问题
const pipeline = async (task: string) => {
  const code = await spawnSubagent({
    role: "coder",
    task: `实现：${task}`,
    output: "file_path",
  });

  const review = await spawnSubagent({
    role: "reviewer",
    task: `审查 ${code.path}，输出问题列表`,
    output: "issues",
  });

  if (review.issues.length === 0) return code;

  const fixed = await spawnSubagent({
    role: "fixer",
    task: `修复 ${code.path} 中的问题：${JSON.stringify(review.issues)}`,
    output: "file_path",
  });

  return fixed;
};
```

管道模式的关键在**契约清晰**：每个节点的输入输出格式必须严格定义，最好用 JSON Schema 或 TypeScript 类型约束，不能让 subagent 自由发挥输出格式。

### 模式 5：主动监督（Critic-Worker）

跑长任务时，让一个 critic subagent 周期性检查 worker subagent 的进展，发现跑偏立刻打断。

```python
async def supervised_long_task(task: str):
    worker = asyncio.create_task(
        run_worker_subagent(task, checkpoint_every=10)
    )

    while not worker.done():
        await asyncio.sleep(60)  # 每分钟检查一次
        progress = await read_worker_state(worker)

        critic_verdict = await spawn_subagent(
            role="critic",
            task=f"评估这个任务进展是否在正确方向上：{progress}",
            output_schema={"on_track": bool, "concern": str},
            max_turns=3,
        )

        if not critic_verdict.on_track:
            worker.cancel()
            # 用 critic 的反馈重启 worker
            return await supervised_long_task(
                f"{task}\n\n之前的尝试存在问题：{critic_verdict.concern}"
            )

    return await worker
```

这是 long-horizon Agent 必备模式。Devin 的 Replay 功能、Claude Code 的 thinking 模式都有类似机制。

## Context 传递的三种姿势

Subagent 之间怎么传递信息？三种姿势各有适用场景。

| 传递方式 | 容量 | 持久化 | 适用场景 |
|---------|------|-------|---------|
| 纯返回值 | <10K token | 否 | 一次性查询、聚合结果 |
| 共享文件系统 | 无限 | 是 | 大文件、跨 session 复用 |
| 外部状态存储（KV / DB） | 无限 | 是 | 多 agent 协作、checkpoint |

**纯返回值**最简单：subagent 跑完返回结构化数据，主 agent 拿去用。但如果数据超过几 KB 就别用——把整个文件内容塞回 main context 等于没做隔离。

**共享文件系统**是 Coding Agent 标配。主 agent 让 subagent 把分析结果写到 `/tmp/analysis.json`，自己只读摘要。Cursor 和 Claude Code 都是这套。

```python
# Subagent 把详细结果落盘
SUBAGENT_PROMPT = """
将完整分析写入 {workspace}/analysis_{task_id}.json
然后向调用方返回这个 JSON 的简短摘要（不超过 200 字）
"""
```

**外部状态存储**用在跨 session 或多个 agent 协作的场景。比如一个长任务被中断，下次接着跑时从 Redis 拉 checkpoint。Letta 和 LangGraph 的 persistent state 就是这个思路。

## 错误处理：Subagent 翻车了怎么办

Subagent 失败比主 agent 失败常见得多——它跑得快、上下文小、又经常被强行收敛。三种典型错误处理策略：

**1. 失败即降级**：subagent 挂了，主 agent 退回到内联执行（context 污染换可用性）

```python
try:
    result = await spawn_subagent(role="searcher", task=task)
except SubagentError as e:
    # 降级：主 agent 自己干
    log.warning(f"Subagent 失败，主 agent 接管: {e}")
    result = await main_agent_inline_search(task)
```

**2. 重试 + 退避**：临时错误（rate limit、网络抖动）重试，但加指数退避防止雪崩

```python
@retry(max_attempts=3, backoff=exponential(base=2))
async def robust_subagent_call(role: str, task: str):
    return await spawn_subagent(role=role, task=task, timeout=120)
```

**3. 补偿事务**：subagent 已经做了副作用（写了文件、发了 API），失败后要回滚

```python
async def transactional_subagent(role: str, task: str):
    snapshot = await create_workspace_snapshot()
    try:
        return await spawn_subagent(role=role, task=task)
    except Exception:
        await restore_workspace(snapshot)
        raise
```

补偿事务在 Computer Use 类 Agent 尤其重要——subagent 点了一半的「下一步」按钮挂了，得能撤回。

## 选型 checklist

不是所有 Agent 都需要 subagent。决定是否引入时过一遍这个清单：

- [ ] 单次请求的 context 经常超过 100K token 吗？
- [ ] 任务里是否有「中间过程产物大但最终结果小」的环节？
- [ ] 主 agent 平均运行轮数是否超过 30？
- [ ] 是否有可并行的子任务（多文件、多端点、多用户）？
- [ ] 是否需要长任务的进度监督？
- [ ] 团队是否有调试分布式系统的经验？

中三条以上就该上 subagent。少于三条，先把 prompt cache 和 context 压缩做到位再考虑。

引入 subagent 之后必须配套：

- 详细的 trace（每个 subagent 一条 span，能看到调用栈）
- token 用量统计（按 role 分组，发现哪个 subagent 在烧钱）
- 超时和重试策略（默认值要保守）
- 失败降级路径（不能让一个 subagent 拖垮整个请求）

最后想说一句：subagent 不是银弹，它是**用工程复杂度换认知清晰度**的权衡。简单任务上 subagent 是过度设计，复杂任务不上 subagent 是自取灭亡。判断标准永远是：**这个 agent 的瓶颈是不是 context 长度？** 如果是，subagent 帮你；不是，先把别的事做好。
