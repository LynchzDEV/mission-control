# Markdown renderer: marked + DOMPurify

**Decision:** chat replies render through [`marked`](https://github.com/markedjs/marked) (GFM) and are sanitized with [`dompurify`](https://github.com/cure53/DOMPurify) before they reach the page (`client/markdown.ts`).

**Why:** the hand-written parser only handled code, bold and italic, so links such as `[text](url)` showed as raw text and tables, strikethrough and task lists were missing. Both libraries are small, widely used, maintained and dependency-free; writing a full GFM parser plus a sanitizer by hand is the riskier option.

**Sanitizing:** model output is untrusted. The sanitizer forbids `id`, `name` and `style` attributes (a reply could otherwise override the page's own element ids and break later rendering, or cover the UI) and the `form`, `input`, `button`, `textarea`, `select`, `img`, `iframe`, `object`, `embed` and `style` tags (no fake controls, no remote images that could leak data). Links open in a new tab with `rel="noopener noreferrer"`; `javascript:` URLs are removed.
