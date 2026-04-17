import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { AuthClient } from "@dfinity/auth-client";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { idlFactory, type BackendActor } from "./idl";

const canisterId = import.meta.env.VITE_BACKEND_CANISTER_ID as string;
const network = import.meta.env.VITE_DFX_NETWORK as string;

// Locally: use "localhost" (not 127.0.0.1) so that CORS between the frontend
// subdomain and the agent host shares the parent "localhost" origin. The
// boundary node uses the URL path to route /api calls to the right canister.
const host =
  network === "ic" ? "https://icp-api.io" : "http://localhost:4943";

/// Guardrail against the nastiest deploy bug: building a bundle with stale
/// `.env` values so a "local" page actually writes to mainnet (or vice
/// versa). If the bundle's target network disagrees with the hostname we
/// were served from, halt loudly — *nothing* should touch canisters until
/// this is reconciled. See README / dfx `output_env_file` for why this
/// happens (dfx rewrites .env per-network, and a forgotten rebuild bakes
/// whichever was last written into the bundle).
export function assertNetworkMatchesHost(): void {
  if (typeof window === "undefined") return;
  const h = window.location.hostname;
  const isLocalHost =
    h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost");
  const bundleIsIc = network === "ic";
  if (bundleIsIc && isLocalHost) {
    const msg =
      "DEPLOY MISMATCH: bundle was built with DFX_NETWORK=ic but is being " +
      "served from localhost. Writes would go to MAINNET backend " +
      canisterId +
      ". Rebuild with local env: `dfx deploy` (not --network ic) and reload.";
    showFatalBanner(msg);
    throw new Error(msg);
  }
  if (!bundleIsIc && !isLocalHost) {
    const msg =
      "DEPLOY MISMATCH: bundle was built for local (DFX_NETWORK=" +
      network +
      ") but is being served from " +
      h +
      ". Writes would go to LOCAL backend " +
      canisterId +
      " which mainnet cannot reach. Rebuild with `dfx deploy --network ic`.";
    showFatalBanner(msg);
    throw new Error(msg);
  }
}

function showFatalBanner(msg: string): void {
  try {
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#200;color:#fff;" +
      "font:14px/1.5 system-ui,sans-serif;padding:32px;white-space:pre-wrap;" +
      "display:flex;align-items:center;justify-content:center;text-align:center";
    el.textContent = msg;
    document.body.appendChild(el);
  } catch {}
}

/// Use Internet Identity on mainnet only. On local dev we skip the II
/// popup and auto-hydrate a persistent Ed25519 key in localStorage — so
/// opening the site while developing drops you straight into a signed-in
/// state without clicking through sign-in every reload.
export const useII = network === "ic";

const iiCanisterId = import.meta.env.VITE_II_CANISTER_ID as
  | string
  | undefined;

/// URL of the Internet Identity provider for the current network.
export const iiProviderUrl =
  network === "ic"
    ? "https://identity.ic0.app"
    : `http://${iiCanisterId}.localhost:4943`;

const STORAGE_KEY = "icpixel_dev_identity";
const REPLICA_FP_KEY = "icpixel_replica_fp";

/// Local-dev "login": generate an Ed25519 keypair, persist in localStorage.
/// Mainnet uses Internet Identity instead — see `loginWithII`.
export function loadOrCreateIdentity(): Ed25519KeyIdentity {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    try {
      return Ed25519KeyIdentity.fromJSON(existing);
    } catch (e) {
      console.warn("could not parse stored identity, creating new", e);
    }
  }
  const id = Ed25519KeyIdentity.generate();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(id.toJSON()));
  return id;
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}

/// On local dev, the replica's root key changes whenever it is reset
/// (e.g. `dfx start --clean`, or restarting after a crash without state).
/// Delegations/identities signed against the OLD root key produce
/// "Invalid signature" errors on every call. Detect a root-key change
/// on startup and wipe the stale identity + II delegation so the user
/// gets a fresh, working session automatically — no manual localStorage
/// clearing required.
export async function ensureReplicaFingerprint(): Promise<void> {
  if (network === "ic") return;
  try {
    const res = await fetch(`${host}/api/v2/status`, { cache: "no-store" });
    if (!res.ok) return;
    const buf = new Uint8Array(await res.arrayBuffer());
    // Hash the raw status body as a cheap fingerprint — it embeds the
    // replica's root_key, which changes whenever state is reset.
    const hash = await crypto.subtle.digest("SHA-256", buf);
    const fp = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const prev = localStorage.getItem(REPLICA_FP_KEY);
    if (prev && prev !== fp) {
      console.warn("[icpixel] local replica changed — clearing stale identity");
      // Wipe dev identity
      localStorage.removeItem(STORAGE_KEY);
      // Wipe II delegation stored by AuthClient (agent-js uses IndexedDB
      // "auth-client-db" by default, with localStorage fallback keys).
      try {
        Object.keys(localStorage)
          .filter((k) => k.startsWith("ic-") || k.startsWith("identity") || k.includes("delegation"))
          .forEach((k) => localStorage.removeItem(k));
      } catch {}
      try { indexedDB.deleteDatabase("auth-client-db"); } catch {}
    }
    localStorage.setItem(REPLICA_FP_KEY, fp);
  } catch (e) {
    console.warn("replica fingerprint check failed", e);
  }
}

let _authClient: AuthClient | null = null;

export async function getAuthClient(): Promise<AuthClient> {
  if (_authClient) return _authClient;
  _authClient = await AuthClient.create({
    idleOptions: { disableIdle: true },
  });
  return _authClient;
}

/// Triggers the II popup (mainnet only). Resolves with the authenticated
/// identity once the user signs in (or rejects on cancel).
export async function loginWithII(): Promise<Identity> {
  const client = await getAuthClient();
  await new Promise<void>((resolve, reject) => {
    client.login({
      identityProvider: iiProviderUrl,
      // 7 days
      maxTimeToLive: BigInt(7 * 24 * 60 * 60 * 1_000_000_000),
      onSuccess: () => resolve(),
      onError: (e) => reject(e),
    });
  });
  return client.getIdentity();
}

export async function logout(): Promise<void> {
  const client = await getAuthClient();
  await client.logout();
}

/// Shared HttpAgent for all canister calls made with the given identity.
/// Exposed so we can spin up secondary actors (e.g. ICP ledger for
/// `icrc2_approve`) without re-fetching the root key.
export async function makeAgent(identity?: Identity): Promise<HttpAgent> {
  const agent = new HttpAgent({ host, identity });
  if (network !== "ic") {
    await agent.fetchRootKey().catch((e) => {
      console.warn("fetchRootKey failed", e);
    });
  }
  return agent;
}

export async function makeActor(identity?: Identity): Promise<BackendActor> {
  const agent = await makeAgent(identity);
  return Actor.createActor<BackendActor>(idlFactory, {
    agent,
    canisterId,
  });
}

// NFT canister — separate ICRC-7 canister used for mission NFTs. Frontend
// needs direct access for the post-mint "transfer to my real wallet" flow,
// because the owner (caller) must sign the `icrc7_transfer` themselves.
import { idlFactory as nftIdlFactory, type _SERVICE as NftActor } from "../../declarations/nft/nft.did.js";

const nftCanisterId = import.meta.env.VITE_NFT_CANISTER_ID as string | undefined;

export async function makeNftActor(identity?: Identity): Promise<NftActor> {
  if (!nftCanisterId) throw new Error("VITE_NFT_CANISTER_ID not set");
  const agent = await makeAgent(identity);
  return Actor.createActor<NftActor>(nftIdlFactory, {
    agent,
    canisterId: nftCanisterId,
  });
}
