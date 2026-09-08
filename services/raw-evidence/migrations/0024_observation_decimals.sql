-- Derived exact decimals. Never rewrite Layer B or use REAL for financial values.
-- v1 recognises the same minor-unit currencies as the existing parser contract.
-- amount_scale is source-text precision, NOT necessarily the minor-unit exponent.
CREATE TABLE observation_decimal_values (
  kind TEXT NOT NULL CHECK(kind IN ('balance','transaction','position','valuation')),
  observation_id INTEGER NOT NULL,
  parse_run_id INTEGER NOT NULL REFERENCES parse_runs(id),
  policy_version TEXT NOT NULL CHECK(policy_version='decimal-v1'),
  status TEXT NOT NULL CHECK(status IN ('exact','missing','unparsed','conflict')),
  coefficient TEXT,
  scale INTEGER,
  basis TEXT NOT NULL CHECK(basis IN ('minor_units','decimal_text','agreement','none')),
  PRIMARY KEY(kind,observation_id,policy_version),
  CHECK((status='exact' AND coefficient IS NOT NULL AND scale IS NOT NULL AND scale BETWEEN 0 AND 4096)
    OR (status<>'exact' AND coefficient IS NULL AND scale IS NULL)),
  CHECK(coefficient IS NULL OR (length(coefficient) BETWEEN 1 AND 4096
    AND (coefficient='0' OR (length(coefficient)-length(replace(coefficient,'-',''))<=1
      AND ltrim(coefficient,'-') NOT GLOB '*[^0-9]*'
      AND substr(ltrim(coefficient,'-'),1,1) BETWEEN '1' AND '9')))),
  CHECK(coefficient IS NOT '0' OR scale=0)
  ,CHECK((status='exact' AND basis<>'none') OR (status<>'exact' AND basis='none'))
) STRICT;

CREATE VIEW observation_decimal_inputs_v1 AS
 SELECT 'balance' AS kind,id AS observation_id,parse_run_id,amount_minor,amount_text,instrument AS unit FROM balance_observations
 UNION ALL SELECT 'transaction',id,parse_run_id,amount_minor,amount_text,currency FROM transaction_observations
 UNION ALL SELECT 'valuation',id,parse_run_id,amount_minor,amount_text,currency FROM valuation_observations
 UNION ALL SELECT 'position',id,parse_run_id,NULL,quantity_text,NULL FROM position_observations;

CREATE VIEW observation_decimal_candidates_v1 AS
WITH prepared AS (
 SELECT *, CASE unit WHEN 'JPY' THEN 0 WHEN 'USD' THEN 2 WHEN 'AUD' THEN 2 END AS exponent,
   ltrim(CAST(amount_minor AS TEXT),'-') AS minor_digits,
   CASE WHEN amount_minor<0 THEN '-' ELSE '' END AS minor_sign
 FROM observation_decimal_inputs_v1
), candidates AS (
 SELECT kind,observation_id,parse_run_id,'decimal_text' AS basis,amount_text AS raw_value,
   amount_minor IS NULL AND amount_text IS NULL AS missing,amount_minor AS raw_minor
 FROM prepared
 UNION ALL
 SELECT kind,observation_id,parse_run_id,'minor_units',
   CASE WHEN amount_minor=0 THEN '0'
     WHEN exponent=0 THEN CAST(amount_minor AS TEXT)
     WHEN exponent=2 THEN minor_sign ||
       CASE WHEN length(minor_digits)>2 THEN substr(minor_digits,1,length(minor_digits)-2) ELSE '0' END
       || '.' || substr('00'||minor_digits,-2)
   END, amount_minor IS NULL AND amount_text IS NULL,amount_minor
 FROM prepared
), unsigned AS (
 SELECT *,trim(raw_value,char(9)||char(10)||char(13)||' ') AS cleaned,
   CASE WHEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),1,1) IN ('-','+')
     THEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),2)
     ELSE trim(raw_value,char(9)||char(10)||char(13)||' ') END AS digits
 FROM candidates
), parts AS (
 SELECT *, CASE WHEN instr(digits,'.')=0 THEN digits ELSE substr(digits,1,instr(digits,'.')-1) END AS whole,
   CASE WHEN instr(digits,'.')=0 THEN '' ELSE rtrim(substr(digits,instr(digits,'.')+1),'0') END AS fraction,
   CASE WHEN length(cleaned) BETWEEN 1 AND 4096 AND digits<>'' AND digits<>'.'
     AND digits NOT GLOB '*[^0-9.]*' AND length(digits)-length(replace(digits,'.',''))<=1
     AND substr(digits,-1)<>'.' THEN 1 ELSE 0 END AS valid
 FROM unsigned
), canonical AS (
 SELECT *,ltrim(whole||fraction,'0') AS coefficient_digits FROM parts
)
SELECT kind,observation_id,parse_run_id,basis,valid,missing,raw_minor,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN '0'
   ELSE CASE WHEN substr(cleaned,1,1)='-' THEN '-' ELSE '' END||coefficient_digits END END AS coefficient,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN 0 ELSE length(fraction) END END AS scale
