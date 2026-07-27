# Quickstart

A tiered path into ruse. Each tier is self-contained and runnable, and they build on one another:

| Tier | Page | You'll learn |
|------|------|--------------|
| **1** | [Worlds & queries](./worlds-and-queries) | Author a world, load it, query it, change it by hand |
| **1.5** | [Provenance](./provenance) | Ask *why* any fact is true |
| **2** | [Actions](./actions) | Author choices, score them by utility, run the best one |
| **2.5** | [Action records](./action-records) | Read back what happened and what caused it |

Tier 1 is meant to be effortless. Tier 2 (actions) is a small step up.

Everything here goes through the **`Engine`** — ruse's single entry point. You create one, then call `query`, `assert`, `selectAction`, `execute`, `why`, and so on. You rarely need anything else.

## The scenario

Every page on this path uses the same small world, which lives in [`data/quickstart/`](https://github.com/mtreanor/ruse). Three agents — `alice`, `bob`, `carol` — with:

- **`knows`** — a *directional* acquaintance relation (alice knows bob, but not carol)
- **`trusts`** — boolean, supporting explicit disbelief (`-trusts`)
- **`friendship`** — a numeric relation (0–100) with `cold` / `neutral` / `warm` tiers
- **`hasNeed`** — who currently needs help
- **`helped`**, **`rested`** — outcomes actions produce

It's deliberately tiny — small enough to hold in your head, rich enough to show queries, numeric tiers, negation, and utility-scored actions.

Start with [Worlds & queries →](./worlds-and-queries)
