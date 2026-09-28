# Markdown fixes and compatibility status

Updated 2026-09-24.

## Implemented

- Task toggling locates parsed list markers, including nested and quoted tasks. Code examples and indented code are excluded.
- Table parsing, caret navigation, and live styling distinguish escaped pipes from structural delimiters. Table moves preserve cells and column alignment. Body rows and columns can be moved with drag handles, handle arrow keys, the table toolbar, or Blocks → Table. Alt+Up/Down moves rows when editing a table.
- Preview and live inline styling use the same Marked grammar and preferences. Nested emphasis, escaped punctuation, intraword underscores, underline inside bold, code delimiters, link destinations, entities, inline HTML formatting, emoji, and image titles retain source offsets.
- Inline equations keep a rendered preview while surrounding text is edited. Clicking the equation exposes its source. Shadow previews keep rendered math out of the editable text offsets.
- Reference links/images, repeated heading anchors, footnote references, and TOCs share document context. Footnotes support continuations, unique reference IDs, native hover descriptions, and whole-document HTML export.
- Nested callouts retain their complete contents. Block splitting keeps longer fences, display math, indented code, footnotes, and details containers together.
- Setext headings appear in the outline and live editor. Closing heading hashes are concealed. TOCs accept lowercase and work inside exported document bodies.
- Emoji includes the pinned Unicode 17 catalog (3,953 fully qualified/component entries), Rich aliases, and existing app aliases; upstream licenses are bundled in `licenses/`. Completion excludes literal code, handles focus changes, and rejects stale replacements. Emoji completion appears while typing `:name`; arrows navigate, Enter/Tab accepts, Escape dismisses, and composition input is respected.
- YAML metadata uses a real data-only parser. Structured metadata is available through `parseYamlMetadata`; existing path consumers receive string values. Both `typora-root-url` and `typora-copy-images-to` aliases work.
- Complex equations, diagrams, metadata, footnotes, TOCs, and supported HTML blocks retain their preview during activation. A floating source panel provides editing with Done/Escape dismissal; temporary delimiter edits keep the panel open. Ordinary paragraphs and lists retain inline editing.
- Chemistry uses KaTeX's bundled mhchem extension. Physics compatibility uses balanced parsing for nested quantities, derivatives, vectors, bra/ket notation, matrix constructors, and operator arguments. Settings → Markdown → Physics operator notation enables operator overrides without changing standard TeX defaults. Equation labels, references, explicit tags, suppressed numbers, and multi-row align/gather environments share document numbering.
- Legacy `sequence` and `flow` fences translate supported statements to Mermaid. Participant aliases, arrow styles, notes, flow states, branch labels, and safe node links are supported. Unsupported statements show an error with their source rather than silently disappearing.
- HTTPS iframe embeds are optional in Settings → Markdown and off by default. Every enabled frame receives an opaque-origin sandbox; document-provided sandbox flags, event handlers, and `srcdoc` are discarded.
- Image uploads are explicit image-menu actions, configured in Settings → Images. Nothing uploads on paste, document open, or save.

## Upload service contract

The configured HTTPS service must accept `POST` multipart form data with an image in field `file`, allow the app's origin through CORS, and return JSON `{"url":"https://…"}`. Ambient credentials and redirects are disabled. The limit is 20 MB. Source replacement is skipped if the document changed while uploading. No real upload was performed during development; the transport was tested with a mock.

## Validation

- `npm test`: 12,538 checks pass, including catalog/grammar compatibility checks and 15 jsdom component interaction checks.
- `npm run audit:markdown`: all 90 whole-document preview fixtures and all 90 editor-block preview fixtures pass; all 90 retain exact editable source text.
- TypeScript, ESLint, production build, and offline Rust check pass.
- The audit's live-structure counter is a targeted DOM probe, not a visual score. It inspects the source styling function alone, so it does not measure the separate complex-block preview or floating source panel. CSS-generated glyphs are accounted for separately from the source-preservation check.

## Remaining limits

This is **not complete Typora parity**:

- KaTeX with a physics compatibility layer is not a complete MathJax runtime. Arbitrary MathJax extensions and user macros are not guaranteed to work; unsupported expressions retain source and display an error.
- Legacy diagrams use Mermaid layout. Engine-specific styling and individual flowchart port constraints are not pixel-identical to flowchart.js or js-sequence-diagrams.
- Ragged tables containing extra cells refuse structural edits to prevent silent content loss. Correct their column counts in source before reordering.
- Native WebKit geometry, drag animation, screen-reader behavior, real upload services, and rendered asynchronous diagram SVGs were not smoke-tested in this pass. Browser access was previously denied and was not retried.

The historical findings are preserved in [MARKDOWN-TYPORA-AUDIT.md](MARKDOWN-TYPORA-AUDIT.md). Re-run the fixtures independently; combining samples can intentionally introduce shared definitions and duplicate headings.

Catalog provenance: [Unicode 17 emoji data](https://unicode.org/Public/17.0.0/emoji/emoji-test.txt). Syntax references: [MathJax physics](https://docs.mathjax.org/en/latest/input/tex/extensions/physics.html), [js-sequence-diagrams](https://bramp.github.io/js-sequence-diagrams/), and [flowchart.js](https://flowchart.js.org/).
