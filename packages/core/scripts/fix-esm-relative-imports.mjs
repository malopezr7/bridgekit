import { constants } from 'node:fs';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const moduleRoot = path.resolve(import.meta.dirname, '..', 'dist', 'module');

const importFromPattern = /(\b(?:import|export)\s+[^;'"]*?\s+from\s*)(['"])(\.[^'"]+)\2/g;
const sideEffectImportPattern = /(\bimport\s*)(['"])(\.[^'"]+)\2/g;
const dynamicImportPattern = /(\bimport\s*\(\s*)(['"])(\.[^'"]+)\2(\s*\))/g;

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return listJavaScriptFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function resolveSpecifier(filePath, specifier) {
  const target = path.resolve(path.dirname(filePath), specifier);
  const parsed = path.posix.parse(specifier);

  if (parsed.ext.length > 0) {
    if (await exists(target)) {
      return specifier;
    }

    throw new Error(
      `${path.relative(moduleRoot, filePath)} imports ${specifier}, but ${target} does not exist.`,
    );
  }

  if (await exists(`${target}.js`)) {
    return `${specifier}.js`;
  }

  if (await exists(path.join(target, 'index.js'))) {
    return `${specifier}/index.js`;
  }

  throw new Error(
    `${path.relative(moduleRoot, filePath)} imports ${specifier}, but neither ${target}.js nor ${path.join(
      target,
      'index.js',
    )} exists.`,
  );
}

async function rewritePattern(source, filePath, pattern, replacement) {
  const matches = [...source.matchAll(pattern)];
  let output = source;

  for (const match of matches.toReversed()) {
    const [statement, prefix, quote, specifier, suffix = ''] = match;
    const resolvedSpecifier = await resolveSpecifier(filePath, specifier);
    const rewritten = replacement(prefix, quote, resolvedSpecifier, suffix);
    output = `${output.slice(0, match.index)}${rewritten}${output.slice(match.index + statement.length)}`;
  }

  return output;
}

async function rewriteFile(filePath) {
  const source = await readFile(filePath, 'utf8');
  let output = source;

  output = await rewritePattern(
    output,
    filePath,
    importFromPattern,
    (prefix, quote, specifier) => `${prefix}${quote}${specifier}${quote}`,
  );
  output = await rewritePattern(
    output,
    filePath,
    sideEffectImportPattern,
    (prefix, quote, specifier) => `${prefix}${quote}${specifier}${quote}`,
  );
  output = await rewritePattern(
    output,
    filePath,
    dynamicImportPattern,
    (prefix, quote, specifier, suffix) => `${prefix}${quote}${specifier}${quote}${suffix}`,
  );

  if (output !== source) {
    await writeFile(filePath, output);
    return true;
  }

  return false;
}

const files = await listJavaScriptFiles(moduleRoot);
let rewrittenCount = 0;

for (const filePath of files) {
  if (await rewriteFile(filePath)) {
    rewrittenCount += 1;
  }
}

await writeFile(path.join(moduleRoot, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);

console.log(`Rewrote ESM relative imports in ${rewrittenCount} files.`);
