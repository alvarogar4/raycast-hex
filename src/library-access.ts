import { environment } from "@raycast/api";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { lockHistory } from "./transcript-store";

// Take Raycast's lock first so another extension command holding listener.lock cannot be mistaken for Hex.
export async function withLibraryAccess<T>(root: string, run: (offline: boolean) => Promise<T>): Promise<T> {
  const O_EXLOCK = 0x20;
  const request = await open(
    join(environment.supportPath, "library-operation.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_EXLOCK,
    0o600,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EAGAIN") throw new Error("Another Raycast library operation is in progress. Try again.");
    throw error;
  });
  try {
    const instance = await lockHistory(root);
    try {
      return await run(Boolean(instance));
    } finally {
      await instance?.close();
    }
  } finally {
    await request.close();
  }
}
