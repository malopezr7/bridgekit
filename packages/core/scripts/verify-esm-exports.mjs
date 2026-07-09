import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));

const exportedImportPaths = Object.entries(packageJson.exports ?? {})
  .flatMap(([subpath, value]) => {
    if (typeof value === 'string') {
      return [];
    }

    const importPath = value?.import;

    if (typeof importPath !== 'string') {
      return [];
    }

    return [{ subpath, importPath }];
  })
  .filter(
    ({ importPath }) => importPath.startsWith('./dist/module/') && importPath.endsWith('.js'),
  );

if (exportedImportPaths.length === 0) {
  throw new Error('No ESM export subpaths found in package.json.');
}

const failures = [];

for (const { subpath, importPath } of exportedImportPaths) {
  const modulePath = path.join(packageRoot, importPath);

  try {
    await import(pathToFileURL(modulePath).href);
  } catch (error) {
    failures.push({ subpath, importPath, error });
  }
}

if (failures.length > 0) {
  const summary = failures
    .map(({ subpath, importPath, error }) => {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return `- ${subpath} (${importPath}): ${reason}`;
    })
    .join('\n');

  throw new Error(`ESM export verification failed:\n${summary}`);
}

console.log(`Verified ${exportedImportPaths.length} ESM export subpaths.`);
