# Walter's Tech Blog

AI Agent、RAG、Context Engineering、MCP 协议等前沿技术深度文章，基于 400+ 篇开源技术笔记。

🔗 **在线预览**：<https://walterwang0x01.github.io/portfolio/>
📡 **RSS 订阅**：<https://walterwang0x01.github.io/portfolio/rss.xml>

## 仓库结构

这个仓库包含**新旧两套实现**：

```
portfolio/
├── astro-site/          ← 当前线上版（Astro + Markdown，生产环境）
│   ├── src/             # 文章源码 + 组件
│   ├── public/          # 静态资源
│   └── README.md        # Astro 站点说明
│
├── index.html           ← 老版纯 HTML 单页（已下线，保留备份）
├── briefing.html        ← 老版每日科技简报页面
├── kiro-sharing.html    ← Kiro 编码实战分享页（独立长文）
├── shared.css           ← 老版公共样式
├── rss.xml / sitemap.xml / robots.txt
└── .github/workflows/deploy.yml   # GitHub Actions：astro-site 自动部署
```

线上访问的是 `astro-site/` 构建产物；根目录的 HTML 文件是博客早期纯 HTML 版的备份。

## 技术栈

- **Astro** + **Markdown** + **TypeScript**
- **Tailwind CSS** 样式
- **GitHub Actions** 自动部署到 **GitHub Pages**

## 特性

- 📝 **博客系统**：Markdown 写作、tag 筛选、搜索、目录导航、阅读时长
- 🌗 **深色 / 浅色模式**：跟随系统 + 手动切换
- 📱 **响应式布局**：手机、平板、桌面三套适配
- 📡 **RSS 订阅**：自动从 Markdown 生成 `rss.xml`
- 🔍 **SEO**：sitemap、Open Graph、Twitter Card、结构化元数据
- ♿ **无障碍**：键盘导航、ARIA、skip-link
- 📊 **访问统计**：51.la + 不蒜子（延迟加载，不阻塞首屏）

## 本地开发

```bash
cd astro-site
npm install
npm run dev          # 启动开发服务器（http://localhost:4321）
npm run build        # 生产构建到 dist/
npm run migrate      # 从老版 index.html 抽出文章 → Markdown（一次性迁移工具）
```

写新文章：

```bash
# 在 astro-site/src/content/blog/ 下新建 .md 文件
# Frontmatter:
---
title: "文章标题"
date: 2026-05-24
tags: [AI Agent, MCP]
excerpt: "摘要，会出现在列表页和 RSS"
vip: false       # 是否会员可见
draft: false     # 是否草稿
---
```

## 部署

push 到 `main` 分支时，GitHub Actions 自动：

1. `npm ci`
2. `npm run build`（在 `astro-site/`）
3. 把 `astro-site/dist/` 上传到 GitHub Pages

部署日志：<https://github.com/walterwang0x01/portfolio/actions>

## 相关项目

- **[lark-kiro-bridge](https://github.com/walterwang0x01/lark-kiro-bridge)** — 把 Kiro CLI 接到飞书，本仓库的 `kiro-sharing.html` 介绍这个项目的设计
- 博客文章里的代码示例 → [GitHub Gists](https://gist.github.com/walterwang0x01)

## License

文章内容：CC BY-NC-SA 4.0（非商业用途可转载，须署名）
代码部分：MIT