FROM canonical;

CREATE VIEW observation_decimal_projection_v1 AS
WITH selected AS (
 SELECT kind,observation_id,parse_run_id,
   CASE WHEN count(DISTINCT coefficient||'/'||scale)>1
     OR (max(raw_minor)<>0 AND max(coefficient)='0')
     OR (max(raw_minor)<0 AND substr(max(coefficient),1,1)<>'-')
     OR (max(raw_minor)>0 AND substr(max(coefficient),1,1)='-') THEN 'conflict'
     WHEN sum(valid)>0 THEN 'exact' WHEN min(missing)=1 THEN 'missing' ELSE 'unparsed' END AS status,
   CASE WHEN sum(valid)=2 THEN 'agreement'
     ELSE coalesce(max( CASE WHEN valid=1 THEN basis END ),'none') END AS basis,
   max(coefficient) AS coefficient,max(scale) AS scale
 FROM observation_decimal_candidates_v1
 GROUP BY kind,observation_id,parse_run_id
)
SELECT kind,observation_id,parse_run_id,'decimal-v1' AS policy_version,status,
 CASE WHEN status='exact' THEN coefficient END AS coefficient,
 CASE WHEN status='exact' THEN scale END AS scale, CASE WHEN status='conflict' THEN 'none' ELSE basis END AS basis
FROM selected;

-- New observations are normalized in the insertion transaction.
-- Generated by scripts/generate-decimal-triggers.ts; only NEW is read.
CREATE TRIGGER balance_decimals_v1 AFTER INSERT ON balance_observations BEGIN
 INSERT INTO observation_decimal_values
