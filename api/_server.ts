import express from "express";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import * as mammoth from "mammoth";
import { createDatabaseClient, type DatabaseClient, type DatabaseDialect } from "./_db.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || "smart-campus-secret-key";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const isProduction = process.env.NODE_ENV === "production";
const isVercelRuntime = process.env.VERCEL === "1";
const defaultDatabasePath = isVercelRuntime
  ? path.join("/tmp", "campus.db")
  : path.join(process.cwd(), "campus.db");
const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : defaultDatabasePath;
const rawDatabaseProvider = process.env.DATABASE_PROVIDER || "";
const rawDatabaseUrl = process.env.DATABASE_URL || "";
// On Vercel, a localhost/127.0.0.1 DATABASE_URL can never connect. Fall back to SQLite.
const isLocalhostDatabaseUrl = /localhost|127\.0\.0\.1/.test(rawDatabaseUrl);
const databaseProvider = (isVercelRuntime && isLocalhostDatabaseUrl) ? "" : rawDatabaseProvider;
const databaseUrl = (isVercelRuntime && isLocalhostDatabaseUrl) ? "" : rawDatabaseUrl;
const APP_TIME_ZONE = process.env.APP_TIMEZONE || "Asia/Kolkata";
const normalizeOrigin = (value?: string | null) => {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};
const allowedOrigins = new Set(
  [
    process.env.FRONTEND_ORIGIN,
    process.env.APP_URL,
    "https://yethish2010.github.io",
    "http://localhost:5173",
    "http://localhost:3000",
  ]
    .map(normalizeOrigin)
    .filter(Boolean)
);

type ModuleLoadTelemetryRecord = {
  module: string;
  phase: string;
  durationMs: number;
  itemCount: number;
  createdAt: string;
  userRole?: string;
};

const moduleLoadTelemetry: ModuleLoadTelemetryRecord[] = [];
const MAX_MODULE_LOAD_TELEMETRY = 250;

const ADMIN_ROLE_VALUES = new Set(["Administrator", "Admin", "Master Admin"]);
const EXECUTIVE_VIEW_ROLE_VALUES = new Set(["Vice Chancellor", "Pro-Chancellor"]);
const GLOBAL_SCOPE_ROLE_VALUES = new Set([
  "Administrator",
  "Admin",
  "Master Admin",
  "Vice Chancellor",
  "Pro-Chancellor",
  "Dean (P&M)",
  "Deputy Dean (P&M)",
]);
const SCHOOL_SCOPE_ROLE_VALUES = new Set(["Dean"]);
const DEPARTMENT_SCOPE_ROLE_VALUES = new Set(["HOD", "Faculty", "Event Coordinator"]);

const isAdminRole = (role: any) => ADMIN_ROLE_VALUES.has(role?.toString().trim() || "");
const isExecutiveViewRole = (role: any) => EXECUTIVE_VIEW_ROLE_VALUES.has(role?.toString().trim() || "");
const normalizeUserAccessTypeValue = (value: any) => {
  const normalized = value?.toString().trim().toLowerCase() || "";
  if (!normalized) return "";
  if (normalized === "global") return "Global";
  if (normalized === "school") return "School";
  if (normalized === "department") return "Department";
  if (normalized === "custom") return "Custom";
  return value?.toString().trim() || "";
};

const getCampusDateTimeParts = (value: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const readPart = (type: string) => parts.find(part => part.type === type)?.value || "";
  return {
    date: `${readPart("year")}-${readPart("month")}-${readPart("day")}`,
    time: `${readPart("hour")}:${readPart("minute")}`,
  };
};

const getPrimarySchemaSql = (dialect: DatabaseDialect) => {
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
  `;
};

if (process.env.DATABASE_RESET === "true" && (!databaseProvider || databaseProvider.trim().toLowerCase() === "sqlite") && !databaseUrl) {
  if (fs.existsSync(databasePath)) {
    fs.rmSync(databasePath);
    console.log(`DATABASE_RESET=true: deleted existing database at ${databasePath}`);
  }
}

let db!: DatabaseClient;
let dbInitializationError: string | null = null;

const seedAdmin = async () => {
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
    provider: databaseProvider,
  });
  await db.exec(getPrimarySchemaSql(db.dialect));
  await seedAdmin();
} catch (err: any) {
  dbInitializationError = err?.message || "Database initialization failed";
  console.error("[Smart Campus] Database initialization failed:", dbInitializationError);
}

const ensureColumn = async (tableName: string, columnName: string, definition: string) => {
  await db.ensureColumn(tableName, columnName, definition);
};

const ensureBookingColumns = async () => {
  await ensureColumn("bookings", "purpose", "TEXT");
  await ensureColumn("bookings", "purpose_type", "TEXT DEFAULT 'Non-Academic'");
  await ensureColumn("bookings", "timing_override", "INTEGER DEFAULT 0");
  await ensureColumn("bookings", "notes", "TEXT");
  await ensureColumn("bookings", "recommended_by", "TEXT");
  await ensureColumn("bookings", "decided_by", "TEXT");
  await ensureColumn("bookings", "request_group_id", "TEXT");
};

let ensuredBookingColumnsPromise: Promise<void> | null = null;
const ensureBookingColumnsReady = async () => {
  if (!ensuredBookingColumnsPromise) {
    ensuredBookingColumnsPromise = ensureBookingColumns().catch(error => {
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
await ensureColumn("users", "force_password_change", "INTEGER DEFAULT 0");
await ensureColumn("batch_room_allocations", "allocation_mode", "TEXT DEFAULT 'Shared'");
await ensureColumn("batch_room_allocations", "allocation_pattern", "TEXT DEFAULT 'Single Room'");
await ensureColumn("batch_room_allocations", "split_group_id", "TEXT");
await ensureColumn("academic_calendars", "timing_profile_id", "INTEGER");
await ensureColumn("timing_profiles", "specialization", "TEXT");
await ensureColumn("academic_calendars", "specialization", "TEXT");
await ensureColumn("batch_room_allocations", "specialization", "TEXT");

const ROOM_TYPE_MATCH_ORDER = [
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
  "Workshop",
].sort((left, right) => right.toLowerCase().length - left.toLowerCase().length);

const normalizeRoomTypeValue = (value: any) => {
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
    return (
      normalized === normalizedOption ||
      normalized.startsWith(`${normalizedOption} -`) ||
      normalized.startsWith(`${normalizedOption}:`) ||
      normalized.startsWith(`${normalizedOption}/`)
    );
  });
  if (prefixedMatch) return prefixedMatch;
  return value?.toString().trim() || "";
};

const normalizeRestroomTypeValue = (value: any) => {
  const normalized = value?.toString().trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "male" || normalized === "boys" || normalized === "men") return "Male";
  if (normalized === "female" || normalized === "girls" || normalized === "women") return "Female";
  return value?.toString().trim() || "";
};

const normalizeRoomLayoutValue = (value: any) => {
  const normalized = value?.toString().trim().toLowerCase();
  if (!normalized) return "Normal";
  if (["split parent", "split room", "split"].includes(normalized)) return "Split Parent";
  if (["split child", "split section", "section"].includes(normalized)) return "Split Child";
  if (["inside parent", "room inside", "contains room", "room inside parent"].includes(normalized)) return "Inside Parent";
  if (["inside child", "inside room", "child room"].includes(normalized)) return "Inside Child";
  if (["shared", "shared room", "multi entrance room", "multi-entrance room", "multiple entrance room", "multiple door room", "multi door room", "multi-door room"].includes(normalized)) return "Shared Room";
  return ["Normal", "Shared Room", "Split Parent", "Split Child", "Inside Parent", "Inside Child"].find(option => option.toLowerCase() === normalized) || value?.toString().trim() || "Normal";
};

const HIERARCHY_PARENT_ROOM_LAYOUTS = ["Split Parent", "Inside Parent"];
const HIERARCHY_CHILD_ROOM_LAYOUTS = ["Split Child", "Inside Child"];
const HIERARCHY_ROOM_LAYOUTS = [...HIERARCHY_PARENT_ROOM_LAYOUTS, ...HIERARCHY_CHILD_ROOM_LAYOUTS];
const PRIVATE_ATTACHED_RESTROOM_PARENT_TYPES = new Set([
  "HOD Cabin",
  "Dean Office",
  "Faculty Room",
  "Staff Room",
]);

const normalizeUsageCategoryValue = (value: any, roomType?: any) => {
  const normalized = value?.toString().trim().toLowerCase();
  const options = ["Access", "Administration", "Dining", "Examination", "Healthcare", "Lab Work", "Meeting", "Multipurpose", "Office", "Restricted", "Restroom", "Security", "Sports", "Storage", "Teaching", "Utility"];
  if (normalized) {
    if (["exam", "exams", "examination", "examination section", "exam section", "examination cell", "exam cell"].includes(normalized)) return "Examination";
    return options.find(option => option.toLowerCase() === normalized) || value?.toString().trim() || null;
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

const normalizeBooleanLikeValue = (value: any, defaultValue = true) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;

  const normalized = value?.toString().trim().toLowerCase();
  if (["yes", "y", "true", "1", "bookable", "available"].includes(normalized)) return true;
  if (["no", "n", "false", "0", "not bookable", "internal only", "internal"].includes(normalized)) return false;
  return defaultValue;
};

const NON_CAPACITY_ROOM_TYPE_VALUES = [
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
  "Staircase",
];
const isNonCapacityRoomType = (roomType: any) =>
  NON_CAPACITY_ROOM_TYPE_VALUES.includes(normalizeRoomTypeValue(roomType));
const CAPACITY_ROOM_TYPE_VALUES = [
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
  "Gym",
];
const isCapacityRoomType = (roomType: any) =>
  CAPACITY_ROOM_TYPE_VALUES.includes(normalizeRoomTypeValue(roomType));
const BOOKABLE_ROOM_TYPE_VALUES = [
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
  "Gym",
];
const BOOKABLE_USAGE_CATEGORY_VALUES = ["Teaching", "Lab Work", "Multipurpose", "Meeting"];
const ROOM_ALIAS_PLACEHOLDER_VALUES = new Set(["-", "--", "---", "n/a", "na", "none", "null", "nil"]);
const normalizeRoomAliases = (value: any) => Array.from(new Set(
  value?.toString()
    .split(/[\n,;|/]+/)
    .map((alias: string) => alias.trim())
    .filter((alias: string) => alias.length > 0 && !ROOM_ALIAS_PLACEHOLDER_VALUES.has(normalizeDuplicateValue(alias))) || []
)).join(", ");

const getRoomAliasTokens = (value: any) =>
  normalizeRoomAliases(value)
    .split(",")
    .map((alias: string) => normalizeDuplicateValue(alias))
    .filter(Boolean);

const normalizeRoomLookupValue = (value: any) =>
  value?.toString().trim().toLowerCase().replace(/\s+/g, " ") || "";

const getRoomLookupVariants = (value: any) => {
  const base = normalizeRoomLookupValue(value);
  if (!base) return [] as string[];

  const variants = new Set<string>([base]);
  const withoutPrefix = base
    .replace(/\b(?:room|r)\s*\.?\s*(?:no|number)?\.?\s*[:\-]?\s*/g, "")
    .trim();

  if (withoutPrefix) {
    variants.add(withoutPrefix);
  }

  const normalizedSeparators = withoutPrefix
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();

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

const getAvailabilityRoomLookupVariants = (room: any) => {
  const variants = new Set<string>();
  [
    room?.room_id,
    room?.room_number,
    room?.room_name,
    room?.lab_name,
    room?.room_section_name,
    ...(getRoomAliasTokens(room?.room_aliases) || []),
  ].forEach((value: any) => {
    getRoomLookupVariants(value).forEach((variant) => variants.add(variant));
  });
  return variants;
};

const buildRoomLookupVariantMaps = (rooms: any[]) => {
  const roomLookupVariantsById = new Map<string, Set<string>>();
  const roomIdsByLookupVariant = new Map<string, Set<string>>();

  (Array.isArray(rooms) ? rooms : []).forEach((room: any) => {
    const roomKey = room?.id?.toString?.() || "";
    if (!roomKey) return;

    const variants = new Set(getAvailabilityRoomLookupVariants(room));
    roomLookupVariantsById.set(roomKey, variants);
    variants.forEach((variant) => {
      if (!roomIdsByLookupVariant.has(variant)) {
        roomIdsByLookupVariant.set(variant, new Set<string>());
      }
      roomIdsByLookupVariant.get(variant)?.add(roomKey);
    });
  });

  return { roomLookupVariantsById, roomIdsByLookupVariant };
};

const getResolvedScheduleRoomIds = (
  schedule: any,
  roomIdsByLookupVariant: Map<string, Set<string>>,
) => {
  const resolvedRoomIds = new Set<string>();
  const directRoomId = schedule?.room_id?.toString?.() || "";
  if (directRoomId) {
    resolvedRoomIds.add(directRoomId);
  }

  getRoomLookupVariants(schedule?.room_label).forEach((variant) => {
    roomIdsByLookupVariant.get(variant)?.forEach((roomId) => resolvedRoomIds.add(roomId));
  });

  return resolvedRoomIds;
};

const isReservableRoomRecord = (room: any) => {
  if (!room) return false;
  if (room.status && room.status !== "Available") return false;
  if (room.is_bookable === 0) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) return false;
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  return BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) || BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "");
};

const normalizeRoomPayload = (payload: any) => {
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

const validateRoomHierarchy = async (room: any, excludeId?: string | number) => {
  if (!room?.parent_room_id) return null;

  if (excludeId && room.parent_room_id?.toString() === excludeId.toString()) {
    return "A room cannot be inside itself.";
  }

  const parentRoom = await db.prepare("SELECT id, floor_id FROM rooms WHERE id = ?").get(room.parent_room_id) as any;
  if (!parentRoom) return "Please select a valid parent room.";
  if (parentRoom.floor_id?.toString() !== room.floor_id?.toString()) {
    return "The parent room must be on the same floor.";
  }

  return null;
};

const findRecordById = (records: any[], id: any) => {
  if (id == null || id === "") return null;
  return (Array.isArray(records) ? records : []).find(record => idsEqual(record?.id, id)) || null;
};

const getBookableRoomError = async (roomId: any, context?: BulkImportContext) => {
  if (!roomId) return null;
  const cacheKey = roomId.toString();
  if (context?.roomBookableErrorByRoomId.has(cacheKey)) {
    return context.roomBookableErrorByRoomId.get(cacheKey) || null;
  }
  let room = context?.roomById.get(cacheKey) || null;
  if (!room) {
    room = await db.prepare("SELECT id, room_number, room_type, usage_category, is_bookable, status FROM rooms WHERE id = ?").get(roomId) as any;
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

const allowsBlankAttachedRestroomType = async (room: any) => {
  if (normalizeRoomTypeValue(room?.room_type) !== "Restroom") return false;
  if (!HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room?.room_layout))) return false;
  if (!room?.parent_room_id) return false;

  const parentRoom = await db.prepare("SELECT room_type FROM rooms WHERE id = ?").get(room.parent_room_id) as any;
  return PRIVATE_ATTACHED_RESTROOM_PARENT_TYPES.has(normalizeRoomTypeValue(parentRoom?.room_type));
};

const getRestroomValidationError = async (room: any) => {
  if (normalizeRoomTypeValue(room?.room_type) !== "Restroom") return null;
  if (["Male", "Female"].includes(room?.restroom_type || "")) return null;
  if (await allowsBlankAttachedRestroomType(room)) return null;
  return "Please choose Male or Female for the restroom.";
};

const getCurrentIndiaDate = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const normalizeIsoDate = (value: any) => {
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
    if (
      !Number.isNaN(parsedDayFirst.getTime()) &&
      parsedDayFirst.getUTCFullYear().toString() === year &&
      (parsedDayFirst.getUTCMonth() + 1).toString().padStart(2, "0") === month &&
      parsedDayFirst.getUTCDate().toString().padStart(2, "0") === day
    ) {
      return isoValue;
    }
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
};

const deriveAcademicCalendarStatus = (startDate: string, endDate: string) => {
  const today = getCurrentIndiaDate();
  if (endDate && endDate < today) return "Completed";
  if (startDate && startDate > today) return "Upcoming";
  return "Active";
};

const deriveBatchAllocationStatus = (startDate: string, endDate: string, requestedStatus?: string | null) => {
  const normalizedRequested = requestedStatus?.toString().trim().toLowerCase() || "";
  if (normalizedRequested === "released") return "Released";
  const today = getCurrentIndiaDate();
  if (endDate && endDate < today) return "Released";
  if (startDate && startDate > today) return "Planned";
  return "Active";
};

const normalizeTimingProfileWorkingDays = (value: any) => {
  const normalized = value?.toString().trim() || "";
  return normalized || "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday";
};

const normalizeTimingProfileSlotPattern = (value: any) => {
  const normalized = value?.toString().trim().replace(/\s+/g, " ") || "";
  return normalized;
};

const parseTimingProfileSlots = (value: any) => {
  const slotText = value?.toString().trim() || "";
  if (!slotText) return [] as Array<{ start_time: string; end_time: string }>;
  const slots = slotText
    .split(/[\n,;]+/)
    .map((part: string) => part.trim())
    .filter(Boolean)
    .map((part: string) => {
      const match = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!match) return null;
      const start = match[1].padStart(5, "0");
      const end = match[2].padStart(5, "0");
      if (start >= end) return null;
      return { start_time: start, end_time: end };
    })
    .filter((slot): slot is { start_time: string; end_time: string } => Boolean(slot))
    .sort((left, right) => left.start_time.localeCompare(right.start_time) || left.end_time.localeCompare(right.end_time));

  return Array.from(
    new Map<string, { start_time: string; end_time: string }>(
      slots.map(slot => [`${slot.start_time}-${slot.end_time}`, slot] as [string, { start_time: string; end_time: string }])
    ).values()
  );
};

const buildTimingProfileSlotWindows = (slots: Array<{ start_time: string; end_time: string }>) => {
  const windows: Array<{ start_time: string; end_time: string; slot_count: number }> = [];
  for (let startIndex = 0; startIndex < slots.length; startIndex += 1) {
    let currentEnd = slots[startIndex].end_time;
    windows.push({
      start_time: slots[startIndex].start_time,
      end_time: currentEnd,
      slot_count: 1,
    });
    for (let endIndex = startIndex + 1; endIndex < slots.length; endIndex += 1) {
      if (slots[endIndex - 1].end_time !== slots[endIndex].start_time) break;
      currentEnd = slots[endIndex].end_time;
      windows.push({
        start_time: slots[startIndex].start_time,
        end_time: currentEnd,
        slot_count: endIndex - startIndex + 1,
      });
    }
  }
  return windows;
};

const normalizeBookingPurposeType = (value: any) => {
  const normalized = value?.toString().trim() || "";
  if (!normalized) return "Non-Academic";
  if (["Academic", "Academic Regular", "Academic-Regular"].includes(normalized)) return "Academic Regular";
  if (["Academic Adjustment", "Academic-Adjustment", "Academic Adjustment / Override"].includes(normalized)) return "Academic Adjustment";
  if (["Non Academic", "Non-Academic", "Event", "Meeting"].includes(normalized)) return "Non-Academic";
  return normalized;
};

const resolveBookingTimingProfile = async (booking: any) => {
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
  `).get(booking.department_id, booking.date, booking.date) as any;

  const directProfile = linkedCalendar?.timing_profile_id
    ? await db.prepare("SELECT * FROM timing_profiles WHERE id = ?").get(linkedCalendar.timing_profile_id) as any
    : null;
  if (directProfile) return directProfile;

  return await db.prepare(`
    SELECT *
    FROM timing_profiles
    WHERE department_id = ?
    ORDER BY
      CASE WHEN specialization IS NOT NULL AND LOWER(TRIM(specialization)) = LOWER(TRIM(?)) THEN 0 ELSE 1 END,
      id DESC
    LIMIT 1
  `).get(booking.department_id, booking.specialization || "") as any;
};

const getBookingTimingPolicyDetails = async (booking: any) => {
  const purposeType = normalizeBookingPurposeType(booking?.purpose_type);
  const timingProfile = await resolveBookingTimingProfile(booking);
  const slots = parseTimingProfileSlots(timingProfile?.slot_pattern);
  const slotWindows = buildTimingProfileSlotWindows(slots);
  const matchesWindow = slotWindows.some(window => window.start_time === booking?.start_time && window.end_time === booking?.end_time);
  const timingOverride = purposeType !== "Academic Regular" && slots.length > 0 && !matchesWindow ? 1 : 0;
  return { purposeType, timingProfile, slots, slotWindows, matchesWindow, timingOverride };
};

