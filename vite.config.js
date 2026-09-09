import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Bumped from default 500kB — Firebase + the larger admin pages legitimately
    // push past it; the warning was just noise. Real splitting is via
    // route-level lazy() in App.jsx, which automatically code-splits each route
    // into its own chunk.
    chunkSizeWarningLimit: 900,
  },
  // Components rely on the automatic JSX runtime (no `import React`).
  // The react plugin applies that for the app build, but vitest transforms
  // through esbuild, which defaults to the CLASSIC runtime — so every
  // component rendered in a test died with "React is not defined". Stating
  // it here makes both pipelines agree.
  esbuild: { jsx: 'automatic' },
  test: {
    // Rules tests need the Firestore emulator running, so they're kept out
    // of the default suite — `npm test` must stay fast and dependency-free.
    // Run them with `npm run test:rules`, which boots the emulator first.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/rules/**'],
  },
})
