---
title: "Harness Engineering 实战：让 AI Agent 学会自主循环的五大工程实践"
date: 2026-05-07
tags: ["Harness Engineering", "AI Agent", "工程化"]
excerpt: "Prompt Engineering 教你写好一句话，Context Engineering 教你喂对一次上下文，Harness Engineering 解决的是另一个问题——让 Agent 在真实项目里持续、自主、可观测地运转起来。本文拆解 OpenAI 提出的五大实践、自主循环模式和 CI/CD 集成落地方案。"
vip: false
draft: false
---

做过 Agent 的人都遇到过一个尴尬：Demo 跑得飞起，一上真项目就垮。问题很少出在模型本身，而是出在**围绕模型的那一整套"运行时骨架"**——怎么把规范、上下文、工具、评估、反馈循环组织起来，让 Agent 不是"调用一次 LLM"，而是"持续工作在一个项目里"。

OpenAI 在 2026 年提出的 [Harness Engineering](https://openai.com/index/harness-engineering) 就是回答这个问题的方法论。如果说 Prompt Engineering 是调一句话、Context Engineering 是组织一次上下文，Harness Engineering 关心的是**整个工程骨架**——Agent 在什么规范下工作、遇到什么事件触发什么动作、用什么标准自我评估、如何形成闭环。

本文基于 [tech-learning-and-projects](https://github.com/WalterHandsome/tech-learning-and-projects) 仓库中 `16-Harness Engineering` 目录的系统化笔记，拆解五大实践、自主循环模式和 CI/CD 落地方案。

## 什么是 Harness

"Harness"（字面意思是挽具、装备）在 OpenAI 的语境里指的是**模型之外、Agent 运行所依赖的整个工程框架**：规范文档、引导规则、触发钩子、提示模板、评估脚本、反馈回路。模型是发动机，Harness 是底盘、变速箱、方向盘和仪表盘。

Anthropic 在 "Building Effective Agents" 里也用过这个词，观察是一致的：**harness 里编码的假设会随着模型进步而过时**。所以 Harness Engineering 并不是追求一次写死的复杂流水线，而是建立一个可维护、可演进、可被 Agent 自己修改的工程底座。

> Prompt → 影响一次生成
> Context → 影响一次调用
> Harness → 影响整个项目的长期协作方式

## 五大核心实践

OpenAI 的总结是五个组件，形成一个可循环系统：Specs、Steering、Hooks、Prompts、Evals。在 Kiro、Cursor、Claude Code 等 IDE Agent 里，这五件套几乎都有对应实现。

### 1. Specs（规范驱动开发）

Spec 是 Agent 做事前的"需求-设计-任务"三件套。不是写完代码再补文档，而是先把要做什么、怎么做、拆成几步写清楚，Agent 按 spec 推进。

典型目录结构：

```text
.kiro/specs/user-auth/
├── requirements.md    # 用户故事、验收标准
├── design.md          # 技术方案、接口、数据结构
└── tasks.md           # 可执行任务清单（带依赖 DAG）
```

好处很直接：**Agent 不会漂移**。没有 spec 的 Agent 是"聊到哪做到哪"，有 spec 的 Agent 每次都可以问自己"当前任务是 tasks.md 里的哪一条"。

### 2. Steering（持续引导）

Steering 是项目级的"世界观"文件——告诉 Agent 这个代码库用什么语言、什么架构、什么规范。所有会话共享，不用每次都重新说一遍。

```markdown
# .kiro/steering/project-conventions.md

- 后端 Python 3.9+ / FastAPI / SQLAlchemy 2.0 异步
- 所有新接口走清洁架构，禁止在 route 层直接写 SQL
- 测试放 tests/，命名 test_<模块>.py
- 提交信息遵循 Conventional Commits
```

Steering 解决的是 **Agent 的一致性**。没有它，同一个项目不同时间生成的代码风格完全不一样；有了它，整个仓库的 AI 产出自然收敛。

### 3. Hooks（事件钩子）

Hooks 是把 Agent 从"被动等指令"变成"主动响应事件"的关键。当文件改动、命令运行、测试失败时，自动触发预设动作。

```yaml
# .kiro/hooks/on-test-fail.yaml
trigger: post_tool_use
match: "pytest"
when: exit_code != 0
action: ask_agent
prompt: |
  pytest 失败。读取失败用例的 traceback，定位根因后修复，
  不要简单地把断言改弱。修完再跑一次。
```

有了 hooks，`lint → 自动修复 → 测试 → 失败即重试` 这样的闭环不用人盯着也能跑。这就是"自主循环"的硬件基础。

### 4. Prompts（可复用提示）

不是散落在代码注释里的零碎 prompt，而是集中管理、版本化、参数化的提示模板。

```yaml
# prompts/code-review.yaml
name: code-review
variables: [diff, conventions]
template: |
  你是资深审查员，基于以下规范审查 diff：
  规范：{conventions}
  Diff：{diff}
  输出：必须修改 / 建议修改 / 通过 三类。
```

抽出来的好处是：**prompt 变更可以 diff、可以回滚、可以 A/B 测试**，不再是"今天效果好、明天不知道为啥变差"的玄学。

### 5. Evals（自动化评估）

Agent 每次改动完，必须有可重复的评估机制告诉你"这次是变好了还是变差了"。不是跑一次看感觉，而是数值化、可追踪。

```python
# evals/code_quality_eval.py
def eval_pr(pr_diff: str) -> dict:
    return {
        "lint_pass": run_lint(pr_diff),
        "tests_pass_rate": run_tests(pr_diff),
        "coverage_delta": coverage_diff(pr_diff),
        "llm_as_judge_score": judge_with_claude(pr_diff),
    }
```

Eval 是 Harness 里最容易被跳过、但长期收益最大的一环。没有 eval，你永远不知道换了模型、改了 prompt 到底有没有变好。

## 自主循环：把五件套串起来

五个组件单独存在价值有限，真正的威力在于把它们拼成一个**自主循环（Autonomous Loop）**：

```text
┌──────────────────────────────────────────────────────┐
│                                                      │
│  Specs  ──► Agent 读任务 ──► 编码 ──► Hooks 触发评估  │
│    ▲                                      │         │
│    │                                      ▼         │
│    └─ 反馈更新 spec ◄── Evals 打分 ◄── 测试/lint     │
│                                                      │
└──────────────────────────────────────────────────────┘
```

一个最小可跑的 Python 伪实现，展示循环骨架：

```python
def autonomous_loop(spec_path: str, max_iters: int = 5):
    spec = load_spec(spec_path)
    steering = load_steering()

    for i in range(max_iters):
        task = next_pending_task(spec)
        if task is None:
            break

        # 1. 带 steering + spec 作为上下文让 Agent 执行
        result = agent.run(
            task=task,
            context={"steering": steering, "spec": spec},
            prompts=load_prompt("implement-task"),
        )

        # 2. hooks 自动触发验证
        eval_report = run_evals(result)

        # 3. eval 不过，生成修复子任务，而不是直接失败
        if not eval_report["passed"]:
            spec.add_subtask(
                parent=task,
                desc=f"修复 eval 失败：{eval_report['failures']}",
            )
            continue

        mark_completed(spec, task)

    return spec
```

注意几个细节：失败不是抛异常，而是**把失败转译成新的子任务**，让循环继续；每一轮的上下文都来自 spec + steering，保证长期一致性；循环次数有上限，防止死转。

## 和 Context Engineering 的关系

很多人会问：这和 [Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 是一回事吗？答案是：**Context Engineering 是 Harness Engineering 里管"上下文组装"的那一层**。

| 维度 | Prompt Engineering | Context Engineering | Harness Engineering |
|------|-------------------|---------------------|---------------------|
| 粒度 | 单次生成 | 单次会话 | 整个项目 |
| 关注 | 指令怎么写 | 给模型喂什么 | 整个工程怎么转 |
| 产物 | Prompt 文本 | 上下文组装策略 | Specs + Steering + Hooks + Evals |
| 生命周期 | 分钟 | 小时 | 周 / 月 |

可以这样类比：Prompt 是你给工人的一句话指令，Context 是工人桌上摊开的图纸和工具，Harness 是整个工地的管理制度——什么时候开工、谁审图、质检怎么做、出问题谁改、怎么改完再验收。

## CI/CD 集成：把 Agent 放进流水线

Harness 的终极形态是和 CI/CD 打通——Agent 不只在本地 IDE 里工作，而是真正成为流水线里的一个 worker。

```yaml
# .github/workflows/agent-loop.yml
name: Agent Autonomous Loop
on:
  schedule:
    - cron: "0 2 * * *"  # 每天凌晨跑一次
  workflow_dispatch:

jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Load harness
        run: |
          cat .kiro/steering/*.md > /tmp/steering.md
      - name: Run agent on pending specs
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: python scripts/run_agent_loop.py
      - name: Create PR if changes
        uses: peter-evans/create-pull-request@v7
        with:
          title: "chore(agent): daily autonomous iteration"
          branch: agent/auto-${{ github.run_id }}
```

这套跑起来后，仓库里有什么改进空间，Agent 每天夜里自己发 PR，人类早上来审。这是 Harness Engineering 区别于 Prompt Engineering 最本质的地方：**从"人找 Agent 干活"变成"Agent 持续自主地推动项目前进"**。

## 落地建议

不要一上来就搭全套。按这个顺序渐进接入：

1. 先写 Steering — 把项目规范固化下来，成本最低，收益立现
2. 再写 Specs — 给 Agent 明确的任务边界
3. 加 Hooks — 把重复的 `lint → fix → test` 自动化掉
4. 补 Evals — 数值化告诉自己 Agent 是不是越来越好
5. 接 CI/CD — 让循环脱离本地，7x24 持续转

每一步都能独立产生价值，不需要等全套搭完再享受红利。这也符合 Harness 的核心信条：**harness 本身也要能演进**。

从 Prompt 到 Context 再到 Harness，AI 辅助开发在做的是同一件事——把人类经验编码成 Agent 能理解和调用的工程资产。模型会继续升级，但组织这些资产的方法论，才是真正留在项目里的长期资产。
