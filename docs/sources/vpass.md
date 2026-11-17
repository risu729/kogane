# Vpass

## 2026-11-10: Daily per-card credit and revolving snapshots

Observed on the owner's machine in the existing authenticated Chrome session,
using only normal card selection and read views. All seven offered cards
returned the same authori (51 fields) and revolving (19 fields) shapes.
No credentials, identifiers, account labels or financial values are recorded
here. This observation did not invoke a collector, deployment or replay.

The existing dropdown `select#vp-view-VC0205-001_RS0051_cardIdentifyKey`
has seven real choices. The member request envelope is
`header{requestHash:number,requestTimestamp:number,corpCode:string}`,
`body{content:object}`. Normal selection POSTs
`/memapi/jaxrs/multicard/operation_card_update/v1` with
`content{cardIdentifyKey:string}`. Reuse the existing selection and stable
card tuple binding; the ordinal or display name is not a new identity.

The available-credit view is `/memx/authori/shokai/index.html`.
Its observed POST sequence, each with `content{}`, is:

1. `/memapi/jaxrs/authori/xt_authori_shokai/v1`.
2. `/memapi/jaxrs/authori/authori_shokai_cvv2_input/v1`.
3. `/memapi/jaxrs/authori/authori_shokai/v1`.

No security code was entered. A response requiring a new interaction remains
unsupported. Successful response headers carry `resultCode`, `resultMessage`,
`transitTo`, `loginFlg` and private `vpSessionBean` material. The latter
must be removed before storage. All seven revolving headers also contain
`siteCatalystSessionBean`; their `vpSessionBean` has
`userName,cardName,corpName,scbcKbn,globalid,externalId,cardCode,preLoginDate`.
Both card name and code are strings and can be checked against the selected
card before redaction. No values are recorded.

`body.content` contains only `AuthoriShokaiDisplayServiceBean`, whose
keys are `authoriShokaiVo` and `authoriShokaiDisplayVo`.
The former has `dataNotFindFlag:boolean`, `shokaiDate:number`
(13-digit epoch milliseconds), and these string fields:

```text
allBalance,allLimit,allLimitInExpansion,allPossible,allReply,allReservation,
authoriEntryFlg,authoriReservationFlg,balanceCodeCs,balanceCodeShopping,
cardBalance,cardLimit,cardLimitInExpansion,cardName,cardPossible,cardReply,
cardReservation,cashingBalance,cashingLimit,cashingOnceBalance,cashingOnceLimit,
cashingOncePossible,cashingOnceReply,cashingPossible,cashingReply,
cashingRevoBalance,cashingRevoBalanceFlg,cashingRevoLimit,cashingRevoPossible,
cashingRevoReply,crevoLimitCode,csLimitCode,customerCsCode,divisionBalance,
divisionLimit,divisionPossible,divisionReply,edificeCode,overseasCashingBalance,
overseasCashingLimit,overseasCashingPossible,overseasCashingReply,
overseasCashingLimitCode,divisionLimitCode,revoBalance,revoLimit,revoPossible,
revoReply,revoLimitCode
```

Monetary strings are integers in **thousands of JPY**, not yen.
For the observed all/card/revo/division triples, raw / 10 equals the displayed
decimal in 万円. Preserve the reported 1,000 JPY precision; multiplying by
1,000 converts the displayed quantity, without establishing exact-yen debt.

The display is one recursive tree with `autoriShokaiDisplayList` arrays.
Nodes carry `mobileTitle,title,balance,limit,possible,hyoujiFlg` strings.
The root, card and cashing nodes additionally have `rowControlCnt` and
`colControlCnt`; other observed nodes omit both.
Both title fields equal one of the following codes:

| Suffix after `00.authori.` | Meaning                               |
| -------------------------- | ------------------------------------- |
| I0010023                   | Overall shared credit (root)          |
| I0010024                   | Selected card                         |
| I0010025                   | Revolving                             |
| I0010027                   | Installment, twice and bonus payments |
| I0010030                   | Cashing                               |
| I0010031                   | Cashing revolving                     |
| I0010028                   | Overseas cashing                      |

Every observed display amount matches `^-?\d+(\.\d+)?$`, with no
commas, units or empty strings. `hyoujiFlg="0"` is visible;
`"1"` is hidden. Hidden numeric zero is unavailable, never a balance
of zero. Desktop/mobile HTML tables duplicate the same data and must not
produce separate publications. Unobserved cashing semantics are not published.

