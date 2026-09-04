import { describe, expect, it } from 'vitest';
import { nodeProxyOptions } from '../vite.config.js';

describe('Vite Node Service 代理', () => {
  it('保留浏览器访问 Vite 时的 Host，使同源 Origin 校验继续有效', () => {
    expect(nodeProxyOptions('http://127.0.0.1:43210')).toEqual({
      target: 'http://127.0.0.1:43210',
      changeOrigin: false,
    });
  });
});
