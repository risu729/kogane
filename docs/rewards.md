# ポイント・マイル・前払式残高（A11）

対象は設計レビュー追補08「ポイント・マイル・前払式残高の専用設計」と、シナリオ SC11〜SC14、
受け入れ試験 AT37/AT39/AT41/AT43〜AT54。移行番号は `0033_reward_buckets.sql`。

**この機能は実際の交換を行わない。** 外部への申請・交換・チャージのcommandは存在せず、追加できる
routeもない。返すのは保有の内訳、観測された期限、規約から算定した見込み、条件つきのsimulationと、
確認が必要な条件の一覧だけである。

## 1. 何を分けているか

| 概念                 | 保持している場所                                             | 分けている理由                                             |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| ProgramUnit          | `reward_programs.unit_ref`                                   | 同じ「ポイント」表記でもプログラムを跨いで同じ単位にしない |
| RewardHolding        | `reward_bucket_claims.holding_ref`                           | 会員の口座。providerの表示スロットとは別                   |
| EligibilityBucket    | `reward_bucket_claims.bucket_kind` / `restriction_refs_json` | 用途・期限の違うbucketを混ぜて利用可能量を作らない         |
| ExpiryObservation    | `reward_bucket_claims.observed_expiry_json`                  | providerが表示した期限。予測とは別列                       |
| MembershipState      | `membership_state_claims`                                    | 自己申告と確認済を区別し、適用期間を持つ                   |
| QualificationMeasure | `bucket_kind='qualification'`                                | 消費できない資格指標。保有量へ加えない                     |
| ExpiryRule           | `expiry_rules`                                               | 計算方式のfamilyと、根拠・確認状態・適用範囲               |
| ConversionOffer      | `conversion_offers`                                          | 倍率は整数比。キャンペーン・会員別は別offer                |

計算は `packages/domain/src/rewards.ts` の純関数で行う。DB・時計・HTTPへ依存しない。

- `summarizeHolding(holding, qualifications)` — 消費できるbucketだけをプログラム自身の単位で合計し、
  `pending-award` と `qualification` は理由コードつきで除外する。単位違い・未解析があれば合計は
  `conflict` になり、小さい数字にはならない（INV05）。
- `availableForOffer(buckets, offer, membership, clock)` — SC13。通常5,000は適格、用途限定3,000は
  `bucket_kind_not_eligible` で除外。会員条件・有効期間・申請期限も検査する。
- `simulateConversion(offer, eligible, fees)` — SC14。上限 → 増分の切り捨て → 最低量の順に適用し、
  受取は「使用量 × 比率」をofferの丸め方針で計算する。`2,500 × 0.5 = 1,250` は返さない。
- `estimateExpiry(rule, holding, activity, membership, clock)` — SC12。`max(transaction_date)` は
  起算日にしない。ruleが指定した対象活動だけを見て、除外された家族間移転などは無視する。
- `redemptionPositions(held, events, destinationUnit)` — 申請・減算・着金・取消・返却を別段階として
  追う。申請だけでは何も動かず、返却は元のlotを復活させず新しいbucket claimになる。
- `findConversionPaths(offers, start, goal, budget)` — 深さと候補数を明示的に制限した探索。

## 2. 期限の状態

`ExpiryEstimate.state` は4つある。

| state                     | 意味                                                   |
| ------------------------- | ------------------------------------------------------ |
| `computed`                | ruleの入力が揃い、算定できた                           |
| `partial`                 | 履歴・取得日・会員資格のいずれかが不足している         |
| `conflict`                | providerの表示期限と算定結果が食い違う。両方を返す     |
| `needs-rule-verification` | 規約が未確認、または内容を計算方式へ落とし込めていない |

`family='none'` は「規約上の無期限が確認済み」であり、期限が不明なこととは別である。
未確認のruleから「期限なし」を返すことはない。期限が確定しないbucketも期日順の一覧から外さず、
`deadline.kind='unknown'` の行として残す。

