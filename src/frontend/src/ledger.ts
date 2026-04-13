//! Minimal ICP ledger client for the frontend.
//!
//! Only wraps the two calls the paid flow needs:
//!
//!   * `icrc1_balance_of` — show the player's current ICP balance
//!   * `icrc2_approve`    — allow backend to pull N e8s via transfer_from
//!
//! The real `icrc2_transfer_from` call is done by backend, not here —
//! the browser only authorizes, the canister moves the funds.
//!
//! Mainnet ICP ledger principal is the canonical `ryjl3-tyaaa-...`.
//! Locally we don't deploy an ICP ledger (see `scripts/deploy.sh`: local
//! dev forces `pixel_price_usd_cents = 0` which skips this whole path),
//! so the ledger actor is only instantiated when the user is actually
//! trying to pay on mainnet.

import { Actor, type HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import type { IDL as IDLType } from "@dfinity/candid";

export const MAINNET_ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";

export const ledgerIdlFactory = ({ IDL }: { IDL: typeof IDLType }) => {
  const Account = IDL.Record({
    owner: IDL.Principal,
    subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  });

  const ApproveArgs = IDL.Record({
    from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
    spender: Account,
    amount: IDL.Nat,
    expected_allowance: IDL.Opt(IDL.Nat),
    expires_at: IDL.Opt(IDL.Nat64),
    fee: IDL.Opt(IDL.Nat),
    memo: IDL.Opt(IDL.Vec(IDL.Nat8)),
    created_at_time: IDL.Opt(IDL.Nat64),
  });

  const ApproveError = IDL.Variant({
    GenericError: IDL.Record({ error_code: IDL.Nat, message: IDL.Text }),
    TemporarilyUnavailable: IDL.Null,
    Duplicate: IDL.Record({ duplicate_of: IDL.Nat }),
    BadFee: IDL.Record({ expected_fee: IDL.Nat }),
    AllowanceChanged: IDL.Record({ current_allowance: IDL.Nat }),
    CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
    TooOld: IDL.Null,
    Expired: IDL.Record({ ledger_time: IDL.Nat64 }),
    InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  });

  return IDL.Service({
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ["query"]),
    icrc2_approve: IDL.Func(
      [ApproveArgs],
      [IDL.Variant({ Ok: IDL.Nat, Err: ApproveError })],
      [],
    ),
  });
};

export interface LedgerActor {
  icrc1_balance_of: (account: {
    owner: Principal;
    subaccount: [] | [Uint8Array];
  }) => Promise<bigint>;
  icrc2_approve: (args: {
    from_subaccount: [] | [Uint8Array];
    spender: { owner: Principal; subaccount: [] | [Uint8Array] };
    amount: bigint;
    expected_allowance: [] | [bigint];
    expires_at: [] | [bigint];
    fee: [] | [bigint];
    memo: [] | [Uint8Array];
    created_at_time: [] | [bigint];
  }) => Promise<{ Ok: bigint } | { Err: unknown }>;
}

export function createLedgerActor(
  agent: HttpAgent,
  canisterId: string = MAINNET_ICP_LEDGER,
): LedgerActor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(ledgerIdlFactory as any, {
    agent,
    canisterId,
  }) as unknown as LedgerActor;
}

/// ICP ledger charges a flat 10_000 e8s fee for ICRC-1/2 calls. Baked in
/// as a constant because the mainnet value is frozen and we don't want
/// to do an `icrc1_fee` round-trip on every approve.
export const ICP_LEDGER_FEE_E8S = 10_000n;

/// Convenience: build an approve amount that comfortably covers
/// `count × pricePerPixelE8s` plus the ledger fee plus a 10% buffer
/// for rate drift between the moment the browser computed it and the
/// moment the backend re-computes it against its own cached rate.
export function buildApproveAmount(
  count: bigint,
  pricePerPixelE8s: bigint,
): bigint {
  const base = count * pricePerPixelE8s;
  const buffer = base / 10n; // 10%
  return base + buffer + ICP_LEDGER_FEE_E8S;
}
