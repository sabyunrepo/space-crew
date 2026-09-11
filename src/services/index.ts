import { MockService } from "./mock.ts";
import { SupabaseService } from "./supabase.ts";
import type { GameService } from "../../shared/contracts.ts";
export function makeService(): GameService {
  const mode = import.meta.env.VITE_BACKEND_MODE || "mock";
  if (mode === "mock") return new MockService();
  if (mode !== "supabase")
    throw new Error(`지원하지 않는 백엔드 모드: ${mode}`);
  return new SupabaseService(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY,
    import.meta.env.VITE_CREW_API_URL,
  );
}
