---
title: "LLM 语义缓存实战：让重复提问不再重复付费"
date: 2026-05-31
tags: ["语义缓存", "LLM", "工程化"]
excerpt: "同一个问题被换着说法问 100 次，精确缓存一次都命中不了，Prompt Cache 也救不了。语义缓存用向量相似度让'意思相同的问题'直接命中，把 LLM 调用成本砍掉 40% 以上。但阈值定高了漏命中、定低了答错人——这篇讲清楚完整链路、三个翻车陷阱，以及一个能直接跑的最小实现。"
emoji: "⚡"
vip: false
draft: false
---

线上 Agent 跑了一周，翻账单时你会发现一个扎心的事实：大量 token 花在了"同一个问题的不同说法"上。

"怎么重置密码"、"密码忘了怎么办"、"如何找回登录密码"——这三句话在用户眼里是一个问题，在 LLM 眼里是三次独立调用，三份钱。精确匹配的缓存（key 是 query 的哈希）对此束手无策，因为字符串根本不一样。Prompt Cache 也帮不上忙，它复用的是固定前缀的 KV 计算，省的是同一段长上下文的重复编码，不是"换了说法的相同意图"。

要让"意思相同"命中缓存，你需要的是语义缓存（Semantic Cache）。

## 三种缓存别搞混

工程里"缓存"这个词被严重重载，先把三层分清楚，否则选型时会张冠李戴。

| 缓存类型 | 命中条件 | 省什么 | 典型实现 | 适用场景 |
|---|---|---|---|---|
| 精确缓存 | query 字符串完全相同 | 整次 LLM 调用 | Redis `GET/SET` | 固定按钮、枚举式请求 |
| Prompt Cache | 请求**前缀**逐 token 相同 | 前缀的 KV 计算 | Anthropic/OpenAI 原生 | 长 system prompt、长文档复用 |
| 语义缓存 | query **语义相似** | 整次 LLM 调用 | embedding + 向量检索 | 知识问答、FAQ、幂等查询 |

三者不互斥，生产系统往往叠着用：先查精确缓存（最快、零误差），未命中再查语义缓存（覆盖换说法的请求），都没中才回源调模型，同时让 Prompt Cache 在模型侧降低单次成本。

本文聚焦最容易做错、收益也最大的语义缓存。

## 核心链路：embedding → 检索 → 阈值判定

语义缓存的骨架只有四步：

1. 把进来的 query 用 embedding 模型编码成向量
2. 在向量库里检索最相似的历史 query
3. 如果最高相似度 ≥ 阈值，判定命中，直接返回它对应的缓存答案
4. 否则回源调 LLM，再把 `(向量, query, 答案)` 写回缓存

骨架很简单，下面是一个不依赖外部服务、用 numpy 做余弦相似度的最小实现：

```python
import numpy as np
from dataclasses import dataclass, field
from typing import Callable

@dataclass
class CacheEntry:
    vector: np.ndarray
    query: str
    answer: str
    created_at: float

class SemanticCache:
    def __init__(self, embed: Callable[[str], np.ndarray], threshold: float = 0.92):
        self.embed = embed            # 文本 -> 已归一化的向量
        self.threshold = threshold
        self.entries: list[CacheEntry] = []

    def _search(self, vec: np.ndarray) -> tuple[CacheEntry | None, float]:
        if not self.entries:
            return None, 0.0
        matrix = np.stack([e.vector for e in self.entries])
        sims = matrix @ vec           # 向量都已归一化，点积即余弦相似度
        idx = int(np.argmax(sims))
        return self.entries[idx], float(sims[idx])

    def get(self, query: str) -> tuple[str | None, float]:
        vec = self.embed(query)
        entry, score = self._search(vec)
        if entry and score >= self.threshold:
            return entry.answer, score   # 命中
        return None, score               # 未命中，分数用于观测

    def put(self, query: str, answer: str):
        import time
        self.entries.append(
            CacheEntry(self.embed(query), query, answer, time.time())
        )
```

接上 LLM 的用法：

```python
def ask(cache: SemanticCache, llm, query: str) -> str:
    cached, score = cache.get(query)
    if cached is not None:
        log_metric("cache_hit", score=score)
        return cached
    answer = llm.complete(query)         # 回源
    cache.put(query, answer)
    log_metric("cache_miss", score=score)
    return answer
```

注意 `embed` 函数返回的必须是**归一化后**的向量（L2 范数为 1），这样点积直接等于余弦相似度，省掉每次检索的除法。生产里别用 numpy 全表扫描，换成 pgvector、Redis Vector、Milvus 这类带 ANN 索引的向量库，否则缓存条目一多检索就成了新瓶颈。

## 阈值是整个系统的命门

`threshold` 这个数字看着不起眼，它决定了语义缓存是省钱利器还是事故源头。

阈值定太低，会发生 **false hit（误命中）**：两句话相似度很高但意思关键性不同，缓存却把错误答案返回给了用户。最经典的反例是否定句——"如何**启用**双因素认证"和"如何**关闭**双因素认证"，embedding 余弦相似度常常高达 0.95 以上，但答案完全相反。靠单纯调高阈值压不住这类 case，因为它们本来就语义相近。

阈值定太高，则命中率塌方，缓存形同虚设，你白白付了 embedding 的成本却几乎没省到 LLM 的钱。

实践中更稳的是**双阈值 + 二次确认**：

