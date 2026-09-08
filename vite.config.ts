import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Vite is the dev server + bundler. It serves ES modules directly to the
// browser in dev (no bundling), which is why HMR is instant. In `build` it
// switches to Rollup and produces optimized bundles.
export default defineConfig({
  plugins: [
    // The PWA plugin generates a service worker + web manifest so the app can
    // be "installed" and work offline. Registration is automatic.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Chess Trainer',
        short_name: 'Chess',
        description: 'Analyze and train chess skills',
        theme_color: '#1e1e1e',
        background_color: '#1e1e1e',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
      workbox: {
        // Engine WASM is ~7MB; keep it out of the precache so first paint stays light.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        globIgnores: ['**/engine/**'],
        // Skip SW minification; terser has been flaky on low-memory hosts.
        mode: 'development',
        runtimeCaching: [
          {
            urlPattern: /\/engine\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'stockfish-engine',
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // --host in `npm run dev` makes the server listen on 0.0.0.0 so you can
    // open it from another device on the LAN (or in the Termux browser).
    port: 5173,
  },
});
