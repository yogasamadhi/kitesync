import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

async function inventory(
  root: string,
  relative = '',
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const result: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, item.name);
    if (item.isDirectory()) result.push(...(await inventory(root, path)));
    else if (item.isFile()) {
      const content = await readFile(join(root, path));
      result.push({
        path,
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  return result;
}

export async function localSnapshot(source: string, destination: string) {
  await mkdir(destination, { recursive: true });
  const revision = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const temporary = join(destination, `.partial-${revision}`);
  const final = join(destination, revision);
  await rm(temporary, { recursive: true, force: true });
  await cp(source, join(temporary, 'data'), { recursive: true, preserveTimestamps: true });
  const files = await inventory(join(temporary, 'data'));
  await writeFile(
    join(temporary, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        revision,
        source: basename(source),
        createdAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    ),
  );
  await rename(temporary, final);
  return {
    revision,
    path: final,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}
