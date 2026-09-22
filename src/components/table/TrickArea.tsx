import { Orbit } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel, suitOf, SUIT_META } from "../../../shared/cards.ts";
import { CompactCardFace } from "./CompactCardFace.tsx";
import { PlayerSeat } from "./PlayerSeat.tsx";
import { arrangeSeats } from "./seatLayout.ts";

export function TrickArea({ snapshot, mineId, onViewPlayer }: { snapshot: Snapshot; mineId?: string; onViewPlayer?: (playerId: string) => void }) {
  const tableRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const table = tableRef.current;
    const layout = table?.querySelector<HTMLElement>(".seat-layout");
    if (!table || !layout) return;
    // Fit the actual public goals and labels, including changes after a trick
    // or reconnect. Keep the hand and mission at their own readable sizes.
    const fit = () => {
      if (!layout.isConnected) return;
      const mobile = window.innerWidth <= 700;
      const available = layout.clientHeight - 18;
      const seats = [...layout.querySelectorAll<HTMLElement>(".player-seat")];
      const threePlayers = snapshot.players.length === 3;
      const fivePlayers = snapshot.players.length === 5;
      const areaWidth = layout.clientWidth / 3;
      const areaHeight = available / (threePlayers ? 1 : 2);
      seats.forEach(seat => { seat.dataset.goalFlow = areaWidth >= areaHeight ? "horizontal" : "vertical"; });
      let low = 16;
      const seatScale = mobile ? .075 : fivePlayers ? .055 : .045;
      let high = Math.min(fivePlayers ? 120 : 104, layout.clientWidth * seatScale);
      const required = (size: number) => {
        layout.style.setProperty("--seat-card", `${size}px`);
        const rows = [0, 0, 0];
        seats.forEach(seat => {
          const row = Number(getComputedStyle(seat).gridRowStart) - 1;
          rows[row] = Math.max(rows[row], seat.getBoundingClientRect().height);
        });
        return rows.reduce((a, b) => a + b, 0) + 12;
      };
      for (let i = 0; i < 12; i++) {
        const mid = (low + high) / 2;
        if (required(mid) <= available) low = mid;
        else high = mid;
      }
      layout.style.setProperty("--seat-card", `${low}px`);
      const center = layout.querySelector<HTMLElement>(".central-trick");
      if (!center) return;
      const board = layout.getBoundingClientRect();
      const occupied = seats.map(seat => seat.getBoundingClientRect());
      // Try every useful card arrangement and place its complete bounding box in
      // the largest free rectangle. This uses side/corner space that a fixed
      // center point misses, especially with four or five players.
      // Keep every table size readable at a glance: the trick is one horizontal
      // row for 3, 4, and 5 players. The surrounding seat layout already
      // provides the vertical separation; stacking the trick cards creates an
      // artificial off-center column and makes the active play harder to scan.
      const layouts = snapshot.players.length === 3 ? ["row-3"]
        : snapshot.players.length === 4 ? ["row-4"] : ["row-5"];
      const gap = mobile ? 3 : 6;
      center.style.transform = "none";
      center.style.bottom = "auto";
      center.style.removeProperty("width");
      const place = (x: number, y: number) => {
        center.style.left = `${x}px`;
        center.style.top = `${y}px`;
      };
      const findPlacement = (size: number) => {
        layout.style.setProperty("--trick-card", `${size}px`);
        place(0, 0);
        const measured = center.getBoundingClientRect();
        const width = measured.width, height = measured.height;
        const xs = new Set([gap, (board.width - width) / 2, board.width - width - gap]);
        const ys = new Set([gap, (board.height - height) / 2, board.height - height - gap]);
        for (const seat of occupied) {
          xs.add(seat.left - board.left - width - gap);
          xs.add(seat.right - board.left + gap);
          ys.add(seat.top - board.top - height - gap);
          ys.add(seat.bottom - board.top + gap);
        }
        const candidates = [...xs].flatMap(x => [...ys].map(y => ({ x, y })))
          .filter(({ x, y }) => x >= gap - .5 && y >= gap - .5 && x + width <= board.width - gap + .5 && y + height <= board.height - gap + .5)
          .sort((a, b) => Math.hypot(a.x + width / 2 - board.width / 2, a.y + height / 2 - board.height / 2)
            - Math.hypot(b.x + width / 2 - board.width / 2, b.y + height / 2 - board.height / 2));
        for (const candidate of candidates) {
          place(candidate.x, candidate.y);
          const rect = center.getBoundingClientRect();
          if (occupied.every(seat => rect.right + gap <= seat.left || seat.right + gap <= rect.left ||
            rect.bottom + gap <= seat.top || seat.bottom + gap <= rect.top)) return candidate;
        }
        return undefined;
      };
      let best: { layout: string; size: number; position: { x: number; y: number } } | undefined;
      for (const candidateLayout of layouts) {
        center.dataset.trickLayout = candidateLayout;
        let cardLow = 16;
        let cardHigh = Math.min(400, board.width / 2, board.height / 1.5);
        let position = findPlacement(cardLow);
        for (let i = 0; i < 13; i++) {
          const mid = (cardLow + cardHigh) / 2;
          const next = findPlacement(mid);
          if (next) { cardLow = mid; position = next; }
          else cardHigh = mid;
        }
        if (position && (!best || cardLow > best.size)) best = { layout: candidateLayout, size: cardLow, position };
      }
      if (best) {
        center.dataset.trickLayout = best.layout;
        layout.style.setProperty("--trick-card", `${best.size}px`);
        place(best.position.x, best.position.y);
        const rect = center.getBoundingClientRect();
        const middle = rect.left + rect.width / 2;
        const sameBand = occupied.filter(seat => seat.bottom > rect.top + 2 && seat.top < rect.bottom - 2);
        const leftEdge = Math.max(board.left + 2, ...sameBand.filter(seat => seat.right <= middle).map(seat => seat.right + 2));
        const rightEdge = Math.min(board.right - 2, ...sameBand.filter(seat => seat.left >= middle).map(seat => seat.left - 2));
        if (rightEdge - leftEdge >= rect.width) {
          center.style.left = `${leftEdge - board.left}px`;
          center.style.width = `${rightEdge - leftEdge}px`;
        }
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(layout);
    document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [snapshot]);
  const led = snapshot.trick[0]?.cardId;
  const seats = arrangeSeats(snapshot.players, mineId);
  const firstPlayerId = snapshot.trick[0]?.playerId ?? snapshot.turnPlayerId;
  const seatOrder = [...seats].sort((a, b) => a.player.seat - b.player.seat);
  const firstIndex = Math.max(0, seatOrder.findIndex(({ player }) => player.id === firstPlayerId));
  const trickOrder = [...seatOrder.slice(firstIndex), ...seatOrder.slice(0, firstIndex)];
  return <div ref={tableRef} className={`crew-table ${snapshot.phase === "task_selection" || snapshot.phase === "briefing" ? "trick-waiting" : "table-surface"}`}>
    <div className="table-orbit" />
    <div className={`seat-layout played-cards opponents-layout seats-${snapshot.players.length}`}>
      {seats.filter(({ player }) => player.id !== mineId).map(({ player, position }) =>
        <PlayerSeat key={player.id} snapshot={snapshot} player={player} position={position} mineId={mineId} compactIdentity onViewPlayer={onViewPlayer ? () => onViewPlayer(player.id) : undefined} />)}
      <section className={`central-trick seats-${snapshot.players.length}`} data-sequential-order="true" aria-label="중앙 트릭">
        <header><strong>TRICK {snapshot.trickNumber}</strong><span>{led ? `${SUIT_META[suitOf(led)].color} 선도` : "대원들의 카드를 모아 봅니다"}</span></header>
        <div className="central-trick-cards">{trickOrder.map(({ player, position }) => {
          const play = snapshot.trick.find(card => card.playerId === player.id);
          const current = snapshot.phase === "playing" && snapshot.turnPlayerId === player.id;
          return <div className={`central-play played-slot from-${position} ${current ? "awaiting-card" : ""}`}
            key={player.id} data-player-id={player.id} data-seat-index={player.seat} data-position={position} aria-label={`${player.nickname} 낸 카드${onViewPlayer ? " · 관전 화면 보기" : ""}`} onClick={onViewPlayer ? () => onViewPlayer(player.id) : undefined}>
            <span className="central-player-name">{player.nickname}{player.id === mineId ? " · 나" : ""}</span>
            {play ? <div tabIndex={0} className={`card played-card compact-card-container ${led === play.cardId ? "lead-card" : ""}`} aria-label={`${cardLabel(play.cardId)}${led === play.cardId ? " · 선도 카드" : ""}`} key={play.cardId}>
              <img className="compact-card-art" src={cardImage(play.cardId)} alt={cardLabel(play.cardId)} draggable={false} />
              <CompactCardFace cardId={play.cardId} />
            </div> : <div className={`card-placeholder ${current ? "active" : ""}`}><Orbit size={18} /><span>{current ? "차례" : "대기"}</span></div>}
          </div>;
        })}</div>
      </section>
    </div>
  </div>;
}
