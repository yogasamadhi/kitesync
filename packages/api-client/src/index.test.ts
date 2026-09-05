import { describe, expect, it, vi } from 'vitest';
import { ApiError, KiteSyncApiClient } from './index.js';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('KiteSyncApiClient', () => {
  it('使用 Cookie session，并为写请求附加 CSRF token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          authenticated: true,
          csrfToken: 'csrf-token-123456',
          expiresAt: '2026-09-04T10:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        response({
          nodeName: '书房电脑',
          lanAccessEnabled: false,
          allowedOrigins: [],
          trustedProxies: [],
          versioningDays: 30,
          uiPort: 3210,
        }),
      );
    const client = new KiteSyncApiClient('http://127.0.0.1:3210/', fetchMock);

    await client.session();
    await client.updateSettings({ nodeName: '新名称' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:3210/api/v1/settings',
      expect.objectContaining({
        method: 'PATCH',
        credentials: 'include',
        body: JSON.stringify({ nodeName: '新名称' }),
      }),
    );
    const init = fetchMock.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-token-123456');
  });

  it('对文件和目录列表发送受限分页参数', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ path: '', parentPath: null, items: [], nextCursor: null }))
      .mockResolvedValueOnce(
        response({
          current: { id: 'dir-root', label: '图片' },
          parentId: null,
          items: [],
          nextCursor: null,
        }),
      );
    const client = new KiteSyncApiClient('', fetchMock);

    await client.folderFiles('photos', '', { limit: 50, cursor: 'next page' });
    await client.directories('dir-root', { cursor: '2' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/folders/photos/files?path=&limit=50&cursor=next+page',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/v1/directories?parentId=dir-root&limit=100&cursor=2',
    );
  });

  it('通过受 CSRF 保护的本机接口打开系统目录选择器', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          authenticated: true,
          csrfToken: 'csrf-token-123456',
          expiresAt: '2026-09-04T10:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(response({ id: 'opaque-handle', label: 'Music' }));
    const client = new KiteSyncApiClient('', fetchMock);

    await client.session();
    await expect(client.pickDirectory()).resolves.toEqual({ id: 'opaque-handle', label: 'Music' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/directories/select',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe(
      'csrf-token-123456',
    );
  });

  it('更新设备时使用指定设备路由', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH',
        name: '书房电脑',
        addresses: ['dynamic'],
        connected: false,
        paused: true,
        lastSeenAt: null,
      }),
    );
    const client = new KiteSyncApiClient('', fetchMock);

    await client.updateDevice('AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', {
      paused: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/devices/AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ paused: true }) }),
    );
  });

  it('读取节点健康状态', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ status: 'ok' }));
    const client = new KiteSyncApiClient('http://localhost:3210', fetchMock);

    await expect(client.health()).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3210/api/v1/health',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('保留 Problem Details 供界面显示', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          type: 'about:blank',
          title: '请求无效',
          status: 400,
          detail: '该目录已经同步',
          traceId: 'trace-1',
          code: 'FOLDER_EXISTS',
        },
        400,
      ),
    );
    const client = new KiteSyncApiClient('', fetchMock);

    const error = await client.folders().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: 'ApiError',
      status: 400,
      message: '该目录已经同步',
    });
  });

  it('服务重启导致会话失效时通知界面并清除 CSRF token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          authenticated: true,
          csrfToken: 'csrf-token-123456',
          expiresAt: '2099-09-04T10:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        response(
          {
            type: 'about:blank',
            title: '请求失败',
            status: 401,
            traceId: 'trace-restart',
            code: 'authentication_required',
          },
          401,
        ),
      )
      .mockResolvedValueOnce(
        response({
          nodeName: '书房电脑',
          lanAccessEnabled: false,
          allowedOrigins: [],
          trustedProxies: [],
          versioningDays: 30,
          uiPort: 3210,
        }),
      );
    const client = new KiteSyncApiClient('', fetchMock);
    const unauthorized = vi.fn();
    client.onUnauthorized(unauthorized);

    await client.session();
    await expect(client.devices()).rejects.toMatchObject({ status: 401 });
    await client.updateSettings({ nodeName: '新名称' });

    expect(unauthorized).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has('X-CSRF-Token')).toBe(false);
  });

  it('密码错误不会被误报为已有会话失效', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        {
          type: 'about:blank',
          title: '请求失败',
          status: 401,
          traceId: 'trace-login',
          code: 'invalid_credentials',
        },
        401,
      ),
    );
    const client = new KiteSyncApiClient('', fetchMock);
    const unauthorized = vi.fn();
    client.onUnauthorized(unauthorized);

    await expect(client.login({ password: 'wrong' })).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
