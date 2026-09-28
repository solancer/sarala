# UX, UI, and accessibility audit

Date: 2026-09-24

## Scope and conclusion

Reviewed the application shell, document tabs and reordering, sidebar/tree/outline/search, Live and Source editors, selection and contextual tools, command palette and Quick Open, find/replace, settings and themes, import/export dialogs, update/download flows, and document status/conflict feedback. The review used the current source, supplied screenshots, deterministic DOM tests, contrast calculations, and build/type/lint checks.

The audit found significant keyboard, focus, labeling, and contrast gaps. This changeset addresses shared problems across the app. **This is not a WCAG conformance certification or a completed assistive-technology acceptance test.** Browser interaction, native Tauri behavior, VoiceOver/NVDA, composited colors, and visual layout were not validated in this pass. Previously denied browser access was not retried.

## Changes made

| Area | Finding and impact | Remediation | Verification |
| --- | --- | --- | --- |
| Dialogs — high | Most surfaces lacked modal semantics, initial focus, focus containment, and return focus. Keyboard users could reach the underlying document. | Shared `ModalFrame`/`containModalFocus` used by ten dialogs. Named modal role, inert background, Tab wrapping, nested-dialog handling, scoped Escape, and focus restoration. Busy downloads retain their existing dismissal rules. | DOM regression tests; native/AT testing pending. |
| Background shortcuts — high | Document commands could run while a settings/dialog input was being edited. | Browser tab/menu/palette handlers and native app-command dispatch ignore document actions while a modal is present. Native standard editing behavior needs platform testing. | Source review and typecheck. |
| Command palette / Quick Open — high | Highlighted rows were visual-only; inputs had no associated accessible result selection. Mouse-down-only activation excluded synthetic click activation. | Combobox/listbox/option semantics, active descendant and selected state, explicit names, click activation, no-result status, and bounded selection index. | Source review; screen-reader announcements pending. |
| Core text contrast — high | Secondary text failed 4.5:1 on main surfaces in nine built-in themes. Additional code/chrome-surface checks identified Night as well. Accent text also failed in three themes. | Adjusted ten secondary-text colors and three accent colors; kept theme-dot previews synchronized. | Automated checks cover normal, secondary, and accent text against page/panel in all 13 built-in themes. All 78 pairs pass 4.5:1. |
| Editor zoom — high | Fixed pixel font declarations prevented the page's percentage font size from scaling the main text. | Explicit numeric scale now applies to live/preview prose, Source view, and fixed-size code typography. | Typecheck/build; 100–200% visual/reflow checks pending. |
| Editor keyboard entry — high | A fully rendered document had no explicit keyboard entry point into editing. | Focusable named editor region; Enter starts editing; Escape returns to the editor region. Active text has a multiline textbox name. | Source review; native caret and reading-order tests pending. |
| Editing appearance | Adding an outline to each active paragraph distracted from writing. | Removed paragraph and Source-textarea outlines following user feedback. The caret indicates editing position. Keyboard focus indicators remain on controls and the editor entry region. | User screenshot feedback; no claim of universal caret/focus compliance. |
| Sidebar — medium | Collapsed content was aria-hidden but still potentially focusable; view tabs lacked roving arrow navigation. Recent/pinned buttons incorrectly claimed treeitem roles without a tree parent. | Inert collapsed sidebar, arrow/Home/End view navigation, one selected view tab stop, corrected recent/pinned group semantics. | Source review/typecheck. |
| Sidebar resize — medium | Resize handle was pointer-only. | Named vertical separator with current/min/max width and Left/Right keyboard resizing. | Source review/typecheck. |
| Document tabs — medium | Hidden close buttons added unnecessary stops; reorder had no announcement. | Only active tab close is in sequential focus order; keyboard/pointer reorders announce final position. Existing Alt+Left/Right supports reordering without dragging. | Store/drag regression tests; screen-reader behavior pending. |
| Forms and toggles — medium | Search, setting inputs, view modes, search options, and font choices omitted names or state. | Added labels, pressed/expanded/current states, invalid-search state, and find-result status. | Source review/typecheck. |
| Theme selection — medium | Radio semantics existed without radio keyboard behavior. | Arrow navigation, selected radio tab stop, and selected states for palette/font controls. | Source review; grid and custom-theme transitions pending. |
| Menus — high | In-app nested menus opened only on hover. | Submenu buttons now toggle on click/keyboard activation, expose expanded state, accept Right to enter and Left/Escape to return. | Source review. Full menu/context-menu model remains below. |
| Feedback — medium | Download progress and failure states lacked machine-readable feedback. | Labeled progressbars with determinate values and alert semantics on errors. Existing document conflict alert and save status retained. | Source review; native download/install testing pending. |
| Target size / compact layout — medium | Several controls were below 24px and settings could crowd at narrow widths. | Tab close/search toggles/filter clear/palette dots have 24px minimum targets. Modal viewport bounds and small-screen settings/find layout added. Table insert dimensions are clamped to documented limits. | CSS/typecheck/build; visual reflow testing pending. |

