import { roleIncludesCommander } from "../../shared/missionRules.ts";
import type { Command, Snapshot } from "../../shared/contracts.ts";

/** A flow demonstrator using exactly one player's public snapshot. It has no
 * access to other hands, unrevealed tasks, or the random deck. */
export function suggestDemoCommand(view: Snapshot): Command | null {
  const actor = view.me.playerId;
  const me = view.players.find((p) => p.id === actor);
  if (!me) return null;
  if (view.phase === "briefing")
    return me.briefingReady ? null : { type: "briefing_ready" };
  if (view.phase === "task_selection" && view.turnPlayerId === actor) {
    const task = view.tasks.find((t) => !t.ownerId);
    return task ? { type: "choose_task", taskId: task.id } : null;
  }
  if (view.phase === "playing" && view.turnPlayerId === actor) {
    const cardId = view.me.legalCardIds[0];
    return cardId ? { type: "play_card", cardId } : null;
  }
  const prep = view.preparation;
  if (view.phase !== "preparation" || !prep) return null;
  const commander = actor === view.commanderId;
  const answered = (id: string) => prep.answeredPlayerIds.includes(id);
  if (prep.stage === "distress_vote")
    return answered(actor) ? null : { type: "preparation_response", answer: "yes" };
  if (prep.stage === "distress_cards") {
    const cardId = view.me.hand.find((card) => !card.startsWith("rocket-"));
    return !answered(actor) && cardId ? { type: "select_distress_card", cardId } : null;
  }
  if (prep.stage === "token_edit")
    return commander ? { type: "confirm_tokens" } : null;
  if (prep.stage === "task_transfer")
    return commander ? { type: "skip_transfer" } : null;
  const responders = view.players.filter((p) =>
    prep.stage === "role" && view.missionId === 11 ? false :
    prep.stage !== "role" || roleIncludesCommander(view.missionId ?? 0, view.rulesetVersion) ? true : p.id !== view.commanderId,
  );
  if (responders.some((p) => p.id === actor) && !answered(actor))
    return { type: "preparation_response", answer: view.missionId === 50 ? "middle" : "yes" };
  if (!commander || responders.some((p) => !answered(p.id))) return null;
  // Balance only public assignment counts. The captain's distribution rule
  // constrains the final counts; selecting a least-loaded legal target works.
  const candidates = view.players
    .filter((p) => prep.eligiblePlayerIds.includes(p.id))
    .sort((a, b) => view.tasks.filter((t) => t.ownerId === a.id).length -
      view.tasks.filter((t) => t.ownerId === b.id).length);
  const playerId = candidates[0]?.id;
  if (!playerId) return null;
  if (prep.stage === "captain_distribution") return { type: "assign_task", playerId };
  if (prep.stage === "captain_decision" || prep.stage === "role") {
    const secondaryPlayerId = view.missionId === 50 ? candidates[1]?.id : undefined;
    return { type: "select_crew", playerId, ...(secondaryPlayerId ? { secondaryPlayerId } : {}) };
  }
  return null;
}
