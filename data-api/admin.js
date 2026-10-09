const crypto = require("node:crypto");
const { Pool } = require("pg");
const { getDatabaseConfig } = require("./migrate");

async function initializeServer(pool, workspaceName, deviceName) {
  const workspaceId = crypto.randomUUID();
  const serverId = crypto.randomUUID();
  const code = crypto.randomBytes(32).toString("base64url");
  const codeHash = crypto.createHash("sha256").update(code).digest();
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT count(*)::int AS count FROM workspaces");
    if (existing.rows[0].count !== 0) {
      throw new Error("Este comando solo inicializa una base sin workspaces.");
    }
    await client.query(
      `INSERT INTO workspaces (workspace_id, server_id, name, created_at_ms)
       VALUES ($1, $2, $3, $4)`,
      [workspaceId, serverId, workspaceName, now]
    );
    await client.query(
      `INSERT INTO workspace_revisions (workspace_id, revision) VALUES ($1, 0)`,
      [workspaceId]
    );
    await client.query(
      `INSERT INTO extension_state_revisions (workspace_id, revision) VALUES ($1, 0)`,
      [workspaceId]
    );
    await client.query(
      `INSERT INTO enrollment_codes (
         code_hash, workspace_id, device_name, grants_workspace_admin, expires_at_ms
       ) VALUES ($1, $2, $3, TRUE, $4)`,
      [codeHash, workspaceId, deviceName, now + 20 * 60 * 1000]
    );
    await client.query("COMMIT");
    return { serverId, workspaceId, code };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Falló la inicialización y no se pudo confirmar el rollback.");
    }
    throw error;
  } finally {
    client.release();
  }
}

async function issueEnrollmentCode(pool, workspaceId, deviceName, grantsWorkspaceAdmin = false) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId) ||
    !deviceName || deviceName.length > 120) {
    throw new Error("El workspace o nombre del dispositivo no es válido.");
  }
  const code = crypto.randomBytes(32).toString("base64url");
  const codeHash = crypto.createHash("sha256").update(code).digest();
  const result = await pool.query(`
    INSERT INTO enrollment_codes (
      code_hash, workspace_id, device_name, grants_workspace_admin, expires_at_ms
    )
    SELECT $1, workspace_id, $3, $4, $5
    FROM workspaces WHERE workspace_id = $2
    RETURNING workspace_id
  `, [codeHash, workspaceId, deviceName, grantsWorkspaceAdmin, Date.now() + 20 * 60 * 1000]);
  if (result.rowCount !== 1) throw new Error("No existe el workspace solicitado.");
  return code;
}

async function main() {
  if (process.argv[2] === "keygen") {
    console.log(crypto.randomBytes(32).toString("base64"));
    return;
  }
  if (process.argv[2] === "enroll") {
    const workspaceId = process.env.DATA_WORKSPACE_ID;
    const deviceName = process.env.DATA_INITIAL_DEVICE_NAME;
    if (!workspaceId || !deviceName) {
      throw new Error("Definí DATA_WORKSPACE_ID y DATA_INITIAL_DEVICE_NAME.");
    }
    const pool = new Pool(getDatabaseConfig());
    try {
      const grantsWorkspaceAdmin = process.env.DATA_ENROLLMENT_ADMIN === "true";
      const code = await issueEnrollmentCode(pool, workspaceId, deviceName, grantsWorkspaceAdmin);
      console.log(`Código de enrolamiento válido por 20 minutos para ${deviceName}:`);
      console.log(code);
    } finally {
      await pool.end();
    }
    return;
  }
  if (process.argv[2] !== "init") {
    throw new Error("Uso: node admin.js keygen | init | enroll");
  }
  const workspaceName = process.env.DATA_WORKSPACE_NAME;
  const deviceName = process.env.DATA_INITIAL_DEVICE_NAME;
  if (!workspaceName || !deviceName ||
    workspaceName.length > 120 || deviceName.length > 120) {
    throw new Error("Definí DATA_WORKSPACE_NAME y DATA_INITIAL_DEVICE_NAME (máximo 120 caracteres).");
  }
  const pool = new Pool(getDatabaseConfig());
  try {
    const initialized = await initializeServer(pool, workspaceName, deviceName);
    console.log(`Servidor inicializado. server_id=${initialized.serverId}`);
    console.log(`workspace_id=${initialized.workspaceId}`);
    console.log("Código de enrolamiento válido por 20 minutos (mostrado una sola vez):");
    console.log(initialized.code);
    console.log("Guardá el código temporalmente; no lo compartas por canales inseguros.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`No se pudo inicializar el servidor: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { initializeServer, issueEnrollmentCode };
