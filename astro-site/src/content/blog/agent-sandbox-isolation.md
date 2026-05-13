---
title: "Agent Sandbox 选型指南：E2B、Modal 与 Firecracker 安全隔离实战"
date: 2025-05-13
tags: ["AI Agent", "Agent 架构", "基础设施"]
excerpt: "让 AI Agent 执行代码却不炸掉你的服务器——三种主流沙盒方案的架构对比、性能实测与生产落地 checklist。"
vip: false
draft: false
emoji: "🏖️"
---

## 为什么 Agent 需要沙盒

当你让 LLM 生成并执行代码时，本质上是把「任意代码执行」的权限交给了一个概率模型。没有隔离层，一次幻觉就可能 `rm -rf /`、泄露环境变量、或发起内网横向攻击。

2026 年的 Coding Agent、Data Agent、Browser Agent 都面临同一个问题：**如何在给予 Agent 足够自由度的同时，把爆炸半径限制在可控范围内？**

沙盒（Sandbox）就是这个问题的工程答案。它提供一个短生命周期、资源受限、网络隔离的执行环境，Agent 在里面随便折腾，宿主机毫发无损。

## 三种主流方案概览

| 维度 | E2B | Modal | Firecracker (自建) |
|------|-----|-------|-------------------|
| 隔离级别 | microVM (Firecracker) | gVisor 容器 | microVM |
| 冷启动 | ~150ms | ~300ms | ~125ms |
| 最大存活时间 | 24h (可配置) | 按调用计费，无硬限制 | 自定义 |
| 网络控制 | 白名单出站 | VPC 级别 | iptables 全自定义 |
| 文件系统 | 临时 + 持久卷 | 临时 + Volume | overlay + tmpfs |
| GPU 支持 | ❌ | ✅ (A100/H100) | ❌ (需 VFIO 透传) |
| 定价模型 | 按沙盒秒计费 | 按 GPU/CPU 秒计费 | 自建成本 |
| 适用场景 | 代码执行、数据分析 | ML 推理、重计算 | 安全审计、合规场景 |

## E2B：开箱即用的 Agent 沙盒

E2B 专为 AI Agent 设计，提供 SDK 直接创建隔离环境、执行代码、读写文件。

```python
from e2b_code_interpreter import Sandbox

# 创建沙盒实例（冷启动 ~150ms）
sandbox = Sandbox(api_key="your-api-key")

# 执行 Agent 生成的代码
execution = sandbox.run_code("""
import pandas as pd
import numpy as np

df = pd.DataFrame({
    'model': ['gpt-4o', 'claude-opus', 'gemini-2'],
    'latency_ms': [320, 280, 350],
    'cost_per_1k': [0.03, 0.025, 0.02]
})

# Agent 可以自由安装包、读写文件
df.to_csv('/tmp/benchmark.csv')
print(df.describe())
""")

print(execution.text)  # stdout 输出
print(execution.error) # 如果有运行时错误

# 从沙盒取回文件
content = sandbox.files.read("/tmp/benchmark.csv")

# 用完销毁
sandbox.close()
```

**E2B 的核心优势**：API 极简，天然适配 Tool Use 模式。你只需要把 `run_code` 包装成一个 Tool Schema，LLM 就能自主决定何时执行代码。

```typescript
// 将 E2B 注册为 Agent Tool
const codeExecutionTool = {
  name: "execute_code",
  description: "在隔离沙盒中执行 Python 代码",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "要执行的 Python 代码" },
      timeout: { type: "number", description: "超时秒数", default: 30 }
    },
    required: ["code"]
  }
}

// Tool handler
async function handleCodeExecution(params: { code: string; timeout?: number }) {
  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY })
  try {
    const result = await sandbox.runCode(params.code, {
      timeout: params.timeout ?? 30
    })
    return { stdout: result.text, stderr: result.error, artifacts: result.artifacts }
  } finally {
    await sandbox.close()
  }
}
```

## Modal：当 Agent 需要 GPU

Modal 的定位更偏通用 serverless 计算，但它的容器隔离 + GPU 调度能力让它成为需要重计算的 Agent 的首选。

```python
import modal

app = modal.App("agent-sandbox")

# 定义沙盒环境：预装依赖 + GPU
sandbox_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch", "transformers", "pandas", "numpy"
)

@app.function(image=sandbox_image, gpu="A10G", timeout=120)
def agent_compute(code: str) -> dict:
    """Agent 的 GPU 沙盒执行器"""
    import io
    import sys
    
    # 捕获 stdout
    captured = io.StringIO()
    sys.stdout = captured
    
    local_ns = {}
    try:
        exec(code, {"__builtins__": __builtins__}, local_ns)
        return {
            "status": "success",
            "stdout": captured.getvalue(),
            "variables": {k: str(v)[:500] for k, v in local_ns.items() 
                         if not k.startswith("_")}
        }
    except Exception as e:
        return {"status": "error", "error": f"{type(e).__name__}: {e}"}
    finally:
        sys.stdout = sys.__stdout__

# 远程调用（Agent Tool handler 中使用）
# result = agent_compute.remote(agent_generated_code)
```

**Modal 的独特价值**：当你的 Agent 需要跑模型推理、处理大数据集、或执行 GPU 密集任务时，E2B 无法满足，Modal 是最省心的选择。

## Firecracker 自建：极致控制

如果你在金融、医疗等合规场景，或者需要完全掌控隔离层，Firecracker microVM 是底层方案。AWS Lambda 和 E2B 底层都用它。

