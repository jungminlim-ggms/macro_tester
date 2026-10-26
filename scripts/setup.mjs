import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const secret = () => randomBytes(24).toString("hex");
await writeFile(
  new URL("../.env", import.meta.url),
  `DB_PASSWORD=${secret()}\nADMIN_TOKEN=${secret()}\nTEST_PASSWORD=${secret()}\nTOKEN_SECRET=${secret()}\nALLOWED_ORIGINS=https://jungminlim-ggms.github.io,http://localhost:8080,http://127.0.0.1:8080\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  ".env created. Read TEST_PASSWORD and ADMIN_TOKEN locally. Never commit this file.",
);
