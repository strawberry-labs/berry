# Brand And Domain Cutover

The provisional public naming policy follows `plans/berry-platform-product-decisions.md`
section 11 and ADR 0001:

- Product family: Berry.
- Desktop app: Berry Desktop.
- CLI binary: `berry`.
- Browser extension: Berry Companion.
- Mobile app: Berry Mobile.
- Hosted cloud: `berry.me`.
- Shared tenant domains: `<tenant>.berry.me`.
- Router preset currently used by the repository: `https://router.berry.dev/v1`
  until the Router team confirms the final production host.

These values are implemented in code and documentation where a concrete value
is required. They are still founder-gated for public launch through
`plans/human-blockers.md` #3 and #33. Do not publish store listings, public
release tags, domain-specific updater URLs, ACP registry entries, npm package
metadata, or Homebrew formulas until those blockers are closed.

## Cutover Checklist

1. Confirm the public product family, app names, URL scheme, repository, hosted
   domains, Router domain, and store listing names in
   `plans/berry-platform-product-decisions.md` section 11.3.
2. Replace release placeholders such as `__BERRY_GITHUB_REPOSITORY__`,
   `__BERRY_VERSION__`, `__BERRY_NPM_PACKAGE__`, and
   `__BERRY_ACP_AGENT_ID__` only in release-rendered artifacts or committed
   config files called out by the relevant human blocker.
3. Regenerate docs and release notes with `corepack pnpm check:docs` and
   `corepack pnpm release:notes`.
4. Rerun `corepack pnpm check:launch` and the full release baseline before
   creating public tags.
