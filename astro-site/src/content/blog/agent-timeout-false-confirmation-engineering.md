---
title: "Agent 超时假确认：别把半截 stdout 写成「已验证」"
date: 2026-07-16
tags: ["AI Agent", "Context Engineering", "工程化"]
excerpt: "会话压缩后，被 kill 的命令（exit 143）的部分输出常被摘要成「已确认」。本文拆解假确认语义陷阱，给出观测/事实分层、强制复验与 harness 防护代码。"
emoji: "🪤"
vip: false
draft: false
---

长会话 Agent 几乎都会做 context compaction：把几十轮工具调用压成一段摘要，好继续往下跑。2026-07 一篇 arXiv 记录把这件事推到台前——Claude Code 一类 agentic 编码工具里，**被 SIGTERM/超时杀掉的命令（常见 exit 143）的半截 stdout，经压缩后会变成「命令已成功、结果已确认」**，再跨会话、跨模型版本传播，且不再复验。

这和「怎么压上下文更省钱」不是同一类问题。后者关心信息密度与 Prompt Cache；前者关心 **证据等级**：你写入摘要的，到底是「观察到的片段」，还是「验证过的事实」。

> 假确认的本质：把「我看到过一段看起来像成功的输出」升格成「系统已证明该步骤完成」。

## 假确认是怎么长出来的

典型链路并不神秘：

1. Agent 跑 `pytest` / `npm test` / `terraform apply`，设了硬超时（比如 120s）。
2. 进程被 kill，exit code 非零，但 stdout 里已经刷出了 `OK`、`PASS`、`Apply complete` 之类中间行。
3. Compactor（或 summarizer）按「文本表面」写摘要：`测试已通过` / `用户已确认部署`。
4. 下一轮、甚至下一次会话，模型只看见摘要，把它当 ground truth，继续改代码、合 PR、发生产。

关键点在第 3 步：**压缩器通常没有 exit code / signal / 超时标记的一等字段**，只吃自然语言 transcript。半截成功日志 + 缺失的失败元数据 = 语义升格。

这和 HITL 里「审批超时默认拒绝」正好相反——HITL 超时走安全默认；假确认是 **把失败路径误标成成功路径**。

## 为什么比普通「压缩丢信息」更危险

普通 compaction 丢细节，最多让模型多问一轮或重读文件；假确认会让模型 **少做关键动作**。少做验证、少跑测试、少等人审——这恰好是生产事故的配方。

几个高频场景：

- **测试半截通过**：单元测试前 80 个 PASS 后卡住，摘要写成「测试套件已通过」，Agent 直接提 PR。
- **基础设施半截 apply**：Terraform/Ansible 打出 `Apply complete` 风格中间态后超时，摘要写成「环境已就绪」，后续步骤对着半残状态继续写。
- **把「无用户回复」写成「用户已确认」**：超时等待人审时，压缩器把空槽位叙事成默认同意——这是 HITL 与 compaction 的交叉翻车。
- **跨模型接力**：会话 A 用强模型跑出假确认摘要，会话 B 用小模型只读摘要，错误被「洗白」成不可质疑的历史。

> 压缩降低的是 token，不该降低证据等级。等级一旦塌陷，后面所有路由、重试、审批都在错误事实上运转。

## 三类证据，不要混写进同一层摘要

落地时先强制拆三层，压缩只能动最上层：

| 证据等级 | 含义 | 能否写入 compaction 摘要 | 典型来源 |
|---------|------|-------------------------|---------|
| L0 观测片段 | 某时刻 stdout/stderr 里出现过这些字 | 可以，但必须标 `observed` | 流式日志切片 |
| L1 终止事实 | 进程如何结束（exit / signal / timeout） | **必须原样保留，禁止改写** | harness 捕获的 `Terminated` |
| L2 验证结论 | 业务上认定「通过 / 失败 / 需复跑」 | 仅当 L1 成功且校验器通过 | 退出码 + 断言 / 再跑结果 |

假确认几乎都是 **L0 被写成了 L2**。防护原则一句话：摘要可以复述观测，不能替终止事实做判决。

工程上还有一个容易忽略的细节：**exit 143 不等于「业务失败原因已知」**。它只说明进程被 SIGTERM 结束；stdout 里的成功字样可能来自子步骤、进度条、甚至上一次运行的缓冲残留。没有 L1，任何对 stdout 的自然语言解读都只是猜测。

## 最小可运行防护：终止态一等公民

下面是一段可直接跑的 Python 骨架：工具执行结果带显式 `Termination`，compaction 只允许压缩 `stdout` 正文，禁止改写终止态；若超时或非零退出，下游强制 `must_rerun`。

