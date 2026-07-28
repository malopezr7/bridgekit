# Releasing

## Version policy

The first stable major tracks React Native minor compatibility. For example,
`83.x.x` targets RN 0.83.

Use patch and minor releases inside the tracked major for compatible BridgeKit
fixes and features. Move to a new major when the supported React Native minor
line changes.

### Pre-stable line

Before the first stable release BridgeKit ships on the `0.x` line. The current
line is `0.1.0-alpha.N`, and it deliberately does not continue the earlier
`0.0.1-beta.x` numbering:

- The contract hash and wire format changed between the two lines with no
  migration path, so continuing the beta numbering would imply a compatibility
  that does not exist.
- `alpha` after `beta` is intentional. The beta line advertised iOS/Android
  parity that was never verified — `packages/core/ios` had no CI and did not
  compile for 23 days. The label now matches what is actually proven.

Both packages share one version. They are released together and version skew
between them has already caused confusion once.

## Tag convention

The packages are released independently with package-specific tags:

- Core package: `core-vX.Y.Z`
- CLI package: `cli-vX.Y.Z`

The tag is the release trigger and the single source of truth for what ships.

## dist-tag policy

`.github/workflows/release.yml` derives the npm dist-tag from the version, so a
prerelease can never become the default install:

| Version contains | dist-tag |
| ---------------- | -------- |
| `-alpha.`        | `alpha`  |
| `-beta.`         | `beta`   |
| `-rc.`           | `rc`     |
| any other `-`    | `next`   |
| no prerelease    | `latest` |

Publishing by hand bypasses this. It is how `latest` ended up pointing at
`0.0.1-beta.0` — the oldest build ever published — while newer betas sat under
the `beta` tag.

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
   tar -tzf "$tmp/$core_tarball" > "$tmp/core-list.txt"
   grep -Fx "package/dist/commonjs/index.js" "$tmp/core-list.txt"
   grep -Fx "package/dist/typescript/index.d.ts" "$tmp/core-list.txt"
   grep -Fx "package/LICENSE" "$tmp/core-list.txt"
   grep -Fx "package/android/build.gradle.kts" "$tmp/core-list.txt"
   grep -q "package/android/src/main" "$tmp/core-list.txt"
   if grep -q "android/src/test" "$tmp/core-list.txt"; then
     exit 1
   fi

   cli_tarball="$(cd packages/cli && npm pack --json --pack-destination "$tmp" | node -e "const c=require('fs').readFileSync(0,'utf8');const i=c.lastIndexOf('\n[');process.stdout.write(JSON.parse(c.slice(i>=0?i+1:c.indexOf('[')))[0].filename)")"
   tar -tzf "$tmp/$cli_tarball" > "$tmp/cli-list.txt"
   grep -Fx "package/dist/index.js" "$tmp/cli-list.txt"
   grep -Fx "package/LICENSE" "$tmp/cli-list.txt"
   ```

6. Update the relevant package `CHANGELOG.md` entries.
7. Create the relevant package tag: `core-vX.Y.Z` or `cli-vX.Y.Z`.
8. Push the tag. `.github/workflows/release.yml` takes over from here.

## Automated publish

Publishing is tag-driven. Do not run `pnpm publish` by hand — every gate that
protects release provenance lives in the workflow.

```sh
# 1. Bump the version in packages/<pkg>/package.json.
#    For core, also update PACKAGE_VERSION in src/runtime/defaultInstance{,.native}.ts
#    (packages/core/src/__tests__/package-version.web.test.ts enforces the match).
# 2. Add the matching '## [X.Y.Z] - YYYY-MM-DD' section to packages/<pkg>/CHANGELOG.md.
# 3. Commit both, then:
git tag core-v0.1.0-alpha.1
git push origin core-v0.1.0-alpha.1
```

The workflow refuses to publish unless all of the following hold:

- the tag version matches the committed `package.json` version exactly;
- that version does not already exist on npm;
- the package `CHANGELOG.md` contains a `## [X.Y.Z]` heading for it;
- Biome, build, typecheck, core web + native suites, and the six
  `generate --check` drift gates all pass.

It then publishes with npm provenance under the dist-tag derived above.

`CI Baseline` carries the complementary guard: a pull request that changes
`packages/<pkg>/src` fails if that package still declares an already-published
version. That is the check that would have caught `packages/cli/src` drifting
nine commits — across a wire-breaking hash change — under a frozen
`0.0.1-beta.0`.

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
