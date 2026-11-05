# Product Configurator Module — Agent Guidelines

Rule-based configuration models for catalog products, priced through catalog and written as configured lines on sales quotes. Spec: `.ai/specs/2026-10-23-product-configurator-module.md`.

## Layout

- `data/` — definition DSL types, zod validators, entities
- `lib/evaluator/` — pure engine (no I/O); `lib/*` — validation, hashing, expressions, money, pricing, finalise, quote access
- `commands/`, `api/`, `backend/product_configurator/`, `components/`, `widgets/injection/`, `i18n/`, `migrations/`
- `__integration__/` — Playwright specs; `meta.ts` gates them on `OM_ENABLE_PRODUCT_CONFIGURATOR`

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