WITH selected AS (
 SELECT kind,observation_id,parse_run_id,
   CASE WHEN count(DISTINCT coefficient||'/'||scale)>1
     OR (max(raw_minor)<>0 AND max(coefficient)='0')
     OR (max(raw_minor)<0 AND substr(max(coefficient),1,1)<>'-')
     OR (max(raw_minor)>0 AND substr(max(coefficient),1,1)='-') THEN 'conflict'
     WHEN sum(valid)>0 THEN 'exact' WHEN min(missing)=1 THEN 'missing' ELSE 'unparsed' END AS status,
   CASE WHEN sum(valid)=2 THEN 'agreement'
     ELSE coalesce(max( CASE WHEN valid=1 THEN basis END ),'none') END AS basis,
   max(coefficient) AS coefficient,max(scale) AS scale
 FROM (WITH prepared AS (
 SELECT *, CASE unit WHEN 'JPY' THEN 0 WHEN 'USD' THEN 2 WHEN 'AUD' THEN 2 END AS exponent,
   ltrim(CAST(amount_minor AS TEXT),'-') AS minor_digits,
   CASE WHEN amount_minor<0 THEN '-' ELSE '' END AS minor_sign
 FROM (SELECT 'balance' AS kind,NEW.id AS observation_id,NEW.parse_run_id,NEW.amount_minor AS amount_minor,NEW.amount_text AS amount_text,NEW.instrument AS unit)
), candidates AS (
 SELECT kind,observation_id,parse_run_id,'decimal_text' AS basis,amount_text AS raw_value,
   amount_minor IS NULL AND amount_text IS NULL AS missing,amount_minor AS raw_minor
 FROM prepared
 UNION ALL
 SELECT kind,observation_id,parse_run_id,'minor_units',
   CASE WHEN amount_minor=0 THEN '0'
     WHEN exponent=0 THEN CAST(amount_minor AS TEXT)
     WHEN exponent=2 THEN minor_sign ||
       CASE WHEN length(minor_digits)>2 THEN substr(minor_digits,1,length(minor_digits)-2) ELSE '0' END
       || '.' || substr('00'||minor_digits,-2)
   END, amount_minor IS NULL AND amount_text IS NULL,amount_minor
 FROM prepared
), unsigned AS (
 SELECT *,trim(raw_value,char(9)||char(10)||char(13)||' ') AS cleaned,
   CASE WHEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),1,1) IN ('-','+')
     THEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),2)
     ELSE trim(raw_value,char(9)||char(10)||char(13)||' ') END AS digits
 FROM candidates
), parts AS (
 SELECT *, CASE WHEN instr(digits,'.')=0 THEN digits ELSE substr(digits,1,instr(digits,'.')-1) END AS whole,
   CASE WHEN instr(digits,'.')=0 THEN '' ELSE rtrim(substr(digits,instr(digits,'.')+1),'0') END AS fraction,
   CASE WHEN length(cleaned) BETWEEN 1 AND 4096 AND digits<>'' AND digits<>'.'
     AND digits NOT GLOB '*[^0-9.]*' AND length(digits)-length(replace(digits,'.',''))<=1
     AND substr(digits,-1)<>'.' THEN 1 ELSE 0 END AS valid
 FROM unsigned
), canonical AS (
 SELECT *,ltrim(whole||fraction,'0') AS coefficient_digits FROM parts
)
SELECT kind,observation_id,parse_run_id,basis,valid,missing,raw_minor,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN '0'
   ELSE CASE WHEN substr(cleaned,1,1)='-' THEN '-' ELSE '' END||coefficient_digits END END AS coefficient,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN 0 ELSE length(fraction) END END AS scale
FROM canonical)
 GROUP BY kind,observation_id,parse_run_id
)
SELECT kind,observation_id,parse_run_id,'decimal-v1' AS policy_version,status,
 CASE WHEN status='exact' THEN coefficient END AS coefficient,
 CASE WHEN status='exact' THEN scale END AS scale, CASE WHEN status='conflict' THEN 'none' ELSE basis END AS basis
FROM selected;
END;

CREATE TRIGGER transaction_decimals_v1 AFTER INSERT ON transaction_observations BEGIN
 INSERT INTO observation_decimal_values
