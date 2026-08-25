import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../src/main/preload.cts', import.meta.url), 'utf8');

describe('Electron bootstrap', () => {
  it('does not block the first event-loop tick while waiting for app readiness', () => {
    expect(mainSource).not.toMatch(/await\s+app\.whenReady\s*\(\s*\)/);
    expect(mainSource).toMatch(/app\s*\.whenReady\s*\(\s*\)\s*\.then\s*\(startApplication\)/s);
  });

  it('loads the sandboxed preload as CommonJS', () => {
    expect(mainSource).toContain("'preload.cjs'");
    expect(preloadSource).toMatch(/import\s+electron\s*=\s*require\(['"]electron['"]\)/);
    expect(preloadSource).not.toMatch(/import\s+\{[^}]+\}\s+from\s+['"]electron['"]/s);
  });
});
