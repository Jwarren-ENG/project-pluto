import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'pluto-ui-notices',
      apply: 'build',
      async generateBundle() {
        const source = await readFile(new URL('./docs/shadcn.md', import.meta.url), 'utf8')
        this.emitFile({ type: 'asset', fileName: 'UI-NOTICES.md', source })
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./ui', import.meta.url)) } },
  build: { target: 'chrome140', outDir: 'dist' },
})
