---
title: "MCP 企业级授权 EMA：ID-JAG 三段跳，如何让员工一次登录打通所有 MCP Server"
date: 2026-07-10
tags: ["MCP", "AI Agent", "Agent 安全"]
excerpt: "EMA（Enterprise-Managed Authorization）把 MCP 授权决策权交给企业 IdP，用 ID-JAG 令牌链消灭逐个 Server 的 OAuth 弹窗。本文拆解协议流程、Client/Server 双端实现，以及它没有解决的运行时授权问题。"
emoji: "🔐"
vip: false
draft: true
---

如果你的公司已经接了 20 个 MCP Server，员工每换一台机器、每接入一个新 Agent Client，就要重新走一遍 OAuth 授权弹窗——这在消费级场景是"用户主权"，在企业场景就是纯粹的摩擦和风控黑洞。2026 年 6 月 18 日，MCP 官方把 **Enterprise-Managed Authorization（EMA）** 扩展升级为 stable 状态，Anthropic、Microsoft、Okta 相继跟进支持。它解决的核心问题很直接：**把"谁能连哪个 MCP Server"的决策权，从员工的个人授权行为，收归到企业身份提供商（IdP）**。

## 传统 MCP OAuth 的问题

标准 MCP 授权流程假设每个用户独立决定是否信任每个 Server：打开 Client、跳转到 Server 的 Authorization Server、登录、点"允许"、拿到 token。这套模型对消费者友好，但放到企业里会放大成四个具体问题：

| 场景 | 传统 MCP OAuth | 企业期望 |
|------|---------------|---------|
| 新员工入职 | 手动逐个授权 10+ 个内部 MCP Server | 首次 SSO 登录后自动可用 |
| 离职 / 换岗 | 逐个 Server 撤销授权，容易遗漏 | IdP 一处撤销，全局立即生效 |
| 策略下发 | 无统一策略，全凭用户自己判断 | IT/安全团队按角色、组统一配置 |
| 审计合规 | 授权记录分散在各 Server | IdP 侧留存统一可审计的授权轨迹 |

EMA 的做法不是替换标准 OAuth，而是在其基础上叠加一层：由企业 IdP 充当"授权中介"，Client 拿到的不再是直接向 Server 申请的 token，而是先从 IdP 换取一个身份断言，再拿这个断言去 Server 的 Authorization Server 兑换正式 access token。

这个设计思路本质上是把"信任锚点"从"用户 + Server 的一次性握手"，挪到了"用户 + 企业 IdP 的长期关系"上。企业 IdP 本来就是员工登录邮箱、Slack、内部系统的统一入口，员工离职当天 IT 把账号在 IdP 里停用，所有下游系统的访问权限理论上应该同步失效——但在标准 MCP OAuth 模型下，每个 Server 各自持有一份独立的授权记录，IdP 停用账号并不会自动撤销这些 Server 上残留的 refresh token。EMA 把授权决策链路收拢到 IdP 之后，这个"授权孤岛"问题才有了统一的解法。

## 核心机制：ID-JAG 三段跳

EMA 的技术底座是 **ID-JAG**（Identity Assertion JWT Authorization Grant），本质是三个标准协议的组合：OIDC/SAML 登录 → RFC 8693 Token Exchange 换取 ID-JAG → RFC 7523 JWT Bearer Grant 换取正式 access token。整条链路：

```
Browser          MCP Client          Enterprise IdP        MCP Auth Server      MCP Resource Server
  │                   │                     │                      │                     │
  │◀── 重定向登录 ─────│                     │                      │                     │
  ├── SSO 登录 ───────────────────────────▶ │                      │                     │
  │◀── IdP 授权码 ─────────────────────────│                      │                     │
  ├── 授权码 ─────────▶│                     │                      │                     │
  │                   ├── 换取 ID Token ──▶ │                      │                     │
  │                   │◀── ID Token ───────│                      │                     │
  │                   │  (Client 缓存 ID Token，用户视角已"登录完成")                       │
  │                   ├── 用 ID Token 换 ID-JAG ─────────────────▶ │                      │
  │                   │           （IdP 在此评估访问策略）           │                      │
  │                   │◀── ID-JAG ─────────│                      │                     │
  │                   ├── 用 ID-JAG 换 Access Token ──────────────────────────────────▶  │
  │                   │◀── MCP Access Token ─────────────────────────────────────────── │
  │                   ├── 调用 MCP Server ───────────────────────────────────────────────────────▶ │
  │                   │◀── 数据响应 ──────────────────────────────────────────────────────────────│
```

关键点：**Client 全程不会把用户重定向到 MCP Server 自己的 Authorization Server 授权页面**——如果策略允许，整个过程对用户完全无感；如果策略不允许，IdP 直接拒发 ID-JAG，Client 永远拿不到 token，也就没有"半授权"状态。

