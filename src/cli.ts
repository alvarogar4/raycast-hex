import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";

export class HexStopped extends Error {
  constructor() {
    super("Hex isn't running");
  }
}

const refused = z.object({
  version: z.literal(4),
  status: z.literal("error"),
  message: z.string(),
});

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function executeHex<T>(
  path: string,
  args: string[],
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!isAbsolute(path)) throw new Error("Set an absolute Hex CLI path in extension preferences.");
  return new Promise((resolve, reject) => {
    // Never propagate a child_process error: its message contains argv and can include private text.
    execFile(path, args, { signal, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error?.code === 3) return reject(new HexStopped());
      const json = parse(stdout);
      if (error) {
        const reply = refused.safeParse(json);
        const fallback =
          error.code === 2
            ? "Hex rejected the command arguments."
            : typeof error.code === "number"
              ? "Hex could not complete the command."
              : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                ? "Hex returned too much data. Narrow the filters."
                : "Could not run the Hex CLI. Check the executable path in extension preferences.";
        return reject(new Error(reply.success ? reply.data.message : fallback));
      }
      const reply = schema.safeParse(json);
      if (!reply.success) return reject(new Error("Unexpected Hex JSON reply. Check the CLI version."));
      resolve(reply.data);
    });
  });
}
