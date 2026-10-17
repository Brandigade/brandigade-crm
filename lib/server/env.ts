// Environment access for the server. Every secret is read here and nowhere
// else, so it is easy to see what the server needs (see .env.example).
// Nothing in this file is ever sent to the browser.

export class ConfigError extends Error {
  constructor(public readonly variable: string, message?: string) {
    super(message || `${variable} is not set on the server`);
    this.name = "ConfigError";
  }
}

export function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = getEnv(name);
  if (!v) throw new ConfigError(name);
  return v;
}

/** Public base URL of the app, without a trailing slash. */
export function appUrl(): string {
  return (getEnv("APP_URL") || "http://localhost:3000").replace(/\/+$/, "");
}

export function appName(): string {
  return getEnv("APP_NAME") || "Brandigade CRM";
}

/** Which integrations have their credentials configured. */
export const features = {
  supabase: () => !!(getEnv("SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY") && getEnv("SUPABASE_ANON_KEY")),
  tokenEncryption: () => !!getEnv("TOKEN_ENCRYPTION_KEY"),
  gmail: () => !!(getEnv("GOOGLE_CLIENT_ID") && getEnv("GOOGLE_CLIENT_SECRET") && getEnv("TOKEN_ENCRYPTION_KEY")),
  outlook: () => !!(getEnv("MICROSOFT_CLIENT_ID") && getEnv("MICROSOFT_CLIENT_SECRET") && getEnv("TOKEN_ENCRYPTION_KEY")),
  notifications: () =>
    !!(getEnv("RESEND_API_KEY") || (getEnv("GMAIL_USER") && getEnv("GMAIL_APP_PASSWORD")) || getEnv("SMTP_HOST")),
  calling: () =>
    !!(
      getEnv("TWILIO_ACCOUNT_SID") &&
      getEnv("TWILIO_AUTH_TOKEN") &&
      getEnv("TWILIO_API_KEY_SID") &&
      getEnv("TWILIO_API_KEY_SECRET") &&
      getEnv("TWILIO_TWIML_APP_SID") &&
      getEnv("TWILIO_CALLER_ID")
    ),
  cron: () => !!getEnv("CRON_SECRET"),
};

/** Feature flags safe to show the browser (booleans only, never values). */
export function publicFeatures() {
  return {
    gmail: features.gmail(),
    outlook: features.outlook(),
    calling: features.calling(),
    notifications: features.notifications(),
  };
}
