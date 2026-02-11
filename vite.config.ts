import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

let gitHash = 'dev';
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // git not available (e.g., in Docker build) — use BUILD_VERSION env or fallback
  gitHash = process.env.BUILD_VERSION || 'dev';
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3060,
    host: '0.0.0.0',
  },
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    '__APP_VERSION__': JSON.stringify(gitHash),
  },
});
