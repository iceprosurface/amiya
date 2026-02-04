import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: false,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'es6',
    external: ['@larksuiteoapi/node-sdk', 'better-sqlite3']
})
