// api/_server.ts
import express from "express";
import fs2 from "fs";
import path2, { dirname } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import * as mammoth from "mammoth";

// api/_db.ts
import fs from "fs";
import path from "path";
import { Pool } from "pg";
var inferDialect = ({ databaseUrl: databaseUrl2, provider }) => {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "postgres" || normalizedProvider === "postgresql") return "postgres";
  if (normalizedProvider === "sqlite") return "sqlite";
  return databaseUrl2 ? "postgres" : "sqlite";
};
var replacePositionalParameters = (sql) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};
var adaptPostgresSql = (sql, mode) => {
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
var createPreparedStatement = (_dialect, executor) => (sql) => ({
  get: (...params) => executor(sql, params, "get"),
  all: (...params) => executor(sql, params, "all"),
  run: (...params) => executor(sql, params, "run")
});
var createSqliteClient = (Database, databasePath2) => {
  const databaseDir = path.dirname(databasePath2);
  if (!fs.existsSync(databaseDir)) {
    fs.mkdirSync(databaseDir, { recursive: true });
  }
  const sqlite = new Database(databasePath2);
  sqlite.pragma("foreign_keys = ON");
  const client = {
    dialect: "sqlite",
    prepare: createPreparedStatement("sqlite", async (sql, params, mode) => {
      const statement = sqlite.prepare(sql);
      if (mode === "get") return statement.get(...params);
      if (mode === "all") return statement.all(...params);
      const result = statement.run(...params);
      return {
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid)
      };
    }),
    exec: async (sql) => {
      sqlite.exec(sql);
    },
    ensureColumn: async (tableName, columnName, definition) => {
      const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all();
      if (!columns.some((column) => column.name === columnName)) {
        sqlite.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
      }
    },
    transaction: async (callback) => {
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
    }
  };
  return client;
};
var createPostgresAdapter = (clientProvider) => {
  const execute = async (sql, params, mode) => {
    const text = adaptPostgresSql(sql, mode);
    const result = await clientProvider().query(text, params);
    if (mode === "get") return result.rows[0];
    if (mode === "all") return result.rows;
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: result.rows[0]?.id != null ? Number(result.rows[0].id) : void 0
    };
  };
  return {
    dialect: "postgres",
    prepare: createPreparedStatement("postgres", execute),
    exec: async (sql) => {
      await clientProvider().query(sql);
    },
    ensureColumn: async (tableName, columnName, definition) => {
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
    transaction: async (callback) => {
      const pool = clientProvider();
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
      const pool = clientProvider();
      if (pool.end) {
        await pool.end();
      }
    }
  };
};
var createDatabaseClient = async (options) => {
  const dialect = inferDialect(options);
  if (dialect === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    return createSqliteClient(Database, options.databasePath);
  }
  if (!options.databaseUrl) {
    throw new Error("DATABASE_URL is required when DATABASE_PROVIDER is postgres.");
  }
  const cleanUrl = options.databaseUrl.replace(/([?&])sslmode=[^&]*/i, "$1").replace(/[?&]$/, "");
  const pool = new Pool({
    connectionString: cleanUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
  });
  return createPostgresAdapter(() => pool);
};

// api/_server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
dotenv.config();
var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
var JWT_SECRET = process.env.JWT_SECRET || "smart-campus-secret-key";
var GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
var isProduction = process.env.NODE_ENV === "production";
var isVercelRuntime = process.env.VERCEL === "1";
var defaultDatabasePath = isVercelRuntime ? path2.join("/tmp", "campus.db") : path2.join(process.cwd(), "campus.db");
var databasePath = process.env.DATABASE_PATH ? path2.resolve(process.env.DATABASE_PATH) : defaultDatabasePath;
var rawDatabaseProvider = process.env.DATABASE_PROVIDER || "";
var rawDatabaseUrl = process.env.DATABASE_URL || "";
var isLocalhostDatabaseUrl = /localhost|127\.0\.0\.1/.test(rawDatabaseUrl);
var databaseProvider = isVercelRuntime && isLocalhostDatabaseUrl ? "" : rawDatabaseProvider;
var databaseUrl = isVercelRuntime && isLocalhostDatabaseUrl ? "" : rawDatabaseUrl;
var APP_TIME_ZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
var normalizeOrigin = (value) => {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};
var allowedOrigins = new Set(
  [
    process.env.FRONTEND_ORIGIN,
    process.env.APP_URL,
    "https://yethish2010.github.io",
    "http://localhost:5173",
    "http://localhost:3000"
  ].map(normalizeOrigin).filter(Boolean)
);
var moduleLoadTelemetry = [];
var MAX_MODULE_LOAD_TELEMETRY = 250;
var normalizeRoleKey = (value) => value?.toString().trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") || "";
var ROLE_CANONICAL_LABELS = /* @__PURE__ */ new Map([
  ["administrator", "Administrator"],
  ["admin", "Admin"],
  ["master admin", "Master Admin"],
  ["vice chancellor", "Vice Chancellor"],
  ["pro chancellor", "Pro-Chancellor"],
  ["dean", "Dean"],
  ["dean (p&m)", "Dean (P&M)"],
  ["dean (p & m)", "Dean (P&M)"],
  ["deputy dean (p&m)", "Deputy Dean (P&M)"],
  ["deputy dean (p & m)", "Deputy Dean (P&M)"],
  ["hod", "HOD"],
  ["timetable coordinator", "Timetable Coordinator"],
  ["time table coordinator", "Timetable Coordinator"],
  ["event coordinator", "Event Coordinator"],
  ["faculty", "Faculty"],
  ["maintenance staff", "Maintenance Staff"],
  ["infrastructure manager", "Infrastructure Manager"]
]);
var normalizeRoleLabel = (value) => {
  const trimmed = value?.toString().trim() || "";
  if (!trimmed) return "";
  return ROLE_CANONICAL_LABELS.get(normalizeRoleKey(trimmed)) || trimmed;
};
var buildRoleSet = (roles) => new Set(roles.map((role) => normalizeRoleLabel(role)));
var ADMIN_ROLE_VALUES = buildRoleSet(["Administrator", "Admin", "Master Admin"]);
var EXECUTIVE_VIEW_ROLE_VALUES = buildRoleSet(["Vice Chancellor", "Pro-Chancellor"]);
var GLOBAL_SCOPE_ROLE_VALUES = buildRoleSet([
  "Administrator",
  "Admin",
  "Master Admin",
  "Vice Chancellor",
  "Pro-Chancellor",
  "Dean (P&M)",
  "Deputy Dean (P&M)"
]);
var SCHOOL_SCOPE_ROLE_VALUES = buildRoleSet(["Dean"]);
var DEPARTMENT_SCOPE_ROLE_VALUES = buildRoleSet(["HOD", "Timetable Coordinator", "Faculty", "Event Coordinator"]);
var isAdminRole = (role) => ADMIN_ROLE_VALUES.has(normalizeRoleLabel(role));
var isExecutiveViewRole = (role) => EXECUTIVE_VIEW_ROLE_VALUES.has(normalizeRoleLabel(role));
var USER_ROLE_OPTIONS = [
  "Administrator",
  "Admin",
  "Master Admin",
  "Vice Chancellor",
  "Pro-Chancellor",
  "Dean",
  "Dean (P&M)",
  "Deputy Dean (P&M)",
  "HOD",
  "Timetable Coordinator",
  "Event Coordinator",
  "Faculty",
  "Maintenance Staff",
  "Infrastructure Manager"
];
var USER_MANAGEMENT_ROLE_MATRIX = {
  "Master Admin": { creatableRoleSet: buildRoleSet(USER_ROLE_OPTIONS), scopedToDepartment: false },
  "Admin": { creatableRoleSet: buildRoleSet(USER_ROLE_OPTIONS.filter((role) => role !== "Master Admin")), scopedToDepartment: false },
  "Administrator": { creatableRoleSet: buildRoleSet(USER_ROLE_OPTIONS.filter((role) => role !== "Master Admin")), scopedToDepartment: false },
  "Dean (P&M)": {
    creatableRoleSet: buildRoleSet(["Dean", "Deputy Dean (P&M)", "HOD", "Timetable Coordinator", "Event Coordinator", "Faculty", "Maintenance Staff", "Infrastructure Manager"]),
    scopedToDepartment: false
  },
  "HOD": { creatableRoleSet: buildRoleSet(["Timetable Coordinator", "Event Coordinator"]), scopedToDepartment: true }
};
var getUserManagementPolicy = (user) => USER_MANAGEMENT_ROLE_MATRIX[normalizeRoleLabel(user?.role)] || null;
var DASHBOARD_VIEW_MODE_VALUES = /* @__PURE__ */ new Set(["Visual", "Text", "Hybrid"]);
var normalizeUserAccessTypeValue = (value) => {
  const normalized = value?.toString().trim().toLowerCase() || "";
  if (!normalized) return "";
  if (normalized === "global") return "Global";
  if (normalized === "school") return "School";
  if (normalized === "department") return "Department";
  if (normalized === "custom") return "Custom";
  return value?.toString().trim() || "";
};
var normalizeDashboardViewMode = (value) => {
  const normalized = value?.toString().trim().toLowerCase() || "";
  if (!normalized) return null;
  if (normalized === "visual") return "Visual";
  if (normalized === "text") return "Text";
  if (normalized === "hybrid") return "Hybrid";
  return null;
};
var getCampusDateTimeParts = (value = /* @__PURE__ */ new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(value);
  const readPart = (type) => parts.find((part) => part.type === type)?.value || "";
  return {
    date: `${readPart("year")}-${readPart("month")}-${readPart("day")}`,
    time: `${readPart("hour")}:${readPart("minute")}`
  };
};
var getPrimarySchemaSql = (dialect) => {
  const idDefinition = dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const timestampType = dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  return `
    CREATE TABLE IF NOT EXISTS users (
      id ${idDefinition},
      full_name TEXT NOT NULL,
      employee_id TEXT UNIQUE NOT NULL,
      school TEXT,
      department TEXT,
      designation TEXT,
      role TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      mobile_number TEXT,
      password TEXT NOT NULL,
      responsibilities TEXT,
      access_limits TEXT,
      access_type TEXT,
      access_scope TEXT,
      access_paths TEXT,
      dashboard_view_mode TEXT,
      force_password_change INTEGER DEFAULT 0,
      created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS campuses (
      id ${idDefinition},
      campus_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS buildings (
      id ${idDefinition},
      building_id TEXT UNIQUE NOT NULL,
      campus_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      structure_type TEXT DEFAULT 'direct',
      planned_block_count INTEGER DEFAULT 0,
      planned_floor_count INTEGER DEFAULT 0,
      first_floor_number INTEGER DEFAULT 0,
      description TEXT,
      FOREIGN KEY(campus_id) REFERENCES campuses(id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id ${idDefinition},
      block_id TEXT UNIQUE NOT NULL,
      building_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      planned_floor_count INTEGER DEFAULT 0,
      first_floor_number INTEGER DEFAULT 0,
      description TEXT,
      FOREIGN KEY(building_id) REFERENCES buildings(id)
    );

    CREATE TABLE IF NOT EXISTS floors (
      id ${idDefinition},
      floor_id TEXT UNIQUE NOT NULL,
      block_id INTEGER NOT NULL,
      floor_number INTEGER NOT NULL,
      description TEXT,
      FOREIGN KEY(block_id) REFERENCES blocks(id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id ${idDefinition},
      room_id TEXT UNIQUE NOT NULL,
      room_number TEXT NOT NULL,
      room_name TEXT,
      room_aliases TEXT,
      floor_id INTEGER NOT NULL,
      parent_room_id INTEGER,
      room_layout TEXT DEFAULT 'Normal',
      sub_room_count INTEGER,
      room_section_name TEXT,
      usage_category TEXT,
      is_bookable INTEGER DEFAULT 1,
      room_type TEXT NOT NULL,
      lab_name TEXT,
      restroom_type TEXT,
      capacity INTEGER NOT NULL,
      accessibility TEXT,
      status TEXT DEFAULT 'Available',
      FOREIGN KEY(floor_id) REFERENCES floors(id),
      FOREIGN KEY(parent_room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS schools (
      id ${idDefinition},
      school_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS departments (
      id ${idDefinition},
      department_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      school_id INTEGER NOT NULL,
      type TEXT,
      description TEXT,
      FOREIGN KEY(school_id) REFERENCES schools(id)
    );

    CREATE TABLE IF NOT EXISTS user_school_assignments (
      id ${idDefinition},
      user_id INTEGER NOT NULL,
      school_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 0,
      valid_from DATE,
      valid_until DATE,
      status TEXT DEFAULT 'Active',
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(school_id) REFERENCES schools(id)
    );

    CREATE TABLE IF NOT EXISTS user_department_assignments (
      id ${idDefinition},
      user_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      is_primary INTEGER DEFAULT 0,
      valid_from DATE,
      valid_until DATE,
      status TEXT DEFAULT 'Active',
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS department_allocations (
      id ${idDefinition},
      school_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      semester TEXT,
      room_type TEXT,
      capacity INTEGER,
      FOREIGN KEY(school_id) REFERENCES schools(id),
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS hod_room_allocations (
      id ${idDefinition},
      school_id INTEGER NOT NULL,
      hod_user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      semester TEXT,
      room_type TEXT,
      capacity INTEGER,
      notes TEXT,
      FOREIGN KEY(school_id) REFERENCES schools(id),
      FOREIGN KEY(hod_user_id) REFERENCES users(id),
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS timing_profiles (
      id ${idDefinition},
      profile_id TEXT UNIQUE NOT NULL,
      profile_name TEXT NOT NULL,
      school_id INTEGER,
      department_id INTEGER,
      program TEXT,
      specialization TEXT,
      academic_year TEXT,
      year_of_study TEXT,
      semester TEXT,
      section TEXT,
      working_days TEXT,
      slot_pattern TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY(school_id) REFERENCES schools(id),
      FOREIGN KEY(department_id) REFERENCES departments(id)
    );

    CREATE TABLE IF NOT EXISTS academic_calendars (
      id ${idDefinition},
      calendar_id TEXT UNIQUE NOT NULL,
      school_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      program TEXT,
      batch TEXT,
      specialization TEXT,
      academic_year TEXT,
      year_of_study TEXT,
      semester TEXT,
      timing_profile_id INTEGER,
      event_type TEXT,
      title TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT DEFAULT 'Upcoming',
      notes TEXT,
      FOREIGN KEY(school_id) REFERENCES schools(id),
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(timing_profile_id) REFERENCES timing_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS batch_room_allocations (
      id ${idDefinition},
      allocation_id TEXT UNIQUE NOT NULL,
      academic_calendar_id INTEGER,
      school_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      program TEXT,
      batch TEXT,
      specialization TEXT,
      academic_year TEXT,
      year_of_study TEXT,
      semester TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      allocation_mode TEXT DEFAULT 'Shared',
      allocation_pattern TEXT DEFAULT 'Single Room',
      split_group_id TEXT,
      room_type TEXT,
      capacity INTEGER,
      status TEXT DEFAULT 'Planned',
      notes TEXT,
      FOREIGN KEY(academic_calendar_id) REFERENCES academic_calendars(id),
      FOREIGN KEY(school_id) REFERENCES schools(id),
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id ${idDefinition},
      equipment_id TEXT UNIQUE NOT NULL,
      room_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      installation_date DATE,
      condition TEXT,
      maintenance_status TEXT,
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id ${idDefinition},
      schedule_id TEXT UNIQUE NOT NULL,
      schedule_code TEXT,
      session_group_id TEXT,
      department_id INTEGER,
      program TEXT,
      specialization TEXT,
      section TEXT,
      course_code TEXT,
      course_name TEXT,
      faculty TEXT,
      room_id INTEGER,
      room_label TEXT,
      day_of_week TEXT,
      start_time TEXT,
      end_time TEXT,
      student_count INTEGER,
      semester TEXT,
      import_status TEXT,
      review_note TEXT,
      source_file TEXT,
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id ${idDefinition},
      request_id TEXT UNIQUE NOT NULL,
      faculty_name TEXT NOT NULL,
      department_id INTEGER,
      event_name TEXT,
      student_count INTEGER,
      room_type TEXT,
      room_id INTEGER,
      equipment_required TEXT,
      purpose TEXT,
      notes TEXT,
      date DATE,
      start_time TEXT,
      end_time TEXT,
      status TEXT DEFAULT 'Pending',
      purpose_type TEXT DEFAULT 'Non-Academic',
      timing_override INTEGER DEFAULT 0,
      recommended_by TEXT,
      decided_by TEXT,
      request_group_id TEXT,
      FOREIGN KEY(department_id) REFERENCES departments(id),
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS maintenance (
      id ${idDefinition},
      maintenance_id TEXT UNIQUE NOT NULL,
      room_id INTEGER NOT NULL,
      equipment_name TEXT,
      issue_description TEXT,
      reported_date DATE,
      assigned_staff TEXT,
      status TEXT DEFAULT 'Pending',
      FOREIGN KEY(room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS reset_tokens (
      id ${idDefinition},
      email TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at ${timestampType} NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_room_id ON schedules(room_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_day_of_week ON schedules(day_of_week);
    CREATE INDEX IF NOT EXISTS idx_schedules_department_id ON schedules(department_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_floor_id ON rooms(floor_id);
    CREATE INDEX IF NOT EXISTS idx_batch_room_allocations_department_id ON batch_room_allocations(department_id);
    CREATE INDEX IF NOT EXISTS idx_batch_room_allocations_room_id ON batch_room_allocations(room_id);
    CREATE INDEX IF NOT EXISTS idx_department_allocations_room_id ON department_allocations(room_id);
    CREATE INDEX IF NOT EXISTS idx_department_allocations_department_id ON department_allocations(department_id);
    CREATE INDEX IF NOT EXISTS idx_hod_room_allocations_hod_user_id ON hod_room_allocations(hod_user_id);
    CREATE INDEX IF NOT EXISTS idx_hod_room_allocations_room_id ON hod_room_allocations(room_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_room_id ON bookings(room_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
  `;
};
if (process.env.DATABASE_RESET === "true" && (!databaseProvider || databaseProvider.trim().toLowerCase() === "sqlite") && !databaseUrl) {
  if (fs2.existsSync(databasePath)) {
    fs2.rmSync(databasePath);
    console.log(`DATABASE_RESET=true: deleted existing database at ${databasePath}`);
  }
}
var db;
var dbInitializationError = null;
var seedAdmin = async () => {
  const admin = await db.prepare("SELECT * FROM users WHERE role = 'Administrator'").get();
  if (!admin) {
    const hashedPassword = bcrypt.hashSync("admin123", 10);
    await db.prepare(`
      INSERT INTO users (full_name, employee_id, role, email, password)
      VALUES (?, ?, ?, ?, ?)
    `).run("Master Admin", "ADMIN001", "Administrator", "admin@smartcampus.ai", hashedPassword);
    console.log("Master Admin created: admin@smartcampus.ai / admin123");
  }
};
try {
  db = await createDatabaseClient({
    databasePath,
    databaseUrl,
    provider: databaseProvider
  });
  await db.exec(getPrimarySchemaSql(db.dialect));
  await seedAdmin();
} catch (err) {
  dbInitializationError = err?.message || "Database initialization failed";
  console.error("[Smart Campus] Database initialization failed:", dbInitializationError);
}
var ensureColumn = async (tableName, columnName, definition) => {
  await db.ensureColumn(tableName, columnName, definition);
};
var ensureBookingColumns = async () => {
  await ensureColumn("bookings", "purpose", "TEXT");
  await ensureColumn("bookings", "purpose_type", "TEXT DEFAULT 'Non-Academic'");
  await ensureColumn("bookings", "timing_override", "INTEGER DEFAULT 0");
  await ensureColumn("bookings", "notes", "TEXT");
  await ensureColumn("bookings", "recommended_by", "TEXT");
  await ensureColumn("bookings", "decided_by", "TEXT");
  await ensureColumn("bookings", "request_group_id", "TEXT");
  await ensureColumn("bookings", "request_type", "TEXT DEFAULT 'Department Room'");
  await ensureColumn("bookings", "required_capacity", "INTEGER");
  await ensureColumn("bookings", "preferred_building", "TEXT");
  await ensureColumn("bookings", "status_remark", "TEXT");
  await ensureColumn("bookings", "allocation_note", "TEXT");
};
var ensuredBookingColumnsPromise = null;
var ensureBookingColumnsReady = async () => {
  if (!ensuredBookingColumnsPromise) {
    ensuredBookingColumnsPromise = ensureBookingColumns().catch((error) => {
      ensuredBookingColumnsPromise = null;
      throw error;
    });
  }
  await ensuredBookingColumnsPromise;
};
await ensureBookingColumnsReady();
await ensureColumn("buildings", "structure_type", "TEXT DEFAULT 'direct'");
await ensureColumn("buildings", "planned_block_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "first_floor_number", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "first_floor_number", "INTEGER DEFAULT 0");
await ensureColumn("department_allocations", "hod_user_id", "INTEGER");
await ensureColumn("rooms", "parent_room_id", "INTEGER");
await ensureColumn("rooms", "room_layout", "TEXT DEFAULT 'Normal'");
await ensureColumn("rooms", "room_aliases", "TEXT");
await ensureColumn("rooms", "room_name", "TEXT");
await ensureColumn("rooms", "sub_room_count", "INTEGER");
await ensureColumn("rooms", "room_section_name", "TEXT");
await ensureColumn("rooms", "usage_category", "TEXT");
await ensureColumn("rooms", "is_bookable", "INTEGER DEFAULT 1");
await ensureColumn("rooms", "lab_name", "TEXT");
await ensureColumn("rooms", "restroom_type", "TEXT");
await ensureColumn("schedules", "room_label", "TEXT");
await ensureColumn("schedules", "section", "TEXT");
await ensureColumn("schedules", "specialization", "TEXT");
await ensureColumn("schedules", "program", "TEXT");
await ensureColumn("schedules", "semester", "TEXT");
await ensureColumn("schedules", "year_of_study", "TEXT");
await ensureColumn("schedules", "import_status", "TEXT");
await ensureColumn("schedules", "review_note", "TEXT");
await ensureColumn("schedules", "schedule_code", "TEXT");
await ensureColumn("schedules", "source_file", "TEXT");
await ensureColumn("schedules", "session_group_id", "TEXT");
await ensureColumn("users", "responsibilities", "TEXT");
await ensureColumn("users", "access_limits", "TEXT");
await ensureColumn("users", "school", "TEXT");
await ensureColumn("users", "access_type", "TEXT");
await ensureColumn("users", "access_scope", "TEXT");
await ensureColumn("users", "access_paths", "TEXT");
await ensureColumn("users", "dashboard_view_mode", "TEXT");
await ensureColumn("users", "force_password_change", "INTEGER DEFAULT 0");
await ensureColumn("bookings", "requester_user_id", "INTEGER");
await ensureColumn("user_school_assignments", "is_primary", "INTEGER DEFAULT 0");
await ensureColumn("user_school_assignments", "valid_from", "DATE");
await ensureColumn("user_school_assignments", "valid_until", "DATE");
await ensureColumn("user_school_assignments", "status", "TEXT DEFAULT 'Active'");
await ensureColumn("user_department_assignments", "is_primary", "INTEGER DEFAULT 0");
await ensureColumn("user_department_assignments", "valid_from", "DATE");
await ensureColumn("user_department_assignments", "valid_until", "DATE");
await ensureColumn("user_department_assignments", "status", "TEXT DEFAULT 'Active'");
await ensureColumn("batch_room_allocations", "allocation_mode", "TEXT DEFAULT 'Shared'");
await ensureColumn("batch_room_allocations", "allocation_pattern", "TEXT DEFAULT 'Single Room'");
await ensureColumn("batch_room_allocations", "split_group_id", "TEXT");
await ensureColumn("academic_calendars", "timing_profile_id", "INTEGER");
await ensureColumn("timing_profiles", "specialization", "TEXT");
await ensureColumn("academic_calendars", "specialization", "TEXT");
await ensureColumn("batch_room_allocations", "specialization", "TEXT");
var normalizeStatusValue = (value) => value?.toString().trim().toLowerCase() || "";
var getCurrentScopedDate = () => getCampusDateTimeParts().date || (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
var isAssignmentActive = (assignment, today = getCurrentScopedDate()) => {
  const status = normalizeStatusValue(assignment?.status);
  if (status && !["active", "current"].includes(status)) return false;
  const validFrom = assignment?.valid_from?.toString().trim();
  const validUntil = assignment?.valid_until?.toString().trim();
  if (validFrom && validFrom > today) return false;
  if (validUntil && validUntil < today) return false;
  return true;
};
var getSchoolAssignmentsForUser = async (userId) => {
  const assignments = await db.prepare(`
    SELECT
      usa.*,
      s.name as school_name,
      s.school_id as school_code
    FROM user_school_assignments usa
    JOIN schools s ON usa.school_id = s.id
    WHERE usa.user_id = ?
    ORDER BY usa.is_primary DESC, usa.id ASC
  `).all(userId);
  const today = getCurrentScopedDate();
  return assignments.filter((assignment) => isAssignmentActive(assignment, today));
};
var getDepartmentAssignmentsForUser = async (userId) => {
  const assignments = await db.prepare(`
    SELECT
      uda.*,
      d.name as department_name,
      d.department_id as department_code,
      d.school_id as school_id
    FROM user_department_assignments uda
    JOIN departments d ON uda.department_id = d.id
    WHERE uda.user_id = ?
    ORDER BY uda.is_primary DESC, uda.id ASC
  `).all(userId);
  const today = getCurrentScopedDate();
  return assignments.filter((assignment) => isAssignmentActive(assignment, today));
};
var resolvePrimaryAssignment = (assignments) => assignments.find((assignment) => Number(assignment?.is_primary) === 1) || assignments[0] || null;
var ensureUserSchoolAssignments = async (user) => {
  if (!user?.id) return [];
  let assignments = await getSchoolAssignmentsForUser(user.id);
  if (assignments.length > 0) return assignments;
  const legacySchool = user.school?.toString().trim();
  if (!legacySchool) return [];
  const school = await db.prepare(`
    SELECT id, name, school_id
    FROM schools
    WHERE CAST(id AS TEXT) = ?
       OR LOWER(TRIM(school_id)) = LOWER(TRIM(?))
       OR LOWER(TRIM(name)) = LOWER(TRIM(?))
  `).get(legacySchool, legacySchool, legacySchool);
  if (!school) return [];
  await db.prepare(`
    INSERT INTO user_school_assignments (user_id, school_id, is_primary, status)
    VALUES (?, ?, 1, 'Active')
  `).run(user.id, school.id);
  assignments = await getSchoolAssignmentsForUser(user.id);
  return assignments;
};
var buildUserSchoolContext = async (user) => {
  const assignments = await ensureUserSchoolAssignments(user);
  const primaryAssignment = resolvePrimaryAssignment(assignments);
  const assignedSchoolIds = assignments.map((assignment) => assignment.school_id?.toString()).filter(Boolean);
  const assignedSchoolNames = assignments.map((assignment) => assignment.school_name?.toString().trim()).filter(Boolean);
  return {
    assignments,
    primaryAssignment,
    primarySchoolId: primaryAssignment?.school_id?.toString() || null,
    primarySchoolName: primaryAssignment?.school_name || user.school || null,
    assignedSchoolIds,
    assignedSchoolNames
  };
};
var ensureUserDepartmentAssignments = async (user) => {
  if (!user?.id) return [];
  let assignments = await getDepartmentAssignmentsForUser(user.id);
  if (assignments.length > 0) return assignments;
  const legacyDepartment = user.department?.toString().trim();
  if (!legacyDepartment) return [];
  const department = await db.prepare(`
    SELECT id, name, department_id, school_id
    FROM departments
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
  `).get(legacyDepartment);
  if (!department) return [];
  await db.prepare(`
    INSERT INTO user_department_assignments (user_id, department_id, is_primary, status)
    VALUES (?, ?, 1, 'Active')
  `).run(user.id, department.id);
  assignments = await getDepartmentAssignmentsForUser(user.id);
  return assignments;
};
var buildUserDepartmentContext = async (user) => {
  const assignments = await ensureUserDepartmentAssignments(user);
  const primaryAssignment = resolvePrimaryAssignment(assignments);
  const assignedDepartmentIds = assignments.map((assignment) => assignment.department_id?.toString()).filter(Boolean);
  const assignedDepartmentNames = assignments.map((assignment) => assignment.department_name?.toString().trim()).filter(Boolean);
  return {
    assignments,
    primaryAssignment,
    primaryDepartmentId: primaryAssignment?.department_id?.toString() || null,
    primaryDepartmentName: primaryAssignment?.department_name || user.department || null,
    assignedDepartmentIds,
    assignedDepartmentNames
  };
};
var parseDelimitedValues = (value) => {
  if (Array.isArray(value)) return value.map((item) => item?.toString().trim()).filter(Boolean);
  return value?.toString().split(/[;,]/).map((item) => item.trim()).filter(Boolean) || [];
};
var getTargetDepartmentIdsFromPayload = (payload) => Array.from(new Set([
  ...parseDelimitedValues(payload?.assigned_department_ids),
  payload?.primary_department_id?.toString?.() || "",
  payload?.department_id?.toString?.() || ""
].filter(Boolean)));
var getTargetDepartmentIdsFromUserRecord = async (user) => {
  const context = await buildUserDepartmentContext(user);
  return Array.from(new Set([
    ...context.assignedDepartmentIds,
    context.primaryDepartmentId || ""
  ].filter(Boolean)));
};
var getScopedActorDepartmentIds = (user) => Array.from(getAccessibleDepartmentIdSet(user)).map((departmentId) => departmentId?.toString?.() || "").filter(Boolean);
var canActorManageExistingUser = async (actor, targetUser) => {
  const policy = getUserManagementPolicy(actor);
  if (!policy || !targetUser) return false;
  const targetRole = normalizeRoleLabel(targetUser.role);
  if (!policy.creatableRoleSet.has(targetRole)) return false;
  if (!policy.scopedToDepartment) return true;
  const actorDepartmentIds = getScopedActorDepartmentIds(actor);
  const targetDepartmentIds = await getTargetDepartmentIdsFromUserRecord(targetUser);
  return targetDepartmentIds.length > 0 && targetDepartmentIds.some((departmentId) => actorDepartmentIds.includes(departmentId));
};
var assertActorCanManageUserPayload = async (actor, payload, existingUser) => {
  const policy = getUserManagementPolicy(actor);
  if (!policy) {
    throw new Error("You do not have permission to manage users.");
  }
  const targetRole = normalizeRoleLabel(payload?.role || existingUser?.role);
  if (!policy.creatableRoleSet.has(targetRole)) {
    throw new Error("You can only create or manage subordinate roles allowed for your account.");
  }
  if (!policy.scopedToDepartment) return;
  const actorDepartmentIds = getScopedActorDepartmentIds(actor);
  const targetDepartmentIds = getTargetDepartmentIdsFromPayload(payload);
  if (targetDepartmentIds.length === 0 || !targetDepartmentIds.some((departmentId) => actorDepartmentIds.includes(departmentId))) {
    throw new Error("You can manage users only inside your assigned department.");
  }
};
var buildUserManagementRow = async (user) => {
  const sessionUser = await getUserSessionPayload(user);
  return {
    ...user,
    role: normalizeRoleLabel(user?.role),
    school: sessionUser.school || null,
    primary_school_id: sessionUser.primary_school_id,
    primary_school: sessionUser.primary_school,
    assigned_school_ids: sessionUser.assigned_school_ids.join(","),
    assigned_schools: sessionUser.assigned_schools.join(", "),
    department: sessionUser.department || null,
    primary_department_id: sessionUser.primary_department_id,
    primary_department: sessionUser.primary_department,
    assigned_department_ids: sessionUser.assigned_department_ids.join(","),
    assigned_departments: sessionUser.assigned_departments.join(", ")
  };
};
var resolveSchoolRecordsFromValues = async (values) => {
  const resolvedSchools = [];
  for (const value of values) {
    const school = await db.prepare(`
      SELECT id, name, school_id
      FROM schools
      WHERE CAST(id AS TEXT) = ?
         OR LOWER(TRIM(school_id)) = LOWER(TRIM(?))
         OR LOWER(TRIM(name)) = LOWER(TRIM(?))
    `).get(value, value, value);
    if (!school) {
      throw new Error(`Could not match school assignment "${value}".`);
    }
    if (!resolvedSchools.some((item) => item.id === school.id)) {
      resolvedSchools.push(school);
    }
  }
  return resolvedSchools;
};
var resolveDepartmentRecordsFromValues = async (values) => {
  const resolvedDepartments = [];
  for (const value of values) {
    const department = await db.prepare(`
      SELECT id, name, department_id, school_id
      FROM departments
      WHERE CAST(id AS TEXT) = ?
         OR LOWER(TRIM(department_id)) = LOWER(TRIM(?))
         OR LOWER(TRIM(name)) = LOWER(TRIM(?))
    `).get(value, value, value);
    if (!department) {
      throw new Error(`Could not match department assignment "${value}".`);
    }
    if (!resolvedDepartments.some((item) => item.id === department.id)) {
      resolvedDepartments.push(department);
    }
  }
  return resolvedDepartments;
};
var syncUserSchoolAssignments = async (userId, payload) => {
  const explicitIds = parseDelimitedValues(payload.assigned_school_ids);
  const explicitNames = parseDelimitedValues(payload.assigned_schools);
  const legacySchool = payload.school?.toString().trim();
  const primaryCandidate = payload.primary_school_id?.toString().trim() || payload.primary_school?.toString().trim() || payload.school?.toString().trim() || "";
  const requestedValues = Array.from(/* @__PURE__ */ new Set([
    ...explicitIds,
    ...explicitNames,
    ...legacySchool ? [legacySchool] : []
  ]));
  if (requestedValues.length === 0) {
    await db.prepare("DELETE FROM user_school_assignments WHERE user_id = ?").run(userId);
    return [];
  }
  const resolvedAssignments = await resolveSchoolRecordsFromValues(requestedValues);
  let primarySchoolId = resolvedAssignments[0]?.id || null;
  if (primaryCandidate) {
    const normalizedPrimaryCandidate = primaryCandidate.toLowerCase();
    const matchedPrimary = resolvedAssignments.find(
      (school) => school.id?.toString() === primaryCandidate || school.school_id?.toString().trim().toLowerCase() === normalizedPrimaryCandidate || school.name?.toString().trim().toLowerCase() === normalizedPrimaryCandidate
    );
    if (matchedPrimary) primarySchoolId = matchedPrimary.id;
  }
  await db.prepare("DELETE FROM user_school_assignments WHERE user_id = ?").run(userId);
  for (const school of resolvedAssignments) {
    await db.prepare(`
      INSERT INTO user_school_assignments (user_id, school_id, is_primary, status)
      VALUES (?, ?, ?, 'Active')
    `).run(userId, school.id, school.id === primarySchoolId ? 1 : 0);
  }
  return getSchoolAssignmentsForUser(userId);
};
var syncUserDepartmentAssignments = async (userId, payload) => {
  const explicitIds = parseDelimitedValues(payload.assigned_department_ids);
  const explicitNames = parseDelimitedValues(payload.assigned_departments);
  const legacyDepartment = payload.department?.toString().trim();
  const primaryCandidate = payload.primary_department_id?.toString().trim() || payload.primary_department?.toString().trim() || payload.department?.toString().trim() || "";
  const requestedValues = Array.from(/* @__PURE__ */ new Set([
    ...explicitIds,
    ...explicitNames,
    ...legacyDepartment ? [legacyDepartment] : []
  ]));
  if (requestedValues.length === 0) {
    await db.prepare("DELETE FROM user_department_assignments WHERE user_id = ?").run(userId);
    return [];
  }
  const resolvedAssignments = await resolveDepartmentRecordsFromValues(requestedValues);
  let primaryDepartmentId = resolvedAssignments[0]?.id || null;
  if (primaryCandidate) {
    const matchedPrimary = resolvedAssignments.find(
      (department) => department.id?.toString() === primaryCandidate || department.department_id?.toString().trim().toLowerCase() === primaryCandidate.toLowerCase() || department.name?.toString().trim().toLowerCase() === primaryCandidate.toLowerCase()
    );
    if (matchedPrimary) primaryDepartmentId = matchedPrimary.id;
  }
  await db.prepare("DELETE FROM user_department_assignments WHERE user_id = ?").run(userId);
  for (const department of resolvedAssignments) {
    await db.prepare(`
      INSERT INTO user_department_assignments (user_id, department_id, is_primary, status)
      VALUES (?, ?, ?, 'Active')
    `).run(userId, department.id, department.id === primaryDepartmentId ? 1 : 0);
  }
  return getDepartmentAssignmentsForUser(userId);
};
var ROOM_TYPE_MATCH_ORDER = [
  "Admin Office",
  "Auditorium",
  "Board Room",
  "Cafeteria",
  "Classroom",
  "Classroom Lab",
  "Common Room",
  "Computer Lab",
  "Conference Room",
  "Corridor",
  "Dean Office",
  "Electrical Room",
  "Emergency Exit",
  "Entrance",
  "Exam Hall",
  "Examination Section",
  "Exit",
  "Faculty Room",
  "Gym",
  "HOD Cabin",
  "Lab",
  "Language Lab",
  "Lecture Hall",
  "Library",
  "Lounge",
  "Main Entrance",
  "Maintenance Room",
  "Medical Room",
  "Meeting Room",
  "Multipurpose Classroom",
  "Multipurpose Lab",
  "Multipurpose Lecture Hall",
  "Multipurpose Room",
  "Office",
  "Pantry",
  "Reading Room",
  "Reception",
  "Records Room",
  "Research Lab",
  "Restroom",
  "Security Room",
  "Seminar Hall",
  "Server Room",
  "Smart Classroom",
  "Sports Room",
  "Staff Room",
  "Staircase",
  "Store",
  "Studio",
  "Tutorial Room",
  "Utility",
  "Waiting Area",
  "Workshop"
].sort((left, right) => right.toLowerCase().length - left.toLowerCase().length);
var normalizeRoomTypeValue = (value) => {
  const normalized = value?.toString().trim().toLowerCase();
  if (!normalized) return "";
  if (["class", "classroom", "classrooms", "class room", "class rooms"].includes(normalized)) return "Classroom";
  if (["smart class", "smart classroom"].includes(normalized)) return "Smart Classroom";
  if (["lecture theatre", "lecture theater", "lecture hall"].includes(normalized)) return "Lecture Hall";
  if (["tutorial", "tutorial room"].includes(normalized)) return "Tutorial Room";
  if (["auditorium", "auditoriums"].includes(normalized)) return "Auditorium";
  if (["exam hall", "examination hall"].includes(normalized)) return "Exam Hall";
  if (["multipurpose room", "multi purpose room", "multi-purpose room", "multipurpose hall", "multi purpose hall", "multi-purpose hall"].includes(normalized)) return "Multipurpose Room";
  if (["multipurpose classroom", "multi purpose classroom", "multi-purpose classroom"].includes(normalized)) return "Multipurpose Classroom";
  if (["multipurpose lecture hall", "multi purpose lecture hall", "multi-purpose lecture hall", "lecture hall lab", "lecture hall/lab"].includes(normalized)) return "Multipurpose Lecture Hall";
  if (["classroom lab", "classroom laboratory", "classroom cum lab", "classroom/lab", "class room lab", "class room laboratory"].includes(normalized)) return "Classroom Lab";
  if (["multipurpose lab", "multi purpose lab", "multi-purpose lab"].includes(normalized)) return "Multipurpose Lab";
  if (normalized === "restroom" || normalized === "restrooms") return "Restroom";
  if (normalized === "lab" || normalized === "laboratory") return "Lab";
  if (["computer lab", "computer laboratory"].includes(normalized)) return "Computer Lab";
  if (["research lab", "research laboratory"].includes(normalized)) return "Research Lab";
  if (["language lab", "language laboratory"].includes(normalized)) return "Language Lab";
  if (["reading room", "reading hall"].includes(normalized)) return "Reading Room";
  if (["faculty room", "faculty cabin"].includes(normalized)) return "Faculty Room";
  if (["staff room"].includes(normalized)) return "Staff Room";
  if (["hod cabin", "hod room", "head room"].includes(normalized)) return "HOD Cabin";
  if (["dean office", "dean room"].includes(normalized)) return "Dean Office";
  if (["admin office", "administration office"].includes(normalized)) return "Admin Office";
  if (["examination section", "exam section", "examination cell", "exam cell"].includes(normalized)) return "Examination Section";
  if (["entrance", "entry", "entry point"].includes(normalized)) return "Entrance";
  if (["main entrance", "main entry"].includes(normalized)) return "Main Entrance";
  if (["emergency exit", "fire exit"].includes(normalized)) return "Emergency Exit";
  if (["exit", "exit point"].includes(normalized)) return "Exit";
  if (["corridor", "passage", "passageway"].includes(normalized)) return "Corridor";
  if (["staircase", "stairs", "stairway"].includes(normalized)) return "Staircase";
  if (["meeting room"].includes(normalized)) return "Meeting Room";
  if (["board room", "boardroom"].includes(normalized)) return "Board Room";
  if (["waiting area", "waiting room"].includes(normalized)) return "Waiting Area";
  if (["common room"].includes(normalized)) return "Common Room";
  if (["store", "store room", "storage room"].includes(normalized)) return "Store";
  if (["records room", "record room"].includes(normalized)) return "Records Room";
  if (["server room"].includes(normalized)) return "Server Room";
  if (["electrical room", "electric room"].includes(normalized)) return "Electrical Room";
  if (["maintenance room"].includes(normalized)) return "Maintenance Room";
  if (["medical room", "sick room", "first aid room"].includes(normalized)) return "Medical Room";
  if (["security room", "guard room"].includes(normalized)) return "Security Room";
  if (["sports room", "sports hall"].includes(normalized)) return "Sports Room";
  const prefixedMatch = ROOM_TYPE_MATCH_ORDER.find((option) => {
    const normalizedOption = option.toLowerCase();
    return normalized === normalizedOption || normalized.startsWith(`${normalizedOption} -`) || normalized.startsWith(`${normalizedOption}:`) || normalized.startsWith(`${normalizedOption}/`);
  });
  if (prefixedMatch) return prefixedMatch;
  return value?.toString().trim() || "";
};
var normalizeRestroomTypeValue = (value) => {
  const normalized = value?.toString().trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "male" || normalized === "boys" || normalized === "men") return "Male";
  if (normalized === "female" || normalized === "girls" || normalized === "women") return "Female";
  return value?.toString().trim() || "";
};
var normalizeRoomLayoutValue = (value) => {
  const normalized = value?.toString().trim().toLowerCase();
  if (!normalized) return "Normal";
  if (["split parent", "split room", "split"].includes(normalized)) return "Split Parent";
  if (["split child", "split section", "section"].includes(normalized)) return "Split Child";
  if (["inside parent", "room inside", "contains room", "room inside parent"].includes(normalized)) return "Inside Parent";
  if (["inside child", "inside room", "child room"].includes(normalized)) return "Inside Child";
  if (["shared", "shared room", "multi entrance room", "multi-entrance room", "multiple entrance room", "multiple door room", "multi door room", "multi-door room"].includes(normalized)) return "Shared Room";
  return ["Normal", "Shared Room", "Split Parent", "Split Child", "Inside Parent", "Inside Child"].find((option) => option.toLowerCase() === normalized) || value?.toString().trim() || "Normal";
};
var HIERARCHY_PARENT_ROOM_LAYOUTS = ["Split Parent", "Inside Parent"];
var HIERARCHY_CHILD_ROOM_LAYOUTS = ["Split Child", "Inside Child"];
var HIERARCHY_ROOM_LAYOUTS = [...HIERARCHY_PARENT_ROOM_LAYOUTS, ...HIERARCHY_CHILD_ROOM_LAYOUTS];
var PRIVATE_ATTACHED_RESTROOM_PARENT_TYPES = /* @__PURE__ */ new Set([
  "HOD Cabin",
  "Dean Office",
  "Faculty Room",
  "Staff Room"
]);
var normalizeUsageCategoryValue = (value, roomType) => {
  const normalized = value?.toString().trim().toLowerCase();
  const options = ["Access", "Administration", "Dining", "Examination", "Healthcare", "Lab Work", "Meeting", "Multipurpose", "Office", "Restricted", "Restroom", "Security", "Sports", "Storage", "Teaching", "Utility"];
  if (normalized) {
    if (["exam", "exams", "examination", "examination section", "exam section", "examination cell", "exam cell"].includes(normalized)) return "Examination";
    return options.find((option) => option.toLowerCase() === normalized) || value?.toString().trim() || null;
  }
  const normalizedRoomType = normalizeRoomTypeValue(roomType);
  if (["Multipurpose Room", "Multipurpose Classroom", "Multipurpose Lecture Hall", "Classroom Lab", "Multipurpose Lab"].includes(normalizedRoomType)) return "Multipurpose";
  if (["Lab", "Computer Lab", "Research Lab", "Language Lab", "Workshop", "Studio"].includes(normalizedRoomType)) return "Lab Work";
  if (["Classroom", "Smart Classroom", "Lecture Hall", "Tutorial Room", "Seminar Hall", "Auditorium", "Exam Hall", "Library", "Reading Room"].includes(normalizedRoomType)) return "Teaching";
  if (["Conference Room", "Meeting Room", "Board Room"].includes(normalizedRoomType)) return "Meeting";
  if (["Office", "Faculty Room", "Staff Room", "HOD Cabin", "Dean Office"].includes(normalizedRoomType)) return "Office";
  if (normalizedRoomType === "Examination Section") return "Examination";
  if (["Admin Office", "Reception", "Waiting Area"].includes(normalizedRoomType)) return "Administration";
  if (["Entrance", "Main Entrance", "Emergency Exit", "Exit", "Corridor", "Staircase"].includes(normalizedRoomType)) return "Access";
  if (["Store", "Records Room"].includes(normalizedRoomType)) return "Storage";
  if (normalizedRoomType === "Restroom") return "Restroom";
  if (["Utility", "Server Room", "Electrical Room", "Maintenance Room"].includes(normalizedRoomType)) return "Utility";
  if (["Pantry", "Cafeteria"].includes(normalizedRoomType)) return "Dining";
  if (normalizedRoomType === "Medical Room") return "Healthcare";
  if (["Sports Room", "Gym"].includes(normalizedRoomType)) return "Sports";
  if (normalizedRoomType === "Security Room") return "Security";
  return null;
};
var normalizeBooleanLikeValue = (value, defaultValue = true) => {
  if (value === void 0 || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = value?.toString().trim().toLowerCase();
  if (["yes", "y", "true", "1", "bookable", "available"].includes(normalized)) return true;
  if (["no", "n", "false", "0", "not bookable", "internal only", "internal"].includes(normalized)) return false;
  return defaultValue;
};
var NON_CAPACITY_ROOM_TYPE_VALUES = [
  "Office",
  "Faculty Room",
  "Staff Room",
  "HOD Cabin",
  "Dean Office",
  "Admin Office",
  "Examination Section",
  "Reception",
  "Library",
  "Reading Room",
  "Waiting Area",
  "Common Room",
  "Lounge",
  "Pantry",
  "Cafeteria",
  "Store",
  "Records Room",
  "Server Room",
  "Electrical Room",
  "Maintenance Room",
  "Utility",
  "Restroom",
  "Medical Room",
  "Security Room",
  "Entrance",
  "Main Entrance",
  "Emergency Exit",
  "Exit",
  "Corridor",
  "Staircase"
];
var isNonCapacityRoomType = (roomType) => NON_CAPACITY_ROOM_TYPE_VALUES.includes(normalizeRoomTypeValue(roomType));
var CAPACITY_ROOM_TYPE_VALUES = [
  "Classroom",
  "Smart Classroom",
  "Lecture Hall",
  "Tutorial Room",
  "Seminar Hall",
  "Conference Room",
  "Auditorium",
  "Exam Hall",
  "Multipurpose Room",
  "Multipurpose Classroom",
  "Multipurpose Lecture Hall",
  "Classroom Lab",
  "Multipurpose Lab",
  "Lab",
  "Computer Lab",
  "Research Lab",
  "Language Lab",
  "Workshop",
  "Studio",
  "Meeting Room",
  "Board Room",
  "Sports Room",
  "Gym"
];
var isCapacityRoomType = (roomType) => CAPACITY_ROOM_TYPE_VALUES.includes(normalizeRoomTypeValue(roomType));
var BOOKABLE_ROOM_TYPE_VALUES = [
  "Classroom",
  "Smart Classroom",
  "Lecture Hall",
  "Tutorial Room",
  "Seminar Hall",
  "Conference Room",
  "Auditorium",
  "Exam Hall",
  "Multipurpose Room",
  "Multipurpose Classroom",
  "Multipurpose Lecture Hall",
  "Classroom Lab",
  "Multipurpose Lab",
  "Lab",
  "Computer Lab",
  "Research Lab",
  "Language Lab",
  "Workshop",
  "Studio",
  "Meeting Room",
  "Board Room",
  "Sports Room",
  "Gym"
];
var BOOKABLE_USAGE_CATEGORY_VALUES = ["Teaching", "Lab Work", "Multipurpose", "Meeting"];
var ROOM_ALIAS_PLACEHOLDER_VALUES = /* @__PURE__ */ new Set(["-", "--", "---", "n/a", "na", "none", "null", "nil"]);
var normalizeRoomAliases = (value) => Array.from(new Set(
  value?.toString().split(/[\n,;|/]+/).map((alias) => alias.trim()).filter((alias) => alias.length > 0 && !ROOM_ALIAS_PLACEHOLDER_VALUES.has(normalizeDuplicateValue(alias))) || []
)).join(", ");
var getRoomAliasTokens = (value) => normalizeRoomAliases(value).split(",").map((alias) => normalizeDuplicateValue(alias)).filter(Boolean);
var normalizeRoomLookupValue = (value) => value?.toString().trim().toLowerCase().replace(/\s+/g, " ") || "";
var getRoomLookupVariants = (value) => {
  const base = normalizeRoomLookupValue(value);
  if (!base) return [];
  const variants = /* @__PURE__ */ new Set([base]);
  const withoutPrefix = base.replace(/\b(?:room|r)\s*\.?\s*(?:no|number)?\.?\s*[:\-]?\s*/g, "").trim();
  if (withoutPrefix) {
    variants.add(withoutPrefix);
  }
  const normalizedSeparators = withoutPrefix.replace(/\s*&\s*/g, " & ").replace(/\s*\/\s*/g, "/").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
  if (normalizedSeparators) {
    variants.add(normalizedSeparators);
  }
  const compact = normalizedSeparators.replace(/[^a-z0-9]/g, "");
  if (compact.length >= 3) {
    variants.add(compact);
  }
  const withoutLeadingZeros = normalizedSeparators.match(/^0*(\d+[a-z]?)$/i)?.[1]?.toLowerCase();
  if (withoutLeadingZeros) {
    variants.add(withoutLeadingZeros);
  }
  return Array.from(variants).filter(Boolean);
};
var getAvailabilityRoomLookupVariants = (room) => {
  const variants = /* @__PURE__ */ new Set();
  [
    room?.room_id,
    room?.room_number,
    room?.room_name,
    room?.lab_name,
    room?.room_section_name,
    ...getRoomAliasTokens(room?.room_aliases) || []
  ].forEach((value) => {
    getRoomLookupVariants(value).forEach((variant) => variants.add(variant));
  });
  return variants;
};
var normalizeRoomPayload = (payload) => {
  const nextPayload = { ...payload };
  nextPayload.room_type = normalizeRoomTypeValue(nextPayload.room_type);
  nextPayload.room_aliases = normalizeRoomAliases(nextPayload.room_aliases) || null;
  nextPayload.room_name = nextPayload.room_name?.toString().trim() || null;
  nextPayload.lab_name = nextPayload.lab_name?.toString().trim() || nextPayload.room_section_name?.toString().trim() || null;
  nextPayload.restroom_type = normalizeRestroomTypeValue(nextPayload.restroom_type) || null;
  nextPayload.parent_room_id = nextPayload.parent_room_id ? Number(nextPayload.parent_room_id) : null;
  nextPayload.room_layout = normalizeRoomLayoutValue(nextPayload.room_layout);
  nextPayload.sub_room_count = nextPayload.sub_room_count === "" || nextPayload.sub_room_count == null ? null : Math.max(0, parseInt(nextPayload.sub_room_count, 10) || 0);
  nextPayload.room_section_name = nextPayload.room_section_name?.toString().trim() || null;
  nextPayload.usage_category = normalizeUsageCategoryValue(nextPayload.usage_category, nextPayload.room_type);
  nextPayload.is_bookable = normalizeBooleanLikeValue(nextPayload.is_bookable, true) ? 1 : 0;
  nextPayload.capacity = isCapacityRoomType(nextPayload.room_type) ? parseInt(nextPayload.capacity, 10) || 0 : 0;
  if (isNonCapacityRoomType(nextPayload.room_type)) {
    nextPayload.is_bookable = 0;
    nextPayload.capacity = 0;
  }
  if (!HIERARCHY_ROOM_LAYOUTS.includes(nextPayload.room_layout)) {
    nextPayload.parent_room_id = null;
    nextPayload.sub_room_count = null;
    nextPayload.room_section_name = null;
  } else if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(nextPayload.room_layout)) {
    nextPayload.parent_room_id = null;
  } else if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(nextPayload.room_layout)) {
    nextPayload.room_name = null;
    nextPayload.sub_room_count = null;
  }
  if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(nextPayload.room_layout) && !nextPayload.parent_room_id) {
    throw new Error("Please select a parent room for split child or inside child rooms.");
  }
  if (nextPayload.parent_room_id && !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(nextPayload.room_layout)) {
    nextPayload.room_layout = nextPayload.room_layout === "Split Parent" ? "Split Child" : "Inside Child";
  }
  if (HIERARCHY_ROOM_LAYOUTS.includes(nextPayload.room_layout) && !nextPayload.room_section_name) {
    throw new Error("Sub room name is required for split or inside room layouts.");
  }
  if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(nextPayload.room_layout) && (!nextPayload.sub_room_count || nextPayload.sub_room_count <= 0)) {
    throw new Error("Sub room count must be greater than zero for split parent or inside parent rooms.");
  }
  if (nextPayload.room_type === "Lab") {
    if (!nextPayload.lab_name) {
      throw new Error("Lab name is required when the room type is Lab.");
    }
    if (!nextPayload.room_name) {
      nextPayload.room_name = nextPayload.lab_name;
    }
    nextPayload.restroom_type = null;
  } else if (nextPayload.room_type === "Restroom") {
    nextPayload.lab_name = null;
  } else {
    nextPayload.lab_name = null;
    nextPayload.restroom_type = null;
  }
  if (!HIERARCHY_CHILD_ROOM_LAYOUTS.includes(nextPayload.room_layout) && !nextPayload.room_name && nextPayload.room_section_name) {
    nextPayload.room_name = nextPayload.room_section_name;
  }
  if (isCapacityRoomType(nextPayload.room_type) && nextPayload.capacity <= 0) {
    throw new Error("Capacity is required for all bookable teaching, event, meeting, sports, and lab room types.");
  }
  return nextPayload;
};
var validateRoomHierarchy = async (room, excludeId) => {
  if (!room?.parent_room_id) return null;
  if (excludeId && room.parent_room_id?.toString() === excludeId.toString()) {
    return "A room cannot be inside itself.";
  }
  const parentRoom = await db.prepare("SELECT id, floor_id FROM rooms WHERE id = ?").get(room.parent_room_id);
  if (!parentRoom) return "Please select a valid parent room.";
  if (parentRoom.floor_id?.toString() !== room.floor_id?.toString()) {
    return "The parent room must be on the same floor.";
  }
  return null;
};
var findRecordById = (records, id) => {
  if (id == null || id === "") return null;
  return (Array.isArray(records) ? records : []).find((record) => idsEqual(record?.id, id)) || null;
};
var getBookableRoomError = async (roomId, context) => {
  if (!roomId) return null;
  const cacheKey = roomId.toString();
  if (context?.roomBookableErrorByRoomId.has(cacheKey)) {
    return context.roomBookableErrorByRoomId.get(cacheKey) || null;
  }
  let room = context?.roomById.get(cacheKey) || null;
  if (!room) {
    room = await db.prepare("SELECT id, room_number, room_type, usage_category, is_bookable, status FROM rooms WHERE id = ?").get(roomId);
    if (room) {
      context?.roomById.set(cacheKey, room);
    }
  }
  if (!room) {
    context?.roomBookableErrorByRoomId.set(cacheKey, "Please select a valid room.");
    return "Please select a valid room.";
  }
  if (room.is_bookable === 0) {
    const message = `Room ${room.room_number} is marked as not bookable.`;
    context?.roomBookableErrorByRoomId.set(cacheKey, message);
    return message;
  }
  if (room.status && room.status !== "Available") {
    const message = `Room ${room.room_number} is not available.`;
    context?.roomBookableErrorByRoomId.set(cacheKey, message);
    return message;
  }
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) {
    const message = `Room ${room.room_number} cannot be booked because ${roomType} is a non-bookable room type.`;
    context?.roomBookableErrorByRoomId.set(cacheKey, message);
    return message;
  }
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  if (!BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) && !BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "")) {
    const message = `Room ${room.room_number} cannot be booked because its room type or usage category is not bookable.`;
    context?.roomBookableErrorByRoomId.set(cacheKey, message);
    return message;
  }
  context?.roomBookableErrorByRoomId.set(cacheKey, null);
  return null;
};
var allowsBlankAttachedRestroomType = async (room) => {
  if (normalizeRoomTypeValue(room?.room_type) !== "Restroom") return false;
  if (!HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room?.room_layout))) return false;
  if (!room?.parent_room_id) return false;
  const parentRoom = await db.prepare("SELECT room_type FROM rooms WHERE id = ?").get(room.parent_room_id);
  return PRIVATE_ATTACHED_RESTROOM_PARENT_TYPES.has(normalizeRoomTypeValue(parentRoom?.room_type));
};
var getRestroomValidationError = async (room) => {
  if (normalizeRoomTypeValue(room?.room_type) !== "Restroom") return null;
  if (["Male", "Female"].includes(room?.restroom_type || "")) return null;
  if (await allowsBlankAttachedRestroomType(room)) return null;
  return "Please choose Male or Female for the restroom.";
};
var getCurrentIndiaDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(/* @__PURE__ */ new Date());
var normalizeIsoDate = (value) => {
  const trimmed = value?.toString().trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dayFirstMatch = trimmed.match(/^(\d{1,2})[-\/\s](\d{1,2})[-\/\s](\d{4})$/);
  if (dayFirstMatch) {
    const [, dayRaw, monthRaw, year] = dayFirstMatch;
    const day = dayRaw.padStart(2, "0");
    const month = monthRaw.padStart(2, "0");
    const isoValue = `${year}-${month}-${day}`;
    const parsedDayFirst = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(parsedDayFirst.getTime()) && parsedDayFirst.getUTCFullYear().toString() === year && (parsedDayFirst.getUTCMonth() + 1).toString().padStart(2, "0") === month && parsedDayFirst.getUTCDate().toString().padStart(2, "0") === day) {
      return isoValue;
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
};
var deriveAcademicCalendarStatus = (startDate, endDate) => {
  const today = getCurrentIndiaDate();
  if (endDate && endDate < today) return "Completed";
  if (startDate && startDate > today) return "Upcoming";
  return "Active";
};
var deriveBatchAllocationStatus = (startDate, endDate, requestedStatus) => {
  const normalizedRequested = requestedStatus?.toString().trim().toLowerCase() || "";
  if (normalizedRequested === "released") return "Released";
  const today = getCurrentIndiaDate();
  if (endDate && endDate < today) return "Released";
  if (startDate && startDate > today) return "Planned";
  return "Active";
};
var normalizeTimingProfileWorkingDays = (value) => {
  const normalized = value?.toString().trim() || "";
  return normalized || "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday";
};
var normalizeTimingProfileSlotPattern = (value) => {
  const normalized = value?.toString().trim().replace(/\s+/g, " ") || "";
  return normalized;
};
var parseTimingProfileSlots = (value) => {
  const slotText = value?.toString().trim() || "";
  if (!slotText) return [];
  const slots = slotText.split(/[\n,;]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!match) return null;
    const start = match[1].padStart(5, "0");
    const end = match[2].padStart(5, "0");
    if (start >= end) return null;
    return { start_time: start, end_time: end };
  }).filter((slot) => Boolean(slot)).sort((left, right) => left.start_time.localeCompare(right.start_time) || left.end_time.localeCompare(right.end_time));
  return Array.from(
    new Map(
      slots.map((slot) => [`${slot.start_time}-${slot.end_time}`, slot])
    ).values()
  );
};
var buildTimingProfileSlotWindows = (slots) => {
  const windows = [];
  for (let startIndex = 0; startIndex < slots.length; startIndex += 1) {
    let currentEnd = slots[startIndex].end_time;
    windows.push({
      start_time: slots[startIndex].start_time,
      end_time: currentEnd,
      slot_count: 1
    });
    for (let endIndex = startIndex + 1; endIndex < slots.length; endIndex += 1) {
      if (slots[endIndex - 1].end_time !== slots[endIndex].start_time) break;
      currentEnd = slots[endIndex].end_time;
      windows.push({
        start_time: slots[startIndex].start_time,
        end_time: currentEnd,
        slot_count: endIndex - startIndex + 1
      });
    }
  }
  return windows;
};
var normalizeBookingPurposeType = (value) => {
  const normalized = value?.toString().trim() || "";
  if (!normalized) return "Non-Academic";
  if (["Academic", "Academic Regular", "Academic-Regular"].includes(normalized)) return "Academic Regular";
  if (["Academic Adjustment", "Academic-Adjustment", "Academic Adjustment / Override"].includes(normalized)) return "Academic Adjustment";
  if (["Non Academic", "Non-Academic", "Event", "Meeting"].includes(normalized)) return "Non-Academic";
  return normalized;
};
var resolveBookingTimingProfile = async (booking) => {
  if (!booking?.department_id || !booking?.date) return null;
  const linkedCalendar = await db.prepare(`
    SELECT ac.timing_profile_id
    FROM academic_calendars ac
    WHERE ac.department_id = ?
      AND ac.start_date <= ?
      AND ac.end_date >= ?
      AND LOWER(COALESCE(ac.event_type, '')) != 'examinations'
      AND ac.timing_profile_id IS NOT NULL
    ORDER BY ac.id DESC
    LIMIT 1
  `).get(booking.department_id, booking.date, booking.date);
  const directProfile = linkedCalendar?.timing_profile_id ? await db.prepare("SELECT * FROM timing_profiles WHERE id = ?").get(linkedCalendar.timing_profile_id) : null;
  if (directProfile) return directProfile;
  return await db.prepare(`
    SELECT *
    FROM timing_profiles
    WHERE department_id = ?
    ORDER BY
      CASE WHEN specialization IS NOT NULL AND LOWER(TRIM(specialization)) = LOWER(TRIM(?)) THEN 0 ELSE 1 END,
      id DESC
    LIMIT 1
  `).get(booking.department_id, booking.specialization || "");
};
var getBookingTimingPolicyDetails = async (booking) => {
  const purposeType = normalizeBookingPurposeType(booking?.purpose_type);
  const timingProfile = await resolveBookingTimingProfile(booking);
  const slots = parseTimingProfileSlots(timingProfile?.slot_pattern);
  const slotWindows = buildTimingProfileSlotWindows(slots);
  const matchesWindow = slotWindows.some((window) => window.start_time === booking?.start_time && window.end_time === booking?.end_time);
  const timingOverride = purposeType !== "Academic Regular" && slots.length > 0 && !matchesWindow ? 1 : 0;
  return { purposeType, timingProfile, slots, slotWindows, matchesWindow, timingOverride };
};
var normalizeTimingProfilePayload = async (payload) => {
  const nextPayload = { ...payload };
  const departmentId = nextPayload.department_id ? Number(nextPayload.department_id) : null;
  const schoolId = nextPayload.school_id ? Number(nextPayload.school_id) : null;
  const department = departmentId ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) : null;
  if (departmentId && !department) {
    throw new Error("Please select a valid department.");
  }
  if (schoolId) {
    const school = await db.prepare("SELECT id FROM schools WHERE id = ?").get(schoolId);
    if (!school) {
      throw new Error("Please select a valid school.");
    }
  }
  if (department && schoolId && department.school_id?.toString() !== schoolId.toString()) {
    throw new Error("Selected department does not belong to the selected school.");
  }
  nextPayload.department_id = department?.id || null;
  nextPayload.school_id = department?.school_id || schoolId || null;
  nextPayload.profile_id = nextPayload.profile_id?.toString().trim() || null;
  nextPayload.profile_name = nextPayload.profile_name?.toString().trim() || nextPayload.profile_id || null;
  nextPayload.program = nextPayload.program?.toString().trim() || null;
  nextPayload.specialization = nextPayload.specialization?.toString().trim() || null;
  nextPayload.academic_year = nextPayload.academic_year?.toString().trim() || null;
  nextPayload.year_of_study = nextPayload.year_of_study?.toString().trim() || null;
  nextPayload.semester = nextPayload.semester?.toString().trim() || null;
  nextPayload.section = nextPayload.section?.toString().trim() || null;
  nextPayload.working_days = normalizeTimingProfileWorkingDays(nextPayload.working_days);
  nextPayload.slot_pattern = normalizeTimingProfileSlotPattern(nextPayload.slot_pattern);
  nextPayload.notes = nextPayload.notes?.toString().trim() || null;
  if (!nextPayload.profile_id) {
    throw new Error("Timing Profile ID is required.");
  }
  if (!nextPayload.profile_name) {
    throw new Error("Timing Profile Name is required.");
  }
  if (!nextPayload.slot_pattern) {
    throw new Error("Slot Timings are required.");
  }
  return nextPayload;
};
var normalizeAcademicCalendarPayload = async (payload) => {
  const nextPayload = { ...payload };
  const departmentId = nextPayload.department_id ? Number(nextPayload.department_id) : null;
  const department = departmentId ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) : null;
  if (!department) {
    throw new Error("Please select a valid department.");
  }
  const startDate = normalizeIsoDate(nextPayload.start_date);
  const endDate = normalizeIsoDate(nextPayload.end_date);
  if (!startDate || !endDate) {
    throw new Error("Start date and end date are required.");
  }
  if (startDate > endDate) {
    throw new Error("Academic calendar start date cannot be after the end date.");
  }
  const timingProfileId = nextPayload.timing_profile_id ? Number(nextPayload.timing_profile_id) : null;
  const timingProfile = timingProfileId ? await db.prepare("SELECT id, school_id, department_id, specialization FROM timing_profiles WHERE id = ?").get(timingProfileId) : null;
  if (timingProfileId && !timingProfile) {
    throw new Error("Please select a valid timing profile.");
  }
  if (timingProfile?.department_id && timingProfile.department_id.toString() !== department.id.toString()) {
    throw new Error("Selected timing profile does not belong to the selected department.");
  }
  if (timingProfile?.school_id && timingProfile.school_id.toString() !== department.school_id.toString()) {
    throw new Error("Selected timing profile does not belong to the selected school.");
  }
  if (timingProfile?.specialization && normalizeAcademicContextText(timingProfile.specialization) !== normalizeAcademicContextText(nextPayload.specialization)) {
    throw new Error("Selected timing profile does not belong to the selected specialization / branch.");
  }
  nextPayload.department_id = department.id;
  nextPayload.school_id = department.school_id;
  nextPayload.program = nextPayload.program?.toString().trim() || null;
  nextPayload.batch = nextPayload.batch?.toString().trim() || null;
  nextPayload.specialization = nextPayload.specialization?.toString().trim() || timingProfile?.specialization || null;
  nextPayload.academic_year = nextPayload.academic_year?.toString().trim() || null;
  nextPayload.year_of_study = nextPayload.year_of_study?.toString().trim() || null;
  nextPayload.semester = nextPayload.semester?.toString().trim() || null;
  nextPayload.timing_profile_id = timingProfile?.id || null;
  nextPayload.event_type = nextPayload.event_type?.toString().trim() || "Semester Period";
  nextPayload.title = nextPayload.title?.toString().trim() || `${nextPayload.program || "Academic"} ${nextPayload.semester || "Period"}`;
  nextPayload.start_date = startDate;
  nextPayload.end_date = endDate;
  nextPayload.status = deriveAcademicCalendarStatus(startDate, endDate);
  nextPayload.notes = nextPayload.notes?.toString().trim() || null;
  return nextPayload;
};
var normalizeBatchRoomAllocationPayload = async (payload) => {
  const nextPayload = { ...payload };
  const buildSplitAllocationGroupId = (value) => {
    const slugify = (input) => input?.toString().trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "";
    const parts = [
      slugify(value?.department_id),
      slugify(value?.program),
      slugify(value?.batch),
      slugify(value?.specialization),
      slugify(value?.year_of_study),
      slugify(value?.semester),
      slugify(value?.start_date),
      slugify(value?.end_date)
    ].filter(Boolean);
    return parts.length ? `SPLIT-${parts.join("-")}` : null;
  };
  const calendarId = nextPayload.academic_calendar_id ? Number(nextPayload.academic_calendar_id) : null;
  const linkedCalendar = calendarId ? await db.prepare(`
      SELECT id, school_id, department_id, program, batch, specialization, academic_year, year_of_study, semester, start_date, end_date
      FROM academic_calendars
      WHERE id = ?
    `).get(calendarId) : null;
  if (calendarId && !linkedCalendar) {
    throw new Error("Please select a valid academic calendar.");
  }
  const departmentId = Number(nextPayload.department_id || linkedCalendar?.department_id || 0) || null;
  const department = departmentId ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) : null;
  if (!department) {
    throw new Error("Please select a valid department.");
  }
  const roomId = nextPayload.room_id ? Number(nextPayload.room_id) : null;
  const room = roomId ? await db.prepare("SELECT id, room_number, room_type, capacity FROM rooms WHERE id = ?").get(roomId) : null;
  if (!room) {
    throw new Error("Please select a valid room.");
  }
  const startDate = normalizeIsoDate(nextPayload.start_date || linkedCalendar?.start_date);
  const endDate = normalizeIsoDate(nextPayload.end_date || linkedCalendar?.end_date);
  if (!startDate || !endDate) {
    throw new Error("Allocation start date and end date are required.");
  }
  if (startDate > endDate) {
    throw new Error("Allocation start date cannot be after the end date.");
  }
  nextPayload.academic_calendar_id = linkedCalendar?.id || null;
  nextPayload.department_id = department.id;
  nextPayload.school_id = department.school_id;
  nextPayload.room_id = room.id;
  nextPayload.program = nextPayload.program?.toString().trim() || linkedCalendar?.program || null;
  nextPayload.batch = nextPayload.batch?.toString().trim() || linkedCalendar?.batch || null;
  nextPayload.specialization = nextPayload.specialization?.toString().trim() || linkedCalendar?.specialization || null;
  nextPayload.academic_year = nextPayload.academic_year?.toString().trim() || linkedCalendar?.academic_year || null;
  nextPayload.year_of_study = nextPayload.year_of_study?.toString().trim() || linkedCalendar?.year_of_study || null;
  nextPayload.semester = nextPayload.semester?.toString().trim() || linkedCalendar?.semester || null;
  nextPayload.start_date = startDate;
  nextPayload.end_date = endDate;
  nextPayload.allocation_mode = ["exclusive", "shared"].includes((nextPayload.allocation_mode || "").toString().trim().toLowerCase()) ? (nextPayload.allocation_mode || "").toString().trim().toLowerCase() === "exclusive" ? "Exclusive" : "Shared" : "Shared";
  nextPayload.allocation_pattern = ["split room", "split"].includes((nextPayload.allocation_pattern || "").toString().trim().toLowerCase()) ? "Split Room" : "Single Room";
  nextPayload.split_group_id = nextPayload.allocation_pattern === "Split Room" ? nextPayload.split_group_id?.toString().trim() || buildSplitAllocationGroupId(nextPayload) : null;
  nextPayload.room_type = room.room_type;
  nextPayload.capacity = parseInt(nextPayload.capacity, 10) || 0;
  nextPayload.status = deriveBatchAllocationStatus(startDate, endDate, nextPayload.status);
  nextPayload.notes = nextPayload.notes?.toString().trim() || null;
  if (nextPayload.capacity <= 0) {
    throw new Error("Required capacity must be greater than zero.");
  }
  if (nextPayload.capacity > room.capacity) {
    throw new Error(`Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${nextPayload.capacity}.`);
  }
  if (nextPayload.allocation_pattern === "Split Room" && !nextPayload.split_group_id) {
    throw new Error("Split Room allocations need a split allocation group.");
  }
  const departmentAllocationError = await getDepartmentAllocationLinkError(nextPayload.room_id, nextPayload.department_id, nextPayload.semester);
  if (departmentAllocationError) {
    throw new Error(departmentAllocationError);
  }
  return nextPayload;
};
var getBatchAllocationOverlapError = async (allocation, excludeId, existingRows) => {
  if (!allocation?.room_id || !allocation?.start_date || !allocation?.end_date) return null;
  const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(allocation.room_id);
  const existingAllocations = Array.isArray(existingRows) ? existingRows.filter((existing) => idsEqual(existing?.room_id, allocation.room_id) && (!excludeId || !idsEqual(existing?.id, excludeId))) : await db.prepare(`
      SELECT id, department_id, program, batch, academic_year, year_of_study, semester, start_date, end_date, status, allocation_mode
      FROM batch_room_allocations
      WHERE room_id = ?
      ${excludeId ? "AND id != ?" : ""}
    `).all(allocation.room_id, ...excludeId ? [excludeId] : []);
  const conflictingAllocation = existingAllocations.find((existing) => {
    if ((existing.status || "").toString().trim().toLowerCase() === "released") return false;
    const existingStart = normalizeIsoDate(existing.start_date);
    const existingEnd = normalizeIsoDate(existing.end_date);
    const overlaps = !(existingEnd < allocation.start_date || existingStart > allocation.end_date);
    if (!overlaps) return false;
    const existingMode = (existing.allocation_mode || "Shared").toString().trim().toLowerCase();
    const nextMode = (allocation.allocation_mode || "Shared").toString().trim().toLowerCase();
    return existingMode !== "shared" || nextMode !== "shared";
  });
  if (!conflictingAllocation) return null;
  return `Room ${room?.room_number || allocation.room_id} already has an overlapping Exclusive batch allocation. Shared allocations can overlap across batches or departments, but any overlap involving Exclusive is blocked.`;
};
var syncBatchAllocationStatuses = async () => {
  const allocations = await db.prepare("SELECT id, start_date, end_date, status FROM batch_room_allocations").all();
  for (const allocation of allocations) {
    const nextStatus = deriveBatchAllocationStatus(normalizeIsoDate(allocation.start_date), normalizeIsoDate(allocation.end_date), allocation.status);
    if (nextStatus !== allocation.status) {
      await db.prepare("UPDATE batch_room_allocations SET status = ? WHERE id = ?").run(nextStatus, allocation.id);
    }
  }
};
var SERVER_CACHE_TTL_MS = 3e4;
var serverTableCache = /* @__PURE__ */ new Map();
var CACHEABLE_SERVER_TABLES = /* @__PURE__ */ new Set([
  "rooms",
  "schools",
  "departments",
  "buildings",
  "blocks",
  "floors",
  "timing_profiles",
  "academic_calendars",
  "equipment",
  "department_allocations",
  "hod_room_allocations",
  "batch_room_allocations",
  "campuses",
  "schedules"
]);
var getFromServerCache = (key) => {
  const entry = serverTableCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  serverTableCache.delete(key);
  return null;
};
var setInServerCache = (key, data) => serverTableCache.set(key, { data, expiresAt: Date.now() + SERVER_CACHE_TTL_MS });
var bustServerCache = (...tableNames) => tableNames.forEach((n) => serverTableCache.delete(n));
var lastBatchSyncAt = 0;
var maybeSyncBatchAllocationStatuses = async () => {
  if (Date.now() - lastBatchSyncAt < 6e4) return;
  lastBatchSyncAt = Date.now();
  bustServerCache("batch_room_allocations");
  await syncBatchAllocationStatuses();
};
var getDayOfWeekForDate = (date) => (/* @__PURE__ */ new Date(`${date}T00:00:00`)).toLocaleDateString("en-US", { weekday: "long" });
var parseSemesterNumber = (value) => {
  const normalized = normalizeDuplicateValue(value)?.toString() || "";
  if (!normalized) return null;
  const numericMatch = normalized.match(/(?:semester|sem)?\s*(\d+)/)?.[1];
  if (numericMatch) return Number(numericMatch);
  const romanMatch = normalized.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/);
  if (!romanMatch) return null;
  const romanToNumber = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10
  };
  return romanToNumber[romanMatch[1]] || null;
};
var normalizeSemesterKey = (value) => {
  const normalized = normalizeDuplicateValue(value)?.toString() || "";
  if (!normalized) return "";
  if (normalized.includes("odd") || normalized.includes("fall")) return "odd";
  if (normalized.includes("even") || normalized.includes("spring") || normalized.includes("summer")) return "even";
  const semesterNumber = parseSemesterNumber(value);
  if (semesterNumber) return semesterNumber % 2 === 0 ? "even" : "odd";
  return normalized;
};
var isExaminationCalendarEvent = (calendar) => {
  const eventType = normalizeDuplicateValue(calendar?.event_type)?.toString() || "";
  const title = normalizeDuplicateValue(calendar?.title)?.toString() || "";
  return eventType.includes("exam") || eventType.includes("ciat") || title.includes("exam") || title.includes("ciat");
};
var normalizeAcademicContextText = (value) => normalizeDuplicateValue(value)?.toString() || "";
var getDepartmentAllocationLink = async (roomId, departmentId, semester, context) => {
  const numericRoomId = Number(roomId || 0) || null;
  const numericDepartmentId = Number(departmentId || 0) || null;
  if (!numericRoomId || !numericDepartmentId) return null;
  const normalizedSemester = normalizeSemesterKey(semester);
  const cacheKey = [numericRoomId, numericDepartmentId, normalizedSemester || ""].join("|");
  if (context?.departmentAllocationLinksByContext.has(cacheKey)) {
    return context.departmentAllocationLinksByContext.get(cacheKey) || null;
  }
  const matches = await db.prepare(`
    SELECT id, room_id, department_id, school_id, semester
    FROM department_allocations
    WHERE room_id = ? AND department_id = ?
    ORDER BY id DESC
  `).all(numericRoomId, numericDepartmentId);
  if (matches.length === 0) return null;
  const matchedAllocation = !normalizedSemester ? matches[0] : matches.find((match) => normalizeSemesterKey(match.semester) === normalizedSemester) || null;
  context?.departmentAllocationLinksByContext.set(cacheKey, matchedAllocation || null);
  return matchedAllocation;
};
var getDepartmentAllocationLinkError = async (roomId, departmentId, semester, context) => {
  if (!roomId || !departmentId) return "Please select both department and room.";
  const linkedAllocation = await getDepartmentAllocationLink(roomId, departmentId, semester, context);
  if (linkedAllocation) return null;
  const roomCacheKey = roomId.toString();
  let roomNumber = context?.roomNumberById.get(roomCacheKey) || "";
  if (!roomNumber) {
    const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(roomId);
    roomNumber = room?.room_number || "";
    context?.roomNumberById.set(roomCacheKey, roomNumber);
  }
  const departmentCacheKey = departmentId.toString();
  let departmentName = context?.departmentNameById.get(departmentCacheKey) || "";
  if (!departmentName) {
    const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId);
    departmentName = department?.name || "";
    context?.departmentNameById.set(departmentCacheKey, departmentName);
  }
  const semesterLabel = normalizeSemesterKey(semester) ? ` for ${semester}` : "";
  return `Room ${roomNumber || roomId} is not mapped to ${departmentName || "the selected department"}${semesterLabel} in Department Allocation. Create the department allocation first.`;
};
var getHodRoomAllocationLink = async (roomId, hodUserId, semester) => {
  const numericRoomId = Number(roomId || 0) || null;
  const numericHodUserId = Number(hodUserId || 0) || null;
  if (!numericRoomId || !numericHodUserId) return null;
  const matches = await db.prepare(`
    SELECT id, semester
    FROM hod_room_allocations
    WHERE room_id = ? AND hod_user_id = ?
    ORDER BY id DESC
  `).all(numericRoomId, numericHodUserId);
  const normalizedSemester = normalizeSemesterKey(semester);
  if (!normalizedSemester) return matches[0] || null;
  return matches.find((match) => normalizeSemesterKey(match?.semester) === normalizedSemester) || null;
};
var getHodRoomAllocationLinkError = async (roomId, hodUserId, semester) => {
  if (!roomId || !hodUserId) return "Please select both HOD and room.";
  const linkedAllocation = await getHodRoomAllocationLink(roomId, hodUserId, semester);
  if (linkedAllocation) return null;
  const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(roomId);
  const hodUser = await db.prepare("SELECT full_name, employee_id FROM users WHERE id = ?").get(hodUserId);
  const hodLabel = hodUser?.full_name || hodUser?.employee_id || "the selected HOD";
  const semesterLabel = normalizeSemesterKey(semester) ? ` for ${semester}` : "";
  return `Room ${room?.room_number || roomId} is not allocated to ${hodLabel}${semesterLabel} in HOD Room Allocation. Allocate the room to this HOD first.`;
};
var countDependentBatchRoomAllocations = async (roomId, departmentId, semester) => {
  const numericRoomId = Number(roomId || 0) || null;
  const numericDepartmentId = Number(departmentId || 0) || null;
  if (!numericRoomId || !numericDepartmentId) return 0;
  const matches = await db.prepare(`
    SELECT id, semester
    FROM batch_room_allocations
    WHERE room_id = ? AND department_id = ?
  `).all(numericRoomId, numericDepartmentId);
  const normalizedSemester = normalizeSemesterKey(semester);
  if (!normalizedSemester) return matches.length;
  return matches.filter((match) => normalizeSemesterKey(match?.semester) === normalizedSemester).length;
};
var countDependentDepartmentRoomMappingsForHodAllocation = async (roomId, hodUserId, semester) => {
  const numericRoomId = Number(roomId || 0) || null;
  const numericHodUserId = Number(hodUserId || 0) || null;
  if (!numericRoomId || !numericHodUserId) return 0;
  const assignments = await db.prepare(`
    SELECT department_id
    FROM user_department_assignments
    WHERE user_id = ?
  `).all(numericHodUserId);
  const departmentIds = assignments.map((assignment) => assignment?.department_id?.toString?.()).filter(Boolean);
  if (departmentIds.length === 0) return 0;
  const placeholders = departmentIds.map(() => "?").join(", ");
  const matches = await db.prepare(`
    SELECT id, semester
    FROM department_allocations
    WHERE room_id = ?
      AND department_id IN (${placeholders})
  `).all(numericRoomId, ...departmentIds);
  const normalizedSemester = normalizeSemesterKey(semester);
  if (!normalizedSemester) return matches.length;
  return matches.filter((match) => normalizeSemesterKey(match?.semester) === normalizedSemester).length;
};
var normalizeScheduleSpecializationValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.toUpperCase();
};
var normalizeScheduleProgramValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const aliases = {
    "bsc": "B.Sc",
    "b.sc": "B.Sc",
    "b.sc.": "B.Sc",
    "bsc hon's": "B.Sc (Hon's)",
    "b.sc hon's": "B.Sc (Hon's)",
    "b.sc. hon's": "B.Sc (Hon's)",
    "bsc hons": "B.Sc (Hon's)",
    "b.sc hons": "B.Sc (Hon's)",
    "b.sc. hons": "B.Sc (Hon's)",
    "bsc honours": "B.Sc (Hon's)",
    "b.sc honours": "B.Sc (Hon's)",
    "b.sc. honours": "B.Sc (Hon's)",
    "bsc honors": "B.Sc (Hon's)",
    "b.sc honors": "B.Sc (Hon's)",
    "b.sc. honors": "B.Sc (Hon's)",
    "bsc (hon's)": "B.Sc (Hon's)",
    "b.sc (hon's)": "B.Sc (Hon's)",
    "b.sc. (hon's)": "B.Sc (Hon's)",
    "bsc (hons)": "B.Sc (Hon's)",
    "b.sc (hons)": "B.Sc (Hon's)",
    "b.sc. (hons)": "B.Sc (Hon's)",
    "bpt": "BPT",
    "b pt": "BPT",
    "btech": "B.Tech",
    "b tech": "B.Tech",
    "b.tech": "B.Tech",
    "mtech": "M.Tech",
    "m tech": "M.Tech",
    "m.tech": "M.Tech",
    "bpharm": "B.Pharm",
    "b pharm": "B.Pharm",
    "b.pharm": "B.Pharm"
  };
  return aliases[normalized.toLowerCase()] || normalized;
};
var normalizeSchedulePayload = (payload) => ({
  ...payload,
  program: normalizeScheduleProgramValue(payload?.program),
  specialization: normalizeScheduleSpecializationValue(payload?.specialization || payload?.branch),
  section: payload?.section?.toString().trim() || null,
  session_group_id: payload?.session_group_id?.toString().trim() || null
});
var buildDepartmentScheduleCodeSegment = (department) => {
  const raw = department?.department_id?.toString().trim() || department?.name?.toString().trim() || "GEN";
  const compact = raw.replace(/[^a-z0-9]+/gi, " ").trim();
  if (!compact) return "GEN";
  if (department?.department_id) {
    return compact.replace(/\s+/g, "-").toUpperCase();
  }
  const acronym = compact.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").toUpperCase();
  return acronym || compact.replace(/\s+/g, "-").toUpperCase();
};
var buildScheduleProgramCodeSegment = (program) => {
  const normalizedProgram = normalizeScheduleProgramValue(program);
  if (!normalizedProgram) return "";
  return normalizedProgram.replace(/[^a-z0-9]+/gi, "").toUpperCase();
};
var buildScheduleCodePrefix = (department, program, specialization) => {
  const departmentSegment = buildDepartmentScheduleCodeSegment(department);
  const programSegment = buildScheduleProgramCodeSegment(program);
  const specializationSegment = normalizeScheduleSpecializationValue(specialization);
  return ["SCH", departmentSegment, programSegment, specializationSegment].filter(Boolean).join("-");
};
var createBulkImportContext = (tableName, records) => ({
  tableName,
  records,
  departmentById: /* @__PURE__ */ new Map(),
  roomById: /* @__PURE__ */ new Map(),
  roomBookableErrorByRoomId: /* @__PURE__ */ new Map(),
  departmentAllocationLinksByContext: /* @__PURE__ */ new Map(),
  roomNumberById: /* @__PURE__ */ new Map(),
  departmentNameById: /* @__PURE__ */ new Map(),
  scheduleCodeSequenceByPrefix: /* @__PURE__ */ new Map()
});
var getCachedDepartmentForScheduleCode = async (departmentId, context) => {
  if (!departmentId) return null;
  const cacheKey = departmentId.toString();
  if (context?.departmentById.has(cacheKey)) {
    return context.departmentById.get(cacheKey) || null;
  }
  const department = await db.prepare("SELECT id, department_id, name FROM departments WHERE id = ?").get(departmentId);
  context?.departmentById.set(cacheKey, department || null);
  return department || null;
};
var seedScheduleCodeSequenceCache = async (context) => {
  if (context.scheduleCodeSequenceByPrefix.size > 0) return;
  const rows = context.records.length > 0 ? context.records : await db.prepare("SELECT id, schedule_code FROM schedules WHERE schedule_code IS NOT NULL").all();
  rows.forEach((row) => {
    const code = row?.schedule_code?.toString().trim() || "";
    const match = code.match(/^(.*)-(\d{3,})$/);
    if (!match) return;
    const prefix = match[1];
    const sequence = parseInt(match[2], 10);
    if (!Number.isFinite(sequence)) return;
    const current = context.scheduleCodeSequenceByPrefix.get(prefix) || 0;
    if (sequence > current) {
      context.scheduleCodeSequenceByPrefix.set(prefix, sequence);
    }
  });
};
var assignScheduleCode = async (payload, existingId, existingItem, context) => {
  const mergedPayload = { ...existingItem || {}, ...payload || {} };
  const department = mergedPayload?.department_id ? await getCachedDepartmentForScheduleCode(mergedPayload.department_id, context) : null;
  const prefix = buildScheduleCodePrefix(department, mergedPayload.program, mergedPayload.specialization);
  const existingCode = existingItem?.schedule_code?.toString().trim() || "";
  if (existingCode && existingCode.startsWith(`${prefix}-`)) {
    return existingCode;
  }
  if (context?.tableName === "schedules") {
    await seedScheduleCodeSequenceCache(context);
    const nextSequence = (context.scheduleCodeSequenceByPrefix.get(prefix) || 0) + 1;
    context.scheduleCodeSequenceByPrefix.set(prefix, nextSequence);
    return `${prefix}-${String(nextSequence).padStart(3, "0")}`;
  }
  const rows = await db.prepare("SELECT id, schedule_code FROM schedules WHERE schedule_code IS NOT NULL").all();
  let maxSequence = 0;
  rows.forEach((row) => {
    if (existingId && idsEqual(row?.id, existingId)) return;
    const code = row?.schedule_code?.toString().trim() || "";
    if (!code.startsWith(`${prefix}-`)) return;
    const sequence = parseInt(code.slice(prefix.length + 1), 10);
    if (Number.isFinite(sequence)) {
      maxSequence = Math.max(maxSequence, sequence);
    }
  });
  return `${prefix}-${String(maxSequence + 1).padStart(3, "0")}`;
};
var backfillMissingScheduleCodes = async (rows) => {
  const rowArray = Array.isArray(rows) ? rows : [];
  const rowsNeedingBackfill = rowArray.filter((row) => row?.id && !row?.schedule_code?.toString().trim());
  if (rowsNeedingBackfill.length === 0) return rows;
  for (const row of rowsNeedingBackfill) {
    const scheduleCode = await assignScheduleCode(row, row.id, row);
    if (row.schedule_code !== scheduleCode) {
      await db.prepare("UPDATE schedules SET schedule_code = ? WHERE id = ?").run(scheduleCode, row.id);
      row.schedule_code = scheduleCode;
    }
  }
  return rows;
};
var normalizeYearOfStudyKey = (value) => {
  const normalized = value?.toString().trim().toLowerCase() || "";
  if (!normalized) return "";
  const numericMatch = normalized.match(/(?:^|\b)(\d+)(?:st|nd|rd|th)?\s*year\b/)?.[1] || normalized.match(/\byear\s*(\d+)\b/)?.[1] || normalized.match(/^(\d+)$/)?.[1];
  if (numericMatch) return numericMatch;
  const romanMatch = normalized.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\s*year\b/)?.[1] || normalized.match(/\byear\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/)?.[1] || normalized.match(/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/)?.[1];
  if (!romanMatch) return "";
  const romanToNumber = {
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10"
  };
  return romanToNumber[romanMatch] || "";
};
var allocationMatchesCalendarContext = (allocation, calendar) => {
  if (calendar?.id && allocation?.academic_calendar_id && allocation.academic_calendar_id.toString() === calendar.id.toString()) return true;
  if (!allocation?.department_id || !calendar?.department_id) return false;
  if (allocation.department_id.toString() !== calendar.department_id.toString()) return false;
  const allocationSemester = normalizeSemesterKey(allocation.semester);
  const calendarSemester = normalizeSemesterKey(calendar.semester);
  if (allocationSemester && calendarSemester && allocationSemester !== calendarSemester) return false;
  if (calendar?.program && normalizeAcademicContextText(allocation.program) !== normalizeAcademicContextText(calendar.program)) return false;
  if (calendar?.batch && normalizeAcademicContextText(allocation.batch) !== normalizeAcademicContextText(calendar.batch)) return false;
  if (calendar?.specialization && normalizeAcademicContextText(allocation.specialization) !== normalizeAcademicContextText(calendar.specialization)) return false;
  if (calendar?.academic_year && normalizeAcademicContextText(allocation.academic_year) !== normalizeAcademicContextText(calendar.academic_year)) return false;
  const allocationYear = normalizeYearOfStudyKey(allocation.year_of_study);
  const calendarYear = normalizeYearOfStudyKey(calendar.year_of_study);
  if (calendarYear && allocationYear && allocationYear !== calendarYear) return false;
  return true;
};
var scheduleMatchesCalendarOverride = (schedule, calendar, activeBatchAllocations = [], date) => {
  if (!schedule?.department_id || !calendar?.department_id) return false;
  if (schedule.department_id.toString() !== calendar.department_id.toString()) return false;
  const scheduleSemester = normalizeSemesterKey(schedule.semester);
  const calendarSemester = normalizeSemesterKey(calendar.semester);
  if (scheduleSemester && calendarSemester && scheduleSemester !== calendarSemester) return false;
  const scheduleYear = normalizeYearOfStudyKey(schedule.year_of_study);
  const calendarYear = normalizeYearOfStudyKey(calendar.year_of_study);
  if (calendarYear && scheduleYear && calendarYear !== scheduleYear) return false;
  if (calendar?.program && schedule?.program && normalizeAcademicContextText(calendar.program) !== normalizeAcademicContextText(schedule.program)) return false;
  if (calendar?.specialization && schedule?.specialization && normalizeAcademicContextText(calendar.specialization) !== normalizeAcademicContextText(schedule.specialization)) return false;
  const calendarHasSpecificContext = Boolean(
    calendar?.program || calendar?.batch || calendar?.specialization || calendar?.academic_year || calendar?.year_of_study
  );
  if (!calendarHasSpecificContext) return true;
  const relevantAllocations = activeBatchAllocations.filter((allocation) => {
    if (schedule?.room_id != null && allocation?.room_id != null && allocation.room_id.toString() !== schedule.room_id.toString()) return false;
    if (!allocation?.department_id || allocation.department_id.toString() !== schedule.department_id.toString()) return false;
    const allocationSemester = normalizeSemesterKey(allocation.semester);
    if (scheduleSemester && allocationSemester && allocationSemester !== scheduleSemester) return false;
    if (schedule?.program && allocation?.program && normalizeAcademicContextText(allocation.program) !== normalizeAcademicContextText(schedule.program)) return false;
    if (schedule?.specialization && allocation?.specialization && normalizeAcademicContextText(allocation.specialization) !== normalizeAcademicContextText(schedule.specialization)) return false;
    const allocationYear = normalizeYearOfStudyKey(allocation.year_of_study);
    if (scheduleYear && allocationYear && allocationYear !== scheduleYear) return false;
    if (date && allocation?.start_date && allocation?.end_date) {
      const allocationStart = normalizeIsoDate(allocation.start_date);
      const allocationEnd = normalizeIsoDate(allocation.end_date);
      if (allocationStart && allocationEnd && (allocationStart > date || allocationEnd < date)) return false;
    }
    return true;
  });
  if (relevantAllocations.length === 0) return true;
  return relevantAllocations.some((allocation) => allocationMatchesCalendarContext(allocation, calendar));
};
var filterSchedulesByAcademicCalendar = async (schedules, date) => {
  const normalizedDate = normalizeIsoDate(date);
  if (!normalizedDate || !Array.isArray(schedules) || schedules.length === 0) return schedules;
  const activeExamCalendars = await db.prepare(`
    SELECT id, department_id, program, batch, specialization, academic_year, year_of_study, semester, event_type, title, start_date, end_date
    FROM academic_calendars
    WHERE start_date <= ? AND end_date >= ?
  `).all(normalizedDate, normalizedDate);
  const examinationCalendars = activeExamCalendars.filter(isExaminationCalendarEvent);
  if (examinationCalendars.length === 0) return schedules;
  const activeBatchAllocations = await db.prepare(`
    SELECT id, academic_calendar_id, room_id, department_id, program, batch, specialization, academic_year, year_of_study, semester, start_date, end_date, status
    FROM batch_room_allocations
    WHERE start_date <= ? AND end_date >= ? AND status != ?
  `).all(normalizedDate, normalizedDate, "Released");
  return schedules.filter(
    (schedule) => !examinationCalendars.some((calendar) => scheduleMatchesCalendarOverride(schedule, calendar, activeBatchAllocations, normalizedDate))
  );
};
var getEffectiveSchedulesForDate = async (date, predicate) => {
  const normalizedDate = normalizeIsoDate(date);
  if (!normalizedDate) return [];
  const dayOfWeek = getDayOfWeekForDate(normalizedDate);
  const daySchedules = await db.prepare(`SELECT * FROM schedules WHERE day_of_week = ?`).all(dayOfWeek);
  const deduplicatedSchedules = deduplicateSchedules(daySchedules).kept;
  const filteredSchedules = predicate ? deduplicatedSchedules.filter(predicate) : deduplicatedSchedules;
  return filterSchedulesByAcademicCalendar(filteredSchedules, normalizedDate);
};
var ensureNotificationsTable = async () => {
  const idDefinition = db.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const timestampType = db.dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id ${idDefinition},
      target_role TEXT,
      target_name TEXT,
      target_department TEXT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await ensureColumn("notifications", "target_department", "TEXT");
};
var ensureNotificationReadsTable = async () => {
  const timestampType = db.dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at ${timestampType} DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id, user_id),
      FOREIGN KEY(notification_id) REFERENCES notifications(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
};
var ensureBookingActivityTable = async () => {
  const idDefinition = db.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const timestampType = db.dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS booking_activity (
      id ${idDefinition},
      booking_id INTEGER,
      request_group_id TEXT,
      actor_name TEXT,
      actor_role TEXT,
      action_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      status_from TEXT,
      status_to TEXT,
      room_id_from INTEGER,
      room_id_to INTEGER,
      note_text TEXT,
      created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
var ensureBookingAlternativesTable = async () => {
  const idDefinition = db.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const timestampType = db.dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS booking_alternatives (
      id ${idDefinition},
      booking_id INTEGER,
      request_group_id TEXT,
      status TEXT DEFAULT 'Pending Response',
      suggested_date TEXT,
      suggested_start_time TEXT,
      suggested_end_time TEXT,
      suggested_capacity INTEGER,
      suggested_room_type TEXT,
      suggested_building TEXT,
      suggested_room_count INTEGER,
      suggestion_note TEXT,
      internal_candidate_room_ids TEXT,
      response_note TEXT,
      created_by TEXT,
      created_role TEXT,
      responded_by TEXT,
      responded_role TEXT,
      responded_at ${timestampType},
      created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestampType} DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
var ensureTemporaryRoomAllocationsTable = async () => {
  const idDefinition = db.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  const timestampType = db.dialect === "postgres" ? "TIMESTAMP" : "DATETIME";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS temporary_room_allocations (
      id ${idDefinition},
      booking_id INTEGER NOT NULL,
      request_group_id TEXT,
      room_id INTEGER NOT NULL,
      temporary_department_id INTEGER NOT NULL,
      original_department_id INTEGER,
      approved_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      purpose TEXT,
      request_type TEXT,
      allocation_note TEXT,
      assigned_by TEXT,
      assigned_role TEXT,
      released_at ${timestampType},
      status TEXT DEFAULT 'Upcoming',
      created_at ${timestampType} DEFAULT CURRENT_TIMESTAMP,
      updated_at ${timestampType} DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(booking_id)
    );
  `);
};
await ensureNotificationsTable();
await ensureNotificationReadsTable();
await ensureBookingActivityTable();
await ensureBookingAlternativesTable();
await ensureTemporaryRoomAllocationsTable();
var createNotification = async (targetRole, targetName, title, message, targetDepartment = null) => {
  await ensureNotificationsTable();
  await db.prepare("INSERT INTO notifications (target_role, target_name, target_department, title, message) VALUES (?, ?, ?, ?, ?)").run(targetRole, targetName, targetDepartment, title, message);
};
var createBookingActivityLog = async (booking, actor, payload) => {
  await ensureBookingActivityTable();
  await db.prepare(`
    INSERT INTO booking_activity (
      booking_id,
      request_group_id,
      actor_name,
      actor_role,
      action_type,
      title,
      message,
      status_from,
      status_to,
      room_id_from,
      room_id_to,
      note_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    booking?.id ?? null,
    booking?.request_group_id ?? null,
    actor?.name ?? null,
    actor?.role ?? null,
    payload.actionType,
    payload.title,
    payload.message ?? null,
    payload.statusFrom ?? null,
    payload.statusTo ?? null,
    payload.roomIdFrom ?? null,
    payload.roomIdTo ?? null,
    payload.noteText ?? null
  );
};
var getDepartmentNameById = async (departmentId) => {
  if (!departmentId) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId);
  return department?.name || null;
};
var getSchoolRecordByName = async (schoolName) => {
  const normalizedSchoolName = schoolName?.toString().trim() || "";
  if (!normalizedSchoolName) return null;
  return await db.prepare(`
    SELECT id, name
    FROM schools
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalizedSchoolName);
};
var getDepartmentScopeByName = async (departmentName) => {
  const normalizedDepartmentName = departmentName?.toString().trim() || "";
  if (!normalizedDepartmentName) {
    return { department: null, schoolId: null, departmentIdsInSchool: [] };
  }
  const department = await db.prepare(`
    SELECT id, name, school_id
    FROM departments
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalizedDepartmentName);
  if (!department) {
    return { department: null, schoolId: null, departmentIdsInSchool: [] };
  }
  if (!department.school_id) {
    return { department, schoolId: null, departmentIdsInSchool: [department.id?.toString()].filter(Boolean) };
  }
  const siblingDepartments = await db.prepare(`
    SELECT id
    FROM departments
    WHERE school_id = ?
  `).all(department.school_id);
  return {
    department,
    schoolId: department.school_id,
    departmentIdsInSchool: siblingDepartments.map((item) => item?.id?.toString()).filter(Boolean)
  };
};
var getScopedDepartmentIdsForUser = async (user) => {
  const role = normalizeRoleLabel(user?.role);
  if (!role || isAdminRole(role) || isExecutiveViewRole(role) || ["Dean (P&M)", "Deputy Dean (P&M)", "Infrastructure Manager", "Maintenance Staff"].includes(role)) {
    return null;
  }
  if (["HOD", "Timetable Coordinator", "Faculty", "Event Coordinator"].includes(role)) {
    const scope = await getDepartmentScopeByName(user?.department);
    return scope.department?.id != null ? [scope.department.id.toString()] : [];
  }
  if (role === "Dean") {
    const accessibleSchoolIds = Array.from(getAccessibleSchoolIdSet(user));
    if (accessibleSchoolIds.length > 0) {
      const placeholders = accessibleSchoolIds.map(() => "?").join(", ");
      const departments = await db.prepare(`
        SELECT id
        FROM departments
        WHERE school_id IN (${placeholders})
      `).all(...accessibleSchoolIds);
      return departments.map((department) => department?.id?.toString()).filter(Boolean);
    }
    const scopedSchool = user?.school ? await getSchoolRecordByName(user.school) : null;
    if (scopedSchool?.id) {
      const departments = await db.prepare(`
        SELECT id
        FROM departments
        WHERE school_id = ?
      `).all(scopedSchool.id);
      return departments.map((department) => department?.id?.toString()).filter(Boolean);
    }
    const scope = await getDepartmentScopeByName(user?.department);
    return scope.departmentIdsInSchool || [];
  }
  return null;
};
var getScopedMappedRoomIdsForUser = async (user) => {
  const departmentIds = await getScopedDepartmentIdsForUser(user);
  if (departmentIds == null) return null;
  if (departmentIds.length === 0) return /* @__PURE__ */ new Set();
  const placeholders = departmentIds.map(() => "?").join(", ");
  const mappedRows = await db.prepare(`
    SELECT DISTINCT room_id
    FROM department_allocations
    WHERE room_id IS NOT NULL
      AND department_id IN (${placeholders})
  `).all(...departmentIds);
  return new Set(mappedRows.map((row) => row?.room_id?.toString()).filter(Boolean));
};
var normalizeUserPayload = async (payload, existingItem) => {
  const nextPayload = { ...existingItem || {}, ...payload || {} };
  nextPayload.full_name = nextPayload.full_name?.toString().trim() || "";
  nextPayload.employee_id = nextPayload.employee_id?.toString().trim() || "";
  nextPayload.role = normalizeRoleLabel(nextPayload.role);
  nextPayload.email = nextPayload.email?.toString().trim().toLowerCase() || "";
  nextPayload.school = nextPayload.school?.toString().trim() || "";
  nextPayload.department = nextPayload.department?.toString().trim() || "";
  nextPayload.designation = nextPayload.designation?.toString().trim() || null;
  nextPayload.mobile_number = nextPayload.mobile_number?.toString().trim() || null;
  nextPayload.responsibilities = nextPayload.responsibilities?.toString().trim() || null;
  nextPayload.access_limits = nextPayload.access_limits?.toString().trim() || null;
  nextPayload.access_paths = nextPayload.access_paths?.toString().trim() || null;
  nextPayload.dashboard_view_mode = normalizeDashboardViewMode(nextPayload.dashboard_view_mode);
  if (!nextPayload.full_name) throw new Error("Full name is required.");
  if (!nextPayload.employee_id) throw new Error("Employee ID is required.");
  if (!nextPayload.role) throw new Error("Role is required.");
  if (!nextPayload.email) throw new Error("Email address is required.");
  const role = normalizeRoleLabel(nextPayload.role);
  const normalizedRequestedAccessType = normalizeUserAccessTypeValue(nextPayload.access_type);
  const requestedAccessScope = nextPayload.access_scope?.toString().trim() || "";
  const requestedSchoolValues = Array.from(/* @__PURE__ */ new Set([
    ...parseDelimitedValues(nextPayload.assigned_school_ids),
    ...parseDelimitedValues(nextPayload.assigned_schools),
    ...nextPayload.school ? [nextPayload.school] : []
  ]));
  const requestedDepartmentValues = Array.from(/* @__PURE__ */ new Set([
    ...parseDelimitedValues(nextPayload.assigned_department_ids),
    ...parseDelimitedValues(nextPayload.assigned_departments),
    ...nextPayload.department ? [nextPayload.department] : []
  ]));
  const resolvedSchoolRecords = await resolveSchoolRecordsFromValues(requestedSchoolValues);
  const resolvedDepartmentRecords = await resolveDepartmentRecordsFromValues(requestedDepartmentValues);
  const inferredSchoolIdsFromDepartments = Array.from(new Set(
    resolvedDepartmentRecords.map((department) => department?.school_id?.toString()).filter(Boolean)
  ));
  const inferredSchoolRecords = inferredSchoolIdsFromDepartments.length === 0 ? [] : (await Promise.all(
    inferredSchoolIdsFromDepartments.map(
      async (schoolId) => await db.prepare("SELECT id, name, school_id FROM schools WHERE id = ?").get(schoolId)
    )
  )).filter(Boolean);
  const mergedSchoolRecords = [...resolvedSchoolRecords];
  inferredSchoolRecords.forEach((school) => {
    if (!mergedSchoolRecords.some((item) => item.id === school.id)) {
      mergedSchoolRecords.push(school);
    }
  });
  if (resolvedSchoolRecords.length > 0 && resolvedDepartmentRecords.some(
    (department) => !resolvedSchoolRecords.some((school) => idsEqual(school.id, department.school_id))
  )) {
    throw new Error("One or more selected departments do not belong to the selected schools.");
  }
  if (DEPARTMENT_SCOPE_ROLE_VALUES.has(role) && resolvedDepartmentRecords.length === 0 && !nextPayload.department) {
    throw new Error(`${role} users must be linked to a department.`);
  }
  if (SCHOOL_SCOPE_ROLE_VALUES.has(role) && mergedSchoolRecords.length === 0 && !nextPayload.school) {
    throw new Error(`${role} users must be linked to a school.`);
  }
  const primarySchoolCandidate = nextPayload.primary_school_id?.toString().trim() || nextPayload.primary_school?.toString().trim() || nextPayload.school?.toString().trim() || "";
  const primaryDepartmentCandidate = nextPayload.primary_department_id?.toString().trim() || nextPayload.primary_department?.toString().trim() || nextPayload.department?.toString().trim() || "";
  const normalizedPrimarySchoolCandidate = primarySchoolCandidate.toLowerCase();
  const normalizedPrimaryDepartmentCandidate = primaryDepartmentCandidate.toLowerCase();
  const primarySchoolRecord = mergedSchoolRecords.find(
    (school) => school.id?.toString() === primarySchoolCandidate || school.school_id?.toString().trim().toLowerCase() === normalizedPrimarySchoolCandidate || school.name?.toString().trim().toLowerCase() === normalizedPrimarySchoolCandidate
  ) || mergedSchoolRecords[0] || null;
  const primaryDepartmentRecord = resolvedDepartmentRecords.find(
    (department) => department.id?.toString() === primaryDepartmentCandidate || department.department_id?.toString().trim().toLowerCase() === normalizedPrimaryDepartmentCandidate || department.name?.toString().trim().toLowerCase() === normalizedPrimaryDepartmentCandidate
  ) || resolvedDepartmentRecords[0] || null;
  nextPayload.assigned_school_ids = mergedSchoolRecords.map((school) => school.id?.toString()).filter(Boolean).join(",");
  nextPayload.assigned_schools = mergedSchoolRecords.map((school) => school.name).filter(Boolean).join(", ");
  nextPayload.primary_school_id = primarySchoolRecord?.id?.toString() || null;
  nextPayload.primary_school = primarySchoolRecord?.name || null;
  nextPayload.assigned_department_ids = resolvedDepartmentRecords.map((department) => department.id?.toString()).filter(Boolean).join(",");
  nextPayload.assigned_departments = resolvedDepartmentRecords.map((department) => department.name).filter(Boolean).join(", ");
  nextPayload.primary_department_id = primaryDepartmentRecord?.id?.toString() || null;
  nextPayload.primary_department = primaryDepartmentRecord?.name || null;
  nextPayload.school = primarySchoolRecord?.name || null;
  nextPayload.department = primaryDepartmentRecord?.name || null;
  let derivedAccessType = normalizedRequestedAccessType;
  let derivedAccessScope = requestedAccessScope;
  if (normalizedRequestedAccessType === "Global") {
    derivedAccessType = "Global";
    derivedAccessScope = requestedAccessScope || "All";
  } else if (normalizedRequestedAccessType === "School") {
    derivedAccessType = "School";
    derivedAccessScope = requestedAccessScope || mergedSchoolRecords.map((school) => school.name).join(", ") || nextPayload.school || "";
  } else if (normalizedRequestedAccessType === "Department") {
    derivedAccessType = "Department";
    derivedAccessScope = requestedAccessScope || resolvedDepartmentRecords.map((department) => department.name).join(", ") || nextPayload.department || "";
  } else if (!derivedAccessType) {
    if (resolvedDepartmentRecords.length > 0 || nextPayload.department) {
      derivedAccessType = "Department";
      derivedAccessScope = resolvedDepartmentRecords.map((department) => department.name).join(", ") || nextPayload.department || requestedAccessScope || "";
    } else if (mergedSchoolRecords.length > 0 || nextPayload.school) {
      derivedAccessType = "School";
      derivedAccessScope = mergedSchoolRecords.map((school) => school.name).join(", ") || nextPayload.school || requestedAccessScope || "";
    } else {
      derivedAccessType = "Global";
      derivedAccessScope = requestedAccessScope || "All";
    }
  }
  nextPayload.access_type = derivedAccessType || null;
  nextPayload.access_scope = derivedAccessScope || null;
  if (isExecutiveViewRole(role)) {
    if (!nextPayload.dashboard_view_mode) {
      nextPayload.dashboard_view_mode = "Visual";
    }
    if (nextPayload.dashboard_view_mode && !DASHBOARD_VIEW_MODE_VALUES.has(nextPayload.dashboard_view_mode)) {
      nextPayload.dashboard_view_mode = "Visual";
    }
  } else {
    nextPayload.dashboard_view_mode = null;
  }
  return nextPayload;
};
var backfillNotificationsIfEmpty = async () => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const notificationCount = await db.prepare("SELECT COUNT(*) as count FROM notifications").get();
  if ((notificationCount?.count || 0) > 0) return;
  const bookings = await db.prepare("SELECT * FROM bookings ORDER BY id ASC").all();
  for (const booking of bookings) {
    const bookingLabel = booking.event_name || "room request";
    const bookingTime = booking.date && booking.start_time && booking.end_time ? `${booking.date} from ${booking.start_time} to ${booking.end_time}` : booking.date || "the selected slot";
    const departmentName = await getDepartmentNameById(booking.department_id);
    if (booking.status === "Pending") {
      await createNotification(null, booking.faculty_name, "Room request submitted", `${bookingLabel} was submitted for approval for ${bookingTime}.`);
      await notifyBookingAuthorities(booking, "New room request", `${booking.faculty_name} requested ${bookingLabel} on ${bookingTime}.`);
      continue;
    }
    if (booking.status === "HOD Recommended") {
      await createNotification(null, booking.faculty_name, "Request recommended", `${bookingLabel} was recommended by HOD for ${bookingTime}.`);
      await createNotification("Dean (P&M)", null, "Request recommended", `${bookingLabel} was recommended by HOD for ${bookingTime}.`);
      await createNotification("Deputy Dean (P&M)", null, "Request recommended", `${bookingLabel} was recommended by HOD for ${bookingTime}.`);
      if (departmentName) {
        await createNotification("HOD", null, "Request recommended", `${bookingLabel} was recommended by HOD for ${bookingTime}.`, departmentName);
      }
      continue;
    }
    if (booking.status === "Approved") {
      await createNotification(null, booking.faculty_name, "Room booking approved", `${bookingLabel} was approved for ${bookingTime}.`);
      continue;
    }
    if (booking.status === "Rejected" || booking.status === "Postponed") {
      await createNotification(null, booking.faculty_name, `Request ${booking.status}`, `${bookingLabel} was marked as ${booking.status.toLowerCase()} for ${bookingTime}.`);
    }
  }
};
var getNotificationAudienceParams = (user) => {
  const normalizedRole = normalizeRoleLabel(user?.role);
  const normalizedRoleAliases = Array.from(new Set([
    normalizedRole,
    user?.role?.toString().trim() || null
  ].filter(Boolean)));
  const normalizedName = user?.name?.toString().trim().toLowerCase() || null;
  const normalizedDepartments = Array.from(new Set([
    user?.department?.toString().trim().toLowerCase() || null,
    ...(Array.isArray(user?.assigned_departments) ? user.assigned_departments : []).map((department) => department?.toString().trim().toLowerCase()).filter(Boolean)
  ].filter(Boolean)));
  return { normalizedRoleAliases, normalizedName, normalizedDepartments };
};
var getNotificationsForUser = async (user, limit = 20) => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const { normalizedRoleAliases, normalizedName, normalizedDepartments } = getNotificationAudienceParams(user);
  const notifications = await db.prepare(`
    SELECT
      n.*,
      CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END as is_read
    FROM notifications n
    LEFT JOIN notification_reads nr
      ON nr.notification_id = n.id
      AND nr.user_id = ?
    WHERE (n.target_role IS NULL AND n.target_name IS NULL AND n.target_department IS NULL)
      OR LOWER(TRIM(COALESCE(n.target_name, ''))) = ?
      OR n.target_role IS NOT NULL
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ?
  `).all(user.id, normalizedName, Math.max(limit * 10, 200));
  return notifications.filter((notification) => {
    const targetRole = notification?.target_role?.toString().trim();
    if (targetRole) {
      const normalizedTargetRole = normalizeRoleLabel(targetRole);
      if (!normalizedRoleAliases.includes(normalizedTargetRole) && !normalizedRoleAliases.includes(targetRole)) {
        return false;
      }
    }
    const targetDepartment = notification?.target_department?.toString().trim().toLowerCase();
    if (!targetDepartment) return true;
    return normalizedDepartments.includes(targetDepartment);
  }).slice(0, limit);
};
var markAllNotificationsRead = async (user, notificationIds) => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const normalizedIds = Array.isArray(notificationIds) ? notificationIds.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id) && id > 0) : [];
  const visibleNotificationIds = (await getNotificationsForUser(user, 1e3)).map((notification) => notification.id).filter((id) => normalizedIds.length === 0 || normalizedIds.includes(id));
  if (visibleNotificationIds.length === 0) return;
  const insertSql = `
    INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
  `;
  await db.transaction(async (transactionDb) => {
    const insertRead = transactionDb.prepare(insertSql);
    for (const id of visibleNotificationIds) {
      await insertRead.run(id, user.id);
    }
  });
};
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const requestOrigin = normalizeOrigin(typeof req.headers.origin === "string" ? req.headers.origin : "");
  if (requestOrigin && allowedOrigins.has(requestOrigin)) {
    res.header("Access-Control-Allow-Origin", requestOrigin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Vary", "Origin");
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }
  }
  next();
});
app.use((_req, res, next) => {
  if (dbInitializationError) {
    return res.status(503).json({ error: "Service unavailable: database could not be initialized." });
  }
  next();
});
var getAuthCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax"
});
var authenticate = async (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.id;
    if (userId) {
      const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      req.user = await getUserSessionPayload(user);
    } else {
      req.user = decoded;
    }
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};
var getAIResponseText = async (response) => {
  const textValue = response?.text;
  if (typeof textValue === "function") return await textValue.call(response);
  if (typeof textValue === "string") return textValue;
  if (typeof response?.response?.text === "function") return await response.response.text();
  throw new Error("AI response did not include readable text.");
};
var parseAIJsonResponse = (text) => {
  let cleanText = text.trim();
  if (cleanText.includes("```json")) {
    cleanText = cleanText.split("```json")[1].split("```")[0];
  } else if (cleanText.includes("```")) {
    cleanText = cleanText.split("```")[1].split("```")[0];
  }
  return JSON.parse(cleanText);
};
var composeDashboardInsightFallback = (stats, schoolReports) => {
  const topSchool = (Array.isArray(schoolReports) ? schoolReports : []).filter((school) => school?.name && school.name !== "Unmapped").sort((a, b) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0))[0];
  if (!topSchool) {
    return "No school utilization data is available yet. Add room allocations, schedules, or approved bookings to populate live insights.";
  }
  const summaryParts = [
    `${topSchool.name} is currently at ${Number(topSchool?.avgUtilization) || 0}% average utilization.`,
    `${stats?.availableNow || 0} rooms are available right now.`
  ];
  if ((stats?.pendingBookings || 0) > 0) {
    summaryParts.push(`${stats.pendingBookings} pending booking request${stats.pendingBookings === 1 ? "" : "s"} need review.`);
  }
  if ((stats?.equipmentIssues || 0) > 0) {
    summaryParts.push(`${stats.equipmentIssues} maintenance issue${stats.equipmentIssues === 1 ? "" : "s"} need attention.`);
  }
  return summaryParts.join(" ");
};
var composeDigitalTwinOptimizationFallback = (summary) => {
  const totalRooms = Number(summary?.totals?.rooms) || 0;
  const scheduledNow = Number(summary?.live?.scheduledNow) || 0;
  const bookedNow = Number(summary?.live?.bookedNow) || 0;
  const maintenanceRooms = Number(summary?.live?.maintenanceRooms) || 0;
  const availableNow = Number(summary?.live?.availableNow) || 0;
  const activeRooms = scheduledNow + bookedNow;
  const efficiencyScore = totalRooms > 0 ? Math.max(10, Math.min(100, Math.round((activeRooms + availableNow) / totalRooms * 100 - maintenanceRooms))) : 45;
  const topBuildings = Array.isArray(summary?.topBuildings) ? summary.topBuildings : [];
  const topBuildingLabel = topBuildings[0]?.name ? `${topBuildings[0].name}` : "the busiest building";
  const recommendations = [
    `Prioritize timetable balancing for ${topBuildingLabel} to reduce concentrated peak load and improve room spread across other buildings.`,
    `Convert rooms with repeated low usage into flexible shared pools for elective, lab support, and event overflow slots.`,
    `Auto-tag maintenance-prone rooms for proactive checks before daily peak hours to avoid avoidable schedule disruptions.`
  ];
  const futureForecast = maintenanceRooms > 0 ? "If maintenance backlog is reduced and low-usage rooms are rebalanced, utilization consistency should improve over the next 2-4 weeks." : "Current infrastructure is stable; adding periodic balancing of schedules and bookings should increase effective utilization in upcoming weeks.";
  const simulationImpact = totalRooms > 0 ? `Simulated rebalancing indicates up to ${Math.max(4, Math.min(18, Math.round(activeRooms / Math.max(totalRooms, 1) * 20)))}% improvement in peak-slot distribution.` : "Simulation baseline is limited because room inventory is still being populated.";
  return {
    recommendations,
    futureForecast,
    efficiencyScore,
    simulationImpact,
    source: "fallback"
  };
};
var normalizeDigitalTwinOptimizationResponse = (payload, fallback) => {
  const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations.map((item) => item?.toString?.().trim()).filter(Boolean) : [];
  const futureForecast = payload?.futureForecast?.toString?.().trim() || "";
  const simulationImpact = payload?.simulationImpact?.toString?.().trim() || "";
  const rawScore = Number(payload?.efficiencyScore);
  const efficiencyScore = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : NaN;
  if (recommendations.length === 0 || !futureForecast || !Number.isFinite(efficiencyScore)) {
    return fallback;
  }
  return {
    recommendations: recommendations.slice(0, 6),
    futureForecast,
    efficiencyScore,
    simulationImpact: simulationImpact || fallback.simulationImpact,
    source: "ai"
  };
};
var composeUtilizationOptimizationFallback = (snapshot) => {
  const rows = Array.isArray(snapshot) ? snapshot : [];
  const underused = rows.filter((row) => Number(row?.util) < 40).sort((a, b) => Number(a?.util || 0) - Number(b?.util || 0)).slice(0, 8);
  if (!underused.length) {
    return [
      {
        title: "Maintain Balanced Usage",
        suggestion: "Current utilization distribution is relatively balanced. Continue monitoring weekly and rotate low-demand sessions across buildings to prevent clustering.",
        impact: "Medium"
      },
      {
        title: "Reserve Flexible Rooms",
        suggestion: "Keep a small pool of multi-purpose rooms available for ad-hoc events and overflow labs to improve response time for urgent requests.",
        impact: "Medium"
      },
      {
        title: "Track Booking-to-Use Variance",
        suggestion: "Compare approved bookings against actual usage and tighten approval windows where repeated no-shows are observed.",
        impact: "Low"
      }
    ];
  }
  const lowestRooms = underused.slice(0, 3).map((row) => row?.room).filter(Boolean).join(", ");
  const lowDept = underused.reduce((acc, row) => {
    const key = row?.dept?.toString?.().trim() || "Unmapped";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const focusDept = Object.entries(lowDept).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "target departments";
  return [
    {
      title: "Rebalance Underused Rooms",
      suggestion: `Prioritize timetable reallocation for low-usage rooms (${lowestRooms || "identified rooms"}) by moving repeat sessions from overloaded spaces into these rooms.`,
      impact: "High"
    },
    {
      title: "Department Scheduling Window",
      suggestion: `Introduce a focused scheduling review with ${focusDept} to spread class timings across the day and reduce concentration in peak slots.`,
      impact: "High"
    },
    {
      title: "Demand-Based Room Pooling",
      suggestion: "Convert chronically underused rooms into a shared pool for electives, tutorials, and seminar overflow with weekly utilization tracking.",
      impact: "Medium"
    }
  ];
};
var normalizeUtilizationOptimizationResponse = (payload, fallback) => {
  const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : Array.isArray(payload) ? payload : [];
  const normalized = suggestions.map((item) => ({
    title: item?.title?.toString?.().trim() || "",
    suggestion: item?.suggestion?.toString?.().trim() || "",
    impact: item?.impact?.toString?.().trim() || "Medium"
  })).filter((item) => item.title && item.suggestion).map((item) => ({
    ...item,
    impact: ["High", "Medium", "Low"].includes(item.impact) ? item.impact : "Medium"
  }));
  return normalized.length ? normalized.slice(0, 6) : fallback;
};
var normalizeExtractedSectionValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const match = raw.match(/section[\s:-]*([a-z0-9]+)/i) || raw.match(/^([a-z]+\d+)$/i);
  return (match?.[1] || raw).toUpperCase();
};
var normalizeExtractedSpecializationValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const explicitMatch = raw.match(/(?:specialization|branch)[\s:-]*([a-z0-9&/ -]+)/i);
  if (explicitMatch?.[1]) {
    return normalizeScheduleSpecializationValue(explicitMatch[1]) || "";
  }
  const singleToken = raw.match(/^(aott|emct|dt|mlt|cvt|opt|rit|rt)$/i);
  if (singleToken?.[1]) {
    return normalizeScheduleSpecializationValue(singleToken[1]) || "";
  }
  const bscHeaderMatch = raw.match(/\bb\.?\s*sc\b[\s:-]*([a-z0-9&/ -]+?)\s+(?:i|ii|iii|iv|v|vi|vii|viii|\d+(?:st|nd|rd|th)?)\s+semester\b/i);
  if (bscHeaderMatch?.[1]) {
    return normalizeScheduleSpecializationValue(bscHeaderMatch[1]) || "";
  }
  return normalizeScheduleSpecializationValue(raw) || "";
};
var normalizeExtractedProgramValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const directMatch = raw.match(/\b(b\.?\s*sc|bpt|b\.?\s*pharm|b\.?\s*tech|m\.?\s*tech)\b/i);
  if (directMatch?.[1]) {
    return normalizeScheduleProgramValue(directMatch[1]) || "";
  }
  return normalizeScheduleProgramValue(raw) || "";
};
var normalizeExtractedRoomValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const directMatch = raw.match(/(?:room|r)\s*\.?\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i) || raw.match(/\b([a-z]?\d{3,4}[a-z]?)\b/i);
  return directMatch?.[1]?.toUpperCase() || raw;
};
var mergeExtractedSchedulesWithHeaderRooms = (schedules, sectionRoomMaps) => {
  if (!Array.isArray(schedules) || schedules.length === 0) return [];
  const fallbackBySection = /* @__PURE__ */ new Map();
  const fallbackBySpecialization = /* @__PURE__ */ new Map();
  for (const item of Array.isArray(sectionRoomMaps) ? sectionRoomMaps : []) {
    const section = normalizeExtractedSectionValue(item?.section);
    const room = normalizeExtractedRoomValue(item?.room);
    const semester = item?.semester || null;
    const department = item?.department || null;
    const program = normalizeExtractedProgramValue(item?.program || item?.program_context || item?.title || item?.header) || null;
    const year_of_study = normalizeYearOfStudyKey(item?.year_of_study || item?.year) || null;
    const specialization = normalizeExtractedSpecializationValue(item?.specialization || item?.branch || item?.title || item?.header) || null;
    if (section && (room || semester || department || program || year_of_study || specialization) && !fallbackBySection.has(section)) {
      fallbackBySection.set(section, { room, semester, department, program, year_of_study, specialization });
    }
    if (specialization && (room || semester || department || program || year_of_study) && !fallbackBySpecialization.has(specialization)) {
      fallbackBySpecialization.set(specialization, { room, semester, department, program, year_of_study, specialization });
    }
  }
  const singleFallback = Array.isArray(sectionRoomMaps) && sectionRoomMaps.length === 1 ? (() => {
    const item = sectionRoomMaps[0];
    return {
      room: normalizeExtractedRoomValue(item?.room),
      semester: item?.semester || null,
      department: item?.department || null,
      program: normalizeExtractedProgramValue(item?.program || item?.program_context || item?.title || item?.header) || null,
      year_of_study: normalizeYearOfStudyKey(item?.year_of_study || item?.year) || null,
      specialization: normalizeExtractedSpecializationValue(item?.specialization || item?.branch || item?.title || item?.header) || null
    };
  })() : null;
  return schedules.map((schedule) => {
    const normalizedSection = normalizeExtractedSectionValue(schedule?.section);
    const normalizedProgram = normalizeExtractedProgramValue(schedule?.program || schedule?.program_context || schedule?.header) || null;
    const normalizedSpecialization = normalizeExtractedSpecializationValue(schedule?.specialization || schedule?.branch || schedule?.program_context || schedule?.header) || null;
    const explicitRoom = normalizeExtractedRoomValue(schedule?.room);
    const inheritedDefaults = (normalizedSection ? fallbackBySection.get(normalizedSection) : null) || (normalizedSpecialization ? fallbackBySpecialization.get(normalizedSpecialization) : null) || singleFallback;
    const inheritedRoom = inheritedDefaults?.room || "";
    const inheritedYear = inheritedDefaults?.year_of_study || "";
    const scheduleYear = normalizeYearOfStudyKey(schedule?.year_of_study || schedule?.year);
    const derivedYearFromSemester = (() => {
      const semesterNumber = parseSemesterNumber(schedule?.semester || inheritedDefaults?.semester);
      return semesterNumber ? Math.ceil(semesterNumber / 2).toString() : "";
    })();
    return {
      ...schedule,
      section: normalizedSection || schedule?.section || null,
      department: schedule?.department || inheritedDefaults?.department || null,
      program: normalizedProgram || inheritedDefaults?.program || null,
      specialization: normalizedSpecialization || inheritedDefaults?.specialization || null,
      semester: schedule?.semester || inheritedDefaults?.semester || null,
      year_of_study: scheduleYear || inheritedYear || derivedYearFromSemester || null,
      room: explicitRoom || inheritedRoom || schedule?.room || null
    };
  });
};
var getUserSessionPayload = async (user) => {
  const schoolContext = await buildUserSchoolContext(user);
  const context = await buildUserDepartmentContext(user);
  return {
    id: user.id,
    email: user.email,
    role: normalizeRoleLabel(user.role),
    name: user.full_name,
    school: schoolContext.primarySchoolName || user.school,
    primary_school_id: schoolContext.primarySchoolId,
    primary_school: schoolContext.primarySchoolName,
    assigned_school_ids: schoolContext.assignedSchoolIds,
    assigned_schools: schoolContext.assignedSchoolNames,
    school_assignments: schoolContext.assignments.map((assignment) => ({
      id: assignment.id,
      school_id: assignment.school_id,
      school_name: assignment.school_name,
      school_code: assignment.school_code,
      is_primary: Number(assignment.is_primary) === 1,
      valid_from: assignment.valid_from || null,
      valid_until: assignment.valid_until || null,
      status: assignment.status || "Active"
    })),
    department: context.primaryDepartmentName || user.department || null,
    primary_department_id: context.primaryDepartmentId,
    primary_department: context.primaryDepartmentName,
    assigned_department_ids: context.assignedDepartmentIds,
    assigned_departments: context.assignedDepartmentNames,
    department_assignments: context.assignments.map((assignment) => ({
      id: assignment.id,
      department_id: assignment.department_id,
      department_name: assignment.department_name,
      department_code: assignment.department_code,
      school_id: assignment.school_id,
      is_primary: Number(assignment.is_primary) === 1,
      valid_from: assignment.valid_from || null,
      valid_until: assignment.valid_until || null,
      status: assignment.status || "Active"
    })),
    designation: user.designation,
    responsibilities: user.responsibilities,
    access_limits: user.access_limits,
    access_type: user.access_type,
    access_scope: user.access_scope,
    access_paths: user.access_paths,
    dashboard_view_mode: isExecutiveViewRole(user.role) ? normalizeDashboardViewMode(user.dashboard_view_mode) || "Visual" : null,
    force_password_change: !!user.force_password_change
  };
};
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const sessionUser = await getUserSessionPayload(user);
    const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, getAuthCookieOptions());
    res.json({ user: sessionUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token", getAuthCookieOptions());
  res.json({ success: true });
});
app.get("/api/auth/me", async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded?.id;
    if (!userId) return res.json({ user: decoded });
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!user) return res.status(401).json({ error: "Not logged in" });
    res.json({ user: await getUserSessionPayload(user) });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
});
app.put("/api/auth/preferences/dashboard-view", authenticate, async (req, res) => {
  try {
    const normalizedRole = normalizeRoleLabel(req.user?.role);
    if (!isExecutiveViewRole(normalizedRole)) {
      return res.status(403).json({ error: "Dashboard view preferences are only available for executive dashboards." });
    }
    const dashboardViewMode = normalizeDashboardViewMode(req.body?.dashboard_view_mode);
    if (!dashboardViewMode) {
      return res.status(400).json({ error: "A valid dashboard view mode is required." });
    }
    await db.prepare("UPDATE users SET dashboard_view_mode = ? WHERE id = ?").run(dashboardViewMode, req.user.id);
    const updatedUser = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    const sessionUser = await getUserSessionPayload(updatedUser);
    const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, getAuthCookieOptions());
    res.json({ user: sessionUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/ai/dashboard-insight", authenticate, async (req, res) => {
  try {
    const safeStats = req.body?.stats && typeof req.body.stats === "object" ? req.body.stats : {};
    const safeSchoolReports = Array.isArray(req.body?.schoolReports) ? req.body.schoolReports : [];
    const fallbackInsight = composeDashboardInsightFallback(safeStats, safeSchoolReports);
    if (!GEMINI_API_KEY) {
      return res.json({ insight: fallbackInsight, source: "fallback" });
    }
    try {
      const rankedSchools = safeSchoolReports.filter((school) => school?.name).sort((a, b) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0)).slice(0, 3).map((school) => `${school.name}: ${Number(school?.avgUtilization) || 0}%`).join(", ");
      const prompt = `You are a campus operations assistant.
Generate one concise admin insight sentence (maximum 55 words) using this live context.
Top school utilization: ${rankedSchools || "No school data"}.
Available rooms now: ${Number(safeStats?.availableNow) || 0}.
Scheduled rooms today: ${Number(safeStats?.scheduledRooms) || 0}.
Scheduled rooms right now: ${Number(safeStats?.activeScheduledRooms) || 0}.
Pending bookings: ${Number(safeStats?.pendingBookings) || 0}.
Equipment issues: ${Number(safeStats?.equipmentIssues) || 0}.
Keep it factual and actionable. Do not use markdown, bullets, or emojis.`;
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }]
      });
      const generatedText = (await getAIResponseText(response)).replace(/\s+/g, " ").trim().replace(/^["'`]|["'`]$/g, "");
      if (!generatedText) {
        return res.json({ insight: fallbackInsight, source: "fallback" });
      }
      return res.json({ insight: generatedText, source: "ai" });
    } catch (aiErr) {
      console.error("Dashboard AI insight fallback:", aiErr?.message || aiErr);
      return res.json({ insight: fallbackInsight, source: "fallback" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/ai/digital-twin-optimization", authenticate, async (req, res) => {
  try {
    const summary = req.body?.summary && typeof req.body.summary === "object" ? req.body.summary : {};
    const fallback = composeDigitalTwinOptimizationFallback(summary);
    if (!GEMINI_API_KEY) {
      return res.json(fallback);
    }
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const prompt = `You are a campus infrastructure optimization assistant.
Analyze the following digital twin summary and return only JSON with these keys:
- recommendations (array of concise actionable strings)
- futureForecast (string)
- efficiencyScore (number 0-100)
- simulationImpact (string)

Context summary JSON:
${JSON.stringify(summary)}

Rules:
- Keep recommendations specific and operational.
- Mention maintenance and scheduling distribution when relevant.
- Do not include markdown or explanation outside JSON.`;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      });
      const parsed = parseAIJsonResponse(await getAIResponseText(response));
      return res.json(normalizeDigitalTwinOptimizationResponse(parsed, fallback));
    } catch (aiErr) {
      console.error("Digital twin optimization fallback:", aiErr?.message || aiErr);
      return res.json(fallback);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/ai/utilization-optimization", authenticate, async (req, res) => {
  try {
    const snapshot = Array.isArray(req.body?.snapshot) ? req.body.snapshot : [];
    const fallbackSuggestions = composeUtilizationOptimizationFallback(snapshot);
    if (!GEMINI_API_KEY) {
      return res.json({ suggestions: fallbackSuggestions, source: "fallback" });
    }
    try {
      const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      const prompt = `You are a campus infrastructure optimization assistant.
Analyze the underutilized room snapshot below and return only JSON.

Required JSON format:
{
  "suggestions": [
    { "title": "...", "suggestion": "...", "impact": "High|Medium|Low" }
  ]
}

Rules:
- Provide 3 to 5 specific suggestions.
- Focus on timetable balancing, sharing strategy, and actionable utilization improvements.
- Keep each suggestion concise and operational.
- Do not include markdown or explanation outside JSON.

Snapshot:
${JSON.stringify(snapshot)}`;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" }
      });
      const raw = await getAIResponseText(response);
      const parsed = parseAIJsonResponse(raw);
      const suggestions = normalizeUtilizationOptimizationResponse(parsed, fallbackSuggestions);
      return res.json({ suggestions, source: "ai" });
    } catch (aiErr) {
      console.error("Utilization AI fallback:", aiErr?.message || aiErr);
      return res.json({ suggestions: fallbackSuggestions, source: "fallback" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to generate utilization optimization suggestions." });
  }
});
app.post("/api/performance/module-load", authenticate, async (req, res) => {
  try {
    const moduleName = req.body?.module?.toString().trim() || "";
    const phase = req.body?.phase?.toString().trim() || "default";
    const durationMs = Number(req.body?.durationMs);
    const itemCount = Number(req.body?.itemCount || 0);
    if (!moduleName) {
      return res.status(400).json({ error: "Module name is required." });
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return res.status(400).json({ error: "Duration must be a valid non-negative number." });
    }
    moduleLoadTelemetry.push({
      module: moduleName,
      phase,
      durationMs: Math.round(durationMs),
      itemCount: Number.isFinite(itemCount) ? Math.max(0, Math.round(itemCount)) : 0,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      userRole: req.user?.role || ""
    });
    if (moduleLoadTelemetry.length > MAX_MODULE_LOAD_TELEMETRY) {
      moduleLoadTelemetry.splice(0, moduleLoadTelemetry.length - MAX_MODULE_LOAD_TELEMETRY);
    }
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/performance/module-load", authenticate, async (_req, res) => {
  try {
    const grouped = /* @__PURE__ */ new Map();
    moduleLoadTelemetry.forEach((record) => {
      const key = `${record.module}::${record.phase}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          module: record.module,
          phase: record.phase,
          samples: 1,
          avgDurationMs: record.durationMs,
          maxDurationMs: record.durationMs,
          lastDurationMs: record.durationMs,
          avgItemCount: record.itemCount,
          lastSeenAt: record.createdAt
        });
        return;
      }
      const nextSamples = existing.samples + 1;
      existing.avgDurationMs = Math.round((existing.avgDurationMs * existing.samples + record.durationMs) / nextSamples);
      existing.avgItemCount = Math.round((existing.avgItemCount * existing.samples + record.itemCount) / nextSamples);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, record.durationMs);
      existing.lastDurationMs = record.durationMs;
      existing.samples = nextSamples;
      existing.lastSeenAt = record.createdAt;
    });
    res.json({
      summary: Array.from(grouped.values()).sort((left, right) => right.avgDurationMs - left.avgDurationMs),
      recent: moduleLoadTelemetry.slice(-50).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/ai/extract-timetable", authenticate, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API key is missing. Set GEMINI_API_KEY on the backend." });
    }
    const { data, mimeType, fileName } = req.body || {};
    if (!data || !mimeType) {
      return res.status(400).json({ error: "File data and mime type are required." });
    }
    const base64Data = data.toString().includes(",") ? data.toString().split(",").pop() : data.toString();
    const parts = [];
    if (mimeType === "application/pdf") {
      parts.push({
        inlineData: {
          data: base64Data,
          mimeType
        }
      });
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const buffer = Buffer.from(base64Data, "base64");
      const result = await mammoth.extractRawText({ buffer });
      parts.push({ text: `Extracted text from ${fileName || "DOCX document"}:

${result.value}` });
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a PDF or DOCX file." });
    }
    parts.push({ text: `Extract all timetable entries from this document.
The document contains multiple sections (A1, A2, etc.).
Extract info for ALL sections.

Return a single JSON object with exactly these keys:
- sectionRoomMaps: array of objects with fields:
  - section
  - room
  - program
  - year_of_study
  - semester
  - department
- schedules: array of objects with fields:
  - department (e.g., "Computer Science and Engineering")
  - program (e.g., "B.Sc", "BPT", "B.Tech")
  - section (e.g., "A1", "A2", "A10" from headers like SECTION-A1)
  - year_of_study (Roman or numeric year if available, e.g., "II", "2", "IV Year")
  - semester (prefer the exact semester if available, e.g., "IV", "6", or "VI Semester"; use Odd/Even only if the file truly provides no exact semester)
  - course_code (if available, else null)
  - course_name (the subject name, e.g., "Computer Networks")
  - faculty (the teacher's name)
  - room (the room number, e.g., "322")
  - day_of_week (Full name: Monday, Tuesday, etc.)
  - start_time (24h format HH:mm, e.g., "09:00")
  - end_time (24h format HH:mm, e.g., "09:55")
  - student_count (estimate or null)

Ensure sectionRoomMaps captures the default Room No and academic context from the header of each section timetable.
Ensure you capture the Section mentioned in the header of each timetable and repeat it for every extracted row from that section.
Also capture the Program from the timetable heading, such as B.Sc or BPT, and repeat it for every extracted row in that timetable even when Section is blank.
Also capture any Specialization / Branch from the timetable heading, such as AOTT, CVT, OPT, or BPT, and repeat it for every extracted row in that branch timetable even when Section is blank.
For normal theory slots, use the section header Room No as the room.
Only use a different room when that specific slot explicitly overrides it with text like (R.No.610) or Room No: 610 inside the timetable grid.
Only extract actual class sessions.
Ignore labels and non-course cells such as "Reading Period", "Reading Periods", "Period", "Periods", "Break", "Lunch", "Tea Break", "Library", section titles, room headings, and plain time-slot labels.
The course_name must always be the real subject title.
If a slot has multiple subjects or is a lab, create separate entries if needed or one entry with combined info.

Example response:
{
  "sectionRoomMaps": [{"section":"A4","program":"B.Sc","specialization":"CVT","room":"331","year_of_study":"II","semester":"IV Semester","department":"Computer Science and Engineering"}],
  "schedules": [{"department":"Computer Science and Engineering","program":"B.Sc","specialization":"CVT","section":"A4","year_of_study":"II","semester":"IV Semester","course_code":"22ME101703M","course_name":"Management Science","faculty":"MOOC","room":"331","day_of_week":"Monday","start_time":"09:00","end_time":"09:55","student_count":null}]
}` });
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts }],
      config: { responseMimeType: "application/json" }
    });
    const extractedPayload = parseAIJsonResponse(await getAIResponseText(response));
    const schedules = Array.isArray(extractedPayload) ? extractedPayload : Array.isArray(extractedPayload?.schedules) ? extractedPayload.schedules : [];
    const sectionRoomMaps = Array.isArray(extractedPayload?.sectionRoomMaps) ? extractedPayload.sectionRoomMaps : Array.isArray(extractedPayload?.section_room_maps) ? extractedPayload.section_room_maps : [];
    const enrichedSchedules = mergeExtractedSchedulesWithHeaderRooms(
      schedules,
      sectionRoomMaps
    );
    res.json({ schedules: enrichedSchedules });
  } catch (err) {
    const errorMessage = err?.message || "";
    const leakedKey = /reported as leaked|leaked/i.test(errorMessage);
    const invalidKey = /API key not valid|API_KEY_INVALID|Invalid API Key|PERMISSION_DENIED/i.test(errorMessage);
    res.status(500).json({
      error: leakedKey ? "The configured Gemini API key was reported as leaked and cannot be used. Create a new key in Google AI Studio, set it as GEMINI_API_KEY in .env, remove the old VITE_GEMINI_API_KEY value, and restart the server." : invalidKey ? "Gemini rejected the configured API key. Set a valid GEMINI_API_KEY on the backend and restart the server." : errorMessage || "Failed to extract timetable."
    });
  }
});
app.get("/api/notifications", authenticate, async (req, res) => {
  try {
    const notifications = await getNotificationsForUser(req.user);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/notifications/read-all", authenticate, async (req, res) => {
  try {
    await markAllNotificationsRead(req.user, req.body?.notificationIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
app.post("/api/auth/forgot-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Admin or Master Admin." });
});
app.post("/api/auth/reset-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Admin or Master Admin." });
});
app.post("/api/auth/change-password", authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.toString().trim().length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const hashedPassword = bcrypt.hashSync(password.toString(), 10);
    await db.prepare("UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?").run(hashedPassword, req.user.id);
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    const sessionUser = await getUserSessionPayload(user);
    const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, getAuthCookieOptions());
    res.json({ user: sessionUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
var duplicateRules = {
  users: [
    { fields: ["employee_id"], label: "Employee ID" },
    { fields: ["email"], label: "Email" }
  ],
  campuses: [
    { fields: ["campus_id"], label: "Campus ID" },
    { fields: ["name"], label: "Campus name" }
  ],
  buildings: [
    { fields: ["building_id"], label: "Building ID" },
    { fields: ["campus_id", "name"], label: "Building name in this campus" }
  ],
  blocks: [
    { fields: ["block_id"], label: "Block ID" },
    { fields: ["building_id", "name"], label: "Block name in this building" }
  ],
  floors: [
    { fields: ["floor_id"], label: "Floor ID" },
    { fields: ["block_id", "floor_number"], label: "Floor number in this block" }
  ],
  rooms: [
    { fields: ["room_id"], label: "Room ID" },
    { fields: ["room_number"], label: "Room number" }
  ],
  schools: [
    { fields: ["school_id"], label: "School ID" },
    { fields: ["name"], label: "School name" }
  ],
  departments: [
    { fields: ["department_id"], label: "Department ID" },
    { fields: ["school_id", "name"], label: "Department name in this school" }
  ],
  department_allocations: [
    { fields: ["room_id", "department_id", "semester"], label: "Room allocation for this department and semester" }
  ],
  hod_room_allocations: [
    { fields: ["room_id", "hod_user_id", "semester"], label: "Room allocation for this HOD and semester" }
  ],
  academic_calendars: [
    { fields: ["calendar_id"], label: "Calendar ID" },
    { fields: ["department_id", "program", "batch", "specialization", "year_of_study", "semester", "event_type", "title", "start_date", "end_date"], label: "Academic calendar period" }
  ],
  timing_profiles: [
    { fields: ["profile_id"], label: "Timing Profile ID" },
    { fields: ["department_id", "program", "specialization", "academic_year", "year_of_study", "semester", "section", "slot_pattern"], label: "Timing profile context" }
  ],
  batch_room_allocations: [
    { fields: ["allocation_id"], label: "Allocation ID" },
    { fields: ["room_id", "department_id", "program", "batch", "specialization", "year_of_study", "semester", "start_date", "end_date"], label: "Batch room allocation period" }
  ],
  equipment: [
    { fields: ["equipment_id"], label: "Equipment ID" },
    { fields: ["room_id", "name"], label: "Equipment name in this room" }
  ],
  schedules: [
    { fields: ["schedule_id"], label: "Schedule ID" },
    { fields: ["room_id", "program", "specialization", "section", "day_of_week", "start_time", "end_time"], label: "Schedule slot for this room, program, branch, and section" }
  ],
  bookings: [
    { fields: ["request_id"], label: "Request ID" }
  ],
  maintenance: [
    { fields: ["maintenance_id"], label: "Maintenance ID" }
  ]
};
var normalizeDuplicateValue = (value) => typeof value === "string" ? value.trim().toLowerCase() : value;
var idsEqual = (left, right) => left !== void 0 && left !== null && right !== void 0 && right !== null && left.toString() === right.toString();
var normalizeReferenceLookupValue = (value) => value === void 0 || value === null ? "" : value.toString().trim();
var resolveReferenceRecordId = async ({
  targetTable,
  rawValue,
  codeField,
  labelFields = [],
  scope = [],
  entityLabel,
  preferredIdentifierLabel
}) => {
  const normalizedValue = normalizeReferenceLookupValue(rawValue);
  if (!normalizedValue) return rawValue;
  const records = await db.prepare(`SELECT * FROM ${targetTable}`).all();
  const scopedRecords = records.filter(
    (record) => scope.every(({ field, value }) => {
      const scopedValue = normalizeReferenceLookupValue(value);
      return !scopedValue || idsEqual(record?.[field], scopedValue);
    })
  );
  const candidates = scopedRecords.length > 0 ? scopedRecords : records;
  const normalizedLookup = normalizeDuplicateValue(normalizedValue);
  const matches = candidates.filter((record) => {
    if (idsEqual(record?.id, normalizedValue)) return true;
    if (normalizeDuplicateValue(record?.[codeField]) === normalizedLookup) return true;
    return labelFields.some((field) => normalizeDuplicateValue(record?.[field]) === normalizedLookup);
  });
  if (matches.length === 1) {
    return matches[0].id;
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${entityLabel} records match "${normalizedValue}". Use the ${preferredIdentifierLabel} or numeric ID.`);
  }
  throw new Error(`Please select a valid ${entityLabel}.`);
};
var normalizeHierarchyReferencePayload = async (tableName, payload) => {
  const nextPayload = { ...payload || {} };
  let resolvedCampusId = nextPayload.campus_id;
  let resolvedBuildingId = nextPayload.building_id;
  let resolvedBlockId = nextPayload.block_id;
  if (["buildings", "blocks"].includes(tableName) && nextPayload.campus_id !== void 0 && nextPayload.campus_id !== null && nextPayload.campus_id !== "") {
    resolvedCampusId = await resolveReferenceRecordId({
      targetTable: "campuses",
      rawValue: nextPayload.campus_id,
      codeField: "campus_id",
      labelFields: ["name"],
      entityLabel: "campus",
      preferredIdentifierLabel: "Campus ID"
    });
    if (tableName === "buildings") {
      nextPayload.campus_id = resolvedCampusId;
    }
  }
  if (["blocks", "floors", "rooms"].includes(tableName) && nextPayload.building_id !== void 0 && nextPayload.building_id !== null && nextPayload.building_id !== "") {
    resolvedBuildingId = await resolveReferenceRecordId({
      targetTable: "buildings",
      rawValue: nextPayload.building_id,
      codeField: "building_id",
      labelFields: ["name"],
      scope: [{ field: "campus_id", value: resolvedCampusId }],
      entityLabel: "building",
      preferredIdentifierLabel: "Building ID"
    });
    if (tableName === "blocks") {
      nextPayload.building_id = resolvedBuildingId;
    }
  }
  if (["floors", "rooms"].includes(tableName) && nextPayload.block_id !== void 0 && nextPayload.block_id !== null && nextPayload.block_id !== "") {
    resolvedBlockId = await resolveReferenceRecordId({
      targetTable: "blocks",
      rawValue: nextPayload.block_id,
      codeField: "block_id",
      labelFields: ["name"],
      scope: [{ field: "building_id", value: resolvedBuildingId }],
      entityLabel: "block",
      preferredIdentifierLabel: "Block ID"
    });
    if (tableName === "floors") {
      nextPayload.block_id = resolvedBlockId;
    }
  }
  if (tableName === "rooms" && nextPayload.floor_id !== void 0 && nextPayload.floor_id !== null && nextPayload.floor_id !== "") {
    nextPayload.floor_id = await resolveReferenceRecordId({
      targetTable: "floors",
      rawValue: nextPayload.floor_id,
      codeField: "floor_id",
      scope: [{ field: "block_id", value: resolvedBlockId }],
      entityLabel: "floor",
      preferredIdentifierLabel: "Floor ID"
    });
  }
  if (tableName === "blocks") {
    delete nextPayload.campus_id;
  }
  if (tableName === "floors") {
    delete nextPayload.building_id;
    delete nextPayload.campus_id;
  }
  if (tableName === "rooms") {
    delete nextPayload.building_id;
    delete nextPayload.block_id;
    delete nextPayload.campus_id;
  }
  return nextPayload;
};
var NUMERIC_DUPLICATE_COMPARE_FIELDS = /* @__PURE__ */ new Set([
  "buildings.campus_id",
  "blocks.building_id",
  "floors.block_id",
  "departments.school_id",
  "department_allocations.school_id",
  "department_allocations.department_id",
  "department_allocations.room_id",
  "department_allocations.hod_user_id",
  "hod_room_allocations.school_id",
  "hod_room_allocations.hod_user_id",
  "hod_room_allocations.room_id",
  "timing_profiles.school_id",
  "timing_profiles.department_id",
  "academic_calendars.school_id",
  "academic_calendars.department_id",
  "academic_calendars.timing_profile_id",
  "batch_room_allocations.academic_calendar_id",
  "batch_room_allocations.school_id",
  "batch_room_allocations.department_id",
  "batch_room_allocations.room_id",
  "equipment.room_id",
  "schedules.department_id",
  "schedules.room_id",
  "bookings.department_id",
  "bookings.room_id",
  "maintenance.room_id"
]);
var shouldUseCaseInsensitiveTextComparison = (tableName, fieldName, value) => {
  if (NUMERIC_DUPLICATE_COMPARE_FIELDS.has(`${tableName}.${fieldName}`)) return false;
  if (typeof value !== "string") return false;
  const normalizedField = fieldName.toLowerCase();
  if (normalizedField === "date" || normalizedField.endsWith("_date")) return false;
  return true;
};
var getScheduleIdentityVariants = (schedule) => {
  const day = normalizeDuplicateValue(schedule?.day_of_week)?.toString() || "";
  const start = normalizeDuplicateValue(schedule?.start_time)?.toString() || "";
  const end = normalizeDuplicateValue(schedule?.end_time)?.toString() || "";
  const program = normalizeDuplicateValue(normalizeScheduleProgramValue(schedule?.program))?.toString() || "";
  const specialization = normalizeDuplicateValue(normalizeScheduleSpecializationValue(schedule?.specialization))?.toString() || "";
  const section = normalizeDuplicateValue(schedule?.section)?.toString() || "";
  const variants = [];
  if (schedule?.room_id !== void 0 && schedule?.room_id !== null && schedule.room_id !== "") {
    variants.push(`room|${schedule.room_id.toString()}|${program}|${specialization}|${section}|${day}|${start}|${end}`);
  }
  const normalizedRoomLabel = normalizeDuplicateValue(schedule?.room_label)?.toString() || "";
  if (normalizedRoomLabel) {
    variants.push(`label|${normalizedRoomLabel}|${program}|${specialization}|${section}|${day}|${start}|${end}`);
  }
  if (variants.length === 0) {
    const scheduleId = normalizeDuplicateValue(schedule?.schedule_id)?.toString() || "";
    if (scheduleId) variants.push(`schedule|${scheduleId}`);
  }
  return variants;
};
var schedulesConflict = (left, right) => {
  const leftVariants = getScheduleIdentityVariants(left);
  const rightVariants = new Set(getScheduleIdentityVariants(right));
  return leftVariants.some((variant) => rightVariants.has(variant));
};
var deduplicateSchedules = (rows) => {
  const seen = /* @__PURE__ */ new Set();
  const kept = [];
  const duplicates = [];
  const prioritizedRows = [...rows].sort((a, b) => {
    const score = (row) => (row?.room_id ? 4 : 0) + (row?.room_label ? 2 : 0) + (row?.course_name ? 1 : 0) + (row?.faculty ? 1 : 0);
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
  for (const row of prioritizedRows) {
    const variants = getScheduleIdentityVariants(row);
    const hasConflict = variants.some((variant) => seen.has(variant));
    if (hasConflict) {
      duplicates.push(row);
      continue;
    }
    variants.forEach((variant) => seen.add(variant));
    kept.push(row);
  }
  kept.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  duplicates.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  return { kept, duplicates };
};
var cleanupDuplicateSchedules = async () => {
  const scheduleRows = await db.prepare("SELECT * FROM schedules").all();
  const { duplicates } = deduplicateSchedules(scheduleRows);
  for (const duplicate of duplicates) {
    await db.prepare("DELETE FROM schedules WHERE id = ?").run(duplicate.id);
  }
  if (duplicates.length > 0) {
    console.log(`Removed ${duplicates.length} duplicate schedule record(s).`);
  }
};
var checkDuplicateRecord = async (tableName, data, excludeId) => {
  const rules = duplicateRules[tableName] || [];
  for (const rule of rules) {
    if (rule.fields.some((field) => data[field] == null || data[field] === "")) continue;
    const whereClause = rule.fields.map((field) => shouldUseCaseInsensitiveTextComparison(tableName, field, data[field]) ? `LOWER(TRIM(${field})) = ?` : `${field} = ?`).join(" AND ");
    const values = rule.fields.map(
      (field) => shouldUseCaseInsensitiveTextComparison(tableName, field, data[field]) ? normalizeDuplicateValue(data[field]) : data[field]
    );
    const query = `SELECT id FROM ${tableName} WHERE ${whereClause}${excludeId ? " AND id != ?" : ""}`;
    const existing = await db.prepare(query).get(...values, ...excludeId ? [excludeId] : []);
    if (existing) {
      return `${rule.label} already exists. Duplicate records are not allowed.`;
    }
  }
  if (tableName === "schedules" && data?.day_of_week && data?.start_time && data?.end_time) {
    const candidates = await db.prepare(`
      SELECT id, schedule_id, program, room_id, room_label, specialization, section, day_of_week, start_time, end_time
      FROM schedules
      WHERE LOWER(TRIM(day_of_week)) = ?
      AND LOWER(TRIM(start_time)) = ?
      AND LOWER(TRIM(end_time)) = ?
      ${excludeId ? "AND id != ?" : ""}
    `).all(
      normalizeDuplicateValue(data.day_of_week),
      normalizeDuplicateValue(data.start_time),
      normalizeDuplicateValue(data.end_time),
      ...excludeId ? [excludeId] : []
    );
    const conflictingSchedule = candidates.find((candidate) => schedulesConflict(candidate, data));
    if (conflictingSchedule) {
      return "Schedule slot for this room, program, branch, and section already exists. Duplicate records are not allowed.";
    }
  }
  if (tableName === "rooms") {
    const candidateTokens = Array.from(new Set([
      normalizeDuplicateValue(data.room_number),
      ...getRoomAliasTokens(data.room_aliases)
    ].filter(Boolean)));
    if (candidateTokens.length > 0) {
      const roomCandidates = await db.prepare(`SELECT id, room_number, room_aliases FROM rooms ${excludeId ? "WHERE id != ?" : ""}`).all(
        ...excludeId ? [excludeId] : []
      );
      const conflictingRoom = roomCandidates.find((room) => {
        const existingTokens = new Set([
          normalizeDuplicateValue(room.room_number),
          ...getRoomAliasTokens(room.room_aliases)
        ].filter(Boolean));
        return candidateTokens.some((token) => existingTokens.has(token));
      });
      if (conflictingRoom) {
        return "Room number or alias already exists. Shared venue labels must be unique across Room Management.";
      }
    }
  }
  return null;
};
var BULK_IMPORT_SUPPORTED_TABLES = /* @__PURE__ */ new Set([
  "users",
  "campuses",
  "buildings",
  "blocks",
  "floors",
  "rooms",
  "schools",
  "departments",
  "department_allocations",
  "hod_room_allocations",
  "timing_profiles",
  "academic_calendars",
  "batch_room_allocations",
  "equipment",
  "schedules",
  "maintenance"
]);
var hasImportMatchValue = (value) => value !== void 0 && value !== null && value !== "";
var normalizeImportMatchValue = (value) => value?.toString().trim().toLowerCase().replace(/\s+/g, " ") || "";
var SERVER_PAGINATION_TABLES = /* @__PURE__ */ new Set([
  "rooms",
  "academic_calendars",
  "batch_room_allocations",
  "hod_room_allocations",
  "department_allocations",
  "schedules"
]);
var compareServerSortValues = (left, right) => {
  const leftValue = left == null ? "" : left.toString();
  const rightValue = right == null ? "" : right.toString();
  return leftValue.localeCompare(rightValue, void 0, { numeric: true, sensitivity: "base" });
};
var scheduleDayOrder = /* @__PURE__ */ new Map([
  ["monday", 0],
  ["tuesday", 1],
  ["wednesday", 2],
  ["thursday", 3],
  ["friday", 4],
  ["saturday", 5],
  ["sunday", 6]
]);
var parseScheduleTimeToMinutes = (value) => {
  const raw = value?.toString().trim() || "";
  if (!raw.includes(":")) return Number.MAX_SAFE_INTEGER;
  const [hour, minute] = raw.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.MAX_SAFE_INTEGER;
  return hour * 60 + minute;
};
var toRomanNumeral = (value) => {
  const numerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return numerals[value] || value.toString();
};
var getYearNumberFromAcademicContext = (yearOfStudy, semester) => {
  const yearKey = normalizeYearOfStudyKey(yearOfStudy);
  if (yearKey) {
    const parsedYear = parseInt(yearKey, 10);
    if (Number.isFinite(parsedYear)) return parsedYear;
  }
  const semesterNumber = parseSemesterNumber(semester);
  return semesterNumber ? Math.ceil(semesterNumber / 2) : null;
};
var getYearDisplayLabel = (yearOfStudy, semester) => {
  const yearNumber = getYearNumberFromAcademicContext(yearOfStudy, semester);
  return yearNumber ? `${toRomanNumeral(yearNumber)} Year` : "-";
};
var findMatchingImportRecord = (records, payload, uniqueFieldGroups) => {
  for (const fields of Array.isArray(uniqueFieldGroups) ? uniqueFieldGroups : []) {
    if (!Array.isArray(fields) || fields.some((field) => !hasImportMatchValue(payload?.[field]))) continue;
    const existing = records.find(
      (record) => fields.every(
        (field) => hasImportMatchValue(record?.[field]) && normalizeImportMatchValue(record[field]) === normalizeImportMatchValue(payload[field])
      )
    );
    if (existing) return existing;
  }
  return null;
};
var findDuplicateRecordInCollection = (tableName, records, data, excludeId) => {
  const rules = duplicateRules[tableName] || [];
  for (const rule of rules) {
    if (rule.fields.some((field) => data[field] == null || data[field] === "")) continue;
    const existing = (Array.isArray(records) ? records : []).find((record) => {
      if (excludeId && idsEqual(record?.id, excludeId)) return false;
      return rule.fields.every((field) => {
        if (record?.[field] == null || record[field] === "") return false;
        return shouldUseCaseInsensitiveTextComparison(tableName, field, data[field]) ? normalizeDuplicateValue(record[field]) === normalizeDuplicateValue(data[field]) : record[field] === data[field];
      });
    });
    if (existing) {
      return `${rule.label} already exists. Duplicate records are not allowed.`;
    }
  }
  if (tableName === "schedules" && data?.day_of_week && data?.start_time && data?.end_time) {
    const candidates = (Array.isArray(records) ? records : []).filter((candidate) => {
      if (excludeId && idsEqual(candidate?.id, excludeId)) return false;
      return normalizeDuplicateValue(candidate?.day_of_week) === normalizeDuplicateValue(data.day_of_week) && normalizeDuplicateValue(candidate?.start_time) === normalizeDuplicateValue(data.start_time) && normalizeDuplicateValue(candidate?.end_time) === normalizeDuplicateValue(data.end_time);
    });
    const conflictingSchedule = candidates.find((candidate) => schedulesConflict(candidate, data));
    if (conflictingSchedule) {
      return "Schedule slot for this room, program, branch, and section already exists. Duplicate records are not allowed.";
    }
  }
  if (tableName === "rooms") {
    const candidateTokens = Array.from(new Set([
      normalizeDuplicateValue(data.room_number),
      ...getRoomAliasTokens(data.room_aliases)
    ].filter(Boolean)));
    if (candidateTokens.length > 0) {
      const conflictingRoom = (Array.isArray(records) ? records : []).find((room) => {
        if (excludeId && idsEqual(room?.id, excludeId)) return false;
        const existingTokens = new Set([
          normalizeDuplicateValue(room.room_number),
          ...getRoomAliasTokens(room.room_aliases)
        ].filter(Boolean));
        return candidateTokens.some((token) => existingTokens.has(token));
      });
      if (conflictingRoom) {
        return "Room number or alias already exists. Shared venue labels must be unique across Room Management.";
      }
    }
  }
  return null;
};
var normalizeBulkImportPayload = async (tableName, payload, existingItem) => {
  let nextPayload = { ...payload || {} };
  if (tableName === "users") {
    if (existingItem && !nextPayload.password) delete nextPayload.password;
    if (!existingItem && !nextPayload.password) nextPayload.password = "Welcome123";
    if (nextPayload.password) nextPayload.force_password_change = 1;
    nextPayload = await normalizeUserPayload(nextPayload, existingItem);
  }
  if (tableName === "rooms") {
    nextPayload = normalizeRoomPayload(nextPayload);
  }
  if (tableName === "academic_calendars") {
    nextPayload = await normalizeAcademicCalendarPayload(existingItem ? { ...existingItem, ...nextPayload } : nextPayload);
  }
  if (tableName === "timing_profiles") {
    nextPayload = await normalizeTimingProfilePayload(existingItem ? { ...existingItem, ...nextPayload } : nextPayload);
  }
  if (tableName === "batch_room_allocations") {
    nextPayload = await normalizeBatchRoomAllocationPayload(existingItem ? { ...existingItem, ...nextPayload } : nextPayload);
  }
  if (tableName === "schedules") {
    nextPayload = normalizeSchedulePayload(existingItem ? { ...existingItem, ...nextPayload } : nextPayload);
  }
  nextPayload = await normalizeHierarchyReferencePayload(tableName, nextPayload);
  return nextPayload;
};
var validateBulkImportPayload = async (tableName, payload, existingItem, context) => {
  const nextRecord = existingItem ? { ...existingItem, ...payload } : payload;
  const duplicateError = context?.records ? findDuplicateRecordInCollection(tableName, context.records, nextRecord, existingItem?.id) : await checkDuplicateRecord(tableName, nextRecord, existingItem?.id);
  if (duplicateError) throw new Error(duplicateError);
  if (tableName === "rooms") {
    const parentRoom = context?.records ? findRecordById(context.records, nextRecord.parent_room_id) : null;
    const hierarchyError = context?.records && nextRecord?.parent_room_id ? existingItem && nextRecord.parent_room_id?.toString() === existingItem.id?.toString() ? "A room cannot be inside itself." : !parentRoom ? "Please select a valid parent room." : parentRoom.floor_id?.toString() !== nextRecord.floor_id?.toString() ? "The parent room must be on the same floor." : null : await validateRoomHierarchy(nextRecord, existingItem?.id);
    if (hierarchyError) throw new Error(hierarchyError);
    const restroomValidationError = await getRestroomValidationError(nextRecord);
    if (restroomValidationError) throw new Error(restroomValidationError);
  }
  if (tableName === "department_allocations") {
    const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextRecord.room_id);
    if (!room) throw new Error("Please select a valid room.");
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    if ((parseInt(nextRecord.capacity, 10) || 0) > room.capacity) {
      throw new Error(`Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${nextRecord.capacity}.`);
    }
    payload.room_type = room.room_type;
  }
  if (tableName === "hod_room_allocations") {
    const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextRecord.room_id);
    if (!room) throw new Error("Please select a valid room.");
    const hodUser = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(nextRecord.hod_user_id);
    if (!hodUser || normalizeRoleLabel(hodUser.role) !== "hod") {
      throw new Error("Please select a valid HOD user.");
    }
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    payload.room_type = room.room_type;
    payload.capacity = room.capacity;
  }
  if (tableName === "batch_room_allocations") {
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    const departmentAllocationError = await getDepartmentAllocationLinkError(nextRecord.room_id, nextRecord.department_id, nextRecord.semester, context);
    if (departmentAllocationError) throw new Error(departmentAllocationError);
    const overlapError = await getBatchAllocationOverlapError(
      nextRecord,
      existingItem?.id,
      context?.tableName === "batch_room_allocations" ? context.records : void 0
    );
    if (overlapError) throw new Error(overlapError);
  }
  if (tableName === "schedules") {
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    const temporaryAllocationConflict = await getTemporaryAllocationScheduleConflict(
      nextRecord.room_id,
      nextRecord.day_of_week,
      nextRecord.start_time,
      nextRecord.end_time
    );
    if (temporaryAllocationConflict) throw new Error("This room has an overlapping temporary allocation for one or more matching schedule slots.");
    payload.schedule_code = await assignScheduleCode(payload, existingItem?.id, existingItem, context);
  }
};
await cleanupDuplicateSchedules();
await syncBatchAllocationStatuses();
lastBatchSyncAt = Date.now();
var isPastDateTime = (date, time) => {
  const normalizedDate = date instanceof Date ? date.toISOString().slice(0, 10) : date?.toString().trim().includes("T") ? date.toString().trim().slice(0, 10) : date?.toString().trim();
  const value = /* @__PURE__ */ new Date(`${normalizedDate}T${time}`);
  return Number.isNaN(value.getTime()) || value.getTime() < Date.now();
};
var timesOverlap = (existingStart, existingEnd, selectedStart, selectedEnd) => {
  if (!existingStart || !existingEnd || !selectedStart || !selectedEnd) return false;
  return existingStart < selectedEnd && existingEnd > selectedStart;
};
var isBookableAvailabilityRoom = (room) => {
  if (!room) return false;
  if (room.is_bookable === 0) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) return false;
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  return BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) || BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "");
};
var LIVE_AVAILABILITY_EXCLUDED_ROOM_TYPES = /* @__PURE__ */ new Set([
  "Restroom",
  "Store",
  "Records Room",
  "Utility",
  "Server Room",
  "Electrical Room",
  "Maintenance Room"
]);
var LIVE_AVAILABILITY_EXCLUDED_USAGE_CATEGORIES = /* @__PURE__ */ new Set([
  "Restroom",
  "Storage",
  "Utility"
]);
var isLiveAvailabilityVisibleRoom = (room) => {
  if (!room) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  if (LIVE_AVAILABILITY_EXCLUDED_ROOM_TYPES.has(roomType)) return false;
  if (LIVE_AVAILABILITY_EXCLUDED_USAGE_CATEGORIES.has(usageCategory || "")) return false;
  return true;
};
var LIVE_AVAILABILITY_ROOM_TYPE_GROUPS = {
  Classroom: [
    "Classroom",
    "Smart Classroom",
    "Lecture Hall",
    "Tutorial Room",
    "Multipurpose Classroom",
    "Multipurpose Lecture Hall"
  ],
  Lab: [
    "Lab",
    "Computer Lab",
    "Research Lab",
    "Language Lab",
    "Workshop",
    "Studio",
    "Classroom Lab",
    "Multipurpose Lab"
  ],
  "Seminar Hall": ["Seminar Hall"],
  Auditorium: ["Auditorium"],
  "Meeting Room": ["Meeting Room", "Conference Room", "Board Room"]
};
var matchesLiveAvailabilityRoomTypeFilter = (room, filterValue) => {
  const normalizedFilter = normalizeRoomTypeValue(filterValue);
  if (!normalizedFilter) return true;
  const normalizedRoomType = normalizeRoomTypeValue(room?.room_type);
  if (!normalizedRoomType) return false;
  if (normalizedFilter === "Other") {
    const groupedRoomTypes = new Set(Object.values(LIVE_AVAILABILITY_ROOM_TYPE_GROUPS).flat());
    return !groupedRoomTypes.has(normalizedRoomType);
  }
  const allowedRoomTypes = LIVE_AVAILABILITY_ROOM_TYPE_GROUPS[normalizedFilter];
  if (allowedRoomTypes) return allowedRoomTypes.includes(normalizedRoomType);
  return normalizedRoomType === normalizedFilter;
};
var getSharedAvailabilitySnapshot = async ({
  date,
  startTime,
  endTime,
  campusId = "",
  buildingId = "",
  blockId = "",
  floorId = "",
  departmentId = "",
  roomType = "",
  minCapacity = 0,
  equipmentFilter = "",
  includeMaintenanceRooms = true,
  markRecommendedStatus = false,
  visibilityScope = "bookable",
  allowedRoomIds = null
}) => {
  await ensureBookingColumnsReady();
  const [
    roomsRaw,
    departments,
    departmentAllocations,
    batchAllocations,
    equipment,
    maintenance,
    approvedBookings
  ] = await Promise.all([
    db.prepare(`
      SELECT
        r.*,
        f.floor_number,
        b.id as block_id,
        b.name as block_name,
        bld.id as building_id,
        bld.name as building_name,
        c.id as campus_id,
        c.name as campus_name
      FROM rooms r
      JOIN floors f ON r.floor_id = f.id
      JOIN blocks b ON f.block_id = b.id
      JOIN buildings bld ON b.building_id = bld.id
      JOIN campuses c ON bld.campus_id = c.id
    `).all(),
    db.prepare("SELECT id, name FROM departments").all(),
    db.prepare(`
      SELECT da.id, da.room_id, da.department_id, da.semester, d.name as department_name
      FROM department_allocations da
      JOIN departments d ON da.department_id = d.id
      ORDER BY da.id DESC
    `).all(),
    db.prepare(`
      SELECT bra.id, bra.room_id, bra.department_id, bra.program, bra.batch, bra.specialization, bra.academic_year, bra.year_of_study, bra.semester, d.name as department_name
      FROM batch_room_allocations bra
      JOIN departments d ON bra.department_id = d.id
      WHERE bra.start_date <= ? AND bra.end_date >= ? AND bra.status != ?
      ORDER BY bra.id DESC
    `).all(date, date, "Released"),
    db.prepare("SELECT room_id, name, type, condition FROM equipment").all(),
    db.prepare(`
      SELECT
        room_id,
        equipment_name,
        issue_description,
        reported_date,
        assigned_staff,
        status
      FROM maintenance
    `).all(),
    db.prepare("SELECT room_id, faculty_name, event_name, purpose, purpose_type, timing_override, date, start_time, end_time, status FROM bookings WHERE date = ? AND status = 'Approved'").all(date)
  ]);
  const normalizedRoomType = normalizeRoomTypeValue(roomType);
  const normalizedEquipmentFilter = normalizeDuplicateValue(equipmentFilter || "");
  const departmentNameById = new Map(departments.map((department) => [department.id?.toString(), department.name]));
  const equipmentByRoomId = /* @__PURE__ */ new Map();
  equipment.forEach((item) => {
    const key = item.room_id?.toString();
    if (!key) return;
    if (!equipmentByRoomId.has(key)) equipmentByRoomId.set(key, []);
    equipmentByRoomId.get(key)?.push(item);
  });
  const activeMaintenanceByRoomId = /* @__PURE__ */ new Map();
  maintenance.forEach((item) => {
    if (item.status === "Completed") return;
    const key = item.room_id?.toString();
    if (!key) return;
    if (!activeMaintenanceByRoomId.has(key)) activeMaintenanceByRoomId.set(key, []);
    activeMaintenanceByRoomId.get(key)?.push(item);
  });
  const allocationNamesByRoomId = /* @__PURE__ */ new Map();
  const allocationIdsByRoomId = /* @__PURE__ */ new Map();
  const applyDepartmentContext = (roomId, nextDepartmentId, nextDepartmentName) => {
    const key = roomId?.toString();
    if (!key) return;
    if (!allocationNamesByRoomId.has(key)) allocationNamesByRoomId.set(key, []);
    if (!allocationIdsByRoomId.has(key)) allocationIdsByRoomId.set(key, /* @__PURE__ */ new Set());
    if (nextDepartmentName && !allocationNamesByRoomId.get(key)?.includes(nextDepartmentName)) {
      allocationNamesByRoomId.get(key)?.push(nextDepartmentName);
    }
    if (nextDepartmentId) allocationIdsByRoomId.get(key)?.add(nextDepartmentId.toString());
  };
  departmentAllocations.forEach(
    (allocation) => applyDepartmentContext(allocation.room_id, allocation.department_id, allocation.department_name || departmentNameById.get(allocation.department_id?.toString()))
  );
  batchAllocations.forEach(
    (allocation) => applyDepartmentContext(allocation.room_id, allocation.department_id, allocation.department_name || departmentNameById.get(allocation.department_id?.toString()))
  );
  const roomCandidates = roomsRaw.filter((room) => {
    const roomKey = room.id?.toString() || "";
    if (allowedRoomIds && !allowedRoomIds.has(roomKey)) return false;
    const bookable = isBookableAvailabilityRoom(room);
    const visible = visibilityScope === "live" ? isLiveAvailabilityVisibleRoom(room) : bookable;
    if (!visible && !(includeMaintenanceRooms && room.status === "Maintenance" && visibilityScope === "live" && isLiveAvailabilityVisibleRoom(room))) return false;
    if (campusId && !idsEqual(room.campus_id, campusId)) return false;
    if (buildingId && !idsEqual(room.building_id, buildingId)) return false;
    if (blockId && !idsEqual(room.block_id, blockId)) return false;
    if (floorId && !idsEqual(room.floor_id, floorId)) return false;
    if (normalizedRoomType && !matchesLiveAvailabilityRoomTypeFilter(room, normalizedRoomType)) return false;
    if (departmentId) {
      const roomDepartmentIds = allocationIdsByRoomId.get(room.id?.toString() || "");
      if (!roomDepartmentIds?.has(departmentId)) return false;
    }
    if (normalizedEquipmentFilter) {
      const labels = (equipmentByRoomId.get(room.id?.toString() || "") || []).map((item) => normalizeDuplicateValue(item.name));
      if (!labels.some((label) => label.includes(normalizedEquipmentFilter))) return false;
    }
    return true;
  });
  const roomLookupVariantsById = /* @__PURE__ */ new Map();
  roomCandidates.forEach((room) => {
    const roomKey = room.id?.toString();
    if (!roomKey) return;
    roomLookupVariantsById.set(roomKey, getAvailabilityRoomLookupVariants(room));
  });
  const assignScheduleToRoom = (map, roomKey, schedule) => {
    if (!roomKey) return;
    if (!map.has(roomKey)) map.set(roomKey, []);
    map.get(roomKey)?.push(schedule);
  };
  const busySchedules = await getEffectiveSchedulesForDate(
    date,
    (schedule) => timesOverlap(schedule.start_time, schedule.end_time, startTime, endTime)
  );
  const scheduleByRoomId = /* @__PURE__ */ new Map();
  busySchedules.forEach((schedule) => {
    const matchedRoomKeys = /* @__PURE__ */ new Set();
    const directKey = schedule.room_id?.toString();
    if (directKey && roomLookupVariantsById.has(directKey)) {
      matchedRoomKeys.add(directKey);
    }
    getRoomLookupVariants(schedule?.room_label).forEach((labelVariant) => {
      roomLookupVariantsById.forEach((roomVariants, roomKey) => {
        if (roomVariants.has(labelVariant)) {
          matchedRoomKeys.add(roomKey);
        }
      });
    });
    matchedRoomKeys.forEach((roomKey) => assignScheduleToRoom(scheduleByRoomId, roomKey, schedule));
  });
  const approvedBookingsByRoomId = /* @__PURE__ */ new Map();
  approvedBookings.filter((booking) => timesOverlap(booking.start_time, booking.end_time, startTime, endTime)).forEach((booking) => {
    const key = booking.room_id?.toString();
    if (!key) return;
    if (!approvedBookingsByRoomId.has(key)) approvedBookingsByRoomId.set(key, []);
    approvedBookingsByRoomId.get(key)?.push(booking);
  });
  const getAudienceLabel = (schedule) => {
    const parts = [
      schedule.program,
      schedule.specialization,
      schedule.section ? `Section ${schedule.section}` : "",
      schedule.year_of_study,
      schedule.semester
    ].filter(Boolean);
    return parts.join(" \u2022 ");
  };
  const roomRows = roomCandidates.map((room) => {
    const roomKey = room.id?.toString() || "";
    const roomBookable = isBookableAvailabilityRoom(room);
    const roomTypeLabel = normalizeRoomTypeValue(room.room_type) || room.room_type || "Room";
    const roomCapacity = parseInt(room.capacity, 10) || 0;
    const roomEquipment = (equipmentByRoomId.get(roomKey) || []).map((item) => item.name).filter(Boolean);
    const roomMaintenance = activeMaintenanceByRoomId.get(roomKey) || [];
    const roomSchedules = scheduleByRoomId.get(roomKey) || [];
    const roomBookings = approvedBookingsByRoomId.get(roomKey) || [];
    const roomDepartments = allocationNamesByRoomId.get(roomKey) || [];
    const currentDepartmentMatch = departmentId && allocationIdsByRoomId.get(roomKey)?.has(departmentId);
    const usageCount = roomSchedules.length + roomBookings.length;
    const capacityGap = Math.max(0, roomCapacity - (minCapacity || 0));
    const hasCapacityMismatch = (minCapacity || 0) > 0 && roomCapacity < (minCapacity || 0);
    let status = roomBookable ? "Available" : "Not Bookable";
    let statusReason = roomBookable ? "Physically vacant for the selected date and time. Academic timing-profile rules are checked only when an Academic Regular booking is confirmed." : "Physically vacant for the selected date and time, but this room is not configured as directly bookable.";
    let currentUsage = "";
    if (roomMaintenance.length > 0 || room.status === "Maintenance") {
      status = "Maintenance";
      statusReason = roomMaintenance.map((item) => `${item.equipment_name || "Maintenance issue"}${item.issue_description ? ` - ${item.issue_description}` : ""}${item.status ? ` (${item.status})` : ""}${item.reported_date ? ` [Reported ${item.reported_date}]` : ""}`).join("; ") || "Room is marked under maintenance.";
    } else if (hasCapacityMismatch) {
      status = "Capacity Mismatch";
      statusReason = `Room capacity is ${roomCapacity}, below the required ${minCapacity}.`;
    } else if (roomSchedules.length > 0) {
      const sameSession = roomSchedules.length > 1 && roomSchedules.every(
        (schedule) => normalizeDuplicateValue(schedule.course_name) === normalizeDuplicateValue(roomSchedules[0]?.course_name) && normalizeDuplicateValue(schedule.faculty) === normalizeDuplicateValue(roomSchedules[0]?.faculty)
      );
      status = "Occupied";
      currentUsage = `${sameSession ? "Combined Class" : "Scheduled"}: ${roomSchedules[0]?.course_name || "Class"}`;
      statusReason = roomSchedules.map((schedule) => {
        const contextLabel = getAudienceLabel(schedule);
        const departmentName = departmentNameById.get(schedule.department_id?.toString()) || "";
        return [
          schedule.course_name || "Scheduled class",
          schedule.faculty ? `Faculty: ${schedule.faculty}` : "",
          departmentName,
          contextLabel
        ].filter(Boolean).join(" \u2022 ");
      }).join("; ");
    } else if (roomBookings.length > 0) {
      status = "Event Booked";
      currentUsage = roomBookings[0]?.event_name || "Approved booking";
      statusReason = roomBookings.map(
        (booking) => [
          booking.event_name || "Approved booking",
          booking.faculty_name ? `Booked by ${booking.faculty_name}` : "",
          booking.purpose ? `Purpose: ${booking.purpose}` : "",
          booking.purpose_type ? `Type: ${booking.purpose_type}` : "",
          Number(booking.timing_override || 0) === 1 ? "Temporary timing override for this booked period only" : ""
        ].filter(Boolean).join(" \u2022 ")
      ).join("; ");
    }
    let recommendationScore = 0;
    if (status === "Available") {
      recommendationScore += roomBookable ? 1e3 : 0;
      recommendationScore += currentDepartmentMatch ? 150 : 0;
      recommendationScore += normalizedEquipmentFilter && roomEquipment.some((label) => normalizeDuplicateValue(label).includes(normalizedEquipmentFilter)) ? 80 : 0;
      recommendationScore += roomCapacity >= (minCapacity || 0) ? Math.max(0, 120 - capacityGap) : 0;
      recommendationScore += Math.max(0, 40 - usageCount * 10);
    }
    let nextAvailableSlot = "Available for selected time";
    if (status !== "Available" && status !== "Best Suitable") {
      const blockingEndTimes = [
        ...roomSchedules.map((schedule) => schedule.end_time).filter(Boolean),
        ...roomBookings.map((booking) => booking.end_time).filter(Boolean)
      ].sort();
      if (status === "Maintenance") {
        nextAvailableSlot = "Available after maintenance clearance";
      } else if (blockingEndTimes.length > 0) {
        nextAvailableSlot = `${blockingEndTimes[blockingEndTimes.length - 1]} onwards`;
      }
    }
    return {
      id: room.id,
      roomId: room.room_id,
      roomNumber: room.room_number,
      roomName: room.room_name || "",
      roomType: roomTypeLabel,
      capacity: roomCapacity,
      campusId: room.campus_id,
      campusName: room.campus_name,
      buildingId: room.building_id,
      buildingName: room.building_name,
      blockId: room.block_id,
      blockName: room.block_name,
      floorId: room.floor_id,
      floorName: room.floor_number,
      departmentName: roomDepartments.join(", "),
      status,
      statusReason,
      currentUsage,
      nextAvailableSlot,
      equipment: roomEquipment,
      recommendationScore,
      availableForBooking: status === "Available" && roomBookable,
      mappedToSelectedDepartment: Boolean(currentDepartmentMatch),
      aliases: getRoomAliasTokens(room.room_aliases),
      _sourceRoom: room
    };
  });
  const recommendedRooms = roomRows.filter((room) => room.availableForBooking).sort((left, right) => right.recommendationScore - left.recommendationScore).slice(0, 3).map((room, index) => ({
    ...room,
    status: "Best Suitable",
    availableForBooking: true,
    statusReason: [
      `Recommended because capacity is ${room.capacity}.`,
      room.mappedToSelectedDepartment ? "Mapped to the selected department." : "",
      normalizedEquipmentFilter && room.equipment.some((label) => normalizeDuplicateValue(label).includes(normalizedEquipmentFilter)) ? `${equipmentFilter} is available.` : "",
      "Physically vacant for the selected real-time window with no timetable clash, no approved booking, and not under maintenance."
    ].filter(Boolean).join(" "),
    currentUsage: `Recommendation rank #${index + 1}`
  }));
  const recommendedRoomIds = new Set(recommendedRooms.map((room) => room.id?.toString()));
  const statusAdjustedRooms = roomRows.map((room) => {
    if (!markRecommendedStatus || !recommendedRoomIds.has(room.id?.toString())) return room;
    const recommendedRoom = recommendedRooms.find((item) => idsEqual(item.id, room.id));
    return recommendedRoom ? { ...room, ...recommendedRoom } : room;
  });
  const sortedRooms = [...statusAdjustedRooms].sort((left, right) => {
    if (left.buildingName !== right.buildingName) {
      return left.buildingName.localeCompare(right.buildingName, void 0, { sensitivity: "base" });
    }
    if (left.blockName !== right.blockName) {
      return left.blockName.localeCompare(right.blockName, void 0, { numeric: true, sensitivity: "base" });
    }
    const leftFloor = Number(left.floorName);
    const rightFloor = Number(right.floorName);
    if (Number.isFinite(leftFloor) && Number.isFinite(rightFloor) && leftFloor !== rightFloor) {
      return leftFloor - rightFloor;
    }
    if ((left.floorName || "") !== (right.floorName || "")) {
      return String(left.floorName || "").localeCompare(String(right.floorName || ""), void 0, { numeric: true, sensitivity: "base" });
    }
    return (left.roomNumber || "").localeCompare(right.roomNumber || "", void 0, { numeric: true, sensitivity: "base" });
  });
  return {
    summary: {
      totalRooms: sortedRooms.length,
      available: sortedRooms.filter((room) => room.status === "Available").length,
      occupied: sortedRooms.filter((room) => room.status === "Occupied").length,
      booked: sortedRooms.filter((room) => room.status === "Event Booked").length,
      maintenance: sortedRooms.filter((room) => room.status === "Maintenance").length,
      notBookable: sortedRooms.filter((room) => room.status === "Not Bookable").length,
      capacityMismatch: sortedRooms.filter((room) => room.status === "Capacity Mismatch").length,
      bestSuitable: recommendedRooms.length
    },
    recommendedRooms,
    rooms: sortedRooms
  };
};
var addMinutesToTimeValue = (time, minutesToAdd) => {
  const [hours, minutes] = (time || "00:00").split(":").map(Number);
  if ([hours, minutes].some((value) => Number.isNaN(value))) return time || "00:00";
  const date = /* @__PURE__ */ new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setMinutes(date.getMinutes() + minutesToAdd);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
};
var getCurrentOperationalRoomSnapshot = async (date, time) => {
  const snapshot = await getSharedAvailabilitySnapshot({
    date,
    startTime: time,
    endTime: addMinutesToTimeValue(time, 1),
    includeMaintenanceRooms: true,
    markRecommendedStatus: false,
    visibilityScope: "live"
  });
  return {
    summary: snapshot.summary,
    rooms: snapshot.rooms.map((room) => {
      const { _sourceRoom, ...payload } = room;
      return payload;
    })
  };
};
var getBookingDepartmentName = async (booking) => {
  if (!booking?.department_id) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(booking.department_id);
  return department?.name || null;
};
var getDigitalTwinCategoryLabel = (room, status) => {
  const normalizedRoomType = normalizeRoomTypeValue(room?.roomType || room?.room_type);
  if (status === "Not Bookable") {
    if (["Server Room", "Electrical Room", "Maintenance Room", "Store Room"].includes(normalizedRoomType)) return "Utility";
    if (normalizedRoomType === "Office") return "Admin Use";
    return "Restricted";
  }
  if ([
    "Classroom",
    "Smart Classroom",
    "Lecture Hall",
    "Tutorial Room",
    "Multipurpose Classroom",
    "Multipurpose Lecture Hall"
  ].includes(normalizedRoomType)) return "Classrooms";
  if ([
    "Lab",
    "Computer Lab",
    "Research Lab",
    "Language Lab",
    "Workshop",
    "Studio",
    "Classroom Lab",
    "Multipurpose Lab"
  ].includes(normalizedRoomType)) return "Labs";
  if (normalizedRoomType === "Seminar Hall") return "Seminar Halls";
  if (normalizedRoomType === "Auditorium") return "Auditoriums";
  if (["Meeting Room", "Conference Room", "Board Room"].includes(normalizedRoomType)) return "Meeting Rooms";
  return "Other";
};
var isDecisionRole = (role) => isAdminRole(role) || ["Dean (P&M)", "Deputy Dean (P&M)"].includes(role);
var openBookingStatuses = [
  "Pending",
  "HOD Recommended",
  "Approved",
  "No Room Available",
  "Awaiting Alternative Response",
  "Waitlisted",
  "Clarification Required"
];
var bookingDeanWorkflowStatuses = ["Approved", "Rejected", "Postponed", "No Room Available", "Waitlisted", "Clarification Required"];
var bookingRequesterRevisionStatuses = ["No Room Available", "Waitlisted", "Clarification Required", "Postponed", "Awaiting Alternative Response"];
var normalizeBookingRequestType = (value) => value?.toString().trim() === "Additional Room" ? "Additional Room" : "Department Room";
var isAdditionalRoomBooking = (booking) => normalizeBookingRequestType(booking?.request_type) === "Additional Room";
var normalizeBookingRequesterValue = (value) => value?.toString().trim().toLowerCase() || "";
var isBookingRequester = (booking, user) => {
  const bookingRequesterUserId = booking?.requester_user_id?.toString().trim();
  const currentUserId = user?.id?.toString().trim();
  if (bookingRequesterUserId && currentUserId && bookingRequesterUserId === currentUserId) return true;
  const bookingRequesterName = normalizeBookingRequesterValue(booking?.faculty_name);
  const currentUserName = normalizeBookingRequesterValue(user?.name);
  return !!bookingRequesterName && bookingRequesterName === currentUserName;
};
var getAccessibleDepartmentIdSet = (user) => new Set(
  (Array.isArray(user?.assigned_department_ids) ? user.assigned_department_ids : []).map((departmentId) => departmentId?.toString()).filter(Boolean)
);
var getAccessibleSchoolIdSet = (user) => new Set(
  (Array.isArray(user?.assigned_school_ids) ? user.assigned_school_ids : []).map((schoolId) => schoolId?.toString()).filter(Boolean)
);
var canManageHodRoomAllocations = (role) => {
  const normalizedRole = normalizeRoleLabel(role);
  return isAdminRole(role) || ["dean (p&m)", "infrastructure manager"].includes(normalizedRole);
};
var getApprovedBookingConflict = async (booking, excludeId) => {
  if (!booking?.room_id || !booking?.date || !booking?.start_time || !booking?.end_time) return null;
  return await db.prepare(`
    SELECT id FROM bookings
    WHERE room_id = ?
    AND date = ?
    AND status = 'Approved'
    ${excludeId ? "AND id != ?" : ""}
    AND NOT (end_time <= ? OR start_time >= ?)
  `).get(
    booking.room_id,
    booking.date,
    ...excludeId ? [excludeId] : [],
    booking.start_time,
    booking.end_time
  );
};
var getDuplicateOpenBookingRequest = async (booking, excludeId) => {
  if (!booking?.requester_user_id && !booking?.faculty_name || !booking?.room_id || !booking?.date || !booking?.start_time || !booking?.end_time) return null;
  const requesterUserId = booking?.requester_user_id?.toString().trim();
  if (requesterUserId) {
    return await db.prepare(`
      SELECT id FROM bookings
      WHERE requester_user_id = ?
      AND room_id = ?
      AND date = ?
      AND start_time = ?
      AND end_time = ?
      AND status IN (${openBookingStatuses.map(() => "?").join(", ")})
      ${excludeId ? "AND id != ?" : ""}
    `).get(
      requesterUserId,
      booking.room_id,
      booking.date,
      booking.start_time,
      booking.end_time,
      ...openBookingStatuses,
      ...excludeId ? [excludeId] : []
    );
  }
  return await db.prepare(`
    SELECT id FROM bookings
    WHERE LOWER(TRIM(faculty_name)) = LOWER(TRIM(?))
    AND room_id = ?
    AND date = ?
    AND start_time = ?
    AND end_time = ?
    AND status IN (${openBookingStatuses.map(() => "?").join(", ")})
    ${excludeId ? "AND id != ?" : ""}
  `).get(
    booking.faculty_name,
    booking.room_id,
    booking.date,
    booking.start_time,
    booking.end_time,
    ...openBookingStatuses,
    ...excludeId ? [excludeId] : []
  );
};
var getCompetingOpenBookingRequests = async (booking, excludeId) => {
  if (!booking?.room_id || !booking?.date || !booking?.start_time || !booking?.end_time) return [];
  return await db.prepare(`
    SELECT id, faculty_name, event_name FROM bookings
    WHERE room_id = ?
    AND date = ?
    AND status IN ('Pending', 'HOD Recommended')
    ${excludeId ? "AND id != ?" : ""}
    AND NOT (end_time <= ? OR start_time >= ?)
  `).all(
    booking.room_id,
    booking.date,
    ...excludeId ? [excludeId] : [],
    booking.start_time,
    booking.end_time
  );
};
var notifyBookingAuthorities = async (booking, title, message) => {
  const departmentName = await getBookingDepartmentName(booking);
  if (departmentName) {
    await createNotification("HOD", null, title, message, departmentName);
  }
  await createNotification("Dean (P&M)", null, title, message);
  await createNotification("Deputy Dean (P&M)", null, title, message);
};
var getBookingWorkflowItems = async (booking) => {
  if (!booking) return [];
  if (booking.request_group_id) {
    return await db.prepare("SELECT * FROM bookings WHERE request_group_id = ? ORDER BY date ASC, start_time ASC, id ASC").all(booking.request_group_id);
  }
  return [booking];
};
var canAccessBookingWorkflow = async (booking, user) => {
  if (!booking || !user) return false;
  if (isDecisionRole(user.role)) return true;
  if (isBookingRequester(booking, user)) return true;
  if (user.role === "HOD" && booking.department_id != null) {
    const departmentIds = getAccessibleDepartmentIdSet(user);
    if (departmentIds.has(booking.department_id.toString())) return true;
  }
  return false;
};
var sanitizeBookingAlternative = (alternative, canViewInternalDetails) => {
  if (canViewInternalDetails) return alternative;
  const { internal_candidate_room_ids, ...safeAlternative } = alternative || {};
  return safeAlternative;
};
var deriveTemporaryAllocationStatus = (date, startTime, endTime) => {
  const now = /* @__PURE__ */ new Date();
  const start = /* @__PURE__ */ new Date(`${date}T${startTime}`);
  const end = /* @__PURE__ */ new Date(`${date}T${endTime}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Upcoming";
  if (now < start) return "Upcoming";
  if (now >= start && now < end) return "Active";
  return "Completed";
};
var getLatestDepartmentAllocationForRoom = async (roomId) => {
  if (!roomId) return null;
  return await db.prepare(`
    SELECT *
    FROM department_allocations
    WHERE room_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(roomId);
};
var refreshTemporaryRoomAllocationStatuses = async () => {
  await ensureTemporaryRoomAllocationsTable();
  const allocations = await db.prepare(`
    SELECT *
    FROM temporary_room_allocations
    WHERE status IN ('Upcoming', 'Active')
  `).all();
  for (const allocation of allocations) {
    const nextStatus = deriveTemporaryAllocationStatus(allocation.approved_date, allocation.start_time, allocation.end_time);
    if (nextStatus !== allocation.status) {
      await db.prepare(`
        UPDATE temporary_room_allocations
        SET status = ?, released_at = CASE WHEN ? = 'Completed' THEN CURRENT_TIMESTAMP ELSE released_at END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, nextStatus, allocation.id);
      const relatedBooking = allocation.booking_id ? await db.prepare("SELECT * FROM bookings WHERE id = ?").get(allocation.booking_id) : null;
      if (relatedBooking) {
        if (nextStatus === "Active") {
          await createBookingActivityLog(relatedBooking, { name: "System", role: "System" }, {
            actionType: "temporary_allocation_started",
            title: "Temporary allocation started",
            message: `Temporary access started for Room ${relatedBooking.room_id || allocation.room_id}.`,
            statusTo: relatedBooking.status ?? null,
            roomIdTo: allocation.room_id ?? null,
            noteText: allocation.allocation_note || null
          });
          await createNotification(null, relatedBooking.faculty_name, "Temporary allocation started", `${relatedBooking.event_name || "Your request"} now has active temporary room access.`);
        }
        if (nextStatus === "Completed") {
          await createBookingActivityLog(relatedBooking, { name: "System", role: "System" }, {
            actionType: "temporary_allocation_completed",
            title: "Temporary allocation completed",
            message: `Temporary access ended and the room returned to its original department.`,
            statusTo: relatedBooking.status ?? null,
            roomIdTo: allocation.room_id ?? null,
            noteText: allocation.allocation_note || null
          });
          await createNotification(null, relatedBooking.faculty_name, "Temporary allocation ended", `${relatedBooking.event_name || "Your request"} completed and the temporary room access window has ended.`);
          const temporaryDepartmentName = await getDepartmentNameById(allocation.temporary_department_id);
          const originalDepartmentName = await getDepartmentNameById(allocation.original_department_id);
          if (temporaryDepartmentName) {
            await createNotification("HOD", null, "Temporary allocation ended", `Temporary access for ${relatedBooking.event_name || "a request"} has ended.`, temporaryDepartmentName);
          }
          if (originalDepartmentName) {
            await createNotification("HOD", null, "Room returned to department", `Room access has returned to the original department after temporary use.`, originalDepartmentName);
          }
        }
      }
    }
  }
};
var syncTemporaryRoomAllocationForBooking = async (booking, actor) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  if (!booking?.id) return;
  const existingAllocation = await db.prepare("SELECT * FROM temporary_room_allocations WHERE booking_id = ?").get(booking.id);
  const shouldHaveAllocation = isAdditionalRoomBooking(booking) && booking.status === "Approved" && booking.room_id && booking.department_id && booking.date && booking.start_time && booking.end_time;
  if (!shouldHaveAllocation) {
    if (existingAllocation && existingAllocation.status !== "Revoked") {
      await db.prepare(`
        UPDATE temporary_room_allocations
        SET status = 'Revoked', released_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE booking_id = ?
      `).run(booking.id);
    }
    return;
  }
  const originalAllocation = await getLatestDepartmentAllocationForRoom(booking.room_id);
  const nextStatus = deriveTemporaryAllocationStatus(booking.date, booking.start_time, booking.end_time);
  const payload = [
    booking.request_group_id ?? null,
    booking.room_id,
    booking.department_id,
    originalAllocation?.department_id ?? null,
    booking.date,
    booking.start_time,
    booking.end_time,
    booking.purpose || null,
    booking.request_type || null,
    booking.allocation_note || null,
    actor?.name || booking.decided_by || null,
    actor?.role || null,
    nextStatus,
    booking.id
  ];
  if (existingAllocation) {
    await db.prepare(`
      UPDATE temporary_room_allocations
      SET
        request_group_id = ?,
        room_id = ?,
        temporary_department_id = ?,
        original_department_id = ?,
        approved_date = ?,
        start_time = ?,
        end_time = ?,
        purpose = ?,
        request_type = ?,
        allocation_note = ?,
        assigned_by = ?,
        assigned_role = ?,
        status = ?,
        released_at = CASE WHEN ? = 'Completed' THEN COALESCE(released_at, CURRENT_TIMESTAMP) ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP
      WHERE booking_id = ?
    `).run(...payload, nextStatus);
    return;
  }
  await db.prepare(`
    INSERT INTO temporary_room_allocations (
      booking_id,
      request_group_id,
      room_id,
      temporary_department_id,
      original_department_id,
      approved_date,
      start_time,
      end_time,
      purpose,
      request_type,
      allocation_note,
      assigned_by,
      assigned_role,
      status,
      released_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'Completed' THEN CURRENT_TIMESTAMP ELSE NULL END)
  `).run(
    booking.id,
    booking.request_group_id ?? null,
    booking.room_id,
    booking.department_id,
    originalAllocation?.department_id ?? null,
    booking.date,
    booking.start_time,
    booking.end_time,
    booking.purpose || null,
    booking.request_type || null,
    booking.allocation_note || null,
    actor?.name || booking.decided_by || null,
    actor?.role || null,
    nextStatus,
    nextStatus
  );
};
var getTemporaryAllocationConflict = async (roomId, date, startTime, endTime, excludeBookingId) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  return await db.prepare(`
    SELECT id, booking_id
    FROM temporary_room_allocations
    WHERE room_id = ?
      AND approved_date = ?
      AND status IN ('Upcoming', 'Active')
      ${excludeBookingId ? "AND booking_id != ?" : ""}
      AND NOT (end_time <= ? OR start_time >= ?)
    LIMIT 1
  `).get(
    roomId,
    date,
    ...excludeBookingId ? [excludeBookingId] : [],
    startTime,
    endTime
  );
};
var getTemporaryAllocationScheduleConflict = async (roomId, dayOfWeek, startTime, endTime) => {
  if (!roomId || !dayOfWeek || !startTime || !endTime) return null;
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  const allocations = await db.prepare(`
    SELECT id, approved_date, start_time, end_time, status
    FROM temporary_room_allocations
    WHERE room_id = ? AND status IN ('Upcoming', 'Active')
  `).all(roomId);
  return allocations.find((allocation) => {
    const allocationDay = (/* @__PURE__ */ new Date(`${allocation.approved_date}T00:00:00`)).toLocaleDateString("en-US", { weekday: "long" });
    return allocationDay === dayOfWeek && timesOverlap(allocation.start_time, allocation.end_time, startTime, endTime);
  }) || null;
};
var applyBookingQueryFilters = (bookings, query) => {
  const requestedStatus = query.status?.toString().trim() || "";
  const requestedDepartmentId = query.department_id?.toString() || query.departmentId?.toString() || "";
  const requestedRequestType = query.requestType?.toString().trim() || query.request_type?.toString().trim() || "";
  const requestedAssignment = query.assignment?.toString().trim() || "";
  const requestedDecision = query.decision?.toString().trim() || "";
  return bookings.filter((booking) => {
    if (requestedStatus && booking?.status !== requestedStatus) return false;
    if (requestedDepartmentId && !idsEqual(booking?.department_id, requestedDepartmentId)) return false;
    if (requestedRequestType && booking?.request_type !== requestedRequestType) return false;
    if (requestedAssignment === "assigned" && !booking?.room_id) return false;
    if (requestedAssignment === "unassigned" && booking?.room_id) return false;
    if (requestedDecision === "ready") {
      const isReadyForDecision = booking?.status === "HOD Recommended" || booking?.request_type === "Additional Room" && ["Pending", "HOD Recommended"].includes(booking?.status) && !!booking?.room_id;
      if (!isReadyForDecision) return false;
    }
    return true;
  });
};
await backfillNotificationsIfEmpty();
var createCrudRoutes = (tableName, idField = "id") => {
  app.get(`/api/${tableName}`, authenticate, async (req, res) => {
    try {
      const wantsPagination = SERVER_PAGINATION_TABLES.has(tableName) && req.query.paginate?.toString() === "1";
      const wantsServerQuery = SERVER_PAGINATION_TABLES.has(tableName) && (wantsPagination || !!req.query.q?.toString().trim() || !!req.query.sortKey?.toString().trim());
      const requestedSearch = req.query.q?.toString().trim() || "";
      const requestedSortKey = req.query.sortKey?.toString().trim() || "";
      const requestedSortDir = normalizeImportMatchValue(req.query.sortDir) === "desc" ? "desc" : "asc";
      const requestedPage = Math.max(parseInt(req.query.page?.toString() || "1", 10) || 1, 1);
      const requestedPageSize = Math.min(Math.max(parseInt(req.query.pageSize?.toString() || "50", 10) || 50, 1), 200);
      const searchFields = (req.query.searchFields?.toString() || "").split(",").map((field) => field.trim()).filter(Boolean);
      if (tableName === "users") {
        const users = await db.prepare(`SELECT * FROM users`).all();
        const enrichedUsers = await Promise.all(users.map(async (user) => {
          const schoolContext = await buildUserSchoolContext(user);
          const context = await buildUserDepartmentContext(user);
          return {
            ...user,
            school: schoolContext.primarySchoolName || user.school || null,
            primary_school_id: schoolContext.primarySchoolId,
            primary_school: schoolContext.primarySchoolName,
            assigned_school_ids: schoolContext.assignedSchoolIds.join(","),
            assigned_schools: schoolContext.assignedSchoolNames.join(", "),
            department: context.primaryDepartmentName || user.department || null,
            primary_department_id: context.primaryDepartmentId,
            primary_department: context.primaryDepartmentName,
            assigned_department_ids: context.assignedDepartmentIds.join(","),
            assigned_departments: context.assignedDepartmentNames.join(", ")
          };
        }));
        return res.json(enrichedUsers);
      }
      if (tableName === "bookings") {
        const bookings = await db.prepare(`
          SELECT bk.*, r.room_number, d.name as department_name
          FROM bookings bk
          LEFT JOIN rooms r ON bk.room_id = r.id
          LEFT JOIN departments d ON bk.department_id = d.id
        `).all();
        const user = req.user;
        if (isDecisionRole(user.role)) return res.json(applyBookingQueryFilters(bookings, req.query));
        if (user.role === "Dean") {
          const accessibleSchoolIds = Array.from(getAccessibleSchoolIdSet(user));
          const scope = accessibleSchoolIds.length > 0 ? await db.prepare(`
                SELECT id
                FROM departments
                WHERE school_id IN (${accessibleSchoolIds.map(() => "?").join(", ")})
              `).all(...accessibleSchoolIds).then((departments) => ({
            departmentIdsInSchool: departments.map((item) => item?.id?.toString()).filter(Boolean)
          })) : user.school ? await getSchoolRecordByName(user.school).then(async (school) => {
            if (!school) return { departmentIdsInSchool: [] };
            const siblingDepartments = await db.prepare(`SELECT id FROM departments WHERE school_id = ?`).all(school.id);
            return {
              departmentIdsInSchool: siblingDepartments.map((item) => item?.id?.toString()).filter(Boolean)
            };
          }) : await getDepartmentScopeByName(user.department);
          if (scope.departmentIdsInSchool.length > 0) {
            const allowedDepartmentIds = new Set(scope.departmentIdsInSchool);
            return res.json(applyBookingQueryFilters(bookings.filter(
              (booking) => isBookingRequester(booking, user) || booking.department_id != null && allowedDepartmentIds.has(booking.department_id.toString())
            ), req.query));
          }
          return res.json(applyBookingQueryFilters(bookings.filter((booking) => isBookingRequester(booking, user)), req.query));
        }
        if (user.role === "HOD") {
          const accessibleDepartmentIds = getAccessibleDepartmentIdSet(user);
          return res.json(applyBookingQueryFilters(bookings.filter(
            (booking) => isBookingRequester(booking, user) || booking?.department_id != null && accessibleDepartmentIds.has(booking.department_id.toString()) || !!user.department && booking.department_name === user.department
          ), req.query));
        }
        return res.json(applyBookingQueryFilters(bookings.filter((booking) => isBookingRequester(booking, user)), req.query));
      }
      if (tableName === "batch_room_allocations") {
        await maybeSyncBatchAllocationStatuses();
      }
      if (wantsServerQuery) {
        const rawColumns = db.dialect === "postgres" ? await db.prepare(`SELECT column_name as name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`).all(tableName) : await db.prepare(`PRAGMA table_info(${tableName})`).all();
        const tableColumns = rawColumns.map((column) => column?.name?.toString()).filter(Boolean);
        const allowedSearchFields = (searchFields.length > 0 ? searchFields : tableColumns).filter((field) => tableColumns.includes(field));
        const sortKey = tableColumns.includes(requestedSortKey) ? requestedSortKey : tableColumns.includes("id") ? "id" : tableColumns[0];
        if (tableName === "schedules") {
          let scheduleItems = await db.prepare(`SELECT * FROM ${tableName}`).all();
          scheduleItems = deduplicateSchedules(await backfillMissingScheduleCodes(scheduleItems)).kept;
          const requestedDate = normalizeIsoDate(req.query.date);
          if (requestedDate) {
            scheduleItems = await filterSchedulesByAcademicCalendar(scheduleItems, requestedDate);
          }
          const scheduleDepartmentId = req.query.department_id?.toString() || "";
          const scheduleProgram = req.query.program?.toString().trim() || "";
          const scheduleYear = req.query.year?.toString().trim() || "";
          const scheduleSpecialization = req.query.specialization?.toString().trim() || "";
          const scheduleRoomId = req.query.room_id?.toString() || "";
          const scheduleDay = req.query.day_of_week?.toString().trim() || "";
          const scheduleCampusId = req.query.campus_id?.toString() || "";
          const scheduleBuildingId = req.query.building_id?.toString() || "";
          const scheduleBlockId = req.query.block_id?.toString() || "";
          const scheduleFloorId = req.query.floor_id?.toString() || "";
          if (scheduleDepartmentId || scheduleProgram || scheduleYear || scheduleSpecialization || scheduleRoomId || scheduleDay || scheduleCampusId || scheduleBuildingId || scheduleBlockId || scheduleFloorId) {
            const rooms = await db.prepare("SELECT id, floor_id FROM rooms").all();
            const floors = await db.prepare("SELECT id, block_id FROM floors").all();
            const blocks = await db.prepare("SELECT id, building_id FROM blocks").all();
            const buildings = await db.prepare("SELECT id, campus_id FROM buildings").all();
            const roomById = new Map(rooms.map((room) => [room.id?.toString(), room]));
            const floorById = new Map(floors.map((floor) => [floor.id?.toString(), floor]));
            const blockById = new Map(blocks.map((block) => [block.id?.toString(), block]));
            const buildingById = new Map(buildings.map((building) => [building.id?.toString(), building]));
            scheduleItems = scheduleItems.filter((schedule) => {
              if (scheduleDepartmentId && !idsEqual(schedule?.department_id, scheduleDepartmentId)) return false;
              if (scheduleProgram && normalizeScheduleProgramValue(schedule?.program) !== normalizeScheduleProgramValue(scheduleProgram)) return false;
              if (scheduleYear) {
                const yearLabel = getYearDisplayLabel(schedule?.year_of_study, schedule?.semester);
                if (yearLabel !== scheduleYear) return false;
              }
              if (scheduleSpecialization && normalizeImportMatchValue(schedule?.specialization) !== normalizeImportMatchValue(scheduleSpecialization)) return false;
              if (scheduleRoomId && !idsEqual(schedule?.room_id, scheduleRoomId)) return false;
              if (scheduleDay && normalizeImportMatchValue(schedule?.day_of_week) !== normalizeImportMatchValue(scheduleDay)) return false;
              if (scheduleCampusId || scheduleBuildingId || scheduleBlockId || scheduleFloorId) {
                const room = roomById.get(schedule?.room_id?.toString());
                const floor = floorById.get(room?.floor_id?.toString());
                const block = blockById.get(floor?.block_id?.toString());
                const building = buildingById.get(block?.building_id?.toString());
                if (scheduleCampusId && !idsEqual(building?.campus_id, scheduleCampusId)) return false;
                if (scheduleBuildingId && !idsEqual(building?.id, scheduleBuildingId)) return false;
                if (scheduleBlockId && !idsEqual(block?.id, scheduleBlockId)) return false;
                if (scheduleFloorId && !idsEqual(floor?.id, scheduleFloorId)) return false;
              }
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            scheduleItems = scheduleItems.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey === "day_of_week") {
            scheduleItems = scheduleItems.slice().sort((left, right) => {
              const dayCompare = (scheduleDayOrder.get(normalizeImportMatchValue(left?.day_of_week)) ?? Number.MAX_SAFE_INTEGER) - (scheduleDayOrder.get(normalizeImportMatchValue(right?.day_of_week)) ?? Number.MAX_SAFE_INTEGER);
              if (dayCompare !== 0) {
                return requestedSortDir === "desc" ? -dayCompare : dayCompare;
              }
              const startCompare = parseScheduleTimeToMinutes(left?.start_time) - parseScheduleTimeToMinutes(right?.start_time);
              if (startCompare !== 0) {
                return requestedSortDir === "desc" ? -startCompare : startCompare;
              }
              return compareServerSortValues(left?.schedule_code || left?.schedule_id, right?.schedule_code || right?.schedule_id);
            });
          } else if (sortKey) {
            scheduleItems = scheduleItems.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(scheduleItems);
          }
          const total2 = scheduleItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: scheduleItems.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        if (tableName === "batch_room_allocations") {
          let allocationItems = await db.prepare(`SELECT * FROM ${tableName}`).all();
          const schoolId = req.query.school_id?.toString() || "";
          const departmentId = req.query.department_id?.toString() || "";
          const status = req.query.status?.toString().trim() || "";
          if (schoolId || departmentId || status) {
            allocationItems = allocationItems.filter((item) => {
              const computedStatus = deriveBatchAllocationStatus(
                normalizeIsoDate(item?.start_date),
                normalizeIsoDate(item?.end_date),
                item?.status
              );
              if (schoolId && !idsEqual(item?.school_id, schoolId)) return false;
              if (departmentId && !idsEqual(item?.department_id, departmentId)) return false;
              if (status && computedStatus !== status) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            allocationItems = allocationItems.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            allocationItems = allocationItems.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(allocationItems);
          }
          const total2 = allocationItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: allocationItems.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        if (tableName === "department_allocations") {
          let allocationItems = await db.prepare(`SELECT * FROM ${tableName}`).all();
          if (normalizeRoleLabel(req.user?.role) === "hod") {
            const accessibleDepartmentIds = getAccessibleDepartmentIdSet(req.user);
            allocationItems = allocationItems.filter(
              (item) => item?.department_id != null && accessibleDepartmentIds.has(item.department_id.toString())
            );
          }
          const schoolId = req.query.school_id?.toString() || "";
          const departmentId = req.query.department_id?.toString() || "";
          const semester = req.query.semester?.toString().trim() || "";
          if (schoolId || departmentId || semester) {
            allocationItems = allocationItems.filter((item) => {
              if (schoolId && !idsEqual(item?.school_id, schoolId)) return false;
              if (departmentId && !idsEqual(item?.department_id, departmentId)) return false;
              if (semester && item?.semester?.toString() !== semester) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            allocationItems = allocationItems.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            allocationItems = allocationItems.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(allocationItems);
          }
          const total2 = allocationItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: allocationItems.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        if (tableName === "hod_room_allocations") {
          let allocationItems = await db.prepare(`SELECT * FROM ${tableName}`).all();
          if (normalizeRoleLabel(req.user?.role) === "hod") {
            allocationItems = allocationItems.filter((item) => idsEqual(item?.hod_user_id, req.user?.id));
          }
          const schoolId = req.query.school_id?.toString() || "";
          const hodUserId = req.query.hod_user_id?.toString() || "";
          const semester = req.query.semester?.toString().trim() || "";
          if (schoolId || hodUserId || semester) {
            allocationItems = allocationItems.filter((item) => {
              if (schoolId && !idsEqual(item?.school_id, schoolId)) return false;
              if (hodUserId && !idsEqual(item?.hod_user_id, hodUserId)) return false;
              if (semester && item?.semester?.toString() !== semester) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            allocationItems = allocationItems.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            allocationItems = allocationItems.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(allocationItems);
          }
          const total2 = allocationItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: allocationItems.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        if (tableName === "rooms") {
          let roomItems = await db.prepare(`SELECT * FROM ${tableName}`).all();
          const campusId = req.query.campus_id?.toString() || "";
          const buildingId = req.query.building_id?.toString() || "";
          const blockId = req.query.block_id?.toString() || "";
          const floorId = req.query.floor_id?.toString() || "";
          if (campusId || buildingId || blockId || floorId) {
            const floors = await db.prepare("SELECT id, block_id FROM floors").all();
            const blocks = await db.prepare("SELECT id, building_id FROM blocks").all();
            const buildings = await db.prepare("SELECT id, campus_id FROM buildings").all();
            const floorById = new Map(floors.map((floor) => [floor.id?.toString(), floor]));
            const blockById = new Map(blocks.map((block) => [block.id?.toString(), block]));
            const buildingById = new Map(buildings.map((building) => [building.id?.toString(), building]));
            roomItems = roomItems.filter((item) => {
              const floor = floorById.get(item?.floor_id?.toString());
              const block = blockById.get(floor?.block_id?.toString());
              const building = buildingById.get(block?.building_id?.toString());
              if (campusId && !idsEqual(building?.campus_id, campusId)) return false;
              if (buildingId && !idsEqual(building?.id, buildingId)) return false;
              if (blockId && !idsEqual(block?.id, blockId)) return false;
              if (floorId && !idsEqual(floor?.id, floorId)) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            roomItems = roomItems.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            roomItems = roomItems.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(roomItems);
          }
          const total2 = roomItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: roomItems.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        if (tableName === "users") {
          const policy = getUserManagementPolicy(req.user);
          if (!policy) {
            return res.status(403).json({ error: "You do not have permission to view users." });
          }
          const allUsers = await db.prepare(`SELECT * FROM ${tableName}`).all();
          const hydratedUsers = await Promise.all(allUsers.map((user) => buildUserManagementRow(user)));
          const visibleUsers = [];
          for (const userRow of hydratedUsers) {
            if (await canActorManageExistingUser(req.user, userRow)) {
              visibleUsers.push(userRow);
            }
          }
          let filteredUsers = visibleUsers;
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            filteredUsers = filteredUsers.filter(
              (item) => allowedSearchFields.some(
                (field) => item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            filteredUsers = filteredUsers.slice().sort((left, right) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(filteredUsers);
          }
          const total2 = filteredUsers.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: filteredUsers.slice(startIndex, startIndex + requestedPageSize),
            total: total2,
            page: requestedPage,
            pageSize: requestedPageSize
          });
        }
        const whereClauses = [];
        const values = [];
        if (requestedSearch && allowedSearchFields.length > 0) {
          const searchClause = allowedSearchFields.map((field) => `LOWER(CAST(${field} AS TEXT)) LIKE ?`).join(" OR ");
          whereClauses.push(`(${searchClause})`);
          const searchValue = `%${requestedSearch.toLowerCase()}%`;
          allowedSearchFields.forEach(() => values.push(searchValue));
        }
        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
        const countRow = await db.prepare(`SELECT COUNT(*) as total FROM ${tableName} ${whereSql}`).get(...values);
        const total = Number(countRow?.total || 0);
        const items2 = await db.prepare(`
          SELECT * FROM ${tableName}
          ${whereSql}
          ORDER BY ${sortKey} ${requestedSortDir.toUpperCase()}
          LIMIT ? OFFSET ?
        `).all(...values, requestedPageSize, (requestedPage - 1) * requestedPageSize);
        if (!wantsPagination) {
          return res.json(items2);
        }
        return res.json({
          items: items2,
          total,
          page: requestedPage,
          pageSize: requestedPageSize
        });
      }
      if (CACHEABLE_SERVER_TABLES.has(tableName) && !req.query.date) {
        const cached = getFromServerCache(tableName);
        if (cached) return res.json(cached);
      }
      const items = await db.prepare(`SELECT * FROM ${tableName}`).all();
      if (tableName === "schedules") {
        const hydratedItems = await backfillMissingScheduleCodes(items);
        const deduplicatedItems = deduplicateSchedules(hydratedItems).kept;
        const requestedDate = normalizeIsoDate(req.query.date);
        if (requestedDate) {
          return res.json(await filterSchedulesByAcademicCalendar(deduplicatedItems, requestedDate));
        }
        setInServerCache("schedules", deduplicatedItems);
        return res.json(deduplicatedItems);
      }
      if (tableName === "users") {
        const policy = getUserManagementPolicy(req.user);
        if (!policy) {
          return res.status(403).json({ error: "You do not have permission to view users." });
        }
        const hydratedUsers = await Promise.all(items.map((user) => buildUserManagementRow(user)));
        const visibleUsers = [];
        for (const userRow of hydratedUsers) {
          if (await canActorManageExistingUser(req.user, userRow)) {
            visibleUsers.push(userRow);
          }
        }
        return res.json(visibleUsers);
      }
      if (CACHEABLE_SERVER_TABLES.has(tableName)) setInServerCache(tableName, items);
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post(`/api/${tableName}/import-bulk`, authenticate, async (req, res) => {
    if (!BULK_IMPORT_SUPPORTED_TABLES.has(tableName)) {
      return res.status(404).json({ error: "Bulk import is not supported for this module." });
    }
    if (tableName === "users" && !isAdminRole(req.user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can manage users and passwords." });
    }
    if (tableName === "hod_room_allocations" && !canManageHodRoomAllocations(req.user?.role)) {
      return res.status(403).json({ error: "You do not have permission to import HOD room allocations." });
    }
    try {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (entries.length === 0) {
        return res.json({ results: [] });
      }
      const results = await db.transaction(async (transactionDb) => {
        const records = await transactionDb.prepare(`SELECT * FROM ${tableName}`).all();
        const importContext = createBulkImportContext(tableName, records);
        const scopedPersistBulkImportRecord = async (payload, existingItem, context) => {
          const normalizedPayload = await normalizeBulkImportPayload(tableName, payload, existingItem);
          const userAssignmentPayload = tableName === "users" ? {
            assigned_schools: normalizedPayload.assigned_schools,
            assigned_school_ids: normalizedPayload.assigned_school_ids,
            primary_school_id: normalizedPayload.primary_school_id,
            primary_school: normalizedPayload.primary_school,
            school: normalizedPayload.school,
            assigned_departments: normalizedPayload.assigned_departments,
            assigned_department_ids: normalizedPayload.assigned_department_ids,
            primary_department_id: normalizedPayload.primary_department_id,
            primary_department: normalizedPayload.primary_department,
            department: normalizedPayload.department
          } : null;
          if (tableName === "users") {
            delete normalizedPayload.assigned_schools;
            delete normalizedPayload.assigned_school_ids;
            delete normalizedPayload.primary_school_id;
            delete normalizedPayload.primary_school;
            delete normalizedPayload.assigned_departments;
            delete normalizedPayload.assigned_department_ids;
            delete normalizedPayload.primary_department_id;
            delete normalizedPayload.primary_department;
          }
          await validateBulkImportPayload(tableName, normalizedPayload, existingItem, context);
          const fields = Object.keys(normalizedPayload);
          if (fields.length === 0) {
            throw new Error("Import payload is empty.");
          }
          if (existingItem?.id) {
            const setClause = fields.map((field) => `${field} = ?`).join(", ");
            const values2 = [...Object.values(normalizedPayload), existingItem.id];
            if (tableName === "users" && normalizedPayload.password) {
              const passwordIndex = fields.indexOf("password");
              values2[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
            }
            await transactionDb.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...values2);
            if (tableName === "users" && userAssignmentPayload) {
              await syncUserSchoolAssignments(existingItem.id, userAssignmentPayload);
              await syncUserDepartmentAssignments(existingItem.id, userAssignmentPayload);
            }
            return { ...existingItem, ...normalizedPayload, id: existingItem.id, __importAction: "updated" };
          }
          const placeholders = fields.map(() => "?").join(", ");
          const values = [...Object.values(normalizedPayload)];
          if (tableName === "users" && normalizedPayload.password) {
            const passwordIndex = fields.indexOf("password");
            values[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
          }
          const info = await transactionDb.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${placeholders})`).run(...values);
          if (tableName === "users" && userAssignmentPayload) {
            await syncUserSchoolAssignments(info.lastInsertRowid, userAssignmentPayload);
            await syncUserDepartmentAssignments(info.lastInsertRowid, userAssignmentPayload);
          }
          return { id: info.lastInsertRowid, ...normalizedPayload, __importAction: "created" };
        };
        const transactionResults = [];
        for (const entry of entries) {
          const payload = entry?.payload ?? entry;
          const uniqueFieldGroups = Array.isArray(entry?.uniqueFieldGroups) ? entry.uniqueFieldGroups : [];
          try {
            const existingItem = findMatchingImportRecord(records, payload, uniqueFieldGroups);
            const savedRecord = await scopedPersistBulkImportRecord(payload, existingItem, importContext);
            const existingIndex = records.findIndex((record) => idsEqual(record?.id, savedRecord?.id));
            if (existingIndex >= 0) {
              records[existingIndex] = { ...records[existingIndex], ...savedRecord };
            } else {
              records.push(savedRecord);
            }
            transactionResults.push({
              ok: true,
              record: savedRecord,
              action: savedRecord.__importAction
            });
          } catch (err) {
            transactionResults.push({
              ok: false,
              error: err?.message || "Import failed."
            });
          }
        }
        return transactionResults;
      });
      bustServerCache(tableName);
      res.json({ results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.post(`/api/${tableName}`, authenticate, async (req, res) => {
    if (tableName === "users" && !getUserManagementPolicy(req.user)) {
      return res.status(403).json({ error: "You do not have permission to manage users." });
    }
    if (tableName === "hod_room_allocations" && !canManageHodRoomAllocations(req.user?.role)) {
      return res.status(403).json({ error: "You do not have permission to allocate rooms to HOD users." });
    }
    if (tableName === "users" && !req.body.password) {
      req.body.password = "Welcome123";
    }
    if (tableName === "users" && req.body.password) {
      req.body.force_password_change = 1;
    }
    if (tableName === "bookings") {
      await ensureBookingColumnsReady();
      if (!req.body.status) {
        req.body.status = "Pending";
      }
    }
    const userAssignmentPayload = tableName === "users" ? {
      assigned_schools: req.body.assigned_schools,
      assigned_school_ids: req.body.assigned_school_ids,
      primary_school_id: req.body.primary_school_id,
      primary_school: req.body.primary_school,
      school: req.body.school,
      assigned_departments: req.body.assigned_departments,
      assigned_department_ids: req.body.assigned_department_ids,
      primary_department_id: req.body.primary_department_id,
      primary_department: req.body.primary_department,
      department: req.body.department
    } : null;
    try {
      if (tableName === "users") {
        req.body = await normalizeUserPayload(req.body);
        await assertActorCanManageUserPayload(req.user, req.body);
        if (userAssignmentPayload) Object.assign(userAssignmentPayload, {
          assigned_schools: req.body.assigned_schools,
          assigned_school_ids: req.body.assigned_school_ids,
          primary_school_id: req.body.primary_school_id,
          primary_school: req.body.primary_school,
          school: req.body.school,
          assigned_departments: req.body.assigned_departments,
          assigned_department_ids: req.body.assigned_department_ids,
          primary_department_id: req.body.primary_department_id,
          primary_department: req.body.primary_department,
          department: req.body.department
        });
        delete req.body.assigned_schools;
        delete req.body.assigned_school_ids;
        delete req.body.primary_school_id;
        delete req.body.primary_school;
        delete req.body.assigned_departments;
        delete req.body.assigned_department_ids;
        delete req.body.primary_department_id;
        delete req.body.primary_department;
      }
      if (tableName === "academic_calendars") {
        req.body = await normalizeAcademicCalendarPayload(req.body);
      }
      if (tableName === "timing_profiles") {
        req.body = await normalizeTimingProfilePayload(req.body);
      }
      if (tableName === "batch_room_allocations") {
        req.body = await normalizeBatchRoomAllocationPayload(req.body);
      }
      if (tableName === "schedules") {
        req.body = normalizeSchedulePayload(req.body);
      }
      if (tableName === "rooms") {
        req.body = normalizeRoomPayload(req.body);
      }
      req.body = await normalizeHierarchyReferencePayload(tableName, req.body);
      const fields = Object.keys(req.body);
      const placeholders = fields.map(() => "?").join(", ");
      const values = Object.values(req.body);
      if (tableName === "users" && req.body.password) {
        const passIdx = fields.indexOf("password");
        values[passIdx] = bcrypt.hashSync(req.body.password, 10);
      }
      const duplicateError = await checkDuplicateRecord(tableName, req.body);
      if (duplicateError) {
        return res.status(400).json({ error: duplicateError });
      }
      if (tableName === "rooms") {
        const hierarchyError = await validateRoomHierarchy(req.body);
        if (hierarchyError) return res.status(400).json({ error: hierarchyError });
        const restroomValidationError = await getRestroomValidationError(req.body);
        if (restroomValidationError) return res.status(400).json({ error: restroomValidationError });
      }
      if (tableName === "department_allocations") {
        if (normalizeRoleLabel(req.user?.role) === "hod") {
          const accessibleDepartmentIds = getAccessibleDepartmentIdSet(req.user);
          if (!req.body.department_id || !accessibleDepartmentIds.has(req.body.department_id.toString())) {
            return res.status(403).json({ error: "You can map rooms only for your assigned departments." });
          }
          const hodRoomAllocationError = await getHodRoomAllocationLinkError(req.body.room_id, req.user?.id, req.body.semester);
          if (hodRoomAllocationError) return res.status(400).json({ error: hodRoomAllocationError });
        }
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(req.body.room_id);
        if (!room) return res.status(400).json({ error: "Please select a valid room." });
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        if ((parseInt(req.body.capacity, 10) || 0) > room.capacity) {
          return res.status(400).json({ error: `Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${req.body.capacity}.` });
        }
        req.body.room_type = room.room_type;
        const roomTypeIndex = fields.indexOf("room_type");
        if (roomTypeIndex >= 0) values[roomTypeIndex] = req.body.room_type;
      }
      if (tableName === "hod_room_allocations") {
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(req.body.room_id);
        if (!room) return res.status(400).json({ error: "Please select a valid room." });
        const hodUser = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(req.body.hod_user_id);
        if (!hodUser || normalizeRoleLabel(hodUser.role) !== "hod") {
          return res.status(400).json({ error: "Please select a valid HOD user." });
        }
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        req.body.room_type = room.room_type;
        req.body.capacity = room.capacity;
      }
      if (tableName === "batch_room_allocations") {
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const departmentAllocationError = await getDepartmentAllocationLinkError(req.body.room_id, req.body.department_id, req.body.semester);
        if (departmentAllocationError) return res.status(400).json({ error: departmentAllocationError });
        const overlapError = await getBatchAllocationOverlapError(req.body);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }
      if (tableName === "schedules") {
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const temporaryAllocationConflict = await getTemporaryAllocationScheduleConflict(
          req.body.room_id,
          req.body.day_of_week,
          req.body.start_time,
          req.body.end_time
        );
        if (temporaryAllocationConflict) return res.status(400).json({ error: "This room has an overlapping temporary allocation for one or more matching schedule slots." });
        req.body.schedule_code = await assignScheduleCode(req.body);
      }
      if (tableName === "bookings") {
        req.body.request_type = normalizeBookingRequestType(req.body.request_type);
        req.body.faculty_name = req.user?.name?.toString().trim() || req.body.faculty_name?.toString().trim() || "Unknown";
        req.body.requester_user_id = req.user?.id ?? null;
        const requiresAssignedRoom = !isAdditionalRoomBooking(req.body);
        if (!req.body.date || !req.body.start_time || !req.body.end_time) {
          return res.status(400).json({ error: "Date, start time, and end time are required." });
        }
        if (requiresAssignedRoom && !req.body.room_id) {
          return res.status(400).json({ error: "Please select a room for a department room booking." });
        }
        if (!requiresAssignedRoom) {
          req.body.room_id = null;
          if (!req.body.required_capacity && !req.body.student_count) {
            return res.status(400).json({ error: "Required capacity is needed for an additional room request." });
          }
        }
        if (req.body.room_id) {
          const bookableError = await getBookableRoomError(req.body.room_id);
          if (bookableError) return res.status(400).json({ error: bookableError });
        }
        if (!req.body.department_id) {
          return res.status(400).json({ error: "Department is required so the request can go to the respective HOD." });
        }
        const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(req.body.department_id);
        if (!department) {
          return res.status(400).json({ error: "Please select a valid department." });
        }
        req.body.purpose_type = normalizeBookingPurposeType(req.body.purpose_type);
        if (!["Pending", "Approved"].includes(req.body.status || "Pending")) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (req.body.status === "Approved" && !(isAdminRole(req.user.role) || ["Dean (P&M)"].includes(req.user.role))) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (req.body.status === "Approved" && !req.body.room_id) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (isPastDateTime(req.body.date, req.body.start_time)) {
          return res.status(400).json({ error: "Past booking times are not allowed." });
        }
        const duplicateOpenRequest = await getDuplicateOpenBookingRequest(req.body);
        if (duplicateOpenRequest) {
          return res.status(400).json({ error: "You already have an active request for this room and time slot." });
        }
        const conflictingBooking = await getApprovedBookingConflict(req.body);
        if (conflictingBooking) {
          return res.status(400).json({ error: "This room already has an approved booking for the selected time slot." });
        }
        const temporaryConflict = await getTemporaryAllocationConflict(req.body.room_id, req.body.date, req.body.start_time, req.body.end_time);
        if (temporaryConflict) {
          return res.status(400).json({ error: "This room already has a temporary allocation for the selected time slot." });
        }
        const timingPolicy = await getBookingTimingPolicyDetails(req.body);
        req.body.timing_override = timingPolicy.timingOverride;
        if (timingPolicy.purposeType === "Academic Regular" && timingPolicy.slots.length > 0 && !timingPolicy.matchesWindow) {
          return res.status(400).json({ error: "Academic Regular bookings must match the active department timing-profile slot window exactly." });
        }
        if (!fields.includes("purpose_type")) {
          fields.push("purpose_type");
          values.push(req.body.purpose_type);
        } else {
          values[fields.indexOf("purpose_type")] = req.body.purpose_type;
        }
        if (!fields.includes("faculty_name")) {
          fields.push("faculty_name");
          values.push(req.body.faculty_name);
        } else {
          values[fields.indexOf("faculty_name")] = req.body.faculty_name;
        }
        if (!fields.includes("requester_user_id")) {
          fields.push("requester_user_id");
          values.push(req.body.requester_user_id);
        } else {
          values[fields.indexOf("requester_user_id")] = req.body.requester_user_id;
        }
        if (!fields.includes("timing_override")) {
          fields.push("timing_override");
          values.push(req.body.timing_override);
        } else {
          values[fields.indexOf("timing_override")] = req.body.timing_override;
        }
      }
      const insertPlaceholders = fields.map(() => "?").join(", ");
      const info = await db.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${insertPlaceholders})`).run(...values);
      if (tableName === "users" && userAssignmentPayload) {
        await syncUserSchoolAssignments(info.lastInsertRowid, userAssignmentPayload);
        await syncUserDepartmentAssignments(info.lastInsertRowid, userAssignmentPayload);
      }
      if (tableName === "bookings") {
        const requestLabel = isAdditionalRoomBooking(req.body) ? "an additional room requirement" : req.body.event_name || "a room";
        const message = `${req.body.faculty_name} requested ${requestLabel} on ${req.body.date} from ${req.body.start_time} to ${req.body.end_time}.`;
        await createBookingActivityLog(
          { id: info.lastInsertRowid, ...req.body },
          { name: req.user?.name || req.body.faculty_name, role: req.user?.role || "Requester" },
          {
            actionType: "created",
            title: "Request submitted",
            message,
            statusTo: req.body.status || "Pending",
            roomIdTo: req.body.room_id ?? null,
            noteText: req.body.notes || req.body.status_remark || null
          }
        );
        if (req.body.status === "Pending") {
          await createNotification(null, req.body.faculty_name, "Room request submitted", `${req.body.event_name || "Your room request"} was submitted for approval.`);
          await notifyBookingAuthorities(req.body, "New room request", message);
          const competingRequests = await getCompetingOpenBookingRequests(req.body, info.lastInsertRowid);
          if (competingRequests.length > 0) {
            await notifyBookingAuthorities(
              req.body,
              "Competing room requests",
              `${req.body.event_name || "A room request"} overlaps with ${competingRequests.length} other active request(s) for the same room and time. Dean (P&M) can take the final decision.`
            );
          }
        } else {
          await createNotification(null, req.body.faculty_name, "Room booking approved", `${req.body.event_name || "Your room request"} is approved.`);
          await notifyBookingAuthorities(req.body, "Room booking approved", `${req.body.event_name || "A room request"} was approved directly.`);
        }
        await syncTemporaryRoomAllocationForBooking({ id: info.lastInsertRowid, ...req.body }, { name: req.user?.name || null, role: req.user?.role || null });
      }
      bustServerCache(tableName);
      res.json({ id: info.lastInsertRowid, ...req.body });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.put(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && !getUserManagementPolicy(req.user)) {
      return res.status(403).json({ error: "You do not have permission to manage users." });
    }
    if (tableName === "hod_room_allocations" && !canManageHodRoomAllocations(req.user?.role)) {
      return res.status(403).json({ error: "You do not have permission to allocate rooms to HOD users." });
    }
    if (tableName === "users" && !req.body.password) {
      delete req.body.password;
    }
    if (tableName === "users" && req.body.password) {
      req.body.force_password_change = 1;
    }
    if (tableName === "bookings") {
      await ensureBookingColumnsReady();
    }
    const userAssignmentPayload = tableName === "users" ? {
      assigned_schools: req.body.assigned_schools,
      assigned_school_ids: req.body.assigned_school_ids,
      primary_school_id: req.body.primary_school_id,
      primary_school: req.body.primary_school,
      school: req.body.school,
      assigned_departments: req.body.assigned_departments,
      assigned_department_ids: req.body.assigned_department_ids,
      primary_department_id: req.body.primary_department_id,
      primary_department: req.body.primary_department,
      department: req.body.department
    } : null;
    if (tableName === "rooms") {
      req.body = normalizeRoomPayload(req.body);
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id);
      if (!existingItem) {
        return res.status(404).json({ error: `${tableName} record not found.` });
      }
      if (tableName === "users") {
        if (!await canActorManageExistingUser(req.user, existingItem)) {
          return res.status(403).json({ error: "You can manage only subordinate users allowed for your account." });
        }
        req.body = await normalizeUserPayload(req.body, existingItem);
        await assertActorCanManageUserPayload(req.user, req.body, existingItem);
        if (userAssignmentPayload) Object.assign(userAssignmentPayload, {
          assigned_schools: req.body.assigned_schools,
          assigned_school_ids: req.body.assigned_school_ids,
          primary_school_id: req.body.primary_school_id,
          primary_school: req.body.primary_school,
          school: req.body.school,
          assigned_departments: req.body.assigned_departments,
          assigned_department_ids: req.body.assigned_department_ids,
          primary_department_id: req.body.primary_department_id,
          primary_department: req.body.primary_department,
          department: req.body.department
        });
        delete req.body.assigned_schools;
        delete req.body.assigned_school_ids;
        delete req.body.primary_school_id;
        delete req.body.primary_school;
        delete req.body.assigned_departments;
        delete req.body.assigned_department_ids;
        delete req.body.primary_department_id;
        delete req.body.primary_department;
      }
      if (tableName === "academic_calendars") {
        req.body = await normalizeAcademicCalendarPayload({ ...existingItem, ...req.body });
      }
      if (tableName === "timing_profiles") {
        req.body = await normalizeTimingProfilePayload({ ...existingItem, ...req.body });
      }
      if (tableName === "batch_room_allocations") {
        req.body = await normalizeBatchRoomAllocationPayload({ ...existingItem, ...req.body });
      }
      if (tableName === "schedules") {
        req.body = normalizeSchedulePayload({ ...existingItem, ...req.body });
      }
      req.body = await normalizeHierarchyReferencePayload(tableName, req.body);
      let fields = Object.keys(req.body);
      let setClause = fields.map((f) => `${f} = ?`).join(", ");
      let values = [...Object.values(req.body), req.params.id];
      const duplicateError = await checkDuplicateRecord(tableName, { ...existingItem, ...req.body }, req.params.id);
      if (duplicateError) {
        return res.status(400).json({ error: duplicateError });
      }
      if (tableName === "rooms") {
        const hierarchyError = await validateRoomHierarchy({ ...existingItem, ...req.body }, req.params.id);
        if (hierarchyError) return res.status(400).json({ error: hierarchyError });
        const restroomValidationError = await getRestroomValidationError({ ...existingItem, ...req.body });
        if (restroomValidationError) return res.status(400).json({ error: restroomValidationError });
      }
      if (tableName === "department_allocations") {
        const nextAllocation = { ...existingItem, ...req.body };
        if (normalizeRoleLabel(req.user?.role) === "hod") {
          const accessibleDepartmentIds = getAccessibleDepartmentIdSet(req.user);
          if (!nextAllocation.department_id || !accessibleDepartmentIds.has(nextAllocation.department_id.toString())) {
            return res.status(403).json({ error: "You can map rooms only for your assigned departments." });
          }
          const hodRoomAllocationError = await getHodRoomAllocationLinkError(nextAllocation.room_id, req.user?.id, nextAllocation.semester);
          if (hodRoomAllocationError) return res.status(400).json({ error: hodRoomAllocationError });
        }
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextAllocation.room_id);
        if (!room) return res.status(400).json({ error: "Please select a valid room." });
        const bookableError = await getBookableRoomError(nextAllocation.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        if ((parseInt(nextAllocation.capacity, 10) || 0) > room.capacity) {
          return res.status(400).json({ error: `Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${nextAllocation.capacity}.` });
        }
        req.body.room_type = room.room_type;
      }
      if (tableName === "hod_room_allocations") {
        const nextAllocation = { ...existingItem, ...req.body };
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextAllocation.room_id);
        if (!room) return res.status(400).json({ error: "Please select a valid room." });
        const hodUser = await db.prepare("SELECT id, role FROM users WHERE id = ?").get(nextAllocation.hod_user_id);
        if (!hodUser || normalizeRoleLabel(hodUser.role) !== "hod") {
          return res.status(400).json({ error: "Please select a valid HOD user." });
        }
        const bookableError = await getBookableRoomError(nextAllocation.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const changedScope = !idsEqual(existingItem?.room_id, nextAllocation.room_id) || !idsEqual(existingItem?.hod_user_id, nextAllocation.hod_user_id) || normalizeSemesterKey(existingItem?.semester) !== normalizeSemesterKey(nextAllocation.semester);
        if (changedScope) {
          const dependentMappings = await countDependentDepartmentRoomMappingsForHodAllocation(
            existingItem?.room_id,
            existingItem?.hod_user_id,
            existingItem?.semester
          );
          if (dependentMappings > 0) {
            return res.status(400).json({ error: "This HOD Room Allocation is already used by Department Room Mapping. Remove or reassign those department mappings first." });
          }
        }
        req.body.room_type = room.room_type;
        req.body.capacity = room.capacity;
      }
      if (tableName === "batch_room_allocations") {
        const nextAllocation = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextAllocation.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const departmentAllocationError = await getDepartmentAllocationLinkError(nextAllocation.room_id, nextAllocation.department_id, nextAllocation.semester);
        if (departmentAllocationError) return res.status(400).json({ error: departmentAllocationError });
        const overlapError = await getBatchAllocationOverlapError(nextAllocation, req.params.id);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }
      if (tableName === "schedules") {
        const nextSchedule = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextSchedule.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const temporaryAllocationConflict = await getTemporaryAllocationScheduleConflict(
          nextSchedule.room_id,
          nextSchedule.day_of_week,
          nextSchedule.start_time,
          nextSchedule.end_time
        );
        if (temporaryAllocationConflict) return res.status(400).json({ error: "This room has an overlapping temporary allocation for one or more matching schedule slots." });
        req.body.schedule_code = await assignScheduleCode(req.body, req.params.id, existingItem);
      }
      if (tableName === "bookings") {
        const nextBooking = { ...existingItem, ...req.body };
        nextBooking.request_type = normalizeBookingRequestType(nextBooking.request_type);
        req.body.request_type = nextBooking.request_type;
        const requiresAssignedRoom = !isAdditionalRoomBooking(nextBooking);
        if (requiresAssignedRoom && !nextBooking.room_id) {
          return res.status(400).json({ error: "Please select a room for a department room booking." });
        }
        if (!requiresAssignedRoom) {
          if (!nextBooking.required_capacity && !nextBooking.student_count) {
            return res.status(400).json({ error: "Required capacity is needed for an additional room request." });
          }
        }
        if (nextBooking.room_id) {
          const bookableError = await getBookableRoomError(nextBooking.room_id);
          if (bookableError) return res.status(400).json({ error: bookableError });
        }
        nextBooking.purpose_type = normalizeBookingPurposeType(nextBooking.purpose_type);
        req.body.purpose_type = nextBooking.purpose_type;
        const requestedStatus = req.body.status;
        const role = req.user.role;
        const isRequester = isBookingRequester(existingItem, req.user);
        const accessibleDepartmentIds = getAccessibleDepartmentIdSet(req.user);
        const isDepartmentHod = role === "HOD" && nextBooking?.department_id != null && accessibleDepartmentIds.has(nextBooking.department_id.toString());
        if (requestedStatus === "HOD Recommended") {
          if (!isDepartmentHod) {
            return res.status(403).json({ error: "Only the respective department HOD can recommend this room request." });
          }
          if (existingItem.status !== "Pending") {
            return res.status(400).json({ error: "Only pending requests can be recommended by HOD." });
          }
        }
        if (bookingDeanWorkflowStatuses.includes(requestedStatus)) {
          const deanCanDecide = isAdminRole(role) || ["Dean (P&M)"].includes(role);
          const deputyCanDecide = role === "Deputy Dean (P&M)" && existingItem.status === "HOD Recommended";
          const requesterCanCancel = requestedStatus === "Rejected" && isRequester;
          if (!deanCanDecide && !deputyCanDecide && !requesterCanCancel) {
            return res.status(403).json({ error: "Deputy Dean can decide only after HOD recommendation. Dean (P&M) can decide directly." });
          }
        }
        if (requestedStatus === "Pending" && !isRequester && !(isAdminRole(role) || ["Dean (P&M)"].includes(role))) {
          return res.status(403).json({ error: "Only the requester, Admin, Master Admin, or Dean (P&M) can reopen this request." });
        }
        if (requestedStatus === "Pending" && !["Rejected", "Postponed", "Clarification Required"].includes(existingItem.status)) {
          return res.status(400).json({ error: "Only rejected or postponed requests can be reopened." });
        }
        if (requestedStatus === "HOD Recommended") {
          req.body.recommended_by = req.user.name;
        }
        if (bookingDeanWorkflowStatuses.includes(requestedStatus)) {
          req.body.decided_by = req.user.name;
        }
        if (requestedStatus === "Approved" && !nextBooking.room_id) {
          return res.status(400).json({ error: "Assign a room before approving this booking request." });
        }
        if (nextBooking.room_id && nextBooking.date && nextBooking.start_time && nextBooking.end_time && isPastDateTime(nextBooking.date, nextBooking.start_time)) {
          return res.status(400).json({ error: "Past booking times are not allowed." });
        }
        if (openBookingStatuses.includes(nextBooking.status)) {
          const duplicateOpenRequest = await getDuplicateOpenBookingRequest(nextBooking, req.params.id);
          if (duplicateOpenRequest) {
            return res.status(400).json({ error: "This requester already has an active request for this room and time slot." });
          }
        }
        if (nextBooking.status === "Approved" && nextBooking.room_id && nextBooking.date && nextBooking.start_time && nextBooking.end_time) {
          const conflictingBooking = await getApprovedBookingConflict(nextBooking, req.params.id);
          if (conflictingBooking) {
            return res.status(400).json({ error: "This room already has an approved booking for the selected time slot." });
          }
          const temporaryConflict = await getTemporaryAllocationConflict(nextBooking.room_id, nextBooking.date, nextBooking.start_time, nextBooking.end_time, req.params.id);
          if (temporaryConflict) {
            return res.status(400).json({ error: "This room already has a temporary allocation for the selected time slot." });
          }
        }
        const timingPolicy = await getBookingTimingPolicyDetails(nextBooking);
        req.body.timing_override = timingPolicy.timingOverride;
        if (timingPolicy.purposeType === "Academic Regular" && timingPolicy.slots.length > 0 && !timingPolicy.matchesWindow) {
          return res.status(400).json({ error: "Academic Regular bookings must match the active department timing-profile slot window exactly." });
        }
      }
      fields = Object.keys(req.body);
      setClause = fields.map((f) => `${f} = ?`).join(", ");
      values = [...Object.values(req.body), req.params.id];
      if (tableName === "users" && req.body.password) {
        const passIdx = fields.indexOf("password");
        values[passIdx] = bcrypt.hashSync(req.body.password, 10);
      }
      await db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE ${idField} = ?`).run(...values);
      if (tableName === "users" && userAssignmentPayload) {
        await syncUserSchoolAssignments(req.params.id, userAssignmentPayload);
        await syncUserDepartmentAssignments(req.params.id, userAssignmentPayload);
      }
      if (tableName === "bookings") {
        const updatedBooking = { ...existingItem, ...req.body, id: existingItem.id };
        const actor = { name: req.user?.name || null, role: req.user?.role || null };
        if (existingItem.room_id?.toString?.() !== updatedBooking.room_id?.toString?.()) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "room_assigned",
            title: updatedBooking.room_id ? "Room assigned" : "Room cleared",
            message: updatedBooking.room_id ? `${actor.name || "A user"} assigned a room to ${existingItem.event_name || "this request"}.` : `${actor.name || "A user"} cleared the assigned room from ${existingItem.event_name || "this request"}.`,
            roomIdFrom: existingItem.room_id ?? null,
            roomIdTo: updatedBooking.room_id ?? null,
            noteText: req.body.allocation_note || null
          });
        }
        if (existingItem.status !== updatedBooking.status) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "status_changed",
            title: `Status changed to ${updatedBooking.status}`,
            message: `${actor.name || "A user"} changed the status from ${existingItem.status || "Pending"} to ${updatedBooking.status || "Pending"}.`,
            statusFrom: existingItem.status ?? null,
            statusTo: updatedBooking.status ?? null,
            roomIdTo: updatedBooking.room_id ?? null,
            noteText: req.body.status_remark || null
          });
        } else if (req.body.status_remark && req.body.status_remark !== existingItem.status_remark) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "status_note_updated",
            title: "Decision remark updated",
            message: `${actor.name || "A user"} updated the decision remark.`,
            statusTo: updatedBooking.status ?? null,
            noteText: req.body.status_remark
          });
        } else if (req.body.allocation_note && req.body.allocation_note !== existingItem.allocation_note) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "allocation_note_updated",
            title: "Allocation note updated",
            message: `${actor.name || "A user"} updated the allocation note.`,
            roomIdTo: updatedBooking.room_id ?? null,
            noteText: req.body.allocation_note
          });
        }
        await syncTemporaryRoomAllocationForBooking(updatedBooking, actor);
      }
      if (tableName === "bookings" && req.body.status) {
        const title = req.body.status === "HOD Recommended" ? "Request recommended" : `Request ${req.body.status}`;
        const actor = req.user.name;
        const message = `${actor} updated ${existingItem.event_name || "a room request"} to ${req.body.status}.`;
        await createNotification(null, existingItem.faculty_name, title, message);
        if (req.body.status === "HOD Recommended") {
          await createNotification("Dean (P&M)", null, title, message);
          await createNotification("Deputy Dean (P&M)", null, title, message);
        }
        if (bookingDeanWorkflowStatuses.includes(req.body.status)) {
          await createNotification("Dean (P&M)", null, title, message);
          await createNotification("Deputy Dean (P&M)", null, title, message);
          const departmentName = await getBookingDepartmentName(existingItem);
          if (departmentName) {
            await createNotification("HOD", null, title, message, departmentName);
          }
        }
      }
      bustServerCache(tableName);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete(`/api/${tableName}/reset`, authenticate, async (req, res) => {
    if (tableName === "users" && !isAdminRole(req.user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can reset all users." });
    }
    if (tableName === "hod_room_allocations" && !canManageHodRoomAllocations(req.user?.role)) {
      return res.status(403).json({ error: "You do not have permission to reset HOD room allocations." });
    }
    try {
      if (tableName === "department_allocations") {
        const dependentCount = await db.prepare("SELECT COUNT(*) as total FROM batch_room_allocations").get();
        if ((Number(dependentCount?.total) || 0) > 0) {
          return res.status(400).json({ error: "Batch Room Allocations still depend on Department Allocations. Remove batch allocations first." });
        }
      }
      if (tableName === "hod_room_allocations") {
        const dependentCount = await db.prepare("SELECT COUNT(*) as total FROM department_allocations").get();
        if ((Number(dependentCount?.total) || 0) > 0) {
          return res.status(400).json({ error: "Department Room Mappings still depend on HOD Room Allocations. Remove department mappings first." });
        }
      }
      if (tableName === "users") {
        await db.prepare(`DELETE FROM user_school_assignments`).run();
        await db.prepare(`DELETE FROM user_department_assignments`).run();
      }
      await db.prepare(`DELETE FROM ${tableName}`).run();
      bustServerCache(tableName);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && !getUserManagementPolicy(req.user)) {
      return res.status(403).json({ error: "You do not have permission to remove users." });
    }
    if (tableName === "hod_room_allocations" && !canManageHodRoomAllocations(req.user?.role)) {
      return res.status(403).json({ error: "You do not have permission to remove HOD room allocations." });
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id);
      if (tableName === "users" && !await canActorManageExistingUser(req.user, existingItem)) {
        return res.status(403).json({ error: "You can remove only subordinate users allowed for your account." });
      }
      if (tableName === "users") {
        await db.prepare(`DELETE FROM user_school_assignments WHERE user_id = ?`).run(req.params.id);
        await db.prepare(`DELETE FROM user_department_assignments WHERE user_id = ?`).run(req.params.id);
      }
      if (tableName === "department_allocations" && existingItem) {
        const dependentBatchAllocations = await countDependentBatchRoomAllocations(
          existingItem.room_id,
          existingItem.department_id,
          existingItem.semester
        );
        if (dependentBatchAllocations > 0) {
          return res.status(400).json({ error: "This Department Allocation is still used by Batch Room Allocations. Remove or reassign those batch allocations first." });
        }
      }
      if (tableName === "hod_room_allocations" && existingItem) {
        const dependentMappings = await countDependentDepartmentRoomMappingsForHodAllocation(
          existingItem.room_id,
          existingItem.hod_user_id,
          existingItem.semester
        );
        if (dependentMappings > 0) {
          return res.status(400).json({ error: "This HOD Room Allocation is still used by Department Room Mapping. Remove or reassign those department mappings first." });
        }
      }
      await db.prepare(`DELETE FROM ${tableName} WHERE ${idField} = ?`).run(req.params.id);
      if (tableName === "bookings" && existingItem) {
        await syncTemporaryRoomAllocationForBooking({ ...existingItem, status: "Revoked", room_id: null }, { name: req.user?.name || null, role: req.user?.role || null });
        const actor = req.user.name;
        const title = "Room request deleted";
        const message = `${actor} deleted ${existingItem.event_name || "a room request"} for ${existingItem.date || "the selected date"}.`;
        await createBookingActivityLog(existingItem, { name: actor, role: req.user?.role || null }, {
          actionType: "deleted",
          title,
          message,
          statusFrom: existingItem.status ?? null,
          roomIdFrom: existingItem.room_id ?? null,
          noteText: existingItem.status_remark || existingItem.allocation_note || null
        });
        await createNotification(null, existingItem.faculty_name, title, message);
        await notifyBookingAuthorities(existingItem, title, message);
      }
      bustServerCache(tableName);
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
app.delete("/api/department_allocations/cleanup/odd", authenticate, async (_req, res) => {
  try {
    const allocations = await db.prepare(`
      SELECT id, room_id, department_id, semester
      FROM department_allocations
      ORDER BY id ASC
    `).all();
    const oddAllocations = allocations.filter((allocation) => normalizeSemesterKey(allocation?.semester) === "odd");
    if (oddAllocations.length === 0) {
      return res.json({ success: true, deletedCount: 0, skippedCount: 0, skipped: [] });
    }
    const skipped = [];
    let deletedCount = 0;
    for (const allocation of oddAllocations) {
      const dependentBatchAllocations = await countDependentBatchRoomAllocations(
        allocation.room_id,
        allocation.department_id,
        allocation.semester
      );
      if (dependentBatchAllocations > 0) {
        skipped.push({
          id: allocation.id,
          reason: "Batch Room Allocations still depend on this Odd semester mapping."
        });
        continue;
      }
      await db.prepare("DELETE FROM department_allocations WHERE id = ?").run(allocation.id);
      deletedCount += 1;
    }
    res.json({
      success: true,
      deletedCount,
      skippedCount: skipped.length,
      skipped
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
createCrudRoutes("users");
createCrudRoutes("campuses");
createCrudRoutes("buildings");
createCrudRoutes("blocks");
createCrudRoutes("floors");
app.get("/api/bookings/:id/activity", authenticate, async (req, res) => {
  try {
    await ensureBookingActivityTable();
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const items = booking.request_group_id ? await db.prepare(`
          SELECT * FROM booking_activity
          WHERE request_group_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.request_group_id) : await db.prepare(`
          SELECT * FROM booking_activity
          WHERE booking_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(req.params.id);
    res.json(items);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/bookings/:id/alternatives", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const canAccess = await canAccessBookingWorkflow(booking, req.user);
    if (!canAccess) {
      return res.status(403).json({ error: "You do not have access to these alternatives." });
    }
    const items = booking.request_group_id ? await db.prepare(`
          SELECT * FROM booking_alternatives
          WHERE request_group_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.request_group_id) : await db.prepare(`
          SELECT * FROM booking_alternatives
          WHERE booking_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.id);
    const canViewInternalDetails = isDecisionRole(req.user?.role || "");
    res.json(items.map((item) => sanitizeBookingAlternative(item, canViewInternalDetails)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/bookings/:id/alternatives", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const actor = req.user;
    if (!["Administrator", "Dean (P&M)", "Deputy Dean (P&M)"].includes(actor?.role)) {
      return res.status(403).json({ error: "Only Planning and Monitoring decision roles can suggest alternatives." });
    }
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    if (!isAdditionalRoomBooking(booking)) {
      return res.status(400).json({ error: "Alternatives are currently supported for additional-room requests only." });
    }
    const suggestionPayload = {
      suggestedDate: req.body.suggested_date?.toString().trim() || "",
      suggestedStartTime: req.body.suggested_start_time?.toString().trim() || "",
      suggestedEndTime: req.body.suggested_end_time?.toString().trim() || "",
      suggestedCapacity: parseInt(req.body.suggested_capacity, 10) || null,
      suggestedRoomType: req.body.suggested_room_type?.toString().trim() || "",
      suggestedBuilding: req.body.suggested_building?.toString().trim() || "",
      suggestedRoomCount: parseInt(req.body.suggested_room_count, 10) || null,
      suggestionNote: req.body.suggestion_note?.toString().trim() || "",
      internalCandidateRoomIds: Array.isArray(req.body.internal_candidate_room_ids) ? req.body.internal_candidate_room_ids.map((item) => item?.toString?.()).filter(Boolean) : []
    };
    const hasSuggestionContent = suggestionPayload.suggestedDate || suggestionPayload.suggestedStartTime || suggestionPayload.suggestedEndTime || suggestionPayload.suggestedCapacity || suggestionPayload.suggestedRoomType || suggestionPayload.suggestedBuilding || suggestionPayload.suggestedRoomCount || suggestionPayload.suggestionNote;
    if (!hasSuggestionContent) {
      return res.status(400).json({ error: "Add at least one alternative detail before sending it to the requester." });
    }
    const workflowItems = await getBookingWorkflowItems(booking);
    const alternativeBookingId = workflowItems[0]?.id || booking.id;
    const alternativeInfo = await db.prepare(`
      INSERT INTO booking_alternatives (
        booking_id,
        request_group_id,
        status,
        suggested_date,
        suggested_start_time,
        suggested_end_time,
        suggested_capacity,
        suggested_room_type,
        suggested_building,
        suggested_room_count,
        suggestion_note,
        internal_candidate_room_ids,
        created_by,
        created_role
      ) VALUES (?, ?, 'Pending Response', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      alternativeBookingId,
      booking.request_group_id ?? null,
      suggestionPayload.suggestedDate || null,
      suggestionPayload.suggestedStartTime || null,
      suggestionPayload.suggestedEndTime || null,
      suggestionPayload.suggestedCapacity,
      suggestionPayload.suggestedRoomType || null,
      suggestionPayload.suggestedBuilding || null,
      suggestionPayload.suggestedRoomCount,
      suggestionPayload.suggestionNote || null,
      suggestionPayload.internalCandidateRoomIds.length > 0 ? JSON.stringify(suggestionPayload.internalCandidateRoomIds) : null,
      actor.name || null,
      actor.role || null
    );
    for (const item of workflowItems) {
      await db.prepare(`
        UPDATE bookings
        SET status = ?, status_remark = ?, decided_by = ?
        WHERE id = ?
      `).run("Awaiting Alternative Response", suggestionPayload.suggestionNote || "Alternative shared for requester review.", actor.name || null, item.id);
    }
    await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
      actionType: "alternative_suggested",
      title: "Alternative shared",
      message: `${actor.name || "A planner"} shared an alternative arrangement with the requester.`,
      statusFrom: booking.status ?? null,
      statusTo: "Awaiting Alternative Response",
      noteText: suggestionPayload.suggestionNote || null
    });
    await createNotification(null, booking.faculty_name, "Alternative proposal shared", `${booking.event_name || "Your request"} has an alternative arrangement for your response.`);
    await notifyBookingAuthorities(booking, "Alternative proposal shared", `${actor.name || "A planner"} shared an alternative arrangement for ${booking.event_name || "this request"}.`);
    const createdAlternative = await db.prepare("SELECT * FROM booking_alternatives WHERE id = ?").get(alternativeInfo.lastInsertRowid);
    res.json(sanitizeBookingAlternative(createdAlternative, true));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/bookings/:id/alternatives/:alternativeId/respond", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const actor = req.user;
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    if (!isBookingRequester(booking, actor)) {
      return res.status(403).json({ error: "Only the requester can respond to this alternative." });
    }
    const alternative = await db.prepare("SELECT * FROM booking_alternatives WHERE id = ?").get(req.params.alternativeId);
    if (!alternative) {
      return res.status(404).json({ error: "Alternative not found." });
    }
    const workflowItems = await getBookingWorkflowItems(booking);
    const belongsToWorkflow = booking.request_group_id ? alternative.request_group_id === booking.request_group_id : Number(alternative.booking_id) === Number(booking.id);
    if (!belongsToWorkflow) {
      return res.status(400).json({ error: "This alternative does not belong to the selected request." });
    }
    if (alternative.status !== "Pending Response") {
      return res.status(400).json({ error: "This alternative already has a final response." });
    }
    const response = req.body.response?.toString().trim().toLowerCase();
    if (!["accept", "decline"].includes(response)) {
      return res.status(400).json({ error: "Response must be either accept or decline." });
    }
    const responseNote = req.body.response_note?.toString().trim() || "";
    const alternativeStatus = response === "accept" ? "Accepted" : "Declined";
    await db.prepare(`
      UPDATE booking_alternatives
      SET status = ?, response_note = ?, responded_by = ?, responded_role = ?, responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(alternativeStatus, responseNote || null, actor.name || null, actor.role || null, alternative.id);
    if (response === "accept") {
      for (const item of workflowItems) {
        const nextDate = alternative.suggested_date || item.date;
        const nextStartTime = alternative.suggested_start_time || item.start_time;
        if (nextDate && nextStartTime && isPastDateTime(nextDate, nextStartTime)) {
          return res.status(400).json({ error: "The accepted alternative is already in the past. Ask Planning and Monitoring to send a fresh option." });
        }
      }
      for (const item of workflowItems) {
        await db.prepare(`
          UPDATE bookings
          SET
            date = ?,
            start_time = ?,
            end_time = ?,
            required_capacity = ?,
            room_type = ?,
            preferred_building = ?,
            status = ?,
            status_remark = ?,
            decided_by = NULL
          WHERE id = ?
        `).run(
          alternative.suggested_date || item.date,
          alternative.suggested_start_time || item.start_time,
          alternative.suggested_end_time || item.end_time,
          alternative.suggested_capacity || item.required_capacity || item.student_count || null,
          alternative.suggested_room_type || item.room_type || null,
          alternative.suggested_building || item.preferred_building || null,
          "Pending",
          responseNote || "Requester accepted the suggested alternative.",
          item.id
        );
      }
      await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
        actionType: "alternative_accepted",
        title: "Alternative accepted",
        message: `${actor.name || "The requester"} accepted the suggested alternative.`,
        statusFrom: booking.status ?? null,
        statusTo: "Pending",
        noteText: responseNote || null
      });
      await notifyBookingAuthorities(booking, "Alternative accepted", `${actor.name || "The requester"} accepted an alternative for ${booking.event_name || "this request"}.`);
      await createNotification(null, booking.faculty_name, "Alternative accepted", `${booking.event_name || "Your request"} was updated with the accepted alternative and is back under review.`);
    } else {
      for (const item of workflowItems) {
        await db.prepare(`
          UPDATE bookings
          SET status = ?, status_remark = ?, decided_by = NULL
          WHERE id = ?
        `).run("No Room Available", responseNote || "Requester declined the suggested alternative.", item.id);
      }
      await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
        actionType: "alternative_declined",
        title: "Alternative declined",
        message: `${actor.name || "The requester"} declined the suggested alternative.`,
        statusFrom: booking.status ?? null,
        statusTo: "No Room Available",
        noteText: responseNote || null
      });
      await notifyBookingAuthorities(booking, "Alternative declined", `${actor.name || "The requester"} declined an alternative for ${booking.event_name || "this request"}.`);
      await createNotification(null, booking.faculty_name, "Alternative declined", `${booking.event_name || "Your request"} remains without a suitable room after declining the suggested option.`);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/bookings/:id/revise", authenticate, async (req, res) => {
  try {
    const actor = req.user;
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    if (!isBookingRequester(booking, actor)) {
      return res.status(403).json({ error: "Only the requester can revise this request." });
    }
    if (!bookingRequesterRevisionStatuses.includes(booking.status)) {
      return res.status(400).json({ error: "This request is not currently open for requester revision." });
    }
    const workflowItems = await getBookingWorkflowItems(booking);
    const revisedDate = req.body.date?.toString().trim() || "";
    const revisedStartTime = req.body.start_time?.toString().trim() || "";
    const revisedEndTime = req.body.end_time?.toString().trim() || "";
    if ((revisedDate || revisedStartTime) && !(revisedDate && revisedStartTime && revisedEndTime)) {
      return res.status(400).json({ error: "Date, start time, and end time must be revised together." });
    }
    if (revisedDate && revisedStartTime && isPastDateTime(revisedDate, revisedStartTime)) {
      return res.status(400).json({ error: "Revised request timings cannot be in the past." });
    }
    const revisedCapacity = req.body.required_capacity != null && req.body.required_capacity !== "" ? parseInt(req.body.required_capacity, 10) || 0 : null;
    if (revisedCapacity !== null && revisedCapacity <= 0) {
      return res.status(400).json({ error: "Required capacity must be greater than zero." });
    }
    const revisedNote = req.body.revision_note?.toString().trim() || req.body.notes?.toString().trim() || "";
    for (const item of workflowItems) {
      await db.prepare(`
        UPDATE bookings
        SET
          date = ?,
          start_time = ?,
          end_time = ?,
          required_capacity = ?,
          room_type = ?,
          preferred_building = ?,
          notes = ?,
          status = ?,
          status_remark = ?,
          decided_by = NULL,
          room_id = CASE WHEN request_type = 'Additional Room' THEN NULL ELSE room_id END
        WHERE id = ?
      `).run(
        revisedDate || item.date,
        revisedStartTime || item.start_time,
        revisedEndTime || item.end_time,
        revisedCapacity || item.required_capacity || item.student_count || null,
        req.body.room_type?.toString().trim() || item.room_type || null,
        req.body.preferred_building?.toString().trim() || item.preferred_building || null,
        req.body.notes?.toString().trim() || item.notes || null,
        "Pending",
        revisedNote || "Requester revised the requirements.",
        item.id
      );
    }
    await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
      actionType: "request_revised",
      title: "Requirements revised",
      message: `${actor.name || "The requester"} revised the room requirements.`,
      statusFrom: booking.status ?? null,
      statusTo: "Pending",
      noteText: revisedNote || null
    });
    await notifyBookingAuthorities(booking, "Request revised", `${actor.name || "The requester"} revised ${booking.event_name || "this request"} and sent it back for review.`);
    await createNotification(null, booking.faculty_name, "Request revised", `${booking.event_name || "Your request"} was updated and returned for review.`);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/temporary-room-allocations", authenticate, async (req, res) => {
  try {
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const actor = req.user;
    const requestedDepartmentId = req.query.departmentId?.toString() || req.query.department_id?.toString() || "";
    const requestedBookingId = req.query.bookingId?.toString() || req.query.booking_id?.toString() || "";
    let items = await db.prepare(`
      SELECT *
      FROM temporary_room_allocations
      ORDER BY approved_date DESC, start_time DESC, id DESC
    `).all();
    if (actor?.role === "HOD") {
      const accessibleDepartmentIds = getAccessibleDepartmentIdSet(actor);
      items = items.filter((item) => item?.temporary_department_id != null && accessibleDepartmentIds.has(item.temporary_department_id.toString()));
    }
    if (requestedDepartmentId) {
      items = items.filter((item) => idsEqual(item?.temporary_department_id, requestedDepartmentId) || idsEqual(item?.original_department_id, requestedDepartmentId));
    }
    if (requestedBookingId) {
      items = items.filter((item) => idsEqual(item?.booking_id, requestedBookingId));
    }
    res.json(items);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get(`/api/rooms`, authenticate, async (req, res) => {
  try {
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const scopedRoomIds = await getScopedMappedRoomIdsForUser(req.user);
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const activeSchedules = await getEffectiveSchedulesForDate(
      currentDate,
      (schedule) => schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const scheduledRoomIds = new Set(
      activeSchedules.map((s) => s.room_id?.toString()).filter(Boolean)
    );
    const bookedRoomIds = new Set(
      (await db.prepare(`
        SELECT DISTINCT room_id FROM bookings
        WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
      `).all(currentDate, currentTime, currentTime)).map((b) => b.room_id?.toString()).filter(Boolean)
    );
    const activeTemporaryAllocations = await db.prepare(`
      SELECT room_id
      FROM temporary_room_allocations
      WHERE approved_date = ? AND status IN ('Upcoming', 'Active') AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime);
    const temporaryAllocatedRoomIds = new Set(activeTemporaryAllocations.map((item) => item.room_id?.toString()).filter(Boolean));
    const floorId = req.query.floor_id?.toString() || "";
    const blockId = req.query.block_id?.toString() || "";
    const buildingId = req.query.building_id?.toString() || "";
    const campusId = req.query.campus_id?.toString() || "";
    let roomItems;
    if (floorId || blockId || buildingId || campusId) {
      const whereParts = [];
      const whereValues = [];
      if (floorId) {
        whereParts.push("r.floor_id = ?");
        whereValues.push(floorId);
      }
      if (blockId) {
        whereParts.push("bl.id = ?");
        whereValues.push(blockId);
      }
      if (buildingId) {
        whereParts.push("b.id = ?");
        whereValues.push(buildingId);
      }
      if (campusId) {
        whereParts.push("b.campus_id = ?");
        whereValues.push(campusId);
      }
      roomItems = await db.prepare(`
        SELECT r.* FROM rooms r
        LEFT JOIN floors f ON r.floor_id = f.id
        LEFT JOIN blocks bl ON f.block_id = bl.id
        LEFT JOIN buildings b ON bl.building_id = b.id
        WHERE ${whereParts.join(" AND ")}
      `).all(...whereValues);
    } else {
      roomItems = await db.prepare(`SELECT * FROM rooms`).all();
    }
    if (scopedRoomIds) {
      roomItems = roomItems.filter((room) => scopedRoomIds.has(room?.id?.toString?.() || ""));
    }
    const enrichedItems = roomItems.map((room) => {
      if (room.status !== "Available") return room;
      if (scheduledRoomIds.has(room.id?.toString())) return { ...room, status: "Occupied (Scheduled)" };
      if (bookedRoomIds.has(room.id?.toString())) return { ...room, status: "Occupied (Booked)" };
      if (temporaryAllocatedRoomIds.has(room.id?.toString())) return { ...room, status: "Occupied (Temporary Allocation)" };
      return room;
    });
    const requestedSearch = req.query.q?.toString().trim().toLowerCase() || "";
    const requestedSortKey = req.query.sortKey?.toString().trim() || "room_number";
    const requestedSortDir = normalizeImportMatchValue(req.query.sortDir) === "desc" ? "desc" : "asc";
    const requestedPage = Math.max(parseInt(req.query.page?.toString() || "1", 10) || 1, 1);
    const requestedPageSize = Math.min(Math.max(parseInt(req.query.pageSize?.toString() || "50", 10) || 50, 1), 200);
    const wantsPagination = req.query.paginate?.toString() === "1";
    const wantsServerQuery = wantsPagination || !!requestedSearch || !!req.query.sortKey?.toString().trim();
    const searchFields = (req.query.searchFields?.toString() || "").split(",").map((field) => field.trim()).filter(Boolean);
    let filteredItems = enrichedItems;
    if (requestedSearch) {
      const allowedSearchFields = searchFields.length > 0 ? searchFields : ["room_id", "room_number", "room_name", "room_type", "status", "usage_category", "lab_name", "room_aliases"];
      filteredItems = filteredItems.filter(
        (room) => allowedSearchFields.some(
          (field) => room?.[field] != null && room[field].toString().toLowerCase().includes(requestedSearch)
        )
      );
    }
    filteredItems.sort((left, right) => {
      const leftValue = left?.[requestedSortKey];
      const rightValue = right?.[requestedSortKey];
      const result = (leftValue ?? "").toString().localeCompare((rightValue ?? "").toString(), void 0, {
        numeric: true,
        sensitivity: "base"
      });
      return requestedSortDir === "desc" ? -result : result;
    });
    if (wantsServerQuery) {
      const total = filteredItems.length;
      const offset = (requestedPage - 1) * requestedPageSize;
      return res.json({
        items: filteredItems.slice(offset, offset + requestedPageSize),
        total,
        page: requestedPage,
        pageSize: requestedPageSize
      });
    }
    res.json(filteredItems);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get(`/api/rooms/:roomId/schedule`, authenticate, async (req, res) => {
  try {
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const { roomId } = req.params;
    const scopedRoomIds = await getScopedMappedRoomIdsForUser(req.user);
    if (scopedRoomIds && !scopedRoomIds.has(roomId?.toString?.() || "")) {
      return res.status(404).json({ error: "Room not found in your mapped scope." });
    }
    const { date } = req.query;
    const schedules = await getEffectiveSchedulesForDate(date, (schedule) => idsEqual(schedule.room_id, roomId));
    const bookings = await db.prepare(`SELECT * FROM bookings WHERE room_id = ? AND date = ? AND status = 'Approved'`).all(roomId, date);
    const temporaryAllocations = await db.prepare(`
        SELECT *
        FROM temporary_room_allocations
        WHERE room_id = ? AND approved_date = ?
        ORDER BY start_time ASC, id ASC
      `).all(roomId, date);
    res.json({ schedules, bookings, temporaryAllocations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
createCrudRoutes("rooms");
createCrudRoutes("schools");
createCrudRoutes("departments");
createCrudRoutes("department_allocations");
createCrudRoutes("hod_room_allocations");
createCrudRoutes("academic_calendars");
createCrudRoutes("timing_profiles");
createCrudRoutes("batch_room_allocations");
createCrudRoutes("equipment");
createCrudRoutes("schedules");
createCrudRoutes("bookings");
createCrudRoutes("maintenance");
app.get("/api/timetable-bundle", authenticate, async (req, res) => {
  try {
    await maybeSyncBatchAllocationStatuses();
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const getCached = async (name) => {
      const hit = getFromServerCache(name);
      if (hit) return hit;
      const rows = await db.prepare(`SELECT * FROM ${name}`).all();
      setInServerCache(name, rows);
      return rows;
    };
    const getSchedules = async () => {
      const hit = getFromServerCache("schedules");
      if (hit) return hit;
      const rows = await db.prepare("SELECT * FROM schedules").all();
      const hydrated = await backfillMissingScheduleCodes(rows);
      const deduped = deduplicateSchedules(hydrated).kept;
      setInServerCache("schedules", deduped);
      return deduped;
    };
    const [schedules, rooms, schools, departments, academic_calendars, timing_profiles, batch_room_allocations, department_allocations, hod_room_allocations, temporary_room_allocations] = await Promise.all([
      getSchedules(),
      getCached("rooms"),
      getCached("schools"),
      getCached("departments"),
      getCached("academic_calendars"),
      getCached("timing_profiles"),
      getCached("batch_room_allocations"),
      getCached("department_allocations"),
      getCached("hod_room_allocations"),
      db.prepare("SELECT * FROM temporary_room_allocations ORDER BY approved_date DESC, start_time DESC, id DESC").all()
    ]);
    res.json({ schedules, rooms, schools, departments, academic_calendars, timing_profiles, batch_room_allocations, department_allocations, hod_room_allocations, temporary_room_allocations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/dashboard/stats", authenticate, async (req, res) => {
  try {
    const totalBuildings = await db.prepare("SELECT COUNT(*) as count FROM buildings").get();
    const totalRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms").get();
    const maintenanceRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'Maintenance'").get();
    const equipmentIssues = await db.prepare("SELECT COUNT(*) as count FROM maintenance WHERE status = 'Pending'").get();
    const pendingBookings = await db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'Pending'").get();
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const daySchedules = await getEffectiveSchedulesForDate(currentDate);
    const activeSchedules = daySchedules.filter(
      (schedule) => schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const activeBookings = await db.prepare(`
      SELECT room_id FROM bookings 
      WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime);
    const activeScheduleRoomIds = new Set(
      activeSchedules.map((item) => item.room_id).filter(Boolean)
    );
    const dayScheduleRoomIds = new Set(
      daySchedules.map((item) => item.room_id).filter(Boolean)
    );
    const activeBookingRoomIds = new Set(
      activeBookings.map((item) => item.room_id).filter(Boolean)
    );
    const occupiedRoomIds = /* @__PURE__ */ new Set([
      ...activeScheduleRoomIds,
      ...activeBookingRoomIds
    ]);
    const availableNow = Math.max(0, totalRooms.count - maintenanceRooms.count - occupiedRoomIds.size);
    const recentAlerts = await db.prepare(`
      SELECT m.*, r.room_number, bld.name as building_name
      FROM maintenance m
      JOIN rooms r ON m.room_id = r.id
      LEFT JOIN floors f ON r.floor_id = f.id
      LEFT JOIN blocks b ON f.block_id = b.id
      LEFT JOIN buildings bld ON b.building_id = bld.id
      ORDER BY m.reported_date DESC
      LIMIT 5
    `).all();
    res.json({
      totalBuildings: totalBuildings.count,
      availableNow,
      equipmentIssues: equipmentIssues.count,
      pendingBookings: pendingBookings.count,
      // Scheduled rooms for the current day (stable metric), plus live-now subset.
      scheduledRooms: dayScheduleRoomIds.size,
      activeScheduledRooms: activeScheduleRoomIds.size,
      bookedRooms: activeBookingRoomIds.size,
      occupiedRooms: occupiedRoomIds.size,
      recentAlerts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/dashboard/overview", authenticate, async (_req, res) => {
  try {
    const totalBuildings = await db.prepare("SELECT COUNT(*) as count FROM buildings").get();
    const totalRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms").get();
    const maintenanceRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'Maintenance'").get();
    const equipmentIssues = await db.prepare("SELECT COUNT(*) as count FROM maintenance WHERE status = 'Pending'").get();
    const pendingBookings = await db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'Pending'").get();
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const daySchedules = await getEffectiveSchedulesForDate(currentDate);
    const activeSchedules = daySchedules.filter(
      (schedule) => schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const activeBookings = await db.prepare(`
      SELECT room_id, event_name, purpose, faculty_name, start_time, end_time FROM bookings
      WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime);
    const activeScheduleRoomIds = new Set(activeSchedules.map((item) => item.room_id).filter(Boolean));
    const dayScheduleRoomIds = new Set(daySchedules.map((item) => item.room_id).filter(Boolean));
    const activeBookingRoomIds = new Set(activeBookings.map((item) => item.room_id).filter(Boolean));
    const occupiedRoomIds = /* @__PURE__ */ new Set([...activeScheduleRoomIds, ...activeBookingRoomIds]);
    const availableNow = Math.max(0, totalRooms.count - maintenanceRooms.count - occupiedRoomIds.size);
    const recentAlerts = await db.prepare(`
      SELECT m.*, r.room_number, bld.name as building_name
      FROM maintenance m
      JOIN rooms r ON m.room_id = r.id
      LEFT JOIN floors f ON r.floor_id = f.id
      LEFT JOIN blocks b ON f.block_id = b.id
      LEFT JOIN buildings bld ON b.building_id = bld.id
      ORDER BY m.reported_date DESC
      LIMIT 5
    `).all();
    const rooms = await db.prepare(`
      SELECT r.id, r.room_number, r.room_type, r.parent_room_id, r.room_layout, r.room_name, r.usage_category, r.is_bookable,
             r.lab_name, r.restroom_type, r.capacity, r.status, f.id as floor_id, f.floor_number,
             bld.id as building_id, bld.name as building_name, b.id as block_id, b.name as block_name
      FROM rooms r
      LEFT JOIN floors f ON r.floor_id = f.id
      LEFT JOIN blocks b ON f.block_id = b.id
      LEFT JOIN buildings bld ON b.building_id = bld.id
    `).all();
    const schedules = await db.prepare("SELECT room_id, department_id, year_of_study, semester, section, start_time, end_time FROM schedules").all();
    const approvedBookings = await db.prepare("SELECT room_id, date, start_time, end_time FROM bookings WHERE status = 'Approved'").all();
    const allBookings = await db.prepare("SELECT room_id, status, date FROM bookings").all();
    const maintenance = await db.prepare("SELECT room_id, status FROM maintenance").all();
    const departments = await db.prepare("SELECT id, name, school_id FROM departments").all();
    const schools = await db.prepare("SELECT id, name FROM schools").all();
    const allocations = await db.prepare(`
      SELECT room_id, department_id, school_id, id
      FROM department_allocations
      ORDER BY id DESC
    `).all();
    const latestAllocationByRoom = /* @__PURE__ */ new Map();
    allocations.forEach((allocation) => {
      const roomKey = allocation.room_id?.toString();
      if (roomKey && !latestAllocationByRoom.has(roomKey)) {
        latestAllocationByRoom.set(roomKey, allocation);
      }
    });
    const calculateHours = (start, end) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(":").map(Number);
      const [h2, m2] = end.split(":").map(Number);
      return h2 + m2 / 60 - (h1 + m1 / 60);
    };
    const baseReports = rooms.map((room) => {
      const roomSchedules = schedules.filter((schedule) => idsEqual(schedule.room_id, room.id));
      const roomApprovedBookings = approvedBookings.filter((booking) => idsEqual(booking.room_id, room.id));
      const roomAllBookings = allBookings.filter((booking) => idsEqual(booking.room_id, room.id));
      const allocation = latestAllocationByRoom.get(room.id?.toString());
      const inferredDepartmentCounts = /* @__PURE__ */ new Map();
      [...roomSchedules, ...roomAllBookings].forEach((entry) => {
        if (!entry.department_id) return;
        inferredDepartmentCounts.set(entry.department_id, (inferredDepartmentCounts.get(entry.department_id) || 0) + 1);
      });
      const inferredDepartmentId = Array.from(inferredDepartmentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      const resolvedDepartmentId = allocation?.department_id || inferredDepartmentId || null;
      const department = departments.find((dept) => dept.id === resolvedDepartmentId);
      const school = schools.find((item) => item.id === (allocation?.school_id || department?.school_id || null));
      const maintenanceIssues = maintenance.filter((item) => idsEqual(item.room_id, room.id) && item.status !== "Completed").length;
      const scheduledHours = roomSchedules.reduce((acc, schedule) => acc + calculateHours(schedule.start_time, schedule.end_time), 0);
      const bookedHours = roomApprovedBookings.reduce((acc, booking) => acc + calculateHours(booking.start_time, booking.end_time), 0);
      const utilization = (scheduledHours + bookedHours) / 72 * 100;
      const yearTags = Array.from(new Set(roomSchedules.map((schedule) => {
        const normalizedYear = normalizeYearOfStudyKey(schedule?.year_of_study);
        if (normalizedYear) return normalizedYear;
        const semesterNumber = parseSemesterNumber(schedule?.semester);
        return semesterNumber ? Math.ceil(semesterNumber / 2).toString() : "";
      }).filter(Boolean)));
      const semesterTags = Array.from(new Set(roomSchedules.map((schedule) => normalizeSemesterKey(schedule?.semester)).filter(Boolean))).map((tag) => tag === "odd" ? "Odd" : tag === "even" ? "Even" : tag);
      const sectionTags = Array.from(new Set(roomSchedules.map((schedule) => schedule?.section?.toString().trim()).filter(Boolean)));
      return {
        room_id: room.id,
        room_number: room.room_number,
        building: room.building_name,
        block: room.block_name,
        department: department?.name || "Unmapped",
        school: school?.name || "Unmapped",
        room_type: room.room_type,
        status: room.status,
        utilization: Math.min(100, Math.round(utilization)),
        maintenanceIssues,
        bookingStatuses: Array.from(new Set(roomAllBookings.map((booking) => booking.status).filter(Boolean))),
        bookingDates: roomAllBookings.map((booking) => booking.date).filter(Boolean),
        approvedBookingDates: roomApprovedBookings.map((booking) => booking.date).filter(Boolean),
        yearTags,
        semesterTags,
        sectionTags
      };
    });
    const classifyRoomMix = (roomTypeValue) => {
      const roomType = normalizeRoomTypeValue(roomTypeValue);
      if ([
        "Classroom",
        "Smart Classroom",
        "Lecture Hall",
        "Tutorial Room",
        "Multipurpose Classroom",
        "Multipurpose Lecture Hall"
      ].includes(roomType)) return "classroom";
      if ([
        "Lab",
        "Computer Lab",
        "Research Lab",
        "Language Lab",
        "Workshop",
        "Studio",
        "Classroom Lab",
        "Multipurpose Lab"
      ].includes(roomType)) return "lab";
      return "";
    };
    const roomMix = baseReports.reduce((acc, room) => {
      const bucket = classifyRoomMix(room.room_type);
      if (bucket === "classroom") acc.classrooms += 1;
      if (bucket === "lab") acc.labs += 1;
      return acc;
    }, { classrooms: 0, labs: 0 });
    const schoolReports = Array.from(new Set(baseReports.map((report) => report.school).filter((s) => s && s !== "Unmapped"))).map((schoolName) => {
      const schoolRooms = baseReports.filter((report) => report.school === schoolName);
      const deptCount = new Set(
        schoolRooms.map((report) => report.department).filter((departmentName) => departmentName && departmentName !== "Unmapped")
      ).size;
      const avgUtilization = schoolRooms.reduce((acc, report) => acc + report.utilization, 0) / (schoolRooms.length || 1);
      const roomTypeAverage = (allowedTypes) => {
        const matchingRooms = schoolRooms.filter((report) => allowedTypes.includes(normalizeRoomTypeValue(report.room_type)));
        if (!matchingRooms.length) return 0;
        return Math.round(matchingRooms.reduce((sum, report) => sum + report.utilization, 0) / matchingRooms.length);
      };
      return {
        name: schoolName,
        avgUtilization: Math.round(avgUtilization),
        deptCount,
        roomCount: schoolRooms.length,
        classroomUtilization: roomTypeAverage(["Classroom", "Seminar Hall"]),
        labUtilization: roomTypeAverage(["Lab"])
      };
    }).sort((a, b) => b.avgUtilization - a.avgUtilization);
    const topBusyRooms = [...baseReports].filter((room) => Number(room.utilization) > 0).sort((a, b) => (Number(b.utilization) || 0) - (Number(a.utilization) || 0)).slice(0, 5).map((room) => ({
      room_id: room.room_id,
      room_number: room.room_number,
      building: room.building,
      block: room.block,
      utilization: room.utilization
    }));
    const lowestUsageRooms = [...baseReports].filter((room) => Number(room.utilization) >= 0).sort((a, b) => (Number(a.utilization) || 0) - (Number(b.utilization) || 0)).slice(0, 5).map((room) => ({
      room_id: room.room_id,
      room_number: room.room_number,
      building: room.building,
      block: room.block,
      utilization: room.utilization
    }));
    const utilizationTrend = [...baseReports].map((room) => ({ name: room.room_number, utilization: room.utilization })).sort((a, b) => (Number(b.utilization) || 0) - (Number(a.utilization) || 0)).slice(0, 10);
    const reportByRoomId = new Map(baseReports.map((report) => [report.room_id?.toString(), report]));
    const liveOperationalSnapshot = await getCurrentOperationalRoomSnapshot(currentDate, currentTime);
    const liveOperationalRoomById = new Map(
      (Array.isArray(liveOperationalSnapshot?.rooms) ? liveOperationalSnapshot.rooms : []).map((room) => [room.id?.toString() || "", room]).filter((entry) => !!entry[0])
    );
    const digitalTwinRoomRows = rooms.map((room) => {
      const roomKey = room.id?.toString() || "";
      const roomReport = reportByRoomId.get(roomKey);
      const roomSnapshot = liveOperationalRoomById.get(roomKey);
      return {
        id: room.id,
        roomNumber: room.room_number,
        roomType: normalizeRoomTypeValue(room.room_type) || room.room_type || "Room",
        capacity: parseInt(room.capacity, 10) || 0,
        buildingId: room.building_id,
        buildingName: room.building_name,
        blockName: room.block_name,
        floorId: room.floor_id,
        floorName: `Floor ${room.floor_number}`,
        status: roomSnapshot?.status || (isBookableAvailabilityRoom(room) ? "Available" : "Not Bookable"),
        isBookable: roomSnapshot?.availableForBooking ?? isBookableAvailabilityRoom(room),
        currentUsage: roomSnapshot?.currentUsage || "",
        nextAvailableSlot: roomSnapshot?.nextAvailableSlot || (isBookableAvailabilityRoom(room) ? "Available now" : "Not directly bookable"),
        departmentName: roomSnapshot?.departmentName || roomReport?.department || "Unmapped"
      };
    });
    const digitalTwinBuildings = Array.from(
      digitalTwinRoomRows.reduce((acc, room) => {
        const buildingKey = room.buildingId?.toString() || room.buildingName;
        if (!acc.has(buildingKey)) {
          acc.set(buildingKey, {
            buildingId: room.buildingId,
            buildingName: room.buildingName,
            floors: /* @__PURE__ */ new Map()
          });
        }
        const buildingEntry = acc.get(buildingKey);
        const floorKey = room.floorId?.toString() || room.floorName;
        if (!buildingEntry.floors.has(floorKey)) {
          buildingEntry.floors.set(floorKey, {
            floorId: room.floorId,
            floorName: room.floorName,
            rooms: []
          });
        }
        buildingEntry.floors.get(floorKey).rooms.push(room);
        return acc;
      }, /* @__PURE__ */ new Map())
    ).map(([, building]) => ({
      buildingId: building.buildingId,
      buildingName: building.buildingName,
      floors: Array.from(building.floors.values()).map((floor) => ({
        ...floor,
        rooms: floor.rooms.sort(
          (left, right) => (left.roomNumber || "").localeCompare(right.roomNumber || "", void 0, { numeric: true, sensitivity: "base" })
        )
      })).sort((left, right) => left.floorName.localeCompare(right.floorName, void 0, { numeric: true, sensitivity: "base" }))
    })).sort((left, right) => left.buildingName.localeCompare(right.buildingName, void 0, { sensitivity: "base" }));
    const digitalTwinStatusCounts = {
      available: digitalTwinRoomRows.filter((room) => room.status === "Available").length,
      occupied: digitalTwinRoomRows.filter((room) => room.status === "Occupied").length,
      maintenance: digitalTwinRoomRows.filter((room) => room.status === "Maintenance").length,
      eventBooked: digitalTwinRoomRows.filter((room) => room.status === "Event Booked").length,
      notBookable: digitalTwinRoomRows.filter((room) => room.status === "Not Bookable").length
    };
    const buildStatusBreakdown = (status) => {
      const counts = /* @__PURE__ */ new Map();
      digitalTwinRoomRows.filter((room) => room.status === status).forEach((room) => {
        const category = getDigitalTwinCategoryLabel(room, status);
        counts.set(category, (counts.get(category) || 0) + 1);
      });
      return Array.from(counts.entries()).map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, void 0, { sensitivity: "base" }));
    };
    const digitalTwinStatusBreakdowns = {
      available: buildStatusBreakdown("Available"),
      occupied: buildStatusBreakdown("Occupied"),
      maintenance: buildStatusBreakdown("Maintenance"),
      eventBooked: buildStatusBreakdown("Event Booked"),
      notBookable: buildStatusBreakdown("Not Bookable")
    };
    res.json({
      currentDate,
      currentTime,
      stats: {
        totalBuildings: totalBuildings.count,
        availableNow: digitalTwinStatusCounts.available,
        equipmentIssues: equipmentIssues.count,
        pendingBookings: pendingBookings.count,
        scheduledRooms: dayScheduleRoomIds.size,
        activeScheduledRooms: activeScheduleRoomIds.size,
        bookedRooms: activeBookingRoomIds.size,
        occupiedRooms: digitalTwinStatusCounts.occupied + digitalTwinStatusCounts.eventBooked,
        occupiedNow: digitalTwinStatusCounts.occupied,
        eventBookedNow: digitalTwinStatusCounts.eventBooked,
        notBookableRooms: digitalTwinStatusCounts.notBookable,
        recentAlerts,
        currentDate,
        currentTime
      },
      utilizationTrend,
      schoolReports,
      roomMix,
      topBusyRooms,
      lowestUsageRooms,
      digitalTwinSnapshot: {
        statusCounts: digitalTwinStatusCounts,
        statusBreakdowns: digitalTwinStatusBreakdowns,
        buildings: digitalTwinBuildings
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/rooms/vacant", authenticate, async (req, res) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  const { date, time, duration, members } = req.query;
  if (!date || !time || !duration) {
    return res.status(400).json({ error: "Date, time, and duration are required" });
  }
  const minimumCapacity = members !== void 0 ? parseInt(members, 10) : null;
  if (members !== void 0 && (!Number.isInteger(minimumCapacity) || minimumCapacity < 0)) {
    return res.status(400).json({ error: "Members must be a valid non-negative number." });
  }
  if (isPastDateTime(date, time)) {
    return res.status(400).json({ error: "Past search times are not allowed." });
  }
  const requestedStart = time;
  const [h, m] = requestedStart.split(":").map(Number);
  const durationMinutes = Math.round((parseFloat(duration) || 1) * 60);
  const endDate = /* @__PURE__ */ new Date();
  endDate.setHours(h, m || 0, 0, 0);
  endDate.setMinutes(endDate.getMinutes() + durationMinutes);
  const requestedEnd = `${endDate.getHours().toString().padStart(2, "0")}:${endDate.getMinutes().toString().padStart(2, "0")}`;
  const scopedRoomIds = await getScopedMappedRoomIdsForUser(req.user);
  const snapshot = await getSharedAvailabilitySnapshot({
    date,
    startTime: requestedStart,
    endTime: requestedEnd,
    minCapacity: minimumCapacity ?? 0,
    includeMaintenanceRooms: false,
    markRecommendedStatus: false,
    visibilityScope: "bookable",
    allowedRoomIds: scopedRoomIds
  });
  const vacantRooms = snapshot.rooms.filter((room) => room.availableForBooking).map((room) => room._sourceRoom);
  const busyTemporaryAllocations = await db.prepare(`
      SELECT room_id FROM temporary_room_allocations
      WHERE approved_date = ?
        AND status IN ('Upcoming', 'Active')
        AND NOT (end_time <= ? OR start_time >= ?)
    `).all(date, requestedStart, requestedEnd);
  const busyTemporaryRoomIds = new Set(busyTemporaryAllocations.map((item) => item.room_id?.toString()).filter(Boolean));
  res.json(vacantRooms.filter((room) => !busyTemporaryRoomIds.has(room?.id?.toString?.() || "")));
});
app.get("/api/live-availability", authenticate, async (req, res) => {
  const date = normalizeIsoDate(req.query.date);
  const startTime = req.query.startTime?.toString().trim() || "";
  const endTime = req.query.endTime?.toString().trim() || "";
  const campusId = req.query.campusId?.toString().trim() || "";
  const buildingId = req.query.buildingId?.toString().trim() || "";
  const blockId = req.query.blockId?.toString().trim() || "";
  const floorId = req.query.floorId?.toString().trim() || "";
  const departmentId = req.query.departmentId?.toString().trim() || "";
  const roomType = normalizeRoomTypeValue(req.query.roomType);
  const minCapacityRaw = req.query.minCapacity?.toString().trim() || "";
  const equipmentFilter = req.query.equipment?.toString().trim() || "";
  if (!date || !startTime || !endTime) {
    return res.status(400).json({ error: "Date, start time, and end time are required." });
  }
  if (isPastDateTime(date, startTime)) {
    return res.status(400).json({ error: "Past availability checks are not allowed." });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ error: "End time must be later than start time." });
  }
  const minCapacity = minCapacityRaw ? parseInt(minCapacityRaw, 10) : 0;
  if (minCapacityRaw && (!Number.isInteger(minCapacity) || minCapacity < 0)) {
    return res.status(400).json({ error: "Minimum capacity must be a valid non-negative number." });
  }
  try {
    const scopedRoomIds = await getScopedMappedRoomIdsForUser(req.user);
    const snapshot = await getSharedAvailabilitySnapshot({
      date,
      startTime,
      endTime,
      campusId,
      buildingId,
      blockId,
      floorId,
      departmentId,
      roomType,
      minCapacity,
      equipmentFilter,
      includeMaintenanceRooms: true,
      markRecommendedStatus: true,
      visibilityScope: "live",
      allowedRoomIds: scopedRoomIds
    });
    res.json({
      summary: snapshot.summary,
      recommendedRooms: snapshot.recommendedRooms.map((room) => {
        const { _sourceRoom, ...payload } = room;
        return payload;
      }),
      rooms: snapshot.rooms.map((room) => {
        const { _sourceRoom, ...payload } = room;
        return payload;
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/events/search-rooms", authenticate, async (req, res) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  const { date, startTime, endTime, strength } = req.query;
  if (!date || !startTime || !endTime || !strength) {
    return res.status(400).json({ error: "Date, start time, end time, and strength are required." });
  }
  if (isPastDateTime(date, startTime)) {
    return res.status(400).json({ error: "Past event searches are not allowed." });
  }
  if (startTime >= endTime) {
    return res.status(400).json({ error: "End time must be later than start time." });
  }
  const targetStrength = parseInt(strength, 10);
  if (!Number.isInteger(targetStrength) || targetStrength <= 0) {
    return res.status(400).json({ error: "Strength must be a valid positive number." });
  }
  try {
    const scopedRoomIds = await getScopedMappedRoomIdsForUser(req.user);
    const snapshot = await getSharedAvailabilitySnapshot({
      date,
      startTime,
      endTime,
      minCapacity: 0,
      includeMaintenanceRooms: false,
      markRecommendedStatus: false,
      visibilityScope: "bookable",
      allowedRoomIds: scopedRoomIds
    });
    const vacantRooms = snapshot.rooms.filter((room) => room.availableForBooking).map((room) => room._sourceRoom);
    const busyTemporaryAllocations = await db.prepare(`
        SELECT room_id FROM temporary_room_allocations
        WHERE approved_date = ?
          AND status IN ('Upcoming', 'Active')
          AND NOT (end_time <= ? OR start_time >= ?)
      `).all(date, startTime, endTime);
    const busyTemporaryRoomIds = new Set(busyTemporaryAllocations.map((item) => item.room_id?.toString()).filter(Boolean));
    const filteredVacantRooms = vacantRooms.filter((room) => !busyTemporaryRoomIds.has(room?.id?.toString?.() || ""));
    const singleOptions = filteredVacantRooms.filter((r) => r.capacity >= targetStrength).sort((a, b) => a.capacity - b.capacity);
    const multiOptions = [];
    if (singleOptions.length === 0) {
      const sortedVacant = [...filteredVacantRooms].sort((a, b) => b.capacity - a.capacity);
      let currentCapacity = 0;
      const combination = [];
      for (const r of sortedVacant) {
        combination.push(r);
        currentCapacity += r.capacity;
        if (currentCapacity >= targetStrength) break;
      }
      if (currentCapacity >= targetStrength) {
        multiOptions.push({
          rooms: combination,
          totalCapacity: currentCapacity,
          proximityScore: 100
        });
      }
    }
    res.json({ singleOptions, multiOptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/reports/utilization", authenticate, async (req, res) => {
  try {
    const getQueryValue = (key) => req.query?.[key]?.toString().trim() || "";
    const reportType = getQueryValue("reportType");
    const dateFrom = getQueryValue("dateFrom");
    const dateTo = getQueryValue("dateTo");
    const campusFilter = getQueryValue("campus");
    const buildingFilter = getQueryValue("building");
    const blockFilter = getQueryValue("block");
    const floorFilter = getQueryValue("floor");
    const departmentFilter = getQueryValue("department");
    const yearFilter = getQueryValue("year");
    const semesterFilter = getQueryValue("semester");
    const sectionFilter = getQueryValue("section");
    const roomFilter = getQueryValue("room");
    const roomTypeFilter = getQueryValue("roomType");
    const bookingStatusFilter = getQueryValue("bookingStatus");
    const flagFilter = getQueryValue("flag");
    const bookingStatusOptions = [
      "Pending",
      "HOD Recommended",
      "Awaiting Alternative Response",
      "Clarification Required",
      "Waitlisted",
      "No Room Available",
      "Approved",
      "Postponed",
      "Rejected"
    ];
    const shouldApplyBookingDateScope = Boolean(dateFrom || dateTo) && (reportType === "booking_approvals" || reportType === "booking_lifecycle" || !!bookingStatusFilter);
    const matchesFilterValue = (value, expected) => !expected || value?.toString().trim().toLowerCase() === expected.trim().toLowerCase();
    const dateMatches = (dates = []) => {
      if (!dateFrom && !dateTo) return true;
      return dates.some((date) => {
        if (!date) return false;
        if (dateFrom && date < dateFrom) return false;
        if (dateTo && date > dateTo) return false;
        return true;
      });
    };
    const rooms = await db.prepare(`
      SELECT r.*, pr.room_number as parent_room_number, bld.name as building_name, b.name as block_name, f.floor_number, c.name as campus_name
      FROM rooms r
      LEFT JOIN rooms pr ON r.parent_room_id = pr.id
      LEFT JOIN floors f ON r.floor_id = f.id
      LEFT JOIN blocks b ON f.block_id = b.id
      LEFT JOIN buildings bld ON b.building_id = bld.id
      LEFT JOIN campuses c ON bld.campus_id = c.id
    `).all();
    const schedules = await db.prepare("SELECT * FROM schedules").all();
    const bookings = await db.prepare("SELECT * FROM bookings WHERE status = 'Approved'").all();
    const allBookings = await db.prepare("SELECT * FROM bookings").all();
    const maintenance = await db.prepare("SELECT * FROM maintenance").all();
    const departments = await db.prepare("SELECT * FROM departments").all();
    const schools = await db.prepare("SELECT * FROM schools").all();
    const allocations = await db.prepare(`
      SELECT room_id, department_id, school_id, id
      FROM department_allocations
      ORDER BY id DESC
    `).all();
    const calculateHours = (start, end) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(":").map(Number);
      const [h2, m2] = end.split(":").map(Number);
      return h2 + m2 / 60 - (h1 + m1 / 60);
    };
    const latestAllocationByRoom = /* @__PURE__ */ new Map();
    allocations.forEach((allocation) => {
      const roomKey = allocation.room_id?.toString();
      if (roomKey && !latestAllocationByRoom.has(roomKey)) {
        latestAllocationByRoom.set(roomKey, allocation);
      }
    });
    const baseReports = rooms.map((room) => {
      const roomSchedules = schedules.filter((s) => idsEqual(s.room_id, room.id));
      const roomBookings = bookings.filter((b) => idsEqual(b.room_id, room.id));
      const allRoomBookings = allBookings.filter((b) => idsEqual(b.room_id, room.id));
      const allocation = latestAllocationByRoom.get(room.id?.toString());
      const inferredDepartmentCounts = /* @__PURE__ */ new Map();
      [...roomSchedules, ...allRoomBookings].forEach((entry) => {
        if (!entry.department_id) return;
        inferredDepartmentCounts.set(entry.department_id, (inferredDepartmentCounts.get(entry.department_id) || 0) + 1);
      });
      const inferredDepartmentId = Array.from(inferredDepartmentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      const resolvedDepartmentId = allocation?.department_id || inferredDepartmentId || null;
      const department = departments.find((dept) => dept.id === resolvedDepartmentId);
      const resolvedSchoolId = allocation?.school_id || department?.school_id || null;
      const school = schools.find((item) => item.id === resolvedSchoolId);
      const maintenanceIssues = maintenance.filter((item) => idsEqual(item.room_id, room.id) && item.status !== "Completed").length;
      const scheduledHours = roomSchedules.reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bookedHours = roomBookings.reduce((acc, b) => {
        const h = calculateHours(b.start_time, b.end_time);
        return acc + h;
      }, 0);
      const totalUsedHours = scheduledHours + bookedHours;
      const availableHours = 72;
      const utilization = totalUsedHours / availableHours * 100;
      const yearTags = Array.from(new Set(roomSchedules.map((schedule) => {
        const normalizedYear = normalizeYearOfStudyKey(schedule?.year_of_study);
        if (normalizedYear) return normalizedYear;
        const semesterNumber = parseSemesterNumber(schedule?.semester);
        return semesterNumber ? Math.ceil(semesterNumber / 2).toString() : "";
      }).filter(Boolean))).sort((a, b) => Number(a) - Number(b));
      const semesterTags = Array.from(new Set(roomSchedules.map((schedule) => normalizeSemesterKey(schedule?.semester)).filter(Boolean))).map((tag) => tag === "odd" ? "Odd" : tag === "even" ? "Even" : tag).sort((a, b) => a.localeCompare(b));
      const sectionTags = Array.from(new Set(roomSchedules.map((schedule) => schedule?.section?.toString().trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
      return {
        room_id: room.id,
        room_number: room.room_number,
        campus: room.campus_name,
        building: room.building_name,
        block: room.block_name,
        floor_number: room.floor_number,
        department_id: resolvedDepartmentId,
        department: department?.name || "Unmapped",
        school: school?.name || "Unmapped",
        room_type: room.room_type,
        room_name: room.room_name,
        parent_room_id: room.parent_room_id,
        parent_room_number: room.parent_room_number,
        room_layout: room.room_layout,
        sub_room_count: room.sub_room_count,
        room_section_name: room.room_section_name,
        usage_category: room.usage_category,
        is_bookable: room.is_bookable,
        lab_name: room.lab_name,
        restroom_type: room.restroom_type,
        capacity: room.capacity,
        status: room.status,
        maintenanceIssues,
        utilization: Math.min(100, Math.round(utilization)),
        totalUsedHours: Math.round(totalUsedHours * 10) / 10,
        scheduledHours: Math.round(scheduledHours * 10) / 10,
        bookedHours: Math.round(bookedHours * 10) / 10,
        bookingStatuses: Array.from(new Set(allRoomBookings.map((booking) => booking.status).filter(Boolean))),
        bookingDates: allRoomBookings.map((booking) => booking.date).filter(Boolean),
        approvedBookingDates: roomBookings.map((booking) => booking.date).filter(Boolean),
        scheduleCount: roomSchedules.length,
        yearTags,
        semesterTags,
        sectionTags,
        flags: [
          utilization < 20 ? "Underused" : null,
          utilization > 80 ? "Overused" : null,
          maintenanceIssues > 0 ? "Maintenance Risk" : null,
          !department ? "Department Unmapped" : null
        ].filter(Boolean)
      };
    });
    const filterOptions = {
      campuses: Array.from(new Set(baseReports.map((report) => report.campus).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      buildings: Array.from(new Set(baseReports.map((report) => report.building).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      blocks: Array.from(new Set(baseReports.map((report) => report.block).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      floors: Array.from(new Set(baseReports.map((report) => report.floor_number).filter((floor) => floor !== void 0 && floor !== null))).sort((a, b) => Number(a) - Number(b)),
      departments: Array.from(new Set([
        ...departments.map((department) => department?.name),
        ...baseReports.map((report) => report.department)
      ].filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      years: Array.from(new Set(baseReports.flatMap((report) => report.yearTags || []))).sort((a, b) => Number(a) - Number(b)),
      semesters: Array.from(new Set(baseReports.flatMap((report) => report.semesterTags || []))).sort((a, b) => a.localeCompare(b)),
      sections: Array.from(new Set(baseReports.flatMap((report) => report.sectionTags || []))).sort((a, b) => a.localeCompare(b)),
      rooms: Array.from(new Set(baseReports.map((report) => report.room_number?.toString().trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, void 0, { numeric: true, sensitivity: "base" })),
      roomTypes: Array.from(new Set(baseReports.map((report) => report.room_type).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      flags: Array.from(new Set(baseReports.flatMap((report) => report.flags || []).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    };
    const reports = baseReports.filter((report) => {
      const bookingDates = bookingStatusFilter === "Approved" ? report.approvedBookingDates : report.bookingDates;
      if (shouldApplyBookingDateScope && !dateMatches(bookingDates || [])) return false;
      if (!matchesFilterValue(report.campus, campusFilter)) return false;
      if (!matchesFilterValue(report.building, buildingFilter)) return false;
      if (!matchesFilterValue(report.block, blockFilter)) return false;
      if (floorFilter && report.floor_number?.toString() !== floorFilter) return false;
      if (!matchesFilterValue(report.department, departmentFilter)) return false;
      if (yearFilter && !(report.yearTags || []).includes(yearFilter)) return false;
      if (semesterFilter && !(report.semesterTags || []).includes(semesterFilter)) return false;
      if (sectionFilter && !(report.sectionTags || []).includes(sectionFilter)) return false;
      if (roomFilter && report.room_number?.toString().trim() !== roomFilter) return false;
      if (!matchesFilterValue(report.room_type, roomTypeFilter)) return false;
      if (bookingStatusFilter && !(report.bookingStatuses || []).includes(bookingStatusFilter)) return false;
      if (flagFilter && !(report.flags || []).includes(flagFilter)) return false;
      if (reportType === "underused" && !(report.flags || []).includes("Underused")) return false;
      if (reportType === "overused" && !(report.flags || []).includes("Overused")) return false;
      if (reportType === "maintenance_impact" && report.maintenanceIssues <= 0 && report.status !== "Maintenance") return false;
      if (reportType === "department_allocation" && report.department === "Unmapped") return false;
      if (reportType === "booking_approvals" && !(report.bookingStatuses || []).length) return false;
      return true;
    });
    const buildingReports = Array.from(new Set(reports.map((report) => report.building))).map((building) => {
      const buildingRooms = reports.filter((report) => report.building === building);
      const avgUtilization = buildingRooms.reduce((acc, report) => acc + report.utilization, 0) / (buildingRooms.length || 1);
      return {
        name: building,
        roomCount: buildingRooms.length,
        avgUtilization: Math.round(avgUtilization),
        maintenanceIssues: buildingRooms.reduce((acc, report) => acc + report.maintenanceIssues, 0)
      };
    });
    const filteredRoomIds = new Set(reports.map((report) => report.room_id?.toString()).filter(Boolean));
    const filteredAllBookings = allBookings.filter((booking) => {
      if (!filteredRoomIds.has(booking.room_id?.toString())) return false;
      const bookingDate = booking.date?.toString();
      if (dateFrom && (!bookingDate || bookingDate < dateFrom)) return false;
      if (dateTo && (!bookingDate || bookingDate > dateTo)) return false;
      return true;
    });
    const bookingStatusReports = bookingStatusOptions.map((status) => ({
      name: status,
      count: filteredAllBookings.filter((booking) => booking.status === status).length
    }));
    const deptReports = departments.map((dept) => {
      const deptRooms = reports.filter((r) => r.department_id === dept.id);
      const totalUtilization = deptRooms.reduce((acc, r) => acc + r.utilization, 0);
      const avgUtilization = deptRooms.length > 0 ? totalUtilization / deptRooms.length : 0;
      return {
        name: dept.name,
        school_id: dept.school_id,
        school: schools.find((school) => school.id === dept.school_id)?.name || "Unmapped",
        avgUtilization: Math.round(avgUtilization),
        roomCount: deptRooms.length
      };
    }).filter((report) => report.roomCount > 0);
    const schoolReports = Array.from(new Set(reports.map((report) => report.school).filter((s) => s && s !== "Unmapped"))).map((schoolName) => {
      const schoolRooms = reports.filter((report) => report.school === schoolName);
      const deptCount = new Set(
        schoolRooms.map((report) => report.department).filter((departmentName) => departmentName && departmentName !== "Unmapped")
      ).size;
      const totalUtilization = schoolRooms.reduce((acc, report) => acc + report.utilization, 0);
      const avgUtilization = schoolRooms.length > 0 ? totalUtilization / schoolRooms.length : 0;
      return {
        name: schoolName,
        avgUtilization: Math.round(avgUtilization),
        deptCount,
        roomCount: schoolRooms.length
      };
    }).sort((a, b) => b.avgUtilization - a.avgUtilization);
    res.json({ roomReports: reports, deptReports, schoolReports, buildingReports, bookingStatusReports, filterOptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/digital-twin/live-data", authenticate, async (_req, res) => {
  try {
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const [maintenance, schedules, bookings, equipment] = await Promise.all([
      db.prepare(`
        SELECT id, room_id, status
        FROM maintenance
        WHERE room_id IS NOT NULL
      `).all(),
      db.prepare(`
        SELECT
          id,
          room_id,
          department_id,
          program,
          specialization,
          section,
          course_code,
          course_name,
          faculty,
          day_of_week,
          start_time,
          end_time,
          year_of_study,
          semester
        FROM schedules
      `).all(),
      db.prepare(`
        SELECT
          id,
          room_id,
          department_id,
          date,
          start_time,
          end_time,
          status,
          event_name
        FROM bookings
      `).all(),
      db.prepare(`
        SELECT room_id, name
        FROM equipment
        WHERE room_id IS NOT NULL
      `).all()
    ]);
    const liveOperationalSnapshot = await getCurrentOperationalRoomSnapshot(currentDate, currentTime);
    res.json({
      currentDate,
      currentTime,
      maintenance: Array.isArray(maintenance) ? maintenance : [],
      schedules: Array.isArray(schedules) ? schedules : [],
      bookings: Array.isArray(bookings) ? bookings : [],
      equipment: Array.isArray(equipment) ? equipment : [],
      liveRooms: Array.isArray(liveOperationalSnapshot?.rooms) ? liveOperationalSnapshot.rooms : [],
      liveSummary: liveOperationalSnapshot?.summary || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/analytics/utilization-trends", authenticate, async (req, res) => {
  try {
    const rooms = await db.prepare("SELECT id, room_number FROM rooms").all();
    const schedules = await db.prepare("SELECT room_id, start_time, end_time FROM schedules").all();
    const bookings = await db.prepare("SELECT room_id, start_time, end_time FROM bookings WHERE status = 'Approved'").all();
    const calculateHours = (start, end) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(":").map(Number);
      const [h2, m2] = end.split(":").map(Number);
      return h2 + m2 / 60 - (h1 + m1 / 60);
    };
    const data = rooms.map((room) => {
      const sHours = schedules.filter((s) => idsEqual(s.room_id, room.id)).reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bHours = bookings.filter((b) => idsEqual(b.room_id, room.id)).reduce((acc, b) => acc + calculateHours(b.start_time, b.end_time), 0);
      const total = sHours + bHours;
      const utilization = Math.min(100, Math.round(total / 72 * 100));
      return { name: room.room_number, utilization };
    });
    res.json(data.sort((a, b) => b.utilization - a.utilization).slice(0, 10));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/analytics/booking-frequency", authenticate, async (req, res) => {
  try {
    const data = await db.prepare(`
      SELECT bld.name as name, COUNT(*) as count 
      FROM bookings bk
      JOIN rooms r ON bk.room_id = r.id
      JOIN floors f ON r.floor_id = f.id
      JOIN blocks b ON f.block_id = b.id
      JOIN buildings bld ON b.building_id = bld.id
      GROUP BY bld.name
    `).all();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
async function healInfrastructureHierarchy() {
  const campus = await db.prepare("SELECT * FROM campuses LIMIT 1").get();
  let defaultCampusId = campus?.id;
  if (!defaultCampusId) {
    const info = await db.prepare("INSERT INTO campuses (campus_id, name, location, description) VALUES (?, ?, ?, ?)").run("CAMPUS-1", "Default Campus", "Default Location", "Auto-healed campus");
    defaultCampusId = Number(info.lastInsertRowid);
  }
  const buildings = await db.prepare("SELECT * FROM buildings").all();
  for (const b of buildings) {
    const exists = await db.prepare("SELECT 1 FROM campuses WHERE id = ?").get(b.campus_id);
    if (!exists) {
      await db.prepare("UPDATE buildings SET campus_id = ? WHERE id = ?").run(defaultCampusId, b.id);
    }
  }
  const buildingCheck = await db.prepare("SELECT * FROM buildings LIMIT 1").get();
  let defaultBuildingId = buildingCheck?.id;
  if (!defaultBuildingId) {
    const info = await db.prepare("INSERT INTO buildings (building_id, campus_id, name, description) VALUES (?, ?, ?, ?)").run("BUILD-1", defaultCampusId, "Default Building", "Auto-healed building");
    defaultBuildingId = Number(info.lastInsertRowid);
  }
  const blocks = await db.prepare("SELECT * FROM blocks").all();
  for (const bl of blocks) {
    const exists = await db.prepare("SELECT 1 FROM buildings WHERE id = ?").get(bl.building_id);
    if (!exists) {
      await db.prepare("UPDATE blocks SET building_id = ? WHERE id = ?").run(defaultBuildingId, bl.id);
    }
  }
  const blockCheck = await db.prepare("SELECT * FROM blocks LIMIT 1").get();
  let defaultBlockId = blockCheck?.id;
  if (!defaultBlockId) {
    const info = await db.prepare("INSERT INTO blocks (block_id, building_id, name, description) VALUES (?, ?, ?, ?)").run("BLOCK-1", defaultBuildingId, "Default Block", "Auto-healed block");
    defaultBlockId = Number(info.lastInsertRowid);
  }
  const floors = await db.prepare("SELECT * FROM floors").all();
  for (const f of floors) {
    const exists = await db.prepare("SELECT 1 FROM blocks WHERE id = ?").get(f.block_id);
    if (!exists) {
      await db.prepare("UPDATE floors SET block_id = ? WHERE id = ?").run(defaultBlockId, f.id);
    }
  }
  const floorCheck = await db.prepare("SELECT * FROM floors LIMIT 1").get();
  let defaultFloorId = floorCheck?.id;
  if (!defaultFloorId) {
    const info = await db.prepare("INSERT INTO floors (floor_id, block_id, floor_number, description) VALUES (?, ?, ?, ?)").run("FLR-1", defaultBlockId, 1, "Auto-healed floor");
    defaultFloorId = Number(info.lastInsertRowid);
  }
  const rooms = await db.prepare("SELECT * FROM rooms").all();
  for (const r of rooms) {
    const exists = await db.prepare("SELECT 1 FROM floors WHERE id = ?").get(r.floor_id);
    if (!exists) {
      await db.prepare("UPDATE rooms SET floor_id = ? WHERE id = ?").run(defaultFloorId, r.id);
    }
  }
  const roomCheck = await db.prepare("SELECT * FROM rooms LIMIT 1").get();
  if (!roomCheck) {
    await db.prepare("INSERT INTO rooms (room_id, room_number, floor_id, room_type, capacity) VALUES (?, ?, ?, ?, ?)").run("ROOM-1", "101", defaultFloorId, "Lecture", 40);
  }
  return {
    status: "healed",
    campus: defaultCampusId,
    building: defaultBuildingId,
    block: defaultBlockId,
    floor: defaultFloorId
  };
}
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    database: db.dialect,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/health/heal", authenticate, async (req, res) => {
  try {
    const healed = await healInfrastructureHierarchy();
    res.json({ success: true, healed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path2.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path2.join(__dirname, "dist", "index.html"));
    });
  }
  const startPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3e3;
  let currentPort = isNaN(startPort) ? 3e3 : startPort;
  const launchServer = () => {
    const server = app.listen(currentPort, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${currentPort}`);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.warn(`Port ${currentPort} already in use. Trying ${currentPort + 1}...`);
        currentPort += 1;
        if (currentPort > 3100) {
          console.error("No free port available between 3000 and 3100. Exiting.");
          process.exit(1);
        }
        launchServer();
      } else {
        console.error("Server error:", err);
        process.exit(1);
      }
    });
  };
  launchServer();
}
var isDirectExecution = process.argv[1] ? path2.resolve(process.argv[1]) === __filename : false;
if (isDirectExecution) {
  startServer();
}
var server_default = app;
export {
  server_default as default,
  startServer
};
