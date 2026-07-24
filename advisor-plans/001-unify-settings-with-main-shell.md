# Plan 001: Unify settings and management with the main Berry shell

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update this plan's status row in
> `advisor-plans/README.md`.
>
> **Drift check (run first)**:
>
> ```sh
> git diff --stat fed82e7..HEAD -- \
>   apps/web/src/components/management/management-sidebar.tsx \
>   apps/web/src/components/management/management-primitives.tsx \
>   apps/web/src/components/shell/web-sidebar.tsx \
>   apps/web/src/components/app-shell.tsx \
>   apps/web/src/styles.css \
>   apps/web/tests/management.spec.ts \
>   apps/web/tests/web-shell.spec.ts
> ```
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts with the live code. If the shell or sidebar
> contracts no longer match, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (one to two focused days, including visual QA)
- **Risk**: MED — this changes navigation structure and responsive behavior,
  but not settings data or API behavior
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `fed82e7`, 2026-07-24

## Why this matters

The main workspace and management routes currently look and behave like
different products. They share color tokens but use different sidebar
structures, row sizing, responsive navigation, page spacing, card treatment,
and interaction code. Unifying those structural primitives will make
`/settings/*`, `/admin/*`, and `/platform/*` feel like part of the same Berry
application while preserving the denser controls those routes require.

## Product outcome

After this plan:

- The same Berry titlebar and sidebar system surrounds workspace, settings,
  organization administration, and platform administration.
- Sidebar width, inset behavior, collapse/expand behavior, row geometry,
  keyboard shortcut, mobile sheet, focus restoration, and reduced-motion
  behavior come from the shared sidebar implementation.
- Management pages retain their routes, navigation groups, permissions,
  organization switcher, forms, tables, charts, and admin/platform distinction.
- Page typography and section styling use the compact Berry web scale:
  14px body, 12px secondary text, 11px metadata, restrained borders, and clear
  focus states.

## Current state

### Shell selection

`apps/web/src/components/app-shell.tsx:1374-1421` swaps the sidebar component
based on the current surface:

```tsx
sidebar={surface === "settings" ? (
  <ManagementSidebar ... />
) : (
  <WebSidebar ... />
)}
```

This routing decision is correct and should remain. The problem is the
component returned by `ManagementSidebar`.

### Main workspace sidebar

`apps/web/src/components/shell/web-sidebar.tsx:134` returns the shared sidebar
primitive:

```tsx
<Sidebar variant="inset" className="berry-app-sidebar">
  <BerryConversationSidebarContent ... />
  <SidebarFooter className="berry-sidebar-footer">...</SidebarFooter>
</Sidebar>
```

The shared primitive owns desktop gap/inset layout, collapse state, mobile
sheet behavior, and the `SidebarTrigger` used by the titlebar. Its menu rows
are styled by the scoped `.berry-web-shell .berry-app-sidebar` rules in
`apps/web/src/styles.css:1386-1426`.

### Management sidebar

`apps/web/src/components/management/management-sidebar.tsx:26-30` bypasses the
shared sidebar primitive:

```tsx
return <>
  <Button className="mgmt-mobile-trigger" ...><Menu /></Button>
  <aside className="mgmt-sidebar">{content()}</aside>
  {open ? <div className="mgmt-mobile-overlay">...</div> : null}
</>;
```

It duplicates mobile open/close state, overlay behavior, focus restoration,
navigation rows, and sizing. It therefore does not participate in the same
sidebar layout or interaction state as the titlebar.

### Management-specific visual layer

`apps/web/src/styles.css:2834-3554` contains the management visual system.
The highest-drift rules are:

- `.mgmt-sidebar`: fixed 240px width and standalone border/background.
- `.mgmt-nav-group button`: 13px text, 32px row, 7px radius.
- `.mgmt-page`: independent 1040px container and page padding.
- `.mgmt-section`: 14px radius, shadow, and 20px internal padding.
- `.mgmt-mobile-*`: a second mobile sidebar system.

The management primitives already import shared Berry components in
`apps/web/src/components/management/management-primitives.tsx:5-20`.
Consolidate their styling rather than replacing their data or behavior.

### Existing tests

