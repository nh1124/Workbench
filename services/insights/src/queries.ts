export interface SummaryCursor { summaryDate: string; machineId: string }
export interface DerivedCursor { createdAt: string; id: string }

export function encodeCursor(value: SummaryCursor | DerivedCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
export function decodeSummaryCursor(value: string): SummaryCursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SummaryCursor>;
  if (typeof parsed.summaryDate !== "string" || typeof parsed.machineId !== "string") throw new Error("Invalid summary cursor");
  return { summaryDate: parsed.summaryDate, machineId: parsed.machineId };
}
export function decodeDerivedCursor(value: string): DerivedCursor {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<DerivedCursor>;
  if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("Invalid derived cursor");
  return { createdAt: parsed.createdAt, id: parsed.id };
}

export const activityAggregateSql = `
  WITH scoped AS (
    SELECT s.machine_id, s.summary_date, s.metrics_json
    FROM activity_summaries s
    INNER JOIN machines m ON m.id = s.machine_id AND m.service_account_id = s.service_account_id
    WHERE s.service_account_id = $1 AND s.summary_date >= $2::date AND s.summary_date <= $3::date
      AND ($4::uuid IS NULL OR s.machine_id = $4::uuid)
  ), category_totals AS (
    SELECT entry.key, SUM(CASE WHEN jsonb_typeof(entry.value) = 'number' THEN (entry.value #>> '{}')::numeric ELSE 0 END) AS total
    FROM scoped CROSS JOIN LATERAL jsonb_each(COALESCE(metrics_json->'categories', '{}'::jsonb)) entry GROUP BY entry.key
  ), app_totals AS (
    SELECT entry.key, SUM(CASE WHEN jsonb_typeof(entry.value) = 'number' THEN (entry.value #>> '{}')::numeric ELSE 0 END) AS total
    FROM scoped CROSS JOIN LATERAL jsonb_each(COALESCE(metrics_json->'apps', '{}'::jsonb)) entry GROUP BY entry.key
  )
  SELECT jsonb_build_object(
    'totals', jsonb_build_object(
      'activeSeconds', COALESCE(SUM(CASE WHEN jsonb_typeof(metrics_json->'activeSeconds') = 'number' THEN (metrics_json->>'activeSeconds')::numeric ELSE 0 END), 0),
      'idleSeconds', COALESCE(SUM(CASE WHEN jsonb_typeof(metrics_json->'idleSeconds') = 'number' THEN (metrics_json->>'idleSeconds')::numeric ELSE 0 END), 0),
      'contextSwitches', COALESCE(SUM(CASE WHEN jsonb_typeof(metrics_json->'contextSwitches') = 'number' THEN (metrics_json->>'contextSwitches')::numeric ELSE 0 END), 0)
    ),
    'categories', COALESCE((SELECT jsonb_object_agg(key, total) FROM category_totals), '{}'::jsonb),
    'apps', COALESCE((SELECT jsonb_object_agg(key, total) FROM app_totals), '{}'::jsonb),
    'days', COALESCE(jsonb_agg(jsonb_build_object(
      'date', to_char(summary_date, 'YYYY-MM-DD'), 'machineId', machine_id,
      'activeSeconds', CASE WHEN jsonb_typeof(metrics_json->'activeSeconds') = 'number' THEN (metrics_json->>'activeSeconds')::numeric ELSE 0 END,
      'contextSwitches', CASE WHEN jsonb_typeof(metrics_json->'contextSwitches') = 'number' THEN (metrics_json->>'contextSwitches')::numeric ELSE 0 END
    ) ORDER BY summary_date, machine_id) FILTER (WHERE machine_id IS NOT NULL), '[]'::jsonb)
  ) AS aggregate FROM scoped
`;