## Outstanding findings and acceptance risks

These are still open; they are not included in the verified fixes above.

| Priority | Area | Remaining issue / next action |
| --- | --- | --- |
| P1 | Editor and image context menus | Some actions still use mouse-down-only handlers or hover-only nested menus. Opening via Shift+F10/Context Menu, initial focus, arrow traversal, and return focus are not consistently implemented. Add a shared keyboard context-menu model, preserving the editor selection. |
| P1 | Large file trees | Navigation scans the mounted rows. With virtualization above 300 rows, keyboard movement can stop at the rendered slice; many tree rows also remain separate Tab stops. Implement a logical-row focus model with scroll-to-mount and a single tree tab stop. |
| P1 | Rich editing and AT | Switching between rendered blocks and contenteditable hosts can replace focused nodes. Hidden Markdown delimiters and source-offset caret restoration need VoiceOver/NVDA testing with lists, links, underline, code, and multi-block selections. Source view is available, but should not be assumed to replace an accessible Live view. |
| P2 | Contextual tools | Selection toolbar, slash menu, code-language picker, image tools, and table rails have uneven keyboard discoverability and active-option announcements. Validate command-palette alternatives for every operation; add explicit keyboard access where missing. |
| P2 | Contrast beyond opaque tokens | Selected/hover/disabled states, opacity, syntax highlighting, thin boundaries, focus rings, user colors, and imported/custom themes are not covered by the 78 core-token checks. Measure actual computed/composited colors and non-text contrast before claiming AA. |
| P2 | Text/UI resizing | New editor scaling requires live validation at 125/150/200%. App chrome uses compact fixed pixel sizes; test OS text scaling and narrow-window clipping, including search controls, status bar, and many tabs. |
| P2 | Popovers and menus | Palette popover, find-bar dismissal, and complete menubar arrow traversal still need consistent return-focus/entry behavior. The new submenu support is not a complete APG menubar implementation. |
| P2 | Native modal behavior | Verify Tauri native accelerators, standard clipboard actions, nested theme/settings transitions, disabled controls during installs, focus restoration after opening another document, and native file-dialog interaction. |
| P3 | Version consistency | Browser-only fallback version strings in About and Update differ from the package version. Derive them from one build-time version source. Native dialogs fetch the actual version. |
| P3 | Discoverability | Alt+Left/Right tab reordering is exposed via keyboard-shortcut semantics but has no visible instructional affordance. Consider a tab context menu with Move Left/Right and Close actions. |

## Manual acceptance checklist

1. Open each dialog from a focused toolbar control and from Cmd/Ctrl+K. Confirm title announcement, initial focus, Tab/Shift+Tab containment, Escape behavior, and focus return. Open Custom Theme from Settings/Themes and repeat with stacked or replaced surfaces.
2. In palette/Quick Open, type a matching query, traverse results, execute, then repeat with zero matches. Listen for the active option and status. Confirm native typing/selection shortcuts affect the input rather than the document.
3. Navigate toolbar → tabs → sidebar → editor using only the keyboard. Enter and leave editing without losing focus. Resize the sidebar and reorder tabs by keyboard. Test close/unsaved prompts and keep all buffers intact.
4. Drag equal- and unequal-width tabs to both ends, across overflow, and cancel with Escape. Test trackpad, mouse, reduced motion, and narrow windows.
5. Open a folder with more than 300 visible rows and follow navigation beyond the virtualized slice. This should reproduce the outstanding tree issue until remediated.
6. Test prose, heading, ordered/unordered lists, nested code, underline, wrapped links, tables, and images at 100/125/150/200% zoom. Activating and deactivating a block must not shift content or change wrapping.
7. Check all themes with real rendered states and macOS Increase Contrast / Reduce Motion. Verify 24px targets (or qualifying spacing exceptions), visible control focus, and readable disabled/selected states.
8. Use VoiceOver in the macOS Tauri app and NVDA on a supported Windows build. Verify editing caret location, reading order, errors, download progress, save/conflict status, and dialog transitions. Check forced colors on Windows separately.

## Validation and limits

- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass.
- 983 automated checks: 411 live-source, 380 formatting, 94 tabs/drag, 6 tab autosave, 92 accessibility.
- Accessibility tests exercise focus entry/wrapping/restoration, nested dialogs, inert background restoration, delegated key handling, and built-in opaque text-token contrast.
- Browser geometry/interaction suites and native/screen-reader acceptance checks were **not run**. DOM tests do not substitute for those checks. Build retains its bundle-size advisory.

## Reference criteria

The review uses [W3C's modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) for focus containment and return, the [tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) for keyboard navigation, and [keyboard interface guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) for composite controls. Contrast checks target the normal-text 4.5:1 threshold in [WCAG 2.2](https://www.w3.org/TR/wcag/). Target-size work uses [Understanding Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), including its spacing exceptions. This report does not treat added ARIA attributes or passing unit tests as proof of conformance.