```bash
# 1. 下载 Firecracker 二进制
curl -L https://github.com/firecracker-microvm/firecracker/releases/download/v1.7.0/firecracker-v1.7.0-x86_64.tgz | tar xz

# 2. 创建 rootfs（最小化 Alpine）
truncate -s 512M rootfs.ext4
mkfs.ext4 rootfs.ext4
mkdir /tmp/rootfs && mount rootfs.ext4 /tmp/rootfs
# ... 安装 Alpine + Python 到 rootfs

# 3. 启动 microVM（~125ms 冷启动）
./firecracker --api-sock /tmp/firecracker.socket --config-file vm_config.json
```

```python
# Python 封装：管理 Firecracker VM 池
import aiohttp
import asyncio
from dataclasses import dataclass

@dataclass
class VMConfig:
    vcpu_count: int = 1
    mem_size_mib: int = 256
    network_mode: str = "none"  # none | nat | bridge
    max_lifetime_sec: int = 60

class FirecrackerPool:
    """预热 VM 池，降低冷启动延迟"""
    
    def __init__(self, pool_size: int = 5, config: VMConfig = VMConfig()):
        self.pool_size = pool_size
        self.config = config
        self._available: asyncio.Queue = asyncio.Queue()
    
    async def acquire(self) -> "FirecrackerVM":
        """从池中获取一个就绪的 VM"""
        if self._available.empty():
            vm = await self._create_vm()
        else:
            vm = await self._available.get()
        return vm
    
    async def release(self, vm: "FirecrackerVM"):
        """执行完毕后销毁 VM（不复用，防止状态泄露）"""
        await vm.destroy()
        # 异步补充池
        asyncio.create_task(self._refill())
    
    async def _create_vm(self) -> "FirecrackerVM":
        # 调用 Firecracker API 创建 VM
        ...
    
    async def _refill(self):
        if self._available.qsize() < self.pool_size:
            vm = await self._create_vm()
            await self._available.put(vm)
```

## 安全加固：不只是隔离

沙盒只是第一层。生产环境还需要：

| 防护层 | 措施 | 说明 |
|--------|------|------|
| 代码静态分析 | AST 预检 | 拦截 `os.system`、`subprocess`、`__import__('ctypes')` |
| 资源限制 | cgroup / VM 配置 | CPU 时间、内存、磁盘 IO 上限 |
| 网络隔离 | 白名单出站 | 只允许访问特定 API endpoint |
| 超时熔断 | 硬超时 + 软超时 | 软超时警告，硬超时强杀 |
| 审计日志 | 全量记录 | 每次执行的代码、输出、资源消耗 |
| Secret 隔离 | 不注入宿主环境变量 | Agent 只能访问显式传入的凭证 |

```python
import ast

class DangerousCodeDetector(ast.NodeVisitor):
    """AST 级别的危险代码预检"""
    
    BLOCKED_MODULES = {"os", "subprocess", "shutil", "ctypes", "socket"}
    BLOCKED_FUNCTIONS = {"eval", "exec", "compile", "__import__"}
    
    def __init__(self):
        self.violations: list[str] = []
    
    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            if alias.name.split(".")[0] in self.BLOCKED_MODULES:
                self.violations.append(f"禁止导入模块: {alias.name}")
        self.generic_visit(node)
    
    def visit_Call(self, node: ast.Call):
        if isinstance(node.func, ast.Name):
            if node.func.id in self.BLOCKED_FUNCTIONS:
                self.violations.append(f"禁止调用: {node.func.id}")
        self.generic_visit(node)

def pre_check(code: str) -> list[str]:
    """执行前静态检查，返回违规列表"""
    tree = ast.parse(code)
    detector = DangerousCodeDetector()
    detector.visit(tree)
    return detector.violations
```

## 选型决策矩阵

根据你的场景选择：

| 你的需求 | 推荐方案 | 理由 |
|----------|----------|------|
| 快速集成 Coding Agent | E2B | SDK 最简，150ms 启动，按需付费 |
| Agent 需要跑 ML 推理 | Modal | 原生 GPU 支持，自动扩缩容 |
| 金融/医疗合规要求 | Firecracker 自建 | 数据不出境，审计全覆盖 |
| 高并发短任务（<5s） | E2B + 预热池 | 冷启动最低，API 延迟可控 |
| 多语言执行（Python+JS+Rust） | E2B 自定义模板 | 支持自定义 Dockerfile 构建沙盒 |
| 预算极度敏感 | Firecracker on Spot | 自建成本最低，但运维负担重 |

## 落地 Checklist

生产环境部署 Agent Sandbox 前，逐项确认：

- [ ] **隔离验证**：沙盒内无法访问宿主文件系统、环境变量、内网服务
- [ ] **资源上限**：设置 CPU（如 1 核）、内存（如 256MB）、执行时间（如 30s）硬限制
- [ ] **网络策略**：默认禁止出站，按需白名单（如只允许 PyPI 安装包）
- [ ] **超时机制**：软超时（返回警告）+ 硬超时（强制终止进程/VM）
- [ ] **代码预检**：AST 静态分析拦截高危操作，减少沙盒逃逸攻击面
- [ ] **审计日志**：记录每次执行的输入代码、输出结果、资源消耗、耗时
- [ ] **Secret 管理**：沙盒内只注入最小权限凭证，用完即撤销
- [ ] **成本监控**：设置每日/每用户预算上限，防止 Agent 死循环烧钱
- [ ] **错误恢复**：沙盒崩溃后 Agent 能收到明确错误信息并决定是否重试
- [ ] **池化预热**：高频场景预创建 VM/容器池，将用户感知延迟降到 <200ms
