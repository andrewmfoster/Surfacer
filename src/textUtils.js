// Strips HTML tags from TipTap-rendered card text for plain-text rendering
// (e.g. "recently deleted" previews where we don't want to instantiate a
// full TipTap editor per card). Output is intended for React text rendering,
// not innerHTML — React text rendering escapes whatever this returns, so
// imperfect tag stripping cannot become an XSS vector downstream.
export function plainText(html) {
  if (!html) return ''
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Wrap plain text as paragraphs so cross-window edits don't strip TipTap's HTML
// shape. Main window saves editor.getHTML() (e.g. "<p>foo</p>"); tray must match
// that shape or every tray edit would clobber rich formatting in the main view.
// Only &, <, > need escaping in text content — quotes round-trip clean through
// plainText() which doesn't decode &quot;/&#39;.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
export function toHtml(text) {
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => `<p>${line.replace(/[&<>]/g, c => HTML_ESCAPES[c])}</p>`)
    .join('')
}
