// Packages the server (lib/server) into one file for the Supabase Edge
// Function "api" (supabase/functions/api), which runs on Deno:
//
//   npm run build:edge   ->  supabase/functions/api/server.js  (not committed)
//
// The deploy workflow runs this before `supabase functions deploy api`. Node
// built-ins stay as `node:` imports, which Deno provides.
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

await build({
  entryPoints: [path.join(root, "lib/server/routes.ts")],
  outfile: path.join(root, "supabase/functions/api/server.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
  plugins: [
    {
      name: "node-builtins",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) =>
          builtins.has(args.path) ? { path: args.path.startsWith("node:") ? args.path : `node:${args.path}`, external: true } : undefined,
        );
      },
    },
  ],
  // Some dependencies are CommonJS and use Node's require(), Buffer, process and setImmediate.
  banner: {
    js: [
      'import { createRequire as __crmRequire } from "node:module";',
      'import { Buffer as __crmBuffer } from "node:buffer";',
      'import __crmProcess from "node:process";',
      'import { setImmediate as __crmSetImmediate, clearImmediate as __crmClearImmediate } from "node:timers";',
      "const require = __crmRequire(import.meta.url);",
      "globalThis.Buffer ??= __crmBuffer;",
      "globalThis.process ??= __crmProcess;",
      "globalThis.setImmediate ??= __crmSetImmediate;",
      "globalThis.clearImmediate ??= __crmClearImmediate;",
    ].join("\n"),
  },
});
console.log("Built supabase/functions/api/server.js");
