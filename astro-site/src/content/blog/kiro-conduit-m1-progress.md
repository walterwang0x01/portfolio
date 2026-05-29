---
title: "kiro-conduit M1.0：从 1 个 worker 到真正的并行编排，跑通了 DAG + 共享文件锁 + 串行 merge"
date: 2026-05-29
tags: ["AI Agent", "AI Coding", "工程化", "开源", "并发"]
excerpt: "上一篇做完 M0 PoC 跑通了单 task。这一周把 M1.0 的 5 件事一起落了：DAG 调度、git worktree 池、多 worker 并行、共享文件单一写者锁、串行 merge。端到端 demo 里 3 个 task 真的并行起来了，锁正确仲裁，最后 2 个分支成功 merge——第 3 个分支按设计停在了真实的文本冲突上。本文讲实现里几个值得记的工程细节。"
vip: false
draft: false
emoji: "🌊"
---

[上一篇](/posts/kiro-conduit-origin-story/) 起源故事讲完 M0 PoC 跑通了单 task：1 个 Coordinator + 1 个 Implementor + 1 个 Verifier 的最小链路。这一周把 M1.0 推完了——核心骨架的 5 件事一起落下来：

1. **DAG 调度**：解析 dag.yaml + 拓扑波次
2. **Git worktree 池**：每个 task 一个隔离工作目录
3. **多 worker 并行**：asyncio Semaphore 限并发的 worker pool
4. **共享文件单一写者锁**：两个 task 改同文件时强制串行
5. **串行 merge**：按拓扑序把成功 task 合回主分支，遇冲突停下

跑通了端到端 demo（3 个 task：1 个串行后 2 个并行），证明骨架能撑起真正的多任务工作流。本文讲实现里**几个之前写代码前没意识到、做了才学到**的工程细节。

## demo 跑出来什么样子

先放结果，后面再讲怎么做的。

`python examples/03_m1_demo.py` 用真 Kiro CLI 跑 3 个 task：

```
✓ Loaded DAG: 3 tasks, 2 phases, 1 shared file(s)

Phase 1: ParallelOrchestrator running
[orchestrator] 2 waves total: [1, 2]
[orchestrator] wave 1/2: running ['pkg-base'], skipping []
[coordinator] task=pkg-base PASSED on attempt 1
[orchestrator] wave 2/2: running ['pkg-mul', 'pkg-sub'], skipping []
[lock] task=pkg-mul acquired src/calc/__init__.py
[lock] task=pkg-mul released src/calc/__init__.py
[lock] task=pkg-sub acquired src/calc/__init__.py
[coordinator] task=pkg-mul PASSED on attempt 1
[coordinator] task=pkg-sub PASSED on attempt 1

✓ Parallel phase done in 125.5s
  ✓ pkg-base / pkg-mul / pkg-sub 全部 attempt 1 通过

Phase 2: MergeOrchestrator
✓ pkg-base 合并成功
✓ pkg-mul  合并成功
✗ pkg-sub  merge 冲突在 src/calc/__init__.py（设计行为：交人工解决）

Running pytest -q on main...
6 passed in 0.02s
```

3 个 task 一次过，125 秒；锁日志清楚显示了 pkg-mul 释放后 pkg-sub 才获取——证明并行框架下 single-writer 工作正确。最后那个 `pkg-sub` 冲突不是 bug，是 M1.0 的**设计契约**：行业共识"自动语义合并不可靠"，所以 git 文本冲突就停下交人工。

## 学到的事 1：Git worktree 的 `info/exclude` 不是 worktree-local 的

第一次跑 demo merge 全失败，错误信息是：

```
warning: Cannot merge binary files: src/calc/__pycache__/__init__.cpython-314.pyc
CONFLICT (add/add): Merge conflict in __pycache__/__init__.cpython-314.pyc
```

Verifier 跑 `pytest` 时生成了 `.pyc`，被 `git add -A` 一起 commit 了，merge 时不同分支的二进制 `.pyc` 撞车。

**第一次想当然的修法**：写每个 worktree 的 `.git/info/exclude`。我以为每个 worktree 各有一份 `info/exclude`——毕竟每个 worktree 在 base repo 的 `.git/worktrees/<name>/` 下都有自己的目录。

写完跑一遍：还是冲突。验证：

```bash
$ cd worktree-A
$ cat .git/worktrees/A/info/exclude
__pycache__/
*.pyc
$ touch foo.pyc
$ git check-ignore -v foo.pyc
(not ignored)
```

