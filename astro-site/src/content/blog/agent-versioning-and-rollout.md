---
title: "Agent 版本管理与灰度发布：Prompt、工具、模型的 CI/CD 实战"
date: 2026-06-04
tags: ["AI Agent", "工程化", "基础设施"]
excerpt: "Agent 上线后最怕的不是写不出新功能，而是改了 prompt 全量生效后出 bug 却无法回滚。本文拆解 Agent 系统中 Prompt 版本、Tool Schema 版本、模型版本三条线的灰度发布架构，附可落地的 CI/CD pipeline。"
emoji: "🚀"
vip: false
draft: false
---

Agent 产品上线第一天你就会发现：传统软件的版本管理对 Agent 根本不够用。代码有 Git，容器有 image tag，但 Prompt 改了一个词就可能让 Agent 行为完全变样。更棘手的是，Agent 的"版本"不是单一维度——Prompt 模板、Tool Schema、底层模型三条线独立演进，任意一条变了都可能影响输出质量。

如果你没有灰度发布机制，每次改动都是全量赌博。本文分享一套经过生产验证的 Agent 版本管理架构。

## 为什么传统 CI/CD 不够用

传统软件的版本管理假设：给定相同输入，相同版本的代码产出相同输出。但 Agent 系统有三个根本差异：

| 传统软件 | Agent 系统 |
|---------|-----------|
| 代码即行为 | Prompt + 模型 + 工具共同决定行为 |
| 输出确定性 | 输出天然带随机性（temperature > 0） |
| 单一变更维度 | 三条独立版本线交叉影响 |
| 单元测试覆盖 | 评估需要统计显著性 |

这意味着：你不能只 `git diff` 就知道这次变更是否安全。你需要的是一套分层版本管理 + 统计灰度验证体系。

## 三条版本线的架构设计

Agent 系统的完整版本由三元组 `(prompt_version, tool_version, model_version)` 唯一确定。我们把这个三元组叫做 **Agent Config**。

```python
from dataclasses import dataclass
from typing import Optional

@dataclass(frozen=True)
class AgentConfig:
    """Agent 运行时配置的不可变快照"""
    prompt_version: str        # e.g. "v2.3.1"
    tool_schema_version: str   # e.g. "v1.8.0"
    model_id: str              # e.g. "claude-sonnet-4-20250514"
    temperature: float = 0.3
    max_tokens: int = 4096
    
    @property
    def config_hash(self) -> str:
        """生成唯一标识，用于追踪和回滚"""
        import hashlib
        content = f"{self.prompt_version}:{self.tool_schema_version}:{self.model_id}"
        return hashlib.sha256(content.encode()).hexdigest()[:12]


@dataclass
class RolloutRule:
    """灰度发布规则"""
    config: AgentConfig
    traffic_percent: int        # 0-100
    target_segments: list[str]  # e.g. ["internal", "beta_users"]
    sticky: bool = True         # 同用户是否固定版本
```

## Prompt 版本管理：Git 不够，需要 Registry

Prompt 改动频率远高于代码。一个成熟 Agent 产品，代码一周发 1-2 次，但 Prompt 可能一天改 3 次。你需要：

1. **Prompt 独立版本号** — 与代码解耦，单独打 tag
2. **Prompt Registry** — 中心化存储，支持按版本拉取
3. **Prompt Diff** — 不是文本 diff，而是行为 diff（通过 eval 比较）