这条链路里有两次"信任传递"，理解清楚才能正确评估安全边界。第一次是用户对企业 IdP 的信任——这一层本来就存在，SSO 登录邮箱、Slack 用的就是同一套身份。第二次是 MCP Server 的 Authorization Server 对企业 IdP 的信任——这是 EMA 新引入的信任关系，需要管理员显式配置"我接受哪些 IdP 签发的 ID-JAG"，而不是任何自称是 IdP 的实体都能代表用户申请 token。ID-JAG 本身是一次性、短生命周期的兑换凭证，不能被当作长期访问令牌缓存或转发，这也是它和普通 access token 在语义上的本质区别。

## Client 侧实现

Client 需要在 `initialize` 请求里声明支持该扩展，并实现 ID-JAG 兑换逻辑而不是走标准授权页跳转：

```typescript
// MCP Client 声明支持 EMA 扩展
const initializeRequest = {
  method: "initialize",
  params: {
    capabilities: {
      extensions: {
        "io.modelcontextprotocol/enterprise-managed-authorization": {},
      },
    },
  },
};

interface IdTokenCache {
  idToken: string;
  issuer: string;
  expiresAt: number;
}

class EnterpriseAuthClient {
  constructor(
    private idpTokenEndpoint: string,
    private cachedIdToken: IdTokenCache,
  ) {}

  /** 用缓存的 ID Token 向企业 IdP 换取 ID-JAG（RFC 8693 Token Exchange） */
  async exchangeForIdJag(targetServerAudience: string): Promise<string> {
    const resp = await fetch(this.idpTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: this.cachedIdToken.idToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        audience: targetServerAudience, // 目标 MCP Authorization Server 标识
        requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
      }),
    });
    if (!resp.ok) {
      // IdP 策略拒绝：用户没有权限访问该 Server，直接返回错误，不弹授权页
      throw new Error(`ID-JAG exchange denied: ${resp.status}`);
    }
    const { access_token } = await resp.json();
    return access_token; // 这就是 ID-JAG
  }

  /** 用 ID-JAG 向 MCP Server 的 Authorization Server 换取真正的 access token */
  async exchangeIdJagForAccessToken(
    mcpAuthServerTokenEndpoint: string,
    idJag: string,
  ): Promise<string> {
    const resp = await fetch(mcpAuthServerTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: idJag,
      }),
    });
    const { access_token } = await resp.json();
    return access_token;
  }
}
```

## Authorization Server 侧：验证 ID-JAG

MCP Server 的 Authorization Server 收到 ID-JAG 后，不能直接信任，必须完成一套签名、issuer、audience、client 一致性的联合校验：

```python
import time
import httpx
import jwt as pyjwt
from dataclasses import dataclass

@dataclass
class TrustedIdP:
    issuer: str
    jwks_url: str
    allowed_audiences: set[str]

class IdJagValidator:
    """校验企业 IdP 发出的 ID-JAG，参考 Atlassian Rovo MCP 的 XAA 实现思路"""

    def __init__(self, trusted_idps: dict[str, TrustedIdP]):
        self.trusted_idps = trusted_idps  # 按 issuer 索引，管理员预先配置
        self._jwks_cache: dict[str, dict] = {}

    async def validate(self, id_jag: str, expected_client_id: str) -> dict:
        header = pyjwt.get_unverified_header(id_jag)
        unverified = pyjwt.decode(id_jag, options={"verify_signature": False})

        # 1. typ 必须标明这是 ID-JAG，不是普通 access token
        if header.get("typ") != "oauth-id-jag+jwt":
            raise ValueError("not an ID-JAG token")

        # 2. issuer 必须是管理员登记过的企业 IdP，杜绝伪造 IdP
        idp = self.trusted_idps.get(unverified.get("iss", ""))
        if idp is None:
            raise ValueError("untrusted issuer")

        # 3. 用 JWKS 校验签名
        jwks = await self._get_jwks(idp.jwks_url)
        claims = pyjwt.decode(
            id_jag,
            jwks,
            algorithms=["RS256"],
            audience=idp.allowed_audiences,
            options={"require": ["exp", "iat", "aud"]},
        )

        # 4. client 一致性：ID-JAG 里的 client_id 必须和当前发起兑换请求的 client 匹配
        if claims.get("client_id") != expected_client_id:
            raise ValueError("client_id mismatch, possible token relay attack")

        return claims  # 含 sub（稳定用户标识）、email（回退账号映射）、scope

    async def _get_jwks(self, jwks_url: str) -> dict:
        if jwks_url not in self._jwks_cache:
            async with httpx.AsyncClient() as client:
                resp = await client.get(jwks_url)
                self._jwks_cache[jwks_url] = resp.json()
        return self._jwks_cache[jwks_url]
```

> **账号映射建议**：ID-JAG 的 `sub` 是跨系统稳定标识，优先用它关联账号；老用户在 EMA 上线前用邮箱注册的账号，用 `email` claim 做一次性回填匹配，之后统一切到 `sub`。

