import { ProviderError } from "../retry.js";
import { urls } from "./config.js";
import type { GraphMessage } from "./parse.js";
import type { MailboxAuth } from "./tokens.js";

// The Microsoft Graph mail calls the CRM makes. Every request asks for
// immutable ids, so a message keeps its id when it moves between folders
// (a sent draft keeps the id it had as a draft).

export const GRAPH_SELECT = [
  "id", "conversationId", "internetMessageId", "subject", "from", "sender", "toRecipients", "ccRecipients", "bccRecipients",
  "receivedDateTime", "sentDateTime", "hasAttachments", "bodyPreview", "isDraft", "parentFolderId",
].join(",");

const PREFER = 'IdType="ImmutableId", odata.maxpagesize=50';

/** The stored delta link is no longer valid: start that folder again. */
export class DeltaResetError extends Error {
  constructor() {
    super("The Outlook sync state expired");
    this.name = "DeltaResetError";
  }
}

export interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function isSyncStateError(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status === 410) return true;
  const code = String((err.body as any)?.error?.code || "");
  return /syncstate|resyncrequired|invaliddeltatoken/i.test(code);
}

export class GraphClient {
  constructor(private readonly auth: MailboxAuth) {}

  private get base() {
    return `${urls.graphApi()}/me`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Prefer: PREFER, ...extra };
  }

  me(): Promise<{ mail?: string | null; userPrincipalName?: string; displayName?: string }> {
    return this.auth.json(`${this.base}?$select=mail,userPrincipalName,displayName`, { headers: this.headers() });
  }

  /** Throws when the account has no Exchange Online mailbox. */
  async checkMailbox(): Promise<void> {
    await this.auth.json(`${this.base}/mailFolders/inbox?$select=id`, { headers: this.headers() });
  }

  async folderId(wellKnown: string): Promise<string | null> {
    try {
      const f = await this.auth.json<{ id: string }>(`${this.base}/mailFolders/${wellKnown}?$select=id`, { headers: this.headers() });
      return f?.id || null;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  /** The first delta request for a folder, limited to mail received since `since`. */
  deltaStartUrl(folder: "inbox" | "sentitems", since: Date): string {
    const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
    return `${this.base}/mailFolders/${folder}/messages/delta?$select=${GRAPH_SELECT}&$filter=${filter}`;
  }

  /** One page of a delta query (start URL, nextLink or deltaLink). */
  async delta(url: string): Promise<GraphPage<GraphMessage>> {
    try {
      return await this.auth.json<GraphPage<GraphMessage>>(url, { headers: this.headers() });
    } catch (err) {
      if (isSyncStateError(err)) throw new DeltaResetError();
      throw err;
    }
  }

  /** Full message with body and threading headers; null if it is gone. */
  async getMessage(id: string): Promise<GraphMessage | null> {
    try {
      return await this.auth.json<GraphMessage>(
        `${this.base}/messages/${encodeURIComponent(id)}?$select=${GRAPH_SELECT},body,internetMessageHeaders`,
        { headers: this.headers({ Prefer: `${PREFER}, outlook.body-content-type="html"` }) },
      );
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return null;
      throw err;
    }
  }

  /** Messages in any folder involving `address`, received on or after `since`. */
  searchUrl(address: string, since: Date): string {
    const kql = `"participants:${address} AND received>=${since.toISOString().slice(0, 10)}"`;
    return `${this.base}/messages?$search=${encodeURIComponent(kql)}&$select=${GRAPH_SELECT}&$top=25`;
  }

  page(url: string): Promise<GraphPage<GraphMessage>> {
    return this.auth.json<GraphPage<GraphMessage>>(url, { headers: this.headers() });
  }

  // ----- sending (never retried automatically; see GmailClient.send) -----
  createDraft(message: Record<string, unknown>): Promise<GraphMessage> {
    return this.auth.json(
      `${this.base}/messages`,
      { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(message) },
      { retries: 0 },
    );
  }

  createReply(messageId: string, message: Record<string, unknown>): Promise<GraphMessage> {
    return this.auth.json(
      `${this.base}/messages/${encodeURIComponent(messageId)}/createReply`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Prefer: `${PREFER}, outlook.body-content-type="html"` }),
        body: JSON.stringify({ message }),
      },
      { retries: 0 },
    );
  }

  updateDraft(id: string, patch: Record<string, unknown>): Promise<GraphMessage> {
    return this.auth.json(
      `${this.base}/messages/${encodeURIComponent(id)}`,
      { method: "PATCH", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(patch) },
      { retries: 0 },
    );
  }

  async sendDraft(id: string): Promise<void> {
    await this.auth.json(
      `${this.base}/messages/${encodeURIComponent(id)}/send`,
      { method: "POST", headers: this.headers(), body: "" },
      { retries: 0, timeoutMs: 60_000 },
    );
  }

  async deleteDraft(id: string): Promise<void> {
    const res = await this.auth.fetch(`${this.base}/messages/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.headers() }, { retries: 1 });
    await res.body?.cancel().catch(() => {});
  }
}