```python
import json
from datetime import datetime
from pathlib import Path

class PromptRegistry:
    """轻量 Prompt 版本注册中心（生产环境建议用 Redis/DynamoDB）"""
    
    def __init__(self, storage_path: str = "./prompt_registry"):
        self.storage = Path(storage_path)
        self.storage.mkdir(exist_ok=True)
    
    def publish(self, name: str, version: str, template: str, 
                metadata: dict | None = None) -> str:
        """发布新版本 prompt"""
        record = {
            "name": name,
            "version": version,
            "template": template,
            "published_at": datetime.utcnow().isoformat(),
            "metadata": metadata or {},
        }
        path = self.storage / f"{name}_{version}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2))
        return str(path)
    
    def fetch(self, name: str, version: str = "latest") -> str:
        """拉取指定版本的 prompt 模板"""
        if version == "latest":
            versions = sorted(self.storage.glob(f"{name}_v*.json"))
            if not versions:
                raise FileNotFoundError(f"No prompt found: {name}")
            path = versions[-1]
        else:
            path = self.storage / f"{name}_{version}.json"
        
        record = json.loads(path.read_text())
        return record["template"]
    
    def list_versions(self, name: str) -> list[str]:
        """列出所有已发布版本"""
        files = sorted(self.storage.glob(f"{name}_v*.json"))
        return [json.loads(f.read_text())["version"] for f in files]
```

## 灰度路由：按流量百分比分配版本

灰度发布的核心是 **Traffic Router** — 根据用户 ID 决定走哪个 Agent Config：

```python
import hashlib
from typing import Optional

class TrafficRouter:
    """基于用户 ID 的确定性灰度路由"""
    
    def __init__(self, rules: list[RolloutRule]):
        # 按 traffic_percent 降序排列，确保高优先级规则先匹配
        self.rules = sorted(rules, key=lambda r: r.traffic_percent, reverse=True)
    
    def route(self, user_id: str, segment: Optional[str] = None) -> AgentConfig:
        """根据用户 ID 确定性地路由到某个版本"""
        bucket = self._hash_to_bucket(user_id)
        
        cumulative = 0
        for rule in self.rules:
            # 检查 segment 匹配
            if rule.target_segments and segment not in rule.target_segments:
                continue
            cumulative += rule.traffic_percent
            if bucket < cumulative:
                return rule.config
        
        # fallback 到最后一条规则
        return self.rules[-1].config
    
    def _hash_to_bucket(self, user_id: str) -> int:
        """用户 ID hash 到 0-99 的桶，保证同用户始终落同一桶"""
        h = hashlib.md5(user_id.encode()).hexdigest()
        return int(h[:8], 16) % 100


# 使用示例
stable = AgentConfig(
    prompt_version="v2.3.0",
    tool_schema_version="v1.8.0",
    model_id="claude-sonnet-4-20250514",
)
canary = AgentConfig(
    prompt_version="v2.4.0-rc1",  # 新 prompt 候选版本
    tool_schema_version="v1.8.0",
    model_id="claude-sonnet-4-20250514",
)

router = TrafficRouter(rules=[
    RolloutRule(config=canary, traffic_percent=10, target_segments=["beta"]),
    RolloutRule(config=stable, traffic_percent=90, target_segments=[]),
])
```

## 自动化 Eval Gate：灰度扩量的前提

灰度发布不是"放 10% 流量然后祈祷"。你需要一个 **Eval Gate** — 自动跑 eval suite，只有新版本指标不劣于旧版本才允许扩量：

```python
from dataclasses import dataclass

@dataclass
class EvalResult:
    config_hash: str
    accuracy: float      # 任务完成率
    latency_p50: float   # 延迟中位数(ms)
    cost_per_req: float  # 每请求成本($)
    tool_error_rate: float  # 工具调用错误率
    sample_size: int

class EvalGate:
    """灰度扩量的自动化决策门"""
    
    def __init__(self, min_samples: int = 200, 
                 max_regression: float = 0.05):
        self.min_samples = min_samples
        self.max_regression = max_regression  # 允许的最大退步幅度
    
    def should_promote(self, baseline: EvalResult, 
                       candidate: EvalResult) -> tuple[bool, str]:
        """判断候选版本是否可以扩量"""
        if candidate.sample_size < self.min_samples:
            return False, f"样本不足: {candidate.sample_size}/{self.min_samples}"
        
        # 准确率不能退步超过阈值
        acc_diff = baseline.accuracy - candidate.accuracy
        if acc_diff > self.max_regression:
            return False, f"准确率退步: {acc_diff:.2%} > {self.max_regression:.2%}"
        
        # 工具错误率不能恶化
        if candidate.tool_error_rate > baseline.tool_error_rate * 1.5:
            return False, f"工具错误率飙升: {candidate.tool_error_rate:.2%}"
        
        # 成本不能暴涨（允许 20% 波动）
        if candidate.cost_per_req > baseline.cost_per_req * 1.2:
            return False, f"成本超标: ${candidate.cost_per_req:.4f}"
        
        return True, "所有指标通过，可扩量"
```