- `apps/web/tests/management.spec.ts` covers settings persistence, direct admin
  navigation, permissions, and the custom management mobile sheet.
- `apps/web/tests/web-shell.spec.ts:653-670` captures separate desktop settings,
  desktop administration, and mobile settings screenshots.
- Main sidebar geometry and theme tokens are already asserted elsewhere in
  `apps/web/tests/web-shell.spec.ts`.

The existing screenshots lock each surface independently but do not assert
that they share the same shell geometry.

## Repository constraints

The root `AGENTS.md` requires:

- Route surfaces, text, borders, and accents through existing `--berry-*`
  variables; do not introduce component-specific theme colors.
- 14px body text, 12px secondary text, and 11px metadata.
- Interruptible motion and `prefers-reduced-motion` support.
- Web-focused verification instead of the cross-platform suite.

Use `apps/web/src/components/shell/web-sidebar.tsx` and
`packages/desktop-ui/src/components/ui/sidebar.tsx` as the implementation
patterns. Do not fork or copy the shared sidebar source into `apps/web`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused typecheck | `corepack pnpm --filter @berry/web... typecheck` | exit 0, no TypeScript errors |
| Focused unit tests | `corepack pnpm --filter @berry/web test` | exit 0, all web unit tests pass |
| Management E2E | `corepack pnpm --filter @berry/web test:e2e -- management.spec.ts --project=chromium` | exit 0 |
| Shell E2E | `corepack pnpm --filter @berry/web test:e2e -- web-shell.spec.ts --project=chromium` | exit 0 |
| Update Chromium references | `corepack pnpm --filter @berry/web test:e2e -- web-shell.spec.ts --project=chromium --update-snapshots` | exit 0; only intended management screenshots change |
| Production build | `corepack pnpm --filter @berry/web... build` | exit 0; client and server bundles complete |

## Suggested executor toolkit

- Use the `frontend-design` skill, if available, to keep visual decisions
  specific to Berry rather than applying a generic dashboard style.
- Use the `make-interfaces-feel-better` or `better-ui` skill, if available, to
  check row geometry, focus treatment, border hierarchy, and interaction
  states.
- Use browser automation for desktop and mobile visual QA after automated
  checks pass.

## Scope

### In scope

- `apps/web/src/components/management/management-sidebar.tsx`
- `apps/web/src/components/management/management-primitives.tsx`
- `apps/web/src/components/shell/web-sidebar.tsx`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/styles.css`
- `apps/web/tests/management.spec.ts`
- `apps/web/tests/web-shell.spec.ts`
- `apps/web/tests/web-shell.spec.ts-snapshots/management-settings-desktop-chromium-darwin.png`
- `apps/web/tests/web-shell.spec.ts-snapshots/management-admin-desktop-chromium-darwin.png`
- `apps/web/tests/web-shell.spec.ts-snapshots/management-settings-mobile-chromium-darwin.png`
- `advisor-plans/README.md` for status only

### Out of scope

- Settings, admin, and platform route paths or tab identifiers.
- Navigation labels, grouping, permission filters, or access-control logic.
- API calls, API contracts, saved preference keys, organization selection
  behavior, charts, tables, and underlying form behavior.
- `packages/desktop-ui` changes. The shared primitives already provide the
  required behavior; stop if they do not.
- Desktop, mobile-app, extension, release packaging, or deployment code.
- A new color palette, font family, icon library, or animation framework.
- Rewriting every management screen. Changes should land at the sidebar,
  shared primitive, and stylesheet boundaries.

## Git workflow

- Branch: `codex/align-management-ui`
- Use the repository's conventional commit style.
- Suggested commit: `fix(web): align management surfaces with workspace shell`
- Do not push or open a pull request unless the operator explicitly requests it.

## Steps

### Step 1: Add parity assertions before changing the sidebar

Update `apps/web/tests/management.spec.ts` so the test suite records the shared
contract the new implementation must satisfy.

Add desktop assertions for `/settings/general`:

- A `[data-slot="sidebar-container"]` exists.
- A `[data-slot="sidebar-inner"]` exists and uses the same computed
  `--berry-sidebar-bg` surface as the main workspace.
- The active `General` navigation item is a shared sidebar menu button with
  `data-active="true"`.
- The titlebar's `Toggle sidebar` button collapses the settings sidebar and a
  second activation expands it.
- `Meta+B` on macOS or `Control+B` elsewhere toggles the same sidebar state.

Replace the test for the bespoke mobile management sheet:

- At 390×844, navigate to `/settings/privacy`.
- Activate the shared `Toggle sidebar` button.
- Assert that the shared mobile sidebar sheet opens and contains the
  `Personal settings` navigation.
- Select `General`; assert `/settings/general`, assert the sheet closes, and
  assert focus returns according to the shared sidebar behavior.

Do not assert implementation-specific Tailwind class strings. Use roles,
`data-slot`, `data-state`, URLs, computed colors, and visible labels.

**Verify**:

```sh
corepack pnpm --filter @berry/web test:e2e -- management.spec.ts --project=chromium
```

Expected before implementation: the new parity assertions fail only because
management still uses the standalone `<aside>` and custom mobile sheet.

### Step 2: Move management navigation onto the shared sidebar

Refactor `ManagementSidebar` in
`apps/web/src/components/management/management-sidebar.tsx`.

Use these shared components from
`@berry/desktop-ui/components/ui/sidebar`:

- `Sidebar`
- `SidebarHeader`
- `SidebarContent`
- `SidebarGroup`
- `SidebarGroupLabel`
- `SidebarMenu`
- `SidebarMenuItem`
- `SidebarMenuButton`

Required component shape:

```tsx
<Sidebar variant="inset" className="berry-app-sidebar berry-management-sidebar">
  <SidebarHeader className="berry-sidebar-header pt-[var(--berry-titlebar-height)]">
    {/* back control and organization/environment control */}
  </SidebarHeader>
  <SidebarContent className="scroll-fade">
    {/* permission-filtered navigation groups */}
  </SidebarContent>
