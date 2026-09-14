import type { Command } from "../../shared/contracts.ts";
import { project, type State } from "./engine.ts";
import { suggestDemoCommand } from "./demoPolicy.ts";
export { suggestDemoCommand } from "./demoPolicy.ts";

export function pendingDemoActor(state: State): string | null {
  return state.players.find((p) => p.isDemo && suggestDemoCommand(project(state, p.id)))?.id ?? null;
}

export function demoCommand(state: State, actor: string): Command | null {
  return suggestDemoCommand(project(state, actor));
}