const normalizeTimingProfilePayload = async (payload: any) => {
  const nextPayload = { ...payload };
  const departmentId = nextPayload.department_id ? Number(nextPayload.department_id) : null;
  const schoolId = nextPayload.school_id ? Number(nextPayload.school_id) : null;

  const department = departmentId
    ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) as any
    : null;

  if (departmentId && !department) {
    throw new Error("Please select a valid department.");
  }

  if (schoolId) {
    const school = await db.prepare("SELECT id FROM schools WHERE id = ?").get(schoolId) as any;
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

const normalizeAcademicCalendarPayload = async (payload: any) => {
  const nextPayload = { ...payload };
  const departmentId = nextPayload.department_id ? Number(nextPayload.department_id) : null;
  const department = departmentId
    ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) as any
    : null;

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
  const timingProfile = timingProfileId
    ? await db.prepare("SELECT id, school_id, department_id, specialization FROM timing_profiles WHERE id = ?").get(timingProfileId) as any
    : null;
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

const normalizeBatchRoomAllocationPayload = async (payload: any) => {
  const nextPayload = { ...payload };
  const buildSplitAllocationGroupId = (value: any) => {
    const slugify = (input: unknown) => input?.toString().trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "";
    const parts = [
      slugify(value?.department_id),
      slugify(value?.program),
      slugify(value?.batch),
      slugify(value?.specialization),
      slugify(value?.year_of_study),
      slugify(value?.semester),
      slugify(value?.start_date),
      slugify(value?.end_date),
    ].filter(Boolean);
    return parts.length ? `SPLIT-${parts.join("-")}` : null;
  };
  const calendarId = nextPayload.academic_calendar_id ? Number(nextPayload.academic_calendar_id) : null;
  const linkedCalendar = calendarId
    ? await db.prepare(`
      SELECT id, school_id, department_id, program, batch, specialization, academic_year, year_of_study, semester, start_date, end_date
      FROM academic_calendars
      WHERE id = ?
    `).get(calendarId) as any
    : null;

  if (calendarId && !linkedCalendar) {
    throw new Error("Please select a valid academic calendar.");
  }

  const departmentId = Number(nextPayload.department_id || linkedCalendar?.department_id || 0) || null;
  const department = departmentId
    ? await db.prepare("SELECT id, school_id FROM departments WHERE id = ?").get(departmentId) as any
    : null;
  if (!department) {
    throw new Error("Please select a valid department.");
  }

  const roomId = nextPayload.room_id ? Number(nextPayload.room_id) : null;
  const room = roomId
    ? await db.prepare("SELECT id, room_number, room_type, capacity FROM rooms WHERE id = ?").get(roomId) as any
    : null;
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
  nextPayload.allocation_mode = ["exclusive", "shared"].includes((nextPayload.allocation_mode || "").toString().trim().toLowerCase())
    ? ((nextPayload.allocation_mode || "").toString().trim().toLowerCase() === "exclusive" ? "Exclusive" : "Shared")
    : "Shared";
  nextPayload.allocation_pattern = ["split room", "split"].includes((nextPayload.allocation_pattern || "").toString().trim().toLowerCase())
    ? "Split Room"
    : "Single Room";
  nextPayload.split_group_id = nextPayload.allocation_pattern === "Split Room"
    ? (nextPayload.split_group_id?.toString().trim() || buildSplitAllocationGroupId(nextPayload))
    : null;
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

const getBatchAllocationOverlapError = async (allocation: any, excludeId?: string | number, existingRows?: any[]) => {
  if (!allocation?.room_id || !allocation?.start_date || !allocation?.end_date) return null;
  const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(allocation.room_id) as any;
  const existingAllocations = Array.isArray(existingRows)
    ? existingRows.filter(existing => idsEqual(existing?.room_id, allocation.room_id) && (!excludeId || !idsEqual(existing?.id, excludeId)))
    : await db.prepare(`
      SELECT id, department_id, program, batch, academic_year, year_of_study, semester, start_date, end_date, status, allocation_mode
      FROM batch_room_allocations
      WHERE room_id = ?
      ${excludeId ? "AND id != ?" : ""}
    `).all(allocation.room_id, ...(excludeId ? [excludeId] : [])) as any[];

  const conflictingAllocation = existingAllocations.find(existing => {
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

const syncBatchAllocationStatuses = async () => {
  const allocations = await db.prepare("SELECT id, start_date, end_date, status FROM batch_room_allocations").all() as any[];
  for (const allocation of allocations) {
    const nextStatus = deriveBatchAllocationStatus(normalizeIsoDate(allocation.start_date), normalizeIsoDate(allocation.end_date), allocation.status);
    if (nextStatus !== allocation.status) {
      await db.prepare("UPDATE batch_room_allocations SET status = ? WHERE id = ?").run(nextStatus, allocation.id);
    }
  }
};

const getDayOfWeekForDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });

const parseSemesterNumber = (value: any) => {
  const normalized = normalizeDuplicateValue(value)?.toString() || "";
  if (!normalized) return null;

  const numericMatch = normalized.match(/(?:semester|sem)?\s*(\d+)/)?.[1];
  if (numericMatch) return Number(numericMatch);

  const romanMatch = normalized.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/);
  if (!romanMatch) return null;

  const romanToNumber: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10,
  };
  return romanToNumber[romanMatch[1]] || null;
};

const normalizeSemesterKey = (value: any) => {
  const normalized = normalizeDuplicateValue(value)?.toString() || "";
  if (!normalized) return "";
  if (normalized.includes("odd") || normalized.includes("fall")) return "odd";
  if (normalized.includes("even") || normalized.includes("spring") || normalized.includes("summer")) return "even";
  const semesterNumber = parseSemesterNumber(value);
  if (semesterNumber) return semesterNumber % 2 === 0 ? "even" : "odd";
  return normalized;
};

const isExaminationCalendarEvent = (calendar: any) => {
  const eventType = normalizeDuplicateValue(calendar?.event_type)?.toString() || "";
  const title = normalizeDuplicateValue(calendar?.title)?.toString() || "";
  return eventType.includes("exam") || eventType.includes("ciat") || title.includes("exam") || title.includes("ciat");
};

const normalizeAcademicContextText = (value: any) =>
  normalizeDuplicateValue(value)?.toString() || "";

const getDepartmentAllocationLink = async (roomId: any, departmentId: any, semester?: any, context?: BulkImportContext) => {
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
  `).all(numericRoomId, numericDepartmentId) as any[];

  if (matches.length === 0) return null;
  const matchedAllocation = !normalizedSemester
    ? matches[0]
    : matches.find(match => normalizeSemesterKey(match.semester) === normalizedSemester) || null;
  context?.departmentAllocationLinksByContext.set(cacheKey, matchedAllocation || null);
  return matchedAllocation;
};

const getDepartmentAllocationLinkError = async (roomId: any, departmentId: any, semester?: any, context?: BulkImportContext) => {
  if (!roomId || !departmentId) return "Please select both department and room.";
  const linkedAllocation = await getDepartmentAllocationLink(roomId, departmentId, semester, context);
  if (linkedAllocation) return null;

  const roomCacheKey = roomId.toString();
  let roomNumber = context?.roomNumberById.get(roomCacheKey) || "";
  if (!roomNumber) {
    const room = await db.prepare("SELECT room_number FROM rooms WHERE id = ?").get(roomId) as any;
    roomNumber = room?.room_number || "";
    context?.roomNumberById.set(roomCacheKey, roomNumber);
  }

  const departmentCacheKey = departmentId.toString();
  let departmentName = context?.departmentNameById.get(departmentCacheKey) || "";
  if (!departmentName) {
    const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId) as any;
    departmentName = department?.name || "";
    context?.departmentNameById.set(departmentCacheKey, departmentName);
  }
  const semesterLabel = normalizeSemesterKey(semester) ? ` for ${semester}` : "";
  return `Room ${roomNumber || roomId} is not mapped to ${departmentName || "the selected department"}${semesterLabel} in Department Allocation. Create the department allocation first.`;
};

const countDependentBatchRoomAllocations = async (roomId: any, departmentId: any, semester?: any) => {
  const numericRoomId = Number(roomId || 0) || null;
  const numericDepartmentId = Number(departmentId || 0) || null;
  if (!numericRoomId || !numericDepartmentId) return 0;

  const matches = await db.prepare(`
    SELECT id, semester
    FROM batch_room_allocations
    WHERE room_id = ? AND department_id = ?
  `).all(numericRoomId, numericDepartmentId) as any[];

  const normalizedSemester = normalizeSemesterKey(semester);
  if (!normalizedSemester) return matches.length;

  return matches.filter(match => normalizeSemesterKey(match?.semester) === normalizedSemester).length;
};

const normalizeScheduleSpecializationValue = (value: any) => {
  const raw = value?.toString().trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.toUpperCase();
};

const normalizeScheduleProgramValue = (value: any) => {
  const raw = value?.toString().trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const aliases: Record<string, string> = {
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
    "b.pharm": "B.Pharm",
  };

  return aliases[normalized.toLowerCase()] || normalized;
};

const normalizeSchedulePayload = (payload: any) => ({
  ...payload,
  program: normalizeScheduleProgramValue(payload?.program),
  specialization: normalizeScheduleSpecializationValue(payload?.specialization || payload?.branch),
  section: payload?.section?.toString().trim() || null,
  session_group_id: payload?.session_group_id?.toString().trim() || null,
});

const buildDepartmentScheduleCodeSegment = (department: any) => {
  const raw = department?.department_id?.toString().trim() || department?.name?.toString().trim() || "GEN";
  const compact = raw.replace(/[^a-z0-9]+/gi, " ").trim();
  if (!compact) return "GEN";
  if (department?.department_id) {
    return compact.replace(/\s+/g, "-").toUpperCase();
  }
  const acronym = compact
    .split(/\s+/)
    .filter(Boolean)
    .map((part: string) => part[0])
    .join("")
    .toUpperCase();
  return acronym || compact.replace(/\s+/g, "-").toUpperCase();
};

const buildScheduleProgramCodeSegment = (program: any) => {
  const normalizedProgram = normalizeScheduleProgramValue(program);
  if (!normalizedProgram) return "";
  return normalizedProgram.replace(/[^a-z0-9]+/gi, "").toUpperCase();
};

const buildScheduleCodePrefix = (department: any, program: any, specialization: any) => {
  const departmentSegment = buildDepartmentScheduleCodeSegment(department);
  const programSegment = buildScheduleProgramCodeSegment(program);
  const specializationSegment = normalizeScheduleSpecializationValue(specialization);
  return ["SCH", departmentSegment, programSegment, specializationSegment].filter(Boolean).join("-");
};

type BulkImportContext = {
  tableName: string;
  records: any[];
  departmentById: Map<string, any>;
  roomById: Map<string, any>;
  roomBookableErrorByRoomId: Map<string, string | null>;
  departmentAllocationLinksByContext: Map<string, any>;
  roomNumberById: Map<string, string>;
  departmentNameById: Map<string, string>;
  scheduleCodeSequenceByPrefix: Map<string, number>;
};

const createBulkImportContext = (tableName: string, records: any[]): BulkImportContext => ({
  tableName,
  records,
  departmentById: new Map(),
  roomById: new Map(),
  roomBookableErrorByRoomId: new Map(),
  departmentAllocationLinksByContext: new Map(),
  roomNumberById: new Map(),
  departmentNameById: new Map(),
  scheduleCodeSequenceByPrefix: new Map(),
});

const getCachedDepartmentForScheduleCode = async (departmentId: any, context?: BulkImportContext) => {
  if (!departmentId) return null;
  const cacheKey = departmentId.toString();
  if (context?.departmentById.has(cacheKey)) {
    return context.departmentById.get(cacheKey) || null;
  }

  const department = await db.prepare("SELECT id, department_id, name FROM departments WHERE id = ?").get(departmentId) as any;
  context?.departmentById.set(cacheKey, department || null);
  return department || null;
};

const seedScheduleCodeSequenceCache = async (context: BulkImportContext) => {
  if (context.scheduleCodeSequenceByPrefix.size > 0) return;
  const rows = context.records.length > 0
    ? context.records
    : await db.prepare("SELECT id, schedule_code FROM schedules WHERE schedule_code IS NOT NULL").all() as any[];
  rows.forEach((row: any) => {
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

const assignScheduleCode = async (payload: any, existingId?: any, existingItem?: any, context?: BulkImportContext) => {
  const mergedPayload = { ...(existingItem || {}), ...(payload || {}) };
  const department = mergedPayload?.department_id
    ? await getCachedDepartmentForScheduleCode(mergedPayload.department_id, context)
    : null;
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

  const rows = await db.prepare("SELECT id, schedule_code FROM schedules WHERE schedule_code IS NOT NULL").all() as any[];
  let maxSequence = 0;
  rows.forEach((row: any) => {
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

const backfillMissingScheduleCodes = async (rows: any[]) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    const existingCode = row?.schedule_code?.toString().trim() || "";
    const scheduleCode = await assignScheduleCode(row, row.id, row);
    if (existingCode === scheduleCode) continue;
    await db.prepare("UPDATE schedules SET schedule_code = ? WHERE id = ?").run(scheduleCode, row.id);
    row.schedule_code = scheduleCode;
  }
  return rows;
};

const normalizeYearOfStudyKey = (value: any) => {
  const normalized = value?.toString().trim().toLowerCase() || "";
  if (!normalized) return "";
  const numericMatch =
    normalized.match(/(?:^|\b)(\d+)(?:st|nd|rd|th)?\s*year\b/)?.[1] ||
    normalized.match(/\byear\s*(\d+)\b/)?.[1] ||
    normalized.match(/^(\d+)$/)?.[1];
  if (numericMatch) return numericMatch;

  const romanMatch =
    normalized.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\s*year\b/)?.[1] ||
    normalized.match(/\byear\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/)?.[1] ||
    normalized.match(/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/)?.[1];
  if (!romanMatch) return "";

  const romanToNumber: Record<string, string> = {
    i: "1",
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10",
  };
  return romanToNumber[romanMatch] || "";
};

const allocationMatchesCalendarContext = (allocation: any, calendar: any) => {
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

const scheduleMatchesCalendarOverride = (schedule: any, calendar: any, activeBatchAllocations: any[] = [], date?: string) => {
  if (!schedule?.department_id || !calendar?.department_id) return false;
  if (schedule.department_id.toString() !== calendar.department_id.toString()) return false;

  const scheduleSemester = normalizeSemesterKey(schedule.semester);
  const calendarSemester = normalizeSemesterKey(calendar.semester);
  if (scheduleSemester && calendarSemester && scheduleSemester !== calendarSemester) return false;

  const scheduleYear = normalizeYearOfStudyKey(schedule.year_of_study);
  const calendarYear = normalizeYearOfStudyKey(calendar.year_of_study);
  if (calendarYear && scheduleYear && calendarYear !== scheduleYear) return false;
  if (
    calendar?.program &&
    schedule?.program &&
    normalizeAcademicContextText(calendar.program) !== normalizeAcademicContextText(schedule.program)
  ) return false;
  if (
    calendar?.specialization &&
    schedule?.specialization &&
    normalizeAcademicContextText(calendar.specialization) !== normalizeAcademicContextText(schedule.specialization)
  ) return false;

  const calendarHasSpecificContext = Boolean(
    calendar?.program || calendar?.batch || calendar?.specialization || calendar?.academic_year || calendar?.year_of_study,
  );
  if (!calendarHasSpecificContext) return true;

  const relevantAllocations = activeBatchAllocations.filter((allocation: any) => {
    if (schedule?.room_id != null && allocation?.room_id != null && allocation.room_id.toString() !== schedule.room_id.toString()) return false;
    if (!allocation?.department_id || allocation.department_id.toString() !== schedule.department_id.toString()) return false;

    const allocationSemester = normalizeSemesterKey(allocation.semester);
    if (scheduleSemester && allocationSemester && allocationSemester !== scheduleSemester) return false;
    if (
      schedule?.program &&
      allocation?.program &&
      normalizeAcademicContextText(allocation.program) !== normalizeAcademicContextText(schedule.program)
    ) return false;
    if (
      schedule?.specialization &&
      allocation?.specialization &&
      normalizeAcademicContextText(allocation.specialization) !== normalizeAcademicContextText(schedule.specialization)
    ) return false;
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
  return relevantAllocations.some((allocation: any) => allocationMatchesCalendarContext(allocation, calendar));

};

const filterSchedulesByAcademicCalendar = async (schedules: any[], date: string) => {
  const normalizedDate = normalizeIsoDate(date);
  if (!normalizedDate || !Array.isArray(schedules) || schedules.length === 0) return schedules;

  const activeExamCalendars = await db.prepare(`
    SELECT id, department_id, program, batch, specialization, academic_year, year_of_study, semester, event_type, title, start_date, end_date
    FROM academic_calendars
    WHERE start_date <= ? AND end_date >= ?
  `).all(normalizedDate, normalizedDate) as any[];

  const examinationCalendars = activeExamCalendars.filter(isExaminationCalendarEvent);
  if (examinationCalendars.length === 0) return schedules;

  const activeBatchAllocations = await db.prepare(`
    SELECT id, academic_calendar_id, room_id, department_id, program, batch, specialization, academic_year, year_of_study, semester, start_date, end_date, status
    FROM batch_room_allocations
    WHERE start_date <= ? AND end_date >= ? AND status != ?
  `).all(normalizedDate, normalizedDate, "Released") as any[];

  return schedules.filter(schedule =>
    !examinationCalendars.some(calendar => scheduleMatchesCalendarOverride(schedule, calendar, activeBatchAllocations, normalizedDate))
  );
};

const getEffectiveSchedulesForDate = async (
  date: string,
  predicate?: (schedule: any) => boolean,
) => {
  const normalizedDate = normalizeIsoDate(date);
  if (!normalizedDate) return [] as any[];

  const dayOfWeek = getDayOfWeekForDate(normalizedDate);
  const daySchedules = await db.prepare(`SELECT * FROM schedules WHERE day_of_week = ?`).all(dayOfWeek) as any[];
  const deduplicatedSchedules = deduplicateSchedules(daySchedules).kept;
  const filteredSchedules = predicate ? deduplicatedSchedules.filter(predicate) : deduplicatedSchedules;
  return filterSchedulesByAcademicCalendar(filteredSchedules, normalizedDate);
};

const ensureNotificationsTable = async () => {
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

const ensureNotificationReadsTable = async () => {
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

const createNotification = async (targetRole: string | null, targetName: string | null, title: string, message: string, targetDepartment: string | null = null) => {
  await ensureNotificationsTable();
  await db.prepare("INSERT INTO notifications (target_role, target_name, target_department, title, message) VALUES (?, ?, ?, ?, ?)")
    .run(targetRole, targetName, targetDepartment, title, message);
};

const getDepartmentNameById = async (departmentId?: string | number | null) => {
  if (!departmentId) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId) as any;
  return department?.name || null;
};

const getSchoolRecordByName = async (schoolName?: string | null) => {
  const normalizedSchoolName = schoolName?.toString().trim() || "";
  if (!normalizedSchoolName) return null;
  return await db.prepare(`
    SELECT id, name
    FROM schools
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalizedSchoolName) as any;
};

const getDepartmentScopeByName = async (departmentName?: string | null) => {
  const normalizedDepartmentName = departmentName?.toString().trim() || "";
  if (!normalizedDepartmentName) {
    return { department: null as any, schoolId: null as any, departmentIdsInSchool: [] as string[] };
  }

  const department = await db.prepare(`
    SELECT id, name, school_id
    FROM departments
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
    LIMIT 1
  `).get(normalizedDepartmentName) as any;

  if (!department) {
    return { department: null as any, schoolId: null as any, departmentIdsInSchool: [] as string[] };
  }

  if (!department.school_id) {
    return { department, schoolId: null as any, departmentIdsInSchool: [department.id?.toString()].filter(Boolean) as string[] };
  }

  const siblingDepartments = await db.prepare(`
    SELECT id
    FROM departments
    WHERE school_id = ?
  `).all(department.school_id) as any[];

  return {
    department,
    schoolId: department.school_id,
    departmentIdsInSchool: siblingDepartments
      .map((item: any) => item?.id?.toString())
      .filter(Boolean),
  };
};

const getScopedDepartmentIdsForUser = async (user?: any) => {
  const role = user?.role?.toString?.().trim() || "";
  if (!role || isAdminRole(role) || isExecutiveViewRole(role) || ["Dean (P&M)", "Deputy Dean (P&M)", "Infrastructure Manager", "Maintenance Staff"].includes(role)) {
    return null;
  }

  if (["HOD", "Faculty", "Event Coordinator"].includes(role)) {
    const scope = await getDepartmentScopeByName(user?.department);
    return scope.department?.id != null ? [scope.department.id.toString()] : [];
  }

  if (role === "Dean") {
    const scopedSchool = user?.school
      ? await getSchoolRecordByName(user.school)
      : null;
    if (scopedSchool?.id) {
      const departments = await db.prepare(`
        SELECT id
        FROM departments
        WHERE school_id = ?
      `).all(scopedSchool.id) as any[];
      return departments.map((department: any) => department?.id?.toString()).filter(Boolean);
    }

    const scope = await getDepartmentScopeByName(user?.department);
    return scope.departmentIdsInSchool || [];
  }

  return null;
};

const getScopedMappedRoomIdsForUser = async (user?: any) => {
  const departmentIds = await getScopedDepartmentIdsForUser(user);
  if (departmentIds == null) return null;
  if (departmentIds.length === 0) return new Set<string>();

  const placeholders = departmentIds.map(() => "?").join(", ");
  const mappedRows = await db.prepare(`
    SELECT DISTINCT room_id
    FROM department_allocations
    WHERE room_id IS NOT NULL
      AND department_id IN (${placeholders})
  `).all(...departmentIds) as any[];

  return new Set(mappedRows.map((row: any) => row?.room_id?.toString()).filter(Boolean));
};

