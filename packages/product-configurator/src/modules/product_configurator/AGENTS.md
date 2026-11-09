# Product Configurator Module — Agent Guidelines

Rule-based configuration models for catalog products, priced through catalog and written as configured lines on sales quotes. Spec: `.ai/specs/2026-10-23-product-configurator-module.md`.

## Layout

- `data/` — definition DSL types, zod validators, entities
- `lib/evaluator/` — pure engine (no I/O); `lib/*` — validation, hashing, expressions, money, pricing, finalise, quote access
- `commands/`, `api/`, `backend/product_configurator/`, `components/`, `widgets/injection/`, `i18n/`, `migrations/`
- `__integration__/` — Playwright specs; `meta.ts` gates them on `OM_ENABLE_PRODUCT_CONFIGURATOR`

## Sessions, pricing and evaluation

- `ConfigurationSession`: `status` `open | finalising | finalised | cancelled`, `selections` = user intent only (nulls dropped), `evaluation` = last stored `ConfigurationResult`, `revision` bumped by a stored evaluate whose intent differs from the stored one (re-evaluating the stored choices, as opening a session does, keeps it). `ConfigurationSnapshot` is written only by finalise and is immutable once `quoteLineId` is set.
- Copies ("Add another identical", "Configure again"): open with `fromSnapshotId` (mode `duplicate`, the default with a snapshot; any other mode or combination is 400 `mode_not_supported`). The snapshot must be in the quote and selected organization (422 `snapshot_not_in_quote`); the session opens on the latest version of the snapshot's model with `source_snapshot_id` set. `lib/selectionMigration.ts` maps the snapshot `intent` onto that version through the evaluator's own `normaliseSelections`: removed features are `dropped`; refused values, and every value of a feature whose type changed, are `reset`; `migration` is stored only when something was dropped or reset, and finalise then needs `migrationAcknowledged`. A copy is an ordinary new line. Migration items carry `oldUnit` for a copied number whose old feature had a unit. The quote tab offers copies only with `sales.quotes.manage` (the "Add to quote" rule).
- `lib/evaluation.ts` `evaluateConfiguration({ definition, modelVersion, selections, pricing })` is the one entry point for evaluate, preview and the finalise re-evaluation. It throws `ConfiguratorEvaluationError` (`invalid_selection`, `fixed_point_not_reached`, `forced_value_invalid`, `expression_error`, `price_missing`); blocking rule and system errors (`option_not_available`, `bom_sku_unmapped`, ...) stay in `errors` with `finalisable: false`. `commands/sessions.ts` `evaluationFailed()` maps the thrown errors to 422.
- `lib/pricing.ts` `resolveUnitPrices(input, skuQuantities)` returns unit prices, catalog labels and the `PriceContextRecord` to store in the snapshot `price_context`. Customer groups come from `resolveCustomerGroupIds()` (`customerGroupsService` through `tryResolve`, `[]` when not registered). Pass `{ channelId, customerId, at }`: the quote's for sessions, the chosen context for preview.
- `lib/quoteAccess.ts`: `readQuoteHeader()` (queryEngine, selected organization, `null` when converted or deleted), `assertFeatures(ctx, SESSION_FEATURES, scope)` for the in-command RBAC re-check, `readUserDisplayNames()`. Quote and order line reads (reconcile, guard) belong here and page through all lines with `pageSize` 100.
- `commands/shared.ts`: `resolveSessionScope`, `findSession`, `sessionNotFound`, `quoteNotFound`, `SESSION_RESOURCE_KIND`. Session writes re-check `status` and `revision` on a `PESSIMISTIC_WRITE` row inside a transaction; `session_changed` carries the current `session` state.
- Routes: `resolveRouteContext`, then `runRouteMutationGuards`, then the command bus. `readLimitedJsonObject()` enforces the 64 KB evaluate limit (413 `payload_too_large`).

## Finalise, line guard and snapshots

