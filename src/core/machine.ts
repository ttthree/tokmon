import os from "node:os";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { ensureTokmonDirectories, getMachineIdPath, pathExists } from "./config.js";

export async function getMachineId(): Promise<string> {
  await ensureTokmonDirectories();
  const machineIdPath = getMachineIdPath();
  if (await pathExists(machineIdPath)) {
    const persisted = (await fs.readFile(machineIdPath, "utf8")).trim();
    if (persisted) {
      return persisted;
    }
  }

  const hostname = os.hostname();
  const machineId = `${hostname}-${createHash("sha256").update(hostname + getFirstMacAddress()).digest("hex").slice(0, 6)}`;
  await fs.writeFile(machineIdPath, machineId + "\n", "utf8");
  return machineId;
}

function getFirstMacAddress(): string {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) {
      continue;
    }
    for (const addr of addrs) {
      if (!addr.internal && addr.mac && addr.mac !== "00:00:00:00:00:00") {
        return addr.mac;
      }
    }
  }
  return "unknown";
}
