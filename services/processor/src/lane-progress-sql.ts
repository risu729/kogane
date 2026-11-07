// The progress statements of the incremental and replay lanes
// (docs/observation-lanes.md). Kept out of worker.ts, whose exports are the
// Worker's entrypoints, so the query-plan test can read them.

/**
 * Records an incremental work item's progress (?1 item, ?2 the cursor it was
 * read with, ?3 the new cursor, ?4 a JSON list of the artifact ids examined,
 * ?5 whether the item is complete, ?6 now). Its jobs are counted from the
 * table, driven from the examined ids through the job key
 * (`lane-progress.test.ts` pins the plan).
 */
export const WORK_ITEM_PROGRESS_SQL = `WITH page AS (SELECT count(*) AS jobs FROM json_each(?4) e
         CROSS JOIN observation_parse_jobs j ON j.fetch_artifact_id=e.value WHERE +j.lane='incremental')
       UPDATE observation_work_items SET cursor_artifact_id=?3,jobs_created=jobs_created+(SELECT jobs FROM page),
         processed_at_ms=CASE WHEN ?5 THEN ?6 ELSE NULL END,
         outcome=CASE WHEN NOT ?5 THEN NULL WHEN jobs_created+(SELECT jobs FROM page)>0 THEN 'jobs_created'
           WHEN ?3>0 THEN 'no_new_jobs' ELSE 'not_eligible' END
       WHERE id=?1 AND processed_at_ms IS NULL AND cursor_artifact_id=?2`;

/**
 * Records a replay creation step (?1 the new cursor, ?2 complete, ?3 now, ?4
 * a JSON list of the artifact ids the step read, ?5 the plan, ?6 the cursor it
 * was read with), counting the plan's jobs among those artifacts.
 */
export const REPLAY_STEP_PROGRESS_SQL = `UPDATE observation_replay_plans SET creation_cursor=?1,creation_complete=?2,updated_at_ms=?3,
      jobs_created=jobs_created+(SELECT count(*) FROM json_each(?4) e
        CROSS JOIN observation_parse_jobs j ON j.fetch_artifact_id=e.value WHERE j.replay_plan_id=?5)
     WHERE id=?5 AND status='running' AND creation_complete=0 AND creation_cursor=?6`;
