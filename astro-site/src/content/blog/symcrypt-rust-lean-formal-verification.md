---
title: "SymCrypt 开源 Rust+Lean 证明：后量子密码如何从文档承诺走向可复现审计"
date: 2026-07-15
tags: ["基础设施", "工程化", "Rust"]
excerpt: "微软把 SymCrypt 里 ML-KEM / SHA3 的 Safe Rust 实现与 Lean/Aeneas 形式化证明放进同一仓库。本文拆解「标准→可执行规格→in-place 实现→多架构 intrinsics」的验证流水线，以及 Agent 写证明、Lean 内核独立验收的工程取舍。"
emoji: "🔐"
vip: false
draft: true
---

密码库托着 OS、云、固件与协议。一个算术错误或 constant-time 路径上的悄悄分支，就能掀翻整段安全设计。测试回答的是「常见输入下通常对」；真正需要的是——**对所有满足前置条件的输入，机器可检查地等于标准**。

2026 年 7 月，Microsoft Research 公开 SymCrypt 用 Safe Rust + Lean（经 Aeneas）做算法形式化验证的路线：Rust 兜底内存安全，Lean 规格与证明对照 NIST 背书功能正确性。首批覆盖 Windows Insider 已用的 **ML-KEM** 与 **SHA3**，后续指向 AES-GCM、FrodoKEM、ML-DSA。后量子实现复杂、优化多——把证明工件与产品库同仓，是可信度从文档承诺走向可复现的信号。

> 验证对象不是理想参考实现，而是带 SIMD 分发与架构特化路径的生产 Rust。

## 为什么测试不够：密码实现的形态

标准里的 NTT 是清爽循环与模运算；真正进产品的代码几乎从不长这样。它塞满了为 constant-time 与吞吐服务的约减、比特操作、SIMD intrinsics，再叠上 x86 SSE2 / aarch64 Neon 的动态分发，以及内核、嵌入式、云服务等多环境下的可移植外壳。代码「看起来不像说明书」，审计成本极高；单靠官方测试向量，也很难覆盖所有合法多项式与边界状态。

形式化验证的切入点很克制：**先把标准变成可执行的数学规格，再证明实现 refine（细化）该规格**——不是另写一套「证明友好」的玩具实现去冒充上线代码。

| 保障层 | 谁提供 | 挡住什么 |
|--------|--------|----------|
| 内存 / 别名安全 | Safe Rust 类型系统 | UAF、越界写、数据竞争等大类 bug |
| 功能正确性 | Lean 规格 + 证明 | 与标准不一致的算术/状态机错误 |
| 证明可信底盘 | Lean 小内核独立检查 | Agent/人写错证明脚本也过不了检 |

两层叠在一起，比「只写 Rust」或「学术工具链生成再让产品团队接管」更贴近工程：开发者继续写惯用、可性能优化的 Rust；验证侧在生成的 Lean 模型上证明——职责分离，互不绑架。

## 流水线：标准 → Spec → Aeneas → 定理

1. **规格贴标准**：循环 / zeta / 系数更新尽量与 NIST 同构，方便对照审阅。
2. **规格可执行**：先用官方 test vector 抓转录错误。
3. **Aeneas 译真实 Rust**：不改写生产代码；可变借用纯化成「输入数组 → 输出数组」。
4. **细化定理**：合法输入下，实现结果等于 Spec。

以 FIPS 203 Algorithm 9（NTT）为例，Lean Spec 故意镜像标准三重循环：

```lean
/-- §4.3 Algorithm 9 — NTT(f)：贴近 NIST 句法的可执行规格 --/
def NTT (f : Polynomial) : Polynomial := Id.run do
  let mut «f̂» := f
  let mut i := 1
  for h0: len in [128 : >1 : /= 2] do
    for h1: start in [0 : 256 : 2*len] do
      let zeta := ζ ^ (bitRev 7 i)
      i := i + 1
      for h: j in [start : start+len] do
        let t := zeta * «f̂»[j + len]
        «f̂» := «f̂».set (j + len) («f̂»[j] - t)
        «f̂» := «f̂».set j («f̂»[j] + t)
  pure «f̂»
```

Rust 侧则是性能取向的就地更新，例如 `fn ntt(&mut [u16; 256])`。Aeneas 把它纯化成大致形如：

```text
ntt : Array U16 256 → Result (Array U16 256)
```

其中 `Result` 显式建模可能 panic 的路径。对应的细化定理（概念形态）是：

```lean
theorem ntt.spec (src : Std.Array U16 256#usize) (hWf : wfPoly src) :
  ntt src ⦃
    src' => toPoly src' = Spec.ntt (toPoly src) ∧ wfPoly src'
  ⦄
```

含义直白：合法多项式输入下，Rust 模型跑完后经 `toPoly` 转换，结果等于 `Spec.ntt`，且仍满足 well-formed 不变式。工程师真正关心的「这段优化过的 NTT 有没有算错」，被压成一条可独立复查的定理陈述；证明工程师与密码工程师终于能对着同一份工件对话。

## 难的是真正上线的路径，不是 portable 参考实现

