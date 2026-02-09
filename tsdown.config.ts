import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/hooks/handler.ts', 'src/analysis/worker.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  outputOptions: {
    entryFileNames: '[name].js',
  },
});
