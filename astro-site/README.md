# Walter's Tech Blog — Astro 重构版

基于 Astro + Markdown 的生产级博客。

## 快速开始

```bash
npm install
npm run migrate     # 从 ../index.html 抽出文章生成 Markdown
npm run dev
npm run build
```

## Frontmatter

```yaml
---
title: "文章标题"
date: 2026-05-06
tags: [AI Agent, MCP]
excerpt: "摘要"
vip: false
draft: false
---
```

## 部署

Cloudflare Pages：
- 构建命令：`npm run build`
- 产物目录：`dist/`
