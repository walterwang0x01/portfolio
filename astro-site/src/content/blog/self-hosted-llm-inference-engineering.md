---
title: "自托管 LLM 推理工程化：从模型选型到量化部署的全链路实战"
date: 2026-05-30
tags: ["LLM", "基础设施", "工程化"]
excerpt: "API 账单失控、数据不能出域、延迟要可控——这三件事任意一件成立，你就该考虑自托管推理。本文把模型选型、量化方案、推理引擎、并发调优串成一条可落地的工程链路。"
vip: false
draft: false
emoji: "🚀"
---

当 Agent 进入生产，三个信号会推着你走向自托管推理：API 账单随调用量线性膨胀、合规要求数据不能出域、或者你需要把首 token 延迟压到云端 API 给不了的水平。但自托管不是「下载个权重跑起来」这么简单——选错模型规格浪费一半显存，选错量化方案掉点掉到不可用,选错推理引擎吞吐差三倍。这篇把整条链路拆开讲清楚。

## 先算一笔账：什么时候该自托管

自托管的盈亏平衡点取决于**调用量**和**GPU 利用率**。一张 A100 80G 包月约 1.2 万元（云厂商按需），如果你的 Agent 日均消耗 5000 万 token，用 GPT-4o-mini 级别的 API 大约月付 2-3 万元。看起来自托管更便宜,但前提是 GPU 利用率能拉到 60% 以上——很多团队实际只有 10%,自托管反而更贵。

> 经验法则：持续吞吐打不满半张卡的负载，别自托管;突发峰值高、均值低的负载，优先用 API + 缓存。

真正适合自托管的场景:数据合规硬约束、超大批量离线任务(文档解析/数据合成)、对延迟有确定性要求的实时链路。

## 模型选型决策矩阵

2026 年的开源模型已经足够覆盖大部分 Agent 任务。关键是按任务类型而非「越大越好」来选:

| 任务类型 | 推荐规格 | 代表模型 | 单卡需求(量化后) |
|---------|---------|---------|----------------|
| 意图分类/路由 | 1-4B | Qwen3-4B、Gemma3-4B | 单张 24G 消费卡 |
| 工具调用/结构化输出 | 7-14B | Qwen3-14B、Llama3.3-8B | 单张 A10/4090 |
| 通用 Agent 推理 | 30-70B | Qwen3-32B、Llama3.3-70B | 1-2 张 A100 |
| 复杂规划/代码 | MoE 类 | DeepSeek-V3、Qwen3-235B-A22B | 多卡/多机 |

选型的两个反直觉点:**MoE 模型激活参数小但显存占用按总参数算**,DeepSeek-V3 总参 671B 即使激活只有 37B,权重仍要几百 G 显存;**小模型 + 好的提示词 + 工具,往往打得过裸用大模型**,路由层尤其如此。

## 量化:省显存的代价是什么

量化把权重从 FP16 压到 INT4/INT8,显存直接砍半甚至四分之一。但不同方案的精度损失和推理速度差异很大:

| 方案 | 精度 | 显存 | 速度 | 适用 |
|------|------|------|------|------|
| GPTQ | INT4 | 1/4 | 快 | GPU 部署,需校准集 |
| AWQ | INT4 | 1/4 | 最快 | GPU 部署,激活感知,掉点小 |
| GGUF | INT4-INT8 | 灵活 | 中 | CPU/Mac/边缘,llama.cpp |
| FP8 | FP8 | 1/2 | 极快 | H100/H800,几乎无损 |

生产环境的主流选择是 **AWQ**(精度和速度平衡最好)或 **FP8**(有 Hopper 架构卡时首选)。用 AutoAWQ 量化一个模型:

```python
from awq import AutoAWQForCausalLM
from transformers import AutoTokenizer

model_path = "Qwen/Qwen3-14B"
quant_path = "Qwen3-14B-AWQ"

model = AutoAWQForCausalLM.from_pretrained(model_path, device_map="auto")
tokenizer = AutoTokenizer.from_pretrained(model_path)

# 量化配置:4-bit,group size 128 是精度/速度的常用平衡点
quant_config = {"zero_point": True, "q_group_size": 128, "w_bit": 4, "version": "GEMM"}

# 用领域内校准数据,而非通用语料——校准集分布越贴近线上,掉点越小
model.quantize(tokenizer, quant_config=quant_config)
model.save_quantized(quant_path)
tokenizer.save_pretrained(quant_path)
```

