import type { CharacterId } from "./contracts.ts";

export const CHARACTERS: { id: CharacterId; name: string; description: string }[] = [
  { id: "otter", name: "수달", description: "조개를 수집하는 강의 탐험가" },
  { id: "gary", name: "게리", description: "핑핑이 · 별 사이를 유영하는 달팽이" },
  { id: "moby-dick", name: "모비딕", description: "푸른 행성을 여행하는 흰 고래" },
  { id: "spongebob", name: "스폰지밥", description: "별을 향해 인사하는 명랑한 대원" },
  { id: "green-dino", name: "요시", description: "초록빛 우주복을 입은 명랑한 공룡 탐험가" },
  { id: "coral", name: "코랄", description: "산호초 행성에서 온 작은 정원사" },
  { id: "komodo", name: "코모도", description: "화산 달의 암석을 조사하는 도마뱀" },
  { id: "hangyodon", name: "한교동", description: "바다 천문대의 별 지도 연구원" },
  { id: "pingu", name: "핑구", description: "얼음 위성의 씩씩한 펭귄" },
  { id: "ilu", name: "일루", description: "빛나는 바다를 누비는 탐사 동료" },
  { id: "snow", name: "콜드", description: "얼음 위성에서 결정을 조사하는 눈 대원" },
  { id: "tamama", name: "타마마", description: "달 기지의 호기심 많은 대원" },
  { id: "sun", name: "태양", description: "탐사선의 아침을 밝히는 햇살" },
  { id: "tree", name: "트리", description: "우주 온실에서 새싹을 돌보는 대원" },
  { id: "bay", name: "베이", description: "작은 해안을 품은 바다 친구" },
];
export function characterFor(id?: CharacterId) {
  return CHARACTERS.find((character) => character.id === id) ?? CHARACTERS[0];
}
export const characterImage = (id?: CharacterId) => `/characters/${characterFor(id).id === "snow" ? "cold-v2" : characterFor(id).id}.webp`;
