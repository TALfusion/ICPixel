//! Shared types for the nft canister.
//!
//! `Token` is the on-chain representation. `Account` mirrors ICRC-1's
//! `(owner, opt subaccount)` so we can speak to ICRC-7 marketplaces without
//! a translation layer.
//!
//! **Migration rule (see [MIGRATION.md](../../../../MIGRATION.md)):** `Token` and
//! `TokenMetadata` are candid-encoded into stable memory. Minted NFTs live
//! forever (per spec — burned tokens still serve their image), so an
//! upgrade that can't decode an old token means every minted NFT is lost.
//! New fields must be `Option<T>`; never remove/rename/retype. Verify with
//! `./scripts/test-upgrade.sh`.

use candid::{CandidType, Principal};
use ic_stable_structures::storable::{Bound, Storable};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

pub type TokenId = u64;
pub type Subaccount = [u8; 32];

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
pub struct Account {
    pub owner: Principal,
    pub subaccount: Option<Subaccount>,
}

/// Metadata frozen at mint time. The image is reconstructed on demand from
/// `template + width + height` by the http_request handler — we do NOT store
/// a pre-rendered PNG, since clients can compute it cheaply and storing it
/// would multiply our stable-memory footprint per token.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TokenMetadata {
    pub name: String,
    pub description: String,
    pub alliance_id: u64,
    pub alliance_name: String,
    pub season: u32,
    pub global_nft_number: u64, // == token id, kept here for marketplaces
    pub pixel_count: u64,
    pub width: u16,
    pub height: u16,
    pub x: i16,
    pub y: i16,
    pub template: Vec<u32>, // row-major, length = width * height
    pub completed_at: u64,  // ns since epoch
    pub match_percent: u8,  // 0..=100, snapshot at mint
}

/// Stored token. `owner = None` means the token has been burned. We keep the
/// metadata around so historical queries (`icrc7_token_metadata`) still work
/// after burn — per spec.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Token {
    pub id: TokenId,
    pub owner: Option<Account>,
    pub minted_at: u64,
    pub metadata: TokenMetadata,
}

impl Storable for Token {
    fn to_bytes(&self) -> Cow<'_, [u8]> {
        Cow::Owned(candid::encode_one(self).expect("encode Token"))
    }
    fn from_bytes(bytes: Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode Token")
    }
    // Templates can be large; bound is unbounded.
    const BOUND: Bound = Bound::Unbounded;
}

/// Wire-format for the custom mint endpoint. Backend constructs this and
/// passes it via inter-canister call.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct MintArgs {
    pub to: Account,
    pub metadata: TokenMetadata,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum MintError {
    Unauthorized,
    InvalidMetadata(String),
    /// Unexpected stable-memory write failure. Transaction rolls back.
    /// Backend should retry the mint; if persistent, it's a bug.
    InternalError(String),
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum BurnError {
    NotFound,
    NotOwner,
    AlreadyBurned,
}

/// ICRC-7 transfer args (single-token form, batched at the call site).
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TransferArg {
    pub from_subaccount: Option<Subaccount>,
    pub to: Account,
    pub token_id: TokenId,
    pub memo: Option<Vec<u8>>,
    pub created_at_time: Option<u64>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TransferError {
    NonExistingTokenId,
    InvalidRecipient,
    Unauthorized,
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: u64 },
    GenericError { error_code: u64, message: String },
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TransferResult {
    Ok(u64), // ICRC-3 transaction index
    Err(TransferError),
}

/// Compact summary of a single live token, returned by `list_season_tokens`.
/// Used by the backend to compute end-of-season treasury weights without
/// having to pull full templates over the wire (templates can be huge).
/// Burned tokens are skipped server-side, so `owner` is always Some.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TokenInfo {
    pub token_id: TokenId,
    pub owner: Account,
    pub pixel_count: u64,
    pub minted_at: u64,
}

/// ICRC-7 metadata value. Subset — we only emit Text and Nat.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum Value {
    Nat(candid::Nat),
    Int(candid::Int),
    Text(String),
    Blob(serde_bytes::ByteBuf),
}

// ───── ICRC-3 transaction log ─────

/// Type of transaction logged in the ICRC-3 ledger.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub enum TxKind {
    Mint,
    Transfer,
    Burn,
}

/// Single ICRC-3 transaction record. Stored in `TX_LOG` stable map.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct TxRecord {
    pub kind: TxKind,
    pub timestamp: u64,
    pub token_id: TokenId,
    pub from: Option<Account>,
    pub to: Option<Account>,
    pub memo: Option<serde_bytes::ByteBuf>,
}

impl ic_stable_structures::Storable for TxRecord {
    fn to_bytes(&self) -> std::borrow::Cow<'_, [u8]> {
        std::borrow::Cow::Owned(candid::encode_one(self).expect("encode TxRecord"))
    }
    fn from_bytes(bytes: std::borrow::Cow<[u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode TxRecord")
    }
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 1024,
            is_fixed_size: false,
        };
}

/// ICRC-3 `GetTransactionsResponse` block.
#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct Icrc3Transaction {
    pub id: u64,
    pub kind: TxKind,
    pub timestamp: u64,
    pub token_id: TokenId,
    pub from: Option<Account>,
    pub to: Option<Account>,
    pub memo: Option<serde_bytes::ByteBuf>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct GetTransactionsResponse {
    pub log_length: u64,
    pub transactions: Vec<Icrc3Transaction>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct SupportedBlockType {
    pub block_type: String,
    pub url: String,
}

// ───── http_request types (ic-cdk style) ─────

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct HttpResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
}
