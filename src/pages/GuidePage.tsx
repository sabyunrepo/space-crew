import { useEffect, useRef, useState, type JSX } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Radio,
  Rocket,
  ShieldCheck,
  X,
} from "lucide-react";
import type { CardId } from "../../shared/contracts.ts";
import { cardImage, cardLabel, SUIT_META, SUITS } from "../../shared/cards.ts";
import missions from "../../shared/missions.json";
import { winner } from "../game/engine.ts";
import "./guide.css";
import { ThemePicker } from "../components/ThemePicker.tsx";

const SECTIONS: { id: string; label: string }[] = [
  { id: "overview", label: "한눈에 보기" },
  { id: "goal", label: "목표" },
  { id: "cards", label: "카드 구성" },
  { id: "commander", label: "지휘관과 첫 트릭" },
  { id: "tricks", label: "트릭 규칙" },
  { id: "tasks", label: "임무 카드 고르기" },
  { id: "communication", label: "교신" },
  { id: "result", label: "성공·실패" },
  { id: "how-to-play", label: "이 사이트에서 하는 법" },
  { id: "missions", label: "미션 1~50 요약" },
];

type TrickExamplePlay = { playerId: string; label: string; cardId: CardId };

function TrickExample({
  title,
  note,
  plays,
}: {
  title: string;
  note: string;
  plays: TrickExamplePlay[];
}) {
  const winnerId = winner(plays);
  const winnerLabel = plays.find((p) => p.playerId === winnerId)!.label;
  return (
    <figure className="trick-example">
      <figcaption>{title}</figcaption>
      <div className="trick-example-row">
        {plays.map((play, index) => {
          const isWinner = play.playerId === winnerId;
          return (
            <div
              key={play.playerId}
              className={
                "trick-example-play" + (isWinner ? " trick-example-play--win" : "")
              }
            >
              {index === 0 && <span className="lead-badge">선도</span>}
              <img
                src={cardImage(play.cardId)}
                alt={cardLabel(play.cardId)}
                loading="lazy"
              />
              <span className="trick-example-seat">{play.label}</span>
            </div>
          );
        })}
      </div>
      <p className="trick-example-note">
        {note} · <strong>승자: {winnerLabel}</strong>
      </p>
    </figure>
  );
}

function CardSuitRow({ suit }: { suit: (typeof SUITS)[number] }) {
  const meta = SUIT_META[suit];
  const count = suit === "rocket" ? 4 : 9;
  const ids = Array.from(
    { length: count },
    (_, i) => `${suit}-${i + 1}` as CardId,
  );
  return (
    <div className="card-suit-row">
      <div className="card-suit-row-head">
        <span
          className="card-suit-swatch"
          style={{ background: meta.hex }}
          aria-hidden
        />
        <span>
          {meta.color} · {meta.name} ({count}장)
        </span>
      </div>
      <div className="card-suit-row-cards">
        {ids.map((id) => (
          <img key={id} src={cardImage(id)} alt={cardLabel(id)} loading="lazy" />
        ))}
      </div>
    </div>
  );
}

