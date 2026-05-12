import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_BACKEND_URL ?? "http://localhost:8787";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // /api/* is proxied to the local backend so the frontend can stay on
      // relative paths in production without worrying about CORS.
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  };
});
