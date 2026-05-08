import { getCollection } from 'astro:content';
import { OGImageRoute } from 'astro-og-canvas';

const posts = await getCollection('blog', ({ data }) => !data.draft);

// 路由参数 slug → 页面 frontmatter 的映射
const pages = Object.fromEntries(
  posts.map((p) => [
    p.slug,
    {
      title: p.data.title,
      description: p.data.excerpt,
      tags: p.data.tags,
    },
  ]),
);

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'slug',
  pages,
  getImageOptions: (_path, page) => ({
    title: page.title,
    description: page.description,
    bgGradient: [
      [11, 13, 16],
      [24, 27, 33],
    ],
    border: {
      color: [96, 165, 250],
      width: 6,
      side: 'inline-start',
    },
    padding: 72,
    font: {
      title: {
        families: ['Noto Sans SC', 'Noto Sans'],
        weight: 'Bold',
        size: 64,
        color: [241, 245, 249],
        lineHeight: 1.25,
      },
      description: {
        families: ['Noto Sans SC', 'Noto Sans'],
        weight: 'Normal',
        size: 28,
        color: [148, 163, 184],
        lineHeight: 1.5,
      },
    },
    fonts: [
      './public/fonts/NotoSansSC-Bold.otf',
      './public/fonts/NotoSansSC-Regular.otf',
    ],
  }),
});
