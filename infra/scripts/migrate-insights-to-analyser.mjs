const DEFAULT_SAMPLE_DAYS = 30;
const BATCH_SIZE = 500;

function usage() {
  console.log(`Usage:
  node infra/scripts/migrate-insights-to-analyser.mjs [--dry-run] [--sample-days N]`);
}

function parseArgs(argv) {
  let dryRun = false;
  let sampleDays = DEFAULT_SAMPLE_DAYS;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--sample-days") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--sample-days requires a positive integer");
      sampleDays = Number(value);
      index += 1;
    } else if (argument.startsWith("--sample-days=")) {
      sampleDays = Number(argument.slice("--sample-days=".length));
    } else if (argument === "--help" || argument === "-h") {
      usage();
      return undefined;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!Number.isSafeInteger(sampleDays) || sampleDays <= 0) {
    throw new Error("--sample-days must be a positive integer");
  }
  return { dryRun, sampleDays };
}

function env(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

function dbConfig(prefix, defaults) {
  const port = Number(env(`${prefix}_DB_PORT`, String(defaults.port)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${prefix}_DB_PORT must be a valid TCP port`);
  }
  return {
    host: env(`${prefix}_DB_HOST`, "127.0.0.1"),
    port,
    database: env(`${prefix}_DB_NAME`, defaults.database),
    user: env(`${prefix}_DB_USER`, defaults.user),
    password: env(`${prefix}_DB_PASSWORD`, defaults.password),
    connectionTimeoutMillis: 5_000,
    application_name: "workbench-analyser-migration"
  };
}

function errorMessage(error) {
  if (!(error instanceof Error)) return String(error);
  const code = typeof error.code === "string" ? `${error.code}: ` : "";
  return `${code}${error.message}`;
}

async function connect(Client, config, label) {
  const client = new Client(config);
  try {
    await client.connect();
    console.log(`[CONNECTED] ${label} ${config.host}:${config.port}/${config.database}`);
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new Error(`Could not connect to ${label} at ${config.host}:${config.port}/${config.database}: ${errorMessage(error)}`);
  }
}

function asBigInt(value) {
  return typeof value === "bigint" ? value : BigInt(value ?? 0);
}

function countRows(result) {
  return BigInt(result.rowCount ?? 0);
}

async function inspectAccountConflicts(analyser, rows) {
  const result = await analyser.query(
    `SELECT id, core_user_id
       FROM service_accounts
      WHERE id = ANY($1::text[]) OR core_user_id = ANY($2::text[])`,
    [rows.map((row) => row.id), rows.map((row) => row.core_user_id)]
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const byCoreUserId = new Map(result.rows.map((row) => [row.core_user_id, row]));

  for (const row of rows) {
    const sameId = byId.get(row.id);
    const sameCoreUser = byCoreUserId.get(row.core_user_id);
    if (sameId && sameId.core_user_id !== row.core_user_id) {
      throw new Error(`Service-account id conflict for ${row.id}; core_user_id differs between databases`);
    }
    if (sameCoreUser && sameCoreUser.id !== row.id) {
      throw new Error(`Service-account id assumption failed for core_user_id ${row.core_user_id}; target id is ${sameCoreUser.id}, source id is ${row.id}`);
    }
  }

  return rows.filter((row) => byId.has(row.id)).length;
}

async function insertAccounts(analyser, rows) {
  const result = await analyser.query(
    `INSERT INTO service_accounts
       (id, core_user_id, username_snapshot, username, password_hash, created_at, updated_at)
     SELECT *
       FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::timestamptz[], $7::timestamptz[]
       )
     ON CONFLICT (id) DO NOTHING`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.core_user_id),
      rows.map((row) => row.username_snapshot),
      rows.map((row) => row.username),
      rows.map((row) => row.password_hash),
      rows.map((row) => row.created_at),
      rows.map((row) => row.updated_at)
    ]
  );
  return countRows(result);
}

async function migrateAccounts(insights, analyser, dryRun) {
  let lastId = "";
  let source = 0n;
  let copied = 0n;
  let skipped = 0n;

  for (;;) {
    const batch = await insights.query(
      `SELECT id, core_user_id, username_snapshot, username, password_hash,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM service_accounts
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [lastId, BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;
    source += BigInt(batch.rows.length);
    const conflicts = BigInt(await inspectAccountConflicts(analyser, batch.rows));
    if (dryRun) {
      copied += BigInt(batch.rows.length) - conflicts;
      skipped += conflicts;
    } else {
      const inserted = await insertAccounts(analyser, batch.rows);
      copied += inserted;
      skipped += BigInt(batch.rows.length) - inserted;
    }
    lastId = batch.rows.at(-1).id;
  }

  return { table: "service_accounts", source, copied, skipped };
}

async function inspectMachineConflicts(analyser, rows) {
  const result = await analyser.query(
    `WITH batch AS (
       SELECT * FROM UNNEST($1::uuid[], $2::text[], $3::text[])
         AS value(source_id, service_account_id, machine_key)
     )
     SELECT batch.source_id, batch.service_account_id, batch.machine_key,
            target.id AS target_id, target.service_account_id AS target_owner,
            target.machine_key AS target_machine_key
       FROM batch
       JOIN analyser_machines target
         ON target.id = batch.source_id
         OR (target.service_account_id = batch.service_account_id AND target.machine_key = batch.machine_key)`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.service_account_id),
      rows.map((row) => row.machine_key)
    ]
  );

  const existing = new Set();
  for (const conflict of result.rows) {
    if (
      conflict.target_id !== conflict.source_id ||
      conflict.target_owner !== conflict.service_account_id ||
      conflict.target_machine_key !== conflict.machine_key
    ) {
      throw new Error(
        `Machine identity conflict for ${conflict.service_account_id}/${conflict.machine_key}; ` +
        `target id is ${conflict.target_id}, source id is ${conflict.source_id}`
      );
    }
    existing.add(conflict.source_id);
  }
  return existing.size;
}

