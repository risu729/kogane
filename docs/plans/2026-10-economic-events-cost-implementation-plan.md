# Kogane: 経済イベント・指定日保有・取得原価・損益の実装準備

- Status: **proposed** — ローカル調査と実装計画。設計の承認、実装済み・本番検証済みの主張ではない。
- Written: 2026-10-10 (Asia/Tokyo)。対象: #549 → #550 → #556 → #557。
- Research baseline (historical): `c8c021d6b127e45887816a26379dd1b3c9357ab9`。調査時のmainを固定した証拠であり、公開時の最新mainではない。
- Publication review baseline: `f761630da082d879b331402127d898948792daf1` (2026-10-10 Asia/Tokyo)。GitHub mainを取得し、研究baselineからの差分を照合した。文書のみのDraft PRとして保存し、実装・金融policy採用・merge・deployは行わない。
- 第2節のコード・行番号と第9節の既存test結果は [研究時の固定commit](https://github.com/risu729/kogane/tree/c8c021d6b127e45887816a26379dd1b3c9357ab9) に属する。公開前照合は第9節に別記。ファイル名はリポジトリ相対で、本書の利用に調査担当のlocal checkoutや未公開メモは不要。
- 制約: 公開コード・既存文書・合成fixtureのみ。研究では本番照会、原本金融データ、login、収集、APIキー、外部有料source、新provider選定、口座紐付け、金融adoption、push/PR/merge/deployを行っていない。今回承認されたremote保存は本計画の文書専用Draft PRと既存Issueへのリンクのみ。税計算と現行税法の判断は対象外。

## 1. 結論と、次回最初に着手するもの

計算エンジンの作り直しから始めない。`computeLots`、選択済みrevisionのlot adapter、knowledge selector、cash再構成queryは既に存在する。主要な未接続箇所は、証拠のadmission、writer、時点別identityを消費する契約、保有数量のfold、coverage、transport/reportである。

**最初の小さなvertical slice S0は、明示指定したtransaction観測の「イベント生成readiness」を返すread-only query。** published observation → account mapping/ownership → row identity → claim競合 → 理由付き結果・manifestまでをつなぐ。policyを選ばず、proposal・event・claimを書かず、既存writerの有効化も行わない。これを後続plannerのprovenance checkとcommit guardの共通根拠にする。

理由: 国内・外国証券履歴は現行registryではfingerprint由来で、ownerが確認してもprovider-issued IDとしてadmitできない。現在は証券writerを追加するだけではlotへ届かない。一方、銀行移動はproposal/plannerがあるが、publicationとaccount mappingの再確認が欠ける。S0なら、これらの阻害要因を現行データモデルで検証可能にし、本人の金融方針決定を待たずに実装できる。

S0は#549の完了ではない。最初の**金融イベント生成**sliceは、S0の証拠条件・ownerの明示policy・稼働gateが成立した後の、同一通貨・本人の預金口座2つの移動（S2）。証券取得/処分、移転原価、P&Lは別sliceとする。

## 2. 今ある機能と未接続部分

| 領域                     | 現在の実装と実コード根拠                                                                                                                                                                      | 未接続・実際の限界                                                                                                                                                                                                                                                         | 既存の合成テスト根拠                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| family/row identity      | `packages/domain/src/event-families.ts` のregistry、`row-identity.ts:47,107` の `rowOriginBasis` / `humanAdoptedRowIdentity`                                                                  | familyの列挙はwriterの実装ではない。fingerprint・digest・origin未記録・resolver欠落をrefuse。名前・同額・日付一致からadoptionしない                                                                                                                                        | `event-families.test.ts`, `row-identity.test.ts`                                                                           |
| securities observations  | `packages/parsers/src/parsers/sbi-domestic-trade-records.ts:94–102` が日付と `externalIdOrigin: collector-fingerprint` を保持。`event-families.ts:364–403` は国内・外国executionをunsupported | quantity/方向/fee込みsettlementの意味、stable execution identity、訂正参照がwriterに接続されていない。positionsはsnapshot claimでありexecutionではない                                                                                                                     | parser各test、registry/identity tests                                                                                      |
| 共通消費guard            | CORE0070、`packages/storage-d1/src/atomic/economic-commit.ts` の `receiptEntry`, `economicClaimWrite`, `eventTimeWrite`, `legEffectWrite`, `revisionSealWrite`, `commitLogWrite`              | common guardは任意のfamilyをadmitする権限ではない。0070:323–326がsecurity-quantity claimを無条件拒否                                                                                                                                                                       | `economic-commit-guard.test.ts`, `economic-card-purchase-lane.test.ts`, processor `economic-card-settlement.test.ts`       |
| own-transfer proposals   | `proposeOwnTransfers` (`own-transfer-proposals.ts:461`)、CORE0072、`ownTransferProposalWrite` / retirement builder                                                                            | supplied ownership・versioned policyが必要。proposal lane・owner採用policyは存在しない。proposalはadoptionではない                                                                                                                                                         | `own-transfer-proposals.test.ts`, storage proposal tests                                                                   |
| own-transfer commands    | `OWN_TRANSFER_PLANNERS` (`operations/own-transfer-plan.ts:651`) はadopt/correct/withdraw/moveを持つ                                                                                           | `targets.ts:140` の `ECONOMIC_EVENT_PLANNERS={}`。`services/processor/src/change-commands.ts:118` の `economicEventMutation` はnull。plan/simulate/approve/commitの全経路がunsupported。`rederive:197` はproposal側accountを渡し、現在mapping・published parseを再読しない | `own-transfer-plan.test.ts`, `economic-event-plan.test.ts`, command tests                                                  |
| event kind / selector    | `events.ts:52–91`、`selectAdopted` と `loadSelectorRows` (`read-model/economic-selector.ts:317`) はcommit-log cutでrevision選択                                                               | trade/corporate_action、executed/settledは保存vocabularyにない。`knowledge-selector.ts:1360` もsecurity bookをunsupported。現在pin比較 `1512–1525` はcurrent identityを基準にする                                                                                          | `knowledge-selector.test.ts`, economic-selector read tests                                                                 |
| 指定日cash再構成         | `queryReconstructedState` (`query/reconstructed-state.ts:343`)、read service、API、agent tool、web `/reconstruction` が存在                                                                   | queryはcashのみ。positionsは `positions_not_folded`。B adapter `WRITER_OF_KIND` (`reconstruction-adapter.ts:68`) はpurchase/refund/card_settlementのみ。card writerのrole timeが欠ける場合もfallbackしない。family/history coverage producerはない                         | reconstruction domain/query/read/API/browser/scale tests                                                                   |
| lot arithmetic           | `computeLots` (`lots.ts:1635`) はFIFO、moving-average、specific-identification、部分処分、exact/rounded配賦、snapshot-only未知原価、合成splitを持つ                                           | provisional inputの純計算。transferは `transfer_contract_pending`。taxは `tax_rules_unverified`。原価・fee・proceeds・FXの欠落を0にしない                                                                                                                                  | `lots.test.ts` のconservation・tie・未知値・split・tax・lineageテスト                                                      |
| selected revision → lots | `adaptSelectionToLots:651`, `lotsOnSelection:934`、`queryLotsOnSelection` (`query/lots-on-selection.ts:263`) が存在                                                                           | 今日の実storeではsecurity writer不在でunsupported。current mappingを読み、crypto以外はclassなし。wrapperはcallerがaccountに1つ指定。route/page/serviceなし                                                                                                                 | `lot-adapter.test.ts`, `lots-on-selection-query.test.ts`。positive tradeは手組みselectionでありDB writerの成功証拠ではない |
| valuation / market data  | `selectMarketData`、as-of price/FX selectorとvaluation queryの部品。価格basis・known-at publication・missing/stale/overlapを扱う                                                              | owner採用price/FX policyなし、関連service接続なし。provider-scoped base refをcanonical temporal instrumentへ無断変換できない                                                                                                                                               | market-data、valuation query tests、ADR0056                                                                                |
| P&L                      | `pnlDecomposition` / `pnlDecompositions` (`calculation.ts:424,456`) は一定quantityの価格/FX分解                                                                                               | actual disposal allocationsとの実現損益、残存lotとの含み損益、income/fee/cash-flow、期間reportは未接続。`costBasis:522` はalways-needs-policyだがlot engine不在を意味しない                                                                                                | `calculation.test.ts`、ADR0051/0059                                                                                        |

確認した必読設計: `docs/economic-events.md`, `calculation-and-reports.md`, ADR0051/0054/0058/0059、`docs/plans/2026-10-instrument-resolution-remaining.md`、AGENTS.md、plans/README。文書の古い段落と現コードが違う箇所（SBI Shinsei origin 0.1.3等）は現コードを優先した。

## 3. S0: published rowからreadinessへ、具体的な契約

### 実装位置

新規候補（名前は提案）:

1. `packages/read-model/src/economic-row-readiness.ts`: 指定rowだけのkeyed SQL loader。
2. `packages/domain/src/economic-row-readiness.ts`: pure evaluator。registryと `humanAdoptedRowIdentity` を呼び、admission規則を複製しない。
3. `packages/application/src/query/economic-row-readiness.ts`: validate → load → evaluate → manifest digest。
4. 同名のread-model/domain/application test。既存 `own-transfer-plan.ts` を変更するのはS1で、既存の4 plannerに同じprovenance checkを接続する。

S0は内部queryまで。grant付きread service/HTTP/MCP/UIはS0bで独立追加する。現open PR #638/#641が共通service・audit/transportを変更中なので、その統合版に追従し、先に並行catalogueを作らない。S0の入力は認可済みcallerから渡される契約とし、将来transportは読取scopeを**内容を読む前に**検証する。

### 入力

- exact keys、schema `economic-row-readiness-v1`。
- `family`: 最初は `bank-movement` / `securities-execution` の明示診断。これはfamily supportを変更しない。
- `rows`: 1–64個の `{observationId, parseRunId}`。正のsafe integer、重複拒否。64は新queryの提案boundであり既存500-row proposal boundを変更しない。
- `knowledge`: S0は **current** のみ。過去publication/ownership queryと誤解されないようknown-atはrefuse。clockで経済順序を作らない。
- policy、provider ID、account ID、ownership、instrument class、wrapper、FXをcallerの上書き値として受け取らない。

### 読取と識別

- 観測は指定parseに実在するtransactionだけを読む。artifact/parserの現在published parseにそのparseが選ばれているか確認する。古い観測は失わず `evidence_not_current`（提案コード）にする。
- publishedはreuse許可を意味しない。CORE0034の `evidence_use_restrictions` (`no-reuse | deleted | key-destroyed`) を対象observation・parse・artifact/原本へ辿るref conventionとともにS0のADRで定義し、現在restrictionを同じsnapshotで確認する。該当証拠の内容を再使用せずrefusal/restrictedを返す。既存observation/eligible identity viewsがこの確認を済ませるとは仮定しない。CORE0038の `visibility_revision` もpinし、過去のcontextから現在restrictionを回避しない。
- source/producer/namespace/source-account/external-idから既存5-tupleを再導出し、provider identity admissionとalias classは現registry関数を使う。外部IDの形だけでprovider-issuedと扱わない。
- 指定観測からaccount identity observationを辿り、現在account mappingが1つでresolvedかを確認し、mapping row ID・revisionをpinする。0/複数/unresolvedをrefuse。callerにaccountを選ばせない。
- keyed `cardSettlementOwnershipCtes("transaction")` (`packages/read-model/src/card-settlement-ownership.ts:44`) のpublished/eligible sealed identity/current ownership semanticsを参照・再利用する。説明refの `account_mapping:<mapping-row-id>` とcommit revision keyの `account_mapping:<source_account_id>` は別。ownership keyは `ownership:<kind>|<account_id>`。`expectedRevisionsSql` (`storage-d1/src/core/operations.ts:42`) へ説明refを流用しない。
- own-transferの「本人所有」はmappingから推定しない。採用済みbeneficial_owner等の関係で本人ownershipを決定できる契約が未確定なら `ownership_unresolved`。S0は既存relationの証拠・revisionを列挙して診断できるだけで、ownershipを採用しない。person principalとrelationの自己本人の対応はS1前に明文化する。
- keyとaliasのlive holderは共通guardと同じbookごとに読む。cashはlegacy card settlementのholdも確認する。新SQLで全`live_consumption_claims` UNIONをmaterializeしないよう、既存keyed readiness/helperの実装を参照する。
- securityは現行DB gate・selector gate・kind/state・class/wrapper不足を別項目として返す。identityが成立したという合成入力でも「writer enabled」にはならない。

### 結果

- rowごとにref、family、`admitted | blocked | unavailable` の**evidence readiness**、複数のclosed reasons、publication/mapping/ownership/registry/identity-epoch/holder pinsを返す。
- `admitted` は観測の診断条件が成立した意味だけ。`proposalEnabled:false` / `writerEnabled:false` を別に返し、金融adoption可能と表示しない。
- 全体はcountとref、manifest/contextId。生のprovider text、external-ID component、amount、account labelを診断結果・audit/logへ出さない。必要なalias/keyは内部で扱い、結果ではdigest化し、commit guardを結果だけから生成しない。
- 0 admitted rowsは「口座が空」でも「取引履歴が完全」でもない。family/history coverageはunknownを保持する。
- 新しいqueryコードは既存のidentity拒否コードを使用。publication/ownership/missing-guard/bound等の追加closed codesは実装PRのADR/contractで定義し、文書の提案名をshipped enumと扱わない。

### 時点・訂正・冪等性・原子性

- 原本の日時、parse publication時点、identity revision、read source revisionを分ける。S0はcurrent diagnosticなので、歴史的採用時点を返さない。
- 一つのSQL statementで必要なmetaと指定rowのpublication・mapping・ownership・holderを同じsnapshotから返す。複数statementが必要なら読み始め/終わりのepoch/revision照合とbounded retry/refusalを設計し、そのrevisionが全読取tableの変更を捕捉することを証明する。単にlast revisionが等しいだけでcoherentと主張しない。
- 同一inputs・同一read pins・同一registry/evaluator versionは同じcontextId。入力順に依存しない。parse rollback、mapping/ownership訂正、claimのhold/releaseは新contextId。
- read-onlyなのでSQL writes、receipts、decisions、proposal、claim、economic logは**0件**。冪等性とは読取結果の再現性でありoperation receiptではない。
- readinessで見た状態は後続writerの許可証ではない。S1/S2はplan/approve/commit時にpublication・mapping・ownership・identity・claim・current evidence restrictionsを再検証し、receipt予約statementにcommit guardを含める。
- 既存の接続点は `receiptReservationWrite` のtrusted `precondition` (`storage-d1/src/atomic/decision-commit.ts:19,39`) と `application/src/command/commit.ts:270` の `mutation.precondition`。caller-provided SQLや診断digestだけからguardを生成しない。

### S0受入条件

- existing CORE schemaの合成storeで、provider ID originあり銀行rowは証拠診断を通り、fingerprint証券rowはrefuse。unsupported writerは常に明示される。
- 再parse・publication rollback・mapping訂正・ownership不明・claim競合がそれぞれ説明され、stale時に以前のreadyを再利用しない。
- missing guard schemaはunavailable、65 refsは全体refuse、欠落rowを無言で落とさない。
- 全関連tableのbefore/after比較で0 writes。金額/provider textがsafe result・audit/logに混入しない。
- keyed readのplanをstatisticsなしで確認し、指定row数に対するscaleを測る。全口座や全historyのscanを初回sliceの要件にしない。

## 4. 後続イベントwriterに必要なwrite契約

S0は金融writerを実装しないが、S1/S2/S4が次回ぶれないよう以下を提案する。CORE0070の規則を弱めることではない。

| 項目                    | 必須の契約                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入力                    | immutable observation+parse refs、proposal digest/policy version、expected event heads、account/ownership/instrument identity pins、identity epoch、writer release。stored source factsを再読し、callerの金額・account・aliasをそのまま信頼しない                                                                                                                                                                                                 |
| event ID / row identity | event IDとconsumption key/aliasは別物。再送のoperation IDを経済的な同一性にしない。新capture/producer/namespace/reparseで同じ事実のkeyが変わった場合、自動的に別取引と採用せずrekey review                                                                                                                                                                                                                                                        |
| times                   | posting/trade/settlement/valueの役割を別々に保存。不在はunknown。fetched_at、created_at、known_atを経済日付へfallbackしない。date-onlyはdate-only、同日tieをID順で解消しない                                                                                                                                                                                                                                                                      |
| legs/effects            | cash/security movement、breakdown、correspondenceを明示。銀行移動は元・先2movement。101 out = 100 principal + 1 feeを101+100+1と加算しない。security settlementを別writerが動かすcashと、executionのconsideration correspondenceを混同しない                                                                                                                                                                                                      |
| adoption                | ownerの明示確認・共通command lifecycleだけ。heuristic proposal/AIはadoptしない。registered economic plannerとwriterが両方存在して初めて対応commandを使える                                                                                                                                                                                                                                                                                        |
| correction              | new full revisionに全legs/claims/times/effectsを再記述。prior headのcompare-and-set、released claimsの完全一致、new seal/log。旧revision/decisionの内容は書き換えず、許されたforward `superseded_by` pointerのみ設定。旧observationは不変で全履歴を保持                                                                                                                                                                                           |
| withdraw / move         | withdrawはunknown revision、legs/claimsゼロ、全release。moveは2 membersを**同一commit**に含め、2つのheadをpin。withdraw→adoptの2operationsに分解しない                                                                                                                                                                                                                                                                                            |
| idempotency             | receipt entryをoperation+principal+payload digest+plan IDに結合。同一receiptは同一commitSeq・結果を返し、追加revision/claimを作らない。同一IDで異なるpayloadはrefuse                                                                                                                                                                                                                                                                              |
| atomic writes           | receipt予約/decision → new event revision/legs → prior supersession → claims/times/effects → seal → economic_commit_logを同じD1 batch。priorがliveのまま同keyをclaimするとguardが拒否するため、この順序を守る。logは最後のeconomic statementで、その後のapproval消費/plan更新/outbox/audit effectも同じcommand batchに含める。全statementがentry conditionを持つ。0-row CASをJS検査だけで成功扱いしない; trigger failureでbatch全体rollbackを検証 |
| pinned versions         | head revision、content digest、proposal version、decision ID、economic sequence、source epoch/revision、identity acceptance versionを別々にpin。片方を片方から推定しない                                                                                                                                                                                                                                                                          |
| 稼働gate                | ADR0054のremote D1 conformance・unlogged revision確認等は既存条件。今回は検証していない。合成SQLite/workerd成功だけで解除しない                                                                                                                                                                                                                                                                                                                   |

security admissionにはCORE0070 refusal triggerだけを消す変更では足りない。保存kind/state CHECK、domain event states/transitions、selector book/kind admission、writer release認識、row identity resolver、class/quantity basis、seal pins、B/C adapterを同じレビュー対象にする。reserved `trade`/`executed`/`settled` はfixture contractの候補名であり決定済み保存契約ではない。

また `lotsOnSelection` (`lot-adapter.ts:947`) の「security claim数0ならwriter_missing」という今日のgateをwriter導入時に変更する。対応writer＋scope/history coverageにより**空が証明されたbook**、writer不在、coverage未知を別結果にする。0 claimだけで空/completeとはしない。

## 5. #546成果との接続 — SQL置換だけでは解決しない

#546のinstrument temporal journal/sealed members/atomic builder/coherent loaderは**未統合の想定依存**。研究時にはCORE0078予定だったが、公開前照合で [#564](https://github.com/risu729/kogane/pull/564) が `6714ea49f8ac046422a6e193a2fd97d9fef29bd0` でmergeされ、`0078_maintenance_change_provenance.sql` がmainに存在することを確認した。これはmaintenance revisionのactor/reason/decision provenanceであり、instrument temporal journalではない。

したがってCORE0078は既に使用済みで、#546の未公開migrationは実装時のmainに合わせて改番が必要。journalのAPI、完全なmember/seal、atomic builder、coherent loaderとtestsが実際に統合されるまではS3/S4の依存を満たさない。番号一致・#564 mergeから#546の完成を推定しない。研究時の最高CORE0077という記録は歴史証拠としてのみ保持する。

現mainの `selectInstrumentTemporal` はpure supplied-snapshot selector。current/known-atとeffective trade/position/price roleを分離し、half-open interval、validity unknown、訂正、完全membershipを扱う。しかしlot消費には次の追加設計が必要。

1. **1 unitRef → 1 mappingでは足りない。** `validLotAdapterRequest` (`lot-adapter.ts:322–348`) はunitRefをuniqueにし、`:697` のMapはunitRef key。コードUが1月A、2月Bを表すと、一つのselectionで2つのbookへ置けない。新bindingは `eventId@revision#securityLegIndex` とidentity reference role/timeをkeyにし、target instrument・decision version・temporal contextをpinする。
2. **経済順序とidentity referenceを分ける。** 銘柄identityはwriterが確認したtrade roleに従う。lot policyがsettlement-dateでもidentityを受渡日の別商品へ変更しない。position/priceも各自のroleを使う。
3. **selector flagsを消して進めない。** 現selector `1512–1525` はseal pinをcurrent pin/epochと比較し `identity_changed`。temporal consumerを追加するなら、歴史的pin/epoch評価のselector・seal version契約をADRで改訂する。既存flagsをadapterで削るshortcutは禁止。
4. **二つのsequenceは独立。** economic commitSeq Eとinstrument acceptanceSeq Iを同一の数値と扱わない。shared instant Tなら各journalのknownAt≤Tを独立解決し、epoch/sequence/knownAt/standing/setVersion/contextIdを両方pin。同一millisecondの全membersを各journalの規則で含める。
5. **経済seq指定だけではpaired cutが決まらない。** E.knownAtと同時刻のinstrument acceptanceに順序はない。APIは「shared-instant semantics」を明示してIを独立解決するか、paired pinned cutsを要求する。ownerの金融policyではなく再現性contractとして実装PRで決定する。
6. **retained結果はinstantを再解決しない。** pinned E/Iをreplay。新しいsame-time appendはfresh contextを変える。どちらかのcutがprovisionalならcompleteにしない。identity validity/class/basisが未知なら該当bookをholdする。
7. **全aliasを読むがeffective scopeでまとめる。** 現queryはcurrent aliasesを拡張し、remapped-awayをneeds_reviewとする安全策を持つ。将来はhistoryに登場したaliasをeffective periodとcutで解決し、buy/saleが同じbookへ集まることを確認する。requested subsetだけでcompleteにしない。

S3の新temporal lot consumerは既存 `queryLotsOnSelection` の安全なcurrent behaviorを残してadditiveに導入する。class、listing、currency、quoted quantity basis、wrapperの証拠がjournalの単純target mappingだけから得られるとは仮定しない。

## 6. 実装依存順・並行単位・難度

時間は、既存構造に慣れた1実装担当の作業量目安。証拠取得・owner決定待ち・独立レビュー・remote検証・本番展開は別で、納期の保証ではない。

| Slice | 実装内容・主な変更箇所                                                                                                                                                                | 依存 / parallel                                                                                                                              | 難度・目安               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| S0    | bounded row readiness query、pure admission evaluator、manifest、合成read tests                                                                                                       | 今すぐ着手。#546不要、migration不要。既存catalogueを編集しない                                                                               | 中、1–2日                |
| S0b   | read service/API/UIで拒否理由とsource fact linkを表示。MCPも同一read service                                                                                                          | S0、#638/#641の共通audit/transport統合確認。writer UIとは別                                                                                  | 中、1–2日                |
| S1    | own-transfer planner provenance: publication、mapping、ownershipを再読/pin、receipt reservationのguardへ接続                                                                          | S0、ownership contract。writer/registrationはoffのまま合成race tests可                                                                       | 中、1–3日                |
| S2    | 同一通貨銀行移動のproposal lane + owner-reviewed atomic writer、posting time/effects、B adapter/fold接続、説明read flow                                                               | S1、owner transfer policy、既存production gate。先に合成off-path builderは作れるがactivationとは分離                                         | 高、3–5日 + gate待ち     |
| S3    | temporal event-leg binding/paired cuts、pinned class/unit/wrapper、lot queryのidentity adapter進化                                                                                    | #546の実際のjournal/loader/seal統合。証券writer準備と並行可能。現selector flag契約は先に設計                                                 | 高、3–5日                |
| S4    | 最初の証券family: stable execution ID+方向+quantity/timeが裏付けられたlong spot acquisition/partial disposal。保存vocabulary/claim admission/selector/B/C/atomic writerをまとめて対応 | S0/S1のprovenance、S3、provider evidence/fee/consideration contract。現fingerprintからは開始不可。新collector/providerはこの計画の実装範囲外 | 高、5–8日 + evidence待ち |
| S5    | 指定日security reconstruction: opening snapshot boundary、selected movements、reported diff、history/family coverage producer。開始snapshot原価は未知のまま                           | S4、snapshot quantity basis/時点証拠。cashの既存queryをsecurity可能と再ラベルしない                                                          | 高、3–5日                |
| S6    | security own-transfer lot lineage: 部分quantity、origin cost/time/wrapper、fees、one live holder、unmatched transfer-inを未知としてhold                                               | S3/S4、#545 ownership、owner transfer/wrapper policy。銀行cash transferをlot transferに流用しない                                            | 非常に高、4–7日          |
| S7    | lots read service・immutable retained result。選択済みacquisition/disposalから原価説明までUI/APIで追跡                                                                                | S3/S4、明示LotPolicy。S5 coverageと統合してcompleteを厳格化。既存computeLotsを利用                                                           | 中〜高、2–4日            |
| S8    | investment P&L: 実現allocation+残存評価+income/fee、external fundingを区別、期間reportと訂正diff                                                                                      | S5/S7、#553の価格/FX policy採用・temporal canonical basis接続。income event familyは別writer依存                                             | 高、4–7日 + policy待ち   |

並行しやすい単位: S0とS3のcontract検討、S1とS0bの表示準備、S4のvocabulary/guard合成契約とS5の純quantity fold設計、S7 retention formatとS8の純rollup契約。共有selector/seal・migration・app command entrypointは一担当で統合し、別branchが同時に同じschemaを予約しない。

最初の金融generation S2はcash移動であり#556を閉じない。#556の最初の説明可能な成功経路はS3/S4/S7の「1 instrument/1 wrapper、別日の取得→部分処分、明示policy」で、transfer・corporate action・tax・外国FXは別の受入条件にする。

この最小原価経路もS5または同等producerのaffirmative family/history coverageとquantity/snapshot boundaryの裏付けがなければ**limited**のまま。合成positive allocationsだけで完全な取得履歴を主張しない。

S7のretentionはlot専用report-purpose body/manifestを対象とする。既存 `calculation_results` のreason CHECKはlot理由を格納できない（ADR0051）ため、その表へ無理に書かない。full validated inputs、policy本体、engine/adapter/selector versions、paired cuts、evidence refsとread restrictionsを保ち、digestだけの保存でreplay可能としない。amount-bearing bodyはreport retentionに従い、operation/audit/logへ保存しない。

S8はflow-aware rollupを別に構成する。期間中にbuy/sale/transferがある場合、一定quantityの `pnlDecomposition` を期間全体へ直接適用しない。capitalized acquisition feeは既にallocated costに入り、reduce-proceeds disposal feeは既にnet proceedsへ反映されているので、fee欄の表示に加えて再減算しない。gross/separateとnet/reduce-proceedsの表示・totalのequivalenceを明示policy下で検証する。

## 7. 合成テスト行列

以下は**今後追加する受入tests**。今回の既存tests実行と混同しない。全部synthetic identifiers/dates/amountsを使う。

| ID  | arrangement                                                                  | 期待結果 / 主なslice                                                                                                    |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| R1  | provider-id originありbank rowとcollector-fingerprint security row           | 前者のidentity成立、後者identity_fingerprint_only。writerは両方disabled / S0                                            |
| R2  | parse V1がV2にpublication変更、rollback、unknown parse                       | 古いrefはevidence_not_current、rollback後fresh context変更、欠落をskipしない / S0,S1                                    |
| R3  | 同じ観測、account mapping A→B、0 mapping、2候補                              | old context stale、unresolved/ambiguous refusal、proposalのaccountを信頼しない / S0,S1                                  |
| R4  | ownership missing/rejected/conflicting relation、mappingだけ存在             | selfを推定しない。owner relation/本人対応contract成立までblocked / S0,S1                                                |
| R5  | same factをproducer/namespace違いで2表示、同額の別facts                      | alias競合、fingerprint refusal、別factsを同額だけでmergeしない / S0,S2,S4                                               |
| R6  | legacy card settlementと新transferが同じbank debitを狙う、両順序             | 一方だけlive holder。safe diagnosticとwriter guardが一致 / S0,S2                                                        |
| R7  | 全refs order変更、65 refs、1つ欠落、guard schemaなし                         | digest同一、全体bound refusal、欠落理由、unavailable。0 writes / S0                                                     |
| R8  | diagnostic/plan後にno-reuse/deleted/key-destroyedを追加、旧context再送       | current restrictionが優先、visibility revision変更、内容を再使用しない、commit拒否 / S0,S1,S7                           |
| W1  | plan後publication/mapping/ownership/identity epoch変更                       | receipt予約時refuse、event/legs/claims/seal/log/audit effectなし。receipt/auditは既存失敗規約通り / S1,S2               |
| W2  | 同じoperation replay、同一ID異payload、race head変更                         | 原receipt/seq再利用、payload conflict、stale head no-op/refusal。半端なrevisionなし / S2,S4                             |
| W3  | 101 debit/100 credit+1 explicitly stated fee、unknown fee                    | cashは101一度だけ、breakdown追加加算なし。差額から暗黙feeを作らない / S2                                                |
| W4  | full correction、withdraw、2-member move、最後のfinalization失敗             | old cut再現、新cut変更、全table rollback、undeclared release禁止 / S2,S4                                                |
| T1  | U→A `[2099-01-01,02-01)`、U→B以降、同selectionの2events                      | event-leg別bindingで別book、境界1回、unitRef Mapへ縮退しない / S3                                                       |
| T2  | tradeがboundary前、settlement後、lot policy settlement basis                 | identity A保持、lot economic orderingだけsettlement。trade欠落ならunresolved / S3,S4                                    |
| T3  | E=4/I=9、同millisecond commit/acceptance、後着append                         | seq namespace別、paired cuts pin。retained replay同じ、fresh instant結果は新context。provisionalはcomplete不可 / S3     |
| T4  | temporal membership不完全、invalidity/overlap、current epoch変更             | loader/selector refusalを伝播。current identity_changedを消さない / S3                                                  |
| Q1  | snapshot dayとtrade day同日、snapshot basis/境界不明                         | order/boundary未知。snapshotに含まれると仮定せず、ID order禁止 / S5                                                     |
| Q2  | opening holdings10、取得2、売却4、end reported8                              | reconstruction8、reported diff0。ただしcoverage不足ならincomplete / S5                                                  |
| Q3  | end snapshot7、missing transaction、complete-empty snapshot                  | unexplained differenceを残す、架空adjustment禁止。complete-emptyはcoverage/boundaryが証明された場合だけ / S5            |
| L1  | acquisition10/cost1000、別日sale4、explicit fee policy                       | allocated400、remaining600、origin/time/policy pins保持。未知feeならlimited / S4,S7                                     |
| L2  | snapshot-only、no fee field、missing FX、sale precedes acquisition           | unknown cost/fee/FX、negative_holding、0補完・synthetic shortなし / S4,S7                                               |
| L3  | same-day buy/sale、inexact 1/3、stale specific lot choice                    | order_tie、explicit rounding以外refuse、旧lotに再割当しない / S7                                                        |
| L4  | transfer-out4/in4、in片側欠落、wrapper変化、correction                       | cost400とorigin lineageを保持、unmatched-in未知、wrapperを混ぜない。既存engineは現時点refuse / S6                       |
| L5  | split、merger/spinoff未対応、margin、tax purpose                             | declared split evidenceのみ別slice。未対応corporate action/margin/taxはrefuse / S6以後                                  |
| L6  | supported writer＋proved empty coverage、writerなし、coverage未知の3 store   | empty book / writer_missing / incompleteを区別、0 claimのcount gateを改訂 / S4,S7                                       |
| L7  | retained lot body再読、policy内容変更、旧paired cuts、read restriction変更   | full inputsから再現、new context、旧結果不変。制限されたevidenceは権限に従って表示し、digestのみをreplayと扱わない / S7 |
| P1  | price/FX stale/missing、execution priceのみ、違うlisting/unit                | unrealized unavailable/limited、0/1:1・execution valuation fallback禁止 / S8                                            |
| P2  | external deposit、dividend、fee、realized sale、correction                   | capital flow≠return。income/feeを分け、allocation/valuation refsで説明。訂正はnew report、old digest不変 / S8           |
| P3  | 同period buy/sale、capitalized fee、net disposalとgross/separate counterpart | constant-q helperを直接適用せず、flow-aware compositionでfee一度だけ。equivalent政策のtotal照合 / S8                    |
| B1  | bound超過、scope attenuation、identifier部分指定、race append                | 全体refuseかreview、全bookを部分読取でcompleteにしない。grant pre-read。coherent meta確認 / S0b,S3,S7                   |

独立reviewではpositive resultだけでなく、pin check/identity gate/time role/holder guardを意図的に外すとtestsが失敗することも確認する。DB guardのbranchはwhole-table before/after、writer raceはSQLiteとworkerd/Miniflareで確認する。remote D1の稼働受入は別途必要。

## 8. 本人決定・実データ不足・技術gateを別に管理

| 区分                   | 未決項目                                                                                                | 必要な確認 / 決まるまでの挙動                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 本人の金融policy       | own-transferの日付window、同額条件/fee-within閾値、対応currency                                         | 明示versioned policy。nullならpolicy_missing。合成fixtureの数値を採用policyとしてseedしない  |
| 本人の金融policy       | investment lot method、time basis、acquisition/disposal fee、FX cost unit/source、rounding、specific ID | 明示LotPolicyを渡す。デフォルトを置かない。investment-analysisとtaxを分離                    |
| 本人の金融policy       | snapshot-only opening costの手入力可否、partial transfer/cross-wrapper/feeの扱い                        | 実装前にdecision/contract。未決はunknown/transfer_contract_pending                           |
| 証拠不足               | stable security execution/order/fill identity、取消/訂正参照、direction code、spot/margin               | 現在のfingerprintではadmission不可。provider IDを合成してregistryに宣言しない                |
| 証拠不足               | domestic settlement amountがprincipal/gross/net/fee込みのどれか、foreign fees/FX                        | consideration/feeはunknownのまま。quantityだけ明確でも正確cost/P&Lとは表示しない             |
| 証拠不足               | security class、listing/share class、quantity/price quote basis、position/cash wrapper source           | 名称/コードだけからequity・fund・NISA等を推定しない。#546 target mappingだけで十分とはしない |
| 証拠不足               | trade同日順序、snapshotが当日tradeを含むか、coverage windowと空口座の証明                               | order_tie/boundary_unknown/history_coverage_unknown。fetched instantによる順序補完なし       |
| 証拠不足               | corporate actions、own-account security transfer、income facts                                          | bank cash移動・pure synthetic splitから実provider対応を主張しない                            |
| 本人の金融policy＋証拠 | valuationのprice/FX rules、freshness、calendar、pivot、listing/adjustment                               | ADR0056のowner質問を確認。今回はprovider/sourceを選定しない。missing/stale/unsupportedを伝播 |
| 技術contract           | ownershipの本人principal対応、published-source guard、paired cut、temporal pin/epoch評価                | 実装ADRで明示。設計上の一致が金融採用を意味しない                                            |
| 技術gate               | #546 temporal journalの実統合（CORE番号は再取得）、remote D1 conformance、unlogged revision検査         | 別担当成果/稼働証拠待ち。今回は未検証。registrationをoffに保持                               |
| 対象外                 | 税制度・jurisdiction/period適用・税額                                                                   | 税目的はrefuse。現行税法や税方式をこの計画で選ばない                                         |

## 9. 歴史的な研究結果と公開前の差分照合

**研究時の記録 (c8 baseline):** open PRは#638（共通audited R1/shared readers）、#641（#638 branch上のR2）、#639（collection quality/unknown coverage）、#580、#564、#540、#436、#326、#324。#549/#550/#556/#557/#546はOPENだった。#546 journalの完成はopen PRリストから推定していない。

**公開前照合 (f761 baseline):** c8以降のmainには#643、#564、#644、#645、#646、#647が統合されていた。#564のmaintenance provenanceがCORE0078を使用し、main最高番号は0078。公開前に確認したopen PRは#638/#641/#639/#636/#580/#540/#436/#326/#324で、#564はMERGED。#638/#641のshared readers/audit/transport統合は引き続きS0bの依存である。

c8からf761へのdiffでは、本書の主要な経済domain/identity/selector/lot engine/lot adapter、own-transfer planner、lot/reconstruction query、economic-selector loader、economic command writer slotの各ファイルは変更されていなかった。security-quantity拒否・empty planner registration・null economic writer・cash-only reconstruction・unitRef単位mappingの阻害要因は同じ。ただしApp/maintenance/audit catalogueとCI/release周辺は更新されたため、S0bは最新の共通サービスを読み直す。現在設定やmerged codeをproduction検証・delegated execution成功の証拠にしない。着手直前にmain/open PR/#546の実統合を再確認する。

以下は**研究時c8で**native mise環境から実行した既存合成testsの履歴であり、公開候補f761上の新しい全runtime tests結果ではない。新test・product code・migrationは書いていない。今回の文書checkと新鮮な独立レビューの結果はDraft PRのvalidation欄に記録する。

| 実行                                                                                                                                                    | 結果                                  | 意味と限界                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| parent: `lots.test.ts`, `lot-adapter.test.ts`, `instrument-temporal.test.ts`                                                                            | **134 pass / 0 fail**, 758 assertions | existing arithmetic / adapter / supplied temporal selectionの確認      |
| A agent: `economic-event-plan`, `own-transfer-plan`, `lots-on-selection-query`, `economic-commit-guard`, `knowledge-selector`, `lot-adapter` の6 suites | **161 pass / 0 fail**, 980 assertions | existing refusalとunregistered plannerの合成確認                       |
| A agent追加: `row-identity`, `own-transfer-proposals`, `reconstruction-adapter`, `reconstructed-state-query` の4 suites                                 | **65 pass / 0 fail**, 856 assertions  | identity/proposalとcurrent cash adaptationの確認。A合計226 pass/0 fail |
| B agent: lots/adapter/query 130 tests、calculation/temporal/reconstruction query 53 tests                                                               | **183 pass / 0 fail**                 | current mappingのrefusal・cost/P&L部品の確認                           |

実行群は重複を含むので成功数をunique totalへ加算しない。full CI/typecheck、remote D1、実原本、production coverageの証拠ではない。line referencesは実コードから確認し、ADR/Issueの未来形をimplementedと扱っていない。A/B担当が統合計画を独立に再読し、correctionのstatement順序、許されたsupersession pointer、0-claimのempty gate、retention先、fee二重減算、coverage条件の指摘を反映した。

## 10. 次回の着手手順

1. 最新main/open PRと#546の実統合状態を確認し、専用worktreeを作る。AGENTS/必要ADRを読む。新migration番号は予約せず実時点で取得する。
2. S0のproposed input/output/reasonsとcoherent single-statement readを小ADRで具体化。existing identity/helperを再利用し、financial policyは要求しない。
3. R1–R8の合成fixtureとqueryを実装、0 writes/省略なし/manifest determinism/SQL costを検証する。read transportを含めるなら#638統合catalogueに追従しS0bとしてレビューする。
4. S1はpublication/account/ownership pinsとreceipt guardの整合を実装。owner policy・remote gate未成立でも純guard/builderの合成testsまでは進められる。
5. S2のactivationとS4のsecurity admissionは別のreview可能な差分にする。上表の本人policy・実証拠・稼働gateが成立するまでwriterを登録しない。

この計画の保存はownerの金融方針や未実装設計を承認したことを意味しない。既存author docsは編集せず、実装で採用した変更だけをそのPRのADRとliving docsへ反映する。
