import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Copy,
  Globe2,
  Radio,
  Rocket,
  Shuffle,
  Users,
  X,
  BookOpen,
  RotateCcw,
  Orbit,
  Wifi,
  ShieldCheck,
} from "lucide-react";
import {
  ApiError,
  type CardId,
  type Command,
  type Connection,
  type Envelope,
  type GameService,
  type Mission,
  type RoomSettings,
  type Snapshot,
} from "../shared/contracts.ts";
import {
  cardImage,
  cardLabel,
  deck,
  rankOf,
  SUIT_META,
  suitOf,
} from "../shared/cards.ts";
import missions from "../shared/missions.json";
import { communicationMarkers } from "./game/engine.ts";
import { makeService } from "./services/index.ts";
const labels = {
  lobby: "대원 모집 중",
  briefing: "임무 브리핑",
  task_selection: "목표 선택",
  playing: "임무 진행 중",
  trick_result: "트릭 확인",
  success: "임무 성공",
  failure: "임무 실패",
  campaign_complete: "탐사 완료",
};
const markers = {
  highest: "이 색 중 가장 높음",
  lowest: "이 색 중 가장 낮음",
  only: "이 색은 이 카드뿐",
};
const defaultSettings: RoomSettings = {
  name: "우리의 첫 번째 탐사",
  capacity: 3,
  missionMode: "sequential",
  startMission: 1,
};
function Card({
  id,
  small = false,
  selected = false,
  disabled = false,
  onClick,
}: {
  id: CardId;
  small?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <img
      src={cardImage(id)}
      alt={cardLabel(id)}
      loading="lazy"
      draggable={false}
    />
  );
  return onClick ? (
    <button
      className={`card ${small ? "small" : ""} ${selected ? "selected" : ""}`}
      aria-label={cardLabel(id)}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className={`card ${small ? "small" : ""}`}>{content}</div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function App() {
  const [serviceResult] = useState(() => {
    try {
      return { service: makeService(), error: "" };
    } catch (e) {
      return { service: null, error: (e as Error).message };
    }
  });
  const service = serviceResult.service;
  const [path, setPath] = useState(location.pathname);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [catalogue, setCatalogue] = useState<Mission[]>(missions);
  const [backendReady, setBackendReady] = useState(service?.mode === "mock");
  const [error, setError] = useState(serviceResult.error);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [modal, setModal] = useState<"missions" | "rules" | "cards" | null>(
    null,
  );
  const [settings, setSettings] = useState<RoomSettings>(defaultSettings);
  const [nickname, setNickname] = useState(
    () => localStorage.getItem("crew.nickname") || "별빛",
  );
  const [selected, setSelected] = useState<CardId | null>(null);
  const [recent, setRecent] = useState(() =>
    localStorage.getItem("crew.recent"),
  );
  const [inviteToken] = useState(() => location.hash.slice(1));
  const pending = useRef<{ roomId: string; envelope: Envelope } | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const createPending = useRef<{ key: string; id: string } | null>(null);
  const roomId = /^\/rooms\/([0-9a-f-]{36})$/.exec(path)?.[1];
  const navigate = (to: string) => {
    history.pushState(null, "", to);
    setPath(to);
    setError("");
    setSelected(null);
  };
  useEffect(() => {
    const listener = () => setPath(location.pathname);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    if (service)
      void service
        .capabilities()
        .then((c) => {
          setCatalogue(c.missions);
          setBackendReady(c.backendReady);
        })
        .catch((e) => setError(e.message));
  }, [service]);
  const accept = useCallback((next: Snapshot) => {
    setSnapshot((old) =>
      !old || old.roomId !== next.roomId || next.revision >= old.revision
        ? next
        : old,
    );
    localStorage.setItem("crew.recent", next.roomId);
    setRecent(next.roomId);
  }, []);
  useEffect(() => {
    if (!roomId || !service) {
      setSnapshot(null);
      return;
    }
    let active = true;
    const refresh = () =>
      service
        .snapshot(roomId)
        .then((next) => {
          if (active) accept(next);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void refresh();
    const unsubscribe = service.subscribe(
      roomId,
      () => void refresh(),
      (status) => {
        if (active) {
          setConnection(status);
          if (status === "connected") void refresh();
        }
      },
    );
    const visibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const offline = () => {
      if (service.mode === "supabase") setConnection("offline");
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15000);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", offline);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [roomId, service, accept]);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }
  async function send(command?: Command) {
    if (!service || !snapshot) return;
    await run(async () => {
      const request = command
        ? {
            roomId: snapshot.roomId,
            envelope: {
              commandId: crypto.randomUUID(),
              expectedRevision: snapshot.revision,
              attemptId: snapshot.attemptId,
              command,
            },
          }
        : pending.current;
      if (!request) return;
      pending.current = request;
      setHasPending(true);
      try {
        accept(await service.command(request.roomId, request.envelope));
        pending.current = null;
        setHasPending(false);
        setSelected(null);
      } catch (e) {
        if (e instanceof ApiError && e.status !== 0 && e.status < 500) {
          pending.current = null;
          setHasPending(false);
          accept(await service.snapshot(request.roomId));
        }
        throw e;
      }
    });
  }
  async function enter(join = false) {
    if (!service) return;
    await run(async () => {
      const key = JSON.stringify({ join, nickname, settings, inviteToken });
      if (createPending.current?.key !== key)
        createPending.current = { key, id: crypto.randomUUID() };
      const commandId = createPending.current!.id;
      const entry = join
        ? await service.joinRoom({ commandId, nickname, inviteToken })
        : await service.createRoom({ commandId, nickname, settings });
      localStorage.setItem("crew.nickname", nickname);
      accept(entry.snapshot);
      createPending.current = null;
      history.replaceState(null, "", `/rooms/${entry.snapshot.roomId}`);
      setPath(`/rooms/${entry.snapshot.roomId}`);
    });
  }
  async function copyInvite() {
    if (!snapshot || !service) return;
    await run(async () => {
      const token = await service.invite(snapshot.roomId);
      const link = `${location.origin}/join#${token}`;
      try {
        await navigator.clipboard.writeText(link);
        setNotice("초대 링크를 복사했습니다.");
      } catch {
        setNotice(`초대 링크: ${link}`);
      }
    });
  }
  const mine = snapshot?.players.find((p) => p.id === snapshot.me.playerId);
  const isHost = snapshot?.hostId === snapshot?.me.playerId;
  const currentMission = catalogue.find(
    (m) =>
      m.id ===
      (snapshot?.missionId ||
        snapshot?.settings.startMission ||
        settings.startMission),
  );
  const locked = busy || hasPending;
  const modalMissionSelect = (id: number) => {
    setSettings((old) => ({
      ...old,
      startMission: id,
      missionMode: "sequential",
    }));
    setModal(null);
  };
  return (
    <div className="app-shell">
      <header className="site-header">
        <button
          className="brand"
          onClick={() => navigate("/")}
          aria-label="스페이스 크루 홈"
        >
          <span className="brand-icon">
            <Orbit size={25} />
          </span>
          <span>
            SPACE CREW<small>함께, 아홉 번째 행성으로</small>
          </span>
        </button>
        <nav>
          <button onClick={() => setModal("rules")}>
            <BookOpen size={16} />
            <span>플레이 가이드</span>
          </button>
          <button onClick={() => setModal("cards")}>카드 도감</button>
          <span className="mode-tag">
            <i />
            {service?.mode === "mock" ? "LOCAL DEMO" : "SUPABASE"}
          </span>
        </nav>
      </header>
      {service?.mode === "mock" && (
        <div className="demo-banner">
          <Globe2 size={14} /> 로컬 데모 · 이 브라우저에 진행 상황이 저장됩니다.
          다른 기기와의 실시간 접속은 Supabase 연동 후 지원합니다.
        </div>
      )}
      {error && (
        <div role="alert" className="alert">
          <span>{error}</span>
          {hasPending ? (
            <button disabled={busy} onClick={() => void send()}>
              같은 요청 재전송
            </button>
          ) : (
            <button
              className="icon-button"
              onClick={() => setError("")}
              aria-label="오류 닫기"
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          <span>{notice}</span>
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="알림 닫기"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!roomId && path !== "/join" && (
        <main className="home">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">
                <span /> COOPERATIVE SPACE ADVENTURE
              </p>
              <h1>
                목적지는 멀리.
                <br />
                우리는 <em>함께.</em>
              </h1>
              <p className="hero-description">
                한 장의 카드, 한 번의 교신.
                <br />
                서로의 마음을 읽으며 아홉 번째 행성을 찾아 떠나요.
              </p>
              <div className="hero-stats">
                <span>
                  <Users size={17} />
                  3–5명의 대원
                </span>
                <span>
                  <Radio size={17} />
                  협력 트릭테이킹
                </span>
                <span>
                  <Orbit size={17} />
                  50개의 임무
                </span>
              </div>
              <a className="primary hero-cta" href="#launch">
                새로운 탐사 시작하기 <ArrowRight size={18} />
              </a>
              {recent && (
                <button
                  className="resume"
                  onClick={() => navigate(`/rooms/${recent}`)}
                >
                  <RotateCcw size={15} />
                  이전 탐사 이어하기
                </button>
              )}
            </div>
            <div className="hero-art" aria-label="완성된 우주 탐사 카드">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="planet" />
              <span className="coordinate">SECTOR 09 / UNKNOWN ORBIT</span>
              <div className="hero-card card-a">
                <Card id="blue-5" />
              </div>
              <div className="hero-card card-b">
                <Card id="yellow-7" />
              </div>
              <div className="hero-card card-c">
                <Card id="green-4" />
              </div>
              <div className="floating-caption">
                <span className="pulse" /> ALL CREW, READY FOR LAUNCH.
              </div>
              <span className="art-number">09</span>
            </div>
          </section>
          <section id="launch" className="launch-grid">
            <div className="launch-intro">
              <p className="eyebrow">YOUR NEXT MISSION</p>
              <h2>
                우리만의 우주선을
                <br />
                준비해 볼까요?
              </h2>
              <p>
                시작할 임무를 고르고 대원을 초대하세요.
                <br />
                잠시 떠나도 같은 브라우저에서 이어갈 수 있어요.
              </p>
              <div className="feature-line">
                <ShieldCheck size={20} />
                <div>
                  <strong>모두가 함께 성공하는 게임</strong>
                  <span>손패는 나만 보고, 목표는 함께 완수해요.</span>
                </div>
              </div>
              <button
                className="text-button"
                onClick={() => setModal("missions")}
              >
                50개 미션 살펴보기 <ChevronRight size={16} />
              </button>
            </div>
            <form
              className="launch-panel"
              onSubmit={(event) => {
                event.preventDefault();
                void enter();
              }}
            >
              <div className="panel-heading">
                <h3>탐사선 만들기</h3>
                <span>01 / PREPARATION</span>
              </div>
              <div className="two-columns">
                <label>
                  대원 이름
                  <input
                    required
                    maxLength={16}
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="나의 호출명"
                  />
                </label>
                <label>
                  탐사선 이름
                  <input
                    required
                    maxLength={32}
                    value={settings.name}
                    onChange={(e) =>
                      setSettings({ ...settings, name: e.target.value })
                    }
                  />
                </label>
              </div>
              <label>탑승 인원</label>
              <div className="segments">
                {([3, 4, 5] as const).map((n) => (
                  <button
                    type="button"
                    key={n}
                    aria-pressed={settings.capacity === n}
                    className={settings.capacity === n ? "active" : ""}
                    onClick={() => setSettings({ ...settings, capacity: n })}
                  >
                    <Users size={16} />
                    {n}명
                  </button>
                ))}
              </div>
              <label>임무 진행 방식</label>
              <div className="mission-modes">
                <button
                  type="button"
                  className={
                    settings.missionMode === "sequential" ? "active" : ""
                  }
                  aria-pressed={settings.missionMode === "sequential"}
                  onClick={() =>
                    setSettings({ ...settings, missionMode: "sequential" })
                  }
                >
                  <Orbit size={20} />
                  <strong>순서대로 탐사</strong>
                  <small>선택한 번호부터 차근차근</small>
                </button>
                <button
                  type="button"
                  className={settings.missionMode === "random" ? "active" : ""}
                  aria-pressed={settings.missionMode === "random"}
                  onClick={() =>
                    setSettings({ ...settings, missionMode: "random" })
                  }
                >
                  <Shuffle size={20} />
                  <strong>랜덤 탐사</strong>
                  <small>완료한 임무는 중복 없이</small>
                </button>
              </div>
              {settings.missionMode === "sequential" ? (
                <label className="mission-select">
                  시작 미션
                  <select
                    value={settings.startMission}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        startMission: Number(e.target.value),
                      })
                    }
                  >
                    {catalogue.map((m) => (
                      <option key={m.id} value={m.id}>
                        {String(m.id).padStart(2, "0")} · {m.title}
                        {m.playable ? "" : " (규칙 구현 예정)"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="helper">
                  현재 실행 가능한{" "}
                  {catalogue
                    .filter((m) => m.playable)
                    .map((m) => m.id)
                    .join(", ")}
                  번 미션 중 추첨합니다. 실패하면 같은 미션으로 다시 도전해요.
                </p>
              )}
              {!catalogue.find((m) => m.id === settings.startMission)
                ?.playable &&
                settings.missionMode === "sequential" && (
                  <p className="helper warning">
                    선택한 미션으로 방을 준비할 수 있습니다. 실제 시작은 해당
                    규칙 구현 후 가능합니다.
                  </p>
                )}
              <button
                className="primary full"
                disabled={busy || !service || !backendReady}
              >
                탐사선 만들기 <ArrowRight size={18} />
              </button>
              {!backendReady && (
                <p className="helper warning">
                  백엔드 준비 상태를 확인해 주세요. 제공된 Edge Function 골격은
                  연동 계약만 포함합니다.
                </p>
              )}
            </form>
          </section>
          <section className="how-it-works">
            <p className="eyebrow">SMALL SIGNALS. BIG ADVENTURES.</p>
            <div>
              {[
                ["01", "목표를 나누고", "누가 어떤 카드를 획득할지 정해요."],
                [
                  "02",
                  "한 번의 신호를 보내고",
                  "임무당 한 번, 카드 한 장으로 교신해요.",
                ],
                [
                  "03",
                  "같은 목적지에 도착해요",
                  "각자의 손패로 팀의 목표를 완수해요.",
                ],
              ].map(([n, t, d]) => (
                <article key={n}>
                  <span>{n}</span>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </article>
              ))}
            </div>
          </section>
        </main>
      )}
      {path === "/join" && (
        <main className="join-view">
          <Rocket size={42} />
          <p className="eyebrow">YOUR CREW IS WAITING</p>
          <h1>탐사선에 초대받았어요.</h1>
          <p>대원 이름을 정하고 여정에 합류하세요.</p>
          <form
            className="launch-panel"
            onSubmit={(e) => {
              e.preventDefault();
              void enter(true);
            }}
          >
            <label>
              대원 이름
              <input
                required
                maxLength={16}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
            <button
              className="primary full"
              disabled={busy || !service || !inviteToken}
            >
              탐사선 탑승하기 <ArrowRight size={18} />
            </button>
            {!inviteToken && (
              <p className="helper warning">
                초대 토큰이 없습니다. 전체 초대 링크로 다시 접속해 주세요.
              </p>
            )}
          </form>
        </main>
      )}
      {roomId && (!snapshot || snapshot.roomId !== roomId) && (
        <main className="loading">
          탐사선 상태를 불러오는 중…{" "}
          <button onClick={() => navigate("/")}>홈으로</button>
        </main>
      )}
      {roomId && snapshot && snapshot.roomId === roomId && (
        <main
          className="room-view"
          aria-busy={busy}
          data-revision={snapshot.revision}
        >
          <div className="room-heading">
            <div>
              <button className="text-button" onClick={() => navigate("/")}>
                <ArrowLeft size={15} />
                탐사 허브
              </button>
              <h1>{snapshot.settings.name}</h1>
              <p>
                <span className="phase-chip">{labels[snapshot.phase]}</span>
                <span>
                  {snapshot.settings.missionMode === "random"
                    ? "랜덤 탐사"
                    : "순차 탐사"}{" "}
                  · {snapshot.players.length}/{snapshot.settings.capacity}명
                </span>
              </p>
            </div>
            <div className="room-actions">
              <span className={`connection ${connection}`}>
                <Wifi size={14} />
                {service?.mode === "mock"
                  ? "로컬 저장 중"
                  : {
                      connecting: "연결 중",
                      connected: "실시간 연결",
                      reconnecting: "재연결 중",
                      offline: "연결 끊김",
                    }[connection]}
              </span>
              {isHost && (
                <button
                  className="secondary"
                  onClick={() => void copyInvite()}
                  disabled={busy}
                >
                  <Copy size={15} />
                  초대 링크
                </button>
              )}
            </div>
          </div>
          <div className="game-layout">
            <aside className="crew-panel">
              <div className="panel-heading">
                <h3>탑승 대원</h3>
                <span>CREW</span>
              </div>
              {Array.from({ length: snapshot.settings.capacity }, (_, i) => {
                const p = snapshot.players[i];
                return (
                  <div
                    key={i}
                    className={`crew-member ${p?.id === snapshot.turnPlayerId ? "on-turn" : ""}`}
                  >
                    <div className={`avatar avatar-${i}`}>
                      {p ? p.nickname.slice(0, 1) : "+"}
                    </div>
                    <div className="member-details">
                      <strong>
                        {p?.nickname || "대원을 기다려요"}
                        {p?.id === mine?.id && <small>나</small>}
                        {p?.id === snapshot.commanderId && (
                          <span title="사령관"> ★</span>
                        )}
                      </strong>
                      <span>
                        {p
                          ? snapshot.phase === "lobby"
                            ? p.ready
                              ? "탑승 준비 완료"
                              : "준비 중"
                            : snapshot.phase === "briefing"
                              ? `${p.cardCount}장 · ${p.briefingReady ? "브리핑 확인 완료" : "브리핑 확인 중"}`
                              : `${p.cardCount}장 · ${p.tricksWon}트릭 획득`
                          : "빈 좌석"}
                      </span>
                      {p?.communication && (
                        <div className="communication">
                          <Radio size={12} />
                          {cardLabel(p.communication.cardId)}
                          <small>
                            {markers[p.communication.marker]}
                            {p.communication.played ? " · 사용함" : ""}
                          </small>
                        </div>
                      )}
                    </div>
                    {p?.isDemo && <span className="bot-tag">DEMO</span>}
                    {p?.ready && snapshot.phase === "lobby" && (
                      <Check size={16} />
                    )}
                  </div>
                );
              })}
              <div className="crew-footer">
                <Radio size={17} />
                <p>
                  손패 이야기는 잠시 접어 두고,
                  <br />
                  허용된 교신으로 마음을 전해요.
                </p>
              </div>
            </aside>
            <section className="main-console">
              {snapshot.phase === "lobby" ? (
                <div className="lobby-stage">
                  <div className="lobby-orbit">
                    <Rocket size={46} />
                  </div>
                  <p className="eyebrow">WAITING FOR THE CREW</p>
                  <h2>
                    모든 대원이 모이면,
                    <br />
                    여정이 시작돼요.
                  </h2>
                  <p>
                    임무{" "}
                    {snapshot.settings.missionMode === "random"
                      ? "랜덤 선택"
                      : `${String(snapshot.settings.startMission).padStart(2, "0")} · ${currentMission?.title}`}
                  </p>
                  <div className="lobby-actions">
                    <button
                      className={mine?.ready ? "secondary" : "primary"}
                      disabled={locked}
                      onClick={() =>
                        void send({ type: "set_ready", ready: !mine?.ready })
                      }
                    >
                      <Check size={17} />
                      {mine?.ready ? "준비 취소" : "탑승 준비 완료"}
                    </button>
                    {service?.fillDemoCrew &&
                      snapshot.players.length < snapshot.settings.capacity && (
                        <button
                          className="secondary"
                          disabled={locked}
                          onClick={() =>
                            void run(async () =>
                              accept(await service.fillDemoCrew!(roomId)),
                            )
                          }
                        >
                          <Users size={17} />
                          데모 대원 채우기
                        </button>
                      )}
                  </div>
                  {isHost && (
                    <button
                      className="primary full start-button"
                      disabled={
                        locked ||
                        (!currentMission?.playable &&
                          snapshot.settings.missionMode !== "random") ||
                        snapshot.players.length !==
                          snapshot.settings.capacity ||
                        snapshot.players.some((p) => !p.ready)
                      }
                      onClick={() => void send({ type: "start_mission" })}
                    >
                      임무 시작 <ArrowRight size={18} />
                    </button>
                  )}
                  {!currentMission?.playable &&
                    snapshot.settings.missionMode === "sequential" && (
                      <p className="helper warning">
                        미션 {currentMission?.id}의 특수 규칙은 구현 예정입니다.
                        현재 미션 1~4를 플레이할 수 있습니다.
                      </p>
                    )}
                  {isHost && (
                    <label className="lobby-mission">
                      시작 미션 변경
                      <select
                        disabled={locked}
                        value={snapshot.settings.startMission}
                        onChange={(e) =>
                          void send({
                            type: "update_settings",
                            settings: {
                              ...snapshot.settings,
                              startMission: Number(e.target.value),
                              missionMode: "sequential",
                            },
                          })
                        }
                      >
                        {catalogue.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.id} · {m.title}
                            {m.playable ? "" : " (구현 예정)"}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p className="helper">
                    데모 대원은 규칙 확인용입니다. 협력 전략을 판단하는 AI는
                    아닙니다.
                  </p>
                </div>
              ) : (
                <>
                  <div className="mission-strip">
                    <div>
                      <span className="eyebrow">
                        MISSION {String(snapshot.missionId).padStart(2, "0")} /
                        50
                      </span>
                      <h2>{currentMission?.title}</h2>
                    </div>
                    <span className="attempt">
                      {snapshot.attemptNumber}번째 시도 · 트릭{" "}
                      {snapshot.trickNumber}
                    </span>
                  </div>
                  <div className="mission-objective">
                    <span>임무 목표</span>
                    <p>{currentMission?.summary}</p>
                    {currentMission?.modifiers.map((m) => (
                      <small key={m}>{m}</small>
                    ))}
                  </div>
                  {snapshot.phase === "briefing" && (
                    <div className="briefing">
                      <Orbit size={35} />
                      <h3>손패를 확인하고, 임무를 읽어 주세요.</h3>
                      <p>
                        로켓 4를 가진{" "}
                        {
                          snapshot.players.find(
                            (p) => p.id === snapshot.commanderId,
                          )?.nickname
                        }{" "}
                        대원이 사령관입니다.
                        <br />
                        모두 확인하면 사령관부터 목표를 선택합니다.
                      </p>
                      <button
                        className="primary"
                        disabled={locked || mine?.briefingReady}
                        onClick={() => void send({ type: "briefing_ready" })}
                      >
                        {mine?.briefingReady
                          ? "다른 대원의 확인을 기다려요"
                          : "임무 확인 완료"}
                        <Check size={16} />
                      </button>
                    </div>
                  )}
                  <div className="target-area">
                    <div className="section-title">
                      <h3>
                        함께 완수할 목표{" "}
                        <span>
                          {
                            snapshot.tasks.filter((t) => t.status === "success")
                              .length
                          }
                          /{snapshot.tasks.length}
                        </span>
                      </h3>
                      {snapshot.phase === "task_selection" && (
                        <span>
                          {snapshot.turnPlayerId === mine?.id
                            ? "내 목표를 선택하세요"
                            : `${snapshot.players.find((p) => p.id === snapshot.turnPlayerId)?.nickname} 선택 중`}
                        </span>
                      )}
                    </div>
                    <div className="target-list">
                      {snapshot.tasks.map((task) => (
                        <div className={`target ${task.status}`} key={task.id}>
                          <Card
                            id={task.cardId}
                            small
                            onClick={
                              snapshot.phase === "task_selection" &&
                              !task.ownerId
                                ? () =>
                                    void send({
                                      type: "choose_task",
                                      taskId: task.id,
                                    })
                                : undefined
                            }
                            disabled={
                              locked || snapshot.turnPlayerId !== mine?.id
                            }
                          />
                          <div>
                            <strong>{cardLabel(task.cardId)}</strong>
                            <span>
                              {task.ownerId
                                ? snapshot.players.find(
                                    (p) => p.id === task.ownerId,
                                  )?.nickname
                                : "담당 대원 선택"}
                            </span>
                            <small>
                              {task.order ? `${task.order}번째로 획득 · ` : ""}
                              {task.status === "success"
                                ? "목표 완료 ✓"
                                : task.status === "failed"
                                  ? "목표 실패"
                                  : "대기 중"}
                            </small>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {[
                    "playing",
                    "trick_result",
                    "success",
                    "failure",
                    "campaign_complete",
                  ].includes(snapshot.phase) && (
                    <div className="table-surface">
                      <div className="table-orbit" />
                      <p className="table-label">
                        {snapshot.phase === "playing"
                          ? snapshot.trick.length
                            ? `${SUIT_META[suitOf(snapshot.trick[0].cardId)].color} 선도 · 같은 색이 있다면 따라 내세요`
                            : "새로운 트릭 · 선도 대원의 카드를 기다려요"
                          : snapshot.lastTrick
                            ? `${snapshot.players.find((p) => p.id === snapshot.lastTrick!.winnerId)?.nickname} 대원 트릭 획득`
                            : "탐사를 마쳤습니다"}
                      </p>
                      <div className="played-cards">
                        {snapshot.players.map((p) => {
                          const play = snapshot.trick.find(
                            (t) => t.playerId === p.id,
                          );
                          return (
                            <div className="played-slot" key={p.id}>
                              <span
                                className={
                                  p.id === snapshot.turnPlayerId
                                    ? "turn-label"
                                    : ""
                                }
                              >
                                {p.nickname}
                                {p.id === mine?.id ? " (나)" : ""}
                              </span>
                              {play ? (
                                <Card id={play.cardId} />
                              ) : (
                                <div
                                  className={`card-placeholder ${p.id === snapshot.turnPlayerId ? "active" : ""}`}
                                >
                                  <Orbit size={27} />
                                  <span>
                                    {p.id === snapshot.turnPlayerId
                                      ? "플레이 차례"
                                      : "대기"}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {snapshot.phase === "trick_result" && isHost && (
                        <button
                          className="primary"
                          disabled={locked}
                          onClick={() => void send({ type: "advance_trick" })}
                        >
                          다음 트릭 <ArrowRight size={16} />
                        </button>
                      )}
                      {["success", "failure", "campaign_complete"].includes(
                        snapshot.phase,
                      ) && (
                        <div className={`result-box ${snapshot.phase}`}>
                          <h2>
                            {snapshot.phase === "success"
                              ? "임무 성공!"
                              : snapshot.phase === "failure"
                                ? "다시, 함께 도전해요."
                                : "탐사 완료!"}
                          </h2>
                          <p>{snapshot.resultReason}</p>
                          {isHost && snapshot.phase !== "campaign_complete" && (
                            <button
                              className="primary"
                              disabled={
                                locked ||
                                (snapshot.phase === "success" &&
                                  snapshot.settings.missionMode ===
                                    "sequential" &&
                                  !catalogue.find(
                                    (m) => m.id === snapshot.missionId! + 1,
                                  )?.playable)
                              }
                              onClick={() =>
                                void send({
                                  type:
                                    snapshot.phase === "success"
                                      ? "next_mission"
                                      : "retry_mission",
                                })
                              }
                            >
                              {snapshot.phase === "success"
                                ? "다음 임무"
                                : "같은 미션 다시 도전"}
                              <ArrowRight size={16} />
                            </button>
                          )}
                          {snapshot.phase === "success" &&
                            snapshot.settings.missionMode === "sequential" &&
                            snapshot.missionId === 4 && (
                              <p className="helper">
                                데모의 네 번째 임무까지 완료했습니다. 미션
                                5부터는 특수 규칙 구현 후 이어집니다.
                              </p>
                            )}
                        </div>
                      )}
                    </div>
                  )}
                  {service?.demoStep &&
                    ((snapshot.phase === "briefing" &&
                      snapshot.players.some(
                        (p) => p.isDemo && !p.briefingReady,
                      )) ||
                      (["playing", "task_selection"].includes(snapshot.phase) &&
                        snapshot.players.some(
                          (p) => p.isDemo && p.id === snapshot.turnPlayerId,
                        ))) && (
                      <button
                        className="demo-step secondary"
                        disabled={locked}
                        onClick={() =>
                          void run(async () =>
                            accept(await service.demoStep!(roomId)),
                          )
                        }
                      >
                        데모 대원 진행 <ChevronRight size={16} />
                      </button>
                    )}
                  <div className="hand-section">
                    <div className="section-title">
                      <h3>
                        내 손패 <span>{snapshot.me.hand.length}장</span>
                      </h3>
                      <span>
                        {snapshot.turnPlayerId === mine?.id &&
                        snapshot.phase === "playing"
                          ? "내 차례입니다"
                          : "카드는 나에게만 보여요"}
                      </span>
                    </div>
                    <div className="hand-cards">
                      {snapshot.me.hand.map((card) => (
                        <Card
                          key={card}
                          id={card}
                          selected={selected === card}
                          onClick={() =>
                            setSelected(selected === card ? null : card)
                          }
                          disabled={locked}
                        />
                      ))}
                    </div>
                    <div className="hand-controls">
                      <span>
                        {selected
                          ? cardLabel(selected)
                          : "카드를 선택해 자세히 확인하세요."}
                      </span>
                      <button
                        className="primary"
                        disabled={
                          locked ||
                          !selected ||
                          !snapshot.me.legalCardIds.includes(selected)
                        }
                        onClick={() =>
                          selected &&
                          void send({ type: "play_card", cardId: selected })
                        }
                      >
                        선택한 카드 내기 <ArrowRight size={16} />
                      </button>
                    </div>
                    {selected && snapshot.me.canCommunicate && (
                      <div className="communication-options">
                        <Radio size={17} />
                        <span>교신하기</span>
                        {communicationMarkers(snapshot.me.hand, selected).map(
                          (marker) => (
                            <button
                              className="secondary"
                              disabled={locked}
                              key={marker}
                              onClick={() =>
                                void send({
                                  type: "communicate",
                                  cardId: selected,
                                  marker,
                                })
                              }
                            >
                              {markers[marker]}
                            </button>
                          ),
                        )}
                        {!communicationMarkers(snapshot.me.hand, selected)
                          .length && (
                          <small>이 카드는 지금 교신할 수 없어요.</small>
                        )}
                      </div>
                    )}
                    {snapshot.lastTrick && (
                      <details className="last-trick">
                        <summary>
                          지난 트릭 확인 ·{" "}
                          {
                            snapshot.players.find(
                              (p) => p.id === snapshot.lastTrick!.winnerId,
                            )?.nickname
                          }{" "}
                          획득
                        </summary>
                        <div>
                          {snapshot.lastTrick.plays.map((p) => (
                            <span key={p.playerId}>
                              {
                                snapshot.players.find(
                                  (m) => m.id === p.playerId,
                                )?.nickname
                              }
                              : {cardLabel(p.cardId)}
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </>
              )}
            </section>
          </div>
        </main>
      )}
      <footer>
        <span>
          SPACE CREW <span className="footer-dot">•</span> 함께 만드는 우주 탐사
        </span>
        <span>THE QUEST FOR PLANET NINE · FAN PROJECT</span>
      </footer>
      {modal === "missions" && (
        <Modal title="50개의 임무 기록" onClose={() => setModal(null)}>
          <p className="helper">
            미션 1~4는 데모 플레이, 나머지는 규칙 열람과 시작 번호 설정을
            지원합니다. 특수 미션은 백엔드 구현 시 활성화합니다.
          </p>
          <div className="mission-catalogue">
            {catalogue.map((m) => (
              <article key={m.id}>
                <span className="mission-number">
                  {String(m.id).padStart(2, "0")}
                </span>
                <div>
                  <h3>
                    {m.title}
                    <small>
                      {m.playable ? "플레이 가능" : "규칙 구현 예정"}
                    </small>
                  </h3>
                  <p>{m.summary}</p>
                  {m.modifiers.length > 0 && (
                    <p className="helper">{m.modifiers.join(" · ")}</p>
                  )}
                  {m.fivePlayerTransfer && (
                    <p className="helper">5인: 목표 양도 규칙 적용</p>
                  )}
                </div>
                {!roomId && (
                  <button
                    className="secondary"
                    onClick={() => modalMissionSelect(m.id)}
                  >
                    선택
                  </button>
                )}
              </article>
            ))}
          </div>
        </Modal>
      )}
      {modal === "cards" && (
        <Modal title="탐사 대원 카드 도감 · v3" onClose={() => setModal(null)}>
          <p className="helper">일반 카드 36장 · 로켓 4장 · 공통 뒷면 1종</p>
          <div className="card-catalogue">
            {deck().map((id) => (
              <div key={id}>
                <Card id={id} />
                <span>
                  {SUIT_META[suitOf(id)].name} {rankOf(id)}
                </span>
              </div>
            ))}
            <div>
              <div className="card">
                <img src="/cards/common-back.webp" alt="공통 카드 뒷면" />
              </div>
              <span>공통 뒷면</span>
            </div>
          </div>
        </Modal>
      )}
      {modal === "rules" && (
        <Modal title="우주 탐사를 시작하는 방법" onClose={() => setModal(null)}>
          <div className="rules">
            <p>
              3~5명이 함께 목표를 완수하는 협력 트릭테이킹 게임입니다. 일반
              카드는 네 색의 1~9, 로켓은 1~4입니다.
            </p>
            <h3>1. 각자의 목표를 정해요</h3>
            <p>
              로켓 4를 가진 사령관부터 목표 카드를 하나씩 선택합니다. 내 목표
              카드가 포함된 트릭을 내가 획득해야 합니다. 순서 표시가 있다면 그
              순서도 지켜야 해요.
            </p>
            <h3>2. 선도 색을 따라 한 장씩 내요</h3>
            <p>
              첫 카드의 색을 갖고 있다면 반드시 같은 색을 냅니다. 없다면 다른
              색이나 로켓을 낼 수 있어요. 로켓 중 가장 높은 카드, 로켓이 없다면
              선도 색 중 가장 높은 카드가 트릭을 가져갑니다.
            </p>
            <h3>3. 한 번만 교신할 수 있어요</h3>
            <p>
              임무당 한 번, 트릭 시작 전에 일반 카드 한 장을 공개합니다. 해당 색
              중 가장 높음·가장 낮음·유일함을 정확하게 표시해야 해요. 로켓은
              교신할 수 없습니다. 교신 카드는 손패에 남습니다.
            </p>
            <h3>4. 실패해도 함께 다시 도전해요</h3>
            <p>
              목표 카드를 다른 사람이 가져가거나 순서를 어기면 실패합니다.
              재도전은 같은 미션을 새로 섞어 시작합니다. 랜덤 탐사도 성공한
              뒤에만 새 미션을 추첨합니다.
            </p>
            <p className="helper">
              3인 게임은 14·13·13장으로 나누고 마지막 남은 한 장은 사용하지
              않습니다. 특수 교신·특수 승리 조건은 각 미션 규칙을 따릅니다. 이
              프론트 데모는 미션 1~4의 기본 규칙을 구현합니다.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
