import fs from "fs";
import path from "path";
import { Pool, type PoolClient } from "pg";

export type DatabaseDialect = "sqlite" | "postgres";

export type RunResult = {
  changes: number;
  lastInsertRowid?: number;
};

export type PreparedStatement = {
  get: (...params: any[]) => Promise<any>;
  all: (...params: any[]) => Promise<any[]>;
  run: (...params: any[]) => Promise<RunResult>;
};

export type DatabaseClient = {
  dialect: DatabaseDialect;
  prepare: (sql: string) => PreparedStatement;
  exec: (sql: string) => Promise<void>;
  ensureColumn: (tableName: string, columnName: string, definition: string) => Promise<void>;
  transaction: <T>(callback: (db: DatabaseClient) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

type CreateDatabaseOptions = {
  databasePath: string;
  databaseUrl?: string;
  provider?: string;
};

type SqliteDatabaseConstructor = typeof import("better-sqlite3").default;

type PostgresQueryable = {
  query: (text: string, params?: any[]) => Promise<any>;
};

type PostgresRootClient = PostgresQueryable & {
  connect?: () => Promise<PoolClient>;
  end?: () => Promise<void>;
};

const inferDialect = ({ databaseUrl, provider }: CreateDatabaseOptions): DatabaseDialect => {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "postgres" || normalizedProvider === "postgresql") return "postgres";
  if (normalizedProvider === "sqlite") return "sqlite";
  return databaseUrl ? "postgres" : "sqlite";
};

const replacePositionalParameters = (sql: string) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};

const adaptPostgresSql = (sql: string, mode: "get" | "all" | "run") => {
  let normalizedSql = sql.trim().replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");

  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql) && !/ON\s+CONFLICT/i.test(normalizedSql)) {
    normalizedSql = `${normalizedSql} ON CONFLICT DO NOTHING`;
  }

  normalizedSql = replacePositionalParameters(normalizedSql);

  if (mode === "run" && /^INSERT\s+INTO\s+/i.test(normalizedSql) && !/\bRETURNING\b/i.test(normalizedSql)) {
    normalizedSql = `${normalizedSql} RETURNING id`;
  }

  return normalizedSql;
};

const createPreparedStatement = (
  dialect: DatabaseDialect,
  executor: (sql: string, params: any[], mode: "get" | "all" | "run") => Promise<any>
) => (sql: string): PreparedStatement => ({
  get: (...params: any[]) => executor(sql, params, "get"),
  all: (...params: any[]) => executor(sql, params, "all"),
  run: (...params: any[]) => executor(sql, params, "run"),
});

const createSqliteClient = (Database: SqliteDatabaseConstructor, databasePath: string): DatabaseClient => {
  const databaseDir = path.dirname(databasePath);
  if (!fs.existsSync(databaseDir)) {
    fs.mkdirSync(databaseDir, { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");

  const client: DatabaseClient = {
    dialect: "sqlite",
    prepare: createPreparedStatement("sqlite", async (sql, params, mode) => {
      const statement = sqlite.prepare(sql);
      if (mode === "get") return statement.get(...params);
      if (mode === "all") return statement.all(...params);

      const result = statement.run(...params);
      return {
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    }),
    exec: async (sql: string) => {
      sqlite.exec(sql);
    },
    ensureColumn: async (tableName: string, columnName: string, definition: string) => {
      const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === columnName)) {
        sqlite.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
      }
    },
    transaction: async <T>(callback: (db: DatabaseClient) => Promise<T>) => {
      sqlite.exec("BEGIN");
      try {
        const result = await callback(client);
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: async () => {
      sqlite.close();
    },
  };

  return client;
};

const createPostgresAdapter = (clientProvider: () => PostgresQueryable): DatabaseClient => {
  const execute = async (sql: string, params: any[], mode: "get" | "all" | "run") => {
    const text = adaptPostgresSql(sql, mode);
    const result = await clientProvider().query(text, params);

    if (mode === "get") return result.rows[0];
    if (mode === "all") return result.rows;

    return {
      changes: result.rowCount || 0,
      lastInsertRowid: result.rows[0]?.id != null ? Number(result.rows[0].id) : undefined,
    };
  };

  return {
    dialect: "postgres",
    prepare: createPreparedStatement("postgres", execute),
    exec: async (sql: string) => {
      await clientProvider().query(sql);
    },
    ensureColumn: async (tableName: string, columnName: string, definition: string) => {
      const columnCheck = await clientProvider().query(
        `
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
          LIMIT 1
        `,
        [tableName, columnName]
      );

      if (columnCheck.rowCount) return;
      await clientProvider().query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    },
    transaction: async <T>(callback: (db: DatabaseClient) => Promise<T>) => {
      const pool = clientProvider() as PostgresRootClient;
      if (!pool.connect) {
        throw new Error("PostgreSQL transactions require a pool-backed client.");
      }

      const transactionClient = await pool.connect();
      try {
        await transactionClient.query("BEGIN");
        const transactionDb = createPostgresAdapter(() => transactionClient);
        const result = await callback(transactionDb);
        await transactionClient.query("COMMIT");
        return result;
      } catch (error) {
        await transactionClient.query("ROLLBACK");
        throw error;
      } finally {
        transactionClient.release();
      }
    },
    close: async () => {
      const pool = clientProvider() as PostgresRootClient;
      if (pool.end) {
        await pool.end();
      }
    },
  };
};

export const createDatabaseClient = async (options: CreateDatabaseOptions): Promise<DatabaseClient> => {
  const dialect = inferDialect(options);

  if (dialect === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    return createSqliteClient(Database, options.databasePath);
  }

  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL is required when DATABASE_PROVIDER is postgres.");
  }

  const pool = new Pool({
    connectionString: options.databaseUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });

  return createPostgresAdapter(() => pool);
};