## 3. 規約の確認状態（重要）

`docs/sources/*.md` に **providerの規約そのものを引用した記録がある場合だけ** `verification='verified'`
とする。それ以外は `verification='needs-rule-verification'` かつ `family='unsupported'` であり、
migrationのCHECK制約がこの対応を強制する。未確認のruleは期限を一切算定しない。

migration 0033 が投入するrule:

| rule                                | family        | verification            | 根拠                                                                                                                                                                                                             |
| ----------------------------------- | ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rule:v-point:regular-inactivity`   | `inactivity`  | **verified**            | `docs/sources/v-point.md` §4.1 が[Vポイントサービス利用規約]を引用し、通常ポイントは最後のポイント変動から1年で失効すること、ストア限定ポイントの獲得/利用はその期限を延長しないことを確認事実として記録している |
| `rule:v-point:fixed-expiry-lot`     | `fixed-lot`   | **verified**            | 同 §4.1。有効期限固定ポイントは個別の期限を持ち、その獲得/利用で当該期限は延びない                                                                                                                               |
| `rule:v-point-pay:prepaid-validity` | `unsupported` | needs-rule-verification | `docs/sources/v-point.md` §5.1 は有効期限FAQを引用しつつ「古い説明と条件が異なり得るため、実装時は現行FAQとapp表示を再確認する」と明記している。再確認前に計算方式へ落とし込まない                               |
| `rule:mobile-suica-sf:validity`     | `unsupported` | needs-rule-verification | `docs/sources/mobile-suica.md` は残高・履歴の取得経路を記録するが、有効期限の規約を引用していない                                                                                                                |

**時間帯は別扱いである。** 引用した規約は期限の基準タイムゾーンを述べていないため、
`deadline_calendar_ref` は `Asia/Tokyo:end-of-day:assumed` とし、算定結果には必ず
`deadline_zone_assumed` を付ける。UIの表示タイムゾーンとプログラムの締切タイムゾーンは別物として
扱う（追補06 §2）。

`conversion_offers` には何も投入しない。レビューが挙げた候補（JRE POINTからSuicaへのチャージ）は
検索抜粋だけの証拠であり [W13]、`needs-rule-verification` としてしか保存できず、simulationの入力に
できないためである。ANA・JAL・楽天のマイル/ポイント規約も同様に、`docs/sources` に規約引用の記録が
できるまでruleを作らない [W09] [W10] [W11] [W12] [W14]。

さらに、V Pointの取引履歴の `point_div`（獲得・利用・失効・訂正・取消等）は実値をrepositoryへ
記録しておらず、観測した明細行を「期限延長の対象活動」に分類できない。したがって現状の実データに
対する `rule:v-point:regular-inactivity` の判定は必ず `partial` になり、理由コードとして
`history_completeness_unknown` と `no_qualifying_activity_observed` を返す。これは仕様どおりで、
最終取引日から期限を作り出さないための帰結である。

## 4. simulationの限界

- 探索は `searchCoverage='bounded'`。深さ（既定2）と候補数の上限があり、全経路を見ていない。
  どの経路も「最適」とは呼ばず、`optimality: "not-determined"` を返す。
- 同一offerの再利用、共有quotaの二重使用、訪問済み単位への循環、着金前の再利用
  （前段の着金予定日より前にしか申請できないoffer）は棄却し、理由コードを返す。
- 完了予定日が `requiredCompletionBy` を越える経路は「間に合う」とは言わず棄却する。
- 未確認の条件は「不可能」ではなく `needs_rule_verification` の別候補として返す。
- 手数料は各hopの `fixedFees` をそのまま積む。変動手数料は `variableFeePolicyRef` の参照のみで、
  金額は計算しない。

## 5. 価値の扱い

追補08 §7 のとおり、**ポイントを円換算して資産合計へ足さない**。

- provider表示価値は B の claim として保持し、独自の価格とは区別する。
- `cash-like redemption estimate` は、具体的なofferを指定したときにだけ生成し、そのofferの
  eligibility/processing/rounding/cancellation の各policy参照を必ず伴う。
- `RewardValueClaim.netAssetEligible` は型として `false` 固定であり、資産小計へ代入できない。
- `/api/v2/rewards/holdings` は `valueModel.cashLikeRedemptionEstimate: null` と
  `reasonCode: "no_offer_named"` を返す。offerを指定しない限り換金額は存在しない。

## 6. 表とその性質

| 表                        | 性質                | 備考                                                     |
| ------------------------- | ------------------- | -------------------------------------------------------- |
| `reward_programs`         | 追記のみ            | `docs/sources` に単位の記録があるプログラムだけ投入      |
| `expiry_rules`            | 追記のみ            | 訂正は新versionで行う。CHECKが未確認ruleの計算方式を禁止 |
| `conversion_offers`       | 追記のみ            | 倍率は整数比。同一区間の複数offerを許す                  |
| `reward_bucket_claims`    | 追記のみ（trigger） | `claim_digest` UNIQUE。公開済みparse runのみ（trigger）  |
| `membership_state_claims` | 追記のみ（trigger） | `provider` の場合は parse run を要求                     |
| `expiry_estimates`        | 再構築可能な投影    | 全削除して再計算しても内容が一致する                     |
| `conversion_simulations`  | 再構築可能な投影    | 入力digest単位。書き込みはsimulation routeでは行わない   |

## 7. 昇格ジョブ

`services/observation-pipeline/src/reward-claims-job.ts`。flag `REWARD_CLAIMS_ENABLED`（既定 `"false"`）。
`scheduled` から1回だけ呼ばれ、flagがoffのときは `null` を返してログ行も出さないため、
既存の `observation_sweep` / `identity_sweep` の出力は変わらない。

- **既存parserは変更しない。** 公開済み（publication gate通過）の `balance_observations` を読み、
  typed claim へ昇格させるだけである。
- 対象は `docs/sources` に単位の記録がある3ソースのみ。
  - V Point `available_point_bucket`: `v-point:store-limited:` 接頭辞は `restricted`、
    providerが期限を表示していれば `time-limited`、していなければ `regular`。
    providerの `point_type` enumは実値を記録していないため写像しない。
  - V Point `displayed_point_balance`（先月の獲得ポイント）: 保有ではないので `qualification`。
  - V Point Pay `prepaid_balance_after_event`、Mobile Suica `sf_balance_after_transaction`:
    それぞれ別プログラムの `regular`。単位はJPYだが、前払式であることは `holding_kind` が持つ。
- **観測された期限はそのまま保持する。** 読み取れない表記は捨てず、
  `{"kind":"unknown","reasonCode":"provider_expiry_unparsed"}` として残す。予測は書かない。
- 冪等: `claim_digest = sha256(source fact参照 + promotion release)` の UNIQUE と `INSERT OR IGNORE`。
  同じsweepを二重に走らせても増えない。release を上げると全件を新しい写像で再昇格する。
- カーソルは追加の表を持たず、`MAX(source_fact_id)` を release ごとに読む。

## 8. 読み取りAPI

capability `rewardsV2`（既定 off）。`services/evidence-browser` の `REWARDS_V2_ENABLED` が
`"true"` のときだけ `/api/meta` が `rewardsV2: true` を広告し、route群が有効になる。
offのとき `/api/v2/rewards/*` は 404 であり、400（未知パラメータ）ではない。

| route                                 | 内容                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/v2/rewards/holdings`        | プログラム別の保有。bucket、観測期限、資格指標、会員資格、除外理由         |
| `GET /api/v2/rewards/expiry`          | rule別の期限判定。state、理由コード、providerの表示と算定の両方            |
| `GET /api/v2/rewards/offers/simulate` | 純粋なquery。offer指定なら単発simulation、goal指定なら深さ制限つき経路探索 |

すべて GET で、書き込みも外部通信も行わない。`Page<T>` = `{rows, coverage:{limit,truncated,nextOffset}}`。
`offset` はbucket行を歩く。読み取りは公開済みparse runに結び付いたclaimだけを見るため、
publication pointerの巻き戻しはreward側の表示からも同時に消える。

## 9. UI

`/rewards`（`rewardsV2` があるときだけnavに出る）。プログラム別に、

- 数量は必ずプログラム自身の単位つきで表示する。円換算欄も横断合計も置かない。
- bucket、観測期限、資格指標、会員資格、合計から除外したものを別の区画にする。
- 期限が確認できない行は「期限未確認」として一覧に残す。行を落とさない。
- 確度は文言と理由コードで示す。色だけには載せない。`provider-observed` / `policy-estimated` /
  `期限未確認` を各行に併記する。

## 10. デプロイ順とロールバック

1. `0033_reward_buckets.sql` を適用する（追加のみ。既存の表・trigger・indexに触れない）。
2. `services/observation-pipeline` をデプロイする。`REWARD_CLAIMS_ENABLED` は `"false"` のまま。
   問題がなければ `"true"` にして昇格を開始する。
3. `services/evidence-browser` をデプロイする。`REWARDS_V2_ENABLED` は `"false"` のまま。
   claimが十分に溜まってから `"true"` にする。
4. UIは同じWorkerのassetsとして配られ、capabilityがoffの間はnavにもrouteにも現れない。

ロールバック:

- 表示を止める: `REWARDS_V2_ENABLED="false"`。routeは404へ戻り、`/api/meta` の広告も戻る。
- 昇格を止める: `REWARD_CLAIMS_ENABLED="false"`。scheduledのログ行も消える。
- migrationは戻さない。`reward_bucket_claims` は追記のみで、他の表を参照するだけである。
- `expiry_estimates` と `conversion_simulations` は再構築可能な投影なので、全削除して差し支えない。

## 11. ローカルで確認したこと・していないこと

合成データだけで確認した。実口座・実際の交換は一切行っていない。

- `packages/domain/test/rewards.test.ts` — SC11〜SC14 を `packages/domain/fixtures/v3` から読み、
  AT43〜AT54の最低限の入力変形（lotあり/期限bucketのみ/取得日不明、除外移転と履歴欠落、
  retroactive根拠のないtier変更、キャンペーン/会員限定の複数offer、期限を跨ぐ完了、
  返却先bucketと期限が変わる取消、循環経路・共有quota・深さ上限・着金前再利用の棄却）、
  月末・閏日・日付のみ入力・タイムゾーン仮置きを実行した。
- `services/observation-pipeline/test/reward-claims.test.ts` — migration 0033 の適用（既存行あり）、
  seedの内容、追記のみの制約、昇格の冪等性、未公開parse runの不可視、読めない期限表記の扱い、
  flag off時に何も書かず何もログしないこと。
- `services/evidence-browser/test/rewards-api.test.ts` — capability off時の404、認証、
  書き込み拒否、保有・期限・simulationの内容、simulationが何も書かないこと。
- `services/evidence-browser/test/conformance.test.ts` — capabilityとrouteの対応。

確認していないこと: 本番D1・本番Workerでの動作、実際のプログラム規約の現在の内容、
providerが表示する期限の実際の表記ゆれ、V Point の `point_type` / `point_div` の実値。

[Vポイントサービス利用規約]: docs/sources/v-point.md

[W09]: 設計レビュー追補99 W09（ANAマイル口座グループ）
[W10]: 同 W10（ANAマイル有効期限）
[W11]: 同 W11（Qantas Frequent Flyer terms）
[W12]: 同 W12（楽天ポイントのルール）
[W13]: 同 W13（JRE POINTからSuicaへチャージ・検索抜粋のみ）
[W14]: 同 W14（JAL Life Statusプログラム）
