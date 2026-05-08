import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const base = import.meta.env.BASE_URL; // 形如 "/portfolio/"（Astro 保证带结尾斜杠）
  // channel link 必须是博客真实首页：site + base 且以 / 结尾，否则相对链接会吃掉 base 段
  const siteUrl = new URL(base, context.site!).toString();
  const siteWithSlash = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  return rss({
    title: "Walter's Tech Blog",
    description: 'AI Agent、工程实践、系统设计',
    site: siteWithSlash,
    // 浏览器打开时用这个样式渲染；RSS 阅读器会忽略它只读数据
    stylesheet: `${base}rss-style.xsl`,
    items: posts
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .map((p) => ({
        title: p.data.title,
        pubDate: p.data.date,
        description: p.data.excerpt,
        categories: p.data.tags,
        link: `posts/${p.slug}/`,
      })),
  });
}
