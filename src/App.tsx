import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  ChevronRight,
  Globe2,
  Radio,
  Rocket,
  Shuffle,
  Users,
  X,
  BookOpen,
  RotateCcw,
  Orbit,
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
import { makeService } from "./services/index.ts";
import { GameTable } from "./components/table/GameTable.tsx";
import { GuidePage } from "./pages/GuidePage.tsx";
/** service.mode는 향후 "server"도 값으로 가질 수 있어 문자열 비교로 안전하게 처리한다. */
function modeLabel(mode: string | undefined) {
  if (mode === "mock") return "LOCAL DEMO";
  if (mode === "supabase") return "SUPABASE";
  if (mode === "server") return "실시간 서버";
  return "연결 안 됨";
}
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
  const [modal, setModal] = useState<"missions" | "cards" | null>(null);
  const guideReturnPath = useRef("/");
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
  // 로비·브리핑·탐사 완료는 문서형 스크롤을 허용하고, 실제 진행 단계만
  // 100dvh 안에서 페이지 스크롤 없이 조작 가능해야 한다.
  const fixedLayout = !!(
    snapshot &&
    ["task_selection", "playing", "trick_result", "success", "failure"].includes(
      snapshot.phase,
    )
  );
  if (path === "/guide")
    return (
      <GuidePage
        onBack={() =>
          navigate(guideReturnPath.current === "/guide" ? "/" : guideReturnPath.current)
        }
      />
    );
  return (
    <div className={`app-shell ${fixedLayout ? "gameplay-fixed" : ""}`}>
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
          <button
            onClick={() => {
              guideReturnPath.current = path;
              navigate("/guide");
            }}
          >
            <BookOpen size={16} />
            <span>플레이 가이드</span>
          </button>
          <button onClick={() => setModal("cards")}>카드 도감</button>
          <span className="mode-tag">
            <i />
            {modeLabel(service?.mode)}
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
          <GameTable
            snapshot={snapshot}
            mine={mine}
            isHost={isHost}
            currentMission={currentMission}
            catalogue={catalogue}
            locked={locked}
            connection={connection}
            serviceMode={service!.mode}
            selected={selected}
            setSelected={setSelected}
            onBack={() => navigate("/")}
            onCopyInvite={() => void copyInvite()}
            onSend={(command) => void send(command)}
            onFillDemoCrew={
              service?.fillDemoCrew &&
              snapshot.players.length < snapshot.settings.capacity
                ? () =>
                    void run(async () =>
                      accept(await service.fillDemoCrew!(roomId)),
                    )
                : undefined
            }
            onDemoStep={
              service?.demoStep
                ? () =>
                    void run(async () =>
                      accept(await service.demoStep!(roomId)),
                    )
                : undefined
            }
          />
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
    </div>
  );
}
