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
var createPreparedStatement = (dialect, executor) => (sql) => ({
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
  const pool = new Pool({
    connectionString: options.databaseUrl,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
  });
  await pool.query("SELECT 1");
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
var databaseProvider = process.env.DATABASE_PROVIDER || "";
var databaseUrl = process.env.DATABASE_URL || "";
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
      department TEXT,
      designation TEXT,
      role TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      mobile_number TEXT,
      password TEXT NOT NULL,
      responsibilities TEXT,
      access_limits TEXT,
      access_paths TEXT,
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

    CREATE TABLE IF NOT EXISTS timing_profiles (
      id ${idDefinition},
      profile_id TEXT UNIQUE NOT NULL,
      profile_name TEXT NOT NULL,
      school_id INTEGER,
      department_id INTEGER,
      program TEXT,
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
      academic_year TEXT,
      year_of_study TEXT,
      semester TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      allocation_mode TEXT DEFAULT 'Shared',
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
      department_id INTEGER,
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
      recommended_by TEXT,
      decided_by TEXT,
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
  `;
};
if (process.env.DATABASE_RESET === "true" && (!databaseProvider || databaseProvider.trim().toLowerCase() === "sqlite") && !databaseUrl) {
  if (fs2.existsSync(databasePath)) {
    fs2.rmSync(databasePath);
    console.log(`DATABASE_RESET=true: deleted existing database at ${databasePath}`);
  }
}
var db = await createDatabaseClient({
  databasePath,
  databaseUrl,
  provider: databaseProvider
});
await db.exec(getPrimarySchemaSql(db.dialect));
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
await seedAdmin();
var ensureColumn = async (tableName, columnName, definition) => {
  await db.ensureColumn(tableName, columnName, definition);
};
var ensureBookingColumns = async () => {
  await ensureColumn("bookings", "purpose", "TEXT");
  await ensureColumn("bookings", "notes", "TEXT");
  await ensureColumn("bookings", "recommended_by", "TEXT");
  await ensureColumn("bookings", "decided_by", "TEXT");
  await ensureColumn("bookings", "request_group_id", "TEXT");
};
await ensureBookingColumns();
await ensureColumn("buildings", "structure_type", "TEXT DEFAULT 'direct'");
await ensureColumn("buildings", "planned_block_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "first_floor_number", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "first_floor_number", "INTEGER DEFAULT 0");
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
await ensureColumn("schedules", "semester", "TEXT");
await ensureColumn("schedules", "year_of_study", "TEXT");
await ensureColumn("schedules", "import_status", "TEXT");
await ensureColumn("schedules", "review_note", "TEXT");
await ensureColumn("schedules", "source_file", "TEXT");
await ensureColumn("users", "responsibilities", "TEXT");
await ensureColumn("users", "access_limits", "TEXT");
await ensureColumn("users", "access_paths", "TEXT");
await ensureColumn("users", "force_password_change", "INTEGER DEFAULT 0");
await ensureColumn("batch_room_allocations", "allocation_mode", "TEXT DEFAULT 'Shared'");
await ensureColumn("academic_calendars", "timing_profile_id", "INTEGER");
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
  "Multipurpose Classroom",
  "Classroom Lab",
  "Multipurpose Lab",
  "Lab",
  "Computer Lab",
  "Research Lab",
  "Language Lab"
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
var isReservableRoomRecord = (room) => {
  if (!room) return false;
  if (room.status && room.status !== "Available") return false;
  if (room.is_bookable === 0) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) return false;
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  return BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) || BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "");
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
    throw new Error("Capacity is required for classroom and lab room types.");
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
var getBookableRoomError = async (roomId) => {
  if (!roomId) return null;
  const room = await db.prepare("SELECT room_number, room_type, usage_category, is_bookable, status FROM rooms WHERE id = ?").get(roomId);
  if (!room) return "Please select a valid room.";
  if (room.is_bookable === 0) return `Room ${room.room_number} is marked as not bookable.`;
  if (room.status && room.status !== "Available") return `Room ${room.room_number} is not available.`;
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) {
    return `Room ${room.room_number} cannot be booked because ${roomType} is a non-bookable room type.`;
  }
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  if (!BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) && !BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "")) {
    return `Room ${room.room_number} cannot be booked because its room type or usage category is not bookable.`;
  }
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
  const timingProfile = timingProfileId ? await db.prepare("SELECT id, school_id, department_id FROM timing_profiles WHERE id = ?").get(timingProfileId) : null;
  if (timingProfileId && !timingProfile) {
    throw new Error("Please select a valid timing profile.");
  }
  if (timingProfile?.department_id && timingProfile.department_id.toString() !== department.id.toString()) {
    throw new Error("Selected timing profile does not belong to the selected department.");
  }
  if (timingProfile?.school_id && timingProfile.school_id.toString() !== department.school_id.toString()) {
    throw new Error("Selected timing profile does not belong to the selected school.");
  }
  nextPayload.department_id = department.id;
  nextPayload.school_id = department.school_id;
  nextPayload.program = nextPayload.program?.toString().trim() || null;
  nextPayload.batch = nextPayload.batch?.toString().trim() || null;
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
  const calendarId = nextPayload.academic_calendar_id ? Number(nextPayload.academic_calendar_id) : null;
  const linkedCalendar = calendarId ? await db.prepare(`
      SELECT id, school_id, department_id, program, batch, academic_year, year_of_study, semester, start_date, end_date
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
  nextPayload.academic_year = nextPayload.academic_year?.toString().trim() || linkedCalendar?.academic_year || null;
  nextPayload.year_of_study = nextPayload.year_of_study?.toString().trim() || linkedCalendar?.year_of_study || null;
  nextPayload.semester = nextPayload.semester?.toString().trim() || linkedCalendar?.semester || null;
  nextPayload.start_date = startDate;
  nextPayload.end_date = endDate;
  nextPayload.allocation_mode = ["exclusive", "shared"].includes((nextPayload.allocation_mode || "").toString().trim().toLowerCase()) ? (nextPayload.allocation_mode || "").toString().trim().toLowerCase() === "exclusive" ? "Exclusive" : "Shared" : "Shared";
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
  return nextPayload;
};
var getBatchAllocationOverlapError = async (allocation, excludeId) => {
  if (!allocation?.room_id || !allocation?.start_date || !allocation?.end_date) return null;
  const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(allocation.room_id);
  const existingAllocations = await db.prepare(`
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
  const calendarHasSpecificContext = Boolean(
    calendar?.program || calendar?.batch || calendar?.academic_year || calendar?.year_of_study
  );
  if (!calendarHasSpecificContext) return true;
  const relevantAllocations = activeBatchAllocations.filter((allocation) => {
    if (schedule?.room_id != null && allocation?.room_id != null && allocation.room_id.toString() !== schedule.room_id.toString()) return false;
    if (!allocation?.department_id || allocation.department_id.toString() !== schedule.department_id.toString()) return false;
    const allocationSemester = normalizeSemesterKey(allocation.semester);
    if (scheduleSemester && allocationSemester && allocationSemester !== scheduleSemester) return false;
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
    SELECT id, department_id, program, batch, academic_year, year_of_study, semester, event_type, title, start_date, end_date
    FROM academic_calendars
    WHERE start_date <= ? AND end_date >= ?
  `).all(normalizedDate, normalizedDate);
  const examinationCalendars = activeExamCalendars.filter(isExaminationCalendarEvent);
  if (examinationCalendars.length === 0) return schedules;
  const activeBatchAllocations = await db.prepare(`
    SELECT id, academic_calendar_id, room_id, department_id, program, batch, academic_year, year_of_study, semester, start_date, end_date, status
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
await ensureNotificationsTable();
await ensureNotificationReadsTable();
var createNotification = async (targetRole, targetName, title, message, targetDepartment = null) => {
  await ensureNotificationsTable();
  await db.prepare("INSERT INTO notifications (target_role, target_name, target_department, title, message) VALUES (?, ?, ?, ?, ?)").run(targetRole, targetName, targetDepartment, title, message);
};
var getDepartmentNameById = async (departmentId) => {
  if (!departmentId) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId);
  return department?.name || null;
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
  const normalizedRole = user?.role || null;
  const normalizedName = user?.name?.toString().trim().toLowerCase() || null;
  const normalizedDepartment = user?.department?.toString().trim().toLowerCase() || null;
  return { normalizedRole, normalizedName, normalizedDepartment };
};
var getNotificationsForUser = async (user, limit = 20) => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const { normalizedRole, normalizedName, normalizedDepartment } = getNotificationAudienceParams(user);
  return await db.prepare(`
    SELECT
      n.*,
      CASE WHEN nr.notification_id IS NULL THEN 0 ELSE 1 END as is_read
    FROM notifications n
    LEFT JOIN notification_reads nr
      ON nr.notification_id = n.id
      AND nr.user_id = ?
    WHERE (n.target_role IS NULL AND n.target_name IS NULL AND n.target_department IS NULL)
      OR (n.target_role = ? AND n.target_department IS NULL)
      OR LOWER(TRIM(COALESCE(n.target_name, ''))) = ?
      OR (n.target_role = ? AND LOWER(TRIM(COALESCE(n.target_department, ''))) = ?)
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ?
  `).all(user.id, normalizedRole, normalizedName, normalizedRole, normalizedDepartment, limit);
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
var getAuthCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax"
});
var authenticate = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
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
  const topSchool = (Array.isArray(schoolReports) ? schoolReports : []).filter((school) => school?.name).sort((a, b) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0))[0];
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
var normalizeExtractedRoomValue = (value) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const directMatch = raw.match(/(?:room|r)\s*\.?\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i) || raw.match(/\b([a-z]?\d{3,4}[a-z]?)\b/i);
  return directMatch?.[1]?.toUpperCase() || raw;
};
var mergeExtractedSchedulesWithHeaderRooms = (schedules, sectionRoomMaps) => {
  if (!Array.isArray(schedules) || schedules.length === 0) return [];
  const fallbackBySection = /* @__PURE__ */ new Map();
  for (const item of Array.isArray(sectionRoomMaps) ? sectionRoomMaps : []) {
    const section = normalizeExtractedSectionValue(item?.section);
    const room = normalizeExtractedRoomValue(item?.room);
    const semester = item?.semester || null;
    const department = item?.department || null;
    const year_of_study = normalizeYearOfStudyKey(item?.year_of_study || item?.year) || null;
    if (section && (room || semester || department || year_of_study) && !fallbackBySection.has(section)) {
      fallbackBySection.set(section, { room, semester, department, year_of_study });
    }
  }
  return schedules.map((schedule) => {
    const normalizedSection = normalizeExtractedSectionValue(schedule?.section);
    const explicitRoom = normalizeExtractedRoomValue(schedule?.room);
    const inheritedDefaults = normalizedSection ? fallbackBySection.get(normalizedSection) : null;
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
      semester: schedule?.semester || inheritedDefaults?.semester || null,
      year_of_study: scheduleYear || inheritedYear || derivedYearFromSemester || null,
      room: explicitRoom || inheritedRoom || schedule?.room || null
    };
  });
};
var getUserSessionPayload = (user) => ({
  id: user.id,
  email: user.email,
  role: user.role,
  name: user.full_name,
  department: user.department,
  designation: user.designation,
  responsibilities: user.responsibilities,
  access_limits: user.access_limits,
  access_paths: user.access_paths,
  force_password_change: !!user.force_password_change
});
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const sessionUser = getUserSessionPayload(user);
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
app.get("/api/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: decoded });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
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
  - year_of_study
  - semester
  - department
- schedules: array of objects with fields:
  - department (e.g., "Computer Science and Engineering")
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
For normal theory slots, use the section header Room No as the room.
Only use a different room when that specific slot explicitly overrides it with text like (R.No.610) or Room No: 610 inside the timetable grid.
Only extract actual class sessions.
Ignore labels and non-course cells such as "Reading Period", "Reading Periods", "Period", "Periods", "Break", "Lunch", "Tea Break", "Library", section titles, room headings, and plain time-slot labels.
The course_name must always be the real subject title.
If a slot has multiple subjects or is a lab, create separate entries if needed or one entry with combined info.

Example response:
{
  "sectionRoomMaps": [{"section":"A4","room":"331","year_of_study":"II","semester":"IV Semester","department":"Computer Science and Engineering"}],
  "schedules": [{"department":"Computer Science and Engineering","section":"A4","year_of_study":"II","semester":"IV Semester","course_code":"22ME101703M","course_name":"Management Science","faculty":"MOOC","room":"331","day_of_week":"Monday","start_time":"09:00","end_time":"09:55","student_count":null}]
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
  res.status(403).json({ error: "Password reset is handled by the Administrator." });
});
app.post("/api/auth/reset-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Administrator." });
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
    const sessionUser = getUserSessionPayload(user);
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
  academic_calendars: [
    { fields: ["calendar_id"], label: "Calendar ID" },
    { fields: ["department_id", "program", "batch", "year_of_study", "semester", "event_type", "title", "start_date", "end_date"], label: "Academic calendar period" }
  ],
  timing_profiles: [
    { fields: ["profile_id"], label: "Timing Profile ID" },
    { fields: ["department_id", "program", "academic_year", "year_of_study", "semester", "section", "slot_pattern"], label: "Timing profile context" }
  ],
  batch_room_allocations: [
    { fields: ["allocation_id"], label: "Allocation ID" },
    { fields: ["room_id", "department_id", "program", "batch", "year_of_study", "semester", "start_date", "end_date"], label: "Batch room allocation period" }
  ],
  equipment: [
    { fields: ["equipment_id"], label: "Equipment ID" },
    { fields: ["room_id", "name"], label: "Equipment name in this room" }
  ],
  schedules: [
    { fields: ["schedule_id"], label: "Schedule ID" },
    { fields: ["room_id", "section", "day_of_week", "start_time", "end_time"], label: "Schedule slot for this room and section" }
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
var NUMERIC_DUPLICATE_COMPARE_FIELDS = /* @__PURE__ */ new Set([
  "buildings.campus_id",
  "blocks.building_id",
  "floors.block_id",
  "departments.school_id",
  "department_allocations.school_id",
  "department_allocations.department_id",
  "department_allocations.room_id",
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
  const section = normalizeDuplicateValue(schedule?.section)?.toString() || "";
  const variants = [];
  if (schedule?.room_id !== void 0 && schedule?.room_id !== null && schedule.room_id !== "") {
    variants.push(`room|${schedule.room_id.toString()}|${section}|${day}|${start}|${end}`);
  }
  const normalizedRoomLabel = normalizeDuplicateValue(schedule?.room_label)?.toString() || "";
  if (normalizedRoomLabel) {
    variants.push(`label|${normalizedRoomLabel}|${section}|${day}|${start}|${end}`);
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
      SELECT id, schedule_id, room_id, room_label, section, day_of_week, start_time, end_time
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
      return "Schedule slot for this room already exists. Duplicate records are not allowed.";
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
await cleanupDuplicateSchedules();
await syncBatchAllocationStatuses();
var isPastDateTime = (date, time) => {
  const value = /* @__PURE__ */ new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) || value.getTime() < Date.now();
};
var getBookingDepartmentName = async (booking) => {
  if (!booking?.department_id) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(booking.department_id);
  return department?.name || null;
};
var isDecisionRole = (role) => ["Administrator", "Dean (P&M)", "Deputy Dean (P&M)"].includes(role);
var openBookingStatuses = ["Pending", "HOD Recommended", "Approved"];
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
  if (!booking?.faculty_name || !booking?.room_id || !booking?.date || !booking?.start_time || !booking?.end_time) return null;
  return await db.prepare(`
    SELECT id FROM bookings
    WHERE faculty_name = ?
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
await backfillNotificationsIfEmpty();
var createCrudRoutes = (tableName, idField = "id") => {
  app.get(`/api/${tableName}`, authenticate, async (req, res) => {
    try {
      if (tableName === "bookings") {
        const bookings = await db.prepare(`
          SELECT bk.*, r.room_number, d.name as department_name
          FROM bookings bk
          LEFT JOIN rooms r ON bk.room_id = r.id
          LEFT JOIN departments d ON bk.department_id = d.id
        `).all();
        const user = req.user;
        if (isDecisionRole(user.role)) return res.json(bookings);
        if (user.role === "HOD") {
          return res.json(bookings.filter(
            (booking) => booking.faculty_name === user.name || !!user.department && booking.department_name === user.department
          ));
        }
        return res.json(bookings.filter((booking) => booking.faculty_name === user.name));
      }
      if (tableName === "batch_room_allocations") {
        await syncBatchAllocationStatuses();
      }
      const items = await db.prepare(`SELECT * FROM ${tableName}`).all();
      if (tableName === "schedules") {
        const deduplicatedItems = deduplicateSchedules(items).kept;
        const requestedDate = normalizeIsoDate(req.query.date);
        if (requestedDate) {
          return res.json(await filterSchedulesByAcademicCalendar(deduplicatedItems, requestedDate));
        }
        return res.json(deduplicatedItems);
      }
      res.json(items);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post(`/api/${tableName}`, authenticate, async (req, res) => {
    if (tableName === "users" && req.user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can manage users and passwords." });
    }
    if (tableName === "users" && !req.body.password) {
      req.body.password = "Welcome123";
    }
    if (tableName === "users" && req.body.password) {
      req.body.force_password_change = 1;
    }
    if (tableName === "bookings") {
      await ensureBookingColumns();
      if (!req.body.status) {
        req.body.status = "Pending";
      }
    }
    try {
      if (tableName === "academic_calendars") {
        req.body = await normalizeAcademicCalendarPayload(req.body);
      }
      if (tableName === "timing_profiles") {
        req.body = await normalizeTimingProfilePayload(req.body);
      }
      if (tableName === "batch_room_allocations") {
        req.body = await normalizeBatchRoomAllocationPayload(req.body);
      }
      if (tableName === "rooms") {
        req.body = normalizeRoomPayload(req.body);
      }
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
      if (tableName === "batch_room_allocations") {
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const overlapError = await getBatchAllocationOverlapError(req.body);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }
      if (tableName === "schedules") {
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
      }
      if (tableName === "bookings") {
        if (!req.body.room_id || !req.body.date || !req.body.start_time || !req.body.end_time) {
          return res.status(400).json({ error: "Room, date, start time, and end time are required." });
        }
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        if (!req.body.department_id) {
          return res.status(400).json({ error: "Department is required so the request can go to the respective HOD." });
        }
        const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(req.body.department_id);
        if (!department) {
          return res.status(400).json({ error: "Please select a valid department." });
        }
        if (!["Pending", "Approved"].includes(req.body.status || "Pending")) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (req.body.status === "Approved" && !["Administrator", "Dean (P&M)"].includes(req.user.role)) {
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
      }
      const info = await db.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${placeholders})`).run(...values);
      if (tableName === "bookings") {
        const message = `${req.body.faculty_name} requested ${req.body.event_name || "a room"} on ${req.body.date} from ${req.body.start_time} to ${req.body.end_time}.`;
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
      }
      res.json({ id: info.lastInsertRowid, ...req.body });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.put(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && req.user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can manage users and passwords." });
    }
    if (tableName === "users" && !req.body.password) {
      delete req.body.password;
    }
    if (tableName === "users" && req.body.password) {
      req.body.force_password_change = 1;
    }
    if (tableName === "bookings") {
      await ensureBookingColumns();
    }
    if (tableName === "rooms") {
      req.body = normalizeRoomPayload(req.body);
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id);
      if (!existingItem) {
        return res.status(404).json({ error: `${tableName} record not found.` });
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
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextAllocation.room_id);
        if (!room) return res.status(400).json({ error: "Please select a valid room." });
        const bookableError = await getBookableRoomError(nextAllocation.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        if ((parseInt(nextAllocation.capacity, 10) || 0) > room.capacity) {
          return res.status(400).json({ error: `Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${nextAllocation.capacity}.` });
        }
        req.body.room_type = room.room_type;
      }
      if (tableName === "batch_room_allocations") {
        const nextAllocation = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextAllocation.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const overlapError = await getBatchAllocationOverlapError(nextAllocation, req.params.id);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }
      if (tableName === "schedules") {
        const nextSchedule = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextSchedule.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
      }
      if (tableName === "bookings") {
        const nextBooking = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextBooking.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        const requestedStatus = req.body.status;
        const role = req.user.role;
        const isRequester = existingItem.faculty_name === req.user.name;
        const departmentName = await getBookingDepartmentName(nextBooking);
        const isDepartmentHod = role === "HOD" && !!departmentName && departmentName === req.user.department;
        if (requestedStatus === "HOD Recommended") {
          if (!isDepartmentHod) {
            return res.status(403).json({ error: "Only the respective department HOD can recommend this room request." });
          }
          if (existingItem.status !== "Pending") {
            return res.status(400).json({ error: "Only pending requests can be recommended by HOD." });
          }
        }
        if (["Approved", "Rejected", "Postponed"].includes(requestedStatus)) {
          const deanCanDecide = ["Administrator", "Dean (P&M)"].includes(role);
          const deputyCanDecide = role === "Deputy Dean (P&M)" && existingItem.status === "HOD Recommended";
          const requesterCanCancel = requestedStatus === "Rejected" && isRequester;
          if (!deanCanDecide && !deputyCanDecide && !requesterCanCancel) {
            return res.status(403).json({ error: "Deputy Dean can decide only after HOD recommendation. Dean (P&M) can decide directly." });
          }
        }
        if (requestedStatus === "Pending" && !isRequester && !["Administrator", "Dean (P&M)"].includes(role)) {
          return res.status(403).json({ error: "Only the requester, Administrator, or Dean (P&M) can reopen this request." });
        }
        if (requestedStatus === "Pending" && !["Rejected", "Postponed"].includes(existingItem.status)) {
          return res.status(400).json({ error: "Only rejected or postponed requests can be reopened." });
        }
        if (requestedStatus === "HOD Recommended") {
          req.body.recommended_by = req.user.name;
        }
        if (["Approved", "Rejected", "Postponed"].includes(requestedStatus)) {
          req.body.decided_by = req.user.name;
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
      if (tableName === "bookings" && req.body.status) {
        const title = req.body.status === "HOD Recommended" ? "Request recommended" : `Request ${req.body.status}`;
        const actor = req.user.name;
        const message = `${actor} updated ${existingItem.event_name || "a room request"} to ${req.body.status}.`;
        await createNotification(null, existingItem.faculty_name, title, message);
        if (req.body.status === "HOD Recommended") {
          await createNotification("Dean (P&M)", null, title, message);
          await createNotification("Deputy Dean (P&M)", null, title, message);
        }
        if (["Approved", "Rejected", "Postponed"].includes(req.body.status)) {
          await createNotification("Dean (P&M)", null, title, message);
          await createNotification("Deputy Dean (P&M)", null, title, message);
          const departmentName = await getBookingDepartmentName(existingItem);
          if (departmentName) {
            await createNotification("HOD", null, title, message, departmentName);
          }
        }
      }
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete(`/api/${tableName}/reset`, authenticate, async (req, res) => {
    if (tableName === "users" && req.user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can remove users." });
    }
    try {
      await db.prepare(`DELETE FROM ${tableName}`).run();
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  app.delete(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && req.user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can remove users." });
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id);
      await db.prepare(`DELETE FROM ${tableName} WHERE ${idField} = ?`).run(req.params.id);
      if (tableName === "bookings" && existingItem) {
        const actor = req.user.name;
        const title = "Room request deleted";
        const message = `${actor} deleted ${existingItem.event_name || "a room request"} for ${existingItem.date || "the selected date"}.`;
        await createNotification(null, existingItem.faculty_name, title, message);
        await notifyBookingAuthorities(existingItem, title, message);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
};
createCrudRoutes("users");
createCrudRoutes("campuses");
createCrudRoutes("buildings");
createCrudRoutes("blocks");
createCrudRoutes("floors");
createCrudRoutes("rooms");
createCrudRoutes("schools");
createCrudRoutes("departments");
createCrudRoutes("department_allocations");
createCrudRoutes("academic_calendars");
createCrudRoutes("timing_profiles");
createCrudRoutes("batch_room_allocations");
createCrudRoutes("equipment");
createCrudRoutes("schedules");
createCrudRoutes("bookings");
createCrudRoutes("maintenance");
app.get(`/api/rooms`, authenticate, async (req, res) => {
  try {
    const items = await db.prepare(`SELECT * FROM rooms`).all();
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const activeSchedules = await getEffectiveSchedulesForDate(
      currentDate,
      (schedule) => schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const enrichedItems = [];
    for (const room of items) {
      if (room.status !== "Available") {
        enrichedItems.push(room);
        continue;
      }
      const schedule = activeSchedules.find((item) => idsEqual(item.room_id, room.id));
      if (schedule) {
        enrichedItems.push({ ...room, status: "Occupied (Scheduled)" });
        continue;
      }
      const booking = await db.prepare(`
          SELECT * FROM bookings 
          WHERE room_id = ? AND date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
        `).get(room.id, currentDate, currentTime, currentTime);
      if (booking) {
        enrichedItems.push({ ...room, status: "Occupied (Booked)" });
        continue;
      }
      enrichedItems.push(room);
    }
    res.json(enrichedItems);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get(`/api/rooms/:roomId/schedule`, authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { date } = req.query;
    const schedules = await getEffectiveSchedulesForDate(date, (schedule) => idsEqual(schedule.room_id, roomId));
    const bookings = await db.prepare(`SELECT * FROM bookings WHERE room_id = ? AND date = ? AND status = 'Approved'`).all(roomId, date);
    res.json({ schedules, bookings });
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
      JOIN floors f ON r.floor_id = f.id
      JOIN blocks b ON f.block_id = b.id
      JOIN buildings bld ON b.building_id = bld.id
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
app.get("/api/rooms/vacant", authenticate, async (req, res) => {
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
  const allRoomsRaw = await db.prepare("SELECT * FROM rooms WHERE status = 'Available' AND COALESCE(is_bookable, 1) != 0").all();
  const allRooms = allRoomsRaw.filter(
    (room) => isReservableRoomRecord(room) && (minimumCapacity === null || (parseInt(room.capacity, 10) || 0) >= minimumCapacity)
  );
  const busySchedules = await getEffectiveSchedulesForDate(
    date,
    (schedule) => !(schedule.end_time <= requestedStart || schedule.start_time >= requestedEnd)
  );
  const busyBookings = await db.prepare(`
    SELECT room_id FROM bookings 
    WHERE date = ? 
    AND status = 'Approved'
    AND NOT (end_time <= ? OR start_time >= ?)
  `).all(date, requestedStart, requestedEnd);
  const busyRoomIds = /* @__PURE__ */ new Set([
    ...busySchedules.map((s) => s.room_id),
    ...busyBookings.map((b) => b.room_id)
  ]);
  const vacantRooms = allRooms.filter((r) => !busyRoomIds.has(r.id));
  res.json(vacantRooms);
});
app.get("/api/events/search-rooms", authenticate, async (req, res) => {
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
    const allRoomsRaw = await db.prepare("SELECT * FROM rooms WHERE status = 'Available' AND COALESCE(is_bookable, 1) != 0").all();
    const allRooms = allRoomsRaw.filter(isReservableRoomRecord);
    const busyInSchedules = await getEffectiveSchedulesForDate(
      date,
      (schedule) => schedule.start_time < endTime && schedule.end_time > startTime || schedule.start_time < startTime && schedule.end_time > endTime || schedule.start_time >= startTime && schedule.start_time < endTime
    );
    const busyRoomIdsSchedules = new Set(busyInSchedules.map((s) => s.room_id));
    const busyInBookings = await db.prepare(`
      SELECT DISTINCT room_id FROM bookings 
      WHERE date = ? AND status = 'Approved'
      AND (
        (start_time < ? AND end_time > ?) OR
        (start_time < ? AND end_time > ?) OR
        (start_time >= ? AND start_time < ?)
      )
    `).all(date, endTime, startTime, startTime, endTime, startTime, endTime);
    const busyRoomIdsBookings = new Set(busyInBookings.map((b) => b.room_id));
    const vacantRooms = allRooms.filter((r) => !busyRoomIdsSchedules.has(r.id) && !busyRoomIdsBookings.has(r.id));
    const singleOptions = vacantRooms.filter((r) => r.capacity >= targetStrength).sort((a, b) => a.capacity - b.capacity);
    const multiOptions = [];
    if (singleOptions.length === 0) {
      const sortedVacant = [...vacantRooms].sort((a, b) => b.capacity - a.capacity);
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
    const rooms = await db.prepare(`
      SELECT r.*, pr.room_number as parent_room_number, bld.name as building_name, b.name as block_name, f.floor_number, c.name as campus_name
      FROM rooms r
      LEFT JOIN rooms pr ON r.parent_room_id = pr.id
      JOIN floors f ON r.floor_id = f.id
      JOIN blocks b ON f.block_id = b.id
      JOIN buildings bld ON b.building_id = bld.id
      JOIN campuses c ON bld.campus_id = c.id
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
    const reports = rooms.map((room) => {
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
    const bookingStatusReports = ["Pending", "HOD Recommended", "Approved", "Postponed", "Rejected"].map((status) => ({
      name: status,
      count: allBookings.filter((booking) => booking.status === status).length
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
    });
    const schoolReports = Array.from(new Set(reports.map((report) => report.school).filter(Boolean))).map((schoolName) => {
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
    res.json({ roomReports: reports, deptReports, schoolReports, buildingReports, bookingStatusReports });
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
