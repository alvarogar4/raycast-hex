import { getPreferenceValues } from "@raycast/api";
import { z } from "zod";
import { executeHex } from "./cli";

function hex<T>(args: string[], schema: z.ZodType<T>, signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
  const { hexPath } = getPreferenceValues<{ hexPath: string }>();
  return executeHex(hexPath || "/Applications/Hex.app/Contents/MacOS/hex", args, schema, signal, env);
}

const v4 = z.literal(4);
const v1 = z.literal(1);
const done = z.object({
  version: v4,
  status: z.literal("done"),
  message: z.string(),
  changed: z.boolean(),
});

// --json goes before any positional terminator. User-supplied positionals follow --.
export function control(command: string[], args: string[] = []) {
  return hex([...command, "--json", ...args], done);
}

const historyEntry = z.object({
  id: z.number(),
  timestamp_ms: z.number(),
  application: z.string().nullable(),
  final_text: z.string(),
  raw_text: z.string().nullish(),
});
export type HistoryEntry = z.infer<typeof historyEntry>;
const historyReply = z.object({
  version: v1,
  entries: z.array(historyEntry),
  truncated: z.boolean(),
});
export async function readHistory(query: string, app: string, since: string, limit: number, signal?: AbortSignal) {
  const args = ["history", "--json", "--raw", "--limit", String(limit)];
  if (query.trim()) args.push(`--search=${query}`);
  if (app) args.push(`--app=${app}`);
  if (since) args.push("--since", since);
  return { ...(await hex(args, historyReply, signal)), query, app, since };
}

export async function readApps() {
  const reply = await hex(
    ["history", "--json", "--limit", "200"],
    z.object({
      version: v1,
      entries: z.array(z.object({ application: z.string().nullable() })),
    }),
  );
  return [...new Set(reply.entries.flatMap(({ application }) => (application ? [application] : [])))].sort();
}

const statusReply = z.object({
  version: v4,
  status: z.literal("status"),
  capture: z.object({
    state: z.string(),
    recording: z.string().nullable(),
    pending_jobs: z.number(),
  }),
  model: z.object({
    id: z.string(),
    name: z.string(),
    language: z.string(),
    preparing: z.string().nullable(),
    error: z.string().nullable(),
  }),
  meeting: z.object({
    state: z.string(),
    title: z.string().nullable(),
    elapsed_seconds: z.number().nullable(),
  }),
});
export function readStatus() {
  return hex(["status", "--json"], statusReply);
}

const model = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string(),
  installed: z.boolean(),
  languages: z.array(z.string()),
});
export type Model = z.infer<typeof model>;

export async function readModels() {
  const [catalog, status] = await Promise.all([
    hex(
      ["model", "list", "--json"],
      z.object({
        version: v4,
        status: z.literal("models"),
        models: z.array(model),
      }),
    ),
    readStatus(),
  ]);
  return { models: catalog.models, current: status.model };
}

export function readVocabulary() {
  return hex(
    ["vocabulary", "list", "--json"],
    z.object({
      version: v4,
      status: z.literal("vocabulary"),
      entries: z.array(
        z.object({
          term: z.string(),
          sounds_like: z.array(z.string()).optional(),
        }),
      ),
    }),
  );
}

const setting = z.object({
  key: z.string(),
  kind: z.string(),
  value: z.json(),
  about: z.string(),
  choices: z.array(z.string()).optional(),
  writable: z.boolean(),
  available: z.boolean(),
});
export type Setting = z.infer<typeof setting>;
const settingsReply = z.object({
  version: v4,
  status: z.literal("settings"),
  settings: z.array(setting),
});
export function readSettings(key?: string) {
  return hex(key ? ["settings", "get", "--json", "--", key] : ["settings", "list", "--json"], settingsReply);
}

const meeting = z.object({
  id: z.string(),
  title: z.string(),
  timestamp_ms: z.number(),
  application: z.string().nullable(),
  status: z.string(),
  in_progress: z.boolean(),
});
export type Meeting = z.infer<typeof meeting>;

export function readMeetings(library?: string) {
  return hex(
    ["meetings", "list", "--json", "--limit", "200"],
    z.object({
      version: v1,
      truncated: z.boolean(),
      meetings: z.array(meeting),
    }),
    undefined,
    library ? { ...process.env, HEX_APPLICATION_SUPPORT_DIR: library } : undefined,
  );
}
