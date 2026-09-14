import { type CSSProperties } from "react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { PlayerSeat } from "./PlayerSeat.tsx";

/** The hand sets the dock's height. Use a compact identity header and full-size signal/goal row. */
export function OwnSeatDock({ snapshot, player, onCommunicate, communicationActive, locked }: {
  snapshot: Snapshot; player: Snapshot["players"][number]; onCommunicate(): void; communicationActive: boolean; locked: boolean;
}) {
  const tasks = snapshot.tasks.filter(task => task.ownerId === player.id);
  return <div className="own-seat-dock" style={{ '--own-goal-count': Math.max(1, tasks.length) } as CSSProperties}>
    <PlayerSeat snapshot={snapshot} player={player} position="south" mineId={player.id} compactIdentity
      onCommunicate={onCommunicate} communicationActive={communicationActive} locked={locked} />
  </div>;
}
