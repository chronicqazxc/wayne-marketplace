import { TOKEN_PATH } from "./config.js";
import { login } from "./oauth.js";

login()
  .then(() => console.log(`Token saved to ${TOKEN_PATH}`))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
