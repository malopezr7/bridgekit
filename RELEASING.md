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
5. Verify package contents with the core and CLI pack assertions from CI.
6. Update the relevant package `CHANGELOG.md` entries.
7. Create the relevant package tag: `core-vX.Y.Z` or `cli-vX.Y.Z`.
8. Publish the package to npm with public access.

## Deliberate exclusions

Changesets are intentionally excluded for the first publish cycle. BridgeKit is a
single-maintainer repository with two pre-first-publish packages, so manual
package versions and changelogs are lower ceremony and easier to audit.

Renovate and Dependabot are also intentionally excluded for now. The Nitro
Modules version is pinned during the pre-1.0 stabilization window, and automated
dependency churn would add noise before the first stable release. Revisit this
after the first stable publish.
