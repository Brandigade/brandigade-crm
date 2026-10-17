import { createRouter } from "./router.js";
import { coreRoutes } from "./core-routes.js";
import { emailRoutes } from "./email/routes.js";
import { notificationRoutes } from "./notifications/routes.js";
import { voiceRoutes } from "./voice/routes.js";

// Every server route, served by the single Vercel function in api/index.ts.
export const handleRequest = createRouter([...coreRoutes, ...emailRoutes, ...notificationRoutes, ...voiceRoutes]);
