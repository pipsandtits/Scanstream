import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['server/index.ts'],
  format: ['esm'],
  target: 'es2022',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    'vite',
    '@vitejs/plugin-react',
    'lightningcss',
    'chartjs-node-canvas',
    '@babel/preset-typescript'
  ]
})
