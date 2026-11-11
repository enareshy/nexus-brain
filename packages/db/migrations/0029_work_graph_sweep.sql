-- 0029: old work graph links are removed for everyone (FR-RET-09). Until now a person's links older
-- than 90 days went only when they next used Brain, so someone who stopped kept theirs. The app
-- calls this on a timer; row-level security keeps people's graphs apart, so it runs as the data
-- keeper, which can read only the key and age of a link and delete nothing newer than 90 days.
GRANT SELECT (source_key, target_key, kind, last_seen_at) ON work_graph_edges TO brain_data_keeper;
CREATE INDEX work_graph_edges_last_seen_idx ON work_graph_edges (last_seen_at);

-- Removes at most max_rows links not seen for 90 days (MAX_AGE_DAYS in work-graph.ts), oldest first,
-- and says how many. Returns 0 while another server is sweeping.
CREATE FUNCTION app_forget_stale_graph_links(max_rows integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  batch integer := LEAST(GREATEST(max_rows, 1), 10000);
  removed integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('app_forget_stale_graph_links', 0)) THEN
    RETURN 0;
  END IF;
  -- The age is checked again on each row: a link the person used while this ran is kept.
  DELETE FROM work_graph_edges e
   WHERE e.last_seen_at < now() - interval '90 days'
     AND (e.tenant_id, e.user_id, e.source_key, e.target_key, e.kind) IN (
     SELECT x.tenant_id, x.user_id, x.source_key, x.target_key, x.kind FROM work_graph_edges x
      WHERE x.last_seen_at < now() - interval '90 days'
      ORDER BY x.last_seen_at
      LIMIT batch);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;
ALTER FUNCTION app_forget_stale_graph_links(integer) OWNER TO brain_data_keeper;
REVOKE ALL ON FUNCTION app_forget_stale_graph_links(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_forget_stale_graph_links(integer) TO brain_app;
