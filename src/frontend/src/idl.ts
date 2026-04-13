// Auto-generated IDL bindings — re-exported from `src/declarations/backend/`.
// Regenerate with `dfx generate backend` when backend.did changes.
//
// We re-export only the pieces the frontend needs:
//  - idlFactory   — candid factory for Actor.createActor
//  - BackendActor — typed service interface (aliased from _SERVICE)
//  - individual types the frontend references directly

export { idlFactory } from "../../declarations/backend/backend.did.js";

export type {
  _SERVICE as BackendActor,
  AdminStats,
  Alliance,
  AllianceError,
  AllianceOrPublic,
  AlliancePublic,
  AllianceUnitResult,
  Billing,
  BuyPixelsResult,
  ChangesResponse,
  CheckMissionResult,
  ClaimMissionRewardResult,
  ClaimResult,
  ClaimTreasuryResult,
  CreateAllianceResult,
  DistributeReport,
  DistributeTreasuryResult,
  GameState,
  IcpUsdCache,
  LeaderboardEntry,
  LeaderboardPage,
  Mission,
  MissionContributionResult,
  MissionContributionView,
  MissionRoundPublic,
  MissionStatus,
  PixelChange,
  PlaceError,
  PlaceResult,
  SetBillingResult,
  StreakEntry,
  UserStats,
  VersionInfo,
} from "../../declarations/backend/backend.did";