</Sidebar>
```

Implementation requirements:

- Preserve the existing `kind`, `tab`, permission filtering, organization
  switcher, platform environment label, admin links, and callbacks.
- Render group labels with `SidebarGroupLabel`.
- Render each group through `SidebarGroup`, `SidebarMenu`, `SidebarMenuItem`,
  and `SidebarMenuButton`.
- Set both `isActive={tab === item.id}` and
  `aria-current={tab === item.id ? "page" : undefined}` on normal navigation
  items. Do not rely on custom `aria-current` CSS for the visual state; the
  shared primitive will emit `data-active`, while `aria-current` preserves the
  navigation semantics.
- Retain accessible navigation names: `Personal settings`,
  `Organization administration`, and `Platform administration`.
- Keep the back button and organization/environment control in the header,
  but size them with shared button and sidebar conventions.
- Delete local `open`, `setOpen`, `triggerRef`, `close`, `Menu`, and `X` code.
- Delete the custom mobile trigger, overlay, sheet, and close button. The
  `Sidebar` primitive and titlebar `SidebarTrigger` must own mobile behavior.
- Use the shared `useSidebar()` hook to read `isMobile` and call
  `setOpenMobile(false)` after a mobile navigation selection. This is the same
  closure pattern used by `WebSidebar`; it also lets `SidebarProvider` restore
  focus to the shared titlebar trigger.

If `WebSettingsSidebar` and `WEB_SETTINGS_NAV` in
`apps/web/src/components/shell/web-sidebar.tsx` remain unused after this
refactor, remove those dead exports and their now-unused imports. Do not move
the full management navigation table into that file.

`apps/web/src/components/app-shell.tsx` should continue selecting
`ManagementSidebar` for settings surfaces. Change it only if a small prop or
class adjustment is required; do not restructure route rendering.

**Verify**:

```sh
corepack pnpm --filter @berry/web... typecheck
corepack pnpm --filter @berry/web test:e2e -- management.spec.ts --project=chromium
```

Expected: typecheck exits 0; the new desktop collapse and mobile sheet tests
pass; existing route, persistence, admin-navigation, and permission tests pass.

### Step 3: Remove the duplicate sidebar CSS and align management chrome

Edit the management section in `apps/web/src/styles.css`.

Delete rules that implement the old sidebar system:

- `.mgmt-sidebar`
- `.mgmt-mobile-trigger`
- `.mgmt-mobile-overlay`
- `.mgmt-mobile-sheet`
- `.mgmt-sheet-close`
- bespoke `.mgmt-nav-group button` geometry and active-state rules that are
  superseded by `SidebarMenuButton`

Keep only management-specific layout needed inside the shared shell:

- organization/environment switcher layout
- management group separation where the shared group spacing is insufficient
- external-link marker
- page and content styling

Apply the existing `.berry-app-sidebar` row contract to
`.berry-management-sidebar`. Do not duplicate exact declarations if the
existing selectors can cover both.

Acceptance values:

- Sidebar width comes only from the `BerryShellFrame` `--sidebar-width`;
  no fixed management width remains.
- Navigation rows use the shared 30px height, 14px label, 10px radius, shared
  hover background, and shared active treatment.
- Group labels use 11px metadata text.
- Management header aligns to the same titlebar height and horizontal inset
  as the workspace sidebar.
- Every color continues to come from an existing `--berry-*`, shadcn semantic,
  or sidebar semantic variable. No hex, RGB, or component-specific color
  variable is introduced.
- Reduced-motion behavior remains inherited from the shared sidebar.

**Verify**:

```sh
rg -n 'mgmt-mobile-trigger|mgmt-mobile-overlay|mgmt-mobile-sheet|mgmt-sheet-close|width: 240px' \
  apps/web/src apps/web/tests
