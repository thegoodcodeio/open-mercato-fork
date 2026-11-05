# Product Configurator Package — Agent Guidelines

Use `@open-mercato/product-configurator` for the opt-in product configurator (CPQ) module. Module rules: `src/modules/product_configurator/AGENTS.md`. Spec: `.ai/specs/2026-10-23-product-configurator-module.md`.

## Always

1. **MUST keep the module opt-in** — it is registered only when `OM_ENABLE_PRODUCT_CONFIGURATOR=true` (`apps/mercato/src/modules.ts` and `packages/create-app/template/src/modules.ts`)
2. **MUST declare peers in this `package.json`** — never append to `scripts/package-peer-deps-allowlist.json`
3. **MUST keep the wiring in sync** when the package shape changes: both `package.json` files, the three `Dockerfile` manifest `COPY` lines, `SYNC_INTERNAL_PACKAGE_KEYS` in `scripts/template-sync.ts`, both `.env.example` files

## Ask First

- Ask before moving the module into another package or changing the env flag name.
- Ask before adding a production dependency.

## Never

- Never import sales or catalog internals through ORM relations; use FK ids, DI services and commands.
- Never enable the module unconditionally in an app or template `modules.ts`.

## Validation Commands

```bash
yarn generate
yarn workspace @open-mercato/product-configurator test
yarn workspace @open-mercato/product-configurator build
yarn template:sync
```