查 [git 文档](https://git-scm.com/docs/gitrepository-layout)：worktree 的 `info/exclude` **共享 base repo 的**，不是 worktree-local 的。我误读了文档结构——`.git/worktrees/<name>/` 里只有 `HEAD` / `commondir` 等 worktree 特有的元数据，不包括 `info`。

**真正的修法**：在 `git add` 时用 pathspec `:(exclude)` 直接排除：

```python
await run_git(handle.path, [
    "add", "-A", "--",
    ".",
    ":(exclude)__pycache__",
    ":(exclude)**/__pycache__",
    ":(exclude)*.pyc",
    ":(exclude)**/*.pyc",
    ":(exclude).pytest_cache",
    ":(exclude).mypy_cache",
])
```

写出来才几行，但找到这个写法用了一晚上。**任何在 worktree 里跑测试的 AI 编排器都会撞这个**——值得记下来。

## 学到的事 2：「单一写者」≠「并发安全」

M1.0 加了共享文件锁，最自然的理解是"两个 worker 不会同时写同一个文件，所以并行安全"。错。

我的 demo 里 pkg-mul 和 pkg-sub 都需要追加一行 import 到 `src/calc/__init__.py`：

- `pkg-mul`: `from src.calc.mul import mul`
- `pkg-sub`: `from src.calc.sub import sub`

锁工作完美——pkg-mul 持锁时 pkg-sub 必须等。日志清楚：

```
14:03:57 [lock] pkg-mul acquired src/calc/__init__.py
14:06:06 [lock] pkg-mul released src/calc/__init__.py
14:06:06 [lock] pkg-sub acquired src/calc/__init__.py   ← 锁释放即获取
14:07:13 [lock] pkg-sub released src/calc/__init__.py
```

写入是串行的。但**两个分支的 `__init__.py` 内容都是「在末尾加一行」**——分别加了不同的 import。merge 时 git 看到：

- main 上 `__init__.py` 是空的
- pkg-mul 分支：尾部加了 mul import
- pkg-sub 分支：尾部加了 sub import

git 不知道这两行是可以共存的"追加"——它只看到两个分支在同一个区域写了不同内容。**自动 merge 失败**，按 M1.0 设计停下交人工。

**锁解决的是「同时写」的物理冲突。语义层面的「都改了同一文件的同一区域」是另一回事。**

这正是 ARCHITECTURE.md 里 6 大模式中"模式 6 串行 merge"配合"人工 review"的原因：行业共识是 **git 检测文本冲突，语义冲突必须人来**。M1.0 老老实实遵守了这条。

那怎么从根本上避开？答案是 M1.1 要做的**接口锁定 stub-first**：

1. 派一个"接口包"task 先跑，**只**写接口 stub（`__init__.py` 里把所有需要的 import 一次性 stub 出来）
2. commit 到一个 base 分支
3. 后续并行 task **从这个 base 分支起 worktree**，看到的 `__init__.py` 是冻结的
4. 并行 task 只动各自的实现文件，不再碰 `__init__.py`

这样从设计上就没有"两个 task 都追加同一文件"的可能。M1.1 第一件事就做这个。

## 学到的事 3：worktree 不能在 run 结束就清理

M0 阶段 Coordinator 跑完一个 task 就清理 worktree——磁盘占用最小化。M1.0 把这套搬过来时立刻撞墙：

```
Phase 1: ParallelOrchestrator 跑完，所有 worktree 被清理
Phase 2: MergeOrchestrator 想 merge worktree...找不到了
```

**生命周期不匹配**。worktree 是「task 的物理身体」，不仅 Implementor 阶段要用，merge 阶段也要用——它们才有对应的 commit 可合。

修法：把 worktree 的清理时机**从 Orchestrator.run() 内部**搬出去，**让调用方决定**。`ParallelRunReport` 里多一个 `handles: dict[str, WorktreeHandle]` 字段，merge 完成后由用户显式清理。

更通用的教训：**资源生命周期跟 phase 1 绑死的 with-block 在多 phase 流水线里很容易出错**。多 phase 之间共享的资源应该用更长生命周期的 manager 持有，by-phase 的 with-block 只管本 phase 自己造的临时东西。这是从 M0 直接搬代码到 M1.0 暴露的真实设计 bug。

## 学到的事 4：测试不能依赖真 Kiro，但 git 可以

M0 写测试的时候我自豪的发现是 mock ACP server——58 个测试 1.93 秒跑完，零 token。M1.0 加了 worktree / 锁 / 并行 / merge 4 个新模块，测试套件涨到 111 个，时间还在 ~7 秒——我**没有**给 worktree / merge 写 mock。

为什么？因为 **git 是确定性的本地工具，跑起来非常快**。我的测试直接用 `subprocess` 跑 `git init` / `git add` / `git commit`，每个测试新建一个 tmp 目录、跑 5-10 个 git 命令、扫一下结果——单测耗时大约 100ms。

跟 ACP 协议比：

| 维度 | ACP（依赖 Kiro） | git（本地工具） |
|------|-----------------|----------------|
| 跑通需要登录 | 是 | 否 |
| 真调外部服务 | LLM 推理 | 文件系统 |
| 单次开销 | 秒级 | 毫秒级 |
| 行为确定性 | 含随机性 | 完全确定 |

ACP 必须 mock，git 不需要。**别为了"原则上要 mock 一切"花精力——区分哪些依赖真要 mock 才划算**。

## 学到的事 5：写"Demo 应该返回什么退出码"比想象中难

第一版 demo 退出码逻辑：「全部 merge 成功 + main 测试通过 = 0，否则 1」。结果 pkg-sub 因预期内的文本冲突停下，demo 返回 1，看起来像失败。

但**这恰好是工具工作正确的证明**——遇到不能自动合并的冲突就停下，不胡乱猜。

修了一版：「所有 task PASS + 至少 1 个 merge 成功 + main 测试通过 = 0，停在文本冲突不算失败」。

更深的反思：**演示工具的"成功"定义不能等于"end-to-end 全部走完"，要等于"展示了我承诺的能力"**。M1.0 承诺的能力是：

- ✅ 真正并行调度（实测 wave 内 2 worker 同时跑）
- ✅ 锁正确仲裁（实测 acquire/release 串行）
- ✅ 串行 merge 成功 case（实测 2/3 merge 成功）
- ✅ 冲突时停下（实测 pkg-sub 停下并报告）

**4 项都演示到了**——这就是成功。没演示的（自动语义合并）压根不在 M1.0 承诺范围内。

退出码改完后，demo 输出加了一段说明：

```
Note: merge stopped at pkg-sub due to a real text conflict.
This is the expected M1.0 behavior — automatic semantic merge is
intentionally not attempted. Resolve manually and continue.
```

把「期望行为」明确写出来，避免被误读为 bug。这种自描述对开源项目尤其重要——别人 5 秒看到输出就要能判断你的工具到底做了什么、没做什么。

## 数据对比：M0 → M1.0

| 指标 | M0 PoC | M1.0 |
|------|--------|------|
| 单元测试 | 49 | 102 |
| 集成测试 | 6 | 6 |
| pytest 总耗时 | 1.93s | ~7s |
| 源代码行数 | ~1100 | ~3000 |
| 最大并发 worker | 1 | N（demo 用 2） |
| 共享文件锁 | — | ✅ single-writer |
| 串行 merge | — | ✅ |
| 端到端 demo | 单 task | 3 task / 2 wave / 1 shared file |
| 端到端 demo 耗时 | 25s | 125s |
| ruff / mypy strict | clean | clean |

代码量翻 2.7 倍，测试翻 1.9 倍，**核心抽象从「单 task 流水线」升级到「DAG-波次-并行-锁-merge」完整工作流**。

## 接下来：M1.1

M1.0 端到端能跑，但暴露的接口锁定问题需要 M1.1 解决。M1.1 范围：

1. **接口锁定 stub-first** —— 从根本上避免"两个 task 都改同共享文件"的语义冲突
2. **Verifier Layer 3（AI 语义 review）** —— 当前只跑 lint + pytest，加一层 LLM 评审
3. **TUI dashboard** —— 实时看每个 worker 状态、锁状态、DAG 进度
4. **BYOA 模型路由** —— Coordinator 用强模型，Implementor 用便宜模型，节省 token
5. **更多锁 policy** —— append-only / coordinator-only

预估 1-2 周。最优先的是**接口锁定**——它是 kiro-conduit 跟 Conductor / Intent 等竞品的真正差异化点，行业其他工具都没显式实现。

## 仓库

- 代码：[github.com/walterwang0x01/kiro-conduit](https://github.com/walterwang0x01/kiro-conduit)
- 上一篇：[kiro-conduit 起源故事](/posts/kiro-conduit-origin-story/)

最快上手：

```bash
git clone https://github.com/walterwang0x01/kiro-conduit.git
cd kiro-conduit
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
pytest                                   # 111 个测试，~7 秒
python examples/03_m1_demo.py            # M1.0 多任务并行 demo，约 2-4 分钟
```

仍然欢迎试用 + 拍砖。pre-alpha 阶段最值钱的反馈不是 star，是真实的"我用你的工具时撞上了什么"。