The page says residual balances can include merchant slips not yet received
(except iD), and can differ from statements. Revolving/installment availability
and the overall multiple-card credit are shared. The linked
[official multiple-card FAQ](https://faq-mem.smbc-card.com/--69969baf721b58bfcb274e79)
explains that the highest limit is the overall limit and another card's usage
reduces availability. These metrics are overlapping provider reports:
never sum overall/card/component/available values or derive availability by
subtraction.

The separate exact-yen view is `/memx/revo/index.html#info`, POST
`/memapi/jaxrs/revo/xt_revo_shokai/v1`, `content{}`.
`body.content` contains `CustomizedRevoShokaiAnsPcDisplayServiceBean`,
`Condition.RiyouHouhouMsg.value:string` and
`ContextRootServiceBean.contextRootInfo:{}`. The 19 bean fields are:

- Numbers: `revoLimit,revoMonthlyKingaku,revoBonusMonth1,revoBonusKingaku1,
  revoBonusMonth2,revoBonusKingaku2,revoMonthlyKinFlag,totalLimit`.
- Strings: `chengeCourseExplanation,revoZan,revoFeeRate,courseName,userName,
  cardName,revoAnnaiCode,hensaiAmount,courseExplanation,revoPayCoursePtn,
  revoPaymentCode`.

`revoZan` and `hensaiAmount` are signed ASCII integer strings
(`+` was observed); the UI explicitly labels their values 円.
Only these two fields establish exact reported yen values. `revoLimit`
is displayed in 万円; its raw scale is not inferred or published here.

The existing `web_meisai_top/v1` statement response lacks these available
credit/outstanding fields, but does contain credit-limit/revolving advisory
fields in `webMeisaiTopK3Vo`: `revoOvly,limitOvly,limitWord:string[8],
limitIncreaseMsg,revoFl:number,limitCnt:number,limitList:string[2][9],revoWaku,
callLimitMsgFlg:number`. Its masked limit advisory is retained; this work does not
claim that statements contain no limit information. It does not duplicate
V Point collection.

Exact installment debt finer than 1,000 JPY was not observed. The catalogue
therefore keeps Vpass balance coverage partial under #1256. No bank balance,
canonical liability, asset total or financial action is established by these
snapshots.

## 2026-11-12: The normal Authori module transition

A normal reload of the existing authenticated Authori read view rendered its
available-credit heading, logout control and table. No login, credential,
security-code or financial action was entered. The final Authori API response
was HTTP 200 JSON, with a successful result code, true `loginFlg` and the
expected `AuthoriShokaiDisplayServiceBean` content. Its `transitTo` was the
normal public module identity, not an empty string.

The view's loaded public `/memx/authori/shokai/js/widget/info.js` declares
`vp.member.pages.info` and initializes with `WebApiConst.API.VC0403001_RS0003`.
The loaded `/app/memx/js/widget/WebApiConst.js` maps that constant to
`/memapi/jaxrs/authori/authori_shokai/v1`. The view's `js/main.js` accepts the
`info` hash and initially loads the dummy widget, whose initial calls match
the sequence above. An in-memory comparison of the final successful response's
transition against that exact public module returned true. No raw transition,
body, session value, identifier or financial value was retained.

Read-only operational metadata found Authori parser rejections alongside
successful revolving publication from the first scheduled credit captures.
A bounded server-side projection of one previously failed stored Authori
artifact returned only closed codes, booleans, known key names/types and
counts. It matched the same public module, successful result code and true
login flag. The 1.0.1 parser's first failure was its empty-only transition
guard. Excluding that guard only for diagnosis left that artifact's existing
content/type/display comparisons satisfied. This identifies one actual stored
failure; it does not prove the inner reason of every other failed artifact.

Reader 1.0.2 accepts exactly the empty transition or `vp.member.pages.info`
for `credit/authori.json`. The empty transition remains supported for prior
accepted captures. `credit/revo.json` remains empty-only. Unknown transitions,
false login flags, unsuccessful result codes and malformed financial content
remain rejected. This compatibility correction adds no new financial meaning,
precision or provider-data catalogue coverage. Production publication after
release remains a separate verification step.
