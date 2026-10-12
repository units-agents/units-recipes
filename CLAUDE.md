# units-recipes

The public recipes of units: what each unit improves and how it is measured. How it is laid out and checked: `README.md`.

## Rules
- `recipes/` is written by `bun scripts/public/export-recipes.ts` in the units monorepo; never edit it by hand. `bun scripts/validate.ts` fails on a file that differs from `recipes/SOURCE.json`.
- Canaries, patch definitions, example candidates and fixture recipes are held back on purpose. Never add them here.
- No em dashes anywhere. Plain language. Never invent a number: figures come from the files here or are left out.
- No secrets, keys, keyed RPC addresses or personal data. This repository is meant to be public.
- No git remote and no push until the owner says so. No LICENSE file until the owner picks one.
- Commit your own work before going idle.

## Who is working on what
| Who | Paths | Status | Started |
|---|---|---|---|
| public repos prep lane | everything (first version) | DONE (2026-10-12: 23 recipes exported, validate passes; local only, not pushed) | 2026-10-12 |
