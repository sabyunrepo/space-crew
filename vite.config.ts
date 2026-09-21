import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// 브라우저는 supabase 모드에서만 Supabase 주소로 Auth/Realtime 연결을 연다.
function supabasePreconnect(): Plugin {
  return {
    name: "supabase-preconnect",
    transformIndexHtml(html) {
      if (process.env.VITE_BACKEND_MODE !== "supabase") return html;
      const url = process.env.VITE_SUPABASE_URL;
      if (!url) return html;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        return html;
      }
      return html.replace(
        "</head>",
        `<link rel="preconnect" href="${origin}" crossorigin/></head>`,
      );
    },
  };
}
export default defineConfig({
  plugins: [react(), supabasePreconnect()],
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
