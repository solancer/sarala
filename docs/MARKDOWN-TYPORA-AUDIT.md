# Markdown rendering and Typora comparison

Date: 2026-09-24

> Historical audit: the implementation status, fixes, validation, and remaining compatibility limits are now recorded in [MARKDOWN-FIXES.md](MARKDOWN-FIXES.md). The findings below describe the pre-fix implementation.

## Original conclusion

Sarala has broad syntax coverage, but does **not** yet provide consistent rendering across inactive preview, live editing, and export. The biggest gaps are parser consistency and document-level context, rather than missing toolbar options.

This audit exercised 90 independent fixtures and four additional logic probes. All 90 retained exact source text through `styleSource`; that is useful evidence for caret offsets, **not proof that editing or table operations cannot damage content**. Two additional probes demonstrate incorrect editing behavior. The existing 1,041 regression checks pass, but did not cover these defects.

This is a source/DOM audit against Typora's official documentation, not a live Typora comparison. Browser geometry, native interaction, real image/media loading, full Shiki language coverage, asynchronous diagram SVG output, screen readers, and PDF/Pandoc output were not exercised. No claim of complete CommonMark/GFM conformance is made.

## Confirmed defects, in priority order

### P1 — incorrect edits and document interpretation

1. **Task toggle can change the wrong text.** Given a block containing `` `[ ]` example `` followed by `- [ ] Task`, toggling task zero changes the code example to `[x]`, leaving the real checkbox untouched. `toggleTask` counts every bracket pair instead of parsed task markers. Evidence: `extras.taskToggleIgnoresCode=false`.
2. **Escaped table pipes are parsed as cell separators.** A body row `| a\|b | c |` previews correctly, but live styling creates three cells; `parseTable` produces `['a\\', 'b']` for the two-column table. Structural edits that serialize that model can lose the original `c` cell. `tabletools.ts` and `livesource.ts` split on every pipe.
3. **Reference links/images break across editable blocks.** `[label][ref]` followed by a blank line and `[ref]: https://example.com` works in whole-document rendering but not in the editor's separate `renderMarkdown(block)` calls. No shared definition registry is passed to the renderer.
4. **Block splitting ignores some syntax boundaries.** Four-backtick fences can close on an inner three-backtick line, splitting a code example at the next blank line. Blank lines also split display math and indented code. `hasOpenFence` shares the fence-length defect. These are document-interpretation bugs, not merely styling changes.
5. **Footnotes differ between editor and export.** Standalone definition blocks render in the editor; definitions embedded in a whole document do not become the same footnotes section. Multiline definitions lose their continuation, and repeated references produce duplicate IDs. HTML export/copy uses whole-document rendering, so it inherits the definition issue.
6. **Nested callouts are malformed in preview.** With a nested blockquote inside a Note, the regex transformation closes the alert at the nested quote's end. Following content is moved outside the callout. The recently improved live quote tree keeps it inside, exposing another preview/live mismatch.

### P2 — rendering and navigation consistency

- **Inline grammar differs on activation:** nested/triple emphasis, escaped punctuation, intraword underscores, underline nested inside bold, multi-backtick and multiline code spans, parenthesized link destinations, and HTML entities. Example: `some_variable_name` is literal in preview but italicizes `variable` when active.
- **Setext headings** (`Heading` followed by `===`/`---`) preview as headings but do not receive equivalent live styling and are omitted from the outline. Closing ATX hashes remain visible in live heading content.
- **Duplicate headings receive duplicate IDs in the editor.** The export wrapper has its own deduplication, so this finding does not imply every exported heading also duplicates its ID. Heading/TOC/link resolution still needs one document-wide anchor policy.
- **TOC handling is case-sensitive and block-specific.** `[TOC]` renders as a standalone editor block; Typora's documented `[toc]` form does not. A TOC inside a whole document remains literal in `renderMarkdown`, affecting the document-body export path. The separately generated export outline is a different feature.
- **Preserve-line-breaks preference** updates preview parsing but not the live block lexer, so it changes wrapping on activation.
- **Inline images, emoji, HTML spans/kbd/ruby/br, and comments** lack equivalent live representations. Some raw-source reveal can be a deliberate editing interaction; it still falls short of the user's requested stable appearance when clicking elsewhere in the paragraph.
- **Horizontal rules** have no equivalent live rule structure.
- **HTML details with blank lines** can split across editor blocks and lose containment. Typora itself documents restrictions on blank lines in HTML blocks, so this is an internal consistency issue rather than a claimed Typora advantage.

