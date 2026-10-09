const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const MIGRATIONS_DIRECTORY = path.join(__dirname, "migrations");
const MIGRATION_NAME_PATTERN = /^(\d+)_([a-z0-9_-]+)\.sql$/;
const ADVISORY_LOCK_ID = 1_382_374_716;

function getDatabaseConfig(prefix = "PG") {
  const config = {
    host: process.env[`${prefix}HOST`] || "127.0.0.1",
    port: Number(process.env[`${prefix}PORT`] || 5432),
    database: process.env[`${prefix}DATABASE`],
    user: process.env[`${prefix}USER`],
    password: process.env[`${prefix}PASSWORD`]
  };
  if (!config.database || !config.user || !config.password) {
    throw new Error(`Definí ${prefix}DATABASE, ${prefix}USER y ${prefix}PASSWORD.`);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("PGPORT debe ser un puerto válido.");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    throw new Error("El migrador solo admite una conexión a PostgreSQL local.");
  }
  return config;
}

async function loadMigrations() {
  const filenames = (await fs.readdir(MIGRATIONS_DIRECTORY))
    .filter((filename) => MIGRATION_NAME_PATTERN.test(filename))
    .sort((left, right) =>
      Number(MIGRATION_NAME_PATTERN.exec(left)[1]) -
      Number(MIGRATION_NAME_PATTERN.exec(right)[1])
    );
  const migrations = [];
  let previousVersion = 0;

  for (const filename of filenames) {
    const match = MIGRATION_NAME_PATTERN.exec(filename);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= previousVersion) {
      throw new Error(`Versión de migración inválida o duplicada: ${filename}`);
    }
    previousVersion = version;
    migrations.push({
      version,
      name: match[2],
      sql: await fs.readFile(path.join(MIGRATIONS_DIRECTORY, filename), "utf8")
    });
  }

  return migrations;
}

async function migrate(pool, migrations) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at_ms BIGINT NOT NULL
      )
    `);

    const columns = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
    `);
    const actualColumns = new Map(columns.rows.map((row) => [row.column_name, row.data_type]));
    const expectedColumns = new Map([
      ["version", "bigint"],
      ["name", "text"],
      ["applied_at_ms", "bigint"]
    ]);
    if (actualColumns.size !== expectedColumns.size ||
      [...expectedColumns].some(([name, type]) => actualColumns.get(name) !== type)) {
      throw new Error("La tabla schema_migrations no coincide con el formato esperado.");
    }

    const appliedResult = await client.query(
      "SELECT version, name FROM schema_migrations ORDER BY version"
    );
    const applied = new Map(appliedResult.rows.map((row) => [Number(row.version), row.name]));
    for (const [version, name] of applied) {
      const expected = migrations.find((migration) => migration.version === version);
      if (!expected || expected.name !== name) {
        throw new Error(`La migración aplicada ${version} (${name}) no coincide con los archivos disponibles.`);
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, applied_at_ms)
         VALUES ($1, $2, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)`,
        [migration.version, migration.name]
      );
      console.log(`Migración ${migration.version} (${migration.name}) aplicada.`);
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Falló la migración y no se pudo confirmar el rollback."
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const migrations = await loadMigrations();
  if (migrations.length === 0) throw new Error("No hay migraciones SQL para aplicar.");
  const pool = new Pool(getDatabaseConfig());
  try {
    await migrate(pool, migrations);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`No se pudieron aplicar las migraciones: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { getDatabaseConfig, loadMigrations, migrate };
