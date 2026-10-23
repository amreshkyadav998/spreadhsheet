import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `vite build --mode profile` (npm run build:profile) swaps in React's profiling
// build so <Profiler> and the React DevTools profiler report commits in an
// otherwise production bundle. See DESIGN_NOTES.md → Measurements.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: mode === 'profile'
    ? { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] }
    : {},
}))
