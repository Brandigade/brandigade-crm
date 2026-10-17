import { handleRequest } from "../lib/server/routes.js";

// The CRM's only Vercel Function. vercel.json rewrites /api/* here, and
// lib/server/routes.ts routes by path (Vercel recommends one shared function
// so Fluid compute can reuse warm instances across routes).
export default {
  fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  },
};
