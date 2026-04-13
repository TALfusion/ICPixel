# Architecture

## Overview

ICPixel runs entirely on the Internet Computer. No external servers, databases, or cloud services.

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Frontend    │     │   Backend   │     │     NFT     │
│  (Asset)     │────>│   (Rust)    │────>│   (Rust)    │
│              │     │             │     │   ICRC-7    │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    │  ICP Ledger │
                    │   (ICRC-2)  │
                    └─────────────┘
```

## Canisters

| Canister | Language | Purpose                                              |
| -------- | -------- | ---------------------------------------------------- |
| Backend  | Rust     | Game logic, map storage, alliances, billing, rewards |
| Frontend | Asset    | React SPA served from IC                             |
| NFT      | Rust     | ICRC-7 token canister for mission NFTs               |

## Backend Storage

### Flat Pixel Array

Pixel colors are stored in a flat stable memory region — not a BTreeMap. For a 500x500 map, this is 1MB of raw bytes. Each pixel is 4 bytes (RGBA color as u32).

This is \~200x cheaper in cycles than BTreeMap operations.

### Stable Structures

All persistent state uses `ic_stable_structures`:

| Data            | Structure          | Memory ID |
| --------------- | ------------------ | --------- |
| Pixel colors    | Flat memory region | 20        |
| Pixel owners    | StableBTreeMap     | 0         |
| Change log      | StableBTreeMap     | 1         |
| Game state      | StableCell         | 2         |
| Alliances       | StableBTreeMap     | 3         |
| Billing config  | StableCell         | 5         |
| Alliance rounds | StableBTreeMap     | 6         |
| Pixel credits   | StableBTreeMap     | 7         |
| User stats      | StableBTreeMap     | 10        |

### In-Memory Caches

Some hot data is cached in thread-local memory for performance:

* **Cooldown cache** — Last pixel timestamp per principal (lost on upgrade = 10s reset, acceptable)
* **Daily pixel counter** — Flushes to stable on day change
* **Completed missions cache** — For reward distribution O(K) instead of O(N)
* **OG PNG cache** — Regenerated on map growth

## Frontend

* **React** with TypeScript
* **Canvas API** for map rendering
* **Vite** for bundling
* Real-time updates via **changelog polling** (every 2 seconds)
* Tile-based map loading (256x256 chunks)

## Upgrade Safety

All schema changes follow strict rules:

1. New fields must be `Option<T>` (candid evolution)
2. Never remove or rename existing fields
3. Never change an existing field's type
4. Test upgrades locally before deploying

See [MIGRATION.md](/broken/pages/iEIqXytnZP9Uf9GJeu5F) for full rules.

## Cycle Optimizations

| Optimization                                 | Savings                    |
| -------------------------------------------- | -------------------------- |
| Flat pixel array instead of BTreeMap         | \~200x on pixel read/write |
| Batched GameState updates (every 100 pixels) | \~2M cycles/pixel          |
| In-memory cooldown cache                     | \~2M cycles/pixel          |
| In-memory daily stats                        | \~2M cycles/pixel          |
| Binary search on cell creditors              | O(log N) vs O(N)           |
| XRC refresh every 12h instead of 6h          | 50% fewer outcalls         |
| OG PNG cached in memory                      | \~100M cycles/request      |

## Security

* **Auto-pause** at critical cycle levels (< 10B)
* **Rate limiting** — burst protection (20 calls/60s per principal)
* **Admin pause** — `admin_set_paused` for maintenance
* **Internet Identity** required for all mutations
* **ICRC-2 approve/transfer\_from** for payments (no raw ICP transfers)
