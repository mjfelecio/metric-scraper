import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOTS = ['src/core/capacity', 'src/web/capacity'];

describe('capacity page structure', () => {
  it('is a configured second Vite entry', async () => {
    const config = await readFile('vite.config.ts', 'utf8');
    expect(config).toContain("capacity: path.resolve(projectRoot, 'src/web/capacity/index.html')");
  });

  it('has no network primitives or dashboard API imports', async () => {
    const source = (await Promise.all(ROOTS.map(readTree))).flat().join('\n');
    for (const forbidden of [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bEventSource\b/,
      /from\s+['"]\.\.\/api\.js['"]/,
      /from\s+['"].*web\/api\.js['"]/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('uses progressive contextual help instead of a detached documentation wall', async () => {
    const page = await readFile('src/web/capacity/index.html', 'utf8');
    expect(page).toContain('Planning snapshot');
    expect(page).toContain('Keep these units separate');
    expect(page).toContain('Throughput is not concurrency');
    expect(page).toContain('Why theoretical and recommended counts differ');
    expect(page).toContain('Provenance badge meanings');
    expect(page.match(/class="section-purpose"/g)?.length).toBeGreaterThanOrEqual(14);
    expect(page.match(/class="explanation/g)?.length).toBeGreaterThanOrEqual(12);
    expect(page).not.toContain('<h2>Documentation</h2>');
  });
});

async function readTree(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? readTree(target) : [await readFile(target, 'utf8')];
      }),
    )
  ).flat();
}