```

Expected: no matches.

Then run:

```sh
corepack pnpm --filter @berry/web test:e2e -- management.spec.ts --project=chromium
```

Expected: all management E2E tests pass.

### Step 4: Align management pages with the compact Berry web scale

Keep `ManagementPage`, `Section`, `MetricGrid`, `DataTable`, and other
management abstractions. Refine their shared rules in `apps/web/src/styles.css`
and, only when necessary for semantics, their markup in
`management-primitives.tsx`.

Apply these constraints:

- Body/control labels: 14px maximum for normal content.
- Supporting descriptions: 12px.
- Metadata, group labels, table headings, and status labels: 11px.
- Page title: 22px desktop, with compact line-height; do not exceed the current
  24px size.
- Main content width: `min(960px, 100%)`. Data-dense pages may use an existing
  modifier class up to the current 1040px only if a real table clips at 960px.
- Desktop page padding: 32px; tablet: 24px; mobile: 16px.
- Section radius: 12px maximum.
- Section padding: 16px desktop and mobile.
- Section and table borders use `var(--berry-border)`.
- Shadows are removed from ordinary settings sections and tables. Keep a
  shadow only for overlays, drawers, floating save bars, or another element
  that must read above the page.
- Buttons, inputs, selects, switches, tabs, cards, sheets, badges, and tables
  continue to use the imported shared components. CSS may compact them but
  must not recreate their variants.
- Preserve management-specific hierarchy: page title, section title, metrics,
  tables, and destructive states must remain distinguishable.
- Preserve all existing focus-visible states. A focused control must remain
  visibly identifiable in both light and dark themes.

Do not mechanically delete all `mgmt-*` styles. Many express legitimate
management layouts such as charts, permission matrices, archive rows, drawers,
and data tables. Remove or merge only declarations that duplicate the shared
component system or create the visual drift identified above.

**Verify**:

```sh
corepack pnpm --filter @berry/web... typecheck
corepack pnpm --filter @berry/web test
```

Expected: both commands exit 0.

### Step 5: Update and review visual references

Start from a clean Chromium run. Update only the management references:

```sh
corepack pnpm --filter @berry/web test:e2e -- \
  web-shell.spec.ts --project=chromium --update-snapshots
