<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <xsl:output method="html" encoding="UTF-8" indent="yes" doctype-system="about:legacy-compat" />
  <xsl:template match="/">
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="robots" content="noindex" />
        <title>
          <xsl:value-of select="rss/channel/title" /> — RSS 订阅
        </title>
        <style>
          :root {
            --bg: #fafaf9;
            --card: #ffffff;
            --text: #1c1917;
            --text-2: #44403c;
            --muted: #78716c;
            --border: #e7e5e4;
            --primary: #2563eb;
            --accent: #6366f1;
            --soft: #eff6ff;
          }
          @media (prefers-color-scheme: dark) {
            :root {
              --bg: #0b0d10;
              --card: #13161b;
              --text: #f1f5f9;
              --text-2: #cbd5e1;
              --muted: #94a3b8;
              --border: #262a31;
              --primary: #60a5fa;
              --accent: #818cf8;
              --soft: rgba(96, 165, 250, 0.12);
            }
          }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro SC",
              "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.7;
            min-height: 100vh;
          }
          .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
          .hero {
            padding: 28px 24px;
            border-radius: 18px;
            background:
              radial-gradient(ellipse 80% 100% at 50% 0%, var(--soft), transparent 65%),
              var(--card);
            border: 1px solid var(--border);
            position: relative;
            overflow: hidden;
            margin-bottom: 24px;
          }
          .hero::before {
            content: "";
            position: absolute; top: 0; left: 0; right: 0; height: 3px;
            background: linear-gradient(90deg, var(--primary), var(--accent));
          }
          .eyebrow {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 4px 10px;
            border-radius: 999px;
            background: var(--soft);
            color: var(--primary);
            font-size: 12px; font-weight: 500;
            border: 1px solid var(--border);
            margin-bottom: 12px;
          }
          h1 {
            font-size: clamp(22px, 4vw, 30px);
            letter-spacing: -0.02em;
            margin-bottom: 8px;
            font-weight: 700;
          }
          .desc {
            color: var(--muted);
            font-size: 15px;
            margin-bottom: 16px;
          }
          .tip {
            font-size: 13px;
            color: var(--text-2);
            background: var(--bg);
            padding: 12px 14px;
            border-left: 3px solid var(--primary);
            border-radius: 0 8px 8px 0;
          }
          .tip b { color: var(--text); }
          .tip code {
            padding: 2px 6px;
            background: var(--soft);
            color: var(--primary);
            border-radius: 4px;
            font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
            font-size: 0.9em;
          }
          .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
          .btn {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 8px 14px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--card);
            color: var(--text);
            text-decoration: none;
            font-size: 14px; font-weight: 500;
            transition: border-color 0.18s, background 0.18s;
          }
          .btn:hover { border-color: var(--primary); background: var(--soft); color: var(--primary); }
          .btn.primary {
            background: linear-gradient(135deg, var(--primary), var(--accent));
            color: #fff; border-color: transparent;
          }
          .btn.primary:hover { filter: brightness(1.05); color: #fff; }
          .section-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            margin: 32px 0 14px;
          }
          .item {
            display: block;
            padding: 16px 18px;
            margin-bottom: 10px;
            border: 1px solid var(--border);
            border-radius: 14px;
            background: var(--card);
            text-decoration: none;
            color: inherit;
            transition: transform 0.18s, border-color 0.18s, box-shadow 0.18s;
          }
          .item:hover {
            transform: translateY(-1px);
            border-color: var(--primary);
            box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
          }
          .item h2 {
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 6px;
            letter-spacing: -0.01em;
            color: var(--text);
          }
          .item .meta { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
          .item .excerpt {
            font-size: 13.5px;
            color: var(--text-2);
            line-height: 1.6;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .tags { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
          .tag {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--soft);
            color: var(--primary);
            font-weight: 500;
          }
          footer {
            margin-top: 40px;
            text-align: center;
            color: var(--muted);
            font-size: 13px;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <section class="hero">
            <div class="eyebrow">📡 RSS Feed</div>
            <h1><xsl:value-of select="rss/channel/title" /></h1>
            <p class="desc"><xsl:value-of select="rss/channel/description" /></p>
            <div class="tip">
              <b>什么是 RSS？</b>用 RSS 阅读器订阅这个地址，新文章自动推送给你，无需每天来刷网站。
              推荐阅读器：<code>Feedly</code> / <code>Inoreader</code> / <code>NetNewsWire</code> / <code>Readwise Reader</code>。
            </div>
            <div class="actions">
              <a class="btn primary">
                <xsl:attribute name="href">
                  <xsl:value-of select="rss/channel/link" />
                </xsl:attribute>
                ← 回到博客
              </a>
              <a class="btn" href="https://feedly.com/i/discover/sources/search/feed/">
                用 Feedly 订阅
              </a>
            </div>
          </section>

          <div class="section-title">最新文章 · <xsl:value-of select="count(rss/channel/item)" /> 篇</div>

          <xsl:for-each select="rss/channel/item">
            <a class="item">
              <xsl:attribute name="href">
                <xsl:value-of select="link" />
              </xsl:attribute>
              <h2><xsl:value-of select="title" /></h2>
              <div class="meta">
                <xsl:value-of select="substring(pubDate, 1, 16)" />
              </div>
              <p class="excerpt"><xsl:value-of select="description" /></p>
              <div class="tags">
                <xsl:for-each select="category">
                  <span class="tag"><xsl:value-of select="." /></span>
                </xsl:for-each>
              </div>
            </a>
          </xsl:for-each>

          <footer>
            这是一个 RSS 订阅源 · 复制此页 URL 粘贴到 RSS 阅读器即可订阅
          </footer>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
