# ICPixel mainnet deploy checklist

This file is the **single source of truth** for getting from a working
local replica to a live mainnet canister without losing money or data.
Read top to bottom every time. Don't skip steps; the early ones are the
ones that bite hardest if you do.

## Why this exists

The IC has a few quirks that punish ad-hoc deploys:

- A single controller principal = single point of failure. Lose the
  seed, lose the canister.
- A schema regression on a Storable type traps on the first
  post-upgrade read. The only recovery is `--mode reinstall`, which
  wipes everything.
- Cycles run out silently. The canister freezes; query calls keep
  working for a while, then everything stops.
- Candid breaking changes break old frontends *that are still cached
  in users' browsers*.

Every step below addresses one of these.

---

## Pre-flight (do this once, before the very first mainnet deploy)

### 1. Wallets, identities, and the multi-sig story

The IC doesn't have native multi-sig for canister controllers. The
practical answers:

**Option A (recommended for solo dev): hardware wallet + cold backup.**
1. Create a fresh dfx identity backed by a hardware key:
   ```sh
   dfx identity new icpixel-prod --hsm
   ```
   (or import an existing seed phrase you control offline)
2. Print the recovery phrase, store on paper in two physical locations.
3. **Never** use this identity for anything other than canister admin.

**Option B (true multi-sig): NNS-controlled canister.**
1. Create an NNS neuron you control, then `dfx canister update-settings
   <id> --add-controller <neuron-controller-principal>`.
2. Removes you as a controller in favour of the NNS, so any future
   admin action requires an NNS proposal vote. Heavy, but bulletproof.
3. Practical for SNS/DAO launch, overkill for solo pre-launch.

**Option C (pragmatic middle ground): two human controllers.**
1. Generate two separate identities on two separate devices.
2. `dfx canister update-settings backend --add-controller <other>`
3. Either can deploy, but the attacker needs both keys to brick you.
4. Works for any 2-person team. Document who has which key.

For ICPixel pre-launch I recommend **Option A**: simplest, no
governance overhead, but the seed phrase MUST live offline.

### 2. Wire the wallet principal in `Billing`

The default `Billing::default_for_canister` sets
`wallet_principal = self`, which means the wallet share of every payment
piles up inside the canister and only `admin_payout_wallet` can move it.
On mainnet you want it to land in **your real wallet** (a separate
ICRC-1 account, ideally backed by the same hardware identity as the
controller).

```sh
dfx --network ic canister call backend set_alliance_billing '(record {
  alliance_price_e8s = 1_000_000_000 : nat64;   # 10 ICP at $0.50/ICP, tune
  pixel_price_usd_cents = 5 : nat16;
  pixel_cooldown_seconds = 10 : nat32;
  ledger = opt principal "ryjl3-tyaaa-aaaaa-aaaba-cai";   # ICP ledger
  wallet_principal = principal "<your-real-wallet-principal>";
  treasury_principal = principal "<the-canister-itself>";
  wallet_pct = 50 : nat8;
  treasury_pct = 50 : nat8;
})'
```

### 3. Wire the NFT canister principal

Backend needs to know the NFT canister id. Set it once, after both
canisters are deployed:
```sh
dfx --network ic canister call backend set_nft_canister '(principal "<nft-canister-id>")'
```

### 4. Cycle the canister to a healthy starting balance

```sh
dfx --network ic ledger top-up <backend-canister-id> --amount 5
dfx --network ic ledger top-up <nft-canister-id> --amount 2
```

5 ICP gets you ~5T cycles, well above the `LOW_CYCLES_THRESHOLD = 5T`
warning. Top-up frequency depends on traffic; monitor `get_health`.

---

## Every-deploy checklist

### Before you run `dfx deploy --network ic`

- [ ] Local replica fully working: `dfx start --clean && dfx deploy`
- [ ] All schema changes Option<T> per MIGRATION.md rules. Grep your diff
      for `pub .*: \(?[A-Z]` (non-Option new fields on existing structs).
