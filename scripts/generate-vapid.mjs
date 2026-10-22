import { generateVAPIDKeys } from "web-push";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
const [destination, subject] = process.argv.slice(2);
if (
  !destination ||
  !isAbsolute(destination) ||
  !/^mailto:[^\s@]+@[^\s@]+$/.test(subject ?? "")
) {
  console.error(
    "Usage: node scripts/generate-vapid.mjs /absolute/private/vapid.json mailto:operator@example.com",
  );
  process.exitCode = 1;
} else {
  try {
    writeFileSync(
      destination,
      JSON.stringify({ ...generateVAPIDKeys(), subject }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    console.log("VAPID file created; keys were not printed.");
  } catch {
    console.error("VAPID file unavailable or already exists.");
    process.exitCode = 1;
  }
}
