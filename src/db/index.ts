import { createClient } from "@libsql/client/web";
import { drizzle } from "drizzle-orm/libsql";
import { relations } from "./schema";

let cachedDb: ReturnType<typeof drizzle<typeof relations>> | null = null;
let cachedUrl: string | null = null;

export function getDb(env: { DATABASE_URL: string; TOKEN: string }) {
  if (cachedDb && cachedUrl === env.DATABASE_URL) {
    return cachedDb;
  }
  const client = createClient({
    url: env.DATABASE_URL,
    authToken: env.TOKEN,
  });
  cachedDb = drizzle({ client, relations });
  cachedUrl = env.DATABASE_URL;
  return cachedDb;
}

export * from "./schema";
export default getDb;
