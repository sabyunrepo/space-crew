import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { createHandler, PendingRepository } from "../_shared/handler.ts";
const url = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
if (!url || !anonKey)
  throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY required");
const auth = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(
  createHandler({
    repository: new PendingRepository(), // Replace with an atomic Postgres repository after server implementation.
    allowedOrigins: (Deno.env.get("CREW_ALLOWED_ORIGINS") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    authenticate: async (token) => {
      const { data, error } = await auth.auth.getUser(token);
      return error ? null : (data.user?.id ?? null);
    },
    playableMissionIds: [],
  }),
);
