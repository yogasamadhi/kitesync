import { describe, expect, it, vi } from 'vitest';
import { pickNativeDirectory, supportsNativeDirectoryPicker } from './native-directory-picker.js';

describe('系统目录选择器', () => {
  it('在 macOS 使用系统目录面板并区分取消操作', async () => {
    const execute = vi.fn(async () => ({ code: 0, stdout: '/Users/alice/Music\n', stderr: '' }));
    await expect(pickNativeDirectory('darwin', execute)).resolves.toBe('/Users/alice/Music');
    expect(execute).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([expect.stringContaining('choose folder')]),
    );

    execute.mockResolvedValueOnce({ code: 0, stdout: '\n', stderr: '' });
    await expect(pickNativeDirectory('darwin', execute)).resolves.toBeUndefined();
  });

  it('在 Windows 使用 STA 系统文件夹选择对话框', async () => {
    const execute = vi.fn(async () => ({ code: 0, stdout: 'D:\\Media\\Music', stderr: '' }));
    await expect(pickNativeDirectory('win32', execute)).resolves.toBe('D:\\Media\\Music');
    expect(execute).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-STA', expect.stringContaining('FolderBrowserDialog')]),
    );
  });

  it('只向 macOS 与 Windows 桌面提供系统选择器', () => {
    expect(supportsNativeDirectoryPicker('darwin')).toBe(true);
    expect(supportsNativeDirectoryPicker('win32')).toBe(true);
    expect(supportsNativeDirectoryPicker('linux')).toBe(false);
  });
});
