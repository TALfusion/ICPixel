# ICPixel — Stable Memory Migration Rules

Rules for safe canister upgrades. Follow strictly to avoid data loss.

## Storable / stable-memory migration rules

All persistent canister state (`GameState`, `Alliance`, `Billing`, `Pixel`,
`TokenMetadata`, …) is stored via `ic_stable_structures` with `Storable`
impls that use `candid::encode_one` / `decode_one`. These survive canister
upgrades, so **schema changes must be candid-backwards-compatible** — or
the canister will trap on the first post-upgrade read and data is effectively
lost (only `--mode reinstall` recovers, which wipes everything).

### The rules

1. **New fields must be `Option<T>`.** Plain `T` breaks decode of old bytes
   that don't have the field — candid's schema evolution only tolerates
   missing fields when the target field is `opt`. `#[serde(default)]` does
   **not** help here — candid ignores serde attributes.

2. **Never remove or rename an existing field.** Candid matches fields by
   name. Renaming = removing + adding, which breaks old bytes. If you must
   drop a field, leave it in the struct with a `// deprecated` comment and
   stop reading it.

3. **Never change an existing field's type.** `u32` → `u64`, `String` →
   `Option<String>`, etc. all break decode. If you need a wider type, add a
   **new** `Option<T>` field with the new type and migrate in code.

4. **Fixed-layout Storables** (manual `to_bytes`/`from_bytes`, e.g.
   `PixelKey`, `PixelChange`) **cannot evolve at all**. Their BOUND is
   fixed. If you need more bytes, create a new key type in a new MemoryId.

5. **Always test upgrades locally before committing schema changes.** Run
   `./scripts/test-upgrade.sh`. It places a pixel, creates an alliance,
   upgrades the backend (not reinstalls), and asserts state survived. If
   the script fails, the migration is broken — fix it before pushing.

6. **Before mainnet:** consider moving to versioned enums
   (`enum StoredAlliance { V1(AllianceV1), V2(AllianceV2) }`) so explicit
   migration becomes possible. Pre-mainnet we skip this complexity.

### Landmines already present (pre-mainnet only)

These fields were added as non-Option and would break upgrade on mainnet.
They're fine right now because local state was reinstalled after they were
added. **Do not touch them** — they're stable as of the current schema:

- `GameState.paused: bool`
- `Alliance.nft_mint_in_progress: bool`
- `Billing.pixel_price_usd_cents: u16`
- `Billing.pixel_cooldown_seconds: u32`

If more come up, list them here.

## Deploy workflow

- `dfx deploy backend` — safe upgrade, preserves stable memory.
- `dfx deploy --mode reinstall backend` — **destructive**, wipes state.
  Only use when explicitly debugging or when a schema change broke things
  and you accept the data loss.
- After wiring changes (e.g. new nft canister id), run
  `./scripts/deploy.sh` which re-applies `set_nft_canister` etc.

## Tone

- Discuss design before coding (see auto-memory).
- Deploy automatically after every code change (see auto-memory).
