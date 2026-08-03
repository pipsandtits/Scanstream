

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from 'rollup-plugin-visualizer';
import compression from 'vite-plugin-compression';
import fs from 'fs';
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
    }),
    visualizer({
      filename: path.resolve(__dirname, 'client', 'dist', 'stats.json'),
      open: false,
      gzipSize: true,
      brotliSize: true,
      json: true,
    }),
    compression(),
    // Logger plugin: after build, check whether visualizer wrote the stats file and log path
    {
      name: 'visualizer-writer-logger',
      closeBundle() {
        try {
          const out = path.resolve(__dirname, 'client', 'dist', 'stats.html');
          if (fs.existsSync(out)) {
            // eslint-disable-next-line no-console
            console.log(`[visualizer] stats generated: ${out}`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[visualizer] stats not found at ${out}`);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[visualizer] error checking stats file', err);
        }
      }
    }
    ,
    // Write a rollup-compatible stats JSON so we can analyze module sizes reliably
    {
      name: 'write-rollup-stats',
      writeBundle(options: any, bundle: Record<string, any>) {
        try {
          const modules = [];
          for (const fileName of Object.keys(bundle)) {
            const chunk = bundle[fileName];
            if (chunk && chunk.type === 'chunk') {
              const modEntries = chunk.modules || {};
              for (const id of Object.keys(modEntries)) {
                const info = modEntries[id];
                modules.push({ id, file: fileName, size: info.renderedLength || info.originalLength || 0 });
              }
            }
          }
          const out = path.resolve(__dirname, 'client', 'dist', 'stats-rollup.json');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify({ generated: Date.now(), modules }, null, 2));
          // eslint-disable-next-line no-console
          console.log('[stats] wrote rollup stats to', out);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[stats] error writing rollup stats', (err as any)?.stack ?? err);
        }
      }
    }
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@assets": path.resolve(__dirname, "assets"),
    },
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "client", "dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id: string | undefined): string | undefined {
          if (!id || !id.includes('node_modules')) return undefined;
          // Group react/react-dom into vendor chunk
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'vendor-react';
          // Query / state libs
          if (id.includes('@tanstack/react-query')) return 'query';
          // Charting libraries - split into subchunks for better caching
          if (id.match(/node_modules\/(recharts|victory|chart\.js|chartjs|chartjs-2)/)) return 'charts-recharts';
          if (id.match(/node_modules\/(apexcharts|react-apexcharts)/)) return 'charts-apexcharts';
          if (id.match(/node_modules\/(echarts|zrender)/)) return 'charts-echarts';
          if (id.match(/node_modules\/(d3|d3-array|d3-scale|d3-shape)/)) return 'charts-d3';
          if (id.match(/node_modules\/@visx\//)) return 'charts-visx';
          // UI primitives
          if (id.match(/node_modules\/(?:@radix-ui|@headlessui)/)) return 'ui-primitives';
          // Analytics / ML libs
          if (id.match(/node_modules\/(?:@tensorflow|onnxruntime-web|tfjs|prom-client)/)) return 'analytics';
          // Fallback vendor chunk
          return 'vendor';
        }
      }
    }
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'recharts', 'echarts', 'd3', 'chart.js', 'apexcharts', 'react-apexcharts', '@tanstack/react-query'],
  },
  server: {
    fs: {
      strict: false,
      allow: ['..'],
    },
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 5173
    },
    middlewareMode: false,
    allowedHosts: true,
    // Proxy to backend services. Disabled by default so frontend can run standalone.
    // Enable by setting environment variable `ENABLE_BACKEND_PROXY=true` when needed.
    proxy: (process.env.ENABLE_BACKEND_PROXY === 'true') ? {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      '/events': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      '/ws': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      '/socket': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        ws: true
      },
      '/api/scanner': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        rewrite: (p: string) => p,
      },
      '/api/position': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        rewrite: (p: string) => p,
      }
    } : undefined,
    watch: {
      usePolling: false,
      ignored: ['**/node_modules/**', '**/.git/**']
    }
  },
});
