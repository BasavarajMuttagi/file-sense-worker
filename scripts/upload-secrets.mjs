import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const envFilePath = path.resolve(process.cwd(), ".env");

if (!fs.existsSync(envFilePath)) {
  console.error("❌ Error: .env file not found in the current working directory.");
  process.exit(1);
}

const envContent = fs.readFileSync(envFilePath, "utf-8");
const lines = envContent.split(/\r?\n/);

const secrets = [];

for (const line of lines) {
  const trimmed = line.trim();
  // Skip comments and empty lines
  if (!trimmed || trimmed.startsWith("#")) {
    continue;
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex === -1) {
    continue;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  // Strip enclosing single or double quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  if (key && value) {
    secrets.push({ key, value });
  }
}

if (secrets.length === 0) {
  console.log("⚠️  No valid key=value pairs found in .env file.");
  process.exit(0);
}

console.log(`🔐 Found ${secrets.length} variables in .env to upload to Cloudflare Secrets...\n`);

async function putSecret(key, value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`⏳ Uploading ${key}... `);

    const child = spawn("npx", ["wrangler", "secret", "put", key], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Done");
        resolve();
      } else {
        console.log(`❌ Failed (exit code ${code})`);
        if (stderr.trim()) {
          console.error(`   ${stderr.trim()}`);
        }
        resolve(); // Continue with next secret even if one fails
      }
    });

    child.on("error", (err) => {
      console.log(`❌ Error: ${err.message}`);
      resolve();
    });

    // Feed the secret value into stdin
    child.stdin.write(value);
    child.stdin.end();
  });
}

async function uploadAll() {
  for (const { key, value } of secrets) {
    await putSecret(key, value);
  }
  console.log("\n🎉 Finished uploading secrets to Cloudflare Workers!");
}

uploadAll();
