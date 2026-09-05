import { expect, test, type Page, type Route } from '@playwright/test';

const localId = 'LOCALAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const peerId = 'PEERAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const otherId = 'OTHERAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const ignoredId = 'IGNOREA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const now = '2026-09-03T10:00:00.000Z';

const session = {
  authenticated: true,
  csrfToken: 'csrf-token-1234567890',
  expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
};

const node = {
  deviceId: localId,
  fingerprint: 'LOCALAA',
  name: '书房 Mac',
  platform: 'macos',
  version: '1.0.0',
  syncthingVersion: 'v2.1.3',
  startedAt: now,
  setupRequired: false,
  listenAddresses: ['tcp://0.0.0.0:22000'],
  localDiscoveryEnabled: true,
  connectedPeers: 1,
  canRevealFiles: true,
  canPickDirectories: true,
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installBaseApi(
  page: Page,
  options: { setupRequired?: boolean; authenticated?: boolean } = {},
) {
  const setupRequired = options.setupRequired ?? false;
  const authenticated = options.authenticated ?? true;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'GET' && path === '/api/v1/auth/status') {
      return json(route, { setupRequired });
    }
    if (request.method() === 'GET' && path === '/api/v1/auth/session') {
      return authenticated
        ? json(route, session)
        : json(route, { title: '未登录', status: 401 }, 401);
    }
    if (request.method() === 'GET' && path === '/api/v1/node') return json(route, node);
    if (request.method() === 'GET' && path === '/api/v1/devices') return json(route, { items: [] });
    if (request.method() === 'GET' && path === '/api/v1/devices/pending') {
      return json(route, { items: [], ignored: [] });
    }
    if (request.method() === 'GET' && path === '/api/v1/folders') return json(route, { items: [] });
    if (request.method() === 'GET' && path === '/api/v1/folders/pending') {
      return json(route, { items: [], ignored: [] });
    }
    return json(route, { message: 'ok' });
  });
}

test('首次启动只要求设置本机管理密码', async ({ page }) => {
  let setupBody: unknown;
  await installBaseApi(page, { setupRequired: true, authenticated: false });
  await page.route('**/api/v1/auth/setup', async (route) => {
    setupBody = route.request().postDataJSON();
    await json(route, session);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '设置管理密码' })).toBeVisible();
  await page.getByLabel('管理密码').fill('correct-horse-battery');
  await page.getByLabel('再次输入密码').fill('different-password');
  await page.getByRole('button', { name: '完成设置' }).click();
  await expect(page.getByText('两次输入的密码不一致')).toBeVisible();

  await page.getByLabel('再次输入密码').fill('correct-horse-battery');
  await page.getByRole('button', { name: '完成设置' }).click();
  await expect(page.getByRole('heading', { name: '节点总览' })).toBeVisible();
  expect(setupBody).toEqual({ password: 'correct-horse-battery' });
});

test('已有节点可用密码登录', async ({ page }) => {
  let loginBody: unknown;
  await installBaseApi(page, { authenticated: false });
  await page.route('**/api/v1/auth/login', async (route) => {
    loginBody = route.request().postDataJSON();
    await json(route, session);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.getByLabel('管理密码').fill('my-local-password');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '节点总览' })).toBeVisible();
  expect(loginBody).toEqual({ password: 'my-local-password' });
});

