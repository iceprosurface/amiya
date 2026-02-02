# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript source. Entry is `src/index.ts`; session orchestration lives in `src/session/session-handler.ts`; database persistence is in `src/database.ts`.
- `src/providers/feishu/` contains the Feishu integration (client, provider, event server, config).
- `scripts/` holds local utilities (example: `scripts/repro-opencode-concurrency.ts`).
- `docs/` includes design notes and plans.
- `.amiya/` is runtime state and configuration (not committed). It stores `amiya.sqlite3`, `feishu.json`, and the agent prompt `source.md`.

## Build, Test, and Development Commands
- `pnpm start` runs the bot with live reload via `tsx` and watches `src/index.ts`.
- `pnpm dev` runs `tsup` in watch mode for builds.
- `pnpm build` produces `dist/` output.
- `pnpm typecheck` runs `tsc --noEmit` for type safety.
- `pnpm test` currently prints "no tests" (no automated suite yet).
- `pnpm repro:opencode-concurrency` runs the concurrency repro script.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM). Use 2-space indentation and trailing commas where already used.
- File naming is kebab-case in `src/` (e.g., `session-handler.ts`).
- Prefer descriptive function names and explicit typing at module boundaries.
- No lint/format tooling is configured; keep formatting consistent with existing files.

## Testing Guidelines
- There is no test framework configured yet.
- If adding tests, place them under `src/` or a new `tests/` directory and document the command in `package.json`.

## Commit & Pull Request Guidelines
- Commit message format: `type(scope): description`.
- Allowed `type`: `fix`, `feat`, `refactor`, `perf`, `docs`, `types`.
- Use a short lowercase `scope` that matches the touched area (e.g., `session`, `feishu`, `config`).
- Keep `description` concise and imperative.
- PRs should include: a short summary, test/verification steps, and any config changes or `.amiya` implications.

## Security & Configuration Tips
- Treat `.amiya/feishu.json` and `.amiya/source.md` as sensitive and local-only.
- Do not commit `.amiya/` contents; `.gitignore` already excludes it.
- If you need to change the default agent prompt, update `src/system-message.ts` and the local `.amiya/source.md`.