> 关键陷阱:校准集必须贴近线上真实分布。用通用维基语料量化一个专门跑代码的模型,代码任务可能掉点 5% 以上。

## 推理引擎:吞吐差距的真正来源

同一个模型同一张卡,换个推理引擎吞吐能差 3-5 倍。差距来自三项核心优化:**PagedAttention**(像操作系统管理内存页一样管理 KV cache,消除碎片)、**continuous batching**(请求级动态拼批,而非等满一批)、**投机解码**(小模型起草大模型验证)。

| 引擎 | 强项 | 适用场景 |
|------|------|---------|
| vLLM | 生态成熟、吞吐高、OpenAI 兼容 | 通用首选 |
| SGLang | RadixAttention 复用前缀、结构化输出快 | 多轮 Agent、共享 system prompt |
| TGI | HuggingFace 原生、部署简单 | 已在 HF 生态 |
| llama.cpp | CPU/Mac、极致轻量 | 边缘、本地开发 |

对 Agent 场景,**SGLang 的 RadixAttention 是隐藏王牌**——Agent 反复带着相同的长 system prompt 和工具定义请求,前缀复用能省掉大量重复计算。但 vLLM 生态最成熟,大多数团队从它起步没错。

## 实战:vLLM 起一个生产级服务

vLLM 直接提供 OpenAI 兼容接口,起服务一行命令:

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen3-14B-AWQ \
  --quantization awq \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 256 \
  --enable-prefix-caching \
  --port 8000
```

几个参数直接决定吞吐和稳定性:`--gpu-memory-utilization` 留 10% 余量防 OOM;`--max-num-seqs` 是并发上限,太高会爆显存太低浪费吞吐;`--enable-prefix-caching` 开启后相同前缀的请求复用 KV cache,对 Agent 场景收益显著。

客户端直接用 OpenAI SDK,零改造:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")

resp = client.chat.completions.create(
    model="Qwen3-14B-AWQ",
    messages=[
        {"role": "system", "content": "你是一个工具调用助手"},
        {"role": "user", "content": "查询北京今天的天气"},
    ],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
    temperature=0.1,
)
print(resp.choices[0].message.tool_calls)
```

## 上线前必须做的压测

千万别用单条请求的延迟去估算生产容量——自托管的核心收益是**批处理吞吐**,单请求快不代表并发扛得住。用并发脚本测真实的吞吐和 P99:

```python
import asyncio, time
from openai import AsyncOpenAI

client = AsyncOpenAI(base_url="http://localhost:8000/v1", api_key="EMPTY")

async def one_call(prompt: str) -> float:
    start = time.perf_counter()
    await client.chat.completions.create(
        model="Qwen3-14B-AWQ",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=256,
    )
    return time.perf_counter() - start

async def bench(concurrency: int = 64):
    tasks = [one_call(f"用一句话解释概念 {i}") for i in range(concurrency)]
    t0 = time.perf_counter()
    latencies = await asyncio.gather(*tasks)
    wall = time.perf_counter() - t0
    latencies.sort()
    p99 = latencies[int(len(latencies) * 0.99) - 1]
    print(f"并发 {concurrency} | 吞吐 {concurrency / wall:.1f} req/s | P99 {p99:.2f}s")

asyncio.run(bench(64))
```

逐步抬高并发,观察吞吐增长到饱和、P99 开始陡升的拐点——那个拐点就是你这张卡的真实容量上限,生产限流要卡在它下面。

## 自托管上线 checklist

- **选型**:按任务类型选最小够用的规格,路由用小模型,别一上来就 70B
- **量化**:GPU 部署优先 AWQ,有 H100 用 FP8,校准集贴近线上分布
- **引擎**:通用 vLLM 起步,长共享前缀的 Agent 场景评估 SGLang
- **显存**:`gpu-memory-utilization` 留 10% 余量,MoE 模型按总参数估显存
- **缓存**:务必开 prefix caching,Agent 的 system prompt 复用收益巨大
- **压测**:用并发脚本测吞吐拐点,而非单请求延迟,限流卡在拐点下
- **监控**:盯 GPU 利用率(低于 30% 该考虑回退 API)、KV cache 命中率、P99 延迟
- **降级**:留一条 API 兜底链路,GPU 节点故障时自动切换

自托管推理的本质是**用工程复杂度换成本和可控性**。它不是所有团队都该走的路,但当调用量、合规、延迟这三件事中有任意一件成为硬约束时,把这条链路吃透会带来云端 API 给不了的确定性。先用上面的盈亏账算清楚再动手,别为了「酷」而自托管。
