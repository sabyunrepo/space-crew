import type { Snapshot } from "../../../shared/contracts.ts";
const positions: Record<number, string[]> = {
  3: ["south", "north-west", "north-east"],
  // Keep the central lane open for the horizontal four-card trick row. With
  // the viewer at south, the third opponent uses the upper-right side rather
  // than occupying the north-center slot above the trick.
  4: ["south", "west", "north-east", "east"],
  5: ["south", "west", "north-west", "north-east", "east"],
};
/** Rotate the cyclic server seat order so the viewer always sits south. */
export function arrangeSeats(players: Snapshot["players"], mineId?: string) {
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const start = Math.max(0, sorted.findIndex((p) => p.id === mineId));
  return [...sorted.slice(start), ...sorted.slice(0, start)].map((player, index) => ({
    player, position: positions[players.length]?.[index] ?? "south",
  }));
}