WITH selected AS (
 SELECT kind,observation_id,parse_run_id,
   CASE WHEN count(DISTINCT coefficient||'/'||scale)>1
     OR (max(raw_minor)<>0 AND max(coefficient)='0')
     OR (max(raw_minor)<0 AND substr(max(coefficient),1,1)<>'-')
     OR (max(raw_minor)>0 AND substr(max(coefficient),1,1)='-') THEN 'conflict'
     WHEN sum(valid)>0 THEN 'exact' WHEN min(missing)=1 THEN 'missing' ELSE 'unparsed' END AS status,
   CASE WHEN sum(valid)=2 THEN 'agreement'
     ELSE coalesce(max( CASE WHEN valid=1 THEN basis END ),'none') END AS basis,
   max(coefficient) AS coefficient,max(scale) AS scale
 FROM (WITH prepared AS (
 SELECT *, CASE unit WHEN 'JPY' THEN 0 WHEN 'USD' THEN 2 WHEN 'AUD' THEN 2 END AS exponent,
   ltrim(CAST(amount_minor AS TEXT),'-') AS minor_digits,
   CASE WHEN amount_minor<0 THEN '-' ELSE '' END AS minor_sign
 FROM (SELECT 'transaction' AS kind,NEW.id AS observation_id,NEW.parse_run_id,NEW.amount_minor AS amount_minor,NEW.amount_text AS amount_text,NEW.currency AS unit)
), candidates AS (
 SELECT kind,observation_id,parse_run_id,'decimal_text' AS basis,amount_text AS raw_value,
   amount_minor IS NULL AND amount_text IS NULL AS missing,amount_minor AS raw_minor
 FROM prepared
 UNION ALL
 SELECT kind,observation_id,parse_run_id,'minor_units',
   CASE WHEN amount_minor=0 THEN '0'
     WHEN exponent=0 THEN CAST(amount_minor AS TEXT)
     WHEN exponent=2 THEN minor_sign ||
       CASE WHEN length(minor_digits)>2 THEN substr(minor_digits,1,length(minor_digits)-2) ELSE '0' END
       || '.' || substr('00'||minor_digits,-2)
   END, amount_minor IS NULL AND amount_text IS NULL,amount_minor
 FROM prepared
), unsigned AS (
 SELECT *,trim(raw_value,char(9)||char(10)||char(13)||' ') AS cleaned,
   CASE WHEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),1,1) IN ('-','+')
     THEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),2)
     ELSE trim(raw_value,char(9)||char(10)||char(13)||' ') END AS digits
 FROM candidates
), parts AS (
 SELECT *, CASE WHEN instr(digits,'.')=0 THEN digits ELSE substr(digits,1,instr(digits,'.')-1) END AS whole,
   CASE WHEN instr(digits,'.')=0 THEN '' ELSE rtrim(substr(digits,instr(digits,'.')+1),'0') END AS fraction,
   CASE WHEN length(cleaned) BETWEEN 1 AND 4096 AND digits<>'' AND digits<>'.'
     AND digits NOT GLOB '*[^0-9.]*' AND length(digits)-length(replace(digits,'.',''))<=1
     AND substr(digits,-1)<>'.' THEN 1 ELSE 0 END AS valid
 FROM unsigned
), canonical AS (
 SELECT *,ltrim(whole||fraction,'0') AS coefficient_digits FROM parts
)
SELECT kind,observation_id,parse_run_id,basis,valid,missing,raw_minor,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN '0'
   ELSE CASE WHEN substr(cleaned,1,1)='-' THEN '-' ELSE '' END||coefficient_digits END END AS coefficient,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN 0 ELSE length(fraction) END END AS scale
FROM canonical)
 GROUP BY kind,observation_id,parse_run_id
)
SELECT kind,observation_id,parse_run_id,'decimal-v1' AS policy_version,status,
 CASE WHEN status='exact' THEN coefficient END AS coefficient,
 CASE WHEN status='exact' THEN scale END AS scale, CASE WHEN status='conflict' THEN 'none' ELSE basis END AS basis
FROM selected;
END;

CREATE TRIGGER position_decimals_v1 AFTER INSERT ON position_observations BEGIN
 INSERT INTO observation_decimal_values
