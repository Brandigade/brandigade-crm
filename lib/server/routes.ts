import { createRouter } from "./router.js";
import { coreRoutes } from "./core-routes.js";
import { emailRoutes } from "./email/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import { voiceRoutes } from "./voice/routes.js";

// Every server route: the Supabase Edge Function "api" (supabase/functions/api)
// in production, scripts/dev-server.ts locally.
export const handleRequest = createRouter([...coreRoutes, ...emailRoutes, ...notificationRoutes, ...voiceRoutes]);
