import sanitizeHtml from "sanitize-html";
import { LIMITS } from "./config.js";

// Email HTML is untrusted. It is sanitized before it is stored, and the
// browser additionally shows it only inside a sandboxed iframe with a strict
// Content-Security-Policy (js/email.js). Text is bounded in size everywhere.

const SAFE_VALUE = /^(?!.*(?:url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding))[^<>{};]{0,300}$/i;
const STYLE_PROPS = [
  "color", "background-color", "background", "font", "font-family", "font-size", "font-style", "font-weight",
  "text-align", "text-decoration", "text-transform", "text-indent", "line-height", "letter-spacing", "white-space",
  "vertical-align", "direction", "width", "max-width", "min-width", "height", "max-height", "min-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-style", "border-width",
  "border-radius", "border-collapse", "border-spacing", "list-style", "list-style-type", "display", "table-layout",
  "word-break", "word-wrap", "overflow-wrap",
];
const allowedStyles: Record<string, RegExp[]> = {};
for (const p of STYLE_PROPS) allowedStyles[p] = [SAFE_VALUE];

const CELL = ["width", "height", "colspan", "rowspan", "align", "valign", "bgcolor", "nowrap", "style"];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "abbr", "address", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code", "col",
    "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
    "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "sub",
    "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "tt", "u", "ul", "wbr",
  ],
  // script, style, title, head... are dropped together with their content.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head", "template", "xml", "iframe", "object", "svg", "math"],
  disallowedTagsMode: "discard",
  allowedAttributes: {
    "*": ["style", "dir", "lang", "title", "align"],
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "width", "height", "border"],
    table: ["width", "border", "cellpadding", "cellspacing", "bgcolor", "role"],
    td: CELL,
    th: CELL,
    tr: ["valign", "bgcolor"],
    col: ["span", "width"],
    colgroup: ["span", "width"],
    font: ["color", "face", "size"],
    ol: ["start", "type"],
    li: ["value"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
  allowProtocolRelative: false,
  allowedStyles: { "*": allowedStyles },
  transformTags: {
    a: (tagName, attribs) => {
      const out: Record<string, string> = { ...attribs, rel: "noopener noreferrer", target: "_blank" };
      if (!out.href) { delete out.target; delete out.rel; }
      return { tagName, attribs: out };
    },
  },
};

/** Sanitizes email HTML for storage. Returns null when nothing visible remains. */
export function sanitizeEmailHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  // Very large messages: cut first (sanitizing closes any tags left open).
  let clean = sanitizeHtml(html.length > LIMITS.bodyHtmlMax * 3 ? html.slice(0, LIMITS.bodyHtmlMax * 3) : html, OPTIONS);
  if (clean.length > LIMITS.bodyHtmlMax) clean = sanitizeHtml(clean.slice(0, LIMITS.bodyHtmlMax), OPTIONS);
  clean = clean.trim();
  return clean ? clean : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);/gi, (whole, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) {
      const cp = parseInt(lower.slice(2), 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (lower.startsWith("#")) {
      const cp = parseInt(lower.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[lower] ?? whole;
  });
}

/** Readable plain text from HTML (for body_text when a message has no text part). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  const s = html
    .replace(/<(script|style|head|title|noscript|template)[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clips text to `max` characters without splitting a surrogate pair. */
export function bound(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = s.split("\u0000").join("");
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** A one-line preview of a message. */
export function makeSnippet(text: string | null | undefined): string {
  return bound((text || "").replace(/\s+/g, " ").trim(), LIMITS.snippetMax) || "";
}

/** Escapes text for the simple HTML part of an email we send. */
export function textToHtml(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return esc.replace(/\r\n|\r|\n/g, "<br>\r\n");
}
