import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  const base = import.meta.env.BASE_URL;
  return rss({
    title: "Walter's Tech Blog",
    description: 'AI Agent、工程实践、系统设计',
    site: context.site!,
    // 浏览器打开时用这个样式渲染；RSS 阅读器会忽略它只读数据
    stylesheet: `${base}rss-style.xsl`,
    items: posts
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .map((p) => ({
        title: p.data.title,
        pubDate: p.data.date,
        description: p.data.excerpt,
        categories: p.data.tags,
        link: `${base}posts/${p.slug}/`,
      })),
  });
}