```

Review the three changed reference images manually. Confirm:

- The settings and admin sidebars now have the same outer geometry, titlebar
  alignment, row height, active state, and background as the main workspace.
- The settings page still reads as settings; labels, controls, section
  boundaries, and destructive actions are not flattened into ambiguity.
- The organization switcher remains clearly separate from route navigation.
- The platform console still has no organization switcher.
- No content is obscured at 1280×720 or 390×844.
- The mobile screenshot uses the shared titlebar/sidebar trigger and does not
  show a second management hamburger.

If a snapshot outside the three scoped management PNGs changes, revert that
snapshot and investigate. Do not accept broad snapshot churn.

**Verify**:

```sh
git diff --name-only -- apps/web/tests/web-shell.spec.ts-snapshots
```

Expected: only the three scoped management PNGs are listed.

Then run:

```sh
corepack pnpm --filter @berry/web test:e2e -- web-shell.spec.ts --project=chromium
```

Expected: exit 0 with all Chromium shell assertions and screenshots passing.

### Step 6: Run final web gates

Run the focused project checks required by `AGENTS.md`:

```sh
corepack pnpm --filter @berry/web... typecheck
corepack pnpm --filter @berry/web test
corepack pnpm --filter @berry/web... build
```

Expected: all commands exit 0.

Run final scope inspection:

```sh
git status --short
git diff --check
```

Expected: no whitespace errors; only in-scope files and
`advisor-plans/README.md` are modified.

## Test plan

Use `apps/web/tests/management.spec.ts` for behavior and shared-shell geometry.
Use the current tests as the structural pattern.

Required regression cases:

1. Desktop settings use shared sidebar slots and active state.
2. Titlebar button collapses and expands the settings sidebar.
3. Keyboard shortcut toggles the same settings sidebar.
4. Mobile settings open through the shared sheet and close after navigation.
5. Existing personal-setting persistence still works.
6. Admin direct navigation and permission-filtered navigation still work.
7. Platform navigation remains visually distinct and has no organization
   switcher.
8. Chromium screenshots cover desktop settings, desktop admin, and mobile
   settings.

No API fixtures or backend behavior should need modification.

## Done criteria

- [ ] `ManagementSidebar` renders the shared `Sidebar` primitive.
- [ ] The standalone management mobile overlay and its React state are gone.
- [ ] Settings, admin, and platform preserve current routes, labels,
      permission filtering, and organization/platform behavior.
- [ ] Sidebar width is controlled only by `BerryShellFrame`.
- [ ] Settings navigation rows use the same shared geometry and active state
      as workspace navigation rows.
- [ ] Management page text follows the 14px/12px/11px compact scale.
- [ ] Ordinary management cards and tables do not use decorative shadows.
- [ ] No new hardcoded theme colors are introduced.
- [ ] Desktop collapse, keyboard toggle, mobile sheet, and focus behavior have
      passing E2E coverage.
- [ ] Only the three intended management screenshot baselines change.
- [ ] `corepack pnpm --filter @berry/web... typecheck` exits 0.
- [ ] `corepack pnpm --filter @berry/web test` exits 0.
- [ ] Chromium management and shell E2E commands exit 0.
- [ ] `corepack pnpm --filter @berry/web... build` exits 0.
- [ ] `git diff --check` exits 0.
- [ ] The status in `advisor-plans/README.md` is `DONE`.

## STOP conditions

Stop and report back; do not improvise if:

- `packages/desktop-ui` must change to make management use the shared sidebar.
- The current route, permission, or organization-switching behavior must
  change to achieve visual alignment.
- `ManagementSidebar` can only use the shared primitive by duplicating
  `SidebarProvider` or nesting a second provider.
- The shared titlebar trigger cannot open the sidebar on mobile.
- More than the three scoped management screenshot baselines change.
- A data-heavy management page cannot fit within the target width without
  losing information; report the exact route and clipping element.
- An in-scope file changed after commit `fed82e7` in a way that invalidates the
  current-state excerpts.
- A verification command fails twice after a reasonable scoped correction.

## Maintenance notes

- New settings and administration routes should use `ManagementPage` and the
  shared management primitives; they should not create another page shell.
- New navigation groups belong in `management-navigation.ts`, while rendering
  remains in the shared-sidebar-based `ManagementSidebar`.
- Review future CSS changes for selectors that restyle
  `.berry-management-sidebar` independently of `.berry-app-sidebar`.
- Snapshot review must compare management chrome with the main workspace, not
  only with the previous management screenshot.
- A later cleanup may split the large management CSS section into a dedicated
  stylesheet or CSS layer. That is intentionally deferred because file
  organization does not need to change to solve this visual inconsistency.