async function insertMachines(analyser, rows) {
  const result = await analyser.query(
    `INSERT INTO analyser_machines
       (id, service_account_id, machine_key, display_name, platform, registered_at, last_seen_at)
     SELECT *
       FROM UNNEST(
         $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::timestamptz[], $7::timestamptz[]
       )
     ON CONFLICT (service_account_id, machine_key) DO NOTHING`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.service_account_id),
      rows.map((row) => row.machine_key),
      rows.map((row) => row.display_name),
      rows.map((row) => row.platform),
      rows.map((row) => row.registered_at),
      rows.map((row) => row.last_seen_at)
    ]
  );
  return countRows(result);
}

async function migrateMachines(insights, analyser, dryRun) {
  let cursor;
  let source = 0n;
  let copied = 0n;
  let skipped = 0n;

  for (;;) {
    const where = cursor ? "WHERE (service_account_id, machine_key) > ($1, $2)" : "";
    const params = cursor ? [cursor.serviceAccountId, cursor.machineKey, BATCH_SIZE] : [BATCH_SIZE];
    const limitParameter = cursor ? "$3" : "$1";
    const batch = await insights.query(
      `SELECT id, service_account_id, machine_key, display_name, platform,
              registered_at::text AS registered_at, last_seen_at::text AS last_seen_at
         FROM machines
         ${where}
        ORDER BY service_account_id, machine_key
        LIMIT ${limitParameter}`,
      params
    );
    if (batch.rows.length === 0) break;
    source += BigInt(batch.rows.length);
    const conflicts = BigInt(await inspectMachineConflicts(analyser, batch.rows));
    if (dryRun) {
      copied += BigInt(batch.rows.length) - conflicts;
      skipped += conflicts;
    } else {
      const inserted = await insertMachines(analyser, batch.rows);
      copied += inserted;
      skipped += BigInt(batch.rows.length) - inserted;
    }
    const last = batch.rows.at(-1);
    cursor = { serviceAccountId: last.service_account_id, machineKey: last.machine_key };
  }

  return { table: "analyser_machines", source, copied, skipped };
}

async function countObservationConflicts(analyser, rows) {
  const keys = rows.map((row) => `pc:${row.machine_id}:${row.sampled_at_iso}`);
  const result = await analyser.query(
    `SELECT COUNT(*)::bigint AS count
       FROM analyser_observations
      WHERE (service_account_id, dedupe_key) IN (
        SELECT * FROM UNNEST($1::text[], $2::text[])
      )`,
    [rows.map((row) => row.service_account_id), keys]
  );
  return asBigInt(result.rows[0]?.count);
}

async function insertObservations(analyser, rows) {
  const result = await analyser.query(
    `INSERT INTO analyser_observations
       (service_account_id, source, action, actor_kind, machine_id,
        occurred_at, received_at, resource_refs, metadata, dedupe_key, expires_at)
     SELECT service_account_id, 'pc_activity', 'foreground_sample', 'user', machine_id,
            sampled_at, sampled_at, '[]'::jsonb,
            jsonb_build_object('app', process_name, 'idle', idle),
            'pc:' || machine_id::text || ':' || sampled_at_iso,
            sampled_at + INTERVAL '30 days'
       FROM UNNEST(
         $1::text[], $2::uuid[], $3::timestamptz[], $4::text[], $5::boolean[], $6::text[]
       ) AS value(service_account_id, machine_id, sampled_at, process_name, idle, sampled_at_iso)
     ON CONFLICT (service_account_id, dedupe_key) DO NOTHING`,
    [
      rows.map((row) => row.service_account_id),
      rows.map((row) => row.machine_id),
      rows.map((row) => row.sampled_at),
      rows.map((row) => row.process_name),
      rows.map((row) => row.idle),
      rows.map((row) => row.sampled_at_iso)
    ]
  );
  return countRows(result);
}

