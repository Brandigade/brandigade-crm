// Fake Google + Microsoft for trying the email UI locally without real
// credentials:
//
//   npx tsx tests/fakes/email/dev-providers.ts            (port 3191)
//
// then start the CRM with the printed environment variables, e.g.
//   PORT=3101 APP_URL=http://localhost:3101 <vars> npm run dev
//
// "Connect Gmail" signs in as dev-gmail@gmail.test, "Connect Outlook" as
// dev-outlook@outlook.test. Both mailboxes get a few emails from/to
// emailtest-maya@cedar.example: add a lead with that address to see them.
import { serveFakeProviders } from "./serve.js";

const port = Number(process.env.FAKE_PROVIDERS_PORT || 3191);
const fakes = await serveFakeProviders({ port });
fakes.consentEmail.google = "dev-gmail@gmail.test";
fakes.consentEmail.microsoft = "dev-outlook@outlook.test";
const LEAD = "emailtest-maya@cedar.example";

fakes.google.addMessage("dev-gmail@gmail.test", {
  from: `Maya Rivera <${LEAD}>`,
  to: "dev-gmail@gmail.test",
  subject: "EMAILTEST Quote for the rebrand",
  html: `<div style="font-family:Georgia,serif;color:#333"><h2 style="color:#4F6CF0">Hi there!</h2><p>Here is our <b>budget</b> for the rebrand. <a href="https://example.com/brief">Brief</a></p>
    <p><img src="https://picsum.photos/seed/crm/400/120" alt="banner" width="400"></p><script>alert('xss')</script><p onclick="alert(1)">Click me (nothing happens)</p></div>`,
  text: "Hi there! Here is our budget for the rebrand.",
  daysAgo: 2,
  attachments: ["budget.pdf"],
});
fakes.google.addMessage("dev-gmail@gmail.test", { from: "news@shop.example", to: "dev-gmail@gmail.test", subject: "Not a lead", text: "50% off", daysAgo: 1 });
fakes.google.addMessage("dev-gmail@gmail.test", {
  from: "dev-gmail@gmail.test",
  to: LEAD,
  subject: "EMAILTEST Following up",
  text: "Hi Maya,\nJust following up on the proposal.\nThanks!",
  labels: ["SENT"],
  daysAgo: 1,
});
fakes.microsoft.addMessage("dev-outlook@outlook.test", { from: `Maya Rivera <${LEAD}>`, to: ["dev-outlook@outlook.test"], subject: "EMAILTEST Outlook hello", text: "Plain text body\nsecond line", daysAgo: 3 });

console.log(`Fake providers on ${fakes.base}\n`);
console.log(Object.entries(fakes.env).map(([k, v]) => `${k}=${v}`).join(" "));
process.on("SIGINT", async () => {
  await fakes.close();
  process.exit(0);
});