test('LAN HTTP 登录页在提交密码前提示流量未加密', async ({ page }) => {
  const publicOrigin = 'http://kitesync.test:5173';
  await page.route(`${publicOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/status') {
      return json(route, { setupRequired: false });
    }
    if (url.pathname === '/api/v1/auth/session') {
      return json(route, { title: '未登录', status: 401 }, 401);
    }
    const localUrl = route.request().url().replace(publicOrigin, 'http://127.0.0.1:5173');
    const response = await page.request.fetch(localUrl);
    await route.fulfill({ response });
  });

  await page.goto(`${publicOrigin}/`);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('当前管理界面使用 HTTP');
});

test('双击启动生成的 hash token 会被交换并立即从地址栏清除', async ({ page }) => {
  let exchangedToken = '';
  let exchangeCount = 0;
  await installBaseApi(page, { authenticated: false });
  await page.route('**/api/v1/auth/open-token', async (route) => {
    exchangeCount += 1;
    exchangedToken = (route.request().postDataJSON() as { token: string }).token;
    await json(
      route,
      exchangeCount === 1
        ? session
        : { title: '令牌已使用', status: 401, code: 'invalid_open_token' },
      exchangeCount === 1 ? 200 : 401,
    );
  });

  await page.goto('/#token=single-use-open-token-1234');
  await expect(page.getByRole('heading', { name: '节点总览' })).toBeVisible();
  expect(exchangedToken).toBe('single-use-open-token-1234');
  expect(exchangeCount).toBe(1);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
});

test('节点管理界面覆盖配对、文件浏览、版本和来源设置', async ({ page }) => {
  let discoveredPairBody: Record<string, unknown> | undefined;
  let unignoredDeviceId = '';
  let settingsPatch: Record<string, unknown> | undefined;
  let settingsIfMatch = '';
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/status') return json(route, { setupRequired: false });
    if (path === '/api/v1/auth/session') return json(route, session);
    if (path === '/api/v1/node') return json(route, node);
    if (path === '/api/v1/devices' && request.method() === 'GET') {
      return json(route, {
        items: [
          {
            id: peerId,
            name: '客厅 Windows',
            addresses: ['tcp://192.168.1.20:22000'],
            connected: true,
            paused: false,
            lastSeenAt: now,
          },
        ],
      });
    }
    if (path === '/api/v1/devices' && request.method() === 'POST') {
      discoveredPairBody = request.postDataJSON() as Record<string, unknown>;
      return json(route, {
        id: otherId,
        name: discoveredPairBody.name,
        addresses: ['dynamic'],
        connected: false,
        paused: false,
        lastSeenAt: null,
      });
    }
    if (path === '/api/v1/devices/discovered') {
      return json(route, {
        items: [{ id: otherId, addresses: ['192.168.1.30'] }],
      });
    }
    if (path === '/api/v1/devices/pending') {
      return json(route, {
        items: [{ id: otherId, name: '新的 Linux', address: '192.168.1.30', seenAt: now }],
        ignored: [
          {
            id: ignoredId,
            name: '旧电脑',
            address: 'dynamic',
            ignoredAt: now,
          },
        ],
      });
    }
    if (request.method() === 'DELETE' && path.startsWith('/api/v1/devices/ignored/')) {
      unignoredDeviceId = decodeURIComponent(path.split('/').at(-1) ?? '');
      return json(route, { message: '已允许重新配对' });
    }
    if (path === '/api/v1/folders' && request.method() === 'GET') {
      return json(route, {
        items: [
          {
            id: 'photos',
            label: '家庭照片',
            pathLabel: '图片 / 家庭照片',
            type: 'sendreceive',
            paused: false,
            deviceIds: [peerId],
            state: 'idle',
            localBytes: 2048,
            globalBytes: 2048,
            needBytes: 0,
            error: null,
            errorCode: null,
            errorCount: 0,
            versioningDays: 30,
          },
        ],
      });
    }
    if (path === '/api/v1/folders/pending') {
      return json(route, {
        items: [
          {
            folderId: 'work',
            label: '工作资料',
            deviceId: peerId,
            deviceName: '客厅 Windows',
            offeredAt: now,
          },
        ],
        ignored: [
          {
            folderId: 'old',
            label: '旧共享',
            deviceId: peerId,
            deviceName: '客厅 Windows',
            ignoredAt: now,
          },
        ],
      });
    }
    if (path === '/api/v1/folders/photos/files') {
      return json(route, {
        path: '',
        parentPath: null,
        items: [
          { name: '旅行', path: '旅行', type: 'directory', size: 0, modifiedAt: now },
          { name: '海边.jpg', path: '海边.jpg', type: 'file', size: 2048, modifiedAt: now },
          { name: '外部链接', path: '外部链接', type: 'symlink', size: 0, modifiedAt: now },
        ],
        nextCursor: null,
      });
    }
    if (path === '/api/v1/folders/photos/versions') {
      return json(route, { items: [{ path: '海边.jpg', versionTime: now, size: 1024 }] });
    }
    if (path === '/api/v1/settings' && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"settings-v1"' },
        body: JSON.stringify({
          nodeName: '书房 Mac',
          lanAccessEnabled: false,
          allowedOrigins: ['https://sync.example.test'],
          trustedProxies: [],
          versioningDays: 30,
          uiPort: 3210,
        }),
      });
    }
    if (path === '/api/v1/settings' && request.method() === 'PATCH') {
      settingsPatch = request.postDataJSON() as Record<string, unknown>;
      settingsIfMatch = request.headers()['if-match'] ?? '';
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"settings-v2"' },
        body: JSON.stringify({
          nodeName: settingsPatch.nodeName ?? '书房 Mac',
          lanAccessEnabled: false,
          allowedOrigins: ['https://sync.example.test'],
          trustedProxies: [],
          versioningDays: 30,
          uiPort: 3210,
        }),
      });
    }
    return json(route, { message: 'ok' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await expect(page.getByRole('heading', { name: '待确认设备' })).toBeVisible();
  await expect(page.getByText('拒绝并忽略')).toBeVisible();
  const pendingCard = page.locator('.request-card').filter({ hasText: '新的 Linux' });
  await expect(pendingCard.getByText(otherId, { exact: true })).toBeVisible();
  await expect(pendingCard.getByText(/短指纹：OTHERA A/)).toBeVisible();
  const discoveredCard = page.locator('.discovered-card').filter({ hasText: '短指纹' });
  await discoveredCard.getByText('查看完整设备 ID').click();
  await expect(discoveredCard.getByText(otherId, { exact: true })).toBeVisible();
  const pairedCard = page.locator('.device-card').filter({ hasText: '客厅 Windows' });
  await expect(pairedCard.getByText(peerId, { exact: true })).toBeVisible();
  await expect(pairedCard.getByText(/短指纹：PEERAA A/)).toBeVisible();
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect.poll(() => discoveredPairBody).toMatchObject({ deviceId: otherId });
  expect(discoveredPairBody).not.toHaveProperty('addresses');

  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  await expect(page.getByText('别人共享给你的文件夹')).toBeVisible();
  const folderOffer = page.locator('.folder-offer-card').filter({ hasText: '工作资料' });
  await expect(folderOffer.getByText(peerId, { exact: true })).toBeVisible();
  await expect(folderOffer.getByText(/来源短指纹：PEERAA A/)).toBeVisible();
  await page.locator('.folder-list-row').filter({ hasText: '家庭照片' }).click();
  await expect(page).toHaveURL(/\/folders\/photos\/files$/);
  await expect(page.getByRole('heading', { name: '家庭照片' })).toBeVisible();
  await expect(page.getByText('海边.jpg', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '下载' })).toHaveAttribute(
    'href',
    /\/api\/v1\/folders\/photos\/download\?path=/,
  );
  await expect(page.getByText('链接不可访问')).toBeVisible();
  await page.getByRole('tab', { name: '历史版本', exact: true }).click();
  await expect(page).toHaveURL(/\/folders\/photos\/versions$/);
  await expect(page.getByRole('button', { name: '恢复此版本' })).toBeVisible();

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '局域网访问' })).toBeVisible();
  await expect(page.getByLabel('允许的 HTTPS 来源')).toHaveValue('https://sync.example.test');
  await page.getByLabel('节点名称').fill('工作室 Mac');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存', { exact: true })).toBeVisible();
  expect(settingsPatch).toEqual({ nodeName: '工作室 Mac' });
  expect(settingsIfMatch).toBe('"settings-v1"');
  await expect(page.getByRole('heading', { name: '已忽略的设备' })).toBeVisible();
  await expect(page.getByText(ignoredId, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许重新配对' }).click();
  await expect.poll(() => unignoredDeviceId).toBe(ignoredId);
  await expect(page.getByRole('heading', { name: '已忽略的文件夹邀请' })).toBeVisible();

  await page.getByLabel('节点名称').fill('尚未保存的名称');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '设备', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);
});

test('选择同步目录后以文件夹名作为可编辑的显示名称', async ({ page }) => {
  let createFolderBody: Record<string, unknown> | undefined;
  await installBaseApi(page);
  await page.route('**/api/v1/directories/select', async (route) => {
    await json(route, { id: 'dir-music', label: 'Music' });
  });
  await page.route('**/api/v1/folders', async (route) => {
    if (route.request().method() === 'POST') {
      createFolderBody = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, {});
    }
    return json(route, { items: [] });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  const displayName = page.getByLabel('显示名称');
  await expect(displayName).toHaveValue('');
  await page.getByRole('button', { name: '浏览' }).click();

  await expect(displayName).toHaveValue('Music');
  await displayName.fill('我的音乐');
  await page.getByRole('button', { name: '创建文件夹' }).click();
  await expect
    .poll(() => createFolderBody)
    .toEqual({
      label: '我的音乐',
      directoryId: 'dir-music',
      type: 'sendreceive',
      deviceIds: [],
    });
});

test('错误文件夹说明原因并提供对应的处理操作', async ({ page }) => {
  let repaired = false;
  await installBaseApi(page);
  const problemFolder = {
    id: 'problem-folder',
    label: '家庭照片',
    pathLabel: '照片',
    type: 'sendreceive',
    paused: false,
    deviceIds: [],
    state: 'error',
    localBytes: 0,
    globalBytes: 0,
    needBytes: 0,
    error:
      '同步安全标记已丢失。请先确认这里仍是原来的同步目录；如果是外接磁盘或网络目录，请先重新连接。确认文件完整后再恢复同步。',
    errorCode: 'marker_missing',
    errorCount: 0,
    versioningDays: 30,
  };
  await page.route('**/api/v1/folders', async (route) => {
    await json(route, { items: [problemFolder] });
  });
  await page.route('**/api/v1/folders/problem-folder/files?*', async (route) => {
    await json(route, { path: '', parentPath: null, items: [], nextCursor: null });
  });
  await page.route('**/api/v1/folders/problem-folder/repair-marker', async (route) => {
    repaired = true;
    await json(route, { ...problemFolder, state: 'idle', error: null, errorCode: null });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  await expect(page.getByText('目录需确认')).toBeVisible();
  await page.locator('.folder-list-row').filter({ hasText: '家庭照片' }).click();
  await expect(page.getByText('请先确认同步目录')).toBeVisible();
  await expect(page.getByText(/同步安全标记已丢失/)).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '确认目录无误并恢复' }).click();
  await expect.poll(() => repaired).toBe(true);
});

test('Node Service 重启使内存会话失效后自动返回登录页', async ({ page }) => {
  let restarted = false;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/status') return json(route, { setupRequired: false });
    if (path === '/api/v1/auth/session') return json(route, session);
    if (restarted) {
      return json(
        route,
        {
          type: 'about:blank',
          title: '请求失败',
          status: 401,
          traceId: 'trace-restart',
          code: 'authentication_required',
        },
        401,
      );
    }
    if (path === '/api/v1/node') return json(route, node);
    if (path === '/api/v1/devices') return json(route, { items: [] });
    if (path === '/api/v1/devices/pending') return json(route, { items: [], ignored: [] });
    if (path === '/api/v1/folders') return json(route, { items: [] });
    if (path === '/api/v1/folders/pending') return json(route, { items: [], ignored: [] });
    return json(route, { message: 'ok' });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '节点总览' })).toBeVisible();
  restarted = true;
  // A stale background query may observe the simulated restart before this line and already
  // unmount the dashboard. Click synchronously when the button still exists; either timing must
  // converge on the login page without Playwright retrying an intentionally detached element.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === '刷新状态',
    );
    button?.click();
  });
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
});

test('只读文件列表可连续翻页并回退到已浏览页面', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/v1/auth/status') return json(route, { setupRequired: false });
    if (path === '/api/v1/auth/session') return json(route, session);
    if (path === '/api/v1/node') return json(route, node);
    if (path === '/api/v1/devices') return json(route, { items: [] });
    if (path === '/api/v1/devices/pending') return json(route, { items: [], ignored: [] });
    if (path === '/api/v1/folders/pending') return json(route, { items: [], ignored: [] });
    if (path === '/api/v1/folders') {
      return json(route, {
        items: [
          {
            id: 'documents',
            label: '文档',
            pathLabel: '文档',
            type: 'sendreceive',
            paused: false,
            deviceIds: [],
            state: 'idle',
            localBytes: 3,
            globalBytes: 3,
            needBytes: 0,
            error: null,
            errorCode: null,
            errorCount: 0,
            versioningDays: 30,
          },
        ],
      });
    }
    if (path === '/api/v1/folders/documents/files') {
      const cursor = url.searchParams.get('cursor');
      const pageNumber = cursor === 'page-3' ? 3 : cursor === 'page-2' ? 2 : 1;
      return json(route, {
        path: '',
        parentPath: null,
        items: [
          {
            name: `第${pageNumber}页.txt`,
            path: `第${pageNumber}页.txt`,
            type: 'file',
            size: pageNumber,
            modifiedAt: now,
          },
        ],
        nextCursor: pageNumber === 1 ? 'page-2' : pageNumber === 2 ? 'page-3' : null,
      });
    }
    return json(route, { message: 'ok' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '文件夹', exact: true }).click();
  await page.locator('.folder-list-row').filter({ hasText: '文档' }).click();
  await expect(page.getByText('第1页.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('第2页.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByText('第3页.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByText('第2页.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '上一页' }).click();
  await expect(page.getByText('第1页.txt', { exact: true })).toBeVisible();
});

test('文件夹详情按路由恢复且只加载当前目录，390px 保留主要操作', async ({ page }) => {
  let photosRequests = 0;
  let documentsRequests = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await installBaseApi(page);
  const folder = (id: string, label: string) => ({
    id,
    label,
    pathLabel: label,
    type: 'sendreceive',
    paused: false,
    deviceIds: [],
    state: 'idle',
    localBytes: 0,
    globalBytes: 0,
    needBytes: 0,
    error: null,
    errorCode: null,
    errorCount: 0,
    versioningDays: 30,
  });
  await page.route('**/api/v1/folders', async (route) => {
    await json(route, { items: [folder('photos', '照片'), folder('documents', '文档')] });
  });
  await page.route('**/api/v1/folders/photos/files?*', async (route) => {
    photosRequests += 1;
    await json(route, { path: '', parentPath: null, items: [], nextCursor: null });
  });
  await page.route('**/api/v1/folders/documents/files?*', async (route) => {
    documentsRequests += 1;
    await json(route, { path: '', parentPath: null, items: [], nextCursor: null });
  });

  await page.goto('/folders/photos/files');
  await expect(page.getByRole('heading', { name: '照片' })).toBeVisible();
  await expect.poll(() => photosRequests).toBeGreaterThan(0);
  expect(documentsRequests).toBe(0);

  const tabs = [
    page.getByRole('tab', { name: '文件', exact: true }),
    page.getByRole('tab', { name: '历史版本', exact: true }),
    page.getByRole('tab', { name: '文件夹设置', exact: true }),
  ];
  const boxes = await Promise.all(tabs.map((tab) => tab.boundingBox()));
  expect(new Set(boxes.map((box) => Math.round(box?.y ?? -1))).size).toBe(1);
  await expect(page.getByRole('button', { name: '刷新状态' })).toBeVisible();
  await expect(page.getByRole('button', { name: '锁定', exact: true })).toBeVisible();

  await page.locator('.folder-list-row').filter({ hasText: '文档' }).click();
  await expect(page).toHaveURL(/\/folders\/documents\/files$/);
  await expect.poll(() => documentsRequests).toBeGreaterThan(0);
});

test('浏览器中的会话到期时无需再发请求也会自动返回登录页', async ({ page }) => {
  const expiringSession = { ...session, expiresAt: new Date(Date.now() + 2_000).toISOString() };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/auth/status') return json(route, { setupRequired: false });
    if (path === '/api/v1/auth/session') return json(route, expiringSession);
    if (path === '/api/v1/node') return json(route, node);
    if (path === '/api/v1/devices') return json(route, { items: [] });
    if (path === '/api/v1/devices/pending') return json(route, { items: [], ignored: [] });
    if (path === '/api/v1/folders') return json(route, { items: [] });
    if (path === '/api/v1/folders/pending') return json(route, { items: [], ignored: [] });
    return json(route, { message: 'ok' });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '节点总览' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible({ timeout: 5_000 });
});
