export type { LocateResult } from "./locate.ts";
export { locateExpression } from "./locate.ts";
export { EXTRACT_EXPRESSION } from "./script.ts";
export type {
  ExtractOptions,
  SnapHeading,
  SnapNode,
  Snapshot,
  SnapshotScroll,
} from "./snapshot.ts";
export {
  domHashOf,
  extractSnapshot,
  isSameView,
  renderSnapshot,
  SNAPSHOT_BUDGET_DEFAULT,
} from "./snapshot.ts";
