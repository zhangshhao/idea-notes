// Server operator bootstrap: credentials arrive on stdin, never in argv or logs.
import { openDatabase, transaction } from "../server/db";
import {
  accountSchema,
  passwordSchema,
  hashPassword,
} from "../server/password";
import { uid, now } from "../server/domain";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const parsed = JSON.parse(input);
const account = accountSchema.parse(parsed.account);
const password = passwordSchema.parse(parsed.password);
const db = openDatabase(process.env.DATABASE_PATH || "./data/ideas.sqlite");
try {
  if (db.prepare("SELECT id FROM users WHERE email=?").get(account))
    throw new Error("Account already exists; refusing to replace credentials.");
  const encoded = await hashPassword(password);
  transaction(db, () => {
    const id = uid();
    db.prepare("INSERT INTO users VALUES(?,?,?,?,NULL)").run(
      id,
      account,
      now(),
      "2026-11-draft",
    );
    db.prepare("INSERT INTO password_credentials VALUES(?,?,?)").run(
      id,
      encoded,
      now(),
    );
  });
  console.log("Account created successfully.");
} finally {
  db.close();
}