```python
def get_with_rerank(self, query: str, rerank: Callable[[str, str], float]):
    vec = self.embed(query)
    entry, score = self._search(vec)
    if entry is None:
        return None, score
    if score >= self.high_threshold:        # 0.95+：高置信，直接命中
        return entry.answer, score
    if score >= self.low_threshold:         # 0.88~0.95：灰区，交叉编码器复核
        if rerank(query, entry.query) >= 0.9:
            return entry.answer, score
    return None, score                      # 低于灰区：回源
```

灰区里用一个交叉编码器（cross-encoder reranker）做二次判定。它把两个 query 拼一起进模型，比单独算两个向量再求相似度精确得多，尤其擅长抓出否定、数量、对象这类"细节决定生死"的差异。代价是慢，所以只在灰区调用，高置信区不碰。

## 三个会让你翻车的工程陷阱

阈值之外，还有三个在 demo 里看不出、上线才爆的坑。

**陷阱一：上下文敏感的 query 不能裸缓存。** 多轮对话里"它多少钱"完全依赖上文是在问哪个商品。如果只用这句话当缓存 key，A 用户问完手机价格写进缓存，B 用户问"它多少钱"时指的是耳机，却拿到了手机的答案。对策很直接：语义缓存只对**无状态、幂等**的 query 开（知识问答、FAQ、文档检索），或者把必要上下文一起编码进 embedding。带强上下文依赖的对话轮次，别进缓存。

**陷阱二：时效性内容会缓存出"过期答案"。** "Python 最新稳定版是多少"今天答 3.13，半年后还命中这条缓存就成了错的。对策是按内容类别分级设 TTL：稳定的概念解释可以缓存很久甚至不过期，含价格、版本号、库存、实时数据的答案要么短 TTL，要么直接标记为不可缓存。

```python
TTL_BY_CATEGORY = {
    "concept": None,        # 概念解释，永不过期
    "howto": 7 * 86400,     # 操作指南，一周
    "pricing": 3600,        # 价格，一小时
    "realtime": 0,          # 实时数据，禁止缓存
}
```

**陷阱三：缓存投毒会被相似度放大。** 一旦某个错误答案进了缓存，后续所有语义相近的 query 都会命中它，错误被持续放大。对策有两条：写入侧只缓存经过校验或高置信的答案（比如带引用、通过了输出护栏的），读取侧给用户一个"答案没用"的反馈入口，命中负反馈就立刻失效这条缓存。

别忘了多租户隔离——缓存 key 必须带上 `tenant_id` 或 `namespace`，否则 A 公司的私有数据会泄漏给 B 公司。这条不是优化，是安全红线。

## 给前端网关加一层缓存中间件

如果你的 Agent 走统一网关，语义缓存适合做成请求中间件。下面是 TypeScript 的示意：

```typescript
async function semanticCacheMiddleware(req: ChatRequest, next: Handler) {
  // 多轮对话直接跳过缓存，避免上下文错配
  if (req.messages.length > 1) return next(req);

  const query = req.messages[0].content;
  const vec = await embed(query);
  const hit = await vectorStore.search(vec, {
    namespace: req.tenantId,        // 多租户隔离
    topK: 1,
  });

  if (hit && hit.score >= THRESHOLD && !isExpired(hit)) {
    metrics.increment("semantic_cache.hit");
    return { content: hit.answer, cached: true };
  }

  const res = await next(req);      // 回源
  await vectorStore.upsert({ vec, query, answer: res.content,
                             namespace: req.tenantId, ttl: ttlFor(query) });
  return res;
}
```

关键点都在注释里：多轮对话短路、按 tenant 隔离命名空间、命中要校验未过期、写回带 TTL。

## 选型与落地 checklist

什么时候该上语义缓存，先过一遍这张决策表：

| 你的场景 | 建议 |
|---|---|
| 高频 FAQ / 知识问答，请求高度重复 | 强烈推荐，命中率和省钱效果最好 |
| 幂等的单轮查询（翻译、分类、摘要） | 推荐 |
| 强上下文多轮对话 | 不要裸用，至少把上下文编进 key |
| 含实时数据 / 个性化结果 | 不缓存，或仅缓存可复用的中间产物 |
| 请求几乎不重复（创意写作、长文生成） | 不值得，命中率太低 |

决定要上之后，按这份 checklist 落地：

- [ ] 先接精确缓存兜底，再叠语义缓存，命中链路按"精确 → 语义 → 回源"排序
- [ ] embedding 向量统一归一化，检索用点积，生产换 ANN 向量库而非全表扫描
- [ ] 用一批**已知答案不同但说法相似**的 query 对（尤其是否定句）校准阈值，别拍脑袋定 0.9
- [ ] 灰区相似度引入 reranker 二次确认，高置信区直接命中
- [ ] 缓存 key 带 `tenant_id`，多租户硬隔离
- [ ] 按内容类别分级设 TTL，时效性内容禁缓存
- [ ] 写入只收高置信答案，提供命中负反馈的失效入口
- [ ] 全程埋点：命中率、命中时的相似度分布、误命中投诉率，这三个指标决定你要不要调阈值

语义缓存不是"加个 Redis"那么简单，它本质是在用相似度做一次概率判断——判断对了省一大笔钱，判断错了给用户喂错答案。把阈值、上下文、时效性、隔离这四件事做扎实，它才是 Agent 成本工程里性价比最高的一环。
