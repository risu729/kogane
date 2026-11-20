// The per-card view's cards added back together (ADR 0125), independently of
// the reader: each card's decimal text is parsed and added exactly in the
// domain (INV03), so a purchase counted under two cards, or left out of
// every card, shows as a difference from the answer's own totals (INV06).
// Synthetic stores only.
import type {
  CardPurchaseCardFigures,
  CardPurchaseCardsPage,
} from "../../domain/src/card-purchase-view.ts";
import { decimalLiteral, decimalToString, sumDecimals } from "../../domain/src/values.ts";

const FIGURES = ["captured", "authorized", "capturedRefunds", "authorizedRefunds"] as const;

/** Every listed card's figures, events and unresolved counts, added per unit and figure. */
export function cardsAddedUp(answer: CardPurchaseCardsPage): {
  totals: CardPurchaseCardFigures[];
  events: number;
  unresolved: number;
} {
  const units = [
    ...new Set(answer.cards.flatMap((card) => card.figures.map((figure) => figure.unit))),
  ].sort();
  return {
    totals: units.map((unit) => {
      const of = answer.cards.flatMap((card) => card.figures.filter((f) => f.unit === unit));
      const sum = (name: (typeof FIGURES)[number]) =>
        decimalToString(sumDecimals(of.map((figure) => decimalLiteral(figure[name]))));
      return {
        unit,
        captured: sum("captured"),
        authorized: sum("authorized"),
        capturedRefunds: sum("capturedRefunds"),
        authorizedRefunds: sum("authorizedRefunds"),
      };
    }),
    events: answer.cards.reduce((total, card) => total + card.events, 0),
    unresolved: answer.cards.reduce((total, card) => total + card.unresolved, 0),
  };
}
