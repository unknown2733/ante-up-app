import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), {
      name: 'ante-up-generated-client-environment',
      enforce: 'pre',
      transform(code, id) {
        // Vite's dev replacement misses Codama's bracket access in the linked client.
        if (!id.replaceAll('\\', '/').includes('/clients/chain/dist/generated/')) return;
        return code.replace(/process\.env\[(?:"NODE_ENV"|'NODE_ENV')\]/g,
          JSON.stringify(command === 'build' ? 'production' : 'development'));
      },
    }],
    resolve: { alias: {
      '@solana/kit': fileURLToPath(new URL('./node_modules/@solana/kit/dist/index.browser.mjs', import.meta.url)),
      '@solana/program-client-core': fileURLToPath(new URL('./node_modules/@solana/program-client-core/dist/index.browser.mjs', import.meta.url)),
    } },
    server: {
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8787',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
