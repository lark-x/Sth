# Sth UI primitives

Button uses the source-owned composition of [shadcn-vue Button](https://www.shadcn-vue.com/docs/components/button) (MIT), adapted to the existing CSS tokens. CreateMenu uses Reka UI's accessible dropdown primitives. Styles are local to these components; no global reset, CSS framework or second theme is installed.

These components own visual states and menu behavior. App owns routing/history; ManuscriptFrame owns panes; LibraryPanels owns the navigation tree and manuscript queries. UI code must not introduce a parallel business operation or persistence model.
