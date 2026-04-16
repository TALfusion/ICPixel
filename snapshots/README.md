# ICPixel mainnet snapshots

This directory holds gzip-compressed JSON dumps of the backend canister
state, one file per day (`YYYY-MM-DD.json.gz`). Snapshots are produced
automatically by `.github/workflows/snapshot.yml` on a daily cron.

## What's inside each file

Ungzip and `jq .` one of them. The top-level shape is:

```jsonc
{
  "schema_version": 1,
  "exported_at_ms": 1713220000000,
  "network": "ic",
  "canister_id": "s743i-5qaaa-aaaai-axh3a-cai",
  "counts":       { /* sizes of every collection */ },
  "singletons":   { "game_state": {...}, "billing": {...}, ... },
  "pixel_colors_base64": "...",   // 1 MB raw flat region (LE u32 per pixel)
  "collections": {
    "pixels":              [...],
    "alliances":           [...],
    "user_alliance":       [...],
    "changes":             [...],
    "last_placed":         [...],
    "pixel_credits":       [...],
    "alliance_rounds":     [...],
    "mission_tile_index":  [...],
    "user_stats":          [...],
    "claimable_treasury":  [...],
    "pending_orders":      [...]
  }
}
```

All `BigInt`s are JSON-encoded as decimal strings; principals as text.

## One-time setup (required before the workflow can run)

1. **Generate a dedicated read-only identity**

   ```bash
   dfx identity new snapshot-reader --storage-mode=plaintext
   dfx identity use snapshot-reader
   dfx identity get-principal
   # save the principal — you'll wire it into the canister next
   ```

2. **Authorize it on mainnet** (from a controller identity):

   ```bash
   dfx identity use <your-controller>
   dfx canister --network ic call backend admin_set_snapshot_reader \
     "(opt principal \"<snapshot-reader-principal-from-step-1>\")"
   ```

3. **Store the identity PEM as a GitHub secret**

   ```bash
   cat ~/.config/dfx/identity/snapshot-reader/identity.pem
   ```

   → GitHub → Settings → Secrets and variables → Actions → New secret
   → name: `ICPIXEL_SNAPSHOT_PEM`, value: paste the PEM.

4. **Done.** The workflow runs daily at 03:17 UTC. You can also trigger
   it manually from the Actions tab ("Run workflow").

## Rotating / revoking the reader key

Any controller can rotate at any time:

```bash
dfx canister --network ic call backend admin_set_snapshot_reader "(null)"
```

Then re-run step 1-3 with a fresh identity.

## Manual run (local machine)

```bash
cd scripts && npm install
ICPIXEL_SNAPSHOT_PEM="$(cat ~/.config/dfx/identity/snapshot-reader/identity.pem)" \
  node scripts/export-snapshot.mjs
```
