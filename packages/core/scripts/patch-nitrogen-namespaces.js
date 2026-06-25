const fs = require('node:fs');
const path = require('node:path');

const targetDir = path.join(__dirname, '../nitrogen/generated/ios');

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  if (filePath.endsWith('.swift')) {
    // Hide Nitro from BridgeKit's public Swift module interface.  Nitrogen's
    // Swift/C++ bridge still needs the generated Swift symbols in BridgeKit-Swift.h,
    // so generated bridge types are exported as SPI instead of public API.
    content = content.replace(/(?<!@_implementationOnly )import NitroModules/g, '@_implementationOnly import NitroModules');
    content = content.replace(/^public final class /gm, '@_spi(BridgeKitNitro) public final class ');
    content = content.replace(/^public protocol /gm, '@_spi(BridgeKitNitro) public protocol ');
    content = content.replace(/^open class /gm, '@_spi(BridgeKitNitro) public class ');
    content = content.replace(/^public typealias /gm, '@_spi(BridgeKitNitro) public typealias ');
  } else {
    // Replace non-namespaced Swift wrapper references with globally namespaced ones.
    // Example: `const BridgeKit::HybridBridgeHostSpec_cxx&` -> `const ::BridgeKit::HybridBridgeHostSpec_cxx&`
    // The negative lookbehind prevents double-prefixing already-qualified names.
    content = content.replace(/(?<!:)\bBridgeKit::/g, '::BridgeKit::');
  }

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`[Nitrogen Patch] Patched: ${path.basename(filePath)}`);
  }
}

function walkDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath);
    } else if (fullPath.endsWith('.hpp') || fullPath.endsWith('.cpp') || fullPath.endsWith('.mm') || fullPath.endsWith('.swift')) {
      processFile(fullPath);
    }
  }
}

console.log('--- Running Post-Nitrogen Namespace Patch ---');
if (fs.existsSync(targetDir)) {
  walkDir(targetDir);
  console.log('--- Post-Nitrogen Patch Complete ---');
} else {
  console.log(`[Nitrogen Patch] Target directory not found: ${targetDir} (no iOS output — OK for Android-only builds)`);
}
