#!/usr/bin/env bash
# Deploys the CRM's server to Supabase (run by .github/workflows/deploy.yml):
#
#   1. copies the settings from the GitHub secrets into the Supabase Edge
#      Function's settings (a secret removed in GitHub is removed there too),
#      and points Twilio at the server when calling is set up
#   2. deploys the Edge Function "api"
#   3. applies new database migrations
#   4. points Supabase's scheduler at the server
#   5. checks it answers, and writes which features are on to the run summary
#
# Steps 1-2 change nothing the current site uses, so if they fail the CRM
# carries on as before. After the database is updated, problems are reported
# as warnings and the new site is still published.
#
# Needs SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD and SUPABASE_PROJECT_REF.
# Secret values are never printed.
set -euo pipefail

REF="$SUPABASE_PROJECT_REF"
owner="$(echo "${GITHUB_REPOSITORY_OWNER:-brandigade}" | tr '[:upper:]' '[:lower:]')"
repo="${GITHUB_REPOSITORY#*/}"
export APP_URL="${APP_URL:-https://${owner}.github.io/${repo}}"
APP_URL="${APP_URL%/}"
export SERVER_URL="https://${REF}.supabase.co/functions/v1"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

supabase link --project-ref "$REF" --password "$SUPABASE_DB_PASSWORD" >/dev/null

echo "== Settings"
existing="$(supabase secrets list --project-ref "$REF" -o json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const s of JSON.parse(d||"[]"))console.log(s.name)})')"
has() { grep -qx "$1" <<<"$existing"; }

settings="$(mktemp)"
trap 'rm -f "$settings"' EXIT
chmod 600 "$settings"
put() { printf '%s=%s\n' "$1" "$2" >>"$settings"; }

put APP_URL "$APP_URL"
put SERVER_URL "$SERVER_URL"
put APP_NAME "${APP_NAME:-Brandigade CRM}"

# Made once, then kept: changing it would disconnect every mailbox.
if ! has TOKEN_ENCRYPTION_KEY; then
  key="$(openssl rand -base64 32)"
  echo "::add-mask::$key"
  put TOKEN_ENCRYPTION_KEY "$key"
  echo "Created the mailbox encryption key."
fi
# A new scheduler secret on every deploy (stored in Supabase Vault below).
cron_secret="$(openssl rand -hex 32)"
echo "::add-mask::$cron_secret"
put CRON_SECRET "$cron_secret"

OPTIONAL=(GMAIL_USER GMAIL_APP_PASSWORD RESEND_API_KEY NOTIFICATION_FROM_EMAIL
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET MICROSOFT_TENANT_ID
  TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_API_KEY_SID TWILIO_API_KEY_SECRET TWILIO_CALLER_ID)
to_remove=()
for name in "${OPTIONAL[@]}"; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    put "$name" "$value"
  elif has "$name"; then
    to_remove+=("$name")
  fi
done

# Calling: point the Twilio number and TwiML App at the server.
if [ -n "${TWILIO_ACCOUNT_SID:-}" ] && { [ -n "${TWILIO_API_KEY_SID:-}" ] || [ -n "${TWILIO_AUTH_TOKEN:-}" ]; }; then
  echo "== Twilio"
  out="$(npm run --silent setup:twilio)" || { echo "$out"; echo "::warning::Twilio setup failed, so calling stays off. Check the TWILIO_* secrets."; out=""; }
  echo "$out" | grep -v "TWILIO_TWIML_APP_SID" || true
  twiml="$(echo "$out" | sed -n 's/^ *TWILIO_TWIML_APP_SID=\(AP[0-9a-fA-F]\{32\}\).*/\1/p' | head -n1)"
  if [ -n "$twiml" ]; then put TWILIO_TWIML_APP_SID "$twiml"; fi
elif has TWILIO_TWIML_APP_SID; then
  to_remove+=(TWILIO_TWIML_APP_SID)
fi

supabase secrets set --project-ref "$REF" --env-file "$settings" >/dev/null
if [ "${#to_remove[@]}" -gt 0 ]; then
  supabase secrets unset --project-ref "$REF" --yes "${to_remove[@]}" >/dev/null
  echo "Removed settings no longer in GitHub: ${to_remove[*]}"
fi

echo "== Server"
npm run --silent build:edge
supabase functions deploy api --project-ref "$REF" --no-verify-jwt

echo "== Database"
supabase db push --password "$SUPABASE_DB_PASSWORD" --yes

# From here on the new version is live in the database: report problems, but
# let the workflow go on and publish the new site.
set +e
echo "== Scheduler"
service_key="$(supabase projects api-keys --project-ref "$REF" -o json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const k=JSON.parse(d||"[]").find(x=>x.name==="service_role");process.stdout.write(k?k.api_key:"")})')"
if [ -n "$service_key" ]; then echo "::add-mask::$service_key"; fi
if SUPABASE_URL="https://${REF}.supabase.co" SUPABASE_SERVICE_ROLE_KEY="$service_key" CRON_SECRET="$cron_secret" npm run --silent setup:cron >/dev/null; then
  echo "The scheduler calls $SERVER_URL/api/cron/tick every minute."
else
  echo "::warning::The scheduler couldn't be set up, so reminder emails and mailbox sync are paused. Run this workflow again."
fi

echo "== Check"
config=""
for _ in $(seq 1 "${DEPLOY_CHECK_TRIES:-12}"); do
  config="$(curl -fsS -m 20 "$SERVER_URL/api/config" || true)"
  [ -n "$config" ] && break
  sleep 5
done
if [ -z "$config" ]; then
  echo "::warning::The server at $SERVER_URL doesn't answer yet. Run this workflow again in a few minutes."
  exit 0
fi
echo "$config" | node -e '
let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const f = JSON.parse(d).features || {};
  const row = (name, on, how) => `| ${name} | ${on ? "On" : "Off"} | ${on ? "" : how} |`;
  const lines = [
    "### What is switched on",
    "",
    "| Feature | Status | To switch it on |",
    "|---|---|---|",
    row("Task emails and invites", f.notifications, "add GMAIL_USER + GMAIL_APP_PASSWORD (or RESEND_API_KEY)"),
    row("Gmail mailboxes", f.gmail, "add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"),
    row("Outlook mailboxes", f.outlook, "add MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET"),
    row("Calling", f.calling, "add the TWILIO_* secrets"),
    "",
    "See SETUP.md in the repository.",
  ];
  console.log(lines.join("\n"));
});' | tee -a "$summary"
