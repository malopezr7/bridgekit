import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && entry !== '__tests__' && entry !== 'node_modules') {
      results.push(...getAllTsFiles(full));
    } else if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('src/contract/ – purity (no react/react-native imports)', () => {
  const contractDir = join(__dirname, '..');

  it('no file imports from react or react-native', () => {
    const files = getAllTsFiles(contractDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // Check for import statements referencing react or react-native
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith('import ') &&
          (trimmed.includes("from 'react'") ||
            trimmed.includes('from "react"') ||
            trimmed.includes("from 'react-native") ||
            trimmed.includes('from "react-native'))
        ) {
          violations.push(`${file}: ${trimmed}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `src/contract/ contains react/react-native imports (purity violation):\n${violations.join('\n')}`,
      );
    }
  });
});
