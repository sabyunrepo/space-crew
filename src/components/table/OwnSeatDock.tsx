import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { PlayerSeat } from "./PlayerSeat.tsx";

/** The hand sets the dock's height. Fit identity and goals into the same row. */
export function OwnSeatDock({ snapshot, player, onCommunicate, communicationActive, locked }: {
  snapshot: Snapshot; player: Snapshot["players"][number]; onCommunicate(): void; communicationActive: boolean; locked: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tasks = snapshot.tasks.filter(task => task.ownerId === player.id);
  useLayoutEffect(() => {
    const wrapper = ref.current!;
    const panel = wrapper.querySelector<HTMLElement>('.player-seat')!;
    const fit = () => {
      if (!wrapper.isConnected || wrapper.clientHeight === 0) return;
      let low = 16, high = Math.min(100, (wrapper.clientWidth - 20) / 2);
      for (let i = 0; i < 12; i++) {
        const mid = (low + high) / 2;
        wrapper.style.setProperty('--seat-card', `${mid}px`);
        if (panel.scrollHeight <= panel.clientHeight && panel.scrollWidth <= panel.clientWidth) low = mid;
        else high = mid;
      }
      wrapper.style.setProperty('--seat-card', `${low}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(wrapper);
    document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [snapshot]);
  return <div className="own-seat-dock" ref={ref} style={{ '--own-goal-columns': Math.max(2, Math.ceil(tasks.length / 2)) } as CSSProperties}>
    <PlayerSeat snapshot={snapshot} player={player} position="south" mineId={player.id}
      onCommunicate={onCommunicate} communicationActive={communicationActive} locked={locked} />
  </div>;
}
