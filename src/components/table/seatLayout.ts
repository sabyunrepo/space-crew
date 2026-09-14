import type { Snapshot } from "../../../shared/contracts.ts";
const positions: Record<number, string[]> = {
  3: ["south", "north-west", "north-east"],
  4: ["south", "west", "north", "east"],
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
