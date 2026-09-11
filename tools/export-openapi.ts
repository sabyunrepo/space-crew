import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  CapabilitiesSchema,
  CreateRoomSchema,
  EntrySchema,
  EnvelopeSchema,
  ErrorSchema,
  JoinRoomSchema,
  SnapshotSchema,
} from "../shared/contracts.ts";
const schemas = {
  Capabilities: CapabilitiesSchema,
  CreateRoom: CreateRoomSchema,
  Entry: EntrySchema,
  CommandEnvelope: EnvelopeSchema,
  JoinRoom: JoinRoomSchema,
  Snapshot: SnapshotSchema,
  ApiError: ErrorSchema,
  InviteRequest: z.object({ commandId: z.uuid() }).strict(),
  InviteResponse: z.object({ inviteToken: z.string().min(20).max(256) }),
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({
  "application/json": { schema: ref(name) },
});
const operation = (
  summary: string,
  response: string,
  body?: string,
  success = "200",
) => ({
  summary,
  ...(body ? { requestBody: { required: true, content: content(body) } } : {}),
  responses: {
    [success]: {
      description:
        "Success. Snapshot includes only the authenticated player’s hand.",
      content: content(response),
    },
    ...Object.fromEntries(
      [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 501].map((code) => [
        code,
        {
          description:
            (
              {
                409: "Revision, attempt or idempotency conflict",
                501: "Backend transaction repository is not implemented",
              } as Record<number, string>
            )[code] || "API error",
          content: content("ApiError"),
        },
      ]),
    ),
  },
});
const roomParameters = [
  {
    name: "roomId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  },
];
const doc = {
  openapi: "3.1.0",
  info: {
    title: "Space Crew API",
    version: "1.0.0",
    description:
      "Frontend integration contract. The supplied Edge scaffold reports backendReady=false and returns 501 for repository operations. Demo supports missions 1–4. Never expose authoritative hands or use client-supplied player identity.",
  },
  servers: [{ url: "https://PROJECT_API_HOST/functions/v1/crew-api" }],
  security: [{ bearerAuth: [], apiKey: [] }],
  paths: {
    "/capabilities": {
      get: operation(
        "Read implemented missions and backend readiness",
        "Capabilities",
      ),
    },
    "/rooms": {
      post: operation(
        "Create a room; idempotent by authenticated actor + commandId",
        "Entry",
        "CreateRoom",
        "201",
      ),
    },
    "/rooms/join": {
      post: operation(
        "Join with an invite or recover existing seat for the same auth identity",
        "Entry",
        "JoinRoom",
      ),
    },
    "/rooms/{roomId}": {
      parameters: roomParameters,
      get: operation(
        "Read caller-specific snapshot after reconnect or revision notification",
        "Snapshot",
      ),
    },
    "/rooms/{roomId}/commands": {
      parameters: roomParameters,
      post: operation(
        "Atomically validate and execute one command",
        "Snapshot",
        "CommandEnvelope",
      ),
    },
    "/rooms/{roomId}/invites": {
      parameters: roomParameters,
      post: operation(
        "Host issues expiring invite; idempotent by actor + commandId",
        "InviteResponse",
        "InviteRequest",
        "201",
      ),
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      apiKey: { type: "apiKey", in: "header", name: "apikey" },
    },
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => {
        const { $schema: _, ...json } = z.toJSONSchema(schema);
        return [name, json];
      }),
    ),
  },
};
await writeFile("docs/openapi.json", JSON.stringify(doc, null, 2) + "\n");
console.log("docs/openapi.json generated from shared/contracts.ts");