WITH selected AS (
 SELECT kind,observation_id,parse_run_id,
   CASE WHEN count(DISTINCT coefficient||'/'||scale)>1
     OR (max(raw_minor)<>0 AND max(coefficient)='0')
     OR (max(raw_minor)<0 AND substr(max(coefficient),1,1)<>'-')
     OR (max(raw_minor)>0 AND substr(max(coefficient),1,1)='-') THEN 'conflict'
     WHEN sum(valid)>0 THEN 'exact' WHEN min(missing)=1 THEN 'missing' ELSE 'unparsed' END AS status,
   CASE WHEN sum(valid)=2 THEN 'agreement'
     ELSE coalesce(max( CASE WHEN valid=1 THEN basis END ),'none') END AS basis,
   max(coefficient) AS coefficient,max(scale) AS scale
 FROM (WITH prepared AS (
 SELECT *, CASE unit WHEN 'JPY' THEN 0 WHEN 'USD' THEN 2 WHEN 'AUD' THEN 2 END AS exponent,
   ltrim(CAST(amount_minor AS TEXT),'-') AS minor_digits,
   CASE WHEN amount_minor<0 THEN '-' ELSE '' END AS minor_sign
 FROM (SELECT 'position' AS kind,NEW.id AS observation_id,NEW.parse_run_id,NULL AS amount_minor,NEW.quantity_text AS amount_text,NULL AS unit)
), candidates AS (
 SELECT kind,observation_id,parse_run_id,'decimal_text' AS basis,amount_text AS raw_value,
   amount_minor IS NULL AND amount_text IS NULL AS missing,amount_minor AS raw_minor
 FROM prepared
 UNION ALL
 SELECT kind,observation_id,parse_run_id,'minor_units',
   CASE WHEN amount_minor=0 THEN '0'
     WHEN exponent=0 THEN CAST(amount_minor AS TEXT)
     WHEN exponent=2 THEN minor_sign ||
       CASE WHEN length(minor_digits)>2 THEN substr(minor_digits,1,length(minor_digits)-2) ELSE '0' END
       || '.' || substr('00'||minor_digits,-2)
   END, amount_minor IS NULL AND amount_text IS NULL,amount_minor
 FROM prepared
), unsigned AS (
 SELECT *,trim(raw_value,char(9)||char(10)||char(13)||' ') AS cleaned,
   CASE WHEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),1,1) IN ('-','+')
     THEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),2)
     ELSE trim(raw_value,char(9)||char(10)||char(13)||' ') END AS digits
 FROM candidates
), parts AS (
 SELECT *, CASE WHEN instr(digits,'.')=0 THEN digits ELSE substr(digits,1,instr(digits,'.')-1) END AS whole,
   CASE WHEN instr(digits,'.')=0 THEN '' ELSE rtrim(substr(digits,instr(digits,'.')+1),'0') END AS fraction,
   CASE WHEN length(cleaned) BETWEEN 1 AND 4096 AND digits<>'' AND digits<>'.'
     AND digits NOT GLOB '*[^0-9.]*' AND length(digits)-length(replace(digits,'.',''))<=1
     AND substr(digits,-1)<>'.' THEN 1 ELSE 0 END AS valid
 FROM unsigned
), canonical AS (
 SELECT *,ltrim(whole||fraction,'0') AS coefficient_digits FROM parts
)
SELECT kind,observation_id,parse_run_id,basis,valid,missing,raw_minor,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN '0'
   ELSE CASE WHEN substr(cleaned,1,1)='-' THEN '-' ELSE '' END||coefficient_digits END END AS coefficient,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN 0 ELSE length(fraction) END END AS scale
FROM canonical)
 GROUP BY kind,observation_id,parse_run_id
)
SELECT kind,observation_id,parse_run_id,'decimal-v1' AS policy_version,status,
 CASE WHEN status='exact' THEN coefficient END AS coefficient,
 CASE WHEN status='exact' THEN scale END AS scale, CASE WHEN status='conflict' THEN 'none' ELSE basis END AS basis
FROM selected;
END;

CREATE TRIGGER valuation_decimals_v1 AFTER INSERT ON valuation_observations BEGIN
 INSERT INTO observation_decimal_values