## CI/CD Pipeline 全流程

把上面的组件串成完整的 pipeline：

```text
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│ Prompt 变更  │────▶│  Eval Suite  │────▶│  Canary 10%   │
│ (PR Merge)  │     │ (离线 eval)   │     │ (线上灰度)     │
└─────────────┘     └──────────────┘     └───────────────┘
                           │                      │
                      通过 / 失败              Eval Gate
                           │                      │
                    ┌──────▼──────┐      ┌────────▼────────┐
                    │  Block PR   │      │  扩量 50% → 100% │
                    │  通知作者    │      │  或自动回滚       │
                    └─────────────┘      └─────────────────┘
```

对应的 GitHub Actions 片段（Prompt 变更触发）：

```yaml
# .github/workflows/prompt-eval.yml
name: Prompt Eval Gate
on:
  push:
    paths: ['prompts/**']

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run offline eval suite
        run: |
          python -m pytest tests/eval/ \
            --eval-config=prompts/config.yaml \
            --min-accuracy=0.85 \
            --max-cost=0.05
      - name: Deploy canary (10%)
        if: success()
        run: |
          python scripts/deploy_canary.py \
            --traffic-percent=10 \
            --eval-threshold=200
```

## 回滚策略：30 秒内恢复

灰度出问题时，回滚必须快。Agent 系统的回滚比传统服务简单——不需要回滚代码或数据库，只需切换 Config 指针：

| 回滚类型 | 操作 | 恢复时间 |
|---------|------|---------|
| Prompt 回滚 | Registry 指针切回旧版本 | < 5s |
| 模型回滚 | Config 切换 model_id | < 5s |
| Tool Schema 回滚 | 需重新加载 schema，略慢 | < 30s |
| 全量回滚 | Config 整体切回上一快照 | < 5s |

关键设计原则：**Config 与代码部署解耦**。Prompt 版本切换不需要重新部署服务，通过 Feature Flag 或 Config Service 热切换。

## 选型决策矩阵

| 方案 | 适用规模 | 复杂度 | 回滚速度 | 推荐场景 |
|------|---------|--------|---------|---------|
| Git + 环境变量 | 1-3 个 Agent | 低 | 分钟级 | 早期 MVP |
| Prompt Registry + Router | 3-10 个 Agent | 中 | 秒级 | 成长期产品 |
| Feature Flag 平台集成 | 10+ Agent | 中高 | 秒级 | LaunchDarkly/Flagsmith |
| 自建 Agent Platform | 企业级 | 高 | 秒级 | 大规模多团队 |

## 落地 Checklist

> 从零搭建 Agent 版本管理的最小路径：

1. **Day 1** — Prompt 从代码中抽出来，放独立目录，Git 管理 + 语义化版本号
2. **Day 3** — 搭建 Prompt Registry（可以从 JSON 文件/Redis 开始）
3. **Day 5** — 实现 Traffic Router，按用户 ID hash 分桶
4. **Week 2** — 建立离线 Eval Suite，每次 Prompt PR 自动跑
5. **Week 3** — 接入线上 Eval Gate，灰度扩量自动化
6. **Week 4** — 完善告警和一键回滚脚本

不需要一步到位。MVP 阶段只做到 Prompt 独立版本号 + 手动灰度就已经比"直接改 production prompt"安全 10 倍了。随着 Agent 数量和流量增长，逐步补齐 Registry、Router、Eval Gate。

核心原则只有一条：**任何变更都要能在 30 秒内回滚**。只要做到这一点，你就可以大胆迭代而不怕翻车。
