import http from "node:http";
import type { AddressInfo } from "node:net";
import { FakeGoogle } from "./fake-google.js";
import { FakeMicrosoft } from "./fake-microsoft.js";

// Runs the Google and Microsoft fakes behind one local HTTP server:
//   <base>/google/...   (auth, token, revoke, gmail/v1/...)
//   <base>/ms/...       (login/<tenant>/oauth2/v2.0/..., graph/v1.0/...)
// GET .../auth and .../authorize act as the consent screen: they redirect
// straight back to the CRM with a code for `consentEmail`.

export interface FakeProviders {
  base: string;
  google: FakeGoogle;
  microsoft: FakeMicrosoft;
  /** The mailbox that "signs in" on the fake consent screens. */
  consentEmail: { google: string; microsoft: string };
  env: Record<string, string>;
  close: () => Promise<void>;
}

async function toRequest(req: http.IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method || "GET";
  return new Request(base + (req.url || "/"), { method, headers, body: method === "GET" || method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks) });
}

export async function serveFakeProviders(opts: { port?: number; host?: string } = {}): Promise<FakeProviders> {
  const google = new FakeGoogle();
  const microsoft = new FakeMicrosoft();
  const consentEmail = { google: "", microsoft: "" };
  const host = opts.host || "127.0.0.1";
  let base = "";
  const server = http.createServer(async (req, res) => {
    try {
      const request = await toRequest(req, base);
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname === "/google/auth") {
        response = new Response(null, { status: 302, headers: { Location: google.authorize(request.url, consentEmail.google || "someone@gmail.test") } });
      } else if (/^\/ms\/login\/[^/]+\/oauth2\/v2\.0\/authorize$/.test(url.pathname)) {
        response = new Response(null, { status: 302, headers: { Location: microsoft.authorize(request.url, consentEmail.microsoft || "someone@outlook.test") } });
      } else if (url.pathname.startsWith("/google/")) {
        response = await google.handle(request);
      } else if (url.pathname.startsWith("/ms/")) {
        response = await microsoft.handle(request);
      } else {
        response = new Response("not found", { status: 404 });
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err instanceof Error ? err.stack : err));
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port || 0, host, resolve));
  base = `http://${host}:${(server.address() as AddressInfo).port}`;
  microsoft.graphBase = `${base}/ms/graph/v1.0`;
  const env = {
    GOOGLE_CLIENT_ID: google.clientId,
    GOOGLE_CLIENT_SECRET: google.clientSecret,
    GOOGLE_AUTH_URL: `${base}/google/auth`,
    GOOGLE_TOKEN_URL: `${base}/google/token`,
    GOOGLE_REVOKE_URL: `${base}/google/revoke`,
    GMAIL_API_BASE: `${base}/google/gmail/v1`,
    MICROSOFT_CLIENT_ID: microsoft.clientId,
    MICROSOFT_CLIENT_SECRET: microsoft.clientSecret,
    MICROSOFT_TENANT_ID: "common",
    MICROSOFT_LOGIN_BASE: `${base}/ms/login`,
    GRAPH_API_BASE: `${base}/ms/graph/v1.0`,
  };
  return {
    base,
    google,
    microsoft,
    consentEmail,
    env,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