若验证只能覆盖「一份干净的 portable 参考实现」，对 SymCrypt 这种必须吃满硬件的库几乎没用。MSR 的做法是：**按目标架构多次编译，再把对应 Lean 模型合并**——把 `#[cfg(target_arch = ...)]` 静态分发还原成模型里的动态分发，再在各架构内落到 XMM / Neon / generic。

```rust
fn ntt_layer(pe_src: &mut PolyElement, k: usize, len: usize) {
    #[cfg(target_arch = "x86_64")]
    if cpu_features_present(SYMCRYPT_CPU_FEATURE_SSE2) {
        ntt_layer_xmm(pe_src, k, len);
        return;
    }
    #[cfg(target_arch = "aarch64")]
    if cpu_features_present(SYMCRYPT_CPU_FEATURE_NEON) {
        ntt_layer_neon(pe_src, k, len);
        return;
    }
    ntt_layer_generic(pe_src, k, len);
}
```

Intrinsics 的信任面刻意收窄：裸指令包装用人工审查的小型 Lean 模型；其余用可测 Rust 再翻译。外层 Safe Rust 对着这些模型证明。

> 不必为形式化牺牲 SIMD——前提是信任面画清楚，分发逻辑一并进模型。

## 开发者仪表盘：证明进日常工作流

证明若只躺在某个 `proofs/` 目录，产品团队几乎用不起来。SymCrypt 用自动生成的 **dashboard** 把定理翻成开发者语言：前置条件、后置条件、覆盖了哪些函数、还剩哪些 trusted assumption。工程师不必会 Lean，也能判断「这条定理是不是保了我以为它保的东西」。代码一变，模型与证明可重放；失败变成工程信号——要么实现改坏了规约，要么规约/假设需要更新。形式化从发布后的附录 PDF，被拉进与类型检查同级的 **CI 门禁**。

## Agent 写证明，Lean 内核验收

最容易被误读的一点是：流水线大量使用 **AI Agent 辅助写证明**，但接受标准仍是 Lean 小内核的机械检查。Agent 是随机搜索；**编译、抽取、证明检查是确定性的**。人的精力集中在审标准形式化得准不准、主定理够不够强、假设多不多，以及策展战术库；Agent 负责展开生成模型、套辅助引理、修重构后碎掉的脚本。因为生产 Rust 与证明侧分离，**Agent 不必为了证明过关去污染产品代码**——否则「为了形式化可读」会再次和「为了性能可读」撕扯。

| 角色 | 随机 / 确定 | 失败意味 |
|------|-------------|---------|
| Agent 草稿 Spec/证明 | 随机 | 可能胡说，须下游验收 |
| Lean 内核检查 | 确定 | 不过即不过，无「差不多对」 |
| 人审 Spec 与假设 | 半自动 | 仍最依赖专家判断 |

这对后量子尤其关键：FrodoKEM、ML-DSA 实现体量大、代数细节密，纯人手证明的日历成本往往跟不上产品节奏。「Agent 加速 + 内核兜底 + 人审规格」是少数能同时满足安全与交付窗口的组合。

## 可迁移骨架（不必用 SymCrypt）

即便你不依赖微软密码栈，这套方法论仍能立刻拆成清单：

1. 把 RFC / NIST 关键算法先做成可跑官方 test vector 的参考实现（哪怕先用 Python），再谈优化等价。
2. 新写算法优先 Safe Rust（或带严格边界的子集），把内存类坑从审查清单剔除。
3. SIMD / ASM 岛单独登记信任面与契约，别假装 portable 证明盖住了 XMM 路径。
4. 证明失败像测试失败一样阻断发布；dashboard 让非证明工程师也能读懂「保了什么、没保什么」。
5. Agent 只碰证明侧，产品代码的评审与性能标准保持不变。

维护自研 TLS、消息加密或内嵌式 PQC 的团队，可以用已开源的 ML-KEM / SHA3 证明工件做一次对照盘点：仓库里哪条算法最缺可审计证据——而不是等到审计季再堆紧急补丁。

## 行动建议

- **本周**：打开 SymCrypt 公开带证明的分支，对照 Windows Insider 已启用的 ML-KEM / SHA3，盘点依赖树里 OpenSSL / BoringSSL / 平台 CSP 的版本与已知审计范围。
- **选型**：新写后量子或对称算法走「Safe Rust + 可执行 Spec + 测试向量」，把汇编岛压到最小并显式登记信任假设。
- **流程**：密码变更 PR 模板强制填写「覆盖性质 / 未覆盖路径（含 SIMD）/ 信任面」三栏；能跑形式化就挂 CI，否则至少挂 Spec↔实现差分测试。
- **治理**：把「有文档承诺」和「有可复现证明工件」分成两档 SLA；对外宣称 PQC 就绪的服务只用第二档验收。

形式化密码学不再只是论文里的 tidy 生成代码故事。SymCrypt 把 Rust 实现、Lean 证明、多架构优化和 Agent 加速拧进同一产品栈——信号很清楚：**可审计的机器证明，正在成为后量子时代生产密码库的默认工程语言之一**。