## EMA 解决了什么，没解决什么

这是最容易被误解的一点——EMA 是"连接层"的授权，不是"调用层"的授权：

| 维度 | EMA 覆盖 | 仍需自建 |
|------|---------|---------|
| 谁能连接这个 MCP Server | ✅ IdP 按角色/组统一裁决 | — |
| 首次使用是否需要弹窗同意 | ✅ 零触达，SSO 登录即完成 | — |
| 离职/换岗后访问是否立即失效 | ✅ IdP 端撤销即时生效 | — |
| 某次具体 tool 调用能否返回机密文档 | ❌ IdP 只在发 token 那一刻做决策 | 运行时细粒度 ACL / 数据分级 |
| 单个 client 的动态注册（DCR） | ❌ Entra 等企业 IdP 原生不支持 DCR | Gateway 层做兼容桥接 |
| 异常调用模式检测（越权探测） | ❌ 协议不涉及 | 调用侧审计 + 行为分析 |

换句话说，EMA 决定的是"Alice 能不能把她的 Agent 连到公司知识库"，决定不了"这一次具体的 tool 调用是否应该把一份标记为机密的文档吐给她"。后者仍然要在 MCP Server 内部按最小权限原则实现。目前公开支持 EMA 的 IdP 只有 Okta（2026 年 6 月稳定发布时），Azure AD / Entra 尚未原生支持 Dynamic Client Registration，因此不少团队会在 Client 和 Server 之间加一层 MCP Gateway，专门弥合这个兼容性缺口。

## 谁已经在真实场景里用它

规范稳定发布后，落地速度比大多数 MCP 扩展快，原因是它解决的痛点足够具体、足够普遍。Atlassian 给 Rovo MCP Server 接入 EMA 时，复用了自家已有的 Cross-App Access（XAA）能力：外部 IdP 发出 ID-JAG 后，Atlassian OAuth 校验签名、应用本地策略、解析用户和 client，再签发一枚仅对 Atlassian 资源有效的 token——关键点在于，**资源方的 Authorization Server 始终保留最终裁决权**，IdP 说"这个请求可以被考虑"，并不等于"这个请求必须被批准"，Atlassian 仍然可以按自己的规则收窄 scope 或直接拒绝。VS Code 已经是支持 EMA 的现网 Client 案例，Slack 支持据称也在路上。对于还在评估阶段的团队，一个务实的判断标准是：如果你的 IdP 是 Okta，且已经有 5 个以上内部 MCP Server 需要统一纳管，现在就值得排期；如果主力 IdP 是 Entra，建议先观察，同时提前调研 Gateway 方案兜底 DCR 缺口。

## 落地建议

- [ ] 优先在**跨部门共享的内部 MCP Server**（知识库、工单系统、CI 平台）上试点 EMA，个人级或实验性 Server 暂不必接入
- [ ] 确认公司 IdP 是否已支持 EMA（目前 Okta 已支持，其余 IdP 需跟进 ID-JAG / identity-chaining draft 进度）
- [ ] Server 侧在 Authorization Server metadata 中声明 `io.modelcontextprotocol/enterprise-managed-authorization`，明确要求 EMA 流程
- [ ] Authorization Server 必须校验 ID-JAG 的 `typ`、`iss`、`aud`、`client_id` 四要素，缺一不可，防止 token 转发攻击
- [ ] 为不支持 EMA 的 IdP/Client 组合保留标准 OAuth 2.1 授权作为兜底路径，避免"一刀切"锁死老用户
- [ ] EMA 只管连接层，运行时的字段级/文档级授权仍要在业务逻辑里单独实现，不要误以为接了 EMA 就等于数据安全闭环
- [ ] 若涉及 Entra 等不支持 DCR 的企业 IdP，评估引入 MCP Gateway（如 Obot）做客户端注册兼容
- [ ] 上线后核对离职流程：确认 HR 系统触发的账号停用，能在分钟级同步到 IdP 的 MCP 访问策略

> EMA 消灭的是"重复点击授权弹窗"的体验债，不是权限设计本身的复杂度。把连接层的信任交给 IdP 之后，团队真正该投入精力的是 Server 内部的细粒度授权和调用审计——这才是 Agent 大规模接入企业系统后真正的风险敞口。

从更长的时间线看，EMA 只是 MCP 授权体系"补课"的第一步。它解决的是连接建立那一刻的信任问题，而 Agent 真正的风险大多发生在连接建立之后——一个已经拿到合法 token 的 Agent，会不会被 prompt injection 诱导调用它本不该调用的 tool？会不会在多步任务里把敏感字段传给了不该看到的下游服务？这些问题超出了 EMA 的规范边界，需要结合 tool 级审计日志、输出内容过滤、运行时行为监控一起解决。把 EMA 当作"接入合规"的必要条件而非"数据安全"的充分条件，是评估这项技术时最值得记住的一句话。
