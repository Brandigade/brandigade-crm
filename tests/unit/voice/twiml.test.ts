import { beforeEach, describe, expect, it } from "vitest";
import { announceTwiml, incomingTwiml, outboundTwiml, sayAndHangup, voicemailTwiml, type InboundClient } from "../../../lib/server/voice/twiml.js";
import { voiceUrls } from "../../../lib/server/voice/config.js";

beforeEach(() => {
  process.env.APP_URL = "https://crm.example/";
});

const attr = (xml: string, tag: string, name: string) => new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(xml)?.[1];

describe("outgoing call TwiML", () => {
  it("dials the number with our caller ID, status callbacks and no recording when it's off", () => {
    const xml = outboundTwiml({ callerId: "+14155550100", number: "+14155550143", recording: false, urls: voiceUrls() });
    expect(xml).toContain("<Number");
    expect(xml).toMatch(/>\+14155550143<\/Number>/);
    expect(attr(xml, "Dial", "callerId")).toBe("+14155550100");
    expect(attr(xml, "Dial", "answerOnBridge")).toBe("true");
    expect(attr(xml, "Dial", "action")).toBe("https://crm.example/api/voice/dial-complete");
    expect(attr(xml, "Number", "statusCallback")).toBe("https://crm.example/api/voice/status");
    expect(attr(xml, "Number", "statusCallbackEvent")).toBe("initiated ringing answered completed");
    expect(xml).not.toContain("record=");
    expect(xml).not.toContain("recordingStatusCallback");
    expect(attr(xml, "Number", "url")).toBeUndefined();
  });

  it("records both sides from answer and plays the announcement to the lead when recording is on", () => {
    const xml = outboundTwiml({ callerId: "+14155550100", number: "+14155550143", recording: true, urls: voiceUrls() });
    expect(attr(xml, "Dial", "record")).toBe("record-from-answer-dual");
    expect(attr(xml, "Dial", "recordingStatusCallback")).toBe("https://crm.example/api/voice/recording-status");
    expect(attr(xml, "Number", "url")).toBe("https://crm.example/api/voice/announce");
  });
});

describe("incoming call TwiML", () => {
  const clients: InboundClient[] = [
    { identity: "crm_" + "1".repeat(32), params: { callId: "call-1", contactId: "lead-1", recording: "on" } },
    { identity: "crm_" + "2".repeat(32), params: { callId: "call-1", recording: "on" } },
  ];
  it("announces recording, then rings every browser with the call's ids", () => {
    const xml = incomingTwiml({ announcement: "Calls are recorded.", recording: true, clients, urls: voiceUrls() });
    expect(xml.indexOf("<Say>Calls are recorded.</Say>")).toBeLessThan(xml.indexOf("<Dial"));
    expect(attr(xml, "Dial", "timeout")).toBe("25");
    expect(attr(xml, "Dial", "record")).toBe("record-from-answer-dual");
    expect(attr(xml, "Dial", "action")).toBe("https://crm.example/api/voice/dial-complete");
    expect(xml.match(/<Client /g)).toHaveLength(2);
    expect(xml).toContain(`<Identity>crm_${"1".repeat(32)}</Identity>`);
    expect(xml).toContain('<Parameter name="callId" value="call-1"/>');
    expect(xml).toContain('<Parameter name="contactId" value="lead-1"/>');
    expect(attr(xml, "Client", "statusCallbackEvent")).toBe("ringing answered completed");
  });
  it("no announcement and no recording when recording is off", () => {
    const xml = incomingTwiml({ announcement: null, recording: false, clients, urls: voiceUrls() });
    expect(xml).not.toContain("<Say>");
    expect(xml).not.toContain("record=");
  });
});

describe("escaping", () => {
  it("escapes the owner's announcement text", () => {
    const evil = `Recorded <Redirect>https://evil.example</Redirect> & "quoted" 'x'`;
    for (const xml of [announceTwiml(evil), incomingTwiml({ announcement: evil, recording: true, clients: [], urls: voiceUrls() })]) {
      expect(xml).not.toContain("<Redirect>");
      expect(xml).toContain("&lt;Redirect&gt;https://evil.example&lt;/Redirect&gt; &amp;");
    }
  });
  it("escapes attribute values", () => {
    const xml = incomingTwiml({ announcement: null, recording: false, clients: [{ identity: "crm_x", params: { callId: `a"><Hangup/>` } }], urls: voiceUrls() });
    expect(xml).not.toContain("<Hangup/>");
    expect(xml).toContain('value="a&quot;>&lt;Hangup/>"'); // the quote and "<" can't end the attribute or open a tag
  });
});

describe("voicemail and refusals", () => {
  it("voicemail: greeting, a two-minute recording and its own callbacks (never the Dial action)", () => {
    const xml = voicemailTwiml({ urls: voiceUrls() });
    expect(xml.indexOf("<Say>")).toBeLessThan(xml.indexOf("<Record"));
    expect(attr(xml, "Record", "maxLength")).toBe("120");
    expect(attr(xml, "Record", "recordingStatusCallback")).toBe("https://crm.example/api/voice/recording-status");
    expect(attr(xml, "Record", "action")).toBe("https://crm.example/api/voice/voicemail-done");
  });
  it("a refusal says why and hangs up", () => {
    expect(sayAndHangup("No <way>")).toMatch(/<Say>No &lt;way&gt;<\/Say><Hangup\/>/);
  });
});
