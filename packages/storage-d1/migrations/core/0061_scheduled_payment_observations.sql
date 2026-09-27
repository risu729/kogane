-- "The source says: this amount is still to be paid on this date." The fifth
-- observation table, for the MyJCB ショッピングスキップ払い schedule page read by
-- `myjcb-skip-payment-schedule` (ADR 0005 amendment e). A row is neither a
-- transaction nor a balance: no read path, purchase recognition, settlement
-- matching, identity run or release comparison reads this table, so nothing
-- is counted twice (INV06) and nothing adopted changes (INV07).
--
-- Append-only like every observation table (0017): corrections are new parse
-- runs. The processor writes it in the same pending parse run as the other
-- kinds (`fields` in services/processor/src/worker.ts), so a row is visible
-- only once its parse run is published. The amount is exact decimal text
-- (INV03); there is no float or minor-unit column. Additive only: nothing
-- existing is altered.
CREATE TABLE scheduled_payment_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  schedule_kind  TEXT NOT NULL CHECK(schedule_kind IN ('card-skip-payment')),
  usage_date     TEXT NOT NULL CHECK(usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_date       TEXT NOT NULL CHECK(due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- An integer in canonical form: `0`, or an optional `-` and digits without a leading zero.
  amount_text    TEXT NOT NULL CHECK(amount_text = '0' OR (
                   ltrim(amount_text, '-') GLOB '[1-9]*'
                   AND ltrim(amount_text, '-') NOT GLOB '*[^0-9]*'
                   AND length(amount_text) - length(ltrim(amount_text, '-')) <= 1)),
  amount_scale   INTEGER NOT NULL CHECK(amount_scale = 0),
  currency       TEXT NOT NULL,
  counterparty   TEXT NOT NULL,
  as_of          TEXT NOT NULL CHECK(as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  observed_at    TEXT,
  raw_locator    TEXT NOT NULL,
  extra_json     TEXT NOT NULL CHECK(json_valid(extra_json))
) STRICT;

CREATE INDEX idx_sched_pay_obs_parse_run ON scheduled_payment_observations (parse_run_id);

CREATE TRIGGER scheduled_payment_observations_no_update BEFORE UPDATE ON scheduled_payment_observations BEGIN SELECT RAISE(ABORT,'scheduled_payment_observations is append-only'); END;
CREATE TRIGGER scheduled_payment_observations_no_delete BEFORE DELETE ON scheduled_payment_observations BEGIN SELECT RAISE(ABORT,'scheduled_payment_observations is append-only'); END;
