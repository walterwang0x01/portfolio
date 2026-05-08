import { defineCollection, z } from 'astro:content';

// 博客文章集合：frontmatter schema 在这里钉死
// 写错字段或日期格式，构建直接报错
const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string().min(1).max(120),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    excerpt: z.string().min(1).max(400),
    // 封面图：可选。URL 或相对路径。没填就渲染渐变+emoji 自动封面
    cover: z.string().optional(),
    // 自动封面上显示的 emoji，不填会根据首个 tag 自动匹配
    emoji: z.string().optional(),
    // 预留：未来 VIP 文章设 true，构建期分流到受保护路径
    vip: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