export function GuidePage(props: { onBack: () => void }): JSX.Element {
  const [tocOpen, setTocOpen] = useState(false);
  const [active, setActive] = useState("overview");
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const targets = SECTIONS.map((s) =>
      document.getElementById(s.id),
    ).filter((el): el is HTMLElement => el !== null);
    if (!targets.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -70% 0px", threshold: 0 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const playableMissions = missions;

  return (
    <div className="guide-page">
      <header className="guide-topbar">
        <button className="text-button" onClick={props.onBack}>
          <ArrowLeft size={15} />
          탐사 허브
        </button>
        <div className="guide-title">
          <BookOpen size={16} />
          게임 방법
        </div>
        <div className="guide-tools"><ThemePicker />
        <button
          className="guide-toc-toggle"
          aria-expanded={tocOpen}
          aria-controls="guide-toc"
          onClick={() => setTocOpen((v) => !v)}
        >
          {tocOpen ? <X size={15} /> : <ChevronRight size={15} />}
          목차
        </button></div>
      </header>
      <div className="guide-body">
        <nav
          id="guide-toc"
          className={"guide-toc" + (tocOpen ? " guide-toc--open" : "")}
          aria-label="게임 방법 목차"
        >
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={active === section.id ? "active" : ""}
                  onClick={() => setTocOpen(false)}
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main className="guide-content" ref={contentRef}>
          <section id="overview">
            <h2>1. 한눈에 보기</h2>
            <ul className="guide-summary">
              <li>3~5명이 팀으로 협력해 미션을 함께 완수하는 카드 게임입니다.</li>
              <li>
                손패는 나에게만 보이며, 카드를 낼 때는 정해진 규칙(색 따르기)을
                반드시 따라야 합니다.
              </li>
              <li>
                각자 맡은 목표 카드가 포함된 트릭을 정확히 그 담당자가 가져와야
                미션이 성공합니다.
              </li>
            </ul>
          </section>

          <section id="goal">
            <h2>2. 목표</h2>
            <p>
              이 게임은 개인전이 아니라 팀 전체가 함께 이기고 함께 지는 협력
              게임입니다. 미션이 시작되면 목표 카드 몇 장이 공개되고, 대원들이
              차례로 하나씩 나누어 담당합니다.
            </p>
            <p>
              담당한 목표 카드가 포함된 트릭은 반드시 그 담당자 본인이
              획득해야 합니다. 다른 대원이 그 트릭을 가져가면 그 자리에서 바로
              미션이 실패합니다. 일부 미션은 목표를 정해진 순서대로 획득해야
              하는 조건이 추가로 붙습니다.
            </p>
          </section>

          <section id="cards">
            <h2>3. 카드 구성</h2>
            <p>
              카드는 총 40장입니다. 네 가지 색 카드가 각각 1~9로 36장, 그리고
              색이 없는 로켓 카드가 1~4로 4장입니다. 로켓은 항상 가장 강한
              카드로 취급됩니다.
            </p>
            <div className="card-suit-list">
              {SUITS.map((suit) => (
                <CardSuitRow key={suit} suit={suit} />
              ))}
            </div>
          </section>

          <section id="commander">
            <h2>4. 지휘관과 첫 트릭</h2>
            <p>
              <Rocket size={14} className="inline-icon" /> 로켓 4를 받은
              대원이 이번 미션의 지휘관이 됩니다. 지휘관은 목표 카드를 나눌 때
              가장 먼저 고르고, 미션의 첫 트릭도 가장 먼저 냅니다. 게임 테이블
              화면에서는 지휘관에게 별 배지가 붙어 누구인지 바로 알 수
              있습니다.
            </p>
          </section>

          <section id="tricks">
            <h2>5. 트릭 규칙</h2>
            <ol>
              <li>
                <strong>색 따르기</strong> — 맨 처음 낸 카드(선도 카드)와 같은
                색을 손에 갖고 있다면 반드시 그 색을 내야 합니다. 없다면 다른
                색이나 로켓을 자유롭게 낼 수 있습니다.
              </li>
              <li>
                <strong>로켓 우선</strong> — 로켓이 한 장이라도 나왔다면 색과
                상관없이 로켓이 무조건 트릭을 가져갑니다. 로켓끼리 겹치면
                숫자가 더 큰 로켓이 이깁니다.
              </li>
              <li>
                <strong>승자 결정</strong> — 로켓이 없다면 선도 색 카드 중
                가장 큰 숫자를 낸 대원이 이깁니다. 선도 색이 아닌 카드는
                숫자가 아무리 커도 이길 수 없습니다.
              </li>
              <li>트릭을 가져간 대원이 다음 트릭을 가장 먼저 냅니다.</li>
            </ol>
            <div className="trick-examples">
              <TrickExample
                title="예시 1 · 색 따르기"
                note="선도는 파랑. 초록 카드를 낸 대원은 파랑이 없어 다른 색을 냈지만, 선도 색이 아니므로 이길 수 없어요."
                plays={[
                  { playerId: "A", label: "대원 A (선도)", cardId: "blue-3" },
                  { playerId: "B", label: "대원 B", cardId: "blue-7" },
                  { playerId: "C", label: "대원 C", cardId: "green-2" },
                  { playerId: "D", label: "대원 D", cardId: "blue-5" },
                ]}
              />
              <TrickExample
                title="예시 2 · 로켓이 이기는 예"
                note="선도는 초록이지만 로켓이 나왔으므로 초록 9는 이길 수 없고, 로켓끼리는 숫자가 큰 쪽이 이겨요."
                plays={[
                  { playerId: "A", label: "대원 A (선도)", cardId: "green-6" },
                  { playerId: "B", label: "대원 B", cardId: "rocket-1" },
                  { playerId: "C", label: "대원 C", cardId: "green-9" },
                  { playerId: "D", label: "대원 D", cardId: "rocket-3" },
                ]}
              />
              <TrickExample
                title="예시 3 · 같은 색 최고 숫자"
                note="로켓 없이 전원이 노랑을 냈다면, 노랑 중 가장 큰 숫자가 이겨요."
                plays={[
                  { playerId: "A", label: "대원 A (선도)", cardId: "yellow-4" },
                  { playerId: "B", label: "대원 B", cardId: "yellow-8" },
                  { playerId: "C", label: "대원 C", cardId: "yellow-2" },
                  { playerId: "D", label: "대원 D", cardId: "yellow-6" },
                ]}
              />
            </div>
          </section>

          <section id="tasks">
            <h2>6. 임무 카드 고르기</h2>
            <p>
              미션이 정해지면 그 미션이 요구하는 수만큼 목표 카드가 공개됩니다.
              지휘관부터 시작해 자리 순서대로 돌아가며 목표를 하나씩 골라
              담당자를 정하고, 모든 목표에 담당자가 정해지면 준비 절차에 따라 첫 트릭을
              시작합니다. 지휘관 결정 미션은 목표를 숨긴 채 응답하고,
              지휘관 분배 미션은 한 장씩 공개해 배정합니다.
            </p>
            <p>
              순서 토큰이 붙은 미션(예: 미션 3)은 목표마다 완수해야 하는
              순서(1번, 2번…)가 정해져 있습니다. 더 늦은 순서의 목표를 먼저
              획득하면, 남은 앞 순서 목표가 아직 완료되지 않은 상태이므로 그
              즉시 미션이 실패합니다.
            </p>
            <p>숫자는 전체 목표의 절대 완료 순서, &lt;·&lt;&lt;·&lt;&lt;&lt;는 해당 토큰끼리의 상대 순서입니다. Ω는 마지막 목표입니다. 48번에서는 Ω 목표를 마지막 트릭에 획득해야 합니다.</p>
            <p>5인 양도 표시가 있는 미션은 배정 후 목표 한 장을 다른 대원에게 넘길 수 있습니다. 토큰은 목표와 함께 이동합니다.</p>
          </section>

          <section id="communication">
            <h2>
              <Radio size={16} className="inline-icon" /> 7. 교신
            </h2>
            <p>
              이 웹 버전은 내 차례가 아니거나 다른 대원이 이미 카드를 낸 뒤에도
              교신할 수 있습니다. 카드 제출 순서는 바뀌지 않으며, 대원마다 한 시도에
              한 번만 사용할 수 있습니다. 미션별 교신 금지·시작 트릭 제한은 유지됩니다.
              이는 사용자 요청으로 적용한 교신 타이밍 변형이며, 이전 버전에서 시작한
              진행 중인 시도는 재도전부터 적용됩니다.
            </p>
            <p>
              손패에서 카드를 한 장 골라 공개하면서, 그 카드가 속한 색 안에서
              "이 색 중 가장 높다" · "가장 낮다" · "이 색은 이 카드
              하나뿐이다" 중 사실과 맞는 표시 하나만 붙일 수 있습니다. 그
              색에서 가장 높지도 낮지도, 유일하지도 않은 중간 카드는 교신에
              쓸 수 없습니다. 로켓 카드도 교신 대상이 될 수 없습니다.
            </p>
            <p>
              공개한 카드는 즉시 내는 것이 아니라 그대로 손에 남고, 나중에
              직접 내야 합니다. 한 번 붙인 표시는 공개한 순간의 손패를
              기준으로 고정되며, 이후 카드를 내며 손패가 바뀌어도 다시
              갱신되지 않습니다.
            </p>
            <p>정보 축소 교신(D)은 같은 교신 가능 조건을 지키면서 최고·최저·유일 여부를 숨깁니다. 카드 옆의 뒤집힌 토큰으로 표시하며 ‘유일한 카드’라는 뜻이 아닙니다. C2·C3은 각각 두 번째·세 번째 트릭부터 교신할 수 있다는 뜻입니다. 11번은 지정된 대원 한 명만 교신할 수 없습니다.</p>
          </section>

          <section id="result">
            <h2>
              <ShieldCheck size={16} className="inline-icon" /> 8. 성공·실패
            </h2>
            <p>
              목표 카드 미션은 담당자와 순서 조건을 함께 지켜야 합니다.
              목표가 없는 미션은 특정 카드로 승리하기, 승수 균형, 지정 대원의
              첫·마지막 트릭 등 화면에 표시된 특수 조건을 달성해야 합니다.
            </p>
            <p>
              목표 카드를 담당자가 아닌 다른 대원이 가져가거나, 정해진 순서를
              어기면 그 트릭이 끝나는 순간 바로 미션이 실패합니다. 담당자를
              모두 정했는데도 아직 완료하지 못한 목표가 남은 채로 낼 카드가
              바닥나도 실패로 처리됩니다. 실패해도 손패를 새로 섞어 같은
              미션을 몇 번이든 다시 도전할 수 있습니다.
            </p>
          </section>

          <section id="how-to-play">
            <h2>9. 이 사이트에서 하는 법</h2>
            <ol className="how-to-play-steps">
              <li>탐사 허브에서 "새 탐사 만들기"로 방을 만듭니다.</li>
              <li>초대 링크를 함께할 대원들에게 공유합니다.</li>
              <li>전원이 자리에 들어와 "준비 완료"를 누릅니다.</li>
              <li>방장이 미션을 시작하면 브리핑 화면에서 조건을 확인합니다.</li>
              <li>미션에 따라 상태 질문에 응답하거나 담당자·목표를 정합니다. 준비 상태는 새로고침해도 유지됩니다.</li>
              <li>브리핑에서 방장이 구조 신호를 제안하면 전원 동의 후 같은 방향으로 일반 카드 한 장씩 교환할 수 있습니다.</li>
              <li>
                트릭과 트릭 사이(아직 아무도 카드를 내지 않았을 때) 원한다면
                교신을 한 번 사용합니다(선택 사항이며 건너뛸 수 있습니다).
              </li>
              <li>자기 차례에 손패에서 카드를 골라 냅니다.</li>
            </ol>
            <p className="helper">
              회색으로 흐려진 카드는 지금 규칙상 낼 수 없는 카드라는
              뜻입니다. 카드를 눌러 보면 이유가 나옵니다. 내 차례가 아닐
              때는 카드를 아예 고를 수 없습니다. 페이지를 새로고침해도 같은
              자리와 손패로 돌아옵니다.
            </p>
          </section>

          <section id="missions">
            <h2>10. 미션 1~50 요약</h2>
            <p className="helper">
              50개 미션의 목표 수와 특수 조건입니다. 방을 만들 때 원하는 번호부터
              시작하거나 랜덤으로 선택할 수 있습니다.
            </p>
            <ul className="mission-summary-list">
              {playableMissions.map((mission) => (
                <li key={mission.id}>
                  <strong>
                    미션 {mission.id} · {mission.title}
                  </strong>
                  <span>
                    목표 {mission.taskCount}개
                    {mission.taskCount === 0 ? " · 특수 조건 미션" : ""}
                    {mission.modifiers.length
                      ? ` · ${mission.modifiers.join(", ")}`
                      : " · 특수 조건 없음"}
                  </span>
                  <p>{mission.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