```python
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any
import json
import signal
import subprocess
import time


class TermKind(str, Enum):
    OK = "ok"
    NONZERO = "nonzero_exit"
    TIMEOUT = "timeout"
    SIGNAL = "signal"


@dataclass(frozen=True)
class Termination:
    kind: TermKind
    exit_code: int | None
    signal_name: str | None
    timed_out: bool
    duration_ms: int

    @property
    def succeeded(self) -> bool:
        return self.kind == TermKind.OK and not self.timed_out


@dataclass
class ToolObservation:
    tool_name: str
    argv: list[str]
    stdout_tail: str
    stderr_tail: str
    termination: Termination
    # L0 only — never promote to "confirmed" without verifier
    observed_markers: list[str]


SUCCESSISH = ("PASS", "OK", "Apply complete", "confirmed", "成功", "已确认")


def run_with_termination(
    argv: list[str], timeout_sec: float = 30.0, tail: int = 2000
) -> ToolObservation:
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
        duration_ms = int((time.monotonic() - t0) * 1000)
        kind = TermKind.OK if proc.returncode == 0 else TermKind.NONZERO
        term = Termination(
            kind=kind,
            exit_code=proc.returncode,
            signal_name=None,
            timed_out=False,
            duration_ms=duration_ms,
        )
        out, err = proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired as e:
        duration_ms = int((time.monotonic() - t0) * 1000)
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = (e.stderr or b"").decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        term = Termination(
            kind=TermKind.TIMEOUT,
            exit_code=None,
            signal_name="SIGTERM",
            timed_out=True,
            duration_ms=duration_ms,
        )

    markers = [m for m in SUCCESSISH if m in out or m in err]
    return ToolObservation(
        tool_name=argv[0],
        argv=argv,
        stdout_tail=out[-tail:],
        stderr_tail=err[-tail:],
        termination=term,
        observed_markers=markers,
    )


def compact_observation(obs: ToolObservation) -> dict[str, Any]:
    """Safe compact: keep termination verbatim; demote markers to observed."""
    status = "succeeded" if obs.termination.succeeded else "failed_or_incomplete"
    return {
        "tool": obs.tool_name,
        "status": status,
        "termination": asdict(obs.termination),
        "must_rerun": not obs.termination.succeeded,
        "stdout_tail_observed": obs.stdout_tail[:400],
        "success_like_markers_observed": obs.observed_markers,  # L0 only
        # Explicitly forbidden fields for summarizer prompts:
        # confirmed / verified / user_approved
    }


def assert_no_false_confirmation(summary: dict[str, Any]) -> None:
    banned = ("confirmed", "verified", "user_approved", "已确认", "已验证")
    blob = json.dumps(summary, ensure_ascii=False).lower()
    if summary.get("must_rerun") and any(b.lower() in blob for b in banned):
        raise ValueError("false confirmation: success language with must_rerun=True")
    if summary.get("must_rerun") and summary.get("status") == "succeeded":
        raise ValueError("inconsistent status vs must_rerun")


if __name__ == "__main__":
    # Simulate a command that prints PASS then hangs past timeout
    obs = run_with_termination(
        ["python", "-c", "print('PASS'); import time; time.sleep(60)"],
        timeout_sec=0.3,
    )
    summary = compact_observation(obs)
    assert summary["must_rerun"] is True
    assert summary["termination"]["timed_out"] is True
    assert "PASS" in summary["success_like_markers_observed"]
    assert_no_false_confirmation(summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
```

跑完你会看到：摘要里仍有 `PASS` 观测，但 `must_rerun=true`、`timed_out=true`，且断言禁止出现「已确认」类措辞。这就是和「只做文本压缩」的分水岭。

把这段嵌进 LangGraph / 自研编排时，关键副作用节点（合并、发布、付款、删库）前加一道门：若上游任一依赖 `must_rerun`，禁止进入，先复跑 verifier。复跑仍超时，走升级或人工，而不是「再总结一次指望变绿」。

## Compaction Prompt 要改的三处

多数团队的压缩提示词类似「总结工具调用结果，保留关键结论」。对假确认几乎零防护。改成契约式：

```text
你是会话压缩器，不是验证器。
规则：
1. 每个工具调用必须原样保留 termination（exit_code / timed_out / signal）。
2. stdout 中的 PASS/OK/已确认 只能写在 observed_markers，禁止写进结论句。
3. 若 timed_out=true 或 exit_code!=0：结论只能是「未完成，必须复跑」，禁止「成功/通过/已确认」。
4. 禁止把「用户消息缺失」推断成「用户默认同意」。
5. 输出 JSON，字段固定：status, termination, must_rerun, observed_markers, notes。
```

TypeScript 侧可以在写入消息历史前再拦一道：

