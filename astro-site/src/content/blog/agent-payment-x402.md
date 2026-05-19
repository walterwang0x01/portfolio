---
title: "Agent 支付实战：x402 协议如何让 AI Agent 自主花钱"
date: 2026-05-01
tags: ["Agent 支付", "x402", "USDC"]
excerpt: "AI Agent 能调 API、能写代码，但不能花钱——这是 Agent 落地的最后一公里。x402 协议用 HTTP 402 + 稳定币签名，让 Agent 像调接口一样完成微支付，本文从协议原理到生产部署完整拆解。"
vip: false
draft: false
---
你的 AI Agent 能帮你搜索信息、生成代码、分析数据，但有一件事它做不了——**花钱**。当 Agent 需要调用一个付费 API、购买一份数据、或者使用一个 SaaS 服务时，它只能停下来等你手动操作。这就是 Agent 经济的核心瓶颈：**Agent 没有自己的支付能力**。

x402 协议正在改变这一点。它由 Coinbase 发起，将支付嵌入 HTTP 协议本身——Agent 发请求遇到 402 状态码，自动签名付款，拿到数据继续干活。整个过程不需要信用卡、不需要注册账号、不需要人工审批。本文基于 [tech-learning-and-projects](https://github.com/walterwang0x01/tech-learning-and-projects) 仓库中的 Agent 支付学习笔记和 x402 实战 Demo，从协议原理到生产部署完整拆解。

## 为什么 Agent 需要自己的支付体系？

传统支付系统是为人设计的：打开网页、输入卡号、点击确认。但 AI Agent 不是人，它的支付需求和人类完全不同：

-   **频率极高**：人一天几笔交易，Agent 一天可能几千笔
-   **金额极小**：调用一次 API 可能只需 $0.001，传统支付的手续费比本金还高
-   **无法手动确认**：Agent 需要预设策略自动授权，不能每笔都等人点"确认"
-   **没有身份**：Agent 没有身份证、没有银行账户，传统 KYC 流程走不通

核心矛盾很清楚：**Agent 需要支付能力，但你不能给它一张信用卡和无限权限**。需要一个中间层，在"用户的钱"和"Agent 的行为"之间做精细控制。

## x402 协议：HTTP 原生的 Agent 支付

x402 是目前最"程序员友好"的 Agent 支付协议。它的核心思路极其简洁——**把支付变成 HTTP 协议的一部分**：

> Agent 发请求 → 服务端返回 HTTP 402 + 价格 → Agent 签名稳定币支付 → 带签名重新请求 → 服务端验证 → 返回数据

HTTP 402 状态码（Payment Required）在 1997 年就被定义了，但一直是"保留供将来使用"。将近 30 年后，x402 终于让它派上了用场。

x402 的关键设计决策：

-   **无需注册**：不需要 API Key，不需要创建账号，有钱包就能付
-   **亚美分微支付**：基于 USDC 稳定币，支持低至 $0.001 的支付
-   **买方无 Gas**：使用 EIP-3009 签名授权，Facilitator 代付链上 Gas 费
-   **去中心化**：没有中心化的支付网关，任何人都可以成为卖方

## 四大 Agent 支付协议对比

x402 不是唯一的选择。2026 年，Agent 支付领域已经形成了四大协议并存的格局：

-   **x402**（Coinbase + Linux Foundation）：HTTP 原生微支付，适合 API-to-API 和 Agent-to-Agent 场景。已处理超过 1.15 亿笔交易。
-   **ACP**（Stripe + OpenAI）：Agent 代用户在商户购物，已在 ChatGPT 中运行。利用 Stripe 现有商户网络，不需要加密货币。
-   **MPP**（Stripe + Tempo）：基于 Tempo L1 区块链的自主支付协议，OpenAI、Anthropic、Visa 等为设计合作伙伴。
-   **UCP**（Google + Shopify）：全链路商务协议，从商品发现到履约的完整流程。

简单的选型建议：**Agent 调付费 API 选 x402，Agent 帮用户购物选 ACP，需要完整商务流程选 UCP**。这些协议会长期共存，因为它们解决的是不同层面的问题。

## x402 实战：10 分钟跑通买卖双方

理论讲完，上代码。下面用 Node.js 演示一个完整的 x402 支付流程——卖方提供付费天气 API，买方 Agent 自动付费获取数据。

### 卖方：给 API 加付费墙

卖方只需要在 Express 应用上加一个 x402 中间件，几行配置就能把免费 API 变成付费 API：

```
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();

// 创建 x402 资源服务器，对接 Facilitator
const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"  // 测试网免费 Facilitator
});
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

// 定义路由价格：每次调用 $0.001 USDC
const routes = {
  "GET /api/weather": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",      // Base Sepolia 测试网
      payTo: "0xYourWalletAddress", // 你的收款地址
    },
  },
};

// 一行中间件搞定付费墙
app.use(paymentMiddleware(routes, resourceServer));

// 业务逻辑不需要任何改动
app.get("/api/weather", (req, res) => {
  res.json({ city: "上海", temperature: "26°C", weather: "晴天" });
});
```

未付费的请求会自动收到 HTTP 402 响应，响应头中包含价格、收款地址、网络等支付要求。

### 买方：Agent 自动付费

买方 Agent 使用 `@x402/fetch` 包装原生 fetch，自动处理 402 响应：

```
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// 用私钥创建钱包账户
const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);

// 包装 fetch，自动处理 402 支付
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{
    network: "eip155:84532",
    client: new ExactEvmScheme(account),
  }],
});

// Agent 像调普通 API 一样调用，支付自动完成
const response = await fetchWithPayment("http://api.example.com/weather");
const data = await response.json();
// data: { city: "上海", temperature: "26°C", weather: "晴天" }
```

整个支付过程对 Agent 来说是透明的：发请求 → 收到 402 → 自动签名 → 重新请求 → 拿到数据。Agent 的业务代码不需要关心支付细节。

## 生产部署：从 Demo 到真金白银

Demo 跑通了，但生产环境要考虑的事情多得多。以下是关键的架构决策：

### 钱包管理：分层架构

生产环境不能让每个 Agent 自己拿着私钥。推荐三层钱包架构：

-   **主钱包**（HSM / 多签）：持有大部分 USDC 储备，每日 1-2 次批量分发，使用 2-of-3 多签保护
-   **运营钱包**（KMS / MPC）：向 Agent 钱包分发资金，保持 24 小时运营量，余额低于阈值自动补充
-   **Agent 钱包**（MPC 托管）：实际做 x402 支付的钱包，余额保持最小化，任务完成后回收剩余资金

资金流向：用户充值 → 主钱包 → 运营钱包 → Agent 钱包 → x402 支付。任务完成后反向回收。

### 签名服务：私钥永不暴露

Agent 代码中不应该出现私钥。推荐使用 Circle Developer-Controlled Wallets 或 Coinbase CDP Wallets：

-   私钥通过 MPC 分片存储，单点泄露不会丢失资金
-   Agent 通过 API 请求签名，签名在 MPC 环境中完成
-   签名前可以做额度验证、风控检查、审计记录
-   即使 Agent 被攻破，攻击者也拿不到私钥

### 会让你赔钱的三个配置错误

这三个错误不会在启动时报错，但会在运行时默默吞掉你的钱：

1.  **收款地址没改**：开发时用的占位地址 `0x0000...0001`，上线忘了改，所有收款都转到了你不控制的地址。链上不可逆，钱拿不回来。
2.  **网络 ID 和 USDC 地址不匹配**：Base 主网是 `eip155:8453`，测试网是 `eip155:84532`，差一位数字。配错了 Facilitator 找不到合约，服务白给。
3.  **汇率过期**：如果以 ETH 计价再转 USDC，部署时 ETH = $3200，一个月后涨到 $4000，你的服务实际便宜了 20%。建议直接用 USDC 定价。

## 2026 年 Agent 支付行业全景

Agent 支付不只是技术问题，它正在成为一个新的行业。几个关键信号：

-   **卡组织入场**：Mastercard 推出 Agent Pay，Citi、US Bank 持卡人已可使用；Visa 发布 Intelligent Commerce 平台，100+ 合作伙伴接入
-   **x402 Foundation 成立**：Coinbase 与 Linux Foundation 联合成立开放治理组织，x402 从公司项目升级为行业标准
-   **Stripe + Tempo 主网上线**：Machine Payments Protocol（MPP）正式发布，OpenAI、Anthropic、Visa、Deutsche Bank 为设计合作伙伴
-   **Agentic Economy 规模预测**：2030 年预计达到 $3-5 万亿

当前大多数生产部署处于 Level 2-3 成熟度：预设参数内自主执行，异常时人工介入。完全自主的 Agent 经济（Level 5）还需要时间，但基础设施正在快速就位。

## 总结：Agent 支付的选型建议

如果你正在构建需要支付能力的 AI Agent，这是我的建议：

-   **Agent 调付费 API / 微支付**：选 x402。HTTP 原生、无需注册、亚美分级，天然适合机器间交易。
-   **Agent 代用户购物**：选 ACP（Stripe）。利用现有商户网络，用户体验好，不需要加密货币。
-   **企业内部 Agent**：选虚拟预付卡（Mastercard Agent Pay / AgentToken）。对商户改造最小，合规最成熟。
-   **高频自主交易**：关注 MPP（Stripe + Tempo）。专为 Agent 自主支付设计，但生态还在早期。

Agent 支付是 Agent 落地的最后一公里。当 Agent 能自主花钱，它就不再只是一个"聊天机器人"，而是一个真正能替你办事的数字员工。
