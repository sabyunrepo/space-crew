import { Orbit, Crown } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { Snapshot } from "../../../shared/contracts.ts";
import { cardImage, cardLabel, rankOf, suitOf, SUIT_META } from "../../../shared/cards.ts";
import { characterFor, characterImage } from "../../../shared/characters.ts";
import { CommunicationCard } from "./CommunicationCard.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { missionRules } from "../../../shared/missionRules.ts";
import { arrangeSeats } from "./seatLayout.ts";

export function TrickArea({ snapshot, mineId, onCommunicate, communicationActive, locked }: { snapshot: Snapshot; mineId?: string; onCommunicate?(): void; communicationActive?: boolean; locked?: boolean }) {
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
      let low = 16;
      let high = Math.min(180, layout.clientWidth * (mobile ? .1 : .05));
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
      // Measure the complete group (names, header, spacing and actual cards).
      // Grow into the free board space instead of capping every card at 88px.
      let cardLow = 16;
      let cardHigh = Math.min(board.width / 3, board.height / 2);
      const fits = (size: number) => {
        layout.style.setProperty("--trick-card", `${size}px`);
        const rect = center.getBoundingClientRect();
        const gap = mobile ? 4 : 12;
        return rect.left >= board.left + gap && rect.right <= board.right - gap &&
          rect.top >= board.top + gap && rect.bottom <= board.bottom + .5 &&
          occupied.every(seat => rect.right + gap <= seat.left || seat.right + gap <= rect.left ||
            rect.bottom + gap <= seat.top || seat.bottom + gap <= rect.top);
      };
      for (let i = 0; i < 12; i++) {
        const mid = (cardLow + cardHigh) / 2;
        if (fits(mid)) cardLow = mid;
        else cardHigh = mid;
      }
      layout.style.setProperty("--trick-card", `${cardLow}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(layout);
    document.fonts.ready.then(fit);
    return () => observer.disconnect();
  }, [snapshot]);
  const led = snapshot.trick[0]?.cardId;
  const seats = arrangeSeats(snapshot.players, mineId);
  return <div ref={tableRef} className={`crew-table ${snapshot.phase === "task_selection" || snapshot.phase === "briefing" ? "trick-waiting" : "table-surface"}`}>
    <div className="table-orbit" />
    <div className={`seat-layout played-cards seats-${snapshot.players.length}`}>
      {seats.map(({ player: p, position }) => {
        const play = snapshot.trick.find((t) => t.playerId === p.id);
        const fromTrick = missionRules(snapshot.missionId ?? 1).communication.fromTrick;
        const blockedReason = snapshot.missionProgress?.silentPlayerId === p.id ? "교신 금지" : snapshot.trickNumber < fromTrick ? `${fromTrick}트릭부터 교신` : undefined;
        const tasks = snapshot.tasks.filter((t) => t.ownerId === p.id);
        const turn = ["playing", "task_selection"].includes(snapshot.phase) && p.id === snapshot.turnPlayerId;
        const ownTurn = turn && p.id === mineId;
        const winner = snapshot.phase !== "playing" && snapshot.lastTrick?.winnerId === p.id;
        return <section key={p.id} className={`player-seat seat-${position} ${turn ? "on-turn" : ""} ${ownTurn ? "is-my-turn" : ""} ${winner ? "trick-winner" : ""}`}
          data-player-id={p.id} data-position={position} aria-current={turn ? "true" : undefined} aria-label={`${p.nickname} 대원 자리`}>
          {turn && <div className="seat-turn-indicator" role="status"><span className="seat-turn-badge"><span className="seat-turn-dot" aria-hidden="true" />{snapshot.phase === "task_selection" ? ownTurn ? "내 목표 선택" : "목표 선택 중" : ownTurn ? "내 차례" : "차례"}</span></div>}
          <header className="seat-heading">
            <strong>{p.id === snapshot.commanderId && <Crown size={12} aria-label="사령관" />}{p.nickname}{p.id === mineId && <small>나</small>}</strong>
            <span>{p.cardCount}장 · {p.tricksWon}승</span>
          </header>
          {snapshot.phase === "briefing" && <span className="seat-briefing">{p.briefingReady ? "브리핑 확인 완료" : "브리핑 확인 중"}</span>}
          <div className="seat-main-row">
            <div className="seat-column"><span className="seat-column-label">캐릭터</span>
              <div className="character-card" data-character-id={characterFor(p.characterId).id}>
                <img src={characterImage(p.characterId)} alt={characterFor(p.characterId).name} draggable={false} />
                <span>{characterFor(p.characterId).name}</span>
              </div>
            </div>
            <div className="seat-column communication"><span className="seat-column-label">신호</span>{p.id === mineId && snapshot.me.canCommunicate && onCommunicate ? <button type="button" className="seat-communication-button" aria-label="교신하기" aria-pressed={communicationActive} disabled={locked || !!snapshot.restartVote} onClick={onCommunicate}><CommunicationCard communication={p.communication} blockedReason={blockedReason} /></button> : <CommunicationCard communication={p.communication} blockedReason={blockedReason} />}</div>
          </div>
          {snapshot.phase === "playing" && <p className={`seat-submission ${play ? "submitted" : ""}`}>{play ? "카드 제출 완료 · 중앙에서 확인" : turn ? "카드를 선택해 주세요" : "카드 제출 대기"}</p>}
          <div className="seat-missions" aria-label={`${p.nickname} 미션 카드`}>
            <span className="seat-missions-label">목표 {tasks.length}</span>
            <div className="seat-task-list">{tasks.map((task) => <TaskCard key={task.id} task={task} />)}
              {!tasks.length && <span className="no-tasks">{snapshot.phase === "task_selection" ? "목표 배정 중" : "팀의 목표를 도와주세요"}</span>}
            </div>
          </div>
        </section>;
      })}
      <section className={`central-trick seats-${snapshot.players.length}`} aria-label="중앙 트릭">
        <header><strong>TRICK {snapshot.trickNumber}</strong><span>{led ? `${SUIT_META[suitOf(led)].color} 선도` : "대원들의 카드를 모아 봅니다"}</span></header>
        <div className="central-trick-cards">{seats.map(({ player, position }) => {
          const play = snapshot.trick.find(card => card.playerId === player.id);
          const current = snapshot.phase === "playing" && snapshot.turnPlayerId === player.id;
          return <div className={`central-play played-slot from-${position} ${current ? "awaiting-card" : ""}`}
            key={player.id} data-player-id={player.id} data-position={position} aria-label={`${player.nickname} 낸 카드`}>
            <span className="central-player-name">{player.nickname}{player.id === mineId ? " · 나" : ""}</span>
            {play ? <div tabIndex={0} className="card played-card" key={play.cardId}>
              <img src={cardImage(play.cardId)} alt={cardLabel(play.cardId)} draggable={false} />
              <b className={`card-value suit-${suitOf(play.cardId)}`}>{rankOf(play.cardId)}</b>
              {snapshot.trick[0]?.playerId === player.id && <small className="lead-card-label">선도</small>}
            </div> : <div className={`card-placeholder ${current ? "active" : ""}`}><Orbit size={18} /><span>{current ? "차례" : "대기"}</span></div>}
          </div>;
        })}</div>
      </section>
    </div>
  </div>;
}
