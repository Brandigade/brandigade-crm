import type { JobHandler } from "../jobs.js";

// Background work for calling (e.g. copying recordings to private storage).
export const voiceJobHandlers: Record<string, JobHandler> = {};
