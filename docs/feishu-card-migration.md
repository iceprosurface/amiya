# Feishu Card JSON v2 Migration Plan

This document defines the migration plan to convert all bot outputs from post/markdown messages to Feishu Card JSON v2 interactive cards, with streaming updates where applicable.

## Goals

- Make all bot replies render as Card JSON v2 interactive cards.
- Support streaming updates for long-running responses (typewriter effect).
- Preserve a consistent UX across replies, errors, tool outputs, and prompts.
- Provide a safe, phased rollout with fallbacks and observability.

## Key Constraints and Platform Rules

- Permission required: `cardkit:card:write`.
- Streaming mode limitations:
  - Cards in streaming mode cannot be forwarded.
  - Interactive callbacks cannot update the card while streaming is enabled.
  - Streaming mode auto-closes 10 minutes after last activation; manual disable is recommended.
- QPS limits:
  - Normal mode: single card update limit is 10 updates/sec.
  - Streaming mode: no QPS limit for card/component APIs.
- Client versions:
  - Feishu 7.20–7.22 support default streaming params only.
  - Feishu 7.23+ supports custom streaming params.

## Migration Strategy

### Phase 0: Inventory and Output Taxonomy

- Enumerate all current output paths:
  - Normal replies, long-form answers, errors, tool logs, progress/status, prompts.
- Consolidate into canonical output types:
  - `final_answer`, `streaming_answer`, `error`, `tool_result`, `choice_prompt`, `status`.
- Map each output path to a single target card template.

### Phase 1: Template System Design

- Define a small set of card templates that cover all output types.
- Provide two variants where needed:
  - Streaming template: non-interactive, progressive content only.
  - Final template: interactive elements enabled.
- Ensure templates work on Feishu 7.20–7.22 (defaults only).
- Decide how to render long content:
  - Summaries + details sections.
  - Truncation rules and links/attachments for large logs.

### Phase 2: Streaming Strategy

- During streaming:
  - Update text blocks only.
  - Do not add or modify interactive elements.
- Finalization:
  - Replace streaming card content with final interactive card content.
- 10-minute watchdog:
  - Finalize at 8–9 minutes and provide a continuation action.
- Update cadence:
  - Coalesce incremental updates.
  - Backoff on rate limits and only apply latest state.

### Phase 3: API Touchpoints and Permissions

- Confirm required scopes, especially `cardkit:card:write`.
- Identify the APIs used for:
  - Send initial interactive card message.
  - Update card content during streaming.
  - Finalize card to non-streaming state.
  - Handle interactive callbacks (buttons/selects).

### Phase 4: Migration Execution Order

1. Simple replies → final cards (no streaming yet).
2. Errors/status → structured cards.
3. Long answers → streaming cards with final interactive update.
4. Tool outputs → tool_result cards with structured sections.
5. Prompts/choices → interactive cards.

### Phase 5: Rollout and Observability

- Add a feature flag for cards by chat/tenant/percentage.
- Use `useCardMessages: false` in Feishu config to rollback to rich text.
- Track metrics:
  - Send/update success rate, rate-limit frequency, finalize success, watchdog triggers.
- Keep a rollback switch to old rendering until stability is proven.

## Risks and Mitigations

- Streaming cards are not forwardable.
  - Mitigation: consider a separate final non-streaming card message.
- No interactive updates during streaming.
  - Mitigation: enable interactions only in the final card.
- Auto-close after 10 minutes.
  - Mitigation: finalize early with a continuation action.
- Client version variability.
  - Mitigation: design to default params; treat custom params as optional.

## Decision Points

- Update-in-place vs two-message strategy for forwardability.
- How to render long tool logs (inline vs attachment/link).
- Which output types should stream vs send final directly.

## Implementation TODO List

1. Output inventory
   - [ ] List all output paths and map to canonical types.
   - [ ] Confirm coverage for replies, errors, tool outputs, and prompts.

2. Template specs
   - [ ] Draft Card JSON v2 templates for each output type.
   - [ ] Define streaming and final variants where needed.
   - [ ] Specify code/log rendering rules.

3. Streaming policy
   - [ ] Define update cadence and coalescing rules.
   - [ ] Add 10-minute watchdog and finalize behavior.
   - [ ] Decide update-in-place vs two-message approach.

4. Platform setup
   - [ ] Confirm `cardkit:card:write` permission.
   - [ ] Confirm send/update/finalize API endpoints.
   - [ ] Set up interactive callback subscriptions.

5. Migration rollout
   - [ ] Convert simple replies to final cards.
   - [ ] Convert errors/status to cards.
   - [ ] Add streaming for long answers.
   - [ ] Convert tool outputs to structured cards.
   - [ ] Convert prompts to interactive cards.

6. Observability and safety
   - [ ] Add logging/metrics for updates and failures.
   - [ ] Add feature flag and rollback switch.
   - [ ] Run internal dogfood and staged rollout.
