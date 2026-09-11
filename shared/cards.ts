import type { CardId } from "./contracts.ts";
export const SUITS = ["blue", "green", "yellow", "black", "rocket"] as const;
export type Suit = (typeof SUITS)[number];
export const SUIT_META = {
  blue: {
    name: "한교동",
    color: "파랑",
    icon: "◆",
    file: "blue-hangyodon",
    hex: "#57b9ef",
  },
  green: {
    name: "코모도",
    color: "초록",
    icon: "♣",
    file: "green-komodo",
    hex: "#7bddb0",
  },
  yellow: {
    name: "스폰지밥",
    color: "노랑",
    icon: "☀",
    file: "yellow-spongebob",
    hex: "#f2d17b",
  },
  black: {
    name: "타마마",
    color: "검정",
    icon: "☾",
    file: "black-tamama",
    hex: "#c2badb",
  },
  rocket: {
    name: "로켓",
    color: "흰색",
    icon: "↑",
    file: "white-rocket",
    hex: "#f2f1ed",
  },
};
export const suitOf = (id: CardId) => id.split("-")[0] as Suit;
export const rankOf = (id: CardId) => Number(id.split("-")[1]);
export const cardImage = (id: CardId) =>
  `/cards/${SUIT_META[suitOf(id)].file}-${rankOf(id)}.webp`;
export const cardLabel = (id: CardId) =>
  `${SUIT_META[suitOf(id)].color} ${rankOf(id)} · ${SUIT_META[suitOf(id)].name}`;
export const deck = (): CardId[] =>
  SUITS.flatMap((suit) =>
    Array.from(
      { length: suit === "rocket" ? 4 : 9 },
      (_, i) => `${suit}-${i + 1}`,
    ),
  );
export const sortCards = (cards: CardId[]) =>
  [...cards].sort(
    (a, b) =>
      SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)) ||
      rankOf(a) - rankOf(b),
  );
