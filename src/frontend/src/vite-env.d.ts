/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_CANISTER_ID: string;
  readonly VITE_NFT_CANISTER_ID: string;
  readonly VITE_II_CANISTER_ID: string;
  readonly VITE_DFX_NETWORK: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
