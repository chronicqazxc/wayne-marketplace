import { login } from "./oauth.js";

login()
  .then((t) => {
    console.log(`Authenticated as ${t.name ?? t.sub}. Token expires ${new Date(t.expiresAt).toISOString()}.`);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
