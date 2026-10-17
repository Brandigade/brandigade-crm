import { describe, expect, it } from "vitest";
import { assertNoLineBreaks, buildMime, encodeHeaderText, encodeWords, formatAddress, HeaderInjectionError, toBase64Url } from "../../../lib/server/email/mime.js";
import { decodeMimeWords, normalizeAddress } from "../../../lib/server/email/addresses.js";
import { validateSendInput } from "../../../lib/server/email/send.js";

const CRLF = "\r\n";
const headerBlock = (raw: string) => raw.split(CRLF + CRLF)[0];
const unfold = (h: string) => h.replace(/\r\n[ \t]+/g, " ");
const headerValue = (raw: string, name: string) => {
  const line = unfold(headerBlock(raw)).split(CRLF).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(name.length + 1).trim() : null;
};
function decodePart(raw: string, type: string) {
  const m = new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(raw);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8") : null;
}

describe("MIME building", () => {
  const base = { from: { email: "eddie@brandigade.com", name: "Eddie Editor" }, to: [{ email: "maya@cedar.example", name: null }], subject: "Proposal", text: "Hi Maya,\nSee attached.\n" };

  it("produces a well-formed multipart/alternative message with CRLF line endings", () => {
    const { raw, messageId } = buildMime(base);
    expect(raw).not.toMatch(/[^\r]\n/); // every newline is CRLF
    expect(headerValue(raw, "From")).toBe('"Eddie Editor" <eddie@brandigade.com>');
    expect(headerValue(raw, "To")).toBe("maya@cedar.example");
    expect(headerValue(raw, "Subject")).toBe("Proposal");
    expect(headerValue(raw, "MIME-Version")).toBe("1.0");
    expect(headerValue(raw, "Message-ID")).toBe(messageId);
    expect(messageId).toMatch(/^<[^<>\s]+@brandigade\.com>$/);
    expect(headerValue(raw, "Date")).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    expect(headerValue(raw, "Content-Type")).toMatch(/^multipart\/alternative; boundary="=_crm_[0-9a-f]+"$/);
    expect(decodePart(raw, "text/plain")).toBe("Hi Maya,\r\nSee attached.\r\n");
    expect(decodePart(raw, "text/html")).toContain("Hi Maya,<br>");
    for (const line of raw.split(CRLF)) expect(line.length).toBeLessThanOrEqual(998);
    expect(headerValue(raw, "In-Reply-To")).toBeNull();
  });

  it("encodes non-ASCII subjects and names as RFC 2047 words without splitting characters", () => {
    const subject = "Angebot für Café ☕ — " + "ü".repeat(60);
    const { raw } = buildMime({ ...base, subject, from: { email: "eddie@brandigade.com", name: "Zoë Łukasz" } });
    const s = headerValue(raw, "Subject")!;
    expect(s).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeMimeWords(s)).toBe(subject);
    expect(decodeMimeWords(headerValue(raw, "From")!)).toBe("Zoë Łukasz <eddie@brandigade.com>");
    for (const w of encodeWords(subject)) expect(w.length).toBeLessThanOrEqual(75);
    // every header line is folded short
    for (const line of headerBlock(raw).split(CRLF)) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("keeps plain ASCII subjects readable and quotes display names", () => {
    expect(encodeHeaderText("Quick question")).toBe("Quick question");
    expect(formatAddress({ email: "a@b.co", name: 'Doe, "J"' })).toBe('"Doe, \\"J\\"" <a@b.co>');
    expect(encodeHeaderText("looks like =?UTF-8?B?eA==?= a word")).toMatch(/^=\?UTF-8\?B\?/);
  });

  it("escapes the HTML alternative", () => {
    const { raw } = buildMime({ ...base, text: '<script>alert("x")</script> & co' });
    const html = decodePart(raw, "text/html")!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
  });

  it("adds In-Reply-To and References for replies", () => {
    const { raw, inReplyTo, references } = buildMime({ ...base, subject: "Re: Proposal", inReplyTo: "<orig@cedar.example>", references: "<first@cedar.example> <orig@cedar.example>" });
    expect(headerValue(raw, "In-Reply-To")).toBe("<orig@cedar.example>");
    expect(headerValue(raw, "References")).toBe("<first@cedar.example> <orig@cedar.example>");
    expect(inReplyTo).toBe("<orig@cedar.example>");
    expect(references).toBe("<first@cedar.example> <orig@cedar.example>");
    const second = buildMime({ ...base, inReplyTo: "orig2@cedar.example", references: null });
    expect(headerValue(second.raw, "References")).toBe("<orig2@cedar.example>");
  });

  it("folds long recipient lists between addresses", () => {
    const to = Array.from({ length: 12 }, (_, i) => ({ email: `person${i}@example.com`, name: `Person Number ${i}` }));
    const { raw } = buildMime({ ...base, to, cc: [{ email: "boss@example.com", name: null }] });
    const block = headerBlock(raw);
    expect(block).toMatch(/To: [^\r]+,\r\n [^\r]+/);
    expect(unfold(block)).toContain("Person Number 11");
    expect(headerValue(raw, "Cc")).toBe("boss@example.com");
  });

  it("refuses CR/LF in any header field (header injection)", () => {
    expect(() => buildMime({ ...base, subject: "Hi\r\nBcc: victim@example.com" })).toThrow(HeaderInjectionError);
    expect(() => buildMime({ ...base, subject: "Hi\nBcc: x@y.z" })).toThrow(HeaderInjectionError);
    expect(() => buildMime({ ...base, from: { email: "a@b.co", name: "Eve\r\nBcc: x@y.z" } })).toThrow(HeaderInjectionError);
    expect(() => buildMime({ ...base, to: [{ email: "a@b.co\r\nBcc: x@y.z", name: null }] })).toThrow();
    expect(() => assertNoLineBreaks("subject", "ok")).not.toThrow();
  });

  it("base64url-encodes the raw message for Gmail", () => {
    const { raw } = buildMime(base);
    const enc = toBase64Url(raw);
    expect(enc).not.toMatch(/[+/=]/);
    expect(Buffer.from(enc, "base64url").toString("utf8")).toBe(raw);
  });
});

describe("send input validation", () => {
  const ok = { clientRequestId: "6f1c2e7a-1b2c-4d3e-8f90-123456789abc", to: ["Maya@Cedar.example"], subject: "Hi", bodyText: "Hello" };
  it("normalizes recipients and drops Cc duplicates", () => {
    const v = validateSendInput({ ...ok, to: ["Maya@Cedar.example", { email: "bo@x.io", name: "Bo" }], cc: ["maya@cedar.example", "c@x.io"] });
    expect(v.to).toEqual([{ email: "maya@cedar.example", name: null }, { email: "bo@x.io", name: "Bo" }]);
    expect(v.cc).toEqual([{ email: "c@x.io", name: null }]);
  });
  it("rejects bad input with clear codes", () => {
    expect(() => validateSendInput({ ...ok, clientRequestId: "nope" })).toThrow(/UUID/);
    expect(() => validateSendInput({ ...ok, to: [] })).toThrow(expect.objectContaining({ code: "invalid_recipient" }));
    expect(() => validateSendInput({ ...ok, to: ["not an address"] })).toThrow(expect.objectContaining({ code: "invalid_recipient" }));
    expect(() => validateSendInput({ ...ok, subject: "Hi\r\nBcc: x@y.z" })).toThrow(expect.objectContaining({ code: "invalid_header" }));
    expect(() => validateSendInput({ ...ok, to: [{ email: "a@b.co", name: "A\nBcc: x@y.z" }] })).toThrow(expect.objectContaining({ code: "invalid_header" }));
    expect(() => validateSendInput({ ...ok, to: ["a@b.co\nbcc:x@y.z"] })).toThrow(expect.objectContaining({ code: "invalid_header" }));
    expect(() => validateSendInput({ ...ok, subject: "", bodyText: "  " })).toThrow(expect.objectContaining({ code: "empty_email" }));
    expect(() => validateSendInput({ ...ok, subject: "x".repeat(999) })).toThrow(expect.objectContaining({ code: "invalid_subject" }));
    expect(() => validateSendInput({ ...ok, bodyText: "x".repeat(100_001) })).toThrow(expect.objectContaining({ code: "invalid_body" }));
    expect(() => validateSendInput({ ...ok, to: Array.from({ length: 51 }, (_, i) => `p${i}@x.io`) })).toThrow(expect.objectContaining({ code: "too_many_recipients" }));
    expect(() => validateSendInput({ ...ok, accountId: "x" })).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
  it("validates addresses strictly", () => {
    expect(normalizeAddress("  Jane.Doe+crm@Example.COM ")).toBe("jane.doe+crm@example.com");
    expect(normalizeAddress("josé@münchen.de")).toBeNull(); // non-ASCII local part
    expect(normalizeAddress("jose@münchen.de")).toBe("jose@xn--mnchen-3ya.de");
    for (const bad of ["a@b", "a b@c.de", "<a@b.co>", "a@b.co,c@d.co", "a@-b.co", "@b.co", "a@b.123", '"a"@b.co', "a..b@c.co"]) {
      expect(normalizeAddress(bad)).toBeNull();
    }
  });
});
