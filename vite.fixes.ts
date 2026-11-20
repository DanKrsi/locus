// Small fixes to libraries we bundle, made as the bundle is built (so a reinstall can't lose them).
import type { Plugin } from 'vite';

/**
 * pptx-preview gives every chart without a title the Chinese words for "Chart title", drawn above
 * the chart. PowerPoint shows no title there, so neither do we.
 */
export function libraryFixes(): Plugin {
  return {
    name: 'locus-library-fixes',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]pptx-preview[\\/]/.test(id) || !code.includes('"图表标题"')) return null;
      return { code: code.replace('||"图表标题"', '||""'), map: null };
    },
  };
}
