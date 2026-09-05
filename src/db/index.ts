import { drizzle } from "drizzle-orm/libsql";
import "dotenv/config";

const db = drizzle({
  connection: {
    url: process.env.DATABASE_URL,
    authToken: process.env.TOKEN,
  },
});

export default db;
