import type { ReactNode } from "react";
import { ArrowLeft, Copy, Wifi } from "lucide-react";
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
  action,
  connection,
  serviceMode,
  isHost,
  onInvite,
}: {
  title: string;
  message: string;
  onBack(): void;
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
}) {
  return (
    <header className="status-bar">
      <button
        type="button"
        className="status-back"
        onClick={onBack}
        aria-label="탐사 허브로 돌아가기"
      >
        <ArrowLeft size={18} />
      </button>
      <div className="status-message">
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      <div className="status-actions">
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
            onClick={onInvite}
          >
            <Copy size={14} />
            초대 링크
          </button>
        )}
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
