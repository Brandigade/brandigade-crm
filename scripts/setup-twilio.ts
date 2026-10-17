// Points a Twilio account at this CRM:
//
//   npm run setup:twilio              create/update the TwiML App and the phone number
//   npm run setup:twilio -- --dry-run show what would change, change nothing
//
// Needs (environment, .env or .env.local):
//   APP_URL               the public https:// address of the CRM (e.g. https://brandigade-crm.vercel.app)
//   TWILIO_ACCOUNT_SID    AC...
//   TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET   (or TWILIO_AUTH_TOKEN)
//   TWILIO_CALLER_ID      optional: the Twilio number (E.164) that should ring the CRM
//   TWILIO_TWIML_APP_SID  optional: update this TwiML App instead of finding "Brandigade CRM" by name
//
// It creates (or updates) the TwiML App "Brandigade CRM" with Voice URL
// APP_URL/api/voice/outbound and status callback APP_URL/api/voice/status, sets
// the phone number's Voice URL to APP_URL/api/voice/incoming, and prints the
// values to put in the server environment (Vercel). Secrets are never printed.
// Safe to run again after APP_URL changes.
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain JS helper
import { loadLocalEnv } from "./env.mjs";
import { checkAppUrl, setupTwilio } from "../lib/server/voice/twilio-setup.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);

const env = (k: string) => (process.env[k] || "").trim();
const fail = (msg: string) => {
  console.error(msg);
  process.exit(1);
};

const dryRun = process.argv.includes("--dry-run");
const accountSid = env("TWILIO_ACCOUNT_SID");
if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) fail("TWILIO_ACCOUNT_SID is missing or isn't an Account SID (AC...).");
const keySid = env("TWILIO_API_KEY_SID");
const keySecret = env("TWILIO_API_KEY_SECRET");
const authToken = env("TWILIO_AUTH_TOKEN");
if (!(keySid && keySecret) && !authToken) fail("Set TWILIO_API_KEY_SID and TWILIO_API_KEY_SECRET (or TWILIO_AUTH_TOKEN).");
const appUrl = env("APP_URL").replace(/\/+$/, "");
const urlProblem = checkAppUrl(appUrl);
if (urlProblem) fail(urlProblem);
const callerId = env("TWILIO_CALLER_ID");
if (callerId && !/^\+[1-9]\d{6,14}$/.test(callerId)) fail("TWILIO_CALLER_ID must be in E.164 format, e.g. +14155550100.");

try {
  const result = await setupTwilio({
    accountSid,
    username: keySid && keySecret ? keySid : accountSid,
    password: keySid && keySecret ? keySecret : authToken,
    appUrl,
    callerId: callerId || undefined,
    twimlAppSid: env("TWILIO_TWIML_APP_SID") || undefined,
    apiBase: env("TWILIO_API_BASE") || undefined,
    dryRun,
    log: (line) => console.log(line),
  });
  console.log("");
  if (dryRun) console.log("Dry run: nothing was changed.");
  console.log("Set these on the server (Vercel -> Project Settings -> Environment Variables):");
  console.log(`  TWILIO_TWIML_APP_SID=${result.twimlAppSid ?? "(created on a real run)"}`);
  if (callerId) console.log(`  TWILIO_CALLER_ID=${callerId}`);
  console.log("  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET (from the Twilio Console)");
  if (result.phoneNumberAction === "not-found") console.log("\nIncoming calls are NOT set up: buy a Twilio number with Voice and use it as TWILIO_CALLER_ID.");
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
