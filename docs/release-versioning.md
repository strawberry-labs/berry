# Release Versioning

Berry uses SemVer for every public artifact: desktop app, CLI, web platform,
mobile app, extension, compose bundle, and Helm chart. Until `1.0.0`, minor
versions may include breaking product behavior, but data migrations and host
protocol contracts must still follow the repository rules below.

Current product version: `0.1.0`

Current host protocol version: `1`

## Version Sources

- Root workspace: `package.json` `version`.
- Desktop renderer: `apps/desktop/package.json` `version`.
- Tauri desktop bundle: `apps/desktop/src-tauri/tauri.conf.json` `version`.
- CLI package and generated binaries: `apps/cli/package.json` `version`.
- Public npm shim: rendered from `packages/cli-npm/package.json` during release.
- Host protocol: `packages/shared/src/index.ts` `PROTOCOL_VERSION`.

Release automation must fail if public artifact versions disagree for a tag.

## Tag Policy

- CLI releases use `cli-v<semver>` tags.
- Desktop releases use `desktop-v<semver>` tags.
- Platform/self-host releases use `platform-v<semver>` tags once the hosted
  release workflow is enabled.
- Mobile and extension store builds should reference the product SemVer plus
  the store build number in their store consoles.

Do not retag a public release. If a signed artifact or manifest is wrong,
publish the next patch version and document the superseded tag in release
notes.

## Protocol Policy

After the Phase 2 freeze, host protocol changes are additive only. New
renderer-visible host methods must be added to `HostMethodCatalog`, mirrored in
the desktop development host, covered by schema tests, and regenerated in
`docs/protocol/host-methods.md`.

`PROTOCOL_VERSION` changes only when a released client and host can no longer
interoperate. Additive methods and fields do not bump the major protocol. A
major protocol bump requires a migration note in release notes and a rollback
plan for desktop/CLI sidecar skew.

## Release Notes

Generate release notes from git history with:

```sh
corepack pnpm release:notes -- --from <previous-tag> --to <release-tag> --output RELEASE_NOTES.md
```

When a tag has no previous public tag, omit `--from`; the script will include
all reachable commits. Human-gated items from `plans/human-blockers.md` must be
listed as pending rather than claimed as shipped.
