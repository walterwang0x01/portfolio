import { OGImageRoute } from 'astro-og-canvas';

/**
 * 静态页面的 OG 图（知识库 / 可视化 / 简报 / 读书）
 *
 * 博客文章的 OG 图走 og/[...slug].ts（从 content collection 取数据），
 * 这些页面不在 collection 里，所以单独一个路由。
 * 产出路径：/og-page/{key}.png
 */
const pages = {
  notes: {
    title: 'AI 知识库',
    description: '171 篇原创笔记 · 198 道自测题 · 从反向传播推导到生产级 Agent 系统',
  },
  demos: {
    title: 'AI 原理可视化',
    description: '注意力热力图 · 反向传播梯度流 · KV Cache 显存 · TIES 模型合并 — 4 个可交互演示',
  },
  briefing: {
    title: '每日技术简报',
    description: 'AI Agent · 国内科技 · 国际科技 — 自动化采集，每日精选',
  },
  reading: {
    title: '读书收藏',
    description: '第三方技术书籍收藏 + 我的阅读笔记',
  },
};

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'page',
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
        size: 68,
        color: [241, 245, 249],
        lineHeight: 1.25,
      },
      description: {
        families: ['Noto Sans SC', 'Noto Sans'],
        weight: 'Normal',
        size: 30,
        color: [148, 163, 184],
        lineHeight: 1.5,
      },
    },
    fonts: [
      './build-assets/fonts/NotoSansSC-Bold.otf',
      './build-assets/fonts/NotoSansSC-Regular.otf',
    ],
  }),
});
