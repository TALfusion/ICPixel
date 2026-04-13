import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../../", "");
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_BACKEND_CANISTER_ID": JSON.stringify(
        env.CANISTER_ID_BACKEND ?? ""
      ),
      "import.meta.env.VITE_II_CANISTER_ID": JSON.stringify(
        env.CANISTER_ID_INTERNET_IDENTITY ?? ""
      ),
      "import.meta.env.VITE_NFT_CANISTER_ID": JSON.stringify(
        env.CANISTER_ID_NFT ?? ""
      ),
      "import.meta.env.VITE_DFX_NETWORK": JSON.stringify(
        env.DFX_NETWORK ?? "local"
      ),
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:4943",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
