import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'es6',
    external: ['@opencode-ai/plugin', '@larksuiteoapi/node-sdk', 'better-sqlite3']
})
