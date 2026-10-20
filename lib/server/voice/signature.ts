import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import { getEnv, serverUrl } from "../env.js";
import { forbidden, HttpError, readForm } from "../http.js";
import { publicUrl } from "../router.js";

/**
 * Reads a Twilio webhook and proves it came from Twilio: X-Twilio-Signature
 * must be the HMAC of the public URL (rebuilt from SERVER_URL, never from the
 * Host header) plus the form parameters, keyed with TWILIO_AUTH_TOKEN. Every
 * voice webhook calls this before it does anything else.
 */
export async function readTwilioWebhook(req: Request): Promise<Record<string, string>> {
  const authToken = getEnv("TWILIO_AUTH_TOKEN");
  // Without the auth token nothing can be verified, so nothing is accepted.
  if (!authToken) throw new HttpError(503, "Calling isn't set up on the server yet.", "not_configured");
  const signature = req.headers.get("x-twilio-signature");
  if (!signature) throw forbidden("Missing Twilio signature");
  const params = await readForm(req);
  const url = publicUrl(req, serverUrl());
  let valid: boolean;
  try {
    valid = validateRequest(authToken, signature, url, params);
  } catch {
    valid = false;
  }
  if (!valid) {
    console.warn("Rejected a voice webhook with an invalid signature for", url.split("?")[0]);
    throw forbidden("Invalid Twilio signature");
  }
  // Belt and braces: a validly signed request must also be for our account.
  const accountSid = getEnv("TWILIO_ACCOUNT_SID");
  if (accountSid && params.AccountSid && params.AccountSid !== accountSid) throw forbidden("Webhook for another Twilio account");
  return params;
}