const normalizeUserPayload = async (payload: any, existingItem?: any) => {
  const nextPayload = { ...(existingItem || {}), ...(payload || {}) };
  nextPayload.full_name = nextPayload.full_name?.toString().trim() || "";
  nextPayload.employee_id = nextPayload.employee_id?.toString().trim() || "";
  nextPayload.role = nextPayload.role?.toString().trim() || "";
  nextPayload.email = nextPayload.email?.toString().trim().toLowerCase() || "";
  nextPayload.school = nextPayload.school?.toString().trim() || "";
  nextPayload.department = nextPayload.department?.toString().trim() || "";
  nextPayload.designation = nextPayload.designation?.toString().trim() || null;
  nextPayload.mobile_number = nextPayload.mobile_number?.toString().trim() || null;
  nextPayload.responsibilities = nextPayload.responsibilities?.toString().trim() || null;
  nextPayload.access_limits = nextPayload.access_limits?.toString().trim() || null;
  nextPayload.access_paths = nextPayload.access_paths?.toString().trim() || null;

  if (!nextPayload.full_name) throw new Error("Full name is required.");
  if (!nextPayload.employee_id) throw new Error("Employee ID is required.");
  if (!nextPayload.role) throw new Error("Role is required.");
  if (!nextPayload.email) throw new Error("Email address is required.");

  const role = nextPayload.role;
  const normalizedRequestedAccessType = normalizeUserAccessTypeValue(nextPayload.access_type);
  const requestedAccessScope = nextPayload.access_scope?.toString().trim() || "";
  const schoolRecord = nextPayload.school ? await getSchoolRecordByName(nextPayload.school) : null;
  if (nextPayload.school && !schoolRecord) {
    throw new Error(`School "${nextPayload.school}" was not found. Create the school first or use the exact school name.`);
  }

  const departmentScope = nextPayload.department ? await getDepartmentScopeByName(nextPayload.department) : null;
  if (nextPayload.department && !departmentScope?.department) {
    throw new Error(`Department "${nextPayload.department}" was not found. Create the department first or use the exact department name.`);
  }

  const inferredSchoolName = schoolRecord?.name
    || (departmentScope?.department?.school_id
      ? (await db.prepare("SELECT name FROM schools WHERE id = ?").get(departmentScope.department.school_id) as any)?.name
      : "");

  if (schoolRecord && departmentScope?.department?.school_id && !idsEqual(schoolRecord.id, departmentScope.department.school_id)) {
    throw new Error(`Department "${nextPayload.department}" does not belong to school "${nextPayload.school}".`);
  }

  if (DEPARTMENT_SCOPE_ROLE_VALUES.has(role) && !nextPayload.department) {
    throw new Error(`${role} users must be linked to a department.`);
  }
  if (SCHOOL_SCOPE_ROLE_VALUES.has(role) && !(nextPayload.school || inferredSchoolName)) {
    throw new Error(`${role} users must be linked to a school.`);
  }

  nextPayload.school = nextPayload.school || inferredSchoolName || null;
  nextPayload.department = nextPayload.department || null;

  let derivedAccessType = normalizedRequestedAccessType;
  let derivedAccessScope = requestedAccessScope;

  if (GLOBAL_SCOPE_ROLE_VALUES.has(role) || isAdminRole(role) || isExecutiveViewRole(role)) {
    derivedAccessType = "Global";
    derivedAccessScope = "All";
    nextPayload.school = nextPayload.school || null;
  } else if (SCHOOL_SCOPE_ROLE_VALUES.has(role)) {
    derivedAccessType = "School";
    derivedAccessScope = nextPayload.school || requestedAccessScope || "";
  } else if (DEPARTMENT_SCOPE_ROLE_VALUES.has(role)) {
    derivedAccessType = "Department";
    derivedAccessScope = nextPayload.department || requestedAccessScope || "";
  } else if (!derivedAccessType) {
    if (nextPayload.department) {
      derivedAccessType = "Department";
      derivedAccessScope = nextPayload.department;
    } else if (nextPayload.school) {
      derivedAccessType = "School";
      derivedAccessScope = nextPayload.school;
    } else {
      derivedAccessType = "Global";
      derivedAccessScope = "All";
    }
  }

  nextPayload.access_type = derivedAccessType || null;
  nextPayload.access_scope = derivedAccessScope || null;

  return nextPayload;
};

const backfillNotificationsIfEmpty = async () => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const notificationCount = await db.prepare("SELECT COUNT(*) as count FROM notifications").get() as any;
  if ((notificationCount?.count || 0) > 0) return;

  const bookings = await db.prepare("SELECT * FROM bookings ORDER BY id ASC").all() as any[];
  for (const booking of bookings) {
    const bookingLabel = booking.event_name || "room request";
    const bookingTime = booking.date && booking.start_time && booking.end_time
      ? `${booking.date} from ${booking.start_time} to ${booking.end_time}`
      : booking.date || "the selected slot";
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

const getNotificationAudienceParams = (user: any) => {
  const normalizedRole = user?.role || null;
  const normalizedName = user?.name?.toString().trim().toLowerCase() || null;
  const normalizedDepartment = user?.department?.toString().trim().toLowerCase() || null;

  return { normalizedRole, normalizedName, normalizedDepartment };
};

const getNotificationsForUser = async (user: any, limit = 20) => {
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

const markAllNotificationsRead = async (user: any, notificationIds?: number[]) => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const normalizedIds = Array.isArray(notificationIds)
    ? notificationIds.map(id => parseInt(id as any, 10)).filter(id => Number.isInteger(id) && id > 0)
    : [];
  const visibleNotificationIds = (await getNotificationsForUser(user, 1000))
    .map((notification: any) => notification.id)
    .filter((id: number) => normalizedIds.length === 0 || normalizedIds.includes(id));

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

app.use((_req: any, res: any, next: any) => {
  if (dbInitializationError) {
    return res.status(503).json({ error: "Service unavailable: database could not be initialized." });
  }
  next();
});

const getAuthCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction ? "none" : "lax") as "none" | "lax",
});

// Auth Middleware
const authenticate = (req: any, res: any, next: any) => {
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

const getAIResponseText = async (response: any) => {
  const textValue = response?.text;
  if (typeof textValue === "function") return await textValue.call(response);
  if (typeof textValue === "string") return textValue;
  if (typeof response?.response?.text === "function") return await response.response.text();
  throw new Error("AI response did not include readable text.");
};

const parseAIJsonResponse = (text: string) => {
  let cleanText = text.trim();
  if (cleanText.includes("```json")) {
    cleanText = cleanText.split("```json")[1].split("```")[0];
  } else if (cleanText.includes("```")) {
    cleanText = cleanText.split("```")[1].split("```")[0];
  }
  return JSON.parse(cleanText);
};

const composeDashboardInsightFallback = (stats: any, schoolReports: any[]) => {
  const topSchool = (Array.isArray(schoolReports) ? schoolReports : [])
    .filter((school: any) => school?.name && school.name !== "Unmapped")
    .sort((a: any, b: any) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0))[0];

  if (!topSchool) {
    return "No school utilization data is available yet. Add room allocations, schedules, or approved bookings to populate live insights.";
  }

  const summaryParts = [
    `${topSchool.name} is currently at ${Number(topSchool?.avgUtilization) || 0}% average utilization.`,
    `${stats?.availableNow || 0} rooms are available right now.`,
  ];

  if ((stats?.pendingBookings || 0) > 0) {
    summaryParts.push(`${stats.pendingBookings} pending booking request${stats.pendingBookings === 1 ? "" : "s"} need review.`);
  }
  if ((stats?.equipmentIssues || 0) > 0) {
    summaryParts.push(`${stats.equipmentIssues} maintenance issue${stats.equipmentIssues === 1 ? "" : "s"} need attention.`);
  }

  return summaryParts.join(" ");
};

const composeDigitalTwinOptimizationFallback = (summary: any) => {
  const totalRooms = Number(summary?.totals?.rooms) || 0;
  const scheduledNow = Number(summary?.live?.scheduledNow) || 0;
  const bookedNow = Number(summary?.live?.bookedNow) || 0;
  const maintenanceRooms = Number(summary?.live?.maintenanceRooms) || 0;
  const availableNow = Number(summary?.live?.availableNow) || 0;
  const activeRooms = scheduledNow + bookedNow;
  const efficiencyScore = totalRooms > 0
    ? Math.max(10, Math.min(100, Math.round(((activeRooms + availableNow) / totalRooms) * 100 - maintenanceRooms)))
    : 45;
  const topBuildings = Array.isArray(summary?.topBuildings) ? summary.topBuildings : [];
  const topBuildingLabel = topBuildings[0]?.name ? `${topBuildings[0].name}` : "the busiest building";

  const recommendations = [
    `Prioritize timetable balancing for ${topBuildingLabel} to reduce concentrated peak load and improve room spread across other buildings.`,
    `Convert rooms with repeated low usage into flexible shared pools for elective, lab support, and event overflow slots.`,
    `Auto-tag maintenance-prone rooms for proactive checks before daily peak hours to avoid avoidable schedule disruptions.`,
  ];

  const futureForecast = maintenanceRooms > 0
    ? "If maintenance backlog is reduced and low-usage rooms are rebalanced, utilization consistency should improve over the next 2-4 weeks."
    : "Current infrastructure is stable; adding periodic balancing of schedules and bookings should increase effective utilization in upcoming weeks.";

  const simulationImpact = totalRooms > 0
    ? `Simulated rebalancing indicates up to ${Math.max(4, Math.min(18, Math.round((activeRooms / Math.max(totalRooms, 1)) * 20)))}% improvement in peak-slot distribution.`
    : "Simulation baseline is limited because room inventory is still being populated.";

  return {
    recommendations,
    futureForecast,
    efficiencyScore,
    simulationImpact,
    source: "fallback",
  };
};

const normalizeDigitalTwinOptimizationResponse = (payload: any, fallback: any) => {
  const recommendations = Array.isArray(payload?.recommendations)
    ? payload.recommendations.map((item: any) => item?.toString?.().trim()).filter(Boolean)
    : [];
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
    source: "ai",
  };
};

const composeUtilizationOptimizationFallback = (snapshot: any[]) => {
  const rows = Array.isArray(snapshot) ? snapshot : [];
  const underused = rows
    .filter((row: any) => Number(row?.util) < 40)
    .sort((a: any, b: any) => Number(a?.util || 0) - Number(b?.util || 0))
    .slice(0, 8);

  if (!underused.length) {
    return [
      {
        title: "Maintain Balanced Usage",
        suggestion: "Current utilization distribution is relatively balanced. Continue monitoring weekly and rotate low-demand sessions across buildings to prevent clustering.",
        impact: "Medium",
      },
      {
        title: "Reserve Flexible Rooms",
        suggestion: "Keep a small pool of multi-purpose rooms available for ad-hoc events and overflow labs to improve response time for urgent requests.",
        impact: "Medium",
      },
      {
        title: "Track Booking-to-Use Variance",
        suggestion: "Compare approved bookings against actual usage and tighten approval windows where repeated no-shows are observed.",
        impact: "Low",
      },
    ];
  }

  const lowestRooms = underused.slice(0, 3).map((row: any) => row?.room).filter(Boolean).join(", ");
  const lowDept = underused
    .reduce((acc: Record<string, number>, row: any) => {
      const key = row?.dept?.toString?.().trim() || "Unmapped";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  const focusDept = Object.entries(lowDept).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || "target departments";

  return [
    {
      title: "Rebalance Underused Rooms",
      suggestion: `Prioritize timetable reallocation for low-usage rooms (${lowestRooms || "identified rooms"}) by moving repeat sessions from overloaded spaces into these rooms.`,
      impact: "High",
    },
    {
      title: "Department Scheduling Window",
      suggestion: `Introduce a focused scheduling review with ${focusDept} to spread class timings across the day and reduce concentration in peak slots.`,
      impact: "High",
    },
    {
      title: "Demand-Based Room Pooling",
      suggestion: "Convert chronically underused rooms into a shared pool for electives, tutorials, and seminar overflow with weekly utilization tracking.",
      impact: "Medium",
    },
  ];
};

const normalizeUtilizationOptimizationResponse = (payload: any, fallback: any[]) => {
  const suggestions = Array.isArray(payload?.suggestions)
    ? payload.suggestions
    : Array.isArray(payload)
      ? payload
      : [];

  const normalized = suggestions
    .map((item: any) => ({
      title: item?.title?.toString?.().trim() || "",
      suggestion: item?.suggestion?.toString?.().trim() || "",
      impact: item?.impact?.toString?.().trim() || "Medium",
    }))
    .filter((item: any) => item.title && item.suggestion)
    .map((item: any) => ({
      ...item,
      impact: ["High", "Medium", "Low"].includes(item.impact) ? item.impact : "Medium",
    }));

  return normalized.length ? normalized.slice(0, 6) : fallback;
};

const normalizeExtractedSectionValue = (value: any) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const match = raw.match(/section[\s:-]*([a-z0-9]+)/i) || raw.match(/^([a-z]+\d+)$/i);
  return (match?.[1] || raw).toUpperCase();
};

const normalizeExtractedSpecializationValue = (value: any) => {
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

const normalizeExtractedProgramValue = (value: any) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const directMatch = raw.match(/\b(b\.?\s*sc|bpt|b\.?\s*pharm|b\.?\s*tech|m\.?\s*tech)\b/i);
  if (directMatch?.[1]) {
    return normalizeScheduleProgramValue(directMatch[1]) || "";
  }
  return normalizeScheduleProgramValue(raw) || "";
};

const normalizeExtractedRoomValue = (value: any) => {
  const raw = value?.toString().trim();
  if (!raw) return "";
  const directMatch =
    raw.match(/(?:room|r)\s*\.?\s*no\.?\s*[:\-]?\s*([a-z0-9-]+)/i) ||
    raw.match(/\b([a-z]?\d{3,4}[a-z]?)\b/i);
  return directMatch?.[1]?.toUpperCase() || raw;
};

const mergeExtractedSchedulesWithHeaderRooms = (schedules: any[], sectionRoomMaps: any[]) => {
  if (!Array.isArray(schedules) || schedules.length === 0) return [];

  const fallbackBySection = new Map<string, { room: string; semester: any; department: any; program: any; year_of_study: any; specialization: any }>();
  const fallbackBySpecialization = new Map<string, { room: string; semester: any; department: any; program: any; year_of_study: any; specialization: any }>();
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

  const singleFallback = Array.isArray(sectionRoomMaps) && sectionRoomMaps.length === 1
    ? (() => {
        const item = sectionRoomMaps[0];
        return {
          room: normalizeExtractedRoomValue(item?.room),
          semester: item?.semester || null,
          department: item?.department || null,
          program: normalizeExtractedProgramValue(item?.program || item?.program_context || item?.title || item?.header) || null,
          year_of_study: normalizeYearOfStudyKey(item?.year_of_study || item?.year) || null,
          specialization: normalizeExtractedSpecializationValue(item?.specialization || item?.branch || item?.title || item?.header) || null,
        };
      })()
    : null;

  return schedules.map(schedule => {
    const normalizedSection = normalizeExtractedSectionValue(schedule?.section);
    const normalizedProgram = normalizeExtractedProgramValue(schedule?.program || schedule?.program_context || schedule?.header) || null;
    const normalizedSpecialization = normalizeExtractedSpecializationValue(schedule?.specialization || schedule?.branch || schedule?.program_context || schedule?.header) || null;
    const explicitRoom = normalizeExtractedRoomValue(schedule?.room);
    const inheritedDefaults =
      (normalizedSection ? fallbackBySection.get(normalizedSection) : null) ||
      (normalizedSpecialization ? fallbackBySpecialization.get(normalizedSpecialization) : null) ||
      singleFallback;
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
      room: explicitRoom || inheritedRoom || schedule?.room || null,
    };
  });
};

// --- AUTH ROUTES ---

const getUserSessionPayload = (user: any) => ({
  id: user.id,
  email: user.email,
  role: user.role,
  name: user.full_name,
  school: user.school,
  department: user.department,
  designation: user.designation,
  responsibilities: user.responsibilities,
  access_limits: user.access_limits,
  access_type: user.access_type,
  access_scope: user.access_scope,
  access_paths: user.access_paths,
  force_password_change: !!user.force_password_change
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user: any = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const sessionUser = getUserSessionPayload(user);
    const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, getAuthCookieOptions());
    res.json({ user: sessionUser });
  } catch (err: any) {
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
      const rankedSchools = safeSchoolReports
        .filter((school: any) => school?.name)
        .sort((a: any, b: any) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0))
        .slice(0, 3)
        .map((school: any) => `${school.name}: ${Number(school?.avgUtilization) || 0}%`)
        .join(", ");

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
        contents: [{ parts: [{ text: prompt }] }],
      });

      const generatedText = (await getAIResponseText(response))
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^["'`]|["'`]$/g, "");

      if (!generatedText) {
        return res.json({ insight: fallbackInsight, source: "fallback" });
      }

      return res.json({ insight: generatedText, source: "ai" });
    } catch (aiErr: any) {
      console.error("Dashboard AI insight fallback:", aiErr?.message || aiErr);
      return res.json({ insight: fallbackInsight, source: "fallback" });
    }
  } catch (err: any) {
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
        config: { responseMimeType: "application/json" },
      });

      const parsed = parseAIJsonResponse(await getAIResponseText(response));
      return res.json(normalizeDigitalTwinOptimizationResponse(parsed, fallback));
    } catch (aiErr: any) {
      console.error("Digital twin optimization fallback:", aiErr?.message || aiErr);
      return res.json(fallback);
    }
  } catch (err: any) {
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
        config: { responseMimeType: "application/json" },
      });

      const raw = await getAIResponseText(response);
      const parsed = parseAIJsonResponse(raw);
      const suggestions = normalizeUtilizationOptimizationResponse(parsed, fallbackSuggestions);
      return res.json({ suggestions, source: "ai" });
    } catch (aiErr: any) {
      console.error("Utilization AI fallback:", aiErr?.message || aiErr);
      return res.json({ suggestions: fallbackSuggestions, source: "fallback" });
    }
  } catch (err: any) {
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
      createdAt: new Date().toISOString(),
      userRole: (req as any).user?.role || "",
    });
    if (moduleLoadTelemetry.length > MAX_MODULE_LOAD_TELEMETRY) {
      moduleLoadTelemetry.splice(0, moduleLoadTelemetry.length - MAX_MODULE_LOAD_TELEMETRY);
    }

    return res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/performance/module-load", authenticate, async (_req, res) => {
  try {
    const grouped = new Map<string, { module: string; phase: string; samples: number; avgDurationMs: number; maxDurationMs: number; lastDurationMs: number; avgItemCount: number; lastSeenAt: string }>();
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
          lastSeenAt: record.createdAt,
        });
        return;
      }
      const nextSamples = existing.samples + 1;
      existing.avgDurationMs = Math.round(((existing.avgDurationMs * existing.samples) + record.durationMs) / nextSamples);
      existing.avgItemCount = Math.round(((existing.avgItemCount * existing.samples) + record.itemCount) / nextSamples);
      existing.maxDurationMs = Math.max(existing.maxDurationMs, record.durationMs);
      existing.lastDurationMs = record.durationMs;
      existing.samples = nextSamples;
      existing.lastSeenAt = record.createdAt;
    });

    res.json({
      summary: Array.from(grouped.values()).sort((left, right) => right.avgDurationMs - left.avgDurationMs),
      recent: moduleLoadTelemetry.slice(-50).reverse(),
    });
  } catch (err: any) {
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

    const base64Data = data.toString().includes(",")
      ? data.toString().split(",").pop()
      : data.toString();
    const parts: any[] = [];

    if (mimeType === "application/pdf") {
      parts.push({
        inlineData: {
          data: base64Data,
          mimeType,
        },
      });
    } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const buffer = Buffer.from(base64Data, "base64");
      const result = await mammoth.extractRawText({ buffer });
      parts.push({ text: `Extracted text from ${fileName || "DOCX document"}:\n\n${result.value}` });
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
      config: { responseMimeType: "application/json" },
    });
    const extractedPayload = parseAIJsonResponse(await getAIResponseText(response));
    const schedules = Array.isArray(extractedPayload)
      ? extractedPayload
      : Array.isArray(extractedPayload?.schedules)
        ? extractedPayload.schedules
        : [];
    const sectionRoomMaps = Array.isArray(extractedPayload?.sectionRoomMaps)
      ? extractedPayload.sectionRoomMaps
      : Array.isArray(extractedPayload?.section_room_maps)
        ? extractedPayload.section_room_maps
        : [];
    const enrichedSchedules = mergeExtractedSchedulesWithHeaderRooms(
      schedules,
      sectionRoomMaps,
    );
    res.json({ schedules: enrichedSchedules });
  } catch (err: any) {
    const errorMessage = err?.message || "";
    const leakedKey = /reported as leaked|leaked/i.test(errorMessage);
    const invalidKey = /API key not valid|API_KEY_INVALID|Invalid API Key|PERMISSION_DENIED/i.test(errorMessage);
    res.status(500).json({
      error: leakedKey
        ? "The configured Gemini API key was reported as leaked and cannot be used. Create a new key in Google AI Studio, set it as GEMINI_API_KEY in .env, remove the old VITE_GEMINI_API_KEY value, and restart the server."
        : invalidKey
          ? "Gemini rejected the configured API key. Set a valid GEMINI_API_KEY on the backend and restart the server."
          : errorMessage || "Failed to extract timetable.",
    });
  }
});

