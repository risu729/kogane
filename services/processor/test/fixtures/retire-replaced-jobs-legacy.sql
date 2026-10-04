-- Frozen from 5a7fb8dd before the D1 cost rewrite.
WITH registry AS (
      SELECT json_extract(value,'$.name') AS name, json_extract(value,'$.version') AS version,
        json_extract(value,'$.parts[0]') AS major, json_extract(value,'$.parts[1]') AS minor,
        json_extract(value,'$.parts[2]') AS patch FROM json_each(?1)
    ), candidates AS (
      SELECT j.fetch_artifact_id, j.parser_name, j.parser_version,
        CASE WHEN json_valid('['||replace(j.parser_version,'.',',')||']')
          THEN '['||replace(j.parser_version,'.',',')||']' ELSE '[]' END AS parts
      FROM observation_parse_jobs j
      WHERE (j.status IN ('pending','failed') OR (j.status='running' AND j.lease_until_ms<=?3))
        AND (?2 IS NULL OR j.fetch_artifact_id=?2)
        AND j.parser_name IN (SELECT name FROM registry)
        AND coalesce(j.last_error_code,'') <> 'parser_version_retired'
    ), older AS (
      SELECT * FROM candidates WHERE json_array_length(parts)=3
        AND json_type(parts,'$[0]')='integer' AND json_type(parts,'$[1]')='integer'
        AND json_type(parts,'$[2]')='integer'
        AND printf('%d.%d.%d',json_extract(parts,'$[0]'),json_extract(parts,'$[1]'),json_extract(parts,'$[2]'))=parser_version
        AND json_extract(parts,'$[0]') BETWEEN 0 AND 9007199254740991
        AND json_extract(parts,'$[1]') BETWEEN 0 AND 9007199254740991
        AND json_extract(parts,'$[2]') BETWEEN 0 AND 9007199254740991
    ) UPDATE observation_parse_jobs SET status='failed',last_error_code='parser_version_retired',
      lease_token=NULL,lease_until_ms=0
    WHERE (fetch_artifact_id,parser_name,parser_version) IN (
      SELECT old.fetch_artifact_id,old.parser_name,old.parser_version FROM older old
      JOIN registry r ON r.name=old.parser_name
      JOIN observation_parse_jobs replacement ON replacement.fetch_artifact_id=old.fetch_artifact_id
        AND replacement.parser_name=r.name AND replacement.parser_version=r.version
      WHERE replacement.status IN ('done','failed')
        AND coalesce(replacement.last_error_code,'') <> 'parser_version_retired'
        AND (json_extract(old.parts,'$[0]'),json_extract(old.parts,'$[1]'),json_extract(old.parts,'$[2]'))
          < (r.major,r.minor,r.patch)
        AND EXISTS (SELECT 1 FROM parse_runs p WHERE p.fetch_artifact_id=replacement.fetch_artifact_id
          AND p.parser_name=replacement.parser_name AND p.parser_version=replacement.parser_version
          AND p.status IN ('ok','error'))
    );
