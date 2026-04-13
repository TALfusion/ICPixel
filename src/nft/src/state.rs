//! Stable state for the nft canister.
//!
//! Layout:
//!   MEM 0 — TOKENS:           StableBTreeMap<TokenId, Token>
//!   MEM 1 — NEXT_TOKEN_ID:    StableCell<TokenId>          (next id to mint)
//!   MEM 2 — BACKEND_PRINCIPAL: StableCell<Option<Principal>> (auth for mint)
//!
//! Owner index is *not* persisted — it's a derived view, rebuilt lazily on
//! demand. Token count is small relative to lookups (rebuilds are cheap and
//! avoid a second source of truth that could drift).

use crate::types::{Token, TokenId};
use candid::Principal;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager, VirtualMemory};
use ic_stable_structures::{DefaultMemoryImpl, StableBTreeMap, StableCell};
use std::cell::RefCell;

pub type Memory = VirtualMemory<DefaultMemoryImpl>;

const MEM_TOKENS: MemoryId = MemoryId::new(0);
const MEM_NEXT_TOKEN_ID: MemoryId = MemoryId::new(1);
const MEM_BACKEND_PRINCIPAL: MemoryId = MemoryId::new(2);

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));

    pub static TOKENS: RefCell<StableBTreeMap<TokenId, Token, Memory>> = RefCell::new(
        StableBTreeMap::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_TOKENS)),
        ),
    );

    pub static NEXT_TOKEN_ID: RefCell<StableCell<TokenId, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_NEXT_TOKEN_ID)),
            1u64,
        ).expect("init NEXT_TOKEN_ID"),
    );

    pub static BACKEND_PRINCIPAL: RefCell<StableCell<PrincipalCell, Memory>> = RefCell::new(
        StableCell::init(
            MEMORY_MANAGER.with(|m| m.borrow().get(MEM_BACKEND_PRINCIPAL)),
            PrincipalCell(None),
        ).expect("init BACKEND_PRINCIPAL"),
    );
}

/// Wrapper that gives `Option<Principal>` a `Storable` impl. We can't add
/// `impl Storable for Option<Principal>` directly (orphan rule), so we wrap
/// it in our own newtype.
#[derive(Clone, Debug, candid::CandidType, serde::Serialize, serde::Deserialize)]
pub struct PrincipalCell(pub Option<Principal>);

impl ic_stable_structures::Storable for PrincipalCell {
    fn to_bytes(&self) -> std::borrow::Cow<'_, [u8]> {
        std::borrow::Cow::Owned(candid::encode_one(self).expect("encode PrincipalCell"))
    }
    fn from_bytes(bytes: std::borrow::Cow<'_, [u8]>) -> Self {
        candid::decode_one(&bytes).expect("decode PrincipalCell")
    }
    // Principal is at most 29 bytes; candid framing pushes it under 64.
    const BOUND: ic_stable_structures::storable::Bound =
        ic_stable_structures::storable::Bound::Bounded {
            max_size: 64,
            is_fixed_size: false,
        };
}

pub fn backend_principal() -> Option<Principal> {
    BACKEND_PRINCIPAL.with(|c| c.borrow().get().0)
}

/// Set the backend principal. Returns an error string on stable-write
/// failure so the `#[update]` caller can propagate with `?`.
pub fn set_backend_principal(p: Principal) -> Result<(), String> {
    BACKEND_PRINCIPAL.with(|c| {
        c.borrow_mut()
            .set(PrincipalCell(Some(p)))
            .map(|_| ())
            .map_err(|e| format!("set BACKEND_PRINCIPAL: {e:?}"))
    })
}

/// Reserve the next token id. Returns an error string on stable-write
/// failure so the caller in `mint` can map it to `MintError::InternalError`.
pub fn next_token_id() -> Result<TokenId, String> {
    NEXT_TOKEN_ID.with(|c| {
        let cur = *c.borrow().get();
        c.borrow_mut()
            .set(cur + 1)
            .map(|_| cur)
            .map_err(|e| format!("set NEXT_TOKEN_ID: {e:?}"))
    })
}
