# Sth UI primitives

Button uses the source-owned composition of [shadcn-vue Button](https://www.shadcn-vue.com/docs/components/button) (MIT), adapted to the existing CSS tokens. CreateMenu uses Reka UI's accessible dropdown primitives. `web/assets/controls.css`, imported by `notebook.css`, provides one button/field implementation to Vue and retained native pages. `ui.css` owns Reka menu presentation. No global reset, CSS framework or second theme is installed.

These components own visual states and menu behavior. App owns routing/history; ManuscriptFrame owns panes; LibraryPanels owns the navigation tree and manuscript queries. UI code must not introduce a parallel business operation or persistence model.

Button variants: `default`, `outline`, `secondary`, `ghost`, `danger`; sizes: `default`, `sm`, `icon`. Native `type`, disabled, form and link attributes remain caller-owned. `loading` adds `aria-busy` and a stable-width visual indicator; it does not decide whether an operation is saved or whether the control is disabled. The caller must describe unknown outcomes and retry state accurately.

Native forms use `.ui-field`, `.ui-input`, `.ui-field-note`, `.ui-field-error`. Existing `.field` and `.button` are compatibility consumers of the same rules. Domain styles may define layout but should not redefine shared colors, radii, disabled states or control sizing. Menu/pane animation is presentation only and respects reduced motion. It must never own a write, browser-history update, focus restoration or scroll unlock.
