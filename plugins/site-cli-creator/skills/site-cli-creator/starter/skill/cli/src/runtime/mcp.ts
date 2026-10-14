// The `mcp` built-in's protocol side: JSON-RPC 2.0 over stdio, one JSON message per line
// (MCP's stdio transport), serving tools only. main.ts builds the tools from the same Task
// commands the CLI runs, so a tool result is exactly what the command prints: its result, a
// dry run, or an error envelope. Nothing else may reach stdout; progress stays on stderr.
import { z } from "zod";
import { render } from "./envelope";

/** Protocol versions this server speaks, newest first. A client asking for another gets the first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export type ToolAnnotations = { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

export type McpTool = {
  name: string;
  description: string;
  /** Validated by `call`; listed as the tool's JSON Schema. */
  schema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Runs the tool. Never throws: a failure comes back as an error envelope with a non-zero code. */
  call(args: Record<string, unknown>): Promise<{ output: unknown; code: number }>;
};

export type ServerInfo = { name: string; version: string; instructions: string };

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Id = string | number | null;

/** A Task command's name as a tool name: "invoice list" → "invoice_list". */
export const toolName = (commandName: string) => commandName.trim().split(/\s+/).join("_");

/** The JSON Schema of a tool's arguments, as the client sends them (Zod input side). */
export function inputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return json;
}

/** A tool's output as MCP content: the JSON as text (the CLI's own rendering), an object also as structured content. */
export function toolResult(output: unknown, code: number) {
  const structured = output !== null && typeof output === "object" && !Array.isArray(output);
  return {
    content: [{ type: "text", text: render(output ?? null).trimEnd() }],
    ...(structured && { structuredContent: output }),
    ...(code !== 0 && { isError: true }),
  };
}

const reply = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const isId = (v: unknown): v is Id => typeof v === "string" || typeof v === "number" || v === null;

export function createMcpServer(info: ServerInfo, tools: McpTool[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    /** One parsed message in, its response out; null for a notification, which gets none. */
    async handle(raw: unknown): Promise<object | null> {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return failure(null, -32600, "Invalid Request: one JSON-RPC object per line");
      const msg = raw as Message;
      const id = "id" in msg && isId(msg.id) ? msg.id : null;
      if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return failure(id, -32600, "Invalid Request");
      if (!("id" in msg)) return null;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      switch (msg.method) {
        case "initialize": {
          const asked = params.protocolVersion;
          return reply(id, {
            protocolVersion: typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            instructions: info.instructions,
          });
        }
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, {
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema), annotations: t.annotations })),
          });
        case "tools/call": {
          const tool = typeof params.name === "string" ? byName.get(params.name) : undefined;
          if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
          const args = params.arguments ?? {};
          if (args === null || typeof args !== "object" || Array.isArray(args)) return failure(id, -32602, "arguments must be an object");
          try {
            const { output, code } = await tool.call(args as Record<string, unknown>);
            return reply(id, toolResult(output, code));
          } catch {
            return failure(id, -32603, `${tool.name} failed inside the MCP server`);
          }
        }
        default:
          return failure(id, -32601, `Method not found: ${msg.method}`);
      }
    },
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;

/**
 * Serves stdin to stdout until stdin ends. Messages are handled one at a time, in order, so two
 * tool calls never refresh the same session at once. A line that is no JSON gets -32700, a message
 * the server throws on gets -32603, and a write that fails (the client closed the pipe: EPIPE)
 * ends the loop quietly, like emit().
 */
export async function serveStdio(
  server: McpServer,
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  write: (line: string) => Promise<unknown> = (line) => Bun.write(Bun.stdout, line),
): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  let closed = false;
  const send = async (msg: object) => {
    try {
      await write(JSON.stringify(msg) + "\n");
    } catch {
      closed = true;
    }
  };
  const answer = async (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return send(failure(null, -32700, "Parse error"));
    }
    let res: object | null;
    try {
      res = await server.handle(parsed);
    } catch {
      const id = (parsed as Message | null)?.id;
      res = failure(isId(id) ? id : null, -32603, "Internal error in the MCP server");
    }
    if (res) await send(res);
  };
  const reader = input.getReader();
  while (!closed) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl: number;
    while (!closed && (nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).replace(/\r$/, "");
      buffered = buffered.slice(nl + 1);
      await answer(line);
    }
  }
  if (!closed) await answer(buffered + decoder.decode());
  reader.releaseLock();
}
