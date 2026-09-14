/** The Crew: Planet Nine, base game 3–5 players. Source: docs/MISSIONS.ko.md. */
export interface TaskToken { kind: "absolute" | "relative" | "omega"; value?: number }
export interface MissionRules {
  tokens: TaskToken[];
  communication: { fromTrick: number; hidden: boolean };
  assignment: "draft" | "decision" | "distribution";
  special: number[];
  ending: "tasks" | "full_hand" | "one_wins" | "rockets" | "black_cards";
}
const absolute: Record<number, number[]> = {
  3:[1,2],8:[1,2,3],11:[1],15:[1,2,3,4],19:[1],21:[1,2],23:[1,2,3,4,5],
  28:[1],31:[1,2,3],36:[1,2],40:[1,2,3],
};
const relative: Record<number, number[]> = {
  6:[1,2],14:[1,2,3],22:[1,2,3,4],25:[1,2],30:[1,2,3],35:[1,2,3],39:[1,2,3],45:[1,2,3],49:[1,2,3],
};
export function missionRules(id: number): MissionRules {
  const special = [5,9,11,12,13,16,23,26,29,33,34,40,41,44,46,48,50].includes(id) ? [id] : id === 17 ? [16] : [];
  if (id === 34) special.push(29);
  return {
    tokens: [
      ...(absolute[id] ?? []).map(value => ({ kind: "absolute" as const, value })),
      ...(relative[id] ?? []).map(value => ({ kind: "relative" as const, value })),
      ...([7,12,28,48].includes(id) ? [{ kind: "omega" as const }] : []),
    ],
    communication: {
      fromTrick: [18,30].includes(id) ? 2 : [19,28,38].includes(id) ? 3 : 1,
      hidden: [6,14,21,25,29,39].includes(id),
    },
    assignment: [20,27,37].includes(id) ? "decision" : [24,32,36,43].includes(id) ? "distribution" : "draft",
    special,
    ending: [5,16,29,33,34,41,50].includes(id) ? "full_hand" : [9,26].includes(id) ? "one_wins" : [13,44].includes(id) ? "rockets" : id === 46 ? "black_cards" : "tasks",
  };
}

/** Inspected logbook includes the commander in bespoke roles 5/33/41.
 * Keep the previous exclusion only while resuming an existing v2 attempt. */
export function roleIncludesCommander(id: number, rulesetVersion: string): boolean {
  return id !== 11 && !(rulesetVersion === "crew-p9-50-2" && [5, 33].includes(id));
}