## Comparison with Typora

“Present” below means the implementation and representative fixture were found, not complete visual parity.

### Core writing syntax

Typora documents headings, quotes, lists/tasks, code, tables, links/images, footnotes, front matter, TOCs, callouts, emphasis, inline code, strike, emoji, underline, highlight, and sub/superscript. Its reference includes reference-style links, lowercase `[toc]`, footnote hover content, and emoji completion. [Official Markdown reference](https://support.typora.io/Markdown-Reference/).

| Feature | Sarala status | Gap or qualification |
| --- | --- | --- |
| ATX H1–H6, paragraphs | Present | Closing hashes, heading anchors, and live layout need more coverage. |
| Setext headings | Partial | Preview only; live/outline gap. |
| Ordered/unordered lists, tasks | Present | Representative nesting/loose-list structures pass; task toggling defect above. |
| Blockquotes, five callout types | Present | Simple cases pass. Nested callout preview fails. |
| Fenced code + syntax highlighting | Present | Long-fence splitting defect. Language-by-language visual highlighting not audited. |
| Tables + alignment | Present | Escaped-pipe editing defect; not safe to call full GFM table editing support yet. |
| Inline/reference links and images | Partial | Reference definitions not shared across blocks; inline live representations differ. |
| Strong/emphasis/strike/underline/highlight/sub/sup | Present | Several combinations and delimiter edge cases fail live parity. |
| Footnotes | Partial | Definition/export inconsistency, multiline and repeated-reference gaps; no footnote hover implementation found. |
| TOC / outline | Partial | Lowercase syntax, whole-document rendering, setext, and duplicate-heading handling. |
| Emoji | Partial | Curated shortcode map; no UI consumer of `emojiMatches` found. No complete catalog or completion popup. |
| YAML metadata block | Present | Parsing is a simple key/value reader, not a complete YAML parser. |

### Advanced mathematics

Typora uses MathJax and documents chemistry, optional physics, equation labels/references, and automatic numbering. [Official math documentation](https://support.typora.io/Math/).

Sarala uses KaTeX. Ordinary inline/display math works in the tested cases, including optional alternate delimiters and `math` fences when enabled. `\ce{H2O}`, `\qty(x)`, and `\ref{eq1}` fail the probes. No document-wide equation numbering/reference registry was found. These are concrete compatibility gaps; changing the engine is not automatically necessary. Any math expansion should start with explicit requirements and package/command coverage. The audit does not require formulas to remain rendered while their own TeX source is being edited, but surrounding content should remain stable.

### Diagrams

Typora documents Mermaid plus the separate legacy `sequence` and `flow` fence formats. [Official diagram documentation](https://support.typora.io/Draw-Diagrams-With-Markdown/).

Sarala recognizes Mermaid and D2. Its `sequence`/`flow` fences remain ordinary code. D2 is an additional Sarala capability beyond the engines listed on that Typora page; this is not a claim that no Typora plugin or future release supports it. The probes confirm placeholders/routing only, not successful rendering of every diagram family or export format.

### Table editing UX

Typora offers table row/column drag reordering. [Official table editing documentation](https://support.typora.io/Table-Editing/).

Sarala has insertion, resizing, alignment, row/column addition and deletion, and hover rails. No row/column reordering implementation was found. The existing “Move Row Up/Down” commands call `moveBlock`, so they move an editor block rather than a row inside a table. Correct escaped-pipe parsing should precede adding more table mutations.

### HTML and media

Typora documents inline HTML, entities, audio/video, comments, and sandboxed iframe embeds, while restricting scripts and several attributes. [Official HTML documentation](https://support.typora.io/HTML/).

Sarala's sanitized preview retains tested kbd/ruby/span/br/audio/video elements. Live editing frequently exposes their source. Iframes are removed by the sanitizer: that is an intentional current restriction, not a defect to fix by weakening sanitization. Media URL loading and document-relative audio/video resolution need native tests; image resolution alone does not establish media parity.

### Images and document metadata

Typora documents image upload, image-root configuration, and `typora-copy-images-to`/`typora-root-url` metadata. [Official images documentation](https://support.typora.io/Images/).

Sarala already supports relative image paths, configurable copying, size/properties, and local image operations. No upload pipeline was found. It reads `image-root-url` and `copy-images-to`, not the Typora-prefixed aliases, so imported documents may resolve/copy assets differently. Supporting aliases would be a focused compatibility improvement.

Typora also documents structured YAML and use of metadata during export. [Official YAML documentation](https://support.typora.io/YAML/). Sarala's simple line parser will not fully understand nested maps, arrays, or multiline scalar values. Pandoc may independently handle original front matter in its own export path; that does not fix the in-app parser.

## Why these issues recur

The preview uses Marked with custom extensions; live source mixes a separate Marked block lexer with regex-based inline styling. Table editing, block splitting, outline extraction, and task toggling each interpret parts of Markdown again. Document symbols are resolved per render call, while the editor renders individual blocks and export renders the whole document.

The sustainable fix is shared parsing and source ranges, not an expanding set of unrelated CSS corrections:

1. Establish a document parse context for definitions, footnotes, heading IDs, TOC, preferences, and block ranges.
2. Use parsed task markers and escaped-pipe-aware table cells for every mutation.
3. Derive live decoration from the same inline token tree as preview, preserving raw source ranges for caret mapping.
4. Transform alerts from block tokens or a structured tree, not a regex over nested HTML.
5. Add click/selection/typing/undo and geometry checks for each fixed fixture before declaring visual parity.
6. Add optional Typora features after these correctness issues: table reordering, emoji completion, footnote hover, image metadata aliases, and advanced math. Evaluate uploads/embeds separately because they introduce external content and services.

## Reproduce and interpret results

Run `node scripts/audit-markdown.mjs`.

- `markdown-audit-results.json`: machine-readable per-fixture results and minimal sources.
- `markdown-rendering-fixtures.md`: samples for manual smoke testing. Test cases independently; a combined file can introduce document-wide references and repeated headings that interact.
- `preview`: whole-input `renderMarkdown` meets the fixture's structural expectation.
- `editorPreview`: concatenated per-block output meets the same expectation.
- `liveStructure`: source styling, with concealed source spans removed, meets a targeted structure/text expectation. This is not a pixel comparison. A false result for a math/diagram source editor is not by itself a bug. One sanitizer-only fixture has no live check.
- `sourcePreserved`: exact text-content roundtrip before editing. It does not validate mutations, cursor placement, saved-file fidelity, or export.

The audit intentionally reports known gaps rather than asserting that every fixture passes. It is separate from `npm test`. Existing regression tests remain green; renderer behavior was not changed by this audit.

## Fixture results

Of 90 fixtures, 77 meet whole-input expectations and 73 meet per-block expectations. 38 meet their live-structure expectation; all 90 preserve source text. These are deliberately mixed coverage probes, not product quality percentages.

| Fixture | Whole input | Editor preview | Live structure | Source retained |
| --- | --- | --- | --- | --- |
| heading-h1 | Pass | Pass | Pass | Pass |
| heading-h2 | Pass | Pass | Pass | Pass |
| heading-h3 | Pass | Pass | Pass | Pass |
| heading-h4 | Pass | Pass | Pass | Pass |
| heading-h5 | Pass | Pass | Pass | Pass |
| heading-h6 | Pass | Pass | Pass | Pass |
| setext-h1 | Pass | Pass | Gap | Pass |
| setext-h2 | Pass | Pass | Gap | Pass |
| closing-heading-hashes | Pass | Pass | Gap | Pass |
| strong | Pass | Pass | Pass | Pass |
| emphasis | Pass | Pass | Pass | Pass |
| nested-emphasis | Pass | Pass | Gap | Pass |
| triple-emphasis | Pass | Pass | Gap | Pass |
| intraword-underscores | Pass | Pass | Gap | Pass |
| escaped-emphasis | Pass | Pass | Gap | Pass |
| html-entities | Pass | Pass | Gap | Pass |
| strike | Pass | Pass | Pass | Pass |
| highlight | Pass | Pass | Pass | Pass |
| subscript | Pass | Pass | Pass | Pass |
| superscript | Pass | Pass | Pass | Pass |
| underline | Pass | Pass | Pass | Pass |
| underline-in-bold | Pass | Pass | Gap | Pass |
| code-single | Pass | Pass | Pass | Pass |
| code-multi-backtick | Pass | Pass | Gap | Pass |
| code-multiline | Pass | Pass | Gap | Pass |
| link-inline | Pass | Pass | Pass | Pass |
| link-nested-parentheses | Pass | Pass | Gap | Pass |
| reference-link | Pass | Gap | Gap | Pass |
| reference-image | Pass | Gap | Gap | Pass |
| angle-autolink | Pass | Pass | Pass | Pass |
| bare-autolink | Pass | Pass | Gap | Pass |
| image-inline | Pass | Pass | Gap | Pass |
| soft-break | Pass | Pass | Pass | Pass |
| hard-break-spaces | Pass | Pass | Pass | Pass |
| hard-break-backslash | Pass | Pass | Pass | Pass |
| horizontal-rule | Pass | Pass | Gap | Pass |
| unordered-list | Pass | Pass | Pass | Pass |
| ordered-start | Pass | Pass | Pass | Pass |
| loose-list | Pass | Pass | Pass | Pass |
| nested-list | Pass | Pass | Pass | Pass |
| tasks | Pass | Pass | Pass | Pass |
| quote | Pass | Pass | Pass | Pass |
| nested-quote | Pass | Pass | Pass | Pass |
| alert-note | Pass | Pass | Pass | Pass |
| alert-tip | Pass | Pass | Pass | Pass |
| alert-important | Pass | Pass | Pass | Pass |
| alert-warning | Pass | Pass | Pass | Pass |
| alert-caution | Pass | Pass | Pass | Pass |
| table-basic | Pass | Pass | Pass | Pass |
| table-optional-pipes | Pass | Pass | Pass | Pass |
| table-escaped-pipe | Pass | Pass | Gap | Pass |
| fenced-code | Pass | Pass | Pass | Pass |
| long-fence-with-short-inner | Pass | Gap | Pass | Pass |
| indented-code | Pass | Gap | Gap | Pass |
| inline-math | Pass | Pass | Gap | Pass |
| display-math | Pass | Pass | Gap | Pass |
| math-blank-line | Pass | Gap | Gap | Pass |
| math-chemistry | Gap | Gap | Gap | Pass |
| math-physics | Gap | Gap | Gap | Pass |
| math-reference | Gap | Gap | Gap | Pass |
| mermaid | Pass | Pass | Gap | Pass |
| d2 | Pass | Pass | Gap | Pass |
| legacy-sequence | Gap | Gap | Gap | Pass |
| legacy-flow | Gap | Gap | Gap | Pass |
| emoji | Pass | Pass | Gap | Pass |
| footnote-document | Gap | Pass | Gap | Pass |
| footnote-multiline | Gap | Gap | Gap | Pass |
| repeated-footnote-reference | Gap | Gap | Gap | Pass |
| frontmatter | Pass | Pass | Pass | Pass |
| toc-upper | Pass | Pass | Gap | Pass |
| toc-lower | Gap | Gap | Gap | Pass |
| duplicate-heading-ids | Gap | Gap | Gap | Pass |
| html-kbd | Pass | Pass | Gap | Pass |
| html-ruby | Pass | Pass | Gap | Pass |
| html-details | Pass | Gap | Gap | Pass |
| html-video | Pass | Pass | Gap | Pass |
| html-audio | Pass | Pass | Gap | Pass |
| html-iframe | Gap | Gap | Gap | Pass |
| html-comment | Pass | Pass | Gap | Pass |
| html-br | Pass | Pass | Gap | Pass |
| html-span-style | Pass | Pass | Gap | Pass |
| nested-quote-in-alert | Gap | Gap | Pass | Pass |
| inline-image-title | Pass | Pass | Gap | Pass |
| link-title | Pass | Pass | Pass | Pass |
| escaped-html | Pass | Pass | Gap | Pass |
| unsafe-script-filtered | Pass | Pass | N/A | Pass |
| toc-inside-document | Gap | Pass | Gap | Pass |
| preserve-line-breaks-option | Pass | Pass | Gap | Pass |
| alternate-inline-math-option | Pass | Pass | Gap | Pass |
| math-fence-option | Pass | Pass | Gap | Pass |
