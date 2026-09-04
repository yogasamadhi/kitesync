import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isHeadlessEnvironment,
  normalizeSyncthingUrl,
  productionStateDirectory,
  resolveSyncthingBinary,
} from './config.js';

describe('生产状态目录', () => {
  it('升级 Windows 客户端时复用 Electron 的 Syncthing 身份', () => {
    const home = 'C:\\Users\\alice';
    const roaming = 'C:\\Users\\alice\\AppData\\Roaming';
    const legacy = join(roaming, 'KiteSync');
    const existing = new Set([join(legacy, 'syncthing', 'cert.pem')]);
    expect(
      productionStateDirectory({
        platform: 'win32',
        home,
        environment: {
          APPDATA: roaming,
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        },
        pathExists: (path) => existing.has(path),
      }),
    ).toBe(legacy);
  });

  it('升级 Linux 客户端时复用 XDG config 中的 Syncthing home', () => {
    const home = '/home/alice';
    const legacy = '/home/alice/.config/KiteSync';
    const existing = new Set([join(legacy, 'syncthing', 'config.xml')]);
    expect(
      productionStateDirectory({
        platform: 'linux',
        home,
        environment: {},
        pathExists: (path) => existing.has(path),
      }),
    ).toBe(legacy);
  });

  it('新装使用新的平台状态目录', () => {
    expect(
      productionStateDirectory({
        platform: 'linux',
        home: '/home/alice',
        environment: {},
        pathExists: () => false,
      }),
    ).toBe('/home/alice/.local/state/kitesync');
  });
});

describe('桌面能力检测', () => {
  it('在无 X11/Wayland 会话的 Linux 上隐藏文件管理器操作', () => {
    expect(isHeadlessEnvironment('linux', {})).toBe(true);
    expect(isHeadlessEnvironment('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(isHeadlessEnvironment('linux', { DISPLAY: ':0' })).toBe(false);
    expect(isHeadlessEnvironment('darwin', {})).toBe(false);
    expect(isHeadlessEnvironment('win32', {})).toBe(false);
  });
});

describe('Syncthing sidecar 解析', () => {
  it('编译产物只从主程序旁边解析，不访问源码目录', () => {
    let sourceLookups = 0;
    const path = resolveSyncthingBinary(
      {
        standalone: true,
        executablePath: '/Applications/KiteSync.app/Contents/Resources/kitesync',
        platform: 'darwin',
        arch: 'arm64',
      },
      () => {
        sourceLookups += 1;
        throw new Error('编译产物不应访问源码树');
      },
    );
    expect(path).toBe('/Applications/KiteSync.app/Contents/Resources/syncthing');
    expect(sourceLookups).toBe(0);
  });
});

describe('Syncthing REST 地址', () => {
  it('只允许与 GUI 端口一致的明文 loopback origin', () => {
    expect(normalizeSyncthingUrl('http://127.0.0.2:8385', 8385)).toBe('http://127.0.0.2:8385');
    expect(normalizeSyncthingUrl('http://[::1]:8385/', 8385)).toBe('http://[::1]:8385');
    expect(normalizeSyncthingUrl('http://localhost:8385', 8385)).toBe('http://localhost:8385');
    for (const value of [
      'https://127.0.0.1:8385',
      'http://192.168.1.2:8385',
      'http://user@127.0.0.1:8385',
      'http://127.0.0.1:8385/rest/system/status',
      'http://127.0.0.1:9999',
    ]) {
      expect(() => normalizeSyncthingUrl(value, 8385)).toThrow(/loopback|HTTP|本机/);
    }
  });
});
