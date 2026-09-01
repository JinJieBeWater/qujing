import { appendFile } from "node:fs/promises";
import { withFileLock } from "../../src/private-files";

const [, , lockPath, logPath] = process.argv;
if (!lockPath || !logPath) throw new Error("lock and log paths are required");

await withFileLock(lockPath, async () => {
  await appendFile(logPath, `start ${process.pid}\n`);
  await Bun.sleep(25);
  await appendFile(logPath, `end ${process.pid}\n`);
});
