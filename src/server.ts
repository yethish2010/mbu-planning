import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import * as mammoth from "mammoth";
import { createDatabaseClient, type DatabaseClient, type DatabaseDialect } from "../db.ts";

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

const getPrimarySchemaSql = (dialect: DatabaseDialect) => {
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
      course_code TEXT,
      course_name TEXT,
      faculty TEXT,
      room_id INTEGER,
      day_of_week TEXT,
      start_time TEXT,
      end_time TEXT,
      student_count INTEGER,
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

await ensureBookingColumns();
await ensureColumn("buildings", "structure_type", "TEXT DEFAULT 'direct'");
await ensureColumn("buildings", "planned_block_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("buildings", "first_floor_number", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "planned_floor_count", "INTEGER DEFAULT 0");
await ensureColumn("blocks", "first_floor_number", "INTEGER DEFAULT 0");
await ensureColumn("rooms", "parent_room_id", "INTEGER");
await ensureColumn("rooms", "room_layout", "TEXT DEFAULT 'Normal'");
await ensureColumn("rooms", "sub_room_count", "INTEGER");
await ensureColumn("rooms", "room_section_name", "TEXT");
await ensureColumn("rooms", "usage_category", "TEXT");
await ensureColumn("rooms", "is_bookable", "INTEGER DEFAULT 1");
await ensureColumn("rooms", "lab_name", "TEXT");
await ensureColumn("rooms", "restroom_type", "TEXT");
await ensureColumn("users", "responsibilities", "TEXT");
await ensureColumn("users", "access_limits", "TEXT");
await ensureColumn("users", "access_paths", "TEXT");
await ensureColumn("users", "force_password_change", "INTEGER DEFAULT 0");
await ensureColumn("users", "school", "TEXT");
await ensureColumn("users", "access_type", "TEXT");
await ensureColumn("users", "access_scope", "TEXT");
await ensureColumn("user_school_assignments", "is_primary", "INTEGER DEFAULT 0");
await ensureColumn("user_school_assignments", "valid_from", "DATE");
await ensureColumn("user_school_assignments", "valid_until", "DATE");
await ensureColumn("user_school_assignments", "status", "TEXT DEFAULT 'Active'");
await ensureColumn("user_department_assignments", "is_primary", "INTEGER DEFAULT 0");
await ensureColumn("user_department_assignments", "valid_from", "DATE");
await ensureColumn("user_department_assignments", "valid_until", "DATE");
await ensureColumn("user_department_assignments", "status", "TEXT DEFAULT 'Active'");

const normalizeStatusValue = (value: any) => value?.toString().trim().toLowerCase() || "";
const getCurrentIsoDate = () => new Date().toISOString().split("T")[0];
const isAssignmentActive = (assignment: any, today = getCurrentIsoDate()) => {
  const status = normalizeStatusValue(assignment?.status);
  if (status && !["active", "current"].includes(status)) return false;
  const validFrom = assignment?.valid_from?.toString().trim();
  const validUntil = assignment?.valid_until?.toString().trim();
  if (validFrom && validFrom > today) return false;
  if (validUntil && validUntil < today) return false;
  return true;
};

const getSchoolAssignmentsForUser = async (userId: string | number) => {
  const assignments = await db.prepare(`
    SELECT
      usa.*,
      s.name as school_name,
      s.school_id as school_code
    FROM user_school_assignments usa
    JOIN schools s ON usa.school_id = s.id
    WHERE usa.user_id = ?
    ORDER BY usa.is_primary DESC, usa.id ASC
  `).all(userId) as any[];
  const today = getCurrentIsoDate();
  return assignments.filter((assignment: any) => isAssignmentActive(assignment, today));
};

const getDepartmentAssignmentsForUser = async (userId: string | number) => {
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
  `).all(userId) as any[];
  const today = getCurrentIsoDate();
  return assignments.filter((assignment: any) => isAssignmentActive(assignment, today));
};

const resolvePrimaryAssignment = (assignments: any[]) =>
  assignments.find((assignment: any) => Number(assignment?.is_primary) === 1)
  || assignments[0]
  || null;

const ensureUserSchoolAssignments = async (user: any) => {
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
  `).get(legacySchool, legacySchool, legacySchool) as any;
  if (!school) return [];

  await db.prepare(`
    INSERT INTO user_school_assignments (user_id, school_id, is_primary, status)
    VALUES (?, ?, 1, 'Active')
  `).run(user.id, school.id);

  assignments = await getSchoolAssignmentsForUser(user.id);
  return assignments;
};

const buildUserSchoolContext = async (user: any) => {
  const assignments = await ensureUserSchoolAssignments(user);
  const primaryAssignment = resolvePrimaryAssignment(assignments);
  const assignedSchoolIds = assignments
    .map((assignment: any) => assignment.school_id?.toString())
    .filter(Boolean);
  const assignedSchoolNames = assignments
    .map((assignment: any) => assignment.school_name?.toString().trim())
    .filter(Boolean);

  return {
    assignments,
    primaryAssignment,
    primarySchoolId: primaryAssignment?.school_id?.toString() || null,
    primarySchoolName: primaryAssignment?.school_name || user.school || null,
    assignedSchoolIds,
    assignedSchoolNames,
  };
};

const ensureUserDepartmentAssignments = async (user: any) => {
  if (!user?.id) return [];

  let assignments = await getDepartmentAssignmentsForUser(user.id);
  if (assignments.length > 0) return assignments;

  const legacyDepartment = user.department?.toString().trim();
  if (!legacyDepartment) return [];

  const department = await db.prepare(`
    SELECT id, name, department_id, school_id
    FROM departments
    WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
  `).get(legacyDepartment) as any;
  if (!department) return [];

  await db.prepare(`
    INSERT INTO user_department_assignments (user_id, department_id, is_primary, status)
    VALUES (?, ?, 1, 'Active')
  `).run(user.id, department.id);

  assignments = await getDepartmentAssignmentsForUser(user.id);
  return assignments;
};

const buildUserDepartmentContext = async (user: any) => {
  const assignments = await ensureUserDepartmentAssignments(user);
  const primaryAssignment = resolvePrimaryAssignment(assignments);
  const assignedDepartmentIds = assignments
    .map((assignment: any) => assignment.department_id?.toString())
    .filter(Boolean);
  const assignedDepartmentNames = assignments
    .map((assignment: any) => assignment.department_name?.toString().trim())
    .filter(Boolean);

  return {
    assignments,
    primaryAssignment,
    primaryDepartmentId: primaryAssignment?.department_id?.toString() || null,
    primaryDepartmentName: primaryAssignment?.department_name || user.department || null,
    assignedDepartmentIds,
    assignedDepartmentNames,
  };
};

const parseDelimitedValues = (value: any) => {
  if (Array.isArray(value)) return value.map(item => item?.toString().trim()).filter(Boolean);
  return value?.toString().split(/[;,]/).map((item: string) => item.trim()).filter(Boolean) || [];
};

const resolveSchoolRecordsFromValues = async (values: string[]) => {
  const resolvedSchools: any[] = [];
  for (const value of values) {
    const school = await db.prepare(`
      SELECT id, name, school_id
      FROM schools
      WHERE CAST(id AS TEXT) = ?
         OR LOWER(TRIM(school_id)) = LOWER(TRIM(?))
         OR LOWER(TRIM(name)) = LOWER(TRIM(?))
    `).get(value, value, value) as any;
    if (!school) {
      throw new Error(`Could not match school assignment "${value}".`);
    }
    if (!resolvedSchools.some((item) => item.id === school.id)) {
      resolvedSchools.push(school);
    }
  }
  return resolvedSchools;
};

const syncUserSchoolAssignments = async (userId: string | number, payload: any) => {
  const explicitIds = parseDelimitedValues(payload.assigned_school_ids);
  const explicitNames = parseDelimitedValues(payload.assigned_schools);
  const legacySchool = payload.school?.toString().trim();
  const primaryCandidate = payload.primary_school_id?.toString().trim()
    || payload.primary_school?.toString().trim()
    || payload.school?.toString().trim()
    || "";
  const requestedValues = Array.from(new Set([
    ...explicitIds,
    ...explicitNames,
    ...(legacySchool ? [legacySchool] : []),
  ]));

  if (requestedValues.length === 0) {
    await db.prepare("DELETE FROM user_school_assignments WHERE user_id = ?").run(userId);
    return [];
  }

  const resolvedAssignments = await resolveSchoolRecordsFromValues(requestedValues);
  let primarySchoolId = resolvedAssignments[0]?.id || null;
  if (primaryCandidate) {
    const normalizedPrimaryCandidate = primaryCandidate.toLowerCase();
    const matchedPrimary = resolvedAssignments.find((school) =>
      school.id?.toString() === primaryCandidate
      || school.school_id?.toString().trim().toLowerCase() === normalizedPrimaryCandidate
      || school.name?.toString().trim().toLowerCase() === normalizedPrimaryCandidate
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

const syncUserDepartmentAssignments = async (userId: string | number, payload: any) => {
  const explicitIds = parseDelimitedValues(payload.assigned_department_ids);
  const explicitNames = parseDelimitedValues(payload.assigned_departments);
  const legacyDepartment = payload.department?.toString().trim();
  const primaryCandidate = payload.primary_department_id?.toString().trim()
    || payload.primary_department?.toString().trim()
    || payload.department?.toString().trim()
    || "";
  const requestedValues = Array.from(new Set([
    ...explicitIds,
    ...explicitNames,
    ...(legacyDepartment ? [legacyDepartment] : []),
  ]));

  if (requestedValues.length === 0) {
    await db.prepare("DELETE FROM user_department_assignments WHERE user_id = ?").run(userId);
    return [];
  }

  const resolvedAssignments: any[] = [];
  for (const value of requestedValues) {
    const department = await db.prepare(`
      SELECT id, name, department_id, school_id
      FROM departments
      WHERE CAST(id AS TEXT) = ?
         OR LOWER(TRIM(department_id)) = LOWER(TRIM(?))
         OR LOWER(TRIM(name)) = LOWER(TRIM(?))
    `).get(value, value, value) as any;
    if (!department) {
      throw new Error(`Could not match department assignment "${value}".`);
    }
    if (!resolvedAssignments.some((item) => item.id === department.id)) {
      resolvedAssignments.push(department);
    }
  }

  let primaryDepartmentId = resolvedAssignments[0]?.id || null;
  if (primaryCandidate) {
    const matchedPrimary = resolvedAssignments.find((department) =>
      department.id?.toString() === primaryCandidate
      || department.department_id?.toString().trim().toLowerCase() === primaryCandidate.toLowerCase()
      || department.name?.toString().trim().toLowerCase() === primaryCandidate.toLowerCase()
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
  "Multipurpose Classroom",
  "Classroom Lab",
  "Multipurpose Lab",
  "Lab",
  "Computer Lab",
  "Research Lab",
  "Language Lab",
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
    nextPayload.restroom_type = null;
  } else if (nextPayload.room_type === "Restroom") {
    if (!["Male", "Female"].includes(nextPayload.restroom_type || "")) {
      throw new Error("Please choose Male or Female when the room type is Restroom.");
    }
    nextPayload.lab_name = null;
  } else {
    nextPayload.lab_name = null;
    nextPayload.restroom_type = null;
  }

  if (isCapacityRoomType(nextPayload.room_type) && nextPayload.capacity <= 0) {
    throw new Error("Capacity is required for classroom and lab room types.");
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

const getBookableRoomError = async (roomId: any) => {
  if (!roomId) return null;
  const room = await db.prepare("SELECT room_number, room_type, usage_category, is_bookable, status FROM rooms WHERE id = ?").get(roomId) as any;
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

const ensureBookingActivityTable = async () => {
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

const ensureBookingAlternativesTable = async () => {
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

const ensureTemporaryRoomAllocationsTable = async () => {
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

const createNotification = async (targetRole: string | null, targetName: string | null, title: string, message: string, targetDepartment: string | null = null) => {
  await ensureNotificationsTable();
  await db.prepare("INSERT INTO notifications (target_role, target_name, target_department, title, message) VALUES (?, ?, ?, ?, ?)")
    .run(targetRole, targetName, targetDepartment, title, message);
};

const createBookingActivityLog = async (
  booking: any,
  actor: { name?: string | null; role?: string | null } | null,
  payload: {
    actionType: string;
    title: string;
    message?: string | null;
    statusFrom?: string | null;
    statusTo?: string | null;
    roomIdFrom?: string | number | null;
    roomIdTo?: string | number | null;
    noteText?: string | null;
  }
) => {
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
    payload.noteText ?? null,
  );
};

const getDepartmentNameById = async (departmentId?: string | number | null) => {
  if (!departmentId) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(departmentId) as any;
  return department?.name || null;
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
  const normalizedDepartments = Array.from(new Set([
    user?.department?.toString().trim().toLowerCase() || null,
    ...(Array.isArray(user?.assigned_departments) ? user.assigned_departments : [])
      .map((department: any) => department?.toString().trim().toLowerCase())
      .filter(Boolean),
  ].filter(Boolean)));

  return { normalizedRole, normalizedName, normalizedDepartments };
};

const getNotificationsForUser = async (user: any, limit = 20) => {
  await ensureNotificationsTable();
  await ensureNotificationReadsTable();
  const { normalizedRole, normalizedName, normalizedDepartments } = getNotificationAudienceParams(user);
  const notifications = await db.prepare(`
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
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ?
  `).all(user.id, normalizedRole, normalizedName, Math.max(limit * 5, 100));

  return notifications
    .filter((notification: any) => {
      const targetDepartment = notification?.target_department?.toString().trim().toLowerCase();
      if (!targetDepartment) return true;
      return normalizedDepartments.includes(targetDepartment);
    })
    .slice(0, limit);
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

  const insertSql = db.dialect === "postgres"
    ? `
      INSERT INTO notification_reads (notification_id, user_id, read_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT (notification_id, user_id) DO NOTHING
    `
    : `
      INSERT OR IGNORE INTO notification_reads (notification_id, user_id, read_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `;

  await db.transaction(async (transactionDb: DatabaseClient) => {
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
const authenticate = async (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = (decoded as any)?.id;
    if (userId) {
      const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
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

// --- AUTH ROUTES ---

const getUserSessionPayload = async (user: any) => {
  const schoolContext = await buildUserSchoolContext(user);
  const context = await buildUserDepartmentContext(user);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.full_name,
    school: schoolContext.primarySchoolName || user.school || null,
    primary_school_id: schoolContext.primarySchoolId,
    primary_school: schoolContext.primarySchoolName,
    assigned_school_ids: schoolContext.assignedSchoolIds,
    assigned_schools: schoolContext.assignedSchoolNames,
    school_assignments: schoolContext.assignments.map((assignment: any) => ({
      id: assignment.id,
      school_id: assignment.school_id,
      school_name: assignment.school_name,
      school_code: assignment.school_code,
      is_primary: Number(assignment.is_primary) === 1,
      valid_from: assignment.valid_from || null,
      valid_until: assignment.valid_until || null,
      status: assignment.status || "Active",
    })),
    department: context.primaryDepartmentName || user.department || null,
    primary_department_id: context.primaryDepartmentId,
    primary_department: context.primaryDepartmentName,
    assigned_department_ids: context.assignedDepartmentIds,
    assigned_departments: context.assignedDepartmentNames,
    department_assignments: context.assignments.map((assignment: any) => ({
      id: assignment.id,
      department_id: assignment.department_id,
      department_name: assignment.department_name,
      department_code: assignment.department_code,
      school_id: assignment.school_id,
      is_primary: Number(assignment.is_primary) === 1,
      valid_from: assignment.valid_from || null,
      valid_until: assignment.valid_until || null,
      status: assignment.status || "Active",
    })),
    designation: user.designation,
    responsibilities: user.responsibilities,
    access_limits: user.access_limits,
    access_paths: user.access_paths,
    force_password_change: !!user.force_password_change
  };
};

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user: any = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const sessionUser = await getUserSessionPayload(user);
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

app.get("/api/auth/me", async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = (decoded as any)?.id;
    if (!userId) return res.json({ user: decoded });
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    if (!user) return res.status(401).json({ error: "Not logged in" });
    res.json({ user: await getUserSessionPayload(user) });
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
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

Return a JSON array of objects with these fields:
- department (e.g., "Computer Science and Engineering")
- semester (Odd or Even if available, else null)
- course_code (if available, else null)
- course_name (the subject name, e.g., "Computer Networks")
- faculty (the teacher's name)
- room (the room number, e.g., "322")
- day_of_week (Full name: Monday, Tuesday, etc.)
- start_time (24h format HH:mm, e.g., "09:00")
- end_time (24h format HH:mm, e.g., "09:55")
- student_count (estimate or null)

Ensure you capture the Room No mentioned in the header of each timetable.
Only extract actual class sessions.
Ignore labels and non-course cells such as "Reading Period", "Reading Periods", "Period", "Periods", "Break", "Lunch", "Tea Break", "Library", section titles, room headings, and plain time-slot labels.
The course_name must always be the real subject title.
If a slot has multiple subjects or is a lab, create separate entries if needed or one entry with combined info.` });

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts }],
      config: { responseMimeType: "application/json" },
    });
    const schedules = parseAIJsonResponse(await getAIResponseText(response));
    res.json({ schedules: Array.isArray(schedules) ? schedules : [] });
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
  res.status(403).json({ error: "Password reset is handled by the Administrator." });
});

app.post("/api/auth/reset-password", (req, res) => {
  res.status(403).json({ error: "Password reset is handled by the Administrator." });
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
    const sessionUser = await getUserSessionPayload(user);
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
  equipment: [
    { fields: ["equipment_id"], label: "Equipment ID" },
    { fields: ["room_id", "name"], label: "Equipment name in this room" },
  ],
  schedules: [
    { fields: ["schedule_id"], label: "Schedule ID" },
    { fields: ["room_id", "day_of_week", "start_time", "end_time"], label: "Schedule slot for this room" },
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

const checkDuplicateRecord = async (tableName: string, data: any, excludeId?: string | number) => {
  const rules = duplicateRules[tableName] || [];

  for (const rule of rules) {
    if (rule.fields.some(field => data[field] == null || data[field] === "")) continue;

    const whereClause = rule.fields
      .map(field => typeof data[field] === "string" ? `LOWER(TRIM(${field})) = ?` : `${field} = ?`)
      .join(" AND ");
    const values = rule.fields.map(field => normalizeDuplicateValue(data[field]));
    const query = `SELECT id FROM ${tableName} WHERE ${whereClause}${excludeId ? " AND id != ?" : ""}`;
    const existing = await db.prepare(query).get(...values, ...(excludeId ? [excludeId] : []));

    if (existing) {
      return `${rule.label} already exists. Duplicate records are not allowed.`;
    }
  }

  return null;
};

const isPastDateTime = (date: any, time: string) => {
  const normalizedDate = date instanceof Date
    ? date.toISOString().slice(0, 10)
    : date?.toString().trim().includes("T")
      ? date.toString().trim().slice(0, 10)
      : date?.toString().trim();
  const value = new Date(`${normalizedDate}T${time}`);
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

const getBookingDepartmentName = async (booking: any) => {
  if (!booking?.department_id) return null;
  const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(booking.department_id) as any;
  return department?.name || null;
};

const isDecisionRole = (role: string) => ["Administrator", "Dean (P&M)", "Deputy Dean (P&M)"].includes(role);
const openBookingStatuses = [
  "Pending",
  "HOD Recommended",
  "Approved",
  "No Room Available",
  "Awaiting Alternative Response",
  "Waitlisted",
  "Clarification Required",
];
const bookingDeanWorkflowStatuses = ["Approved", "Rejected", "Postponed", "No Room Available", "Waitlisted", "Clarification Required"];
const bookingRequesterRevisionStatuses = ["No Room Available", "Waitlisted", "Clarification Required", "Postponed", "Awaiting Alternative Response"];
const normalizeBookingRequestType = (value: any) =>
  value?.toString().trim() === "Additional Room" ? "Additional Room" : "Department Room";
const isAdditionalRoomBooking = (booking: any) => normalizeBookingRequestType(booking?.request_type) === "Additional Room";
const getAccessibleDepartmentIdSet = (user: any) =>
  new Set(
    (Array.isArray(user?.assigned_department_ids) ? user.assigned_department_ids : [])
      .map((departmentId: any) => departmentId?.toString())
      .filter(Boolean)
  );

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

const getBookingWorkflowItems = async (booking: any) => {
  if (!booking) return [];
  if (booking.request_group_id) {
    return await db.prepare("SELECT * FROM bookings WHERE request_group_id = ? ORDER BY date ASC, start_time ASC, id ASC").all(booking.request_group_id) as any[];
  }
  return [booking];
};

const canAccessBookingWorkflow = async (booking: any, user: any) => {
  if (!booking || !user) return false;
  if (isDecisionRole(user.role)) return true;
  if (booking.faculty_name === user.name) return true;
  if (user.role === "HOD" && booking.department_id != null) {
    const departmentIds = getAccessibleDepartmentIdSet(user);
    if (departmentIds.has(booking.department_id.toString())) return true;
  }
  return false;
};

const sanitizeBookingAlternative = (alternative: any, canViewInternalDetails: boolean) => {
  if (canViewInternalDetails) return alternative;
  const { internal_candidate_room_ids, ...safeAlternative } = alternative || {};
  return safeAlternative;
};

const deriveTemporaryAllocationStatus = (date: string, startTime: string, endTime: string) => {
  const now = new Date();
  const start = new Date(`${date}T${startTime}`);
  const end = new Date(`${date}T${endTime}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Upcoming";
  if (now < start) return "Upcoming";
  if (now >= start && now < end) return "Active";
  return "Completed";
};

const getLatestDepartmentAllocationForRoom = async (roomId?: string | number | null) => {
  if (!roomId) return null;
  return await db.prepare(`
    SELECT *
    FROM department_allocations
    WHERE room_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(roomId) as any;
};

const refreshTemporaryRoomAllocationStatuses = async () => {
  await ensureTemporaryRoomAllocationsTable();
  const allocations = await db.prepare(`
    SELECT *
    FROM temporary_room_allocations
    WHERE status IN ('Upcoming', 'Active')
  `).all() as any[];
  for (const allocation of allocations) {
    const nextStatus = deriveTemporaryAllocationStatus(allocation.approved_date, allocation.start_time, allocation.end_time);
    if (nextStatus !== allocation.status) {
      await db.prepare(`
        UPDATE temporary_room_allocations
        SET status = ?, released_at = CASE WHEN ? = 'Completed' THEN CURRENT_TIMESTAMP ELSE released_at END, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, nextStatus, allocation.id);
      const relatedBooking = allocation.booking_id
        ? await db.prepare("SELECT * FROM bookings WHERE id = ?").get(allocation.booking_id) as any
        : null;
      if (relatedBooking) {
        if (nextStatus === "Active") {
          await createBookingActivityLog(relatedBooking, { name: "System", role: "System" }, {
            actionType: "temporary_allocation_started",
            title: "Temporary allocation started",
            message: `Temporary access started for Room ${relatedBooking.room_id || allocation.room_id}.`,
            statusTo: relatedBooking.status ?? null,
            roomIdTo: allocation.room_id ?? null,
            noteText: allocation.allocation_note || null,
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
            noteText: allocation.allocation_note || null,
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

const syncTemporaryRoomAllocationForBooking = async (booking: any, actor?: { name?: string | null; role?: string | null } | null) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  if (!booking?.id) return;

  const existingAllocation = await db.prepare("SELECT * FROM temporary_room_allocations WHERE booking_id = ?").get(booking.id) as any;
  const shouldHaveAllocation = isAdditionalRoomBooking(booking)
    && booking.status === "Approved"
    && booking.room_id
    && booking.department_id
    && booking.date
    && booking.start_time
    && booking.end_time;

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
    booking.id,
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
    nextStatus,
  );
};

const getTemporaryAllocationConflict = async (roomId: any, date: string, startTime: string, endTime: string, excludeBookingId?: string | number) => {
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
    ...(excludeBookingId ? [excludeBookingId] : []),
    startTime,
    endTime,
  ) as any;
};

const getTemporaryAllocationScheduleConflict = async (roomId: any, dayOfWeek: string, startTime: string, endTime: string) => {
  if (!roomId || !dayOfWeek || !startTime || !endTime) return null;
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
  const allocations = await db.prepare(`
    SELECT id, approved_date, start_time, end_time, status
    FROM temporary_room_allocations
    WHERE room_id = ? AND status IN ('Upcoming', 'Active')
  `).all(roomId) as any[];
  return allocations.find((allocation: any) => {
    const allocationDay = new Date(`${allocation.approved_date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
    return allocationDay === dayOfWeek && timesOverlap(allocation.start_time, allocation.end_time, startTime, endTime);
  }) || null;
};

const applyBookingQueryFilters = (bookings: any[], query: any) => {
  const requestedStatus = query.status?.toString().trim() || "";
  const requestedDepartmentId = query.department_id?.toString() || query.departmentId?.toString() || "";
  const requestedRequestType = query.requestType?.toString().trim() || query.request_type?.toString().trim() || "";
  const requestedAssignment = query.assignment?.toString().trim() || "";
  const requestedDecision = query.decision?.toString().trim() || "";

  return bookings.filter((booking: any) => {
    if (requestedStatus && booking?.status !== requestedStatus) return false;
    if (requestedDepartmentId && !idsEqual(booking?.department_id, requestedDepartmentId)) return false;
    if (requestedRequestType && booking?.request_type !== requestedRequestType) return false;
    if (requestedAssignment === "assigned" && !booking?.room_id) return false;
    if (requestedAssignment === "unassigned" && booking?.room_id) return false;
    if (requestedDecision === "ready") {
      const isReadyForDecision = booking?.status === "HOD Recommended"
        || (booking?.request_type === "Additional Room" && ["Pending", "HOD Recommended"].includes(booking?.status) && !!booking?.room_id);
      if (!isReadyForDecision) return false;
    }
    return true;
  });
};

await backfillNotificationsIfEmpty();

const createCrudRoutes = (tableName: string, idField: string = "id") => {
  app.get(`/api/${tableName}`, authenticate, async (req, res) => {
    try {
      if (tableName === "users") {
        const users = await db.prepare(`SELECT * FROM users`).all() as any[];
        const enrichedUsers = await Promise.all(users.map(async (user: any) => {
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
            assigned_departments: context.assignedDepartmentNames.join(", "),
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
        const user = (req as any).user;
        if (isDecisionRole(user.role)) return res.json(applyBookingQueryFilters(bookings as any[], req.query));
        if (user.role === "HOD") {
          const accessibleDepartmentIds = getAccessibleDepartmentIdSet(user);
          return res.json(applyBookingQueryFilters(bookings.filter((booking: any) =>
            booking.faculty_name === user.name
            || (booking?.department_id != null && accessibleDepartmentIds.has(booking.department_id.toString()))
            || (!!user.department && booking.department_name === user.department)
          ), req.query));
        }
        return res.json(applyBookingQueryFilters(bookings.filter((booking: any) => booking.faculty_name === user.name), req.query));
      }

      const items = await db.prepare(`SELECT * FROM ${tableName}`).all();
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/${tableName}`, authenticate, async (req, res) => {
    if (tableName === "users" && (req as any).user?.role !== "Administrator") {
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
    const userAssignmentPayload = tableName === "users"
      ? {
          assigned_schools: req.body.assigned_schools,
          assigned_school_ids: req.body.assigned_school_ids,
          primary_school_id: req.body.primary_school_id,
          primary_school: req.body.primary_school,
          school: req.body.school,
          assigned_departments: req.body.assigned_departments,
          assigned_department_ids: req.body.assigned_department_ids,
          primary_department_id: req.body.primary_department_id,
          primary_department: req.body.primary_department,
          department: req.body.department,
        }
      : null;
    if (tableName === "users") {
      delete req.body.assigned_schools;
      delete req.body.assigned_school_ids;
      delete req.body.primary_school_id;
      delete req.body.primary_school;
      delete req.body.assigned_departments;
      delete req.body.assigned_department_ids;
      delete req.body.primary_department_id;
      delete req.body.primary_department;
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

    try {
      const duplicateError = await checkDuplicateRecord(tableName, req.body);
      if (duplicateError) {
        return res.status(400).json({ error: duplicateError });
      }

      if (tableName === "rooms") {
        const hierarchyError = await validateRoomHierarchy(req.body);
        if (hierarchyError) return res.status(400).json({ error: hierarchyError });
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

      if (tableName === "schedules") {
        if (req.body.room_id !== undefined && req.body.room_id !== null && req.body.room_id !== "") {
          const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(req.body.room_id) as any;
          if (!room) return res.status(400).json({ error: "Please select a valid room." });
          const temporaryAllocationConflict = await getTemporaryAllocationScheduleConflict(
            req.body.room_id,
            req.body.day_of_week,
            req.body.start_time,
            req.body.end_time,
          );
          if (temporaryAllocationConflict) {
            return res.status(400).json({ error: "This room has an overlapping temporary allocation for one or more matching schedule slots." });
          }
        }
      }

      if (tableName === "bookings") {
        req.body.request_type = normalizeBookingRequestType(req.body.request_type);
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
        const department = await db.prepare("SELECT name FROM departments WHERE id = ?").get(req.body.department_id) as any;
        if (!department) {
          return res.status(400).json({ error: "Please select a valid department." });
        }
        if (!["Pending", "Approved"].includes(req.body.status || "Pending")) {
          req.body.status = "Pending";
          const statusIndex = fields.indexOf("status");
          if (statusIndex >= 0) values[statusIndex] = req.body.status;
        }
        if (req.body.status === "Approved" && !["Administrator", "Dean (P&M)"].includes((req as any).user.role)) {
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
      }

      const insertPlaceholders = fields.map(() => "?").join(", ");
      const info = await db.prepare(`INSERT INTO ${tableName} (${fields.join(", ")}) VALUES (${insertPlaceholders})`).run(...values);
      if (tableName === "users" && userAssignmentPayload) {
        await syncUserSchoolAssignments(info.lastInsertRowid, userAssignmentPayload);
        await syncUserDepartmentAssignments(info.lastInsertRowid, userAssignmentPayload);
      }
      if (tableName === "bookings") {
        const requestLabel = isAdditionalRoomBooking(req.body) ? "an additional room requirement" : (req.body.event_name || "a room");
        const message = `${req.body.faculty_name} requested ${requestLabel} on ${req.body.date} from ${req.body.start_time} to ${req.body.end_time}.`;
        await createBookingActivityLog(
          { id: info.lastInsertRowid, ...req.body },
          { name: (req as any).user?.name || req.body.faculty_name, role: (req as any).user?.role || "Requester" },
          {
            actionType: "created",
            title: "Request submitted",
            message,
            statusTo: req.body.status || "Pending",
            roomIdTo: req.body.room_id ?? null,
            noteText: req.body.notes || req.body.status_remark || null,
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
        await syncTemporaryRoomAllocationForBooking({ id: info.lastInsertRowid, ...req.body }, { name: (req as any).user?.name || null, role: (req as any).user?.role || null });
      }
      res.json({ id: info.lastInsertRowid, ...req.body });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && (req as any).user?.role !== "Administrator") {
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
    const userAssignmentPayload = tableName === "users"
      ? {
          assigned_schools: req.body.assigned_schools,
          assigned_school_ids: req.body.assigned_school_ids,
          primary_school_id: req.body.primary_school_id,
          primary_school: req.body.primary_school,
          school: req.body.school,
          assigned_departments: req.body.assigned_departments,
          assigned_department_ids: req.body.assigned_department_ids,
          primary_department_id: req.body.primary_department_id,
          primary_department: req.body.primary_department,
          department: req.body.department,
        }
      : null;
    if (tableName === "users") {
      delete req.body.assigned_schools;
      delete req.body.assigned_school_ids;
      delete req.body.primary_school_id;
      delete req.body.primary_school;
      delete req.body.assigned_departments;
      delete req.body.assigned_department_ids;
      delete req.body.primary_department_id;
      delete req.body.primary_department;
    }
    if (tableName === "rooms") {
      req.body = normalizeRoomPayload(req.body);
    }
    req.body = await normalizeHierarchyReferencePayload(tableName, req.body);
    let fields = Object.keys(req.body);
    let setClause = fields.map(f => `${f} = ?`).join(", ");
    let values = [...Object.values(req.body), req.params.id];

    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id) as any;
      const duplicateError = await checkDuplicateRecord(tableName, { ...existingItem, ...req.body }, req.params.id);
      if (duplicateError) {
        return res.status(400).json({ error: duplicateError });
      }

      if (tableName === "rooms") {
        const hierarchyError = await validateRoomHierarchy({ ...existingItem, ...req.body }, req.params.id);
        if (hierarchyError) return res.status(400).json({ error: hierarchyError });
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

      if (tableName === "schedules") {
        const nextSchedule = { ...existingItem, ...req.body };
        if (nextSchedule.room_id !== undefined && nextSchedule.room_id !== null && nextSchedule.room_id !== "") {
          const room = await db.prepare("SELECT id FROM rooms WHERE id = ?").get(nextSchedule.room_id) as any;
          if (!room) return res.status(400).json({ error: "Please select a valid room." });
          const temporaryAllocationConflict = await getTemporaryAllocationScheduleConflict(
            nextSchedule.room_id,
            nextSchedule.day_of_week,
            nextSchedule.start_time,
            nextSchedule.end_time,
          );
          if (temporaryAllocationConflict) {
            return res.status(400).json({ error: "This room has an overlapping temporary allocation for one or more matching schedule slots." });
          }
        }
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
        const requestedStatus = req.body.status;
        const role = (req as any).user.role;
        const isRequester = existingItem.faculty_name === (req as any).user.name;
        const accessibleDepartmentIds = getAccessibleDepartmentIdSet((req as any).user);
        const isDepartmentHod = role === "HOD"
          && nextBooking?.department_id != null
          && accessibleDepartmentIds.has(nextBooking.department_id.toString());

        if (requestedStatus === "HOD Recommended") {
          if (!isDepartmentHod) {
            return res.status(403).json({ error: "Only the respective department HOD can recommend this room request." });
          }
          if (existingItem.status !== "Pending") {
            return res.status(400).json({ error: "Only pending requests can be recommended by HOD." });
          }
        }
        if (bookingDeanWorkflowStatuses.includes(requestedStatus)) {
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
        if (requestedStatus === "Pending" && !["Rejected", "Postponed", "Clarification Required"].includes(existingItem.status)) {
          return res.status(400).json({ error: "Only rejected or postponed requests can be reopened." });
        }
        if (requestedStatus === "HOD Recommended") {
          req.body.recommended_by = (req as any).user.name;
        }
        if (bookingDeanWorkflowStatuses.includes(requestedStatus)) {
          req.body.decided_by = (req as any).user.name;
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
      }

      fields = Object.keys(req.body);
      setClause = fields.map(f => `${f} = ?`).join(", ");
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
        const actor = { name: (req as any).user?.name || null, role: (req as any).user?.role || null };
        if (existingItem.room_id?.toString?.() !== updatedBooking.room_id?.toString?.()) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "room_assigned",
            title: updatedBooking.room_id ? "Room assigned" : "Room cleared",
            message: updatedBooking.room_id
              ? `${actor.name || "A user"} assigned a room to ${existingItem.event_name || "this request"}.`
              : `${actor.name || "A user"} cleared the assigned room from ${existingItem.event_name || "this request"}.`,
            roomIdFrom: existingItem.room_id ?? null,
            roomIdTo: updatedBooking.room_id ?? null,
            noteText: req.body.allocation_note || null,
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
            noteText: req.body.status_remark || null,
          });
        } else if (req.body.status_remark && req.body.status_remark !== existingItem.status_remark) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "status_note_updated",
            title: "Decision remark updated",
            message: `${actor.name || "A user"} updated the decision remark.`,
            statusTo: updatedBooking.status ?? null,
            noteText: req.body.status_remark,
          });
        } else if (req.body.allocation_note && req.body.allocation_note !== existingItem.allocation_note) {
          await createBookingActivityLog(updatedBooking, actor, {
            actionType: "allocation_note_updated",
            title: "Allocation note updated",
            message: `${actor.name || "A user"} updated the allocation note.`,
            roomIdTo: updatedBooking.room_id ?? null,
            noteText: req.body.allocation_note,
          });
        }
        await syncTemporaryRoomAllocationForBooking(updatedBooking, actor);
      }
      if (tableName === "bookings" && req.body.status) {
        const title = req.body.status === "HOD Recommended" ? "Request recommended" : `Request ${req.body.status}`;
        const actor = (req as any).user.name;
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
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(`/api/${tableName}/reset`, authenticate, async (req, res) => {
    if (tableName === "users" && (req as any).user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can remove users." });
    }
    try {
      if (tableName === "users") {
        await db.prepare(`DELETE FROM user_school_assignments`).run();
        await db.prepare(`DELETE FROM user_department_assignments`).run();
      }
      await db.prepare(`DELETE FROM ${tableName}`).run();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete(`/api/${tableName}/:id`, authenticate, async (req, res) => {
    if (tableName === "users" && (req as any).user?.role !== "Administrator") {
      return res.status(403).json({ error: "Only Administrator can remove users." });
    }
    try {
      const existingItem = await db.prepare(`SELECT * FROM ${tableName} WHERE ${idField} = ?`).get(req.params.id) as any;
      if (tableName === "users") {
        await db.prepare(`DELETE FROM user_school_assignments WHERE user_id = ?`).run(req.params.id);
        await db.prepare(`DELETE FROM user_department_assignments WHERE user_id = ?`).run(req.params.id);
      }
      await db.prepare(`DELETE FROM ${tableName} WHERE ${idField} = ?`).run(req.params.id);
      if (tableName === "bookings" && existingItem) {
        await syncTemporaryRoomAllocationForBooking({ ...existingItem, status: "Revoked", room_id: null }, { name: (req as any).user?.name || null, role: (req as any).user?.role || null });
        const actor = (req as any).user.name;
        const title = "Room request deleted";
        const message = `${actor} deleted ${existingItem.event_name || "a room request"} for ${existingItem.date || "the selected date"}.`;
        await createBookingActivityLog(existingItem, { name: actor, role: (req as any).user?.role || null }, {
          actionType: "deleted",
          title,
          message,
          statusFrom: existingItem.status ?? null,
          roomIdFrom: existingItem.room_id ?? null,
          noteText: existingItem.status_remark || existingItem.allocation_note || null,
        });
        await createNotification(null, existingItem.faculty_name, title, message);
        await notifyBookingAuthorities(existingItem, title, message);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
};

createCrudRoutes("users");
createCrudRoutes("campuses");
createCrudRoutes("buildings");
createCrudRoutes("blocks");
createCrudRoutes("floors");

app.get("/api/bookings/:id/activity", authenticate, async (req, res) => {
  try {
    await ensureBookingActivityTable();
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id) as any;
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const items = booking.request_group_id
      ? await db.prepare(`
          SELECT * FROM booking_activity
          WHERE request_group_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.request_group_id) as any[]
      : await db.prepare(`
          SELECT * FROM booking_activity
          WHERE booking_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(req.params.id) as any[];
    res.json(items);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/bookings/:id/alternatives", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id) as any;
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const canAccess = await canAccessBookingWorkflow(booking, (req as any).user);
    if (!canAccess) {
      return res.status(403).json({ error: "You do not have access to these alternatives." });
    }
    const items = booking.request_group_id
      ? await db.prepare(`
          SELECT * FROM booking_alternatives
          WHERE request_group_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.request_group_id) as any[]
      : await db.prepare(`
          SELECT * FROM booking_alternatives
          WHERE booking_id = ?
          ORDER BY created_at DESC, id DESC
        `).all(booking.id) as any[];
    const canViewInternalDetails = isDecisionRole((req as any).user?.role || "");
    res.json(items.map(item => sanitizeBookingAlternative(item, canViewInternalDetails)));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/alternatives", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const actor = (req as any).user;
    if (!["Administrator", "Dean (P&M)", "Deputy Dean (P&M)"].includes(actor?.role)) {
      return res.status(403).json({ error: "Only Planning and Monitoring decision roles can suggest alternatives." });
    }
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id) as any;
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
      internalCandidateRoomIds: Array.isArray(req.body.internal_candidate_room_ids)
        ? req.body.internal_candidate_room_ids.map((item: any) => item?.toString?.()).filter(Boolean)
        : [],
    };
    const hasSuggestionContent = suggestionPayload.suggestedDate
      || suggestionPayload.suggestedStartTime
      || suggestionPayload.suggestedEndTime
      || suggestionPayload.suggestedCapacity
      || suggestionPayload.suggestedRoomType
      || suggestionPayload.suggestedBuilding
      || suggestionPayload.suggestedRoomCount
      || suggestionPayload.suggestionNote;
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
      actor.role || null,
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
      noteText: suggestionPayload.suggestionNote || null,
    });
    await createNotification(null, booking.faculty_name, "Alternative proposal shared", `${booking.event_name || "Your request"} has an alternative arrangement for your response.`);
    await notifyBookingAuthorities(booking, "Alternative proposal shared", `${actor.name || "A planner"} shared an alternative arrangement for ${booking.event_name || "this request"}.`);

    const createdAlternative = await db.prepare("SELECT * FROM booking_alternatives WHERE id = ?").get(alternativeInfo.lastInsertRowid) as any;
    res.json(sanitizeBookingAlternative(createdAlternative, true));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/alternatives/:alternativeId/respond", authenticate, async (req, res) => {
  try {
    await ensureBookingAlternativesTable();
    const actor = (req as any).user;
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id) as any;
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    if (booking.faculty_name !== actor?.name) {
      return res.status(403).json({ error: "Only the requester can respond to this alternative." });
    }
    const alternative = await db.prepare("SELECT * FROM booking_alternatives WHERE id = ?").get(req.params.alternativeId) as any;
    if (!alternative) {
      return res.status(404).json({ error: "Alternative not found." });
    }
    const workflowItems = await getBookingWorkflowItems(booking);
    const belongsToWorkflow = booking.request_group_id
      ? alternative.request_group_id === booking.request_group_id
      : Number(alternative.booking_id) === Number(booking.id);
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
          item.id,
        );
      }
      await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
        actionType: "alternative_accepted",
        title: "Alternative accepted",
        message: `${actor.name || "The requester"} accepted the suggested alternative.`,
        statusFrom: booking.status ?? null,
        statusTo: "Pending",
        noteText: responseNote || null,
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
        noteText: responseNote || null,
      });
      await notifyBookingAuthorities(booking, "Alternative declined", `${actor.name || "The requester"} declined an alternative for ${booking.event_name || "this request"}.`);
      await createNotification(null, booking.faculty_name, "Alternative declined", `${booking.event_name || "Your request"} remains without a suitable room after declining the suggested option.`);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/revise", authenticate, async (req, res) => {
  try {
    const actor = (req as any).user;
    const booking = await db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id) as any;
    if (!booking) {
      return res.status(404).json({ error: "Booking not found." });
    }
    if (booking.faculty_name !== actor?.name) {
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
    const revisedCapacity = req.body.required_capacity != null && req.body.required_capacity !== ""
      ? (parseInt(req.body.required_capacity, 10) || 0)
      : null;
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
        item.id,
      );
    }

    await createBookingActivityLog(booking, { name: actor.name || null, role: actor.role || null }, {
      actionType: "request_revised",
      title: "Requirements revised",
      message: `${actor.name || "The requester"} revised the room requirements.`,
      statusFrom: booking.status ?? null,
      statusTo: "Pending",
      noteText: revisedNote || null,
    });
    await notifyBookingAuthorities(booking, "Request revised", `${actor.name || "The requester"} revised ${booking.event_name || "this request"} and sent it back for review.`);
    await createNotification(null, booking.faculty_name, "Request revised", `${booking.event_name || "Your request"} was updated and returned for review.`);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/temporary-room-allocations", authenticate, async (req, res) => {
  try {
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const actor = (req as any).user;
    const requestedDepartmentId = req.query.departmentId?.toString() || req.query.department_id?.toString() || "";
    const requestedBookingId = req.query.bookingId?.toString() || req.query.booking_id?.toString() || "";
    let items = await db.prepare(`
      SELECT *
      FROM temporary_room_allocations
      ORDER BY approved_date DESC, start_time DESC, id DESC
    `).all() as any[];

    if (actor?.role === "HOD") {
      const accessibleDepartmentIds = getAccessibleDepartmentIdSet(actor);
      items = items.filter((item: any) => item?.temporary_department_id != null && accessibleDepartmentIds.has(item.temporary_department_id.toString()));
    }
    if (requestedDepartmentId) {
      items = items.filter((item: any) => idsEqual(item?.temporary_department_id, requestedDepartmentId) || idsEqual(item?.original_department_id, requestedDepartmentId));
    }
    if (requestedBookingId) {
      items = items.filter((item: any) => idsEqual(item?.booking_id, requestedBookingId));
    }
    res.json(items);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get(`/api/rooms`, authenticate, async (req, res) => {
  try {
    await ensureTemporaryRoomAllocationsTable();
    await refreshTemporaryRoomAllocationStatuses();
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const currentDate = now.toISOString().split('T')[0];

    // Batch pre-fetch #1: scheduled room IDs (single query — replaces N per-room queries)
    const scheduledRoomIds = new Set(
      (await db.prepare(`
        SELECT DISTINCT room_id FROM schedules
        WHERE day_of_week = ? AND start_time <= ? AND end_time > ?
      `).all(dayOfWeek, currentTime, currentTime) as any[])
        .map((s: any) => s.room_id?.toString()).filter(Boolean)
    );

    // Batch pre-fetch #2: booked room IDs (single query — replaces N per-room queries)
    const bookedRoomIds = new Set(
      (await db.prepare(`
        SELECT DISTINCT room_id FROM bookings
        WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
      `).all(currentDate, currentTime, currentTime) as any[])
        .map((b: any) => b.room_id?.toString()).filter(Boolean)
    );
    const activeTemporaryAllocations = await db.prepare(`
      SELECT room_id
      FROM temporary_room_allocations
      WHERE approved_date = ? AND status IN ('Upcoming', 'Active') AND start_time <= ? AND end_time > ?
    `).all(currentDate, currentTime, currentTime) as any[];
    const temporaryAllocatedRoomIds = new Set(activeTemporaryAllocations.map((item: any) => item.room_id?.toString()).filter(Boolean));

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

    // Enrich occupancy using pre-built Sets — O(1) per room, zero DB queries in loop
    const enrichedItems = roomItems.map((room: any) => {
      if (room.status !== 'Available') return room;
      if (scheduledRoomIds.has(room.id?.toString())) return { ...room, status: 'Occupied (Scheduled)' };
      if (bookedRoomIds.has(room.id?.toString())) return { ...room, status: 'Occupied (Booked)' };
      if (temporaryAllocatedRoomIds.has(room.id?.toString())) return { ...room, status: 'Occupied (Temporary Allocation)' };
      return room;
    });

    const requestedSearch = req.query.q?.toString().trim().toLowerCase() || "";
    const requestedSortKey = req.query.sortKey?.toString().trim() || "room_number";
    const requestedSortDir = req.query.sortDir?.toString().trim().toLowerCase() === "desc" ? "desc" : "asc";
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
      await ensureTemporaryRoomAllocationsTable();
      await refreshTemporaryRoomAllocationStatuses();
      const { roomId } = req.params;
      const { date } = req.query;
      const dayOfWeek = new Date(date as string).toLocaleDateString('en-US', { weekday: 'long' });
      
      const schedules = await db.prepare(`SELECT * FROM schedules WHERE room_id = ? AND day_of_week = ?`).all(roomId, dayOfWeek);
      const bookings = await db.prepare(`SELECT * FROM bookings WHERE room_id = ? AND date = ? AND status = 'Approved'`).all(roomId, date);
      const temporaryAllocations = await db.prepare(`
        SELECT *
        FROM temporary_room_allocations
        WHERE room_id = ? AND approved_date = ?
        ORDER BY start_time ASC, id ASC
      `).all(roomId, date) as any[];
      
      res.json({ schedules, bookings, temporaryAllocations });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

createCrudRoutes("rooms");
createCrudRoutes("schools");
createCrudRoutes("departments");
createCrudRoutes("department_allocations");
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
    const now = new Date();
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    const currentDate = now.toISOString().split('T')[0];

    const currentlyScheduled = await db.prepare(`
      SELECT COUNT(DISTINCT room_id) as count FROM (
        SELECT room_id FROM schedules 
        WHERE day_of_week = ? AND start_time <= ? AND end_time > ?
        UNION
        SELECT room_id FROM bookings 
        WHERE date = ? AND status = 'Approved' AND start_time <= ? AND end_time > ?
      )
    `).get(dayOfWeek, currentTime, currentTime, currentDate, currentTime, currentTime) as any;

    const availableNow = totalRooms.count - maintenanceRooms.count - currentlyScheduled.count;

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
      availableNow: availableNow,
      equipmentIssues: equipmentIssues.count,
      pendingBookings: pendingBookings.count,
      scheduledRooms: currentlyScheduled.count,
      recentAlerts
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- VACANCY CHECK ROUTE ---

app.get("/api/rooms/vacant", authenticate, async (req, res) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
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

  const dayOfWeek = new Date(date as string).toLocaleDateString('en-US', { weekday: 'long' });
  const requestedStart = time as string;
  
  // Calculate end time
  const [h, m] = requestedStart.split(':').map(Number);
  const durationMinutes = Math.round((parseFloat(duration as string) || 1) * 60);
  const endDate = new Date();
  endDate.setHours(h, m || 0, 0, 0);
  endDate.setMinutes(endDate.getMinutes() + durationMinutes);
  const requestedEnd = `${endDate.getHours().toString().padStart(2, '0')}:${endDate.getMinutes().toString().padStart(2, '0')}`;

  const allRoomsRaw = await db.prepare("SELECT * FROM rooms WHERE status = 'Available' AND COALESCE(is_bookable, 1) != 0").all() as any[];
  const allRooms = allRoomsRaw.filter(room =>
    isReservableRoomRecord(room) &&
    (minimumCapacity === null || (parseInt(room.capacity, 10) || 0) >= minimumCapacity)
  );

  // Filter out rooms that have schedules
  const busySchedules = await db.prepare(`
    SELECT room_id FROM schedules 
    WHERE day_of_week = ? 
    AND NOT (end_time <= ? OR start_time >= ?)
  `).all(dayOfWeek, requestedStart, requestedEnd) as any[];

  // Filter out rooms that have bookings
  const busyBookings = await db.prepare(`
    SELECT room_id FROM bookings 
    WHERE date = ? 
    AND status = 'Approved'
    AND NOT (end_time <= ? OR start_time >= ?)
  `).all(date, requestedStart, requestedEnd) as any[];
  const busyTemporaryAllocations = await db.prepare(`
    SELECT room_id FROM temporary_room_allocations
    WHERE approved_date = ?
      AND status IN ('Upcoming', 'Active')
      AND NOT (end_time <= ? OR start_time >= ?)
  `).all(date, requestedStart, requestedEnd) as any[];

  const busyRoomIds = new Set([
    ...busySchedules.map(s => s.room_id),
    ...busyBookings.map(b => b.room_id),
    ...busyTemporaryAllocations.map((item: any) => item.room_id),
  ]);

  const vacantRooms = allRooms.filter(r => !busyRoomIds.has(r.id));
  res.json(vacantRooms);
});

// --- USAGE REPORTS & AI SUGGESTIONS ---

app.get("/api/events/search-rooms", authenticate, async (req, res) => {
  await ensureTemporaryRoomAllocationsTable();
  await refreshTemporaryRoomAllocationStatuses();
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

  const dayOfWeek = new Date(date as string).toLocaleDateString('en-US', { weekday: 'long' });

  try {
    // 1. Get all reservable rooms using the same normalized rules as room management.
    const allRoomsRaw = await db.prepare("SELECT * FROM rooms WHERE status = 'Available' AND COALESCE(is_bookable, 1) != 0").all() as any[];
    const allRooms = allRoomsRaw.filter(isReservableRoomRecord);
    
    // 2. Get busy rooms from schedules
    const busyInSchedules = await db.prepare(`
      SELECT DISTINCT room_id FROM schedules 
      WHERE day_of_week = ? 
      AND (
        (start_time < ? AND end_time > ?) OR
        (start_time < ? AND end_time > ?) OR
        (start_time >= ? AND start_time < ?)
      )
    `).all(dayOfWeek, endTime, startTime, startTime, endTime, startTime, endTime) as any[];
    const busyRoomIdsSchedules = new Set(busyInSchedules.map(s => s.room_id));

    // 3. Get busy rooms from bookings
    const busyInBookings = await db.prepare(`
      SELECT DISTINCT room_id FROM bookings 
      WHERE date = ? AND status = 'Approved'
      AND (
        (start_time < ? AND end_time > ?) OR
        (start_time < ? AND end_time > ?) OR
        (start_time >= ? AND start_time < ?)
      )
    `).all(date, endTime, startTime, startTime, endTime, startTime, endTime) as any[];
    const busyRoomIdsBookings = new Set(busyInBookings.map(b => b.room_id));
    const busyInTemporaryAllocations = await db.prepare(`
      SELECT DISTINCT room_id FROM temporary_room_allocations
      WHERE approved_date = ? AND status IN ('Upcoming', 'Active')
      AND (
        (start_time < ? AND end_time > ?) OR
        (start_time < ? AND end_time > ?) OR
        (start_time >= ? AND start_time < ?)
      )
    `).all(date, endTime, startTime, startTime, endTime, startTime, endTime) as any[];
    const busyRoomIdsTemporary = new Set(busyInTemporaryAllocations.map((item: any) => item.room_id));

    // 4. Filter vacant rooms
    const vacantRooms = allRooms.filter(r => !busyRoomIdsSchedules.has(r.id) && !busyRoomIdsBookings.has(r.id) && !busyRoomIdsTemporary.has(r.id));

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
    const [rooms, schedules, allBookings, maintenance, departments, schools, allocations] = await Promise.all([
      db.prepare(`
        SELECT r.*, pr.room_number as parent_room_number, bld.name as building_name, b.name as block_name, f.floor_number
        FROM rooms r
        LEFT JOIN rooms pr ON r.parent_room_id = pr.id
        JOIN floors f ON r.floor_id = f.id
        JOIN blocks b ON f.block_id = b.id
        JOIN buildings bld ON b.building_id = bld.id
      `).all(),
      db.prepare("SELECT * FROM schedules").all(),
      db.prepare("SELECT * FROM bookings").all(),
      db.prepare("SELECT * FROM maintenance").all(),
      db.prepare("SELECT * FROM departments").all(),
      db.prepare("SELECT * FROM schools").all(),
      db.prepare("SELECT room_id, department_id, school_id, id FROM department_allocations ORDER BY id DESC").all(),
    ]) as [any[], any[], any[], any[], any[], any[], any[]];

    const calculateHours = (start: string, end: string) => {
      if (!start || !end) return 0;
      const [h1, m1] = start.split(':').map(Number);
      const [h2, m2] = end.split(':').map(Number);
      return (h2 + m2 / 60) - (h1 + m1 / 60);
    };

    // Pre-group by room_id to avoid O(rooms × records) filter loops in rooms.map
    const schedulesByRoom = new Map<number, any[]>();
    for (const s of schedules) {
      const arr = schedulesByRoom.get(s.room_id);
      if (arr) arr.push(s); else schedulesByRoom.set(s.room_id, [s]);
    }
    const approvedBookingsByRoom = new Map<number, any[]>();
    const allBookingsByRoom = new Map<number, any[]>();
    for (const b of allBookings) {
      const allArr = allBookingsByRoom.get(b.room_id);
      if (allArr) allArr.push(b); else allBookingsByRoom.set(b.room_id, [b]);
      if (b.status === 'Approved') {
        const approvedArr = approvedBookingsByRoom.get(b.room_id);
        if (approvedArr) approvedArr.push(b); else approvedBookingsByRoom.set(b.room_id, [b]);
      }
    }
    const openMaintenanceCountByRoom = new Map<number, number>();
    for (const item of maintenance) {
      if (item.status !== 'Completed') {
        openMaintenanceCountByRoom.set(item.room_id, (openMaintenanceCountByRoom.get(item.room_id) || 0) + 1);
      }
    }

    const latestAllocationByRoom = new Map<number, any>();
    for (const allocation of allocations) {
      if (!latestAllocationByRoom.has(allocation.room_id)) {
        latestAllocationByRoom.set(allocation.room_id, allocation);
      }
    }

    const departmentById = new Map<number, any>();
    for (const dept of departments) departmentById.set(dept.id, dept);
    const schoolById = new Map<number, any>();
    for (const school of schools) schoolById.set(school.id, school);

    const reports = rooms.map((room: any) => {
      const roomSchedules = schedulesByRoom.get(room.id) || [];
      const roomBookings = approvedBookingsByRoom.get(room.id) || [];
      const allRoomBookings = allBookingsByRoom.get(room.id) || [];
      const allocation = latestAllocationByRoom.get(room.id);
      const inferredDepartmentCounts = new Map<number, number>();
      for (const entry of [...roomSchedules, ...allRoomBookings]) {
        if (!entry.department_id) continue;
        inferredDepartmentCounts.set(entry.department_id, (inferredDepartmentCounts.get(entry.department_id) || 0) + 1);
      }
      const inferredDepartmentId = Array.from(inferredDepartmentCounts.entries())
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      const resolvedDepartmentId = allocation?.department_id || inferredDepartmentId || null;
      const department = resolvedDepartmentId ? departmentById.get(resolvedDepartmentId) : undefined;
      const resolvedSchoolId = allocation?.school_id || department?.school_id || null;
      const school = resolvedSchoolId ? schoolById.get(resolvedSchoolId) : undefined;
      const maintenanceIssues = openMaintenanceCountByRoom.get(room.id) || 0;

      const scheduledHours = roomSchedules.reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bookedHours = roomBookings.reduce((acc, b) => {
        const h = calculateHours(b.start_time, b.end_time);
        return acc + h;
      }, 0);
      
      const totalUsedHours = scheduledHours + bookedHours;
      const availableHours = 72; // Assuming 12h * 6 days
      const utilization = (totalUsedHours / availableHours) * 100;

      return {
        room_id: room.id,
        room_number: room.room_number,
        building: room.building_name,
        block: room.block_name,
        floor_number: room.floor_number,
        department_id: resolvedDepartmentId,
        department: department?.name || "Unmapped",
        school: school?.name || "Unmapped",
        room_type: room.room_type,
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
        flags: [
          utilization < 20 ? "Underused" : null,
          utilization > 80 ? "Overused" : null,
          maintenanceIssues > 0 ? "Maintenance Risk" : null,
          !department ? "Department Unmapped" : null,
        ].filter(Boolean)
      };
    });

    // Pre-group reports for O(1) lookups in aggregation
    const reportsByBuilding = new Map<string, typeof reports>();
    const reportsByDeptId = new Map<number, typeof reports>();
    for (const report of reports) {
      if (report.building) {
        const arr = reportsByBuilding.get(report.building);
        if (arr) arr.push(report); else reportsByBuilding.set(report.building, [report]);
      }
      if (report.department_id) {
        const arr = reportsByDeptId.get(report.department_id);
        if (arr) arr.push(report); else reportsByDeptId.set(report.department_id, [report]);
      }
    }

    const buildingReports = Array.from(reportsByBuilding.entries()).map(([building, buildingRooms]) => {
      const avgUtilization = buildingRooms.reduce((acc, r) => acc + r.utilization, 0) / (buildingRooms.length || 1);
      return {
        name: building,
        roomCount: buildingRooms.length,
        avgUtilization: Math.round(avgUtilization),
        maintenanceIssues: buildingRooms.reduce((acc, r) => acc + r.maintenanceIssues, 0)
      };
    });

    const bookingStatusOptions = [
      "Pending",
      "HOD Recommended",
      "Awaiting Alternative Response",
      "Clarification Required",
      "Waitlisted",
      "No Room Available",
      "Approved",
      "Postponed",
      "Rejected",
    ];
    const bookingCountByStatus = new Map<string, number>();
    for (const b of allBookings) {
      if (b.status) bookingCountByStatus.set(b.status, (bookingCountByStatus.get(b.status) || 0) + 1);
    }
    const bookingStatusReports = bookingStatusOptions.map(status => ({
      name: status,
      count: bookingCountByStatus.get(status) || 0,
    }));

    // Aggregate by Department
    const deptReports = departments.map((dept: any) => {
      const deptRooms = reportsByDeptId.get(dept.id) || [];
      const totalUtilization = deptRooms.reduce((acc, r) => acc + r.utilization, 0);
      const avgUtilization = deptRooms.length > 0 ? totalUtilization / deptRooms.length : 0;
      return {
        name: dept.name,
        school_id: dept.school_id,
        school: schoolById.get(dept.school_id)?.name || "Unmapped",
        avgUtilization: Math.round(avgUtilization),
        roomCount: deptRooms.length
      };
    });

    // Aggregate by School
    const deptReportsBySchoolId = new Map<number, typeof deptReports>();
    for (const d of deptReports) {
      if (d.school_id) {
        const arr = deptReportsBySchoolId.get(d.school_id);
        if (arr) arr.push(d); else deptReportsBySchoolId.set(d.school_id, [d]);
      }
    }
    const schoolReports = schools.map((school: any) => {
      const schoolDepts = deptReportsBySchoolId.get(school.id) || [];
      const totalUtilization = schoolDepts.reduce((acc, d) => acc + d.avgUtilization, 0);
      const avgUtilization = schoolDepts.length > 0 ? totalUtilization / schoolDepts.length : 0;
      return {
        name: school.name,
        avgUtilization: Math.round(avgUtilization),
        deptCount: schoolDepts.length
      };
    });

    res.json({ roomReports: reports, deptReports, schoolReports, buildingReports, bookingStatusReports });
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
      const sHours = schedules.filter(s => s.room_id === room.id).reduce((acc, s) => acc + calculateHours(s.start_time, s.end_time), 0);
      const bHours = bookings.filter(b => b.room_id === room.id).reduce((acc, b) => acc + calculateHours(b.start_time, b.end_time), 0);
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

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "smart-campus-api",
    database: db.dialect,
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

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
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
