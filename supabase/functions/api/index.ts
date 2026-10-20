// The CRM's server, as one Supabase Edge Function: every /api/* route in
// lib/server. server.js is lib/server packaged by `npm run build:edge` (the
// deploy workflow builds it; it isn't committed).
//
// Deployed with JWT checks off (supabase/config.toml), because Twilio,
// Google, Microsoft and the scheduler call it too: each route checks who is
// calling itself (sign-in token, webhook signature or cron secret).
import { handleRequest } from "./server.js";

Deno.serve((req: Request) => handleRequest(req));
