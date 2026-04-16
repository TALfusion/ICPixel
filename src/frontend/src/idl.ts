// Auto-generated IDL bindings — re-exported from `src/declarations/backend/`.
// Regenerate with `dfx generate backend` when backend.did changes.
//
// We re-export only the pieces the frontend needs:
//  - idlFactory   — candid factory for Actor.createActor
//  - BackendActor — typed service interface (aliased from _SERVICE)
//  - individual record / variant types the frontend references directly

export { idlFactory } from "../../declarations/backend/backend.did.js";

export type {
  _SERVICE as BackendActor,
  AdminStats,
  Alliance,
  AllianceError,
  AllianceOrPublic,
  AlliancePublic,
  Billing,
  ChangesResponse,
  ClaimResult,
  DistributeReport,
  GameState,
  LeaderboardEntry,
  LeaderboardPage,
  Mission,
  MissionContributionView,
  MissionRoundPublic,
  MissionStatus,
  OrderCreated,
  OrderStatus,
  OrderView,
  PixelChange,
  PixelPack,
  PlaceError,
  VersionInfo,
} from "../../declarations/backend/backend.did";
