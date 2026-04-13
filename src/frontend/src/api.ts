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
