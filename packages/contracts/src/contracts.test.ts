import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CreateFolderRequestSchema,
  DeviceIdSchema,
  FolderIdSchema,
  FolderFileSchema,
  FolderSchema,
  HealthSchema,
  NodeSettingsSchema,
  SetupRequestSchema,
  RelativePathSchema,
  UpdateDeviceRequestSchema,
  UpdateNodeSettingsSchema,
} from './index.js';

describe('统一节点契约', () => {
  it('接受健康状态', () => {
    expect(Value.Check(HealthSchema, { status: 'ok' })).toBe(true);
  });

  it('首次设置要求至少十二位密码', () => {
    expect(Value.Check(SetupRequestSchema, { password: 'too-short' })).toBe(false);
    expect(Value.Check(SetupRequestSchema, { password: 'correct-horse-battery' })).toBe(true);
  });

  it('只允许显式 HTTPS 来源', () => {
    const settings = {
      nodeName: '书房电脑',
      lanAccessEnabled: true,
      allowedOrigins: ['https://sync.example.test'],
      trustedProxies: ['192.168.1.2'],
      versioningDays: 30,
      uiPort: 3210,
    };

    expect(Value.Check(NodeSettingsSchema, settings)).toBe(true);
    expect(
      Value.Check(NodeSettingsSchema, {
        ...settings,
        allowedOrigins: ['https://sync.example.test/'],
      }),
    ).toBe(true);
    expect(
      Value.Check(NodeSettingsSchema, {
        ...settings,
        allowedOrigins: ['http://sync.example.test'],
      }),
    ).toBe(false);
    expect(
      Value.Check(NodeSettingsSchema, {
        ...settings,
        allowedOrigins: ['https://sync.example.test/admin?token=no'],
      }),
    ).toBe(false);
    expect(
      Value.Check(NodeSettingsSchema, {
        ...settings,
        trustedProxies: ['proxy.example.test'],
      }),
    ).toBe(false);
    expect(
      Value.Check(NodeSettingsSchema, {
        ...settings,
        trustedProxies: ['loopback', '10.0.0.0/8', 'fd00::/8'],
      }),
    ).toBe(true);
  });

  it('不暴露全局发现、Relay 或 NAT 开关', () => {
    expect(Object.keys(UpdateNodeSettingsSchema.properties)).toEqual([
      'nodeName',
      'lanAccessEnabled',
      'allowedOrigins',
      'trustedProxies',
      'versioningDays',
    ]);
    expect(
      Value.Check(UpdateNodeSettingsSchema, {
        globalDiscoveryEnabled: true,
      }),
    ).toBe(false);
  });

  it('创建文件夹只接受本机签发的不透明目录标识', () => {
    expect(
      Value.Check(CreateFolderRequestSchema, {
        label: '照片',
        directoryId: 'dir_01JABCDEF',
        deviceIds: [],
        type: 'sendreceive',
      }),
    ).toBe(true);
    expect(
      Value.Check(CreateFolderRequestSchema, {
        label: '照片',
        directoryId: 'dir_01JABCDEF',
        path: '/Users/example/Pictures',
      }),
    ).toBe(false);
    expect(Object.keys(FolderSchema.properties)).not.toContain('path');
    expect(Object.keys(FolderSchema.properties)).toContain('pathLabel');
  });

  it('设备更新支持名称、地址和暂停状态', () => {
    expect(Value.Check(UpdateDeviceRequestSchema, { name: '书房电脑' })).toBe(true);
    expect(Value.Check(UpdateDeviceRequestSchema, { addresses: [], paused: false })).toBe(true);
    expect(
      Value.Check(UpdateDeviceRequestSchema, {
        addresses: ['tcp://192.168.1.20:22000', 'quic://[fd00::20]:22000'],
      }),
    ).toBe(true);
    expect(Value.Check(UpdateDeviceRequestSchema, {})).toBe(false);
    expect(Value.Check(UpdateDeviceRequestSchema, { addresses: ['not-an-address'] })).toBe(false);
    expect(Value.Check(UpdateDeviceRequestSchema, { addresses: ['dynamic'] })).toBe(false);
  });

  it('设备身份必须是完整 Device ID，并允许服务端规范化小写输入', () => {
    const id = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
    expect(Value.Check(DeviceIdSchema, id)).toBe(true);
    expect(Value.Check(DeviceIdSchema, id.toLowerCase())).toBe(true);
    expect(Value.Check(DeviceIdSchema, 'AAAAAAA-BBBBBBB')).toBe(false);
  });

  it('文件夹 ID 保留 Syncthing 兼容字符，但拒绝路径和控制字符', () => {
    expect(Value.Check(FolderIdSchema, '照片-2026.backup@example')).toBe(true);
    expect(Value.Check(FolderIdSchema, '.')).toBe(false);
    expect(Value.Check(FolderIdSchema, '..')).toBe(false);
    expect(Value.Check(FolderIdSchema, 'parent/child')).toBe(false);
    expect(Value.Check(FolderIdSchema, 'parent\\child')).toBe(false);
    expect(Value.Check(FolderIdSchema, 'folder\nheader')).toBe(false);
  });

  it('文件 DTO 只能携带相对路径，不能泄漏绝对路径或父目录跳转', () => {
    expect(Value.Check(RelativePathSchema, '')).toBe(true);
    expect(Value.Check(RelativePathSchema, '照片/海边.jpg')).toBe(true);
    expect(Value.Check(RelativePathSchema, '../secret.txt')).toBe(false);
    expect(Value.Check(RelativePathSchema, '照片/../secret.txt')).toBe(false);
    expect(Value.Check(RelativePathSchema, '/Users/example/secret.txt')).toBe(false);
    expect(Value.Check(RelativePathSchema, 'C:\\Users\\example\\secret.txt')).toBe(false);
    expect(
      Value.Check(FolderFileSchema, {
        name: 'secret.txt',
        path: '/Users/example/secret.txt',
        type: 'file',
        size: 1,
        modifiedAt: '2026-09-03T10:00:00.000Z',
      }),
    ).toBe(false);
  });
});