- `lib/finalise.ts` holds the finalise algorithm (`finaliseSession`) and the conversion cleanup (`reconcileConvertedQuote`) over injected ports (`FinaliseDeps`: lock, store, sales, prepare, observer), so every crash and concurrency case is a unit test with fakes. Keep the order: lock, claim (`open|finalising -> finalising`), adopt a committed line (quote lines, or order lines when the quote is gone) before anything is re-evaluated, then revision, `prepare`, hash, snapshot, line, link. A committed line is always adopted; when its snapshot hash differs from `expectedHash` the 200 answer carries `outcome: 'added_with_earlier_choices'` (session finalised, audited). Failures before the line write reopen the session; a failed line write is first reconciled against the committed lines (the sales command can fail after its commit), and stays `finalising` when they cannot be read (502 with `status: 'finalising'`); `quote_converted` cancels it; a lost lock connection leaves it `finalising`. The conversion cleanup pages through all sessions (`RECONCILE_BATCH_SIZE`).
- `lib/finaliseStore.ts`: `createQuoteLock(em)` holds `pg_try_advisory_lock(hashtextextended('product_configurator:quote:<id>', 0))` on a connection of one lazily created lock pool per ORM configuration (`createKyselyDialect` with our own `onPoolCreated`, outside the app pool, at most `QUOTE_LOCK_CONNECTIONS`, waits `QUOTE_LOCK_WAIT_MS` and then reports busy), unlocks in `finally` and destroys a connection whose unlock failed; cleanup failures are reported, never thrown over the result. It needs a direct database connection, never a transaction-mode pooler. Session changes are compare-and-set on a `PESSIMISTIC_WRITE` row. Real-PostgreSQL behaviour: `lib/__tests__/finaliseStore.integration.test.ts` (skipped without `DATABASE_URL`).
- `commands/finalise.ts` builds the real ports. `writeLine` dispatches `sales.quotes.lines.upsert` with `ctx` kept and only `request` replaced by one marked with `markTrustedFinaliseRequest()` that carries the quote `updatedAt` as `OPTIMISTIC_LOCK_HEADER_NAME`. Never mark any other request trusted.
- `commands/interceptors.ts`: the configured line guard (tenant from auth or organization scope only; without one the named lines are read by id in their own tenant with `readStoredLinesInAnyTenant`, and a body naming no tenant is 403 `configured_line_unverified`; amounts compare as exact decimals with `sameDecimal`) on `sales.quotes.lines.upsert`, `sales.orders.lines.upsert`, `sales.orders.lines.upsert_many`, `sales.quotes.create`, `sales.orders.create` (priority 1000, no `features`), and the `sales.quotes.convert_to_order` `afterExecute` cleanup. Decisions live in `lib/lineGuard.ts`; stored lines are read fresh by id in the tenant (`readStoredLines`). The cleanup skips while the quote is still readable (conversion inside an uncommitted caller transaction) and never throws into the conversion.
- Snapshot `selections` is `{ intent, settled, visibility }`; `lib/snapshots.ts` builds the `GET /snapshots` read model from it and the version definition. The route metadata needs only `snapshots.view`; the handler adds `sales.quotes.view` (`quoteId`, `id`) or `sales.orders.view` (`orderId`, `id` + `orderId`, where the order must carry the snapshot). With `ids` and `id` + `orderId`, carriers are read by id (`readDocumentLinesByIds`, a snapshot's `quote_line_id`; order lines keep the quote line ids), never a full document scan per batch; only unlinked snapshots fall back to `readDocumentLines`.
- `commands/lines.ts` (`product_configurator.lines.update`, `POST /lines/update`) edits name, comment, discount and tax of a configured quote line by dispatching `sales.quotes.lines.upsert` on the caller's own request (lock header passes through, never trusted) with the stored configured inputs re-sent unchanged, so the guard allows it. Discount modes clear the other field; a tax change sends `taxRate` and the unit gross derived from the unchanged net. `prepare` and `captureAfter` read the line's name, comment, discounts and tax rate (`readQuoteLineDetails`) for the audit `snapshotBefore`/`snapshotAfter` in one shape, so the command bus infers only real changes; invalid input is 400 `invalid_request` from the command too.
- Coupling with sales UI (no sales change, Q5): the quote totals refresh through sales `emitSalesDocumentTotalsRefresh`; the order items column reads rows through sales `useOrderItemsInjectionContext` (the declared `orderItemColumns` host, a known coupling like WMS); the configured-lines notice opens the Configurations tab by clicking the sales tab button found by `data-tab-id` (no `?tab=` param) and falls back to plain text when that button is not on the page. The sales page keeps these widgets mounted across organization changes, so they reload on `useOrganizationScopeVersion()` (the order cache is keyed by it). If sales changes any of these, update the widgets and their integration specs.

## Always

1. **MUST keep `lib/evaluator/` pure** — no DB, DI or clock access; money as scaled BigInt with the currency exponent
2. **MUST scope every query by `tenantId` and `organizationId`** in the `where`, and read through `findWithDecryption` / `findOneWithDecryption`
3. **MUST read prices through the `catalogPriceRowService` and `catalogPricingService` DI services** — never reimplement catalog pricing
4. **MUST write sales lines through sales commands** — no direct ORM writes or relations to sales or catalog entities
5. **MUST keep `__integration__/meta.ts` values as inline string literals** — discovery parses the file with a regex

## Ask First

- Ask before changing the definition DSL shape, the hash contract, route paths, event ids, ACL feature ids or widget spot ids once released.

## Never

- Never let a configured line change its net price, quantity, unit or product outside the configurator.
- Never depend on `seedExamples` data in integration tests.

## Validation Commands

```bash
yarn generate
yarn workspace @open-mercato/product-configurator test
yarn agents:check-budget
```
