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
    // 预留：未来 VIP 文章设 true，构建期分流到受保护路径
    vip: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