app.get("/api/notifications", authenticate, async (req: any, res) => {
  try {
    const notifications = await getNotificationsForUser(req.user);
    res.json(notifications);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/notifications/read-all", authenticate, async (req: any, res) => {
  try {
    await markAllNotificationsRead(req.user, req.body?.notificationIds);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/forgot-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Admin or Master Admin." });
});

app.post("/api/auth/reset-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Admin or Master Admin." });
});

app.post("/api/auth/change-password", authenticate, async (req: any, res) => {
  try {
    const { password } = req.body;
    if (!password || password.toString().trim().length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const hashedPassword = bcrypt.hashSync(password.toString(), 10);
    await db.prepare("UPDATE users SET password = ?, force_password_change = 0 WHERE id = ?").run(hashedPassword, req.user.id);
    const user: any = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    const sessionUser = getUserSessionPayload(user);
    const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: "24h" });
    res.cookie("token", token, getAuthCookieOptions());
    res.json({ user: sessionUser });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- CRUD ROUTES ---

const duplicateRules: Record<string, Array<{ fields: string[]; label: string }>> = {
  users: [
    { fields: ["employee_id"], label: "Employee ID" },
    { fields: ["email"], label: "Email" },
  ],
  campuses: [
    { fields: ["campus_id"], label: "Campus ID" },
    { fields: ["name"], label: "Campus name" },
  ],
  buildings: [
    { fields: ["building_id"], label: "Building ID" },
    { fields: ["campus_id", "name"], label: "Building name in this campus" },
  ],
  blocks: [
    { fields: ["block_id"], label: "Block ID" },
    { fields: ["building_id", "name"], label: "Block name in this building" },
  ],
  floors: [
    { fields: ["floor_id"], label: "Floor ID" },
    { fields: ["block_id", "floor_number"], label: "Floor number in this block" },
  ],
  rooms: [
    { fields: ["room_id"], label: "Room ID" },
    { fields: ["room_number"], label: "Room number" },
  ],
  schools: [
    { fields: ["school_id"], label: "School ID" },
    { fields: ["name"], label: "School name" },
  ],
  departments: [
    { fields: ["department_id"], label: "Department ID" },
    { fields: ["school_id", "name"], label: "Department name in this school" },
  ],
  department_allocations: [
    { fields: ["room_id", "department_id", "semester"], label: "Room allocation for this department and semester" },
  ],
  academic_calendars: [
    { fields: ["calendar_id"], label: "Calendar ID" },
    { fields: ["department_id", "program", "batch", "specialization", "year_of_study", "semester", "event_type", "title", "start_date", "end_date"], label: "Academic calendar period" },
  ],
  timing_profiles: [
    { fields: ["profile_id"], label: "Timing Profile ID" },
    { fields: ["department_id", "program", "specialization", "academic_year", "year_of_study", "semester", "section", "slot_pattern"], label: "Timing profile context" },
  ],
  batch_room_allocations: [
    { fields: ["allocation_id"], label: "Allocation ID" },
    { fields: ["room_id", "department_id", "program", "batch", "specialization", "year_of_study", "semester", "start_date", "end_date"], label: "Batch room allocation period" },
  ],
  equipment: [
    { fields: ["equipment_id"], label: "Equipment ID" },
    { fields: ["room_id", "name"], label: "Equipment name in this room" },
  ],
  schedules: [
    { fields: ["schedule_id"], label: "Schedule ID" },
    { fields: ["room_id", "program", "specialization", "section", "day_of_week", "start_time", "end_time"], label: "Schedule slot for this room, program, branch, and section" },
  ],
  bookings: [
    { fields: ["request_id"], label: "Request ID" },
  ],
  maintenance: [
    { fields: ["maintenance_id"], label: "Maintenance ID" },
  ],
};

const normalizeDuplicateValue = (value: any) =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

const idsEqual = (left: any, right: any) =>
  left !== undefined && left !== null && right !== undefined && right !== null && left.toString() === right.toString();

const normalizeReferenceLookupValue = (value: any) =>
  value === undefined || value === null ? "" : value.toString().trim();

const resolveReferenceRecordId = async ({
  targetTable,
  rawValue,
  codeField,
  labelFields = [],
  scope = [],
  entityLabel,
  preferredIdentifierLabel,
}: {
  targetTable: string;
  rawValue: any;
  codeField: string;
  labelFields?: string[];
  scope?: Array<{ field: string; value: any }>;
  entityLabel: string;
  preferredIdentifierLabel: string;
}) => {
  const normalizedValue = normalizeReferenceLookupValue(rawValue);
  if (!normalizedValue) return rawValue;

  const records = await db.prepare(`SELECT * FROM ${targetTable}`).all() as any[];
  const scopedRecords = records.filter((record: any) =>
    scope.every(({ field, value }) => {
      const scopedValue = normalizeReferenceLookupValue(value);
      return !scopedValue || idsEqual(record?.[field], scopedValue);
    })
  );
  const candidates = scopedRecords.length > 0 ? scopedRecords : records;
  const normalizedLookup = normalizeDuplicateValue(normalizedValue);
  const matches = candidates.filter((record: any) => {
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

const normalizeHierarchyReferencePayload = async (tableName: string, payload: any) => {
  const nextPayload = { ...(payload || {}) };
  let resolvedCampusId = nextPayload.campus_id;
  let resolvedBuildingId = nextPayload.building_id;
  let resolvedBlockId = nextPayload.block_id;

  if (["buildings", "blocks"].includes(tableName) && nextPayload.campus_id !== undefined && nextPayload.campus_id !== null && nextPayload.campus_id !== "") {
    resolvedCampusId = await resolveReferenceRecordId({
      targetTable: "campuses",
      rawValue: nextPayload.campus_id,
      codeField: "campus_id",
      labelFields: ["name"],
      entityLabel: "campus",
      preferredIdentifierLabel: "Campus ID",
    });
    if (tableName === "buildings") {
      nextPayload.campus_id = resolvedCampusId;
    }
  }

  if (["blocks", "floors", "rooms"].includes(tableName) && nextPayload.building_id !== undefined && nextPayload.building_id !== null && nextPayload.building_id !== "") {
    resolvedBuildingId = await resolveReferenceRecordId({
      targetTable: "buildings",
      rawValue: nextPayload.building_id,
      codeField: "building_id",
      labelFields: ["name"],
      scope: [{ field: "campus_id", value: resolvedCampusId }],
      entityLabel: "building",
      preferredIdentifierLabel: "Building ID",
    });
    if (tableName === "blocks") {
      nextPayload.building_id = resolvedBuildingId;
    }
  }

  if (["floors", "rooms"].includes(tableName) && nextPayload.block_id !== undefined && nextPayload.block_id !== null && nextPayload.block_id !== "") {
    resolvedBlockId = await resolveReferenceRecordId({
      targetTable: "blocks",
      rawValue: nextPayload.block_id,
      codeField: "block_id",
      labelFields: ["name"],
      scope: [{ field: "building_id", value: resolvedBuildingId }],
      entityLabel: "block",
      preferredIdentifierLabel: "Block ID",
    });
    if (tableName === "floors") {
      nextPayload.block_id = resolvedBlockId;
    }
  }

  if (tableName === "rooms" && nextPayload.floor_id !== undefined && nextPayload.floor_id !== null && nextPayload.floor_id !== "") {
    nextPayload.floor_id = await resolveReferenceRecordId({
      targetTable: "floors",
      rawValue: nextPayload.floor_id,
      codeField: "floor_id",
      scope: [{ field: "block_id", value: resolvedBlockId }],
      entityLabel: "floor",
      preferredIdentifierLabel: "Floor ID",
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

const NUMERIC_DUPLICATE_COMPARE_FIELDS = new Set([
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
  "maintenance.room_id",
]);

const shouldUseCaseInsensitiveTextComparison = (tableName: string, fieldName: string, value: any) => {
  if (NUMERIC_DUPLICATE_COMPARE_FIELDS.has(`${tableName}.${fieldName}`)) return false;
  if (typeof value !== "string") return false;
  const normalizedField = fieldName.toLowerCase();
  if (normalizedField === "date" || normalizedField.endsWith("_date")) return false;
  return true;
};

const getScheduleIdentityVariants = (schedule: any) => {
  const day = normalizeDuplicateValue(schedule?.day_of_week)?.toString() || "";
  const start = normalizeDuplicateValue(schedule?.start_time)?.toString() || "";
  const end = normalizeDuplicateValue(schedule?.end_time)?.toString() || "";
  const program = normalizeDuplicateValue(normalizeScheduleProgramValue(schedule?.program))?.toString() || "";
  const specialization = normalizeDuplicateValue(normalizeScheduleSpecializationValue(schedule?.specialization))?.toString() || "";
  const section = normalizeDuplicateValue(schedule?.section)?.toString() || "";
  const variants: string[] = [];

  if (schedule?.room_id !== undefined && schedule?.room_id !== null && schedule.room_id !== "") {
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

const schedulesConflict = (left: any, right: any) => {
  const leftVariants = getScheduleIdentityVariants(left);
  const rightVariants = new Set(getScheduleIdentityVariants(right));
  return leftVariants.some(variant => rightVariants.has(variant));
};

const deduplicateSchedules = (rows: any[]) => {
  const seen = new Set<string>();
  const kept: any[] = [];
  const duplicates: any[] = [];
  const prioritizedRows = [...rows].sort((a, b) => {
    const score = (row: any) =>
      (row?.room_id ? 4 : 0) +
      (row?.room_label ? 2 : 0) +
      (row?.course_name ? 1 : 0) +
      (row?.faculty ? 1 : 0);
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });

  for (const row of prioritizedRows) {
    const variants = getScheduleIdentityVariants(row);
    const hasConflict = variants.some(variant => seen.has(variant));
    if (hasConflict) {
      duplicates.push(row);
      continue;
    }

    variants.forEach(variant => seen.add(variant));
    kept.push(row);
  }

  kept.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  duplicates.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  return { kept, duplicates };
};

const cleanupDuplicateSchedules = async () => {
  const scheduleRows = await db.prepare("SELECT * FROM schedules").all() as any[];
  const { duplicates } = deduplicateSchedules(scheduleRows);

  for (const duplicate of duplicates) {
    await db.prepare("DELETE FROM schedules WHERE id = ?").run(duplicate.id);
  }

  if (duplicates.length > 0) {
    console.log(`Removed ${duplicates.length} duplicate schedule record(s).`);
  }
};

const checkDuplicateRecord = async (tableName: string, data: any, excludeId?: string | number) => {
  const rules = duplicateRules[tableName] || [];

  for (const rule of rules) {
    if (rule.fields.some(field => data[field] == null || data[field] === "")) continue;

    const whereClause = rule.fields
      .map(field => shouldUseCaseInsensitiveTextComparison(tableName, field, data[field]) ? `LOWER(TRIM(${field})) = ?` : `${field} = ?`)
      .join(" AND ");
    const values = rule.fields.map(field =>
      shouldUseCaseInsensitiveTextComparison(tableName, field, data[field]) ? normalizeDuplicateValue(data[field]) : data[field]
    );
    const query = `SELECT id FROM ${tableName} WHERE ${whereClause}${excludeId ? " AND id != ?" : ""}`;
    const existing = await db.prepare(query).get(...values, ...(excludeId ? [excludeId] : []));

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
      ...(excludeId ? [excludeId] : [])
    ) as any[];

    const conflictingSchedule = candidates.find(candidate => schedulesConflict(candidate, data));
    if (conflictingSchedule) {
      return "Schedule slot for this room, program, branch, and section already exists. Duplicate records are not allowed.";
    }
  }

  if (tableName === "rooms") {
    const candidateTokens = Array.from(new Set([
      normalizeDuplicateValue(data.room_number),
      ...getRoomAliasTokens(data.room_aliases),
    ].filter(Boolean)));

    if (candidateTokens.length > 0) {
      const roomCandidates = await db.prepare(`SELECT id, room_number, room_aliases FROM rooms ${excludeId ? "WHERE id != ?" : ""}`).all(
        ...(excludeId ? [excludeId] : [])
      ) as any[];

      const conflictingRoom = roomCandidates.find(room => {
        const existingTokens = new Set([
          normalizeDuplicateValue(room.room_number),
          ...getRoomAliasTokens(room.room_aliases),
        ].filter(Boolean));
        return candidateTokens.some(token => existingTokens.has(token));
      });

      if (conflictingRoom) {
        return "Room number or alias already exists. Shared venue labels must be unique across Room Management.";
      }
    }
  }

  return null;
};

const BULK_IMPORT_SUPPORTED_TABLES = new Set([
  "users",
  "campuses",
  "buildings",
  "blocks",
  "floors",
  "rooms",
  "schools",
  "departments",
  "department_allocations",
  "timing_profiles",
  "academic_calendars",
  "batch_room_allocations",
  "equipment",
  "schedules",
  "maintenance",
]);

const hasImportMatchValue = (value: any) => value !== undefined && value !== null && value !== "";

const normalizeImportMatchValue = (value: any) =>
  value?.toString().trim().toLowerCase().replace(/\s+/g, " ") || "";

const SERVER_PAGINATION_TABLES = new Set([
  "rooms",
  "academic_calendars",
  "batch_room_allocations",
  "department_allocations",
  "schedules",
]);

const compareServerSortValues = (left: any, right: any) => {
  const leftValue = left == null ? "" : left.toString();
  const rightValue = right == null ? "" : right.toString();
  return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: "base" });
};

const getAcademicCalendarEventRank = (eventType: any) => {
  const normalized = normalizeImportMatchValue(eventType);
  if (normalized.includes("semester")) return 0;
  if (normalized.includes("class")) return 1;
  if (normalized.includes("exam") || normalized.includes("ciat")) return 2;
  if (normalized.includes("holiday")) return 3;
  if (normalized.includes("vacation")) return 4;
  if (normalized.includes("registration")) return 5;
  if (normalized.includes("orientation")) return 6;
  if (normalized.includes("project")) return 7;
  if (normalized.includes("internship")) return 8;
  return 99;
};

const compareAcademicCalendarItems = (
  left: any,
  right: any,
  departmentNamesById: Map<string, string>,
  sortKey?: string,
  sortDir: "asc" | "desc" = "asc",
) => {
  if (sortKey && sortKey !== "start_date") {
    const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
    return sortDir === "desc" ? -comparison : comparison;
  }

  const departmentCompare = compareServerSortValues(
    departmentNamesById.get(left?.department_id?.toString() || "") || "",
    departmentNamesById.get(right?.department_id?.toString() || "") || "",
  );
  if (departmentCompare !== 0) {
    return sortDir === "desc" ? -departmentCompare : departmentCompare;
  }

  const startCompare = compareServerSortValues(left?.start_date, right?.start_date);
  if (startCompare !== 0) {
    return sortDir === "desc" ? -startCompare : startCompare;
  }

  const specializationCompare = compareServerSortValues(left?.specialization, right?.specialization);
  if (specializationCompare !== 0) {
    return sortDir === "desc" ? -specializationCompare : specializationCompare;
  }

  const endCompare = compareServerSortValues(left?.end_date, right?.end_date);
  if (endCompare !== 0) {
    return sortDir === "desc" ? -endCompare : endCompare;
  }

  const eventCompare = getAcademicCalendarEventRank(left?.event_type) - getAcademicCalendarEventRank(right?.event_type);
  if (eventCompare !== 0) {
    return sortDir === "desc" ? -eventCompare : eventCompare;
  }

  const titleCompare = compareServerSortValues(left?.title, right?.title);
  if (titleCompare !== 0) {
    return sortDir === "desc" ? -titleCompare : titleCompare;
  }

  const idCompare = compareServerSortValues(left?.id, right?.id);
  return sortDir === "desc" ? -idCompare : idCompare;
};

const scheduleDayOrder = new Map([
  ["monday", 0],
  ["tuesday", 1],
  ["wednesday", 2],
  ["thursday", 3],
  ["friday", 4],
  ["saturday", 5],
  ["sunday", 6],
]);

const parseScheduleTimeToMinutes = (value: any) => {
  const raw = value?.toString().trim() || "";
  if (!raw.includes(":")) return Number.MAX_SAFE_INTEGER;
  const [hour, minute] = raw.split(":").map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return Number.MAX_SAFE_INTEGER;
  return (hour * 60) + minute;
};

const toRomanNumeral = (value: number) => {
  const numerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  return numerals[value] || value.toString();
};

const getYearNumberFromAcademicContext = (yearOfStudy: any, semester: any) => {
  const yearKey = normalizeYearOfStudyKey(yearOfStudy);
  if (yearKey) {
    const parsedYear = parseInt(yearKey, 10);
    if (Number.isFinite(parsedYear)) return parsedYear;
  }
  const semesterNumber = parseSemesterNumber(semester);
  return semesterNumber ? Math.ceil(semesterNumber / 2) : null;
};

const getYearDisplayLabel = (yearOfStudy: any, semester: any) => {
  const yearNumber = getYearNumberFromAcademicContext(yearOfStudy, semester);
  return yearNumber ? `${toRomanNumeral(yearNumber)} Year` : "-";
};

const findMatchingImportRecord = (records: any[], payload: any, uniqueFieldGroups: string[][]) => {
  for (const fields of Array.isArray(uniqueFieldGroups) ? uniqueFieldGroups : []) {
    if (!Array.isArray(fields) || fields.some(field => !hasImportMatchValue(payload?.[field]))) continue;

    const existing = records.find(record =>
      fields.every(field =>
        hasImportMatchValue(record?.[field]) &&
        normalizeImportMatchValue(record[field]) === normalizeImportMatchValue(payload[field])
      )
    );

    if (existing) return existing;
  }

  return null;
};

const findDuplicateRecordInCollection = (
  tableName: string,
  records: any[],
  data: any,
  excludeId?: string | number,
) => {
  const rules = duplicateRules[tableName] || [];

  for (const rule of rules) {
    if (rule.fields.some(field => data[field] == null || data[field] === "")) continue;

    const existing = (Array.isArray(records) ? records : []).find(record => {
      if (excludeId && idsEqual(record?.id, excludeId)) return false;
      return rule.fields.every(field => {
        if (record?.[field] == null || record[field] === "") return false;
        return shouldUseCaseInsensitiveTextComparison(tableName, field, data[field])
          ? normalizeDuplicateValue(record[field]) === normalizeDuplicateValue(data[field])
          : record[field] === data[field];
      });
    });

    if (existing) {
      return `${rule.label} already exists. Duplicate records are not allowed.`;
    }
  }

  if (tableName === "schedules" && data?.day_of_week && data?.start_time && data?.end_time) {
    const candidates = (Array.isArray(records) ? records : []).filter(candidate => {
      if (excludeId && idsEqual(candidate?.id, excludeId)) return false;
      return normalizeDuplicateValue(candidate?.day_of_week) === normalizeDuplicateValue(data.day_of_week) &&
        normalizeDuplicateValue(candidate?.start_time) === normalizeDuplicateValue(data.start_time) &&
        normalizeDuplicateValue(candidate?.end_time) === normalizeDuplicateValue(data.end_time);
    });

    const conflictingSchedule = candidates.find(candidate => schedulesConflict(candidate, data));
    if (conflictingSchedule) {
      return "Schedule slot for this room, program, branch, and section already exists. Duplicate records are not allowed.";
    }
  }

  if (tableName === "rooms") {
    const candidateTokens = Array.from(new Set([
      normalizeDuplicateValue(data.room_number),
      ...getRoomAliasTokens(data.room_aliases),
    ].filter(Boolean)));

    if (candidateTokens.length > 0) {
      const conflictingRoom = (Array.isArray(records) ? records : []).find(room => {
        if (excludeId && idsEqual(room?.id, excludeId)) return false;
        const existingTokens = new Set([
          normalizeDuplicateValue(room.room_number),
          ...getRoomAliasTokens(room.room_aliases),
        ].filter(Boolean));
        return candidateTokens.some(token => existingTokens.has(token));
      });

      if (conflictingRoom) {
        return "Room number or alias already exists. Shared venue labels must be unique across Room Management.";
      }
    }
  }

  return null;
};

const normalizeBulkImportPayload = async (tableName: string, payload: any, existingItem?: any) => {
  let nextPayload = { ...(payload || {}) };

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

const validateBulkImportPayload = async (tableName: string, payload: any, existingItem?: any, context?: BulkImportContext) => {
  const nextRecord = existingItem ? { ...existingItem, ...payload } : payload;
  const duplicateError = context?.records
    ? findDuplicateRecordInCollection(tableName, context.records, nextRecord, existingItem?.id)
    : await checkDuplicateRecord(tableName, nextRecord, existingItem?.id);
  if (duplicateError) throw new Error(duplicateError);

  if (tableName === "rooms") {
    const parentRoom = context?.records ? findRecordById(context.records, nextRecord.parent_room_id) : null;
    const hierarchyError = context?.records && nextRecord?.parent_room_id
      ? (
          existingItem && nextRecord.parent_room_id?.toString() === existingItem.id?.toString()
            ? "A room cannot be inside itself."
            : !parentRoom
              ? "Please select a valid parent room."
              : parentRoom.floor_id?.toString() !== nextRecord.floor_id?.toString()
                ? "The parent room must be on the same floor."
                : null
        )
      : await validateRoomHierarchy(nextRecord, existingItem?.id);
    if (hierarchyError) throw new Error(hierarchyError);
    const restroomValidationError = await getRestroomValidationError(nextRecord);
    if (restroomValidationError) throw new Error(restroomValidationError);
  }

  if (tableName === "department_allocations") {
    const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextRecord.room_id) as any;
    if (!room) throw new Error("Please select a valid room.");
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    if ((parseInt(nextRecord.capacity, 10) || 0) > room.capacity) {
      throw new Error(`Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${nextRecord.capacity}.`);
    }
    payload.room_type = room.room_type;
  }

  if (tableName === "batch_room_allocations") {
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    const departmentAllocationError = await getDepartmentAllocationLinkError(nextRecord.room_id, nextRecord.department_id, nextRecord.semester, context);
    if (departmentAllocationError) throw new Error(departmentAllocationError);
    const overlapError = await getBatchAllocationOverlapError(
      nextRecord,
      existingItem?.id,
      context?.tableName === "batch_room_allocations" ? context.records : undefined,
    );
    if (overlapError) throw new Error(overlapError);
  }

  if (tableName === "schedules") {
    const bookableError = await getBookableRoomError(nextRecord.room_id, context);
    if (bookableError) throw new Error(bookableError);
    payload.schedule_code = await assignScheduleCode(payload, existingItem?.id, existingItem, context);
  }
};

const persistBulkImportRecord = async (tableName: string, payload: any, existingItem?: any, context?: BulkImportContext) => {
  const normalizedPayload = await normalizeBulkImportPayload(tableName, payload, existingItem);
  await validateBulkImportPayload(tableName, normalizedPayload, existingItem, context);

  const fields = Object.keys(normalizedPayload);
  if (fields.length === 0) {
    throw new Error("Import payload is empty.");
  }

  if (existingItem?.id) {
    const setClause = fields.map(field => `${field} = ?`).join(", ");
    const values = [...Object.values(normalizedPayload), existingItem.id];
    if (tableName === "users" && normalizedPayload.password) {
      const passwordIndex = fields.indexOf("password");
      values[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
    }
    await db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...values);
    return { ...existingItem, ...normalizedPayload, id: existingItem.id, __importAction: "updated" as const };
  }

  const placeholders = fields.map(() => "?").join(", ");
  const values = [...Object.values(normalizedPayload)];
  if (tableName === "users" && normalizedPayload.password) {
    const passwordIndex = fields.indexOf("password");
    values[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
  }
  const info = await db.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${placeholders})`).run(...values);
  return { id: info.lastInsertRowid, ...normalizedPayload, __importAction: "created" as const };
};

await cleanupDuplicateSchedules();
await syncBatchAllocationStatuses();

const isPastDateTime = (date: string, time: string) => {
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) || value.getTime() < Date.now();
};

const timesOverlap = (
  existingStart?: string | null,
  existingEnd?: string | null,
  selectedStart?: string | null,
  selectedEnd?: string | null,
) => {
  if (!existingStart || !existingEnd || !selectedStart || !selectedEnd) return false;
  return existingStart < selectedEnd && existingEnd > selectedStart;
};

const isBookableAvailabilityRoom = (room: any) => {
  if (!room) return false;
  if (room.is_bookable === 0) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  if (isNonCapacityRoomType(roomType)) return false;
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  return BOOKABLE_ROOM_TYPE_VALUES.includes(roomType) || BOOKABLE_USAGE_CATEGORY_VALUES.includes(usageCategory || "");
};

const LIVE_AVAILABILITY_EXCLUDED_ROOM_TYPES = new Set([
  "Restroom",
  "Store",
  "Records Room",
  "Utility",
  "Server Room",
  "Electrical Room",
  "Maintenance Room",
]);

const LIVE_AVAILABILITY_EXCLUDED_USAGE_CATEGORIES = new Set([
  "Restroom",
  "Storage",
  "Utility",
]);

const isLiveAvailabilityVisibleRoom = (room: any) => {
  if (!room) return false;
  const roomType = normalizeRoomTypeValue(room.room_type);
  const usageCategory = normalizeUsageCategoryValue(room.usage_category, roomType);
  if (LIVE_AVAILABILITY_EXCLUDED_ROOM_TYPES.has(roomType)) return false;
  if (LIVE_AVAILABILITY_EXCLUDED_USAGE_CATEGORIES.has(usageCategory || "")) return false;
  return true;
};

const LIVE_AVAILABILITY_ROOM_TYPE_GROUPS: Record<string, string[]> = {
  Classroom: [
    "Classroom",
    "Smart Classroom",
    "Lecture Hall",
    "Tutorial Room",
    "Multipurpose Classroom",
    "Multipurpose Lecture Hall",
  ],
  Lab: [
    "Lab",
    "Computer Lab",
    "Research Lab",
    "Language Lab",
    "Workshop",
    "Studio",
    "Classroom Lab",
    "Multipurpose Lab",
  ],
  "Seminar Hall": ["Seminar Hall"],
  Auditorium: ["Auditorium"],
  "Meeting Room": ["Meeting Room", "Conference Room", "Board Room"],
};

const matchesLiveAvailabilityRoomTypeFilter = (room: any, filterValue: string) => {
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

const getSharedAvailabilitySnapshot = async ({
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
  allowedRoomIds = null,
}: {
  date: string;
  startTime: string;
  endTime: string;
  campusId?: string;
  buildingId?: string;
  blockId?: string;
  floorId?: string;
  departmentId?: string;
  roomType?: string;
  minCapacity?: number;
  equipmentFilter?: string;
  includeMaintenanceRooms?: boolean;
  markRecommendedStatus?: boolean;
  visibilityScope?: "bookable" | "live";
  allowedRoomIds?: Set<string> | null;
}) => {
  await ensureBookingColumnsReady();
  const [
    roomsRaw,
    departments,
    departmentAllocations,
    batchAllocations,
    equipment,
    maintenance,
    approvedBookings,
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
    `).all() as Promise<any[]>,
    db.prepare("SELECT id, name FROM departments").all() as Promise<any[]>,
    db.prepare(`
      SELECT da.id, da.room_id, da.department_id, da.semester, d.name as department_name
      FROM department_allocations da
      JOIN departments d ON da.department_id = d.id
      ORDER BY da.id DESC
    `).all() as Promise<any[]>,
    db.prepare(`
      SELECT bra.id, bra.room_id, bra.department_id, bra.program, bra.batch, bra.specialization, bra.academic_year, bra.year_of_study, bra.semester, d.name as department_name
      FROM batch_room_allocations bra
      JOIN departments d ON bra.department_id = d.id
      WHERE bra.start_date <= ? AND bra.end_date >= ? AND bra.status != ?
      ORDER BY bra.id DESC
    `).all(date, date, "Released") as Promise<any[]>,
    db.prepare("SELECT room_id, name, type, condition FROM equipment").all() as Promise<any[]>,
    db.prepare(`
      SELECT
        room_id,
        equipment_name,
        issue_description,
        reported_date,
        assigned_staff,
        status
      FROM maintenance
    `).all() as Promise<any[]>,
    db.prepare("SELECT room_id, faculty_name, event_name, purpose, purpose_type, timing_override, date, start_time, end_time, status FROM bookings WHERE date = ? AND status = 'Approved'").all(date) as Promise<any[]>,
  ]);

  const normalizedRoomType = normalizeRoomTypeValue(roomType);
  const normalizedEquipmentFilter = normalizeDuplicateValue(equipmentFilter || "");
  const departmentNameById = new Map(departments.map((department: any) => [department.id?.toString(), department.name]));
  const equipmentByRoomId = new Map<string, any[]>();
  equipment.forEach((item: any) => {
    const key = item.room_id?.toString();
    if (!key) return;
    if (!equipmentByRoomId.has(key)) equipmentByRoomId.set(key, []);
    equipmentByRoomId.get(key)?.push(item);
  });

  const activeMaintenanceByRoomId = new Map<string, any[]>();
  maintenance.forEach((item: any) => {
    if (item.status === "Completed") return;
    const key = item.room_id?.toString();
    if (!key) return;
    if (!activeMaintenanceByRoomId.has(key)) activeMaintenanceByRoomId.set(key, []);
    activeMaintenanceByRoomId.get(key)?.push(item);
  });

  const allocationNamesByRoomId = new Map<string, string[]>();
  const allocationIdsByRoomId = new Map<string, Set<string>>();
  const applyDepartmentContext = (roomId: any, nextDepartmentId: any, nextDepartmentName?: string | null) => {
    const key = roomId?.toString();
    if (!key) return;
    if (!allocationNamesByRoomId.has(key)) allocationNamesByRoomId.set(key, []);
    if (!allocationIdsByRoomId.has(key)) allocationIdsByRoomId.set(key, new Set<string>());
    if (nextDepartmentName && !allocationNamesByRoomId.get(key)?.includes(nextDepartmentName)) {
      allocationNamesByRoomId.get(key)?.push(nextDepartmentName);
    }
    if (nextDepartmentId) allocationIdsByRoomId.get(key)?.add(nextDepartmentId.toString());
  };

  departmentAllocations.forEach((allocation: any) =>
    applyDepartmentContext(allocation.room_id, allocation.department_id, allocation.department_name || departmentNameById.get(allocation.department_id?.toString()))
  );
  batchAllocations.forEach((allocation: any) =>
    applyDepartmentContext(allocation.room_id, allocation.department_id, allocation.department_name || departmentNameById.get(allocation.department_id?.toString()))
  );

  const roomCandidates = roomsRaw.filter((room: any) => {
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
      const labels = (equipmentByRoomId.get(room.id?.toString() || "") || []).map((item: any) => normalizeDuplicateValue(item.name));
      if (!labels.some((label: string) => label.includes(normalizedEquipmentFilter))) return false;
    }
    return true;
  });

  const roomLookupVariantsById = new Map<string, Set<string>>();
  roomCandidates.forEach((room: any) => {
    const roomKey = room.id?.toString();
    if (!roomKey) return;
    roomLookupVariantsById.set(roomKey, getAvailabilityRoomLookupVariants(room));
  });

  const assignScheduleToRoom = (map: Map<string, any[]>, roomKey: string, schedule: any) => {
    if (!roomKey) return;
    if (!map.has(roomKey)) map.set(roomKey, []);
    map.get(roomKey)?.push(schedule);
  };

  const busySchedules = await getEffectiveSchedulesForDate(
    date,
    schedule => timesOverlap(schedule.start_time, schedule.end_time, startTime, endTime),
  );

  const scheduleByRoomId = new Map<string, any[]>();
  busySchedules.forEach((schedule: any) => {
    const matchedRoomKeys = new Set<string>();
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

  const approvedBookingsByRoomId = new Map<string, any[]>();
  approvedBookings
    .filter((booking: any) => timesOverlap(booking.start_time, booking.end_time, startTime, endTime))
    .forEach((booking: any) => {
      const key = booking.room_id?.toString();
      if (!key) return;
      if (!approvedBookingsByRoomId.has(key)) approvedBookingsByRoomId.set(key, []);
      approvedBookingsByRoomId.get(key)?.push(booking);
    });

  const getAudienceLabel = (schedule: any) => {
    const parts = [
      schedule.program,
      schedule.specialization,
      schedule.section ? `Section ${schedule.section}` : "",
      schedule.year_of_study,
      schedule.semester,
    ].filter(Boolean);
    return parts.join(" • ");
  };

  const roomRows = roomCandidates.map((room: any) => {
    const roomKey = room.id?.toString() || "";
    const roomBookable = isBookableAvailabilityRoom(room);
    const roomTypeLabel = normalizeRoomTypeValue(room.room_type) || room.room_type || "Room";
    const roomCapacity = parseInt(room.capacity, 10) || 0;
    const roomEquipment = (equipmentByRoomId.get(roomKey) || []).map((item: any) => item.name).filter(Boolean);
    const roomMaintenance = activeMaintenanceByRoomId.get(roomKey) || [];
    const roomSchedules = scheduleByRoomId.get(roomKey) || [];
    const roomBookings = approvedBookingsByRoomId.get(roomKey) || [];
    const roomDepartments = allocationNamesByRoomId.get(roomKey) || [];
    const currentDepartmentMatch = departmentId && allocationIdsByRoomId.get(roomKey)?.has(departmentId);
    const usageCount = roomSchedules.length + roomBookings.length;
    const capacityGap = Math.max(0, roomCapacity - (minCapacity || 0));
    const hasCapacityMismatch = (minCapacity || 0) > 0 && roomCapacity < (minCapacity || 0);

    let status = roomBookable ? "Available" : "Not Bookable";
    let statusReason = roomBookable
      ? "Physically vacant for the selected date and time. Academic timing-profile rules are checked only when an Academic Regular booking is confirmed."
      : "Physically vacant for the selected date and time, but this room is not configured as directly bookable.";
    let currentUsage = "";

    if (roomMaintenance.length > 0 || room.status === "Maintenance") {
      status = "Maintenance";
      statusReason = roomMaintenance
        .map((item: any) => `${item.equipment_name || "Maintenance issue"}${item.issue_description ? ` - ${item.issue_description}` : ""}${item.status ? ` (${item.status})` : ""}${item.reported_date ? ` [Reported ${item.reported_date}]` : ""}`)
        .join("; ") || "Room is marked under maintenance.";
    } else if (hasCapacityMismatch) {
      status = "Capacity Mismatch";
      statusReason = `Room capacity is ${roomCapacity}, below the required ${minCapacity}.`;
    } else if (roomSchedules.length > 0) {
      const sameSession = roomSchedules.length > 1 && roomSchedules.every((schedule: any) =>
        normalizeDuplicateValue(schedule.course_name) === normalizeDuplicateValue(roomSchedules[0]?.course_name) &&
        normalizeDuplicateValue(schedule.faculty) === normalizeDuplicateValue(roomSchedules[0]?.faculty)
      );
      status = "Occupied";
      currentUsage = `${sameSession ? "Combined Class" : "Scheduled"}: ${roomSchedules[0]?.course_name || "Class"}`;
      statusReason = roomSchedules
        .map((schedule: any) => {
          const contextLabel = getAudienceLabel(schedule);
          const departmentName = departmentNameById.get(schedule.department_id?.toString()) || "";
          return [
            schedule.course_name || "Scheduled class",
            schedule.faculty ? `Faculty: ${schedule.faculty}` : "",
            departmentName,
            contextLabel,
          ].filter(Boolean).join(" • ");
        })
        .join("; ");
    } else if (roomBookings.length > 0) {
      status = "Event Booked";
      currentUsage = roomBookings[0]?.event_name || "Approved booking";
      statusReason = roomBookings
        .map((booking: any) =>
          [
            booking.event_name || "Approved booking",
            booking.faculty_name ? `Booked by ${booking.faculty_name}` : "",
            booking.purpose ? `Purpose: ${booking.purpose}` : "",
            booking.purpose_type ? `Type: ${booking.purpose_type}` : "",
            Number(booking.timing_override || 0) === 1 ? "Temporary timing override for this booked period only" : "",
          ].filter(Boolean).join(" • ")
        )
        .join("; ");
    }

    let recommendationScore = 0;
    if (status === "Available") {
      recommendationScore += roomBookable ? 1000 : 0;
      recommendationScore += currentDepartmentMatch ? 150 : 0;
      recommendationScore += normalizedEquipmentFilter && roomEquipment.some((label: string) => normalizeDuplicateValue(label).includes(normalizedEquipmentFilter)) ? 80 : 0;
      recommendationScore += roomCapacity >= (minCapacity || 0) ? Math.max(0, 120 - capacityGap) : 0;
      recommendationScore += Math.max(0, 40 - (usageCount * 10));
    }

    let nextAvailableSlot = "Available for selected time";
    if (status !== "Available" && status !== "Best Suitable") {
      const blockingEndTimes = [
        ...roomSchedules.map((schedule: any) => schedule.end_time).filter(Boolean),
        ...roomBookings.map((booking: any) => booking.end_time).filter(Boolean),
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
      _sourceRoom: room,
    };
  });

  const recommendedRooms = roomRows
    .filter((room: any) => room.availableForBooking)
    .sort((left: any, right: any) => right.recommendationScore - left.recommendationScore)
    .slice(0, 3)
    .map((room: any, index: number) => ({
      ...room,
      status: "Best Suitable",
      availableForBooking: true,
      statusReason: [
        `Recommended because capacity is ${room.capacity}.`,
        room.mappedToSelectedDepartment ? "Mapped to the selected department." : "",
        normalizedEquipmentFilter && room.equipment.some((label: string) => normalizeDuplicateValue(label).includes(normalizedEquipmentFilter))
          ? `${equipmentFilter} is available.`
          : "",
        "Physically vacant for the selected real-time window with no timetable clash, no approved booking, and not under maintenance.",
      ].filter(Boolean).join(" "),
      currentUsage: `Recommendation rank #${index + 1}`,
    }));

  const recommendedRoomIds = new Set(recommendedRooms.map((room: any) => room.id?.toString()));
  const statusAdjustedRooms = roomRows.map((room: any) => {
    if (!markRecommendedStatus || !recommendedRoomIds.has(room.id?.toString())) return room;
    const recommendedRoom = recommendedRooms.find((item: any) => idsEqual(item.id, room.id));
    return recommendedRoom ? { ...room, ...recommendedRoom } : room;
  });

  const sortedRooms = [...statusAdjustedRooms].sort((left: any, right: any) => {
    if (left.buildingName !== right.buildingName) {
      return left.buildingName.localeCompare(right.buildingName, undefined, { sensitivity: "base" });
    }
    if (left.blockName !== right.blockName) {
      return left.blockName.localeCompare(right.blockName, undefined, { numeric: true, sensitivity: "base" });
    }
    const leftFloor = Number(left.floorName);
    const rightFloor = Number(right.floorName);
    if (Number.isFinite(leftFloor) && Number.isFinite(rightFloor) && leftFloor !== rightFloor) {
      return leftFloor - rightFloor;
    }
    if ((left.floorName || "") !== (right.floorName || "")) {
      return String(left.floorName || "").localeCompare(String(right.floorName || ""), undefined, { numeric: true, sensitivity: "base" });
    }
    return (left.roomNumber || "").localeCompare((right.roomNumber || ""), undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    summary: {
      totalRooms: sortedRooms.length,
      available: sortedRooms.filter((room: any) => room.status === "Available").length,
      occupied: sortedRooms.filter((room: any) => room.status === "Occupied").length,
      booked: sortedRooms.filter((room: any) => room.status === "Event Booked").length,
      maintenance: sortedRooms.filter((room: any) => room.status === "Maintenance").length,
      notBookable: sortedRooms.filter((room: any) => room.status === "Not Bookable").length,
      capacityMismatch: sortedRooms.filter((room: any) => room.status === "Capacity Mismatch").length,
      bestSuitable: recommendedRooms.length,
    },
    recommendedRooms,
    rooms: sortedRooms,
  };
};

const addMinutesToTimeValue = (time: string, minutesToAdd: number) => {
  const [hours, minutes] = (time || "00:00").split(":").map(Number);
  if ([hours, minutes].some(value => Number.isNaN(value))) return time || "00:00";
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  date.setMinutes(date.getMinutes() + minutesToAdd);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
};

const getCurrentOperationalRoomSnapshot = async (date: string, time: string) => {
  const snapshot = await getSharedAvailabilitySnapshot({
    date,
    startTime: time,
    endTime: addMinutesToTimeValue(time, 1),
    includeMaintenanceRooms: true,
    markRecommendedStatus: false,
    visibilityScope: "live",
  });

  return {
    summary: snapshot.summary,
    rooms: snapshot.rooms.map((room: any) => {
      const { _sourceRoom, ...payload } = room;
      return payload;
    }),
  };
};

const getBookingDepartmentName = async (booking: any) => {
  if (!booking?.department_id) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(booking.department_id) as any;
  return department?.name || null;
};

const getDigitalTwinCategoryLabel = (room: any, status?: string) => {
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
    "Multipurpose Lecture Hall",
  ].includes(normalizedRoomType)) return "Classrooms";
  if ([
    "Lab",
    "Computer Lab",
    "Research Lab",
    "Language Lab",
    "Workshop",
    "Studio",
    "Classroom Lab",
    "Multipurpose Lab",
  ].includes(normalizedRoomType)) return "Labs";
  if (normalizedRoomType === "Seminar Hall") return "Seminar Halls";
  if (normalizedRoomType === "Auditorium") return "Auditoriums";
  if (["Meeting Room", "Conference Room", "Board Room"].includes(normalizedRoomType)) return "Meeting Rooms";
  return "Other";
};

const isDecisionRole = (role: string) => isAdminRole(role) || ["Dean (P&M)", "Deputy Dean (P&M)"].includes(role);
const openBookingStatuses = ["Pending", "HOD Recommended", "Approved"];

const getApprovedBookingConflict = async (booking: any, excludeId?: string | number) => {
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
    ...(excludeId ? [excludeId] : []),
    booking.start_time,
    booking.end_time
  ) as any;
};

const getDuplicateOpenBookingRequest = async (booking: any, excludeId?: string | number) => {
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
    ...(excludeId ? [excludeId] : [])
  ) as any;
};

const getCompetingOpenBookingRequests = async (booking: any, excludeId?: string | number) => {
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
    ...(excludeId ? [excludeId] : []),
    booking.start_time,
    booking.end_time
  ) as any[];
};

const notifyBookingAuthorities = async (booking: any, title: string, message: string) => {
  const departmentName = await getBookingDepartmentName(booking);
  if (departmentName) {
    await createNotification("HOD", null, title, message, departmentName);
  }
  await createNotification("Dean (P&M)", null, title, message);
  await createNotification("Deputy Dean (P&M)", null, title, message);
};

await backfillNotificationsIfEmpty();

const createCrudRoutes = (tableName: string, idField: string = "id") => {
  app.get(`/api/${tableName}`, authenticate, async (req, res) => {
    try {
      const wantsPagination = SERVER_PAGINATION_TABLES.has(tableName) && req.query.paginate?.toString() === "1";
      const wantsServerQuery = SERVER_PAGINATION_TABLES.has(tableName) && (
        wantsPagination ||
        !!req.query.q?.toString().trim() ||
        !!req.query.sortKey?.toString().trim()
      );
      const requestedSearch = req.query.q?.toString().trim() || "";
      const requestedSortKey = req.query.sortKey?.toString().trim() || "";
      const requestedSortDir = normalizeImportMatchValue(req.query.sortDir) === "desc" ? "desc" : "asc";
      const requestedPage = Math.max(parseInt(req.query.page?.toString() || "1", 10) || 1, 1);
      const requestedPageSize = Math.min(Math.max(parseInt(req.query.pageSize?.toString() || "50", 10) || 50, 1), 200);
      const searchFields = (req.query.searchFields?.toString() || "")
        .split(",")
        .map(field => field.trim())
        .filter(Boolean);

      if (tableName === "bookings") {
        const bookings = await db.prepare(`
          SELECT bk.*, r.room_number, d.name as department_name
          FROM bookings bk
          LEFT JOIN rooms r ON bk.room_id = r.id
          LEFT JOIN departments d ON bk.department_id = d.id
        `).all();
        const user = (req as any).user;
        if (isDecisionRole(user.role)) return res.json(bookings);
        if (user.role === "Dean") {
          const scope = user.school
            ? await getSchoolRecordByName(user.school).then(async (school) => {
              if (!school) return { departmentIdsInSchool: [] as string[] };
              const siblingDepartments = await db.prepare(`SELECT id FROM departments WHERE school_id = ?`).all(school.id) as any[];
              return {
                departmentIdsInSchool: siblingDepartments
                  .map((item: any) => item?.id?.toString())
                  .filter(Boolean),
              };
            })
            : await getDepartmentScopeByName(user.department);
          if (scope.departmentIdsInSchool.length > 0) {
            const allowedDepartmentIds = new Set(scope.departmentIdsInSchool);
            return res.json(bookings.filter((booking: any) =>
              booking.faculty_name === user.name ||
              (booking.department_id != null && allowedDepartmentIds.has(booking.department_id.toString()))
            ));
          }
          return res.json(bookings.filter((booking: any) => booking.faculty_name === user.name));
        }
        if (user.role === "HOD") {
          return res.json(bookings.filter((booking: any) =>
            booking.faculty_name === user.name || (!!user.department && booking.department_name === user.department)
          ));
        }
        return res.json(bookings.filter((booking: any) => booking.faculty_name === user.name));
      }

      if (tableName === "batch_room_allocations") {
        await syncBatchAllocationStatuses();
      }

      if (wantsServerQuery) {
        const rawColumns = db.dialect === "postgres"
          ? (await db.prepare(`SELECT column_name as name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`).all(tableName) as any[])
          : (await db.prepare(`PRAGMA table_info(${tableName})`).all() as any[]);
        const tableColumns = rawColumns.map((column: any) => column?.name?.toString()).filter(Boolean);
        const allowedSearchFields = (searchFields.length > 0 ? searchFields : tableColumns)
          .filter(field => tableColumns.includes(field));
        const sortKey = tableColumns.includes(requestedSortKey) ? requestedSortKey : (tableColumns.includes("id") ? "id" : tableColumns[0]);

        if (tableName === "schedules") {
          let scheduleItems = await db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
          scheduleItems = deduplicateSchedules(await backfillMissingScheduleCodes(scheduleItems as any[])).kept;
          const requestedDate = normalizeIsoDate(req.query.date);
          if (requestedDate) {
            scheduleItems = await filterSchedulesByAcademicCalendar(scheduleItems, requestedDate);
          }
          const scheduleDepartmentId = req.query.department_id?.toString() || "";
          const scheduleSchoolId = req.query.school_id?.toString() || "";
          const scheduleProgram = req.query.program?.toString().trim() || "";
          const scheduleYear = req.query.year?.toString().trim() || "";
          const scheduleSpecialization = req.query.specialization?.toString().trim() || "";
          const scheduleRoomId = req.query.room_id?.toString() || "";
          const scheduleDay = req.query.day_of_week?.toString().trim() || "";
          const scheduleCampusId = req.query.campus_id?.toString() || "";
          const scheduleBuildingId = req.query.building_id?.toString() || "";
          const scheduleBlockId = req.query.block_id?.toString() || "";
          const scheduleFloorId = req.query.floor_id?.toString() || "";
          if (
            scheduleDepartmentId || scheduleSchoolId || scheduleProgram || scheduleYear || scheduleSpecialization ||
            scheduleRoomId || scheduleDay || scheduleCampusId || scheduleBuildingId || scheduleBlockId || scheduleFloorId
          ) {
            const departments = await db.prepare("SELECT id, school_id FROM departments").all() as any[];
            const rooms = await db.prepare("SELECT id, floor_id, room_id, room_number, room_name, lab_name, room_section_name, room_aliases FROM rooms").all() as any[];
            const floors = await db.prepare("SELECT id, block_id FROM floors").all() as any[];
            const blocks = await db.prepare("SELECT id, building_id FROM blocks").all() as any[];
            const buildings = await db.prepare("SELECT id, campus_id FROM buildings").all() as any[];
            const departmentById = new Map(departments.map(department => [department.id?.toString(), department]));
            const { roomIdsByLookupVariant } = buildRoomLookupVariantMaps(rooms);
            const roomById = new Map(rooms.map(room => [room.id?.toString(), room]));
            const floorById = new Map(floors.map(floor => [floor.id?.toString(), floor]));
            const blockById = new Map(blocks.map(block => [block.id?.toString(), block]));
            const buildingById = new Map(buildings.map(building => [building.id?.toString(), building]));

            scheduleItems = scheduleItems.filter((schedule: any) => {
              const resolvedRoomIds = scheduleRoomId ? getResolvedScheduleRoomIds(schedule, roomIdsByLookupVariant) : null;
              if (scheduleDepartmentId && !idsEqual(schedule?.department_id, scheduleDepartmentId)) return false;
              if (scheduleSchoolId) {
                const department = departmentById.get(schedule?.department_id?.toString());
                if (!idsEqual(department?.school_id, scheduleSchoolId)) return false;
              }
              if (scheduleProgram && normalizeScheduleProgramValue(schedule?.program) !== normalizeScheduleProgramValue(scheduleProgram)) return false;
              if (scheduleYear) {
                const yearLabel = getYearDisplayLabel(schedule?.year_of_study, schedule?.semester);
                if (yearLabel !== scheduleYear) return false;
              }
              if (scheduleSpecialization && normalizeImportMatchValue(schedule?.specialization) !== normalizeImportMatchValue(scheduleSpecialization)) return false;
              if (scheduleRoomId && !resolvedRoomIds?.has(scheduleRoomId)) return false;
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
            scheduleItems = scheduleItems.filter((item: any) =>
              allowedSearchFields.some(field =>
                item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey === "day_of_week") {
            scheduleItems = scheduleItems.slice().sort((left: any, right: any) => {
              const dayCompare = (scheduleDayOrder.get(normalizeImportMatchValue(left?.day_of_week)) ?? Number.MAX_SAFE_INTEGER) -
                (scheduleDayOrder.get(normalizeImportMatchValue(right?.day_of_week)) ?? Number.MAX_SAFE_INTEGER);
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
            scheduleItems = scheduleItems.slice().sort((left: any, right: any) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(scheduleItems);
          }
          const total = scheduleItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: scheduleItems.slice(startIndex, startIndex + requestedPageSize),
            total,
            page: requestedPage,
            pageSize: requestedPageSize,
          });
        }

        if (tableName === "batch_room_allocations") {
          let allocationItems = await db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
          const schoolId = req.query.school_id?.toString() || "";
          const departmentId = req.query.department_id?.toString() || "";
          const status = req.query.status?.toString().trim() || "";
          if (schoolId || departmentId || status) {
            allocationItems = allocationItems.filter((item: any) => {
              const computedStatus = deriveBatchAllocationStatus(
                normalizeIsoDate(item?.start_date),
                normalizeIsoDate(item?.end_date),
                item?.status,
              );
              if (schoolId && !idsEqual(item?.school_id, schoolId)) return false;
              if (departmentId && !idsEqual(item?.department_id, departmentId)) return false;
              if (status && computedStatus !== status) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            allocationItems = allocationItems.filter((item: any) =>
              allowedSearchFields.some(field =>
                item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            allocationItems = allocationItems.slice().sort((left: any, right: any) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(allocationItems);
          }
          const total = allocationItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: allocationItems.slice(startIndex, startIndex + requestedPageSize),
            total,
            page: requestedPage,
            pageSize: requestedPageSize,
          });
        }

        if (tableName === "department_allocations") {
          let allocationItems = await db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
          const schoolId = req.query.school_id?.toString() || "";
          const departmentId = req.query.department_id?.toString() || "";
          const semester = req.query.semester?.toString().trim() || "";
          if (schoolId || departmentId || semester) {
            allocationItems = allocationItems.filter((item: any) => {
              if (schoolId && !idsEqual(item?.school_id, schoolId)) return false;
              if (departmentId && !idsEqual(item?.department_id, departmentId)) return false;
              if (semester && item?.semester?.toString() !== semester) return false;
              return true;
            });
          }
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            allocationItems = allocationItems.filter((item: any) =>
              allowedSearchFields.some(field =>
                item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            allocationItems = allocationItems.slice().sort((left: any, right: any) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(allocationItems);
          }
          const total = allocationItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: allocationItems.slice(startIndex, startIndex + requestedPageSize),
            total,
            page: requestedPage,
            pageSize: requestedPageSize,
          });
        }

        if (tableName === "rooms") {
          let roomItems = await db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
          const campusId = req.query.campus_id?.toString() || "";
          const buildingId = req.query.building_id?.toString() || "";
          const blockId = req.query.block_id?.toString() || "";
          const floorId = req.query.floor_id?.toString() || "";
          if (campusId || buildingId || blockId || floorId) {
            const floors = await db.prepare("SELECT id, block_id FROM floors").all() as any[];
            const blocks = await db.prepare("SELECT id, building_id FROM blocks").all() as any[];
            const buildings = await db.prepare("SELECT id, campus_id FROM buildings").all() as any[];
            const floorById = new Map(floors.map(floor => [floor.id?.toString(), floor]));
            const blockById = new Map(blocks.map(block => [block.id?.toString(), block]));
            const buildingById = new Map(buildings.map(building => [building.id?.toString(), building]));

            roomItems = roomItems.filter((item: any) => {
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
            roomItems = roomItems.filter((item: any) =>
              allowedSearchFields.some(field =>
                item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          if (sortKey) {
            roomItems = roomItems.slice().sort((left: any, right: any) => {
              const comparison = compareServerSortValues(left?.[sortKey], right?.[sortKey]);
              return requestedSortDir === "desc" ? -comparison : comparison;
            });
          }
          if (!wantsPagination) {
            return res.json(roomItems);
          }
          const total = roomItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: roomItems.slice(startIndex, startIndex + requestedPageSize),
            total,
            page: requestedPage,
            pageSize: requestedPageSize,
          });
        }

        if (tableName === "academic_calendars") {
          let calendarItems = await db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
          if (requestedSearch && allowedSearchFields.length > 0) {
            const normalizedSearch = requestedSearch.toLowerCase();
            calendarItems = calendarItems.filter((item: any) =>
              allowedSearchFields.some(field =>
                item?.[field] != null && item[field].toString().toLowerCase().includes(normalizedSearch)
              )
            );
          }
          const departments = await db.prepare("SELECT id, name FROM departments").all() as any[];
          const departmentNamesById = new Map(
            departments.map((department: any) => [department.id?.toString() || "", department.name?.toString() || ""])
          );
          calendarItems = calendarItems.slice().sort((left: any, right: any) =>
            compareAcademicCalendarItems(left, right, departmentNamesById, sortKey, requestedSortDir)
          );
          if (!wantsPagination) {
            return res.json(calendarItems);
          }
          const total = calendarItems.length;
          const startIndex = (requestedPage - 1) * requestedPageSize;
          return res.json({
            items: calendarItems.slice(startIndex, startIndex + requestedPageSize),
            total,
            page: requestedPage,
            pageSize: requestedPageSize,
          });
        }

        const whereClauses: string[] = [];
        const values: any[] = [];
        if (requestedSearch && allowedSearchFields.length > 0) {
          const searchClause = allowedSearchFields
            .map(field => `LOWER(CAST(${field} AS TEXT)) LIKE ?`)
            .join(" OR ");
          whereClauses.push(`(${searchClause})`);
          const searchValue = `%${requestedSearch.toLowerCase()}%`;
          allowedSearchFields.forEach(() => values.push(searchValue));
        }
        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
        const countRow = await db.prepare(`SELECT COUNT(*) as total FROM ${tableName} ${whereSql}`).get(...values) as any;
        const total = Number(countRow?.total || 0);
        const items = await db.prepare(`
          SELECT * FROM ${tableName}
          ${whereSql}
          ORDER BY ${sortKey} ${requestedSortDir.toUpperCase()}
          LIMIT ? OFFSET ?
        `).all(...values, requestedPageSize, (requestedPage - 1) * requestedPageSize) as any[];
        if (!wantsPagination) {
          return res.json(items);
        }
        return res.json({
          items,
          total,
          page: requestedPage,
          pageSize: requestedPageSize,
        });
      }

      const items = await db.prepare(`SELECT * FROM ${tableName}`).all();
      if (tableName === "schedules") {
        const hydratedItems = await backfillMissingScheduleCodes(items as any[]);
        const deduplicatedItems = deduplicateSchedules(hydratedItems as any[]).kept;
        const requestedDate = normalizeIsoDate(req.query.date);
        if (requestedDate) {
          return res.json(await filterSchedulesByAcademicCalendar(deduplicatedItems, requestedDate));
        }
        return res.json(deduplicatedItems);
      }
      if (tableName === "academic_calendars") {
        const departments = await db.prepare("SELECT id, name FROM departments").all() as any[];
        const departmentNamesById = new Map(
          departments.map((department: any) => [department.id?.toString() || "", department.name?.toString() || ""])
        );
        return res.json(
          (items as any[]).slice().sort((left: any, right: any) =>
            compareAcademicCalendarItems(left, right, departmentNamesById, "start_date", "asc")
          )
        );
      }
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${tableName}/import-bulk`, authenticate, async (req, res) => {
    if (!BULK_IMPORT_SUPPORTED_TABLES.has(tableName)) {
      return res.status(404).json({ error: "Bulk import is not supported for this module." });
    }
    if (tableName === "users" && !isAdminRole((req as any).user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can manage users and passwords." });
    }

    try {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      if (entries.length === 0) {
        return res.json({ results: [] });
      }

      const results = await db.transaction(async (transactionDb) => {
        const records = await transactionDb.prepare(`SELECT * FROM ${tableName}`).all() as any[];
        const importContext = createBulkImportContext(tableName, records);
        const scopedPersistBulkImportRecord = async (payload: any, existingItem?: any, context?: BulkImportContext) => {
          const normalizedPayload = await normalizeBulkImportPayload(tableName, payload, existingItem);
          await validateBulkImportPayload(tableName, normalizedPayload, existingItem, context);

          const fields = Object.keys(normalizedPayload);
          if (fields.length === 0) {
            throw new Error("Import payload is empty.");
          }

          if (existingItem?.id) {
            const setClause = fields.map(field => `${field} = ?`).join(", ");
            const values = [...Object.values(normalizedPayload), existingItem.id];
            if (tableName === "users" && normalizedPayload.password) {
              const passwordIndex = fields.indexOf("password");
              values[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
            }
            await transactionDb.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...values);
            return { ...existingItem, ...normalizedPayload, id: existingItem.id, __importAction: "updated" as const };
          }

          const placeholders = fields.map(() => "?").join(", ");
          const values = [...Object.values(normalizedPayload)];
          if (tableName === "users" && normalizedPayload.password) {
            const passwordIndex = fields.indexOf("password");
            values[passwordIndex] = bcrypt.hashSync(normalizedPayload.password, 10);
          }
          const info = await transactionDb.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${placeholders})`).run(...values);
          return { id: info.lastInsertRowid, ...normalizedPayload, __importAction: "created" as const };
        };

        const transactionResults: Array<{ ok: boolean; record?: any; action?: "created" | "updated"; error?: string }> = [];
        for (const entry of entries) {
          const payload = entry?.payload ?? entry;
          const uniqueFieldGroups = Array.isArray(entry?.uniqueFieldGroups) ? entry.uniqueFieldGroups : [];

          try {
            const existingItem = findMatchingImportRecord(records, payload, uniqueFieldGroups);
            const savedRecord = await scopedPersistBulkImportRecord(payload, existingItem, importContext);
            const existingIndex = records.findIndex(record => idsEqual(record?.id, savedRecord?.id));
            if (existingIndex >= 0) {
              records[existingIndex] = { ...records[existingIndex], ...savedRecord };
            } else {
              records.push(savedRecord);
            }
            transactionResults.push({
              ok: true,
              record: savedRecord,
              action: savedRecord.__importAction,
            });
          } catch (err: any) {
            transactionResults.push({
              ok: false,
              error: err?.message || "Import failed.",
            });
          }
        }
        return transactionResults;
      });

      res.json({ results });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post(`/api/${tableName}`, authenticate, async (req, res) => {
    if (tableName === "users" && !isAdminRole((req as any).user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can manage users and passwords." });
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
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(req.body.room_id) as any;
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
        const departmentAllocationError = await getDepartmentAllocationLinkError(req.body.room_id, req.body.department_id, req.body.semester);
        if (departmentAllocationError) return res.status(400).json({ error: departmentAllocationError });
        const overlapError = await getBatchAllocationOverlapError(req.body);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }

      if (tableName === "schedules") {
        const bookableError = await getBookableRoomError(req.body.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        req.body.schedule_code = await assignScheduleCode(req.body);
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
        const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(req.body.department_id) as any;
        if (!department) {
          return res.status(400).json({ error: "Please select a valid department." });
        }
        req.body.purpose_type = normalizeBookingPurposeType(req.body.purpose_type);
        if (!["Pending", "Approved"].includes(req.body.status || "Pending")) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (req.body.status === "Approved" && !(isAdminRole((req as any).user.role) || ["Dean (P&M)"].includes((req as any).user.role))) {
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
        if (!fields.includes("timing_override")) {
          fields.push("timing_override");
          values.push(req.body.timing_override);
        } else {
          values[fields.indexOf("timing_override")] = req.body.timing_override;
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
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && !isAdminRole((req as any).user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can manage users and passwords." });
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
    if (tableName === "rooms") {
      req.body = normalizeRoomPayload(req.body);
    }

    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id) as any;
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
      if (tableName === "schedules") {
        req.body = normalizeSchedulePayload({ ...existingItem, ...req.body });
      }
      req.body = await normalizeHierarchyReferencePayload(tableName, req.body);
      let fields = Object.keys(req.body);
      let setClause = fields.map(f => `${f} = ?`).join(", ");
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
        const room = await db.prepare("SELECT room_number, capacity, room_type, is_bookable FROM rooms WHERE id = ?").get(nextAllocation.room_id) as any;
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
        const departmentAllocationError = await getDepartmentAllocationLinkError(nextAllocation.room_id, nextAllocation.department_id, nextAllocation.semester);
        if (departmentAllocationError) return res.status(400).json({ error: departmentAllocationError });
        const overlapError = await getBatchAllocationOverlapError(nextAllocation, req.params.id);
        if (overlapError) return res.status(400).json({ error: overlapError });
      }

      if (tableName === "schedules") {
        const nextSchedule = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextSchedule.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        req.body.schedule_code = await assignScheduleCode(req.body, req.params.id, existingItem);
      }

      if (tableName === "bookings") {
        const nextBooking = { ...existingItem, ...req.body };
        const bookableError = await getBookableRoomError(nextBooking.room_id);
        if (bookableError) return res.status(400).json({ error: bookableError });
        nextBooking.purpose_type = normalizeBookingPurposeType(nextBooking.purpose_type);
        req.body.purpose_type = nextBooking.purpose_type;
        const requestedStatus = req.body.status;
        const role = (req as any).user.role;
        const isRequester = existingItem.faculty_name === (req as any).user.name;
        const departmentName = await getBookingDepartmentName(nextBooking);
        const isDepartmentHod = role === "HOD" && !!departmentName && departmentName === (req as any).user.department;

        if (requestedStatus === "HOD Recommended") {
          if (!isDepartmentHod) {
            return res.status(403).json({ error: "Only the respective department HOD can recommend this room request." });
          }
          if (existingItem.status !== "Pending") {
            return res.status(400).json({ error: "Only pending requests can be recommended by HOD." });
          }
        }
        if (["Approved", "Rejected", "Postponed"].includes(requestedStatus)) {
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
        if (requestedStatus === "Pending" && !["Rejected", "Postponed"].includes(existingItem.status)) {
          return res.status(400).json({ error: "Only rejected or postponed requests can be reopened." });
        }
        if (requestedStatus === "HOD Recommended") {
          req.body.recommended_by = (req as any).user.name;
        }
        if (["Approved", "Rejected", "Postponed"].includes(requestedStatus)) {
          req.body.decided_by = (req as any).user.name;
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

        const timingPolicy = await getBookingTimingPolicyDetails(nextBooking);
        req.body.timing_override = timingPolicy.timingOverride;
        if (timingPolicy.purposeType === "Academic Regular" && timingPolicy.slots.length > 0 && !timingPolicy.matchesWindow) {
          return res.status(400).json({ error: "Academic Regular bookings must match the active department timing-profile slot window exactly." });
        }
      }

      fields = Object.keys(req.body);
      setClause = fields.map(f => `${f} = ?`).join(", ");
      values = [...Object.values(req.body), req.params.id];
      if (tableName === "users" && req.body.password) {
        const passIdx = fields.indexOf("password");
        values[passIdx] = bcrypt.hashSync(req.body.password, 10);
      }
      await db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE ${idField} = ?`).run(...values);
      if (tableName === "bookings" && req.body.status) {
        const title = req.body.status === "HOD Recommended" ? "Request recommended" : `Request ${req.body.status}`;
        const actor = (req as any).user.name;
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
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(`/api/${tableName}/reset`, authenticate, async (req, res) => {
    if (tableName === "users" && !isAdminRole((req as any).user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can remove users." });
    }
    try {
      if (tableName === "department_allocations") {
        const dependentCount = await db.prepare("SELECT COUNT(*) as total FROM batch_room_allocations").get() as any;
        if ((Number(dependentCount?.total) || 0) > 0) {
          return res.status(400).json({ error: "Batch Room Allocations still depend on Department Allocations. Remove batch allocations first." });
        }
      }
      await db.prepare(`DELETE FROM ${tableName}`).run();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && !isAdminRole((req as any).user?.role)) {
      return res.status(403).json({ error: "Only Admin or Master Admin can remove users." });
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id) as any;
      if (tableName === "department_allocations" && existingItem) {
        const dependentBatchAllocations = await countDependentBatchRoomAllocations(
          existingItem.room_id,
          existingItem.department_id,
          existingItem.semester,
        );
        if (dependentBatchAllocations > 0) {
          return res.status(400).json({ error: "This Department Allocation is still used by Batch Room Allocations. Remove or reassign those batch allocations first." });
        }
      }
      await db.prepare(`DELETE FROM ${tableName} WHERE ${idField} = ?`).run(req.params.id);
      if (tableName === "bookings" && existingItem) {
        const actor = (req as any).user.name;
        const title = "Room request deleted";
        const message = `${actor} deleted ${existingItem.event_name || "a room request"} for ${existingItem.date || "the selected date"}.`;
        await createNotification(null, existingItem.faculty_name, title, message);
        await notifyBookingAuthorities(existingItem, title, message);
      }
      res.json({ success: true });
    } catch (err: any) {
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
    `).all() as any[];

    const oddAllocations = allocations.filter(allocation => normalizeSemesterKey(allocation?.semester) === "odd");

    if (oddAllocations.length === 0) {
      return res.json({ success: true, deletedCount: 0, skippedCount: 0, skipped: [] });
    }

    const skipped: Array<{ id: any; reason: string }> = [];
    let deletedCount = 0;

    for (const allocation of oddAllocations) {
      const dependentBatchAllocations = await countDependentBatchRoomAllocations(
        allocation.room_id,
        allocation.department_id,
        allocation.semester,
      );

      if (dependentBatchAllocations > 0) {
        skipped.push({
          id: allocation.id,
          reason: "Batch Room Allocations still depend on this Odd semester mapping.",
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
      skipped,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

createCrudRoutes("users");
createCrudRoutes("campuses");
createCrudRoutes("buildings");
createCrudRoutes("blocks");
createCrudRoutes("floors");

app.get(`/api/rooms`, authenticate, async (req, res) => {
  try {
    const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();

    // Batch pre-fetch #1: scheduled room IDs (single query via academic calendar logic)
    const activeSchedules = await getEffectiveSchedulesForDate(currentDate, schedule =>
      schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const scheduledRoomIds = new Set(
      (activeSchedules as any[]).map(s => s.room_id?.toString()).filter(Boolean)
    );

    // Batch pre-fetch #2: booked room IDs (single query — replaces N per-room queries)
    const bookedRoomIds = new Set(
      (await db.prepare(`
        SELECT DISTINCT room_id FROM bookings
        WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
      `).all(currentDate, currentTime, currentTime) as any[])
        .map((b: any) => b.room_id?.toString()).filter(Boolean)
    );

    // Push location filtering to SQL with JOINs — eliminates 3 extra lookup queries
    const floorId = req.query.floor_id?.toString() || "";
    const blockId = req.query.block_id?.toString() || "";
    const buildingId = req.query.building_id?.toString() || "";
    const campusId = req.query.campus_id?.toString() || "";

    let roomItems: any[];
    if (floorId || blockId || buildingId || campusId) {
      const whereParts: string[] = [];
      const whereValues: any[] = [];
      if (floorId) { whereParts.push("r.floor_id = ?"); whereValues.push(floorId); }
      if (blockId) { whereParts.push("bl.id = ?"); whereValues.push(blockId); }
      if (buildingId) { whereParts.push("b.id = ?"); whereValues.push(buildingId); }
      if (campusId) { whereParts.push("b.campus_id = ?"); whereValues.push(campusId); }
      roomItems = await db.prepare(`
        SELECT r.* FROM rooms r
        LEFT JOIN floors f ON r.floor_id = f.id
        LEFT JOIN blocks bl ON f.block_id = bl.id
        LEFT JOIN buildings b ON bl.building_id = b.id
        WHERE ${whereParts.join(" AND ")}
      `).all(...whereValues) as any[];
    } else {
      roomItems = await db.prepare(`SELECT * FROM rooms`).all() as any[];
    }

    // Apply scope filter
    if (scopedRoomIds) {
      roomItems = roomItems.filter((room: any) => scopedRoomIds.has(room?.id?.toString?.() || ""));
    }

    // Enrich occupancy using pre-built Sets — O(1) per room, zero DB queries in loop
    const enrichedItems = roomItems.map((room: any) => {
      if (room.status !== 'Available') return room;
      if (scheduledRoomIds.has(room.id?.toString())) return { ...room, status: 'Occupied (Scheduled)' };
      if (bookedRoomIds.has(room.id?.toString())) return { ...room, status: 'Occupied (Booked)' };
      return room;
    });

    const requestedSearch = req.query.q?.toString().trim().toLowerCase() || "";
    const requestedSortKey = req.query.sortKey?.toString().trim() || "room_number";
    const requestedSortDir = normalizeImportMatchValue(req.query.sortDir) === "desc" ? "desc" : "asc";
    const requestedPage = Math.max(parseInt(req.query.page?.toString() || "1", 10) || 1, 1);
    const requestedPageSize = Math.min(Math.max(parseInt(req.query.pageSize?.toString() || "50", 10) || 50, 1), 200);
    const wantsPagination = req.query.paginate?.toString() === "1";
    const wantsServerQuery = wantsPagination || !!requestedSearch || !!req.query.sortKey?.toString().trim();
    const searchFields = (req.query.searchFields?.toString() || "")
      .split(",")
      .map(field => field.trim())
      .filter(Boolean);

    let filteredItems = enrichedItems;

    if (requestedSearch) {
      const allowedSearchFields = searchFields.length > 0
        ? searchFields
        : ["room_id", "room_number", "room_name", "room_type", "status", "usage_category", "lab_name", "room_aliases"];
      filteredItems = filteredItems.filter((room: any) =>
        allowedSearchFields.some((field) =>
          room?.[field] != null && room[field].toString().toLowerCase().includes(requestedSearch)
        )
      );
    }

    filteredItems.sort((left: any, right: any) => {
      const leftValue = left?.[requestedSortKey];
      const rightValue = right?.[requestedSortKey];
      const result = (leftValue ?? "").toString().localeCompare((rightValue ?? "").toString(), undefined, {
        numeric: true,
        sensitivity: "base",
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
        pageSize: requestedPageSize,
      });
    }

    res.json(filteredItems);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`/api/rooms/:roomId/schedule`, authenticate, async (req, res) => {
  try {
    const { roomId } = req.params;
    const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
    if (scopedRoomIds && !scopedRoomIds.has(roomId?.toString?.() || "")) {
      return res.status(404).json({ error: "Room not found in your mapped scope." });
    }
    const { date } = req.query;
    const schedules = await getEffectiveSchedulesForDate(date as string, schedule => idsEqual(schedule.room_id, roomId));
    const bookings = await db.prepare(`SELECT * FROM bookings WHERE room_id = ? AND date = ? AND status = 'Approved'`).all(roomId, date);

    res.json({ schedules, bookings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/schedules/room-index", authenticate, async (req, res) => {
  try {
    const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
    const [rooms, schedulesRaw] = await Promise.all([
      db.prepare("SELECT id, room_id, room_number, room_name, lab_name, room_section_name, room_aliases FROM rooms").all() as Promise<any[]>,
      db.prepare("SELECT * FROM schedules").all() as Promise<any[]>,
    ]);
    const schedules = deduplicateSchedules(await backfillMissingScheduleCodes(schedulesRaw as any[])).kept;
    const { roomIdsByLookupVariant } = buildRoomLookupVariantMaps(rooms as any[]);
    const scheduleCountByRoomId = new Map<string, number>();

    (Array.isArray(schedules) ? schedules : []).forEach((schedule: any) => {
      getResolvedScheduleRoomIds(schedule, roomIdsByLookupVariant).forEach((roomId) => {
        if (scopedRoomIds && !scopedRoomIds.has(roomId)) return;
        scheduleCountByRoomId.set(roomId, (scheduleCountByRoomId.get(roomId) || 0) + 1);
      });
    });

    res.json(Array.from(scheduleCountByRoomId.entries()).map(([roomId, scheduleCount]) => ({
      room_id: roomId,
      schedule_count: scheduleCount,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

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

// --- DASHBOARD STATS ---

app.get("/api/dashboard/stats", authenticate, async (req, res) => {
  try {
    const totalBuildings = await db.prepare("SELECT COUNT(*) as count FROM buildings").get() as any;
    const totalRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms").get() as any;
    const maintenanceRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'Maintenance'").get() as any;
    const equipmentIssues = await db.prepare("SELECT COUNT(*) as count FROM maintenance WHERE status = 'Pending'").get() as any;
    const pendingBookings = await db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'Pending'").get() as any;
    
    // Calculate currently scheduled rooms
    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const daySchedules = await getEffectiveSchedulesForDate(currentDate);
    const activeSchedules = daySchedules.filter(schedule =>
      schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const activeBookings = await db.prepare(`
      SELECT room_id FROM bookings 
      WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime) as any[];
    const activeScheduleRoomIds = new Set(
      activeSchedules.map(item => item.room_id).filter(Boolean)
    );
    const dayScheduleRoomIds = new Set(
      daySchedules.map(item => item.room_id).filter(Boolean)
    );
    const activeBookingRoomIds = new Set(
      activeBookings.map(item => item.room_id).filter(Boolean)
    );
    const occupiedRoomIds = new Set([
      ...activeScheduleRoomIds,
      ...activeBookingRoomIds,
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
      availableNow: availableNow,
      equipmentIssues: equipmentIssues.count,
      pendingBookings: pendingBookings.count,
      // Scheduled rooms for the current day (stable metric), plus live-now subset.
      scheduledRooms: dayScheduleRoomIds.size,
      activeScheduledRooms: activeScheduleRoomIds.size,
      bookedRooms: activeBookingRoomIds.size,
      occupiedRooms: occupiedRoomIds.size,
      recentAlerts
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/dashboard/overview", authenticate, async (_req, res) => {
  try {
    const totalBuildings = await db.prepare("SELECT COUNT(*) as count FROM buildings").get() as any;
    const totalRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms").get() as any;
    const maintenanceRooms = await db.prepare("SELECT COUNT(*) as count FROM rooms WHERE status = 'Maintenance'").get() as any;
    const equipmentIssues = await db.prepare("SELECT COUNT(*) as count FROM maintenance WHERE status = 'Pending'").get() as any;
    const pendingBookings = await db.prepare("SELECT COUNT(*) as count FROM bookings WHERE status = 'Pending'").get() as any;

    const { date: currentDate, time: currentTime } = getCampusDateTimeParts();
    const daySchedules = await getEffectiveSchedulesForDate(currentDate);
    const activeSchedules = daySchedules.filter((schedule: any) =>
      schedule.start_time <= currentTime && schedule.end_time > currentTime
    );
    const activeBookings = await db.prepare(`
      SELECT room_id, event_name, purpose, faculty_name, start_time, end_time FROM bookings
      WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime) as any[];
    const activeScheduleRoomIds = new Set(activeSchedules.map((item: any) => item.room_id).filter(Boolean));
    const dayScheduleRoomIds = new Set(daySchedules.map((item: any) => item.room_id).filter(Boolean));
    const activeBookingRoomIds = new Set(activeBookings.map((item: any) => item.room_id).filter(Boolean));
    const occupiedRoomIds = new Set([...activeScheduleRoomIds, ...activeBookingRoomIds]);
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
    `).all() as any[];

    const rooms = await db.prepare(`
      SELECT r.id, r.room_number, r.room_type, r.parent_room_id, r.room_layout, r.room_name, r.usage_category, r.is_bookable,
             r.lab_name, r.restroom_type, r.capacity, r.status, f.id as floor_id, f.floor_number,
             bld.id as building_id, bld.name as building_name, b.id as block_id, b.name as block_name
      FROM rooms r
      LEFT JOIN floors f ON r.floor_id = f.id
      LEFT JOIN blocks b ON f.block_id = b.id
      LEFT JOIN buildings bld ON b.building_id = bld.id
    `).all() as any[];
    const schedules = await db.prepare("SELECT room_id, department_id, year_of_study, semester, section, start_time, end_time FROM schedules").all() as any[];
    const approvedBookings = await db.prepare("SELECT room_id, date, start_time, end_time FROM bookings WHERE status = 'Approved'").all() as any[];
    const allBookings = await db.prepare("SELECT room_id, status, date FROM bookings").all() as any[];
    const maintenance = await db.prepare("SELECT room_id, status FROM maintenance").all() as any[];
    const departments = await db.prepare("SELECT id, name, school_id FROM departments").all() as any[];
    const schools = await db.prepare("SELECT id, name FROM schools").all() as any[];
    const allocations = await db.prepare(`
      SELECT room_id, department_id, school_id, id
      FROM department_allocations
      ORDER BY id DESC
    `).all() as any[];

    const latestAllocationByRoom = new Map<string, any>();
    allocations.forEach((allocation: any) => {
      const roomKey = allocation.room_id?.toString();
      if (roomKey && !latestAllocationByRoom.has(roomKey)) {
        latestAllocationByRoom.set(roomKey, allocation);
      }
    });

    const calculateHours = (start: string, end: string) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(":").map(Number);
      const [h2, m2] = end.split(":").map(Number);
      return (h2 + m2 / 60) - (h1 + m1 / 60);
    };

    const baseReports = rooms.map((room: any) => {
      const roomSchedules = schedules.filter((schedule: any) => idsEqual(schedule.room_id, room.id));
      const roomApprovedBookings = approvedBookings.filter((booking: any) => idsEqual(booking.room_id, room.id));
      const roomAllBookings = allBookings.filter((booking: any) => idsEqual(booking.room_id, room.id));
      const allocation = latestAllocationByRoom.get(room.id?.toString());
      const inferredDepartmentCounts = new Map<number, number>();
      [...roomSchedules, ...roomAllBookings].forEach((entry: any) => {
        if (!entry.department_id) return;
        inferredDepartmentCounts.set(entry.department_id, (inferredDepartmentCounts.get(entry.department_id) || 0) + 1);
      });
      const inferredDepartmentId = Array.from(inferredDepartmentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
      const resolvedDepartmentId = allocation?.department_id || inferredDepartmentId || null;
      const department = departments.find((dept: any) => dept.id === resolvedDepartmentId);
      const school = schools.find((item: any) => item.id === (allocation?.school_id || department?.school_id || null));
      const maintenanceIssues = maintenance.filter((item: any) => idsEqual(item.room_id, room.id) && item.status !== "Completed").length;
      const scheduledHours = roomSchedules.reduce((acc: number, schedule: any) => acc + calculateHours(schedule.start_time, schedule.end_time), 0);
      const bookedHours = roomApprovedBookings.reduce((acc: number, booking: any) => acc + calculateHours(booking.start_time, booking.end_time), 0);
      const utilization = ((scheduledHours + bookedHours) / 72) * 100;
      const yearTags = Array.from(new Set(roomSchedules
        .map((schedule: any) => {
          const normalizedYear = normalizeYearOfStudyKey(schedule?.year_of_study);
          if (normalizedYear) return normalizedYear;
          const semesterNumber = parseSemesterNumber(schedule?.semester);
          return semesterNumber ? Math.ceil(semesterNumber / 2).toString() : "";
        })
        .filter(Boolean)));
      const semesterTags = Array.from(new Set(roomSchedules
        .map((schedule: any) => normalizeSemesterKey(schedule?.semester))
        .filter(Boolean)))
        .map((tag: string) => tag === "odd" ? "Odd" : tag === "even" ? "Even" : tag);
      const sectionTags = Array.from(new Set(roomSchedules
        .map((schedule: any) => schedule?.section?.toString().trim())
        .filter(Boolean)));

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
        bookingStatuses: Array.from(new Set(roomAllBookings.map((booking: any) => booking.status).filter(Boolean))),
        bookingDates: roomAllBookings.map((booking: any) => booking.date).filter(Boolean),
        approvedBookingDates: roomApprovedBookings.map((booking: any) => booking.date).filter(Boolean),
        yearTags,
        semesterTags,
        sectionTags,
      };
    });

    const classifyRoomMix = (roomTypeValue: any) => {
      const roomType = normalizeRoomTypeValue(roomTypeValue);
      if ([
        "Classroom",
        "Smart Classroom",
        "Lecture Hall",
        "Tutorial Room",
        "Multipurpose Classroom",
        "Multipurpose Lecture Hall",
      ].includes(roomType)) return "classroom";
      if ([
        "Lab",
        "Computer Lab",
        "Research Lab",
        "Language Lab",
        "Workshop",
        "Studio",
        "Classroom Lab",
        "Multipurpose Lab",
      ].includes(roomType)) return "lab";
      return "";
    };

    const roomMix = baseReports.reduce((acc: { classrooms: number; labs: number }, room: any) => {
      const bucket = classifyRoomMix(room.room_type);
      if (bucket === "classroom") acc.classrooms += 1;
      if (bucket === "lab") acc.labs += 1;
      return acc;
    }, { classrooms: 0, labs: 0 });

    const schoolReports = Array.from(new Set(baseReports.map((report: any) => report.school).filter((s: any) => s && s !== "Unmapped"))).map((schoolName: string) => {
      const schoolRooms = baseReports.filter((report: any) => report.school === schoolName);
      const deptCount = new Set(
        schoolRooms
          .map((report: any) => report.department)
          .filter((departmentName: string) => departmentName && departmentName !== "Unmapped")
      ).size;
      const avgUtilization = schoolRooms.reduce((acc: number, report: any) => acc + report.utilization, 0) / (schoolRooms.length || 1);
      const roomTypeAverage = (allowedTypes: string[]) => {
        const matchingRooms = schoolRooms.filter((report: any) => allowedTypes.includes(normalizeRoomTypeValue(report.room_type)));
        if (!matchingRooms.length) return 0;
        return Math.round(matchingRooms.reduce((sum: number, report: any) => sum + report.utilization, 0) / matchingRooms.length);
      };

      return {
        name: schoolName,
        avgUtilization: Math.round(avgUtilization),
        deptCount,
        roomCount: schoolRooms.length,
        classroomUtilization: roomTypeAverage(["Classroom", "Seminar Hall"]),
        labUtilization: roomTypeAverage(["Lab"]),
      };
    }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);

    const topBusyRooms = [...baseReports]
      .filter((room: any) => Number(room.utilization) > 0)
      .sort((a: any, b: any) => (Number(b.utilization) || 0) - (Number(a.utilization) || 0))
      .slice(0, 5)
      .map((room: any) => ({
        room_id: room.room_id,
        room_number: room.room_number,
        building: room.building,
        block: room.block,
        utilization: room.utilization,
      }));

    const lowestUsageRooms = [...baseReports]
      .filter((room: any) => Number(room.utilization) >= 0)
      .sort((a: any, b: any) => (Number(a.utilization) || 0) - (Number(b.utilization) || 0))
      .slice(0, 5)
      .map((room: any) => ({
        room_id: room.room_id,
        room_number: room.room_number,
        building: room.building,
        block: room.block,
        utilization: room.utilization,
      }));

    const utilizationTrend = [...baseReports]
      .map((room: any) => ({ name: room.room_number, utilization: room.utilization }))
      .sort((a: any, b: any) => (Number(b.utilization) || 0) - (Number(a.utilization) || 0))
      .slice(0, 10);

    const reportByRoomId = new Map(baseReports.map((report: any) => [report.room_id?.toString(), report]));
    const liveOperationalSnapshot = await getCurrentOperationalRoomSnapshot(currentDate, currentTime);
    const liveOperationalRoomById = new Map<string, any>(
      (Array.isArray(liveOperationalSnapshot?.rooms) ? liveOperationalSnapshot.rooms : [])
        .map((room: any): [string, any] => [room.id?.toString() || "", room])
        .filter((entry): entry is [string, any] => !!entry[0])
    );

    const digitalTwinRoomRows = rooms.map((room: any) => {
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
        departmentName: roomSnapshot?.departmentName || roomReport?.department || "Unmapped",
      };
    });

    const digitalTwinBuildings = Array.from(
      digitalTwinRoomRows.reduce((acc: Map<string, { buildingId: any; buildingName: string; floors: Map<string, any> }>, room: any) => {
        const buildingKey = room.buildingId?.toString() || room.buildingName;
        if (!acc.has(buildingKey)) {
          acc.set(buildingKey, {
            buildingId: room.buildingId,
            buildingName: room.buildingName,
            floors: new Map<string, any>(),
          });
        }
        const buildingEntry = acc.get(buildingKey)!;
        const floorKey = room.floorId?.toString() || room.floorName;
        if (!buildingEntry.floors.has(floorKey)) {
          buildingEntry.floors.set(floorKey, {
            floorId: room.floorId,
            floorName: room.floorName,
            rooms: [],
          });
        }
        buildingEntry.floors.get(floorKey).rooms.push(room);
        return acc;
      }, new Map())
    )
      .map(([, building]) => ({
        buildingId: building.buildingId,
        buildingName: building.buildingName,
        floors: Array.from(building.floors.values())
          .map((floor: any) => ({
            ...floor,
            rooms: floor.rooms.sort((left: any, right: any) =>
              (left.roomNumber || "").localeCompare((right.roomNumber || ""), undefined, { numeric: true, sensitivity: "base" })
            ),
          }))
          .sort((left: any, right: any) => left.floorName.localeCompare(right.floorName, undefined, { numeric: true, sensitivity: "base" })),
      }))
      .sort((left: any, right: any) => left.buildingName.localeCompare(right.buildingName, undefined, { sensitivity: "base" }));

    const digitalTwinStatusCounts = {
      available: digitalTwinRoomRows.filter((room: any) => room.status === "Available").length,
      occupied: digitalTwinRoomRows.filter((room: any) => room.status === "Occupied").length,
      maintenance: digitalTwinRoomRows.filter((room: any) => room.status === "Maintenance").length,
      eventBooked: digitalTwinRoomRows.filter((room: any) => room.status === "Event Booked").length,
      notBookable: digitalTwinRoomRows.filter((room: any) => room.status === "Not Bookable").length,
    };

    const buildStatusBreakdown = (status: string) => {
      const counts = new Map<string, number>();
      digitalTwinRoomRows
        .filter((room: any) => room.status === status)
        .forEach((room: any) => {
          const category = getDigitalTwinCategoryLabel(room, status);
          counts.set(category, (counts.get(category) || 0) + 1);
        });
      return Array.from(counts.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
    };

    const digitalTwinStatusBreakdowns = {
      available: buildStatusBreakdown("Available"),
      occupied: buildStatusBreakdown("Occupied"),
      maintenance: buildStatusBreakdown("Maintenance"),
      eventBooked: buildStatusBreakdown("Event Booked"),
      notBookable: buildStatusBreakdown("Not Bookable"),
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
        currentTime,
      },
      utilizationTrend,
      schoolReports,
      roomMix,
      topBusyRooms,
      lowestUsageRooms,
      digitalTwinSnapshot: {
        statusCounts: digitalTwinStatusCounts,
        statusBreakdowns: digitalTwinStatusBreakdowns,
        buildings: digitalTwinBuildings,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- VACANCY CHECK ROUTE ---

app.get("/api/rooms/vacant", authenticate, async (req, res) => {
  const { date, time, duration, members } = req.query;
  if (!date || !time || !duration) {
    return res.status(400).json({ error: "Date, time, and duration are required" });
  }

  const minimumCapacity = members !== undefined
    ? parseInt(members as string, 10)
    : null;
  if (members !== undefined && (!Number.isInteger(minimumCapacity) || minimumCapacity < 0)) {
    return res.status(400).json({ error: "Members must be a valid non-negative number." });
  }

  if (isPastDateTime(date as string, time as string)) {
    return res.status(400).json({ error: "Past search times are not allowed." });
  }

  const requestedStart = time as string;
  
  // Calculate end time
  const [h, m] = requestedStart.split(':').map(Number);
  const durationMinutes = Math.round((parseFloat(duration as string) || 1) * 60);
  const endDate = new Date();
  endDate.setHours(h, m || 0, 0, 0);
  endDate.setMinutes(endDate.getMinutes() + durationMinutes);
  const requestedEnd = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;

  const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
  const snapshot = await getSharedAvailabilitySnapshot({
    date: date as string,
    startTime: requestedStart,
    endTime: requestedEnd,
    minCapacity: minimumCapacity ?? 0,
    includeMaintenanceRooms: false,
    markRecommendedStatus: false,
    visibilityScope: "bookable",
    allowedRoomIds: scopedRoomIds,
  });

  const vacantRooms = snapshot.rooms
    .filter((room: any) => room.availableForBooking)
    .map((room: any) => room._sourceRoom);

  res.json(vacantRooms);
});

app.get("/api/live-availability", authenticate, async (req, res) => {
  const date = normalizeIsoDate(req.query.date as string);
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
    const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
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
      allowedRoomIds: scopedRoomIds,
    });

    res.json({
      summary: snapshot.summary,
      recommendedRooms: snapshot.recommendedRooms.map((room: any) => {
        const { _sourceRoom, ...payload } = room;
        return payload;
      }),
      rooms: snapshot.rooms.map((room: any) => {
        const { _sourceRoom, ...payload } = room;
        return payload;
      }),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- USAGE REPORTS & AI SUGGESTIONS ---

app.get("/api/events/search-rooms", authenticate, async (req, res) => {
  const { date, startTime, endTime, strength } = req.query;

  if (!date || !startTime || !endTime || !strength) {
    return res.status(400).json({ error: "Date, start time, end time, and strength are required." });
  }

  if (isPastDateTime(date as string, startTime as string)) {
    return res.status(400).json({ error: "Past event searches are not allowed." });
  }

  if ((startTime as string) >= (endTime as string)) {
    return res.status(400).json({ error: "End time must be later than start time." });
  }

  const targetStrength = parseInt(strength as string, 10);
  if (!Number.isInteger(targetStrength) || targetStrength <= 0) {
    return res.status(400).json({ error: "Strength must be a valid positive number." });
  }

  try {
    const scopedRoomIds = await getScopedMappedRoomIdsForUser((req as any).user);
    const snapshot = await getSharedAvailabilitySnapshot({
      date: date as string,
      startTime: startTime as string,
      endTime: endTime as string,
      minCapacity: 0,
      includeMaintenanceRooms: false,
      markRecommendedStatus: false,
      visibilityScope: "bookable",
      allowedRoomIds: scopedRoomIds,
    });
    const vacantRooms = snapshot.rooms
      .filter((room: any) => room.availableForBooking)
      .map((room: any) => room._sourceRoom);

    // 5. Find single room options
    const singleOptions = vacantRooms
      .filter(r => r.capacity >= targetStrength)
      .sort((a, b) => a.capacity - b.capacity); // Closest fit first

    // 6. Find multi-room options if no single room is large enough or as alternatives
    const multiOptions: any[] = [];
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/reports/utilization", authenticate, async (req, res) => {
  try {
    const getQueryValue = (key: string) => req.query?.[key]?.toString().trim() || "";
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
    const shouldApplyBookingDateScope = Boolean(dateFrom || dateTo) && (reportType === "booking_approvals" || !!bookingStatusFilter);
    const matchesFilterValue = (value: any, expected: string) =>
      !expected || value?.toString().trim().toLowerCase() === expected.trim().toLowerCase();
    const dateMatches = (dates: string[] = []) => {
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
    `).all() as any[];
    const schedules = await db.prepare("SELECT * FROM schedules").all() as any[];
    const bookings = await db.prepare("SELECT * FROM bookings WHERE status = 'Approved'").all() as any[];
    const allBookings = await db.prepare("SELECT * FROM bookings").all() as any[];
    const maintenance = await db.prepare("SELECT * FROM maintenance").all() as any[];
    const departments = await db.prepare("SELECT * FROM departments").all() as any[];
    const schools = await db.prepare("SELECT * FROM schools").all() as any[];
    const allocations = await db.prepare(`
      SELECT room_id, department_id, school_id, id
      FROM department_allocations
      ORDER BY id DESC
    `).all() as any[];

    const calculateHours = (start: string, end: string) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(':').map(Number);
      const [h2, m2] = end.split(':').map(Number);
      return (h2 + m2 / 60) - (h1 + m1 / 60);
    };

    const latestAllocationByRoom = new Map<string, any>();
    allocations.forEach((allocation) => {
      const roomKey = allocation.room_id?.toString();
      if (roomKey && !latestAllocationByRoom.has(roomKey)) {
        latestAllocationByRoom.set(roomKey, allocation);
      }
    });

    const baseReports = rooms.map(room => {
      const roomSchedules = schedules.filter(s => idsEqual(s.room_id, room.id));
      const roomBookings = bookings.filter(b => idsEqual(b.room_id, room.id));
      const allRoomBookings = allBookings.filter(b => idsEqual(b.room_id, room.id));
      const allocation = latestAllocationByRoom.get(room.id?.toString());
      const inferredDepartmentCounts = new Map<number, number>();
      [...roomSchedules, ...allRoomBookings].forEach((entry: any) => {
        if (!entry.department_id) return;
        inferredDepartmentCounts.set(entry.department_id, (inferredDepartmentCounts.get(entry.department_id) || 0) + 1);
      });
      const inferredDepartmentId = Array.from(inferredDepartmentCounts.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      const resolvedDepartmentId = allocation?.department_id || inferredDepartmentId || null;
      const department = departments.find(dept => dept.id === resolvedDepartmentId);
      const resolvedSchoolId = allocation?.school_id || department?.school_id || null;
      const school = schools.find(item => item.id === resolvedSchoolId);
      const maintenanceIssues = maintenance.filter(item => idsEqual(item.room_id, room.id) && item.status !== "Completed").length;

      const scheduledHours = roomSchedules.reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bookedHours = roomBookings.reduce((acc, b) => {
        const h = calculateHours(b.start_time, b.end_time);
        return acc + h;
      }, 0);
      
      const totalUsedHours = scheduledHours + bookedHours;
      const availableHours = 72; // Assuming 12h * 6 days
      const utilization = (totalUsedHours / availableHours) * 100;
      const yearTags = Array.from(new Set(roomSchedules
        .map(schedule => {
          const normalizedYear = normalizeYearOfStudyKey(schedule?.year_of_study);
          if (normalizedYear) return normalizedYear;
          const semesterNumber = parseSemesterNumber(schedule?.semester);
          return semesterNumber ? Math.ceil(semesterNumber / 2).toString() : "";
        })
        .filter(Boolean)))
        .sort((a, b) => Number(a) - Number(b));
      const semesterTags = Array.from(new Set(roomSchedules
        .map(schedule => normalizeSemesterKey(schedule?.semester))
        .filter(Boolean)))
        .map(tag => tag === "odd" ? "Odd" : tag === "even" ? "Even" : tag)
        .sort((a, b) => a.localeCompare(b));
      const sectionTags = Array.from(new Set(roomSchedules
        .map(schedule => schedule?.section?.toString().trim())
        .filter(Boolean)))
        .sort((a, b) => a.localeCompare(b));

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
        bookingStatuses: Array.from(new Set(allRoomBookings.map(booking => booking.status).filter(Boolean))),
        bookingDates: allRoomBookings.map(booking => booking.date).filter(Boolean),
        approvedBookingDates: roomBookings.map(booking => booking.date).filter(Boolean),
        scheduleCount: roomSchedules.length,
        yearTags,
        semesterTags,
        sectionTags,
        flags: [
          utilization < 20 ? "Underused" : null,
          utilization > 80 ? "Overused" : null,
          maintenanceIssues > 0 ? "Maintenance Risk" : null,
          !department ? "Department Unmapped" : null,
        ].filter(Boolean)
      };
    });

    const filterOptions = {
      campuses: Array.from(new Set(baseReports.map(report => report.campus).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      buildings: Array.from(new Set(baseReports.map(report => report.building).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      blocks: Array.from(new Set(baseReports.map(report => report.block).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      floors: Array.from(new Set(baseReports.map(report => report.floor_number).filter((floor) => floor !== undefined && floor !== null)))
        .sort((a: any, b: any) => Number(a) - Number(b)),
      departments: Array.from(new Set([
        ...departments.map((department: any) => department?.name),
        ...baseReports.map(report => report.department),
      ].filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      years: Array.from(new Set(baseReports.flatMap(report => report.yearTags || []))).sort((a: any, b: any) => Number(a) - Number(b)),
      semesters: Array.from(new Set(baseReports.flatMap(report => report.semesterTags || []))).sort((a, b) => a.localeCompare(b)),
      sections: Array.from(new Set(baseReports.flatMap(report => report.sectionTags || []))).sort((a, b) => a.localeCompare(b)),
      rooms: Array.from(new Set(baseReports.map(report => report.room_number?.toString().trim()).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })),
      roomTypes: Array.from(new Set(baseReports.map(report => report.room_type).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
      flags: Array.from(new Set(baseReports.flatMap(report => report.flags || []).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
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

    const buildingReports = Array.from(new Set(reports.map(report => report.building))).map(building => {
      const buildingRooms = reports.filter(report => report.building === building);
      const avgUtilization = buildingRooms.reduce((acc, report) => acc + report.utilization, 0) / (buildingRooms.length || 1);
      return {
        name: building,
        roomCount: buildingRooms.length,
        avgUtilization: Math.round(avgUtilization),
        maintenanceIssues: buildingRooms.reduce((acc, report) => acc + report.maintenanceIssues, 0)
      };
    });

    const filteredRoomIds = new Set(reports.map(report => report.room_id?.toString()).filter(Boolean));
    const filteredAllBookings = allBookings.filter((booking) => {
      if (!filteredRoomIds.has(booking.room_id?.toString())) return false;
      const bookingDate = booking.date?.toString();
      if (dateFrom && (!bookingDate || bookingDate < dateFrom)) return false;
      if (dateTo && (!bookingDate || bookingDate > dateTo)) return false;
      return true;
    });
    const bookingStatusReports = ["Pending", "HOD Recommended", "Approved", "Postponed", "Rejected"].map(status => ({
      name: status,
      count: filteredAllBookings.filter(booking => booking.status === status).length
    }));

    // Aggregate by Department
    const deptReports = departments.map(dept => {
      const deptRooms = reports.filter(r => r.department_id === dept.id);
      const totalUtilization = deptRooms.reduce((acc, r) => acc + r.utilization, 0);
      const avgUtilization = deptRooms.length > 0 ? totalUtilization / deptRooms.length : 0;

      return {
        name: dept.name,
        school_id: dept.school_id,
        school: schools.find(school => school.id === dept.school_id)?.name || "Unmapped",
        avgUtilization: Math.round(avgUtilization),
        roomCount: deptRooms.length
      };
    }).filter(report => report.roomCount > 0);

    // Aggregate by School (room-weighted, only schools that actually have mapped rooms)
    const schoolReports = Array.from(new Set(reports.map(report => report.school).filter(s => s && s !== "Unmapped"))).map((schoolName) => {
      const schoolRooms = reports.filter(report => report.school === schoolName);
      const deptCount = new Set(
        schoolRooms
          .map(report => report.department)
          .filter((departmentName) => departmentName && departmentName !== "Unmapped")
      ).size;
      const totalUtilization = schoolRooms.reduce((acc, report) => acc + report.utilization, 0);
      const avgUtilization = schoolRooms.length > 0 ? totalUtilization / schoolRooms.length : 0;

      return {
        name: schoolName,
        avgUtilization: Math.round(avgUtilization),
        deptCount,
        roomCount: schoolRooms.length,
      };
    }).sort((a, b) => b.avgUtilization - a.avgUtilization);

    res.json({ roomReports: reports, deptReports, schoolReports, buildingReports, bookingStatusReports, filterOptions });
  } catch (err: any) {
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
      `).all(),
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
      liveSummary: liveOperationalSnapshot?.summary || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- ANALYTICS ENDPOINTS ---

app.get("/api/analytics/utilization-trends", authenticate, async (req, res) => {
  try {
    const rooms = await db.prepare("SELECT id, room_number FROM rooms").all() as any[];
    const schedules = await db.prepare("SELECT room_id, start_time, end_time FROM schedules").all() as any[];
    const bookings = await db.prepare("SELECT room_id, start_time, end_time FROM bookings WHERE status = 'Approved'").all() as any[];

    const calculateHours = (start: string, end: string) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(':').map(Number);
      const [h2, m2] = end.split(':').map(Number);
      return (h2 + m2 / 60) - (h1 + m1 / 60);
    };

    const data = rooms.map(room => {
      const sHours = schedules.filter(s => idsEqual(s.room_id, room.id)).reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bHours = bookings.filter(b => idsEqual(b.room_id, room.id)).reduce((acc, b) => acc + calculateHours(b.start_time, b.end_time), 0);
      const total = sHours + bHours;
      const utilization = Math.min(100, Math.round((total / 72) * 100)); // 72h week
      return { name: room.room_number, utilization };
    });

    res.json(data.sort((a, b) => b.utilization - a.utilization).slice(0, 10));
  } catch (err: any) {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function healInfrastructureHierarchy() {
  const campus = await db.prepare("SELECT * FROM campuses LIMIT 1").get();
  let defaultCampusId = campus?.id;
  if (!defaultCampusId) {
    const info = await db.prepare("INSERT INTO campuses (campus_id, name, location, description) VALUES (?, ?, ?, ?)").run('CAMPUS-1', 'Default Campus', 'Default Location', 'Auto-healed campus');
    defaultCampusId = Number(info.lastInsertRowid);
  }

  // Buildings
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
    const info = await db.prepare("INSERT INTO buildings (building_id, campus_id, name, description) VALUES (?, ?, ?, ?)").run('BUILD-1', defaultCampusId, 'Default Building', 'Auto-healed building');
    defaultBuildingId = Number(info.lastInsertRowid);
  }

  // Blocks
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
    const info = await db.prepare("INSERT INTO blocks (block_id, building_id, name, description) VALUES (?, ?, ?, ?)").run('BLOCK-1', defaultBuildingId, 'Default Block', 'Auto-healed block');
    defaultBlockId = Number(info.lastInsertRowid);
  }

  // Floors
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
    const info = await db.prepare("INSERT INTO floors (floor_id, block_id, floor_number, description) VALUES (?, ?, ?, ?)").run('FLR-1', defaultBlockId, 1, 'Auto-healed floor');
    defaultFloorId = Number(info.lastInsertRowid);
  }

  // Rooms
  const rooms = await db.prepare("SELECT * FROM rooms").all();
  for (const r of rooms) {
    const exists = await db.prepare("SELECT 1 FROM floors WHERE id = ?").get(r.floor_id);
    if (!exists) {
      await db.prepare("UPDATE rooms SET floor_id = ? WHERE id = ?").run(defaultFloorId, r.id);
    }
  }
  const roomCheck = await db.prepare("SELECT * FROM rooms LIMIT 1").get();
  if (!roomCheck) {
    await db.prepare("INSERT INTO rooms (room_id, room_number, floor_id, room_type, capacity) VALUES (?, ?, ?, ?, ?)").run('ROOM-1', '101', defaultFloorId, 'Lecture', 40);
  }

  return {
    status: 'healed',
    campus: defaultCampusId,
    building: defaultBuildingId,
    block: defaultBlockId,
    floor: defaultFloorId,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    database: db.dialect,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health/heal', authenticate, async (req, res) => {
  try {
    const healed = await healInfrastructureHierarchy();
    res.json({ success: true, healed });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  const startPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  let currentPort = isNaN(startPort) ? 3000 : startPort;

  const launchServer = () => {
    const server = app.listen(currentPort, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${currentPort}`);
    });

    server.on("error", (err: any) => {
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

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === __filename
  : false;

if (isDirectExecution) {
  startServer();
}

export default app;
