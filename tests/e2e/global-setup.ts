import { execSync } from "node:child_process";

// Makes sure the local test accounts exist (idempotent; never wipes data).
export default function globalSetup() {
  execSync("npx tsx scripts/seed-local.ts", { stdio: "inherit" });
}
