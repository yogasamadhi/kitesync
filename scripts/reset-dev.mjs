import { rm } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';

const developmentState = resolve('.kitesync-dev');
let confirmed = process.argv.includes('--yes');

if (!confirmed) {
  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question(
    `这会删除本仓库的 KiteSync 开发节点身份和设置：${developmentState}\n输入 RESET 继续：`,
  );
  prompt.close();
  confirmed = answer === 'RESET';
}

if (!confirmed) {
  console.log('已取消。');
  process.exitCode = 1;
} else {
  await rm(developmentState, { recursive: true, force: true });
  console.log(`已删除 ${developmentState}。同步目录和可选 Docker volumes 未被修改。`);
}
