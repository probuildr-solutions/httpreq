# UI architecture

## Styling: Tailwind CSS and design tokens

Every screen is styled with Tailwind CSS utility classes. There is no component library and no CSS
modules. [`packages/ui/src/tailwind.css`](../packages/ui/src/tailwind.css) is the whole design
system:

- the palette and the **semantic tokens** components use (`bg-surface`, `text-dimmed`,
  `border-line`, `bg-primary-soft`, `text-method-get`…);
- dark mode, which re-points those tokens under `data-theme="dark"` on `<html>`, so component code
  does not carry `dark:` variants for ordinary colours;
- the few global rules a utility cannot express (scrollbars, the find-match highlight, the
  Electron drag region).

Components never choose a raw colour: a new theme is a change to `tailwind.css` alone. The theme is
applied by [`initColorScheme`](../packages/ui/src/kit/colorScheme.ts) before first paint, and the
choice is stored under `httpreq-color-scheme`.

Tailwind only generates classes it can find as whole strings, so variant tables (button tones, badge
colours, HTTP verb colours) spell every class out instead of assembling names at run time.

## The component kit

[`packages/ui/src/kit`](../packages/ui/src/kit) holds the small set of controls the app uses:
layout primitives (`Group`, `Stack`, `SimpleGrid`), text, buttons, form fields, `Select`, `Menu`,
`Popover`, `Tooltip`, `Modal`, `Tabs` and notifications. Positioning, focus management and dismissal
for floating elements come from `@floating-ui/react`. Screens import from `../kit` only; nothing
else knows how a control is built.

## Design principles in practice

- **Single responsibility.** `HttpReqApp` is a composition root. Menus (`app/menus.ts`), the command
  registry (`app/buildCommands.ts`), request sending (`app/useSendRequest.ts`), updates
  (`app/useAppUpdates.tsx`), zoom (`app/useWindowZoom.ts`) and tab derivation
  (`app/useWorkbenchTabs.ts`) each own one concern. The workbench store keeps core workspace actions
  and composes terminal tabs, environment tabs and connection profiles from slices
  (`storeSlices/`). The tree row is its own component (`explorer/ExplorerRow.tsx`).
- **Open for extension.** New actions are entries in the command registry and one line in
  `APP_MENUS`. New authorization schemes are a provider in `api-client` plus an editor in the editor
  registry; neither the panel nor the pipeline switches on the type. New colours or sizes of a
  control are a row in a lookup table.
- **Dependency inversion.** Screens depend on interfaces (`HttpRuntime`, `WorkspaceRepository`,
  `DesktopBridge`) supplied by the host, so the same UI runs in the browser and in Electron.
- **Patterns used on purpose:** command (menus, shortcuts), registry/strategy (auth providers and
  editors, tone and variant tables), slice composition (the store), observer (Zustand), compound
  components (`Menu`, `Tabs`, `Popover`, `Radio`).

## Conventions

- Four-space indentation everywhere, enforced by Prettier (`npm run format`); `.editorconfig`
  mirrors it.
- Every source file carries the copyright and SPDX header.
- Comments explain why something exists or why it is done a particular way, not what a line does.