WITH selected AS (
 SELECT kind,observation_id,parse_run_id,
   CASE WHEN count(DISTINCT coefficient||'/'||scale)>1
     OR (max(raw_minor)<>0 AND max(coefficient)='0')
     OR (max(raw_minor)<0 AND substr(max(coefficient),1,1)<>'-')
     OR (max(raw_minor)>0 AND substr(max(coefficient),1,1)='-') THEN 'conflict'
     WHEN sum(valid)>0 THEN 'exact' WHEN min(missing)=1 THEN 'missing' ELSE 'unparsed' END AS status,
   CASE WHEN sum(valid)=2 THEN 'agreement'
     ELSE coalesce(max( CASE WHEN valid=1 THEN basis END ),'none') END AS basis,
   max(coefficient) AS coefficient,max(scale) AS scale
 FROM (WITH prepared AS (
 SELECT *, CASE unit WHEN 'JPY' THEN 0 WHEN 'USD' THEN 2 WHEN 'AUD' THEN 2 END AS exponent,
   ltrim(CAST(amount_minor AS TEXT),'-') AS minor_digits,
   CASE WHEN amount_minor<0 THEN '-' ELSE '' END AS minor_sign
 FROM (SELECT 'valuation' AS kind,NEW.id AS observation_id,NEW.parse_run_id,NEW.amount_minor AS amount_minor,NEW.amount_text AS amount_text,NEW.currency AS unit)
), candidates AS (
 SELECT kind,observation_id,parse_run_id,'decimal_text' AS basis,amount_text AS raw_value,
   amount_minor IS NULL AND amount_text IS NULL AS missing,amount_minor AS raw_minor
 FROM prepared
 UNION ALL
 SELECT kind,observation_id,parse_run_id,'minor_units',
   CASE WHEN amount_minor=0 THEN '0'
     WHEN exponent=0 THEN CAST(amount_minor AS TEXT)
     WHEN exponent=2 THEN minor_sign ||
       CASE WHEN length(minor_digits)>2 THEN substr(minor_digits,1,length(minor_digits)-2) ELSE '0' END
       || '.' || substr('00'||minor_digits,-2)
   END, amount_minor IS NULL AND amount_text IS NULL,amount_minor
 FROM prepared
), unsigned AS (
 SELECT *,trim(raw_value,char(9)||char(10)||char(13)||' ') AS cleaned,
   CASE WHEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),1,1) IN ('-','+')
     THEN substr(trim(raw_value,char(9)||char(10)||char(13)||' '),2)
     ELSE trim(raw_value,char(9)||char(10)||char(13)||' ') END AS digits
 FROM candidates
), parts AS (
 SELECT *, CASE WHEN instr(digits,'.')=0 THEN digits ELSE substr(digits,1,instr(digits,'.')-1) END AS whole,
   CASE WHEN instr(digits,'.')=0 THEN '' ELSE rtrim(substr(digits,instr(digits,'.')+1),'0') END AS fraction,
   CASE WHEN length(cleaned) BETWEEN 1 AND 4096 AND digits<>'' AND digits<>'.'
     AND digits NOT GLOB '*[^0-9.]*' AND length(digits)-length(replace(digits,'.',''))<=1
     AND substr(digits,-1)<>'.' THEN 1 ELSE 0 END AS valid
 FROM unsigned
), canonical AS (
 SELECT *,ltrim(whole||fraction,'0') AS coefficient_digits FROM parts
)
SELECT kind,observation_id,parse_run_id,basis,valid,missing,raw_minor,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN '0'
   ELSE CASE WHEN substr(cleaned,1,1)='-' THEN '-' ELSE '' END||coefficient_digits END END AS coefficient,
 CASE WHEN valid=1 THEN CASE WHEN coefficient_digits='' THEN 0 ELSE length(fraction) END END AS scale
FROM canonical)
 GROUP BY kind,observation_id,parse_run_id
)
SELECT kind,observation_id,parse_run_id,'decimal-v1' AS policy_version,status,
 CASE WHEN status='exact' THEN coefficient END AS coefficient,
 CASE WHEN status='exact' THEN scale END AS scale, CASE WHEN status='conflict' THEN 'none' ELSE basis END AS basis
FROM selected;
END;

-- Backfill all historical and current B rows using exactly the insertion policy.
INSERT INTO observation_decimal_values SELECT * FROM observation_decimal_projection_v1;

CREATE TRIGGER observation_decimals_no_update BEFORE UPDATE ON observation_decimal_values
BEGIN SELECT RAISE(ABORT,'versioned decimal values are immutable'); END;
CREATE TRIGGER observation_decimals_no_delete BEFORE DELETE ON observation_decimal_values
BEGIN SELECT RAISE(ABORT,'versioned decimal values are immutable'); END;
