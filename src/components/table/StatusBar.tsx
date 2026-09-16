import type { ReactNode } from "react";
import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Copy, LogOut, RotateCcw, Wifi } from "lucide-react";
import type { Connection, GameService } from "../../../shared/contracts.ts";

/**
 * 화면 최상단 고정 바. 좌: 뒤로가기, 중앙: 현재 단계 안내 문구, 우: 주요 액션 버튼.
 * "상태 표시줄 전체를 탭하면 액션 실행" 패턴은 쓰지 않는다 — 액션은 항상 명시적
 * 버튼(44px 이상)이다.
 */
export function StatusBar({
  title,
  message,
  onBack,
  onLeave,
  action,
  connection,
  serviceMode,
  isHost,
  onInvite,
  mission,
  onRestart,
  restartDisabled,
}: {
  title: string;
  message: string;
  onBack(): void;
  onLeave?(): void;
  action?: {
    label: string;
    icon?: ReactNode;
    onClick(): void;
    disabled?: boolean;
  } | null;
  connection: Connection;
  serviceMode: GameService["mode"];
  isHost: boolean;
  onInvite(): void;
  mission?: ReactNode;
  onRestart?(): void;
  restartDisabled?: boolean;
}) {
  const [mobileCompact, setMobileCompact] = useState(true);
  return (
    <header className={`status-bar ${mobileCompact ? "mobile-collapsed" : "mobile-expanded"}`}>
      <button
        type="button"
        className="status-back"
        onClick={onBack}
        aria-label="탐사 허브로 돌아가기"
      >
        <ArrowLeft size={18} />
      </button>
      <div className="status-overview">
        <div className="status-message">
          <strong>{title}</strong>
          <span>{message}</span>
        </div>
        {mission}
      </div>
      {mission && (
        <button
          type="button"
          className="status-mobile-toggle"
          aria-expanded={!mobileCompact}
          aria-label={mobileCompact ? "상단 안내 펼치기" : "상단 안내 접기"}
          onClick={() => setMobileCompact((compact) => !compact)}
        >
          {mobileCompact ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
        </button>
      )}
      <div className="status-actions">
        {onLeave && <button type="button" className="secondary status-leave" onClick={onLeave}><LogOut size={15} /><span className="status-leave-label">방 나가기</span></button>}
        <span className={`connection ${connection}`}>
          <Wifi size={13} />
          {serviceMode === "mock"
            ? "로컬 저장"
            : {
                connecting: "연결 중",
                connected: "실시간",
                reconnecting: "재연결",
                offline: "끊김",
              }[connection]}
        </span>
        {isHost && (
          <button
            type="button"
            className="secondary status-invite"
            aria-label="초대 링크"
            onClick={onInvite}
          >
            <Copy size={14} />
            <span className="status-invite-label">초대 링크</span>
          </button>
        )}
        {onRestart && <button type="button" className="secondary status-restart" disabled={restartDisabled} onClick={onRestart}><RotateCcw size={16} /><span>게임 포기 · 재시작</span></button>}
        {action && (
          <button
            type="button"
            className="primary status-primary"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </button>
        )}
      </div>
    </header>
  );
}