- [ ] **Run `./scripts/test-upgrade.sh`** — must print
      `✓ upgrade preserved state`. If it fails, your migration is broken.
      Fix it. Do NOT proceed.
- [ ] **Run `./scripts/mainnet-snapshot.sh --network ic`** — captures
      the current live state to `snapshots/`. If the deploy goes wrong,
      this is your only diff target.
- [ ] Check git: working tree clean, current commit is what you intend
      to deploy. `git rev-parse HEAD` matches your release tag if any.
- [ ] `cargo check -p backend` clean. Treat warnings as todo, not show
      stoppers, but no `error:`.

### The deploy itself

```sh
# Pause first to freeze state and give yourself a clean snapshot diff.
dfx --network ic canister call backend admin_set_paused '(true)'

# Deploy. Use upgrade mode (the default). NEVER --mode reinstall on
# mainnet unless you have explicitly accepted data loss.
dfx --network ic deploy backend
# (the candid breaking-change warning will trigger; review the diff
#  and only proceed if it's a frontward-compatible change — adding
#  endpoints is fine, removing/renaming variants is not.)

# Sanity probe: post-upgrade calls must not trap.
dfx --network ic canister call backend get_game_state
dfx --network ic canister call backend get_health

# Unpause.
dfx --network ic canister call backend admin_set_paused '(false)'
```

### After every deploy

- [ ] `./scripts/mainnet-snapshot.sh --network ic` again — diff against
      the pre-deploy snapshot. Counters that should monotonically
      increase (`unique_pixels_set`, `total_pixels_placed`,
      `season`) should be `>=` the pre values; nothing else should
      have moved.
- [ ] Place a test pixel from a fresh principal, confirm it lands.
- [ ] Check `get_health`: `cycles >= LOW_CYCLES_THRESHOLD`,
      `low_cycles_warning = false`.
- [ ] Tail canister logs for the next ~5 minutes:
      `dfx --network ic canister logs backend`
      Look for "scheduled icp_price::refresh failed" or "low cycles" warnings.

---

## In case of fire

### The canister starts trapping

1. `dfx --network ic canister call backend admin_set_paused '(true)'` —
   stops new state writes that could compound the damage. Query
   endpoints stay alive.
2. `dfx --network ic canister logs backend` — find the trap message.
3. If it's a Storable decode failure, your last deploy broke a schema
   landmine. **Do not run `--mode reinstall`** unless you've already
   accepted data loss; the fix is to revert the canister wasm to the
   previous version.
4. Save the latest snapshot for forensics, even if incomplete.

### Cycles run out

The IC freezes the canister silently. Query calls keep working briefly
on cached responses, then everything stops. To unfreeze:

```sh
dfx --network ic ledger top-up <backend-canister-id> --amount 5
```

If you're worried about getting locked out, set up a periodic cron on
some external machine that polls `get_health` and pages you when
`low_cycles_warning = true`. The threshold is intentionally generous
(5T cycles ≈ a few weeks of headroom).

### A bad actor exploits something

1. Pause first, debug second. `admin_set_paused(true)` is the kill
   switch — verified end-to-end (see `scripts/MAINNET-DEPLOY.md`
   verification log).
2. The contributor bitmap rules out the most obvious sabotage path
   (overwrite-to-steal-credit), but the most plausible exploit is:
   farming bots cycling identities to dodge the 20/min rate limit. If
   that becomes the dominant attack pattern, lower the rate limit and
   raise the cooldown via `set_alliance_billing` — both are runtime-
   configurable.

### A controller key is compromised

If you're on Option A (single controller, hardware key): worst case,
the attacker pauses or upgrades the canister, deletes data, drains
balances. There's no recovery.

If you're on Option C (two controllers): rotate immediately —
```sh
dfx --network ic canister update-settings backend \
  --remove-controller <compromised-principal>
```
…from the *other* controller. Done.

This is exactly why Option C exists. Don't skip it once the project
has any meaningful TVL.