async function migrateObservations(insights, analyser, cutoff, dryRun) {
  let source = 0n;
  let copied = 0n;
  let skipped = 0n;
  let lastOwner = "";

  for (;;) {
    const owners = await insights.query(
      `SELECT DISTINCT service_account_id
         FROM activity_samples
        WHERE sampled_at >= $1 AND service_account_id > $2
        ORDER BY service_account_id
        LIMIT $3`,
      [cutoff, lastOwner, BATCH_SIZE]
    );
    if (owners.rows.length === 0) break;

    for (const owner of owners.rows) {
      let cursor;
      let dryRunTimestamp;
      let dryRunKeysAtTimestamp = new Set();
      for (;;) {
        const cursorClause = cursor ? "AND (sampled_at, machine_id) > ($3::timestamptz, $4::uuid)" : "";
        const params = cursor
          ? [owner.service_account_id, cutoff, cursor.sampledAt, cursor.machineId, BATCH_SIZE]
          : [owner.service_account_id, cutoff, BATCH_SIZE];
        const limitParameter = cursor ? "$5" : "$3";
        const batch = await insights.query(
          `SELECT service_account_id, machine_id, sampled_at::text AS sampled_at,
                  process_name, idle,
                  to_char(
                    sampled_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ) AS sampled_at_iso
             FROM activity_samples
            WHERE service_account_id = $1 AND sampled_at >= $2::timestamptz
                  ${cursorClause}
            ORDER BY sampled_at, machine_id
            LIMIT ${limitParameter}`,
          params
        );
        if (batch.rows.length === 0) break;
        source += BigInt(batch.rows.length);
        if (dryRun) {
          const uniqueRows = [];
          let duplicateKeys = 0n;
          for (const row of batch.rows) {
            if (row.sampled_at_iso !== dryRunTimestamp) {
              dryRunTimestamp = row.sampled_at_iso;
              dryRunKeysAtTimestamp = new Set();
            }
            const key = `pc:${row.machine_id}:${row.sampled_at_iso}`;
            if (dryRunKeysAtTimestamp.has(key)) duplicateKeys += 1n;
            else {
              dryRunKeysAtTimestamp.add(key);
              uniqueRows.push(row);
            }
          }
          const conflicts = await countObservationConflicts(analyser, uniqueRows);
          copied += BigInt(uniqueRows.length) - conflicts;
          skipped += duplicateKeys + conflicts;
        } else {
          const inserted = await insertObservations(analyser, batch.rows);
          copied += inserted;
          skipped += BigInt(batch.rows.length) - inserted;
        }
        const last = batch.rows.at(-1);
        cursor = { sampledAt: last.sampled_at, machineId: last.machine_id };
      }
    }
    lastOwner = owners.rows.at(-1).service_account_id;
  }

  return { table: "analyser_observations", source, copied, skipped };
}

function printSummary(rows, dryRun) {
  console.log(`\n${dryRun ? "[DRY-RUN] Would-copy summary" : "[SUMMARY] Migration results"}`);
  console.table(rows.map((row) => dryRun
    ? {
        table: row.table,
        eligible: row.source.toString(),
        wouldCopy: row.copied.toString(),
        alreadyPresent: row.skipped.toString()
      }
    : {
        table: row.table,
        source: row.source.toString(),
        copied: row.copied.toString(),
        skipped: row.skipped.toString()
      }));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const insightsConfig = dbConfig("INSIGHTS", {
    port: 5550,
    database: "insights_db",
    user: "insights_user",
    password: "insights_pass"
  });
  const analyserConfig = dbConfig("ANALYSER", {
    port: 5551,
    database: "analyser_db",
    user: "analyser_user",
    password: "analyser_pass"
  });
  const { Client } = await import("pg");
  let insights;
  let analyser;

  try {
    insights = await connect(Client, insightsConfig, "Insights DB");
    analyser = await connect(Client, analyserConfig, "Analyser DB");
    const clock = await insights.query(
      `SELECT NOW()::text AS migration_now,
              (NOW() - ($1::integer * INTERVAL '1 day'))::text AS cutoff`,
      [options.sampleDays]
    );
    const cutoff = clock.rows[0].cutoff;
    console.log(`[INFO] Mode: ${options.dryRun ? "dry-run" : "write"}`);
    console.log(`[INFO] Activity cutoff: ${cutoff} (${options.sampleDays} days from Insights DB time)`);

    const results = [];
    results.push(await migrateAccounts(insights, analyser, options.dryRun));
    results.push(await migrateMachines(insights, analyser, options.dryRun));
    results.push(await migrateObservations(insights, analyser, cutoff, options.dryRun));

    const legacy = await insights.query(
      `SELECT
         (SELECT COUNT(*)::bigint FROM activity_summaries) AS activity_summaries,
         (SELECT COUNT(*)::bigint FROM derived_observations) AS derived_observations`
    );
    console.log(
      `[SKIPPED] activity_summaries: ${legacy.rows[0].activity_summaries} ` +
      "(content-heavy; retained only in the legacy backup)"
    );
    console.log(
      `[SKIPPED] derived_observations: ${legacy.rows[0].derived_observations} ` +
      "(content-heavy; retained only in the legacy backup)"
    );
    printSummary(results, options.dryRun);
  } finally {
    await analyser?.end().catch(() => undefined);
    await insights?.end().catch(() => undefined);
  }
}

run().catch((error) => {
  console.error(`[ERROR] Insights-to-analyser migration failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
