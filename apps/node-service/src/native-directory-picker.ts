import { spawn } from 'node:child_process';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DirectoryPickerCommand = (file: string, args: string[]) => Promise<CommandResult>;

const runCommand: DirectoryPickerCommand = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.once('error', reject);
    child.once('exit', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });

export function supportsNativeDirectoryPicker(platform: NodeJS.Platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

export async function pickNativeDirectory(
  platform: NodeJS.Platform = process.platform,
  execute: DirectoryPickerCommand = runCommand,
) {
  let result: CommandResult;
  if (platform === 'darwin') {
    const script = [
      'try',
      'set selectedFolder to choose folder with prompt "选择 KiteSync 同步文件夹"',
      'return POSIX path of selectedFolder',
      'on error number -128',
      'return ""',
      'end try',
    ];
    result = await execute(
      'osascript',
      script.flatMap((line) => ['-e', line]),
    );
    result.stdout = result.stdout.replace(/\r?\n$/, '');
  } else if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Windows.Forms.Application]::EnableVisualStyles()',
      '$dialog=New-Object Windows.Forms.FolderBrowserDialog',
      "$dialog.Description='选择 KiteSync 同步文件夹'",
      '$dialog.ShowNewFolderButton=$true',
      'try {',
      'if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {',
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
      '[Console]::Out.Write($dialog.SelectedPath)',
      '}',
      '} finally { $dialog.Dispose() }',
    ].join(';');
    result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', script]);
  } else {
    throw new Error('当前平台不支持系统目录选择器');
  }

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `系统目录选择器退出 ${result.code}`);
  }
  return result.stdout || undefined;
}
