# Releasing

## Version policy

The first stable major tracks React Native minor compatibility. For example,
`83.x.x` targets RN 0.83.

Use patch and minor releases inside the tracked major for compatible BridgeKit
fixes and features. Move to a new major when the supported React Native minor
line changes.

## Tag convention

The packages are released independently with package-specific tags:

- Core package: `core-vX.Y.Z`
- CLI package: `cli-vX.Y.Z`

## Release checklist

1. Install from a clean checkout with `pnpm install --frozen-lockfile`.
2. Run `pnpm -r typecheck`.
3. Run `pnpm --filter @malopezr7/bridgekit test`.
4. Run `pnpm build`.
5. Verify package contents with the same pack assertions as CI:

   ```sh
   set -euo pipefail
   tmp="$(mktemp -d)"
   core_tarball="$(cd packages/core && npm pack --json --pack-destination "$tmp" | node -e "const c=require('fs').readFileSync(0,'utf8');const i=c.lastIndexOf('\n[');process.stdout.write(JSON.parse(c.slice(i>=0?i+1:c.indexOf('[')))[0].filename)")"
   tar -tzf "$tmp/$core_tarball" | grep -Fx "package/dist/commonjs/index.js"
   tar -tzf "$tmp/$core_tarball" | grep -Fx "package/dist/typescript/index.d.ts"
   tar -tzf "$tmp/$core_tarball" | grep -Fx "package/LICENSE"
   tar -tzf "$tmp/$core_tarball" | grep -Fx "package/android/build.gradle.kts"
   tar -tzf "$tmp/$core_tarball" | grep -q "package/android/src/main"
   if tar -tzf "$tmp/$core_tarball" | grep -q "android/src/test"; then
     exit 1
   fi

   cli_tarball="$(cd packages/cli && npm pack --json --pack-destination "$tmp" | node -e "const c=require('fs').readFileSync(0,'utf8');const i=c.lastIndexOf('\n[');process.stdout.write(JSON.parse(c.slice(i>=0?i+1:c.indexOf('[')))[0].filename)")"
   tar -tzf "$tmp/$cli_tarball" | grep -Fx "package/dist/index.js"
   tar -tzf "$tmp/$cli_tarball" | grep -Fx "package/LICENSE"
   ```

6. Update the relevant package `CHANGELOG.md` entries.
7. Create the relevant package tag: `core-vX.Y.Z` or `cli-vX.Y.Z`.
8. Publish the package to npm with public access from each package directory:

   ```sh
   cd packages/core && pnpm publish --access public
   cd ../cli && pnpm publish --access public
   ```

   For the core package, `pnpm pub:release` is equivalent.

## Deliberate exclusions

Changesets are intentionally excluded for the first publish cycle. BridgeKit is a
single-maintainer repository with two pre-first-publish packages, so manual
package versions and changelogs are lower ceremony and easier to audit.

Renovate and Dependabot are also intentionally excluded for now. The Nitro
Modules version is pinned during the pre-1.0 stabilization window, and automated
dependency churn would add noise before the first stable release. Revisit this
after the first stable publish.

Package `CHANGELOG.md` files are repo-only release notes and are deliberately
excluded from npm tarballs. The published artifacts keep runtime/build inputs
small while source control keeps the audit trail.
