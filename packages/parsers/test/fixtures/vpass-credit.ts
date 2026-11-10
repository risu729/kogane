// Synthetic response shapes only. No owner values or identifiers.
const authoriFields = "allBalance,allLimit,allLimitInExpansion,allPossible,allReply,allReservation,authoriEntryFlg,authoriReservationFlg,balanceCodeCs,balanceCodeShopping,cardBalance,cardLimit,cardLimitInExpansion,cardName,cardPossible,cardReply,cardReservation,cashingBalance,cashingLimit,cashingOnceBalance,cashingOnceLimit,cashingOncePossible,cashingOnceReply,cashingPossible,cashingReply,cashingRevoBalance,cashingRevoBalanceFlg,cashingRevoLimit,cashingRevoPossible,cashingRevoReply,crevoLimitCode,csLimitCode,customerCsCode,divisionBalance,divisionLimit,divisionPossible,divisionReply,edificeCode,overseasCashingBalance,overseasCashingLimit,overseasCashingPossible,overseasCashingReply,overseasCashingLimitCode,divisionLimitCode,revoBalance,revoLimit,revoPossible,revoReply,revoLimitCode".split(",");
export function envelope<T extends Record<string, unknown>>(content: T, card = 1) {
  return { header: { resultCode: 0, resultMessage: "", transitTo: "", loginFlg: true, siteCatalystSessionBean: {}, vpSessionBean: { externalId: String(card).repeat(32), globalid: "g".repeat(32), cardCode: String(card).repeat(13), cardName: `Synthetic card ${card}` } }, body: { content } };
}
export function authori(outstanding = "123") {
  const vo: Record<string, unknown> = Object.fromEntries(authoriFields.map((field) => [field, "0"]));
  Object.assign(vo, { dataNotFindFlag: false, shokaiDate: Date.parse("2099-01-01T10:00:00Z"), cardName: "Synthetic card" });
  for (const prefix of ["all", "card", "revo", "division"]) Object.assign(vo, { [`${prefix}Limit`]: "700", [`${prefix}Balance`]: outstanding, [`${prefix}Possible`]: "555" });
  const display = ["00.authori.I0010023", "00.authori.I0010024", "00.authori.I0010025", "00.authori.I0010027", "00.authori.I0010030", "00.authori.I0010031", "00.authori.I0010028"].map((title, i) => ({
    mobileTitle: title, title, balance: i < 4 ? (Number(outstanding) / 10).toFixed(1) : "0", limit: i < 4 ? "70.0" : "0", possible: i < 4 ? "55.5" : "0", hyoujiFlg: i < 4 ? "0" : "1",
  }));
  return envelope({ AuthoriShokaiDisplayServiceBean: { authoriShokaiVo: vo, authoriShokaiDisplayVo: { ...display[0]!, rowControlCnt: "3", colControlCnt: "3", autoriShokaiDisplayList: display.slice(1) } } });
}
export function revo(outstanding = "+123456") {
  return envelope({ CustomizedRevoShokaiAnsPcDisplayServiceBean: {
    chengeCourseExplanation: "", revoLimit: 70, revoZan: outstanding, revoFeeRate: "0", courseName: "Synthetic course", revoMonthlyKingaku: 10000, revoBonusMonth1: 0, revoBonusKingaku1: 0, revoBonusMonth2: 0, revoBonusKingaku2: 0,
    userName: "Synthetic person", cardName: "Synthetic card", revoMonthlyKinFlag: 0, revoAnnaiCode: "0", totalLimit: 70, hensaiAmount: "+10000", courseExplanation: "", revoPayCoursePtn: "0", revoPaymentCode: "0",
  }, Condition: { RiyouHouhouMsg: { value: "" } }, ContextRootServiceBean: { contextRootInfo: {} } });
}
