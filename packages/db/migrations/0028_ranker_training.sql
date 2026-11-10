-- 0028: the app trains each company's learned ranker itself, on a timer (FR-RET-08), without any
-- wider database access. It still cannot read ranking_examples directly. Three functions do what
-- training needs, each for the company set in the transaction (app_current_tenant()) and nothing
-- else: list the companies with ratings (ids only), hand over one company's ratings (deleting any
-- past 180 days first), and save one company's result. They run as the data keeper; the app's own
-- role gains nothing on the tables.
GRANT SELECT, DELETE ON ranking_examples TO brain_data_keeper;
GRANT SELECT, INSERT, UPDATE ON tenant_rankers TO brain_data_keeper;
-- The current company only, except while app_companies_with_ranking_examples() lists companies,
-- which it marks for its own duration; so no other keeper function gains reach across companies.
CREATE POLICY data_keeper_training ON ranking_examples FOR SELECT TO brain_data_keeper
  USING (tenant_id = app_current_tenant() OR current_setting('app.ranking_listing', true) = 'on');
CREATE POLICY data_keeper_training_delete ON ranking_examples FOR DELETE TO brain_data_keeper
  USING (tenant_id = app_current_tenant());
CREATE POLICY data_keeper_training ON tenant_rankers FOR ALL TO brain_data_keeper
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Which companies have ratings: ids only, so the timer knows whom to train. The only function that
-- looks across companies, and only at which ones have rows.
CREATE FUNCTION app_companies_with_ranking_examples()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.ranking_listing', 'on', true);
  RETURN QUERY SELECT DISTINCT r.tenant_id FROM ranking_examples r ORDER BY r.tenant_id;
  PERFORM set_config('app.ranking_listing', '', true);
END $$;

-- The current company's ratings, newest 180 days, at most max_rows (the most recently saved), in a
-- fixed order. Older ones are deleted first. Nothing at all when no company is set.
CREATE FUNCTION app_ranking_examples_for_training(max_rows integer)
  RETURNS TABLE (answer_group uuid, server_id text, "position" smallint, score_ratio real, age_days integer, label smallint)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM ranking_examples x WHERE x.tenant_id = v_tenant AND x.saved_on < current_date - 180;
  RETURN QUERY
    SELECT k.answer_group, k.server_id, k.position, k.score_ratio, k.age_days, k.label
      FROM (
        SELECT r.answer_group, r.server_id, r.position, r.score_ratio, r.age_days, r.label
          FROM ranking_examples r
         WHERE r.tenant_id = v_tenant
         ORDER BY r.saved_on DESC, r.answer_group, r.position
         LIMIT LEAST(GREATEST(max_rows, 1), 100000)
      ) k
     ORDER BY k.answer_group, k.position;
END $$;

-- Saves the current company's training result. A null model keeps today's order.
CREATE FUNCTION app_save_tenant_ranker(p_model jsonb, p_metrics jsonb)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no company in scope' USING ERRCODE = 'BR500';
  END IF;
  -- A model is a handful of numbers; anything large did not come from training.
  IF octet_length(COALESCE(p_model::text, '')) > 16384 OR octet_length(p_metrics::text) > 4096 THEN
    RAISE EXCEPTION 'training result too large' USING ERRCODE = 'BR400';
  END IF;
  INSERT INTO tenant_rankers (tenant_id, model, metrics, trained_at) VALUES (v_tenant, p_model, p_metrics, now())
  ON CONFLICT (tenant_id) DO UPDATE SET model = EXCLUDED.model, metrics = EXCLUDED.metrics, trained_at = now();
END $$;

ALTER FUNCTION app_companies_with_ranking_examples() OWNER TO brain_data_keeper;
ALTER FUNCTION app_ranking_examples_for_training(integer) OWNER TO brain_data_keeper;
ALTER FUNCTION app_save_tenant_ranker(jsonb, jsonb) OWNER TO brain_data_keeper;
REVOKE ALL ON FUNCTION app_companies_with_ranking_examples() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_ranking_examples_for_training(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_save_tenant_ranker(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_companies_with_ranking_examples() TO brain_app;
GRANT EXECUTE ON FUNCTION app_ranking_examples_for_training(integer) TO brain_app;
GRANT EXECUTE ON FUNCTION app_save_tenant_ranker(jsonb, jsonb) TO brain_app;
