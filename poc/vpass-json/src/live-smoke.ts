import { isCancel, password as promptSecret } from "@clack/prompts";
import { VpassClient } from "./vpass-client";

async function requiredSecret(message: string): Promise<string> {
  const value = await promptSecret({
    message,
    validate: (candidate) => (candidate ? undefined : "A value is required"),
  });
  if (isCancel(value)) throw new Error("Cancelled");
  return value;
}

let userId = await requiredSecret("Vpass ID (masked)");
let userPassword = await requiredSecret("Vpass password (masked)");
const client = new VpassClient();

try {
  await client.login(userId, userPassword);
} finally {
  userId = "";
  userPassword = "";
}

const { cards } = await client.listCards();
const summaries: Array<{
  cardIndex: number;
  availableMonthCount: number;
  sampleMonth: string;
  responseFamily: string;
  pageCount: number;
  transactionCount: number;
}> = [];

for (const [index, card] of cards.entries()) {
  await client.selectCard(card.value);
  const { months } = await client.listAvailableMonths();
  const sampleMonth = months[0];
  if (!sampleMonth) throw new Error(`Card ${index + 1} returned no statement month`);
  const statement = await client.fetchStatementMonth(sampleMonth);
  summaries.push({
    cardIndex: index + 1,
    availableMonthCount: months.length,
    sampleMonth,
    responseFamily: statement.kind,
    pageCount: statement.pages.length,
    transactionCount: statement.transactionCount,
  });
}

console.log(
  JSON.stringify(
    {
      authenticated: true,
      cardCount: cards.length,
      cards: summaries,
    },
    null,
    2,
  ),
);
