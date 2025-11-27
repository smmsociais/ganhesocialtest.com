import fs from "fs";

export function logToFile(msg) {
  const data = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFile("/app/logs.txt", data, () => {});
}
