import { ProviderError } from "../retry.js";
import { urls } from "./config.js";
import type { GmailMessage } from "./parse.js";
import type { MailboxAuth } from "./tokens.js";

// The Gmail REST calls the CRM makes (no SDK; fetchWithRetry underneath).

const METADATA_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Message-ID", "In-Reply-To", "References", "Date"];

/** Gmail no longer has history that old: the caller must rescan. */
export class HistoryGoneError extends Error {
  constructor() {
    super("Gmail history is no longer available");
    this.name = "HistoryGoneError";
  }
}

export interface GmailHistoryPage {
  history?: { id: string; messagesAdded?: { message: { id: string; threadId?: string; labelIds?: string[] } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}

export class GmailClient {
  constructor(private readonly auth: MailboxAuth) {}

  private url(path: string, params?: Record<string, string | string[] | number | undefined>): string {
    const u = new URL(`${urls.gmailApi()}/users/me${path}`);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(x));
    }
    return u.toString();
  }

  profile(): Promise<{ emailAddress: string; historyId: string; messagesTotal?: number }> {
    return this.auth.json(this.url("/profile"));
  }

  async listMessages(q: string, pageToken?: string, maxResults = 100): Promise<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }> {
    return this.auth.json(this.url("/messages", { q, pageToken, maxResults }));
  }

  /** null when the message no longer exists. */
  async getMessage(id: string, format: "metadata" | "full"): Promise<GmailMessage | null> {
    const params = format === "metadata" ? { format, metadataHeaders: METADATA_HEADERS } : { format };
    try {
      return await this.auth.json<GmailMessage>(this.url(`/messages/${encodeURIComponent(id)}`, params));
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  async history(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage> {
    try {
      return await this.auth.json<GmailHistoryPage>(
        this.url("/history", { startHistoryId, pageToken, historyTypes: "messageAdded", maxResults: 500 }),
      );
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) throw new HistoryGoneError();
      throw err;
    }
  }

  /**
   * Sends a message. Never retried automatically: a timeout or a 5xx after
   * Gmail accepted the message would otherwise send it twice.
   */
  send(raw: string, threadId?: string | null): Promise<{ id: string; threadId?: string; labelIds?: string[] }> {
    return this.auth.json(
      this.url("/messages/send"),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(threadId ? { raw, threadId } : { raw }) },
      { retries: 0, timeoutMs: 60_000 },
    );
  }
}