```typescript
type Termination = {
  kind: "ok" | "nonzero_exit" | "timeout" | "signal";
  exitCode: number | null;
  timedOut: boolean;
};

type CompactedTool = {
  status: "succeeded" | "failed_or_incomplete";
  termination: Termination;
  mustRerun: boolean;
  observedMarkers: string[];
  notes?: string;
};

const BANNED = /已确认|已验证|\bconfirmed\b|\bverified\b/i;

export function guardCompactedTool(c: CompactedTool): CompactedTool {
  if (!c.termination.timedOut && c.termination.kind === "ok" && c.termination.exitCode === 0) {
    return { ...c, mustRerun: false, status: "succeeded" };
  }
  const notes = c.notes ?? "";
  if (BANNED.test(notes) || BANNED.test(c.observedMarkers.join(" "))) {
    // markers may contain PASS — that's fine; notes must not promote them
  }
  if (BANNED.test(notes)) {
    throw new Error("compaction promoted observation to confirmation");
  }
  return {
    ...c,
    status: "failed_or_incomplete",
    mustRerun: true,
    notes: (notes + " [harness: incomplete — rerun required]").trim(),
  };
}
```

## 和相邻主题怎么划界

| 主题 | 关心什么 | 本文增量 |
|------|---------|---------|
| Context Compaction 工程 | 压什么、何时压、Cache 友好 | 压完之后**语义是否仍然真实** |
| HITL / 审批超时 | 人没回时默认拒绝还是升级 | 机器超时被误标成「人已同意」 |
| Output Guard | 工具参数该不该执行 | 工具**已经半执行**后，历史怎么记账 |
| Error Recovery | 失败后怎么重试 | 先别把失败记成成功，再谈重试 |

实操顺序建议：**先修记账（本文）→ 再修压缩策略 → 再修重试预算**。记账错了，后面三层都会在错误事实上优化。

## 检测与回归：别等事故才发现

假确认很难靠「读一篇摘要觉得不对劲」发现，必须可扫描。建议至少三条自动化：

1. **Transcript 静态扫描**：历史消息里同时出现 `timed_out`/`exit 143` 与「已通过/已确认」→ 记为 near-miss。
2. **压缩前后 diff**：压缩器输出不得删除 `termination` 字段；若输入 `must_rerun=true`，输出不得变为成功叙事。
3. **影子复验**：对标记成功的高风险命令，抽样用同一 argv 再跑一次（只读或沙箱），对比 exit code；不一致则告警并回写 L2。

指标上不要只看「压缩率」和「任务完成率」。完成率会被假确认抬高。更有用的是：`timeout_with_success_marker`、`false_confirm_blocked_by_guard`、`rerun_after_timeout_pass_rate`。前两个上升说明暴露面大或防护在干活；第三个稳定在高位，说明复验策略有效而不是空转。

## 生产落地：harness 清单

把防护嵌进 Agent 运行时，而不是指望模型「自觉」：

1. **工具结果 schema 强制带 `termination`**，压缩器输入输出都校验。
2. **超时 / 非零退出 → `must_rerun=true`**，编排器在进入下一关键副作用前短路。
3. **摘要写入前跑 `assert_no_false_confirmation`**，CI 里对历史 transcript 做回归扫描。
4. **跨会话恢复只信任 L1/L2 结构化字段**，不信任自然语言「上次已通过」。
5. **对 `exit 143` / `SIGTERM` / `TimeoutExpired` 单独打点**，看板看假确认近失率（有成功样 marker 且 must_rerun）。
6. **人审槽位单独建模**：`awaiting_human` 超时只能变成 `rejected` 或 `escalated`，绝不能被摘要器写成 `approved`。

## 落地 Checklist

- [ ] 工具观测结构区分 `observed_markers` 与 `termination`，禁止混写
- [ ] Compaction 提示词明确：超时/非零退出不得总结为成功或「已确认」
- [ ] 压缩后 JSON 校验：`must_rerun` 与 `status` 一致性 + 禁用词扫描
- [ ] 编排器在 `must_rerun=true` 时强制再跑同一命令（或等价 verifier），禁止跳过
- [ ] 跨会话 resume 只加载结构化终止态，不把旧摘要当 ground truth
- [ ] 指标：`timeout_with_success_marker` 计数；周环比下降才算治理有效
- [ ] 与 HITL 对齐：人审超时默认拒绝；机器超时默认未完成——两边都不要「默认成功」
- [ ] 发布前用「打印 PASS 后 sleep」用例跑通压缩守卫，确认 CI 会因假确认措辞失败

假确认不是模型「变笨」，是 harness 把 **不完整执行** 和 **已验证完成** 写进了同一叙事层。先把证据等级拆开，压缩才安全，长任务才敢放心跑过夜。
