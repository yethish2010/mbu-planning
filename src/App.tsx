import { useState, useEffect, createContext, useContext, useRef, useMemo, Fragment, Component } from 'react';
import { BrowserRouter, HashRouter, Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, Users, Building2, Layers, DoorOpen, 
  Wrench, Calendar, Clock, BookOpen, BrainCircuit, 
  BarChart3, FileText, Bell, LogOut, Menu, X,
  ChevronRight, Search, Plus, Edit2, Trash2, Check, AlertTriangle,
  Globe, Map as MapIcon, Activity, Zap, TrendingUp, TrendingDown, Sparkles, FileSpreadsheet,
  PieChart as PieChartIcon, AlertCircle, CheckCircle2, Info, LayoutGrid
} from 'lucide-react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, PerspectiveCamera, Environment, ContactShadows, Float, Html } from '@react-three/drei';
import * as THREE from 'three';
import { GoogleGenAI } from "@google/genai";
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as XLSX from 'xlsx';

import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  PieChart, Pie, Cell, Legend, LineChart, Line, AreaChart, Area
} from 'recharts';

// --- UTILS ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const GEMINI_API_KEY = (import.meta as any).env?.VITE_GEMINI_API_KEY || '';
function getGenAIClient() {
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini API key is missing. Please set VITE_GEMINI_API_KEY in .env.");
  }
  return new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

const parseAIResponse = (text: string) => {
  try {
    let cleanText = text.trim();
    if (cleanText.includes("```json")) {
      cleanText = cleanText.split("```json")[1].split("```")[0];
    } else if (cleanText.includes("```")) {
      cleanText = cleanText.split("```")[1].split("```")[0];
    }
    return JSON.parse(cleanText.trim());
  } catch (err) {
    console.error("AI Parse Error:", err, "Raw Text:", text);
    throw new Error("Invalid AI response format");
  }
};

const getAIResponseText = async (response: any) => {
  const textValue = response?.text;
  if (typeof textValue === 'function') return await textValue.call(response);
  if (typeof textValue === 'string') return textValue;
  if (typeof response?.response?.text === 'function') return await response.response.text();
  throw new Error("AI response did not include readable text.");
};

const INVALID_TIMETABLE_LABELS = [
  'reading period',
  'reading periods',
  'period',
  'periods',
  'break',
  'lunch',
  'tea break',
  'interval',
  'library',
];

const isInvalidTimetableValue = (value: unknown) => {
  if (!value) return true;
  const normalized = value.toString().trim().toLowerCase();
  return !normalized || INVALID_TIMETABLE_LABELS.includes(normalized);
};

const sanitizeExtractedSchedule = (schedule: any) => {
  if (!schedule || isInvalidTimetableValue(schedule.course_name)) return null;
  if (!schedule.room || !schedule.day_of_week || !schedule.start_time || !schedule.end_time) return null;

  return {
    ...schedule,
    section: schedule.section?.toString().trim() || null,
    course_name: schedule.course_name?.toString().trim(),
    faculty: schedule.faculty?.toString().trim() || 'TBA',
    year_of_study: normalizeYearOfStudyValue(schedule.year_of_study ?? schedule.year),
    semester: normalizeExactSemesterValue(schedule.semester, schedule.year_of_study ?? schedule.year),
    room: schedule.room?.toString().trim(),
    day_of_week: schedule.day_of_week?.toString().trim(),
    start_time: schedule.start_time?.toString().trim(),
    end_time: schedule.end_time?.toString().trim(),
  };
};

const normalizeLookupValue = (value: unknown) =>
  value?.toString().trim().toLowerCase().replace(/\s+/g, ' ') || '';

const ROOM_IMPORT_OPTIONAL_PLACEHOLDERS = new Set([
  '-',
  '--',
  '---',
  'n/a',
  'na',
  'none',
  'null',
  'nil',
]);

const normalizeOptionalImportValue = (value: unknown) => {
  const raw = value?.toString().trim() || '';
  if (!raw) return '';
  const normalized = normalizeLookupValue(raw);
  return ROOM_IMPORT_OPTIONAL_PLACEHOLDERS.has(normalized) ? '' : raw;
};

const normalizeOptionalImportLookupValue = (value: unknown) =>
  normalizeLookupValue(normalizeOptionalImportValue(value));

const getRoomLookupVariants = (value: unknown) => {
  const base = normalizeLookupValue(value);
  if (!base) return [];

  const variants = new Set<string>([base]);
  const withoutPrefix = base
    .replace(/\b(?:room|r)\s*\.?\s*(?:no|number)?\.?\s*[:\-]?\s*/g, '')
    .trim();

  if (withoutPrefix) {
    variants.add(withoutPrefix);
  }

  const normalizedSeparators = withoutPrefix
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalizedSeparators) {
    variants.add(normalizedSeparators);
  }

  const compact = normalizedSeparators.replace(/[^a-z0-9]/g, '');
  if (compact.length >= 3) {
    variants.add(compact);
  }

  const withoutLeadingZeros = normalizedSeparators.match(/^0*(\d+[a-z]?)$/i)?.[1]?.toLowerCase();
  if (withoutLeadingZeros) {
    variants.add(withoutLeadingZeros);
  }

  return Array.from(variants).filter(Boolean);
};

const roomLookupMatches = (candidate: unknown, targetVariants: Set<string>) => {
  if (targetVariants.size === 0) return false;
  return getRoomLookupVariants(candidate).some(variant => targetVariants.has(variant));
};

const idsMatch = (left: unknown, right: unknown) =>
  left !== undefined && left !== null && right !== undefined && right !== null && left.toString() === right.toString();

const SCHOOL_TYPE_OPTIONS = [
  'Administration',
  'Agriculture',
  'Arts and Design',
  'Commerce and Management',
  'Computing',
  'Distance and Online Education',
  'Engineering',
  'Film Academy',
  'Liberal Arts and Sciences',
  'Media Studies',
  'Nursing',
  'Paramedical and Health Sciences',
  'Pharmacy',
];

const normalizeSchoolTypeValue = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return 'Administration';

  const aliases: Record<string, string> = {
    admin: 'Administration',
    administrative: 'Administration',
    agriculture: 'Agriculture',
    art: 'Arts and Design',
    arts: 'Arts and Design',
    design: 'Arts and Design',
    business: 'Commerce and Management',
    commerce: 'Commerce and Management',
    management: 'Commerce and Management',
    computing: 'Computing',
    computer: 'Computing',
    cse: 'Computing',
    online: 'Distance and Online Education',
    distance: 'Distance and Online Education',
    engineering: 'Engineering',
    film: 'Film Academy',
    liberal: 'Liberal Arts and Sciences',
    science: 'Liberal Arts and Sciences',
    sciences: 'Liberal Arts and Sciences',
    media: 'Media Studies',
    nursing: 'Nursing',
    paramedical: 'Paramedical and Health Sciences',
    health: 'Paramedical and Health Sciences',
    medical: 'Paramedical and Health Sciences',
    pharma: 'Pharmacy',
    pharmacy: 'Pharmacy',
    pharmaceutical: 'Pharmacy',
  };

  const matchedOption = SCHOOL_TYPE_OPTIONS.find(option => normalizeLookupValue(option) === normalized);
  if (matchedOption) return matchedOption;

  const matchedAlias = Object.entries(aliases).find(([alias]) => normalized.includes(alias));
  return matchedAlias?.[1] || value?.toString().trim() || 'Administration';
};

const parseSemesterNumber = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
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

const parseYearOfStudyNumber = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return null;

  const numericMatch =
    normalized.match(/(?:^|\b)(\d+)(?:st|nd|rd|th)?\s*year\b/)?.[1] ||
    normalized.match(/\byear\s*(\d+)\b/)?.[1] ||
    normalized.match(/^(\d+)$/)?.[1];
  if (numericMatch) return Number(numericMatch);

  const romanMatch =
    normalized.match(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\s*year\b/)?.[1] ||
    normalized.match(/\byear\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/)?.[1] ||
    normalized.match(/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/)?.[1];
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
  return romanToNumber[romanMatch] || null;
};

const normalizeSemesterValue = (value: unknown, fallback = 'Odd') => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return fallback;
  if (normalized.includes('odd') || normalized.includes('fall')) return 'Odd';
  if (normalized.includes('even') || normalized.includes('spring') || normalized.includes('summer')) return 'Even';

  const semesterNumber = parseSemesterNumber(value);
  if (semesterNumber) {
    return Number(semesterNumber) % 2 === 0 ? 'Even' : 'Odd';
  }

  return fallback;
};

const getExactSemesterLabel = (value: number) => {
  const numerals: Record<number, string> = {
    1: 'I',
    2: 'II',
    3: 'III',
    4: 'IV',
    5: 'V',
    6: 'VI',
    7: 'VII',
    8: 'VIII',
    9: 'IX',
    10: 'X',
  };
  return `${numerals[value] || value.toString()} Semester`;
};

const getExactSemesterNumber = (yearOfStudy: unknown, semester: unknown) => {
  const parsedSemester = parseSemesterNumber(semester);
  if (parsedSemester) return parsedSemester;

  const yearNumber = Number(normalizeYearOfStudyValue(yearOfStudy, ''));
  if (!yearNumber) return null;

  const parity = normalizeSemesterValue(semester, '');
  if (parity === 'Odd') return yearNumber * 2 - 1;
  if (parity === 'Even') return yearNumber * 2;
  return null;
};

const normalizeExactSemesterValue = (value: unknown, yearOfStudy: unknown = '', fallback = '') => {
  const semesterNumber = getExactSemesterNumber(yearOfStudy, value);
  if (semesterNumber) return getExactSemesterLabel(semesterNumber);

  const normalized = normalizeLookupValue(value);
  if (!normalized) return fallback;

  if (normalized.includes('odd') || normalized.includes('even')) {
    return fallback || value?.toString().trim() || '';
  }

  return value?.toString().trim() || fallback;
};

const SCHEDULE_SEMESTER_OPTIONS = Array.from({ length: 10 }, (_, index) => getExactSemesterLabel(index + 1));

const getScheduleSemesterOptions = (yearOfStudy: unknown) => {
  const yearNumber = Number(normalizeYearOfStudyValue(yearOfStudy, ''));
  if (!yearNumber) return SCHEDULE_SEMESTER_OPTIONS;

  const oddSemester = yearNumber * 2 - 1;
  const evenSemester = yearNumber * 2;
  return [oddSemester, evenSemester]
    .filter((semesterNumber) => semesterNumber > 0 && semesterNumber <= SCHEDULE_SEMESTER_OPTIONS.length)
    .map(getExactSemesterLabel);
};

const PROGRAM_OPTIONS = [
  'B.Tech',
  'M.Tech',
  'BCA',
  'MCA',
  'BBA',
  'MBA',
  'B.Com',
  'M.Com',
  'B.Sc',
  'M.Sc',
  'B.A',
  'M.A',
  'B.Pharm',
  'D.Pharm',
  'M.Pharm',
  'Pharm.D',
  'B.Arch',
  'M.Arch',
  'B.Des',
  'M.Des',
  'B.Ed',
  'M.Ed',
  'Diploma',
  'Polytechnic',
  'LLB',
  'LLM',
  'PhD',
  'PG Diploma',
  'Certificate',
];

const PROGRAM_DURATION_YEARS: Record<string, number> = {
  'B.Tech': 4,
  'M.Tech': 2,
  'BCA': 3,
  'MCA': 2,
  'BBA': 3,
  'MBA': 2,
  'B.Com': 3,
  'M.Com': 2,
  'B.Sc': 3,
  'M.Sc': 2,
  'B.A': 3,
  'M.A': 2,
  'B.Pharm': 4,
  'D.Pharm': 2,
  'M.Pharm': 2,
  'Pharm.D': 6,
  'B.Arch': 5,
  'M.Arch': 2,
  'B.Des': 4,
  'M.Des': 2,
  'B.Ed': 2,
  'M.Ed': 2,
  'Diploma': 3,
  'Polytechnic': 3,
  'LLB': 3,
  'LLM': 2,
  'PhD': 5,
  'PG Diploma': 1,
  'Certificate': 1,
};

const normalizeProgramValue = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return '';

  const aliases: Record<string, string> = {
    btech: 'B.Tech',
    'b.tech': 'B.Tech',
    be: 'B.Tech',
    mtech: 'M.Tech',
    'm.tech': 'M.Tech',
    me: 'M.Tech',
    bca: 'BCA',
    mca: 'MCA',
    bba: 'BBA',
    mba: 'MBA',
    bcom: 'B.Com',
    'b.com': 'B.Com',
    mcom: 'M.Com',
    'm.com': 'M.Com',
    bsc: 'B.Sc',
    'b.sc': 'B.Sc',
    msc: 'M.Sc',
    'm.sc': 'M.Sc',
    ba: 'B.A',
    'b.a': 'B.A',
    ma: 'M.A',
    'm.a': 'M.A',
    bpharm: 'B.Pharm',
    'b.pharm': 'B.Pharm',
    dpharm: 'D.Pharm',
    'd.pharm': 'D.Pharm',
    mpharm: 'M.Pharm',
    'm.pharm': 'M.Pharm',
    pharmd: 'Pharm.D',
    'pharm.d': 'Pharm.D',
    barch: 'B.Arch',
    'b.arch': 'B.Arch',
    march: 'M.Arch',
    'm.arch': 'M.Arch',
    bdes: 'B.Des',
    'b.des': 'B.Des',
    mdes: 'M.Des',
    'm.des': 'M.Des',
    bed: 'B.Ed',
    'b.ed': 'B.Ed',
    med: 'M.Ed',
    'm.ed': 'M.Ed',
    diploma: 'Diploma',
    polytechnic: 'Polytechnic',
    llb: 'LLB',
    llm: 'LLM',
    phd: 'PhD',
    'pg diploma': 'PG Diploma',
    certificate: 'Certificate',
  };

  const exactMatch = PROGRAM_OPTIONS.find(option => normalizeLookupValue(option) === normalized);
  if (exactMatch) return exactMatch;
  return aliases[normalized] || value?.toString().trim() || '';
};

const normalizeYearOfStudyValue = (value: unknown, fallback = '') => {
  const yearNumber = parseYearOfStudyNumber(value);
  return yearNumber ? yearNumber.toString() : fallback;
};

const toRomanNumeral = (value: number) => {
  const numerals: Record<number, string> = {
    1: 'I',
    2: 'II',
    3: 'III',
    4: 'IV',
    5: 'V',
    6: 'VI',
    7: 'VII',
    8: 'VIII',
  };
  return numerals[value] || value.toString();
};

const getYearNumberFromAcademicContext = (yearOfStudy: unknown, semester: unknown) => {
  const normalizedYear = Number(normalizeYearOfStudyValue(yearOfStudy, ''));
  if (normalizedYear > 0) return normalizedYear;
  const semesterNumber = parseSemesterNumber(semester);
  return semesterNumber ? Math.ceil(semesterNumber / 2) : null;
};

const getYearDisplayLabel = (yearOfStudy: unknown, semester: unknown) => {
  const yearNumber = getYearNumberFromAcademicContext(yearOfStudy, semester);
  return yearNumber ? `${toRomanNumeral(yearNumber)} Year` : '-';
};

const formatOrdinal = (value: number) => {
  if (Number.isNaN(value)) return '';
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
};

const getProgramDurationYears = (program: unknown) =>
  PROGRAM_DURATION_YEARS[normalizeProgramValue(program)] || 4;

const getSemesterNumberForSelection = (yearOfStudy: unknown, semester: unknown) => {
  const yearNumber = Number(normalizeYearOfStudyValue(yearOfStudy));
  if (!yearNumber) return null;
  const normalizedSemester = normalizeSemesterValue(semester, '');
  if (normalizedSemester === 'Odd') return yearNumber * 2 - 1;
  if (normalizedSemester === 'Even') return yearNumber * 2;
  return null;
};

const getYearOfStudyOptions = (program: unknown, semester: unknown) => {
  const totalYears = getProgramDurationYears(program);
  const normalizedSemester = normalizeSemesterValue(semester, '');

  return Array.from({ length: totalYears }, (_, index) => {
    const yearNumber = index + 1;
    const semesterNumber = getSemesterNumberForSelection(yearNumber, normalizedSemester);
    return {
      value: yearNumber.toString(),
      label: semesterNumber
        ? `${formatOrdinal(yearNumber)} Year - ${formatOrdinal(semesterNumber)} Semester`
        : `${formatOrdinal(yearNumber)} Year`,
    };
  });
};

const getStudyPeriodDisplay = (yearOfStudy: unknown, semester: unknown, program?: unknown) => {
  const normalizedYear = normalizeYearOfStudyValue(yearOfStudy, '');
  if (!normalizedYear) return '-';
  const semesterNumber = getSemesterNumberForSelection(normalizedYear, semester);
  const programDuration = getProgramDurationYears(program);

  if (!semesterNumber) {
    return `${formatOrdinal(Number(normalizedYear))} Year`;
  }

  const yearLabel = Number(normalizedYear) <= programDuration
    ? `${formatOrdinal(Number(normalizedYear))} Year`
    : `Year ${normalizedYear}`;

  return `${yearLabel} - ${formatOrdinal(semesterNumber)} Semester`;
};

const isExaminationCalendarEvent = (calendar: any) => {
  const eventType = normalizeLookupValue(calendar?.event_type);
  const title = normalizeLookupValue(calendar?.title);
  return eventType.includes('exam') || eventType.includes('ciat') || title.includes('exam') || title.includes('ciat');
};

const normalizeAcademicContextText = (value: unknown) => normalizeLookupValue(value);

const doesAllocationMatchCalendarContext = (allocation: any, calendar: any) => {
  if (calendar?.id && allocation?.academic_calendar_id && idsMatch(allocation.academic_calendar_id, calendar.id)) return true;
  if (!idsMatch(allocation?.department_id, calendar?.department_id)) return false;

  const allocationSemester = normalizeSemesterValue(allocation?.semester, '');
  const calendarSemester = normalizeSemesterValue(calendar?.semester, '');
  if (allocationSemester && calendarSemester && allocationSemester !== calendarSemester) return false;

  if (calendar?.program && normalizeAcademicContextText(allocation?.program) !== normalizeAcademicContextText(calendar?.program)) return false;
  if (calendar?.batch && normalizeAcademicContextText(allocation?.batch) !== normalizeAcademicContextText(calendar?.batch)) return false;
  if (calendar?.academic_year && normalizeAcademicContextText(allocation?.academic_year) !== normalizeAcademicContextText(calendar?.academic_year)) return false;

  const allocationYear = normalizeYearOfStudyValue(allocation?.year_of_study, '');
  const calendarYear = normalizeYearOfStudyValue(calendar?.year_of_study, '');
  if (calendarYear && allocationYear && allocationYear !== calendarYear) return false;

  return true;
};

const doesScheduleMatchCalendarOverride = (schedule: any, calendar: any, batchRoomAllocations: any[] = [], date?: string) => {
  if (!idsMatch(schedule?.department_id, calendar?.department_id)) return false;
  const scheduleSemester = normalizeSemesterValue(schedule?.semester, '');
  const calendarSemester = normalizeSemesterValue(calendar?.semester, '');
  if (scheduleSemester && calendarSemester && scheduleSemester !== calendarSemester) return false;

  const scheduleYear = normalizeYearOfStudyValue(schedule?.year_of_study, '');
  const calendarYear = normalizeYearOfStudyValue(calendar?.year_of_study, '');
  if (calendarYear && scheduleYear && calendarYear !== scheduleYear) return false;

  const calendarHasSpecificContext = Boolean(
    calendar?.program || calendar?.batch || calendar?.academic_year || calendar?.year_of_study,
  );
  if (!calendarHasSpecificContext) return true;

  const relevantAllocations = batchRoomAllocations.filter(allocation => {
    if (schedule?.room_id != null && allocation?.room_id != null && !idsMatch(allocation.room_id, schedule.room_id)) return false;
    if (!idsMatch(allocation?.department_id, schedule?.department_id)) return false;

    const allocationSemester = normalizeSemesterValue(allocation?.semester, '');
    if (scheduleSemester && allocationSemester && allocationSemester !== scheduleSemester) return false;

    const normalizedDate = normalizeComparableDateValue(date);
    const allocationStartDate = normalizeComparableDateValue(allocation?.start_date);
    const allocationEndDate = normalizeComparableDateValue(allocation?.end_date);
    if (normalizedDate && allocationStartDate && allocationEndDate) {
      if (allocationStartDate > normalizedDate || allocationEndDate < normalizedDate) return false;
    }

    return true;
  });

  if (relevantAllocations.length === 0) return true;
  return relevantAllocations.some(allocation => doesAllocationMatchCalendarContext(allocation, calendar));
};

const isScheduleSuppressedForDate = (schedule: any, date: string, calendars: any[], batchRoomAllocations: any[] = []) => {
  if (!date || !Array.isArray(calendars) || calendars.length === 0) return false;
  const normalizedDate = normalizeComparableDateValue(date);
  return calendars.some(calendar =>
    isExaminationCalendarEvent(calendar) &&
    calendar?.start_date &&
    calendar?.end_date &&
    normalizeComparableDateValue(calendar.start_date) <= normalizedDate &&
    normalizeComparableDateValue(calendar.end_date) >= normalizedDate &&
    doesScheduleMatchCalendarOverride(schedule, calendar, batchRoomAllocations, normalizedDate)
  );
};

const getWeekDatesForReferenceDate = (referenceDate: string) => {
  const fallbackDate = referenceDate || formatLocalDate(new Date());
  const seedDate = new Date(`${fallbackDate}T00:00:00`);
  const mondayOffset = (seedDate.getDay() + 6) % 7;
  seedDate.setDate(seedDate.getDate() - mondayOffset);

  const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return Object.fromEntries(weekDays.map((day, index) => {
    const nextDate = new Date(seedDate);
    nextDate.setDate(seedDate.getDate() + index);
    return [day, formatLocalDate(nextDate)];
  })) as Record<string, string>;
};

const ROOM_TYPE_OPTIONS = [
  'Admin Office',
  'Auditorium',
  'Board Room',
  'Cafeteria',
  'Classroom',
  'Classroom Lab',
  'Common Room',
  'Computer Lab',
  'Conference Room',
  'Corridor',
  'Dean Office',
  'Electrical Room',
  'Emergency Exit',
  'Entrance',
  'Exam Hall',
  'Examination Section',
  'Exit',
  'Faculty Room',
  'Gym',
  'HOD Cabin',
  'Lab',
  'Language Lab',
  'Lecture Hall',
  'Library',
  'Lounge',
  'Main Entrance',
  'Maintenance Room',
  'Medical Room',
  'Meeting Room',
  'Multipurpose Classroom',
  'Multipurpose Lab',
  'Multipurpose Lecture Hall',
  'Multipurpose Room',
  'Office',
  'Pantry',
  'Reading Room',
  'Reception',
  'Records Room',
  'Research Lab',
  'Restroom',
  'Security Room',
  'Seminar Hall',
  'Server Room',
  'Smart Classroom',
  'Sports Room',
  'Staff Room',
  'Staircase',
  'Store',
  'Studio',
  'Tutorial Room',
  'Utility',
  'Waiting Area',
  'Workshop',
];
const EVENT_ROOM_TYPE_OPTIONS = [
  'Auditorium',
  'Board Room',
  'Classroom',
  'Classroom Lab',
  'Computer Lab',
  'Conference Room',
  'Exam Hall',
  'Gym',
  'Lab',
  'Language Lab',
  'Lecture Hall',
  'Meeting Room',
  'Multipurpose Classroom',
  'Multipurpose Lab',
  'Multipurpose Lecture Hall',
  'Multipurpose Room',
  'Research Lab',
  'Seminar Hall',
  'Smart Classroom',
  'Sports Room',
  'Studio',
  'Tutorial Room',
  'Workshop',
];
const RESTROOM_TYPE_OPTIONS = ['Male', 'Female'];
const ROOM_LAYOUT_OPTIONS = ['Normal', 'Shared Room', 'Split Parent', 'Split Child', 'Inside Parent', 'Inside Child'];
const HIERARCHY_PARENT_ROOM_LAYOUTS = ['Split Parent', 'Inside Parent'];
const HIERARCHY_CHILD_ROOM_LAYOUTS = ['Split Child', 'Inside Child'];
const HIERARCHY_ROOM_LAYOUTS = [...HIERARCHY_PARENT_ROOM_LAYOUTS, ...HIERARCHY_CHILD_ROOM_LAYOUTS];
const USAGE_CATEGORY_OPTIONS = ['Access', 'Administration', 'Dining', 'Examination', 'Healthcare', 'Lab Work', 'Meeting', 'Multipurpose', 'Office', 'Restricted', 'Restroom', 'Security', 'Sports', 'Storage', 'Teaching', 'Utility'];
const BOOKABLE_ROOM_TYPES = new Set([
  'Classroom',
  'Smart Classroom',
  'Lecture Hall',
  'Tutorial Room',
  'Seminar Hall',
  'Conference Room',
  'Auditorium',
  'Exam Hall',
  'Multipurpose Room',
  'Multipurpose Classroom',
  'Multipurpose Lecture Hall',
  'Classroom Lab',
  'Multipurpose Lab',
  'Lab',
  'Computer Lab',
  'Research Lab',
  'Language Lab',
  'Workshop',
  'Studio',
  'Meeting Room',
  'Board Room',
  'Sports Room',
  'Gym',
]);
const BOOKABLE_USAGE_CATEGORIES = new Set(['Teaching', 'Lab Work', 'Multipurpose', 'Meeting']);
const CAPACITY_ROOM_TYPES = new Set([
  'Classroom',
  'Smart Classroom',
  'Multipurpose Classroom',
  'Classroom Lab',
  'Multipurpose Lab',
  'Lab',
  'Computer Lab',
  'Research Lab',
  'Language Lab',
]);
const NON_CAPACITY_ROOM_TYPES = new Set([
  'Office',
  'Faculty Room',
  'Staff Room',
  'HOD Cabin',
  'Dean Office',
  'Examination Section',
  'Admin Office',
  'Reception',
  'Library',
  'Reading Room',
  'Waiting Area',
  'Common Room',
  'Lounge',
  'Pantry',
  'Cafeteria',
  'Store',
  'Records Room',
  'Server Room',
  'Electrical Room',
  'Maintenance Room',
  'Utility',
  'Restroom',
  'Medical Room',
  'Security Room',
  'Entrance',
  'Main Entrance',
  'Emergency Exit',
  'Exit',
  'Corridor',
  'Staircase',
]);

const ROOM_TYPE_MATCH_ORDER = [...ROOM_TYPE_OPTIONS]
  .sort((left, right) => normalizeLookupValue(right).length - normalizeLookupValue(left).length);

const normalizeRoomTypeValue = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return '';
  if (['class', 'classroom', 'classrooms', 'class room', 'class rooms'].includes(normalized)) return 'Classroom';
  if (['smart class', 'smart classroom'].includes(normalized)) return 'Smart Classroom';
  if (['lecture theatre', 'lecture theater', 'lecture hall'].includes(normalized)) return 'Lecture Hall';
  if (['tutorial', 'tutorial room'].includes(normalized)) return 'Tutorial Room';
  if (['auditorium', 'auditoriums'].includes(normalized)) return 'Auditorium';
  if (['exam hall', 'examination hall'].includes(normalized)) return 'Exam Hall';
  if (['multipurpose room', 'multi purpose room', 'multi-purpose room', 'multipurpose hall', 'multi purpose hall', 'multi-purpose hall'].includes(normalized)) return 'Multipurpose Room';
  if (['multipurpose classroom', 'multi purpose classroom', 'multi-purpose classroom'].includes(normalized)) return 'Multipurpose Classroom';
  if (['multipurpose lecture hall', 'multi purpose lecture hall', 'multi-purpose lecture hall', 'lecture hall lab', 'lecture hall/lab'].includes(normalized)) return 'Multipurpose Lecture Hall';
  if (['classroom lab', 'classroom laboratory', 'classroom cum lab', 'classroom/lab', 'class room lab', 'class room laboratory'].includes(normalized)) return 'Classroom Lab';
  if (['multipurpose lab', 'multi purpose lab', 'multi-purpose lab'].includes(normalized)) return 'Multipurpose Lab';
  if (normalized === 'restroom' || normalized === 'restrooms') return 'Restroom';
  if (normalized === 'lab' || normalized === 'laboratory') return 'Lab';
  if (['computer lab', 'computer laboratory'].includes(normalized)) return 'Computer Lab';
  if (['research lab', 'research laboratory'].includes(normalized)) return 'Research Lab';
  if (['language lab', 'language laboratory'].includes(normalized)) return 'Language Lab';
  if (['reading room', 'reading hall'].includes(normalized)) return 'Reading Room';
  if (['faculty room', 'faculty cabin'].includes(normalized)) return 'Faculty Room';
  if (['staff room'].includes(normalized)) return 'Staff Room';
  if (['hod cabin', 'hod room', 'head room'].includes(normalized)) return 'HOD Cabin';
  if (['dean office', 'dean room'].includes(normalized)) return 'Dean Office';
  if (['admin office', 'administration office'].includes(normalized)) return 'Admin Office';
  if (['examination section', 'exam section', 'examination cell', 'exam cell'].includes(normalized)) return 'Examination Section';
  if (['entrance', 'entry', 'entry point'].includes(normalized)) return 'Entrance';
  if (['main entrance', 'main entry'].includes(normalized)) return 'Main Entrance';
  if (['emergency exit', 'fire exit'].includes(normalized)) return 'Emergency Exit';
  if (['exit', 'exit point'].includes(normalized)) return 'Exit';
  if (['corridor', 'passage', 'passageway'].includes(normalized)) return 'Corridor';
  if (['staircase', 'stairs', 'stairway'].includes(normalized)) return 'Staircase';
  if (['meeting room'].includes(normalized)) return 'Meeting Room';
  if (['board room', 'boardroom'].includes(normalized)) return 'Board Room';
  if (['waiting area', 'waiting room'].includes(normalized)) return 'Waiting Area';
  if (['common room'].includes(normalized)) return 'Common Room';
  if (['store', 'store room', 'storage room'].includes(normalized)) return 'Store';
  if (['records room', 'record room'].includes(normalized)) return 'Records Room';
  if (['server room'].includes(normalized)) return 'Server Room';
  if (['electrical room', 'electric room'].includes(normalized)) return 'Electrical Room';
  if (['maintenance room'].includes(normalized)) return 'Maintenance Room';
  if (['medical room', 'sick room', 'first aid room'].includes(normalized)) return 'Medical Room';
  if (['security room', 'guard room'].includes(normalized)) return 'Security Room';
  if (['sports room', 'sports hall'].includes(normalized)) return 'Sports Room';
  const prefixedMatch = ROOM_TYPE_MATCH_ORDER.find((option) => {
    const normalizedOption = normalizeLookupValue(option);
    return (
      normalized === normalizedOption ||
      normalized.startsWith(`${normalizedOption} -`) ||
      normalized.startsWith(`${normalizedOption}:`) ||
      normalized.startsWith(`${normalizedOption}/`)
    );
  });
  if (prefixedMatch) return prefixedMatch;
  return value?.toString().trim() || '';
};

const normalizeRestroomTypeValue = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return '';
  if (['male', 'boys', 'men'].includes(normalized)) return 'Male';
  if (['female', 'girls', 'women'].includes(normalized)) return 'Female';
  return value?.toString().trim() || '';
};

const normalizeRoomLayoutValue = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return 'Normal';
  if (['split parent', 'split room', 'split'].includes(normalized)) return 'Split Parent';
  if (['split child', 'split section', 'section'].includes(normalized)) return 'Split Child';
  if (['inside parent', 'room inside', 'contains room', 'room inside parent'].includes(normalized)) return 'Inside Parent';
  if (['inside child', 'inside room', 'child room'].includes(normalized)) return 'Inside Child';
  if (['shared', 'shared room', 'multi entrance room', 'multi-entrance room', 'multiple entrance room', 'multiple door room', 'multi door room', 'multi-door room'].includes(normalized)) return 'Shared Room';
  return ROOM_LAYOUT_OPTIONS.find(option => normalizeLookupValue(option) === normalized) || value?.toString().trim() || 'Normal';
};

const normalizeUsageCategoryValue = (value: unknown, roomType?: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (normalized) {
    if (['exam', 'exams', 'examination', 'examination section', 'exam section', 'examination cell', 'exam cell'].includes(normalized)) return 'Examination';
    return USAGE_CATEGORY_OPTIONS.find(option => normalizeLookupValue(option) === normalized) || value?.toString().trim() || '';
  }

  const normalizedRoomType = normalizeRoomTypeValue(roomType);
  if (['Multipurpose Room', 'Multipurpose Classroom', 'Multipurpose Lecture Hall', 'Classroom Lab', 'Multipurpose Lab'].includes(normalizedRoomType)) return 'Multipurpose';
  if (['Lab', 'Computer Lab', 'Research Lab', 'Language Lab', 'Workshop', 'Studio'].includes(normalizedRoomType)) return 'Lab Work';
  if (['Classroom', 'Smart Classroom', 'Lecture Hall', 'Tutorial Room', 'Seminar Hall', 'Auditorium', 'Exam Hall', 'Library', 'Reading Room'].includes(normalizedRoomType)) return 'Teaching';
  if (['Conference Room', 'Meeting Room', 'Board Room'].includes(normalizedRoomType)) return 'Meeting';
  if (['Office', 'Faculty Room', 'Staff Room', 'HOD Cabin', 'Dean Office'].includes(normalizedRoomType)) return 'Office';
  if (normalizedRoomType === 'Examination Section') return 'Examination';
  if (['Admin Office', 'Reception', 'Waiting Area'].includes(normalizedRoomType)) return 'Administration';
  if (['Entrance', 'Main Entrance', 'Emergency Exit', 'Exit', 'Corridor', 'Staircase'].includes(normalizedRoomType)) return 'Access';
  if (['Store', 'Records Room'].includes(normalizedRoomType)) return 'Storage';
  if (normalizedRoomType === 'Restroom') return 'Restroom';
  if (['Utility', 'Server Room', 'Electrical Room', 'Maintenance Room'].includes(normalizedRoomType)) return 'Utility';
  if (['Pantry', 'Cafeteria'].includes(normalizedRoomType)) return 'Dining';
  if (normalizedRoomType === 'Medical Room') return 'Healthcare';
  if (['Sports Room', 'Gym'].includes(normalizedRoomType)) return 'Sports';
  if (normalizedRoomType === 'Security Room') return 'Security';
  return '';
};

const getRoomTypeDisplay = (room: any) => {
  const roomType = normalizeRoomTypeValue(room?.room_type);
  if (roomType === 'Lab' && room?.lab_name) {
    return `${roomType} - ${room.lab_name}`;
  }
  if (roomType === 'Restroom' && room?.restroom_type) {
    return `${roomType} - ${room.restroom_type}`;
  }
  return roomType || room?.room_type || '';
};

const getBaseRoomTypeDisplay = (room: any) =>
  normalizeRoomTypeValue(room?.room_type) || room?.room_type || '';

const getEffectiveBaseRoomTypeDisplay = (room: any) =>
  normalizeRoomTypeValue(room?.room_type || room?.sub_room_type) || room?.room_type || room?.sub_room_type || '';

const normalizeBooleanLikeValue = (value: unknown, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;

  const normalized = normalizeLookupValue(value);
  if (['yes', 'y', 'true', '1', 'bookable', 'available'].includes(normalized)) return true;
  if (['no', 'n', 'false', '0', 'not bookable', 'internal only', 'internal'].includes(normalized)) return false;
  return defaultValue;
};

const isRoomBookable = (room: any) => normalizeBooleanLikeValue(room?.is_bookable, true);

const isNonCapacityRoomType = (roomType: unknown) =>
  NON_CAPACITY_ROOM_TYPES.has(normalizeRoomTypeValue(roomType));

const isCapacityRoomType = (roomType: unknown) =>
  CAPACITY_ROOM_TYPES.has(normalizeRoomTypeValue(roomType));

const isRoomReservable = (room: any) => {
  if (!isRoomBookable(room)) return false;
  if (room?.status && room.status !== 'Available') return false;
  const roomType = normalizeRoomTypeValue(room?.room_type);
  if (isNonCapacityRoomType(roomType)) return false;
  const usageCategory = normalizeUsageCategoryValue(room?.usage_category, roomType);
  return BOOKABLE_ROOM_TYPES.has(roomType) || BOOKABLE_USAGE_CATEGORIES.has(usageCategory);
};

const splitAliasTokens = (value: unknown): string[] =>
  String(value ?? '')
    .split(/[\n,;|/]+/)
    .map((alias: string) => normalizeOptionalImportValue(alias))
    .filter((alias: string) => alias.length > 0);

const getRoomAliasList = (room: any): string[] =>
  splitAliasTokens(room?.room_aliases);

const normalizeRoomAliases = (value: unknown): string =>
  Array.from(new Set(splitAliasTokens(value))).join(', ');

const getRoomDisplayLabel = (room: any, rooms: any[] = []) => {
  if (!room) return 'Unknown Room';
  const parent = rooms.find(item => item.id?.toString() === room.parent_room_id?.toString());
  const parentLabel = parent?.room_number || room.parent_room_number;
  return parentLabel ? `${room.room_number} inside ${parentLabel}` : room.room_number;
};

const compareRoomSortLabels = (left: unknown, right: unknown) =>
  normalizeOptionalImportValue(left).localeCompare(
    normalizeOptionalImportValue(right),
    undefined,
    { numeric: true, sensitivity: 'base' },
  );

const compareRoomsByNaturalOrder = (left: any, right: any, rooms: any[] = []) => {
  const leftLabel = getRoomDisplayLabel(left, rooms) || left?.room_number || left?.Room || '';
  const rightLabel = getRoomDisplayLabel(right, rooms) || right?.room_number || right?.Room || '';
  const byLabel = compareRoomSortLabels(leftLabel, rightLabel);
  if (byLabel !== 0) return byLabel;
  const leftRoomId = left?.room_id || left?.RoomId || left?.room_id?.toString() || '';
  const rightRoomId = right?.room_id || right?.RoomId || right?.room_id?.toString() || '';
  return compareRoomSortLabels(leftRoomId, rightRoomId);
};

const getHierarchyLevelDisplay = (room: any) => {
  const roomLayout = normalizeRoomLayoutValue(room?.room_layout);
  if (roomLayout === 'Shared Room') return 'Shared';
  if (roomLayout === 'Split Parent') return 'Split Parent';
  if (roomLayout === 'Split Child') return 'Split Child';
  if (roomLayout === 'Inside Parent') return 'Inside Parent';
  if (roomLayout === 'Inside Child') return 'Inside Child';
  return 'Normal';
};

const CATEGORY_ROOM_REPORT_GROUP_ORDER = [
  'Class Rooms',
  'Labs',
  'Faculty & Admin',
  'Seminar Halls',
  'Auditoriums',
  'Examination Section Rooms',
  'Access & Circulation',
  'Utilities & Support',
] as const;

const getCategoryRoomReportGroup = (room: any) => {
  const roomType = getEffectiveBaseRoomTypeDisplay(room);
  if ([
    'Classroom',
    'Smart Classroom',
    'Lecture Hall',
    'Tutorial Room',
    'Multipurpose Classroom',
    'Multipurpose Lecture Hall',
  ].includes(roomType)) return 'Class Rooms';
  if ([
    'Lab',
    'Computer Lab',
    'Research Lab',
    'Language Lab',
    'Workshop',
    'Studio',
    'Classroom Lab',
    'Multipurpose Lab',
  ].includes(roomType)) return 'Labs';
  if ([
    'Office',
    'Faculty Room',
    'Staff Room',
    'HOD Cabin',
    'Dean Office',
    'Admin Office',
    'Reception',
    'Library',
    'Reading Room',
    'Meeting Room',
    'Board Room',
    'Waiting Area',
    'Common Room',
    'Lounge',
  ].includes(roomType)) return 'Faculty & Admin';
  if (['Seminar Hall', 'Conference Room'].includes(roomType)) return 'Seminar Halls';
  if (roomType === 'Auditorium') return 'Auditoriums';
  if (['Examination Section', 'Exam Hall'].includes(roomType)) return 'Examination Section Rooms';
  if (['Entrance', 'Main Entrance', 'Emergency Exit', 'Exit', 'Corridor', 'Staircase'].includes(roomType)) {
    return 'Access & Circulation';
  }
  if ([
    'Restroom',
    'Store',
    'Records Room',
    'Server Room',
    'Electrical Room',
    'Maintenance Room',
    'Utility',
    'Medical Room',
    'Security Room',
    'Sports Room',
    'Gym',
    'Pantry',
    'Cafeteria',
  ].includes(roomType)) return 'Utilities & Support';
  return 'Faculty & Admin';
};

const getRoomMixCounts = (rooms: any[] = []) => rooms.reduce((acc, room) => {
  const group = getCategoryRoomReportGroup(room);
  if (group === 'Class Rooms') acc.classrooms += 1;
  if (group === 'Labs') acc.labs += 1;
  return acc;
}, { classrooms: 0, labs: 0 });

const formatRoomMixSummary = (counts: { classrooms: number; labs: number }) =>
  `Classrooms: ${counts.classrooms} | Labs: ${counts.labs}`;

const getParentRoomDisplay = (room: any, rooms: any[] = []) => {
  if (!room || !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room?.room_layout))) return '';
  const parent = rooms.find(item => item.id?.toString() === room.parent_room_id?.toString());
  return parent?.room_number || room.parent_room_number || '';
};

const getRoomNameDisplay = (room: any) => {
  if (!room) return '';
  const roomLayout = normalizeRoomLayoutValue(room?.room_layout);
  if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(roomLayout)) {
    return room?.room_section_name?.toString().trim()
      || room?.sub_lab_name?.toString().trim()
      || room?.lab_name?.toString().trim()
      || '';
  }
  const explicitRoomName = room?.room_name?.toString().trim();
  if (explicitRoomName) return explicitRoomName;
  const labName = room?.lab_name?.toString().trim();
  if (labName) return labName;
  if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(roomLayout)) {
    return room?.room_section_name?.toString().trim() || '';
  }
  return '';
};

const findRoomsByImportLabel = (rooms: any[], value: unknown) => {
  const normalizedValue = normalizeLookupValue(value);
  const lookupVariants = new Set(getRoomLookupVariants(value));
  if (!normalizedValue) {
    return { normalizedValue, matchType: 'none', matches: [] as any[] };
  }

  const uniqueById = (items: any[]) => {
    const seen = new Set<string>();
    return items.filter((item: any) => {
      const key = item?.id?.toString() || '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const byRoomId = uniqueById(rooms.filter(room => {
    const roomIdValue = normalizeLookupValue(room.room_id);
    return !!roomIdValue && (roomIdValue === normalizedValue || lookupVariants.has(roomIdValue));
  }));
  if (byRoomId.length > 0) return { normalizedValue, matchType: 'room_id', matches: byRoomId };

  const byRoomNumber = uniqueById(rooms.filter(room => roomLookupMatches(room.room_number, lookupVariants)));
  if (byRoomNumber.length > 0) return { normalizedValue, matchType: 'room_number', matches: byRoomNumber };

  const byDisplayLabel = uniqueById(
    rooms.filter(room => roomLookupMatches(getRoomDisplayLabel(room, rooms), lookupVariants))
  );
  if (byDisplayLabel.length > 0) return { normalizedValue, matchType: 'display_label', matches: byDisplayLabel };

  const byAlias = uniqueById(
    rooms.filter(room => getRoomAliasList(room).some(alias => roomLookupMatches(alias, lookupVariants)))
  );
  if (byAlias.length > 0) return { normalizedValue, matchType: 'alias', matches: byAlias };

  return { normalizedValue, matchType: 'none', matches: [] as any[] };
};

const resolveRoomForImport = (rooms: any[], value: unknown) => {
  const { normalizedValue, matchType, matches } = findRoomsByImportLabel(rooms, value);

  if (!normalizedValue) {
    return {
      room: null as any,
      reason: 'missing' as const,
      note: 'Room value is empty in the import row.',
    };
  }

  if (matches.length === 1) {
    return {
      room: matches[0],
      reason: 'linked' as const,
      note: null as string | null,
      matchType,
    };
  }

  if (matches.length > 1) {
    return {
      room: null as any,
      reason: 'ambiguous' as const,
      note: `Multiple rooms match "${value?.toString().trim()}" (${matchType}). Use a unique Room ID or canonical Room Number to avoid cross-block mixing.`,
      matchType,
    };
  }

  return {
    room: null as any,
    reason: 'unmatched' as const,
    note: `Room label "${value?.toString().trim()}" did not match any room in Room Management.`,
    matchType,
  };
};

const findRoomByImportLabel = (rooms: any[], value: unknown) => {
  const resolution = resolveRoomForImport(rooms, value);
  return resolution.room || null;
};

const getImportValue = (row: any, labels: string[]) => {
  for (const label of labels) {
    const value = row[label];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const normalizeImportMatchValue = (value: unknown) =>
  value?.toString().trim().toLowerCase().replace(/\s+/g, ' ') || '';

const hasImportValue = (value: unknown) =>
  value !== undefined && value !== null && value !== '';

const findMatchingImportRecord = (records: any[], payload: any, uniqueFieldGroups: string[][]) => {
  for (const fields of uniqueFieldGroups) {
    if (fields.some(field => !hasImportValue(payload[field]))) continue;

    const existing = records.find(record =>
      fields.every(field =>
        hasImportValue(record?.[field]) &&
        normalizeImportMatchValue(record[field]) === normalizeImportMatchValue(payload[field])
      )
    );

    if (existing) return existing;
  }

  return null;
};

const getScheduleRenderSignature = (schedule: any) => [
  normalizeImportMatchValue(schedule?.room_id),
  normalizeImportMatchValue(schedule?.room_label),
  normalizeImportMatchValue(schedule?.section),
  normalizeImportMatchValue(schedule?.day_of_week),
  normalizeImportMatchValue(schedule?.start_time),
  normalizeImportMatchValue(schedule?.end_time),
  normalizeImportMatchValue(schedule?.course_code),
  normalizeImportMatchValue(schedule?.course_name),
  normalizeImportMatchValue(schedule?.faculty),
  normalizeImportMatchValue(schedule?.department_id),
].join('|');

const getScheduleAcademicContextKey = (schedule: any) => [
  normalizeImportMatchValue(schedule?.department_id),
  normalizeImportMatchValue(normalizeExactSemesterValue(schedule?.semester, schedule?.year_of_study, '')),
  normalizeImportMatchValue(getYearDisplayLabel(schedule?.year_of_study, schedule?.semester)),
  normalizeImportMatchValue(schedule?.section),
].join('|');

const getScheduleAcademicContextLabel = (schedule: any, departments: any[]) => {
  const departmentName = schedule?.department_name
    || departments.find((department: any) => idsMatch(department.id, schedule?.department_id))?.name
    || schedule?.department
    || '';
  const yearLabel = getYearDisplayLabel(schedule?.year_of_study, schedule?.semester);
  const semester = normalizeExactSemesterValue(schedule?.semester, schedule?.year_of_study, '');
  const section = schedule?.section?.toString().trim() || '';
  const contextParts = [departmentName, yearLabel !== '-' ? yearLabel : '', semester, section ? `Section ${section}` : ''];
  return contextParts.filter(Boolean).join(' • ');
  return [departmentName, semester, section ? `Section ${section}` : ''].filter(Boolean).join(' • ');
};

const deduplicateScheduleRows = (rows: any[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const signature = getScheduleRenderSignature(row);
    if (!signature.replace(/\|/g, '')) return true;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
};

const apiJson = async (url: string, options?: RequestInit) => {
  const res = await fetch(url, {
    credentials: 'include',
    ...(options || {}),
    headers: {
      ...(options?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || 'Import request failed');
  }
  return data;
};

const upsertImportRecord = async (apiPath: string, payload: any, uniqueFieldGroups: string[][]) => {
  const records = await apiJson(apiPath);
  const existing = findMatchingImportRecord(Array.isArray(records) ? records : [], payload, uniqueFieldGroups);

  if (existing?.id) {
    await apiJson(`${apiPath}/${existing.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { ...existing, ...payload, __importAction: 'updated' as const };
  }

  const createdRecord = await apiJson(apiPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ...createdRecord, __importAction: 'created' as const };
};

type ImportAuditRow = Record<string, any>;
type ImportAuditSummary = {
  totalRowsRead?: number;
  validRows?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
};
type ImportAuditResult = {
  message?: string;
  auditRows?: ImportAuditRow[];
  auditHeaders?: string[];
  auditTitle?: string;
  summary?: ImportAuditSummary;
};

const isBlocksStructureType = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  return normalized === 'blocks' || normalized === 'has blocks' || normalized === 'has block';
};

const findBuildingForImport = (buildings: any[], row: any, blockOrFloorId?: unknown) => {
  const buildingValue = getImportValue(row, ['Building', 'Building Name', 'Building ID']);
  const normalizedBuildingValue = normalizeLookupValue(buildingValue);

  const matchedByColumn = buildings.find(building =>
    normalizeLookupValue(building.name) === normalizedBuildingValue ||
    normalizeLookupValue(building.building_id) === normalizedBuildingValue
  );
  if (matchedByColumn) return matchedByColumn;

  const recordId = blockOrFloorId?.toString().trim();
  if (!recordId) return undefined;

  return buildings
    .filter(building => recordId.toLowerCase().startsWith(building.building_id?.toString().trim().toLowerCase()))
    .sort((a, b) => b.building_id.toString().length - a.building_id.toString().length)[0];
};

const findCampusForImport = (campuses: any[], row: any) => {
  const campusValue = getImportValue(row, ['Campus', 'Campus Name', 'Campus ID']);
  const normalizedCampusValue = normalizeLookupValue(campusValue);

  const matchedCampus = campuses.find(campus =>
    normalizeLookupValue(campus.name) === normalizedCampusValue ||
    normalizeLookupValue(campus.campus_id) === normalizedCampusValue
  );
  if (matchedCampus) return matchedCampus;

  return campuses.length === 1 ? campuses[0] : undefined;
};

const SEMESTER_OPTIONS = ['Odd', 'Even'];
const ACADEMIC_CALENDAR_EVENT_TYPES = ['Semester Period', 'Class Work', 'Examinations', 'Holiday', 'Vacation', 'Orientation', 'Registration', 'Project Review', 'Internship'];
const ALLOCATION_STATUS_OPTIONS = ['Planned', 'Active', 'Released'];
const BATCH_ALLOCATION_MODE_OPTIONS = ['Shared', 'Exclusive'];
const ACADEMIC_CALENDAR_TITLE_OPTIONS_BY_EVENT: Record<string, string[]> = {
  'Semester Period': ['Odd Semester', 'Even Semester', 'Teaching Period', 'Semester Duration'],
  'Class Work': ['Class Work', 'Instruction Period', 'Teaching Days'],
  Examinations: ['CIAT-I', 'CIAT-II', 'Mid Semester Examinations', 'Semester End Examinations', 'Practical Examinations'],
  Holiday: ['Public Holiday', 'Festival Holiday', 'Declared Holiday'],
  Vacation: ['Summer Vacation', 'Winter Vacation', 'Semester Break'],
  Orientation: ['Orientation Program', 'Student Induction'],
  Registration: ['Course Registration', 'Semester Registration'],
  'Project Review': ['Project Review - I', 'Project Review - II'],
  Internship: ['Internship Period'],
};

const getAcademicCalendarTitleOptions = (eventType: unknown) =>
  ACADEMIC_CALENDAR_TITLE_OPTIONS_BY_EVENT[eventType?.toString() || ''] || [];

const getAcademicCalendarEventRank = (eventType: unknown) => {
  const normalized = normalizeLookupValue(eventType);
  if (normalized.includes('semester')) return 0;
  if (normalized.includes('class')) return 1;
  if (normalized.includes('exam') || normalized.includes('ciat')) return 2;
  if (normalized.includes('holiday')) return 3;
  if (normalized.includes('vacation')) return 4;
  if (normalized.includes('registration')) return 5;
  if (normalized.includes('orientation')) return 6;
  if (normalized.includes('project')) return 7;
  if (normalized.includes('internship')) return 8;
  return 99;
};

const IMPORT_TEMPLATE_CONFIG: Record<string, { headers: string[]; exampleRows: Record<string, any>[]; instructions?: string[] }> = {
  User: {
    headers: ['Full Name', 'Employee ID', 'Role', 'Email Address', 'Department', 'Password'],
    exampleRows: [
      {
        'Full Name': 'Jane Administrator',
        'Employee ID': 'EMP-001',
        Role: 'Administrator',
        'Email Address': 'jane.admin@example.com',
        Department: 'Computer Science and Engineering',
        Password: 'Welcome123',
      },
    ],
  },
  Campus: {
    headers: ['Campus ID', 'Campus Name', 'Location', 'Description'],
    exampleRows: [
      {
        'Campus ID': 'CAMPUS-001',
        'Campus Name': 'Main Campus',
        Location: 'Madanapalle',
        Description: 'Primary academic campus',
      },
    ],
  },
  Building: {
    headers: ['Building ID', 'Building Name', 'Campus', 'Structure Type', 'Number of Blocks', 'Description'],
    exampleRows: [
      {
        'Building ID': 'BLDG-001',
        'Building Name': 'M-Plaza',
        Campus: 'Main Campus',
        'Structure Type': 'Has blocks',
        'Number of Blocks': 2,
        Description: 'Central teaching building',
      },
      {
        'Building ID': 'BLDG-002',
        'Building Name': 'Pharmacy',
        Campus: 'Main Campus',
        'Structure Type': 'No blocks, floors directly under building',
        'Number of Blocks': '',
        Description: 'Administrative offices',
      },
    ],
  },
  Block: {
    headers: ['Block ID', 'Block Name', 'Building', 'Description'],
    exampleRows: [
      {
        'Block ID': 'BLDG-001-BLOCK-A',
        'Block Name': 'Block A',
        Building: 'BLDG-001',
        Description: 'Classrooms and seminar halls',
      },
    ],
  },
  Floor: {
    headers: ['Floor ID Prefix', 'Building', 'Block / Direct Floors', 'Number of Floors', 'First Floor Number', 'Description'],
    exampleRows: [
      {
        'Floor ID Prefix': 'BLDG-001-BLOCK-A',
        Building: 'BLDG-001',
        'Block / Direct Floors': 'Block A',
        'Number of Floors': 3,
        'First Floor Number': -1,
        Description: 'Floors for Block A',
      },
      {
        'Floor ID Prefix': 'BLDG-002',
        Building: 'BLDG-002',
        'Block / Direct Floors': 'Direct floors',
        'Number of Floors': 3,
        'First Floor Number': 0,
        Description: 'Direct floors for Pharmacy',
      },
    ],
  },
  Room: {
    headers: ['Room ID', 'Room Number', 'Room Name', 'Room Aliases', 'Building', 'Block / Direct Floors', 'Floor', 'Room Layout', 'Sub Room Count', 'Room Type', 'Sub Room Type', 'Sub Room Name', 'Parent Room', 'Usage Category', 'Is Bookable', 'Capacity', 'Status', 'Lab Name', 'Sub Lab Name', 'Restroom For'],
    instructions: [
      'You can safely export Room Management data, edit it in Excel, and import it back to update existing rows. Keep Room ID, Room Number, Building, Block / Direct Floors, and Floor unchanged unless you intentionally want to move the room.',
      'For re-importing exported files, keep the exported Floor and Block / Direct Floors labels exactly as they appear in the file so the importer can match the same room location correctly.',
      'Every Room Number and every Room Alias must be unique across the same workbook. Do not reuse a room number for another room or child row.',
      'Room Name is the main name for a normal, shared, or parent room. For Split Child or Inside Child rows, keep Room Name blank and use Sub Room Name instead.',
      'Parent Room / Inside / Parent Room is optional for non-child rows. Leave it blank or use - only when there is no parent room.',
      'Use Shared Room for one physical room with multiple doors/entrances. It behaves like a normal single room and does not need Sub Room Count, Sub Room Name, or Parent Room.',
      'For seminar halls or shared venues with multiple room numbers like 4015 and 4016, create one canonical room row and list the alternate labels in Room Aliases separated by commas.',
      'If child rooms belong to an unnamed common space, create one internal parent/common room row with a unique Room Number like 123-BC-COMMON and link every child row to that parent.',
      'Use one row for the parent room and one separate row for every split/inside child room.',
      'For Split Parent or Inside Parent, enter Sub Room Count as the planned number of child rows.',
      'For Split Child or Inside Child, leave Sub Room Count blank and enter Parent Room as the parent room number or room ID.',
      'Room Type is for parent/normal rows. Sub Room Type is for Split Child or Inside Child rows.',
      'A child room can have a different room type and lab name from its parent room.',
      'Capacity is used only for classroom and lab room types. For classroom/lab parent rows and classroom/lab child rows, fill Capacity. For all other room types, leave Capacity blank and it will be imported as 0.',
      'For offices, cabins, examination sections, library/reading rooms, admin/support/service rooms, restrooms, and access spaces, leave Is Bookable and Capacity blank. They are imported as non-bookable spaces with capacity 0.',
      'During import, a parent row with Sub Room Count must have the same number of matching child rows in the same Excel file.',
    ],
    exampleRows: [
      {
        'Room ID': 'ROOM-LAB-201',
        'Room Number': 'LAB-201',
        'Room Name': 'Computer Lab',
        'Room Aliases': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Block A',
        Floor: 'First Floor',
        'Room Type': 'Lab',
        'Sub Room Type': '',
        'Room Layout': 'Split Parent',
        'Sub Room Count': 3,
        'Sub Room Name': 'Computer Lab',
        'Parent Room': '',
        'Usage Category': 'Lab Work',
        'Is Bookable': 'Yes',
        Capacity: 60,
        Status: 'Available',
        'Lab Name': 'Computer Lab',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-SH-4015',
        'Room Number': '4015',
        'Room Name': 'Shared Seminar Hall',
        'Room Aliases': '4016',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Direct floors',
        Floor: 'Fourth Floor',
        'Room Type': 'Seminar Hall',
        'Sub Room Type': '',
        'Room Layout': 'Shared Room',
        'Sub Room Count': '',
        'Sub Room Name': '',
        'Parent Room': '',
        'Usage Category': 'Teaching',
        'Is Bookable': 'Yes',
        Capacity: 120,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-LAB-201A',
        'Room Number': 'LAB-201-A',
        'Room Name': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Block A',
        Floor: 'First Floor',
        'Room Type': '',
        'Sub Room Type': 'Lab',
        'Room Layout': 'Split Child',
        'Sub Room Count': '',
        'Sub Room Name': 'Programming Section',
        'Parent Room': 'LAB-201',
        'Usage Category': 'Lab Work',
        'Is Bookable': 'Yes',
        Capacity: 30,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': 'Programming Section',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-LAB-201S',
        'Room Number': 'LAB-201-S',
        'Room Name': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Block A',
        Floor: 'First Floor',
        'Room Type': '',
        'Sub Room Type': 'Store',
        'Room Layout': 'Split Child',
        'Sub Room Count': '',
        'Sub Room Name': 'Store Room',
        'Parent Room': 'LAB-201',
        'Usage Category': 'Storage',
        'Is Bookable': '',
        Capacity: '',
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-019',
        'Room Number': '19',
        'Room Name': 'Main Room 19',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Block A',
        Floor: 'First Floor',
        'Room Type': 'Classroom',
        'Sub Room Type': '',
        'Room Layout': 'Inside Parent',
        'Sub Room Count': 1,
        'Sub Room Name': 'Main Room 19',
        'Parent Room': '',
        'Usage Category': 'Teaching',
        'Is Bookable': 'Yes',
        Capacity: 40,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-020',
        'Room Number': '20',
        'Room Name': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'Block A',
        Floor: 'First Floor',
        'Room Type': '',
        'Sub Room Type': 'Classroom',
        'Room Layout': 'Inside Child',
        'Sub Room Count': '',
        'Sub Room Name': 'Inside Room 20',
        'Parent Room': '19',
        'Usage Category': 'Teaching',
        'Is Bookable': 'Yes',
        Capacity: 20,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-123-BC-COMMON',
        'Room Number': '123-BC-COMMON',
        'Room Name': 'Common Room for 123-B and 123-C',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'South',
        Floor: 'Basement 1 (M-Plaza - South)',
        'Room Type': 'Common Room',
        'Sub Room Type': '',
        'Room Layout': 'Split Parent',
        'Sub Room Count': 2,
        'Sub Room Name': 'Common Room for 123-B and 123-C',
        'Parent Room': '',
        'Usage Category': 'Restricted',
        'Is Bookable': '',
        Capacity: '',
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-123-B',
        'Room Number': '123-B',
        'Room Name': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'South',
        Floor: 'Basement 1 (M-Plaza - South)',
        'Room Type': '',
        'Sub Room Type': 'Lab',
        'Room Layout': 'Split Child',
        'Sub Room Count': '',
        'Sub Room Name': 'Exercise Therapy Lab',
        'Parent Room': '123-BC-COMMON',
        'Usage Category': 'Lab Work',
        'Is Bookable': 'Yes',
        Capacity: 24,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': 'Exercise Therapy Lab',
        'Restroom For': '',
      },
      {
        'Room ID': 'ROOM-123-C',
        'Room Number': '123-C',
        'Room Name': '',
        Building: 'M-Plaza',
        'Block / Direct Floors': 'South',
        Floor: 'Basement 1 (M-Plaza - South)',
        'Room Type': '',
        'Sub Room Type': 'Classroom',
        'Room Layout': 'Split Child',
        'Sub Room Count': '',
        'Sub Room Name': 'Class Room',
        'Parent Room': '123-BC-COMMON',
        'Usage Category': 'Teaching',
        'Is Bookable': 'Yes',
        Capacity: 24,
        Status: 'Available',
        'Lab Name': '',
        'Sub Lab Name': '',
        'Restroom For': '',
      },
    ],
  },
  School: {
    headers: ['School ID', 'School Name', 'Type', 'Description'],
    exampleRows: [
      {
        'School ID': 'SCH-COMP',
        'School Name': 'School of Computing',
        Type: 'Computing',
        Description: 'Computing programs from MBU program list',
      },
      {
        'School ID': 'SCH-ADMIN',
        'School Name': 'Central Administration',
        Type: 'Administration',
        Description: 'Administrative and support departments',
      },
    ],
    instructions: [
      `Allowed Type values: ${SCHOOL_TYPE_OPTIONS.join(', ')}.`,
      'Create/import schools before importing departments because every department must map to a school.',
      'Use Central Administration for non-academic units such as Accounts, Transport, Exams, Library, or Establishment.',
    ],
  },
  Department: {
    headers: ['Department ID', 'Department Name', 'School', 'Type', 'Description'],
    exampleRows: [
      {
        'Department ID': 'DEPT-001',
        'Department Name': 'Computer Science and Engineering',
        School: 'School of Computing',
        Type: 'Academic',
        Description: 'Core computer science department',
      },
      {
        'Department ID': 'DEPT-ADMIN-001',
        'Department Name': 'Accounts',
        School: 'Central Administration',
        Type: 'Administrative',
        Description: 'Administrative department',
      },
    ],
  },
  'Department Allocation': {
    headers: ['School', 'Department', 'Semester', 'Building', 'Block', 'Floor', 'Room', 'Room Type', 'Required Capacity'],
    exampleRows: [
      {
        School: 'School of Engineering',
        Department: 'Computer Science and Engineering',
        Semester: 'Odd',
        Building: 'Academic Block',
        Block: 'Block A',
        Floor: 'Ground Floor',
        Room: '101',
        'Room Type': 'Classroom',
        'Required Capacity': 60,
      },
    ],
  },
  'Timing Profile': {
    headers: ['Profile ID', 'Profile Name', 'School', 'Department', 'Program', 'Academic Year', 'Year / Semester', 'Semester', 'Section', 'Working Days', 'Slot Timings', 'Notes'],
    exampleRows: [
      {
        'Profile ID': 'TP-DEFAULT-CAMPUS',
        'Profile Name': 'Campus Common Day Pattern',
        School: '',
        Department: '',
        Program: '',
        'Academic Year': '2025-26',
        'Year / Semester': '',
        Semester: '',
        Section: '',
        'Working Days': 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday',
        'Slot Timings': '09:00-09:55, 09:55-10:50, 11:10-12:05, 12:05-13:00, 14:15-15:10, 15:10-16:05',
        Notes: 'Format 1: broad default profile for all schools, departments, years, and sections.',
      },
      {
        'Profile ID': 'TP-BTECH-II-YEAR',
        'Profile Name': 'B.Tech Second Year Late Shift',
        School: '',
        Department: '',
        Program: 'B.Tech',
        'Academic Year': '2025-26',
        'Year / Semester': '2nd Year',
        Semester: 'IV Semester',
        Section: '',
        'Working Days': 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday',
        'Slot Timings': '10:00-10:55, 10:55-11:50, 12:10-13:05, 13:05-14:00, 15:00-15:55, 15:55-16:50',
        Notes: 'Format 2: year or semester specific profile used by one academic level.',
      },
      {
        'Profile ID': 'TP-CSE-DEPT',
        'Profile Name': 'CSE Department Standard Pattern',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'B.Tech',
        'Academic Year': '2025-26',
        'Year / Semester': '',
        Semester: '',
        Section: '',
        'Working Days': 'Monday,Tuesday,Wednesday,Thursday,Friday',
        'Slot Timings': '09:30-10:25, 10:25-11:20, 11:40-12:35, 12:35-13:30, 14:20-15:15, 15:15-16:10',
        Notes: 'Format 3: department-level profile shared by multiple CSE batches.',
      },
      {
        'Profile ID': 'TP-CSE-VI-A4',
        'Profile Name': 'CSE VI Semester Section A4 Late Shift',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'B.Tech',
        'Academic Year': '2025-26',
        'Year / Semester': '3rd Year - 6th Semester',
        Semester: 'VI Semester',
        Section: 'A4',
        'Working Days': 'Monday,Tuesday,Wednesday,Thursday,Friday',
        'Slot Timings': '10:00-10:55, 10:55-11:50, 12:10-13:05, 13:05-14:00, 15:00-15:55, 15:55-16:50',
        Notes: 'Format 4: section-specific override profile for one exact batch or section.',
      },
    ],
    instructions: [
      'Keep scope fields blank to create a broad default profile that can be reused across multiple years or semesters.',
      'Use more specific scope fields such as Department, Year / Semester, Semester, or Section only when that context truly follows a different daily timing pattern.',
      'This template demonstrates four example scopes: common default, year or semester specific, department specific, and section specific.',
      'Slot Timings must be comma-separated or line-separated ranges in HH:mm-HH:mm format, for example 09:00-09:55, 09:55-10:50.',
      'Timetable View prefers the active timing profile for vacancy slot scaffolding and falls back to the imported timetable timings when no profile is matched.',
      'Academic Calendar rows can optionally link to one timing profile so date-based periods and slot patterns stay connected without storing timings directly in the calendar row.',
    ],
  },
  'Academic Calendar': {
    headers: ['Calendar ID', 'School', 'Department', 'Program', 'Batch', 'Academic Year', 'Semester', 'Year / Semester', 'Timing Profile', 'Event Type', 'Title', 'Start Date', 'End Date', 'Notes'],
    exampleRows: [
      {
        'Calendar ID': 'CAL-MTECH2-2025-26',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'M.Tech',
        Batch: '2025-2027',
        'Academic Year': '2025-26',
        Semester: 'Even',
        'Year / Semester': '2nd Year - 4th Semester',
        'Timing Profile': 'Common UG Day Pattern',
        'Event Type': 'Semester Period',
        Title: 'M.Tech II Semester - Teaching Period',
        'Start Date': '2026-01-02',
        'End Date': '2026-05-30',
        Notes: 'Room allocation remains active only during this period.',
      },
      {
        'Calendar ID': 'CAL-BTECH3-2025-26',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'B.Tech',
        Batch: '2023-2027',
        'Academic Year': '2025-26',
        Semester: 'VI Semester',
        'Year / Semester': '3rd Year - 6th Semester',
        'Timing Profile': 'CSE VI Semester Late Shift',
        'Event Type': 'Semester Period',
        Title: 'B.Tech VI Semester - Teaching Period',
        'Start Date': '2026-01-02',
        'End Date': '2026-05-30',
        Notes: 'Roman semester values are normalized automatically.',
      },
      {
        'Calendar ID': 'CAL-MTECH2-CIAT1-2025-26',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'M.Tech',
        Batch: '2025-2027',
        'Academic Year': '2025-26',
        Semester: 'Even',
        'Year / Semester': '2nd Year - 4th Semester',
        'Timing Profile': 'Common UG Day Pattern',
        'Event Type': 'Examinations',
        Title: 'CIAT-I',
        'Start Date': '2026-03-09',
        'End Date': '2026-03-16',
        Notes: 'Normal timetable occupancy is suppressed during CIAT-I dates.',
      },
      {
        'Calendar ID': 'CAL-MTECH2-CIAT2-2025-26',
        School: 'School of Computing',
        Department: 'Computer Science and Engineering',
        Program: 'M.Tech',
        Batch: '2025-2027',
        'Academic Year': '2025-26',
        Semester: 'Even',
        'Year / Semester': '2nd Year - 4th Semester',
        'Timing Profile': 'Common UG Day Pattern',
        'Event Type': 'Examinations',
        Title: 'CIAT-II',
        'Start Date': '2026-04-27',
        'End Date': '2026-05-05',
        Notes: 'Normal timetable occupancy is suppressed during CIAT-II dates.',
      },
    ],
    instructions: [
      `Allowed Event Type values: ${ACADEMIC_CALENDAR_EVENT_TYPES.join(', ')}.`,
      `Allowed Program values include: ${PROGRAM_OPTIONS.join(', ')}.`,
      'Match the form order exactly: School -> Department -> Program -> Batch -> Academic Year -> Semester -> Year / Semester -> Timing Profile.',
      'Semester accepts Odd/Even, numeric values like 6, and Roman numeral values like VI Semester. Roman numerals are normalized automatically during import.',
      'For Year / Semester, use values like 1st Year - 1st Semester, 1st Year - 2nd Semester, 2nd Year - 3rd Semester, 2nd Year - 4th Semester, and so on.',
      'Timing Profile is optional but recommended whenever a batch or semester follows a defined slot pattern. Use either the Profile ID or Profile Name from Timing Profile Management.',
      'Use one row per academic period. The app automatically marks rows as Upcoming, Active, or Completed from the date range.',
      'Use Event Type = Examinations for CIAT-I, CIAT-II, semester-end exams, or any exam window where normal class timetable occupancy must be ignored.',
      'When an Examinations row is active for a department and semester, Timetable View, Room Bookings vacancy checks, and Digital Twin suppress normal class schedules for those dates.',
      'If Program, Batch, Academic Year, or Year / Semester are also filled and matching Batch Room Allocations exist, the exam suppression is narrowed safely to that exact academic context instead of blocking every room in the department.',
      'Completed calendars can be reused as history; do not delete them unless they were imported by mistake.',
    ],
  },
  'Batch Room Allocation': {
    headers: ['Allocation ID', 'Academic Calendar', 'Department', 'Program', 'Batch', 'Academic Year', 'Semester', 'Year / Semester', 'Building', 'Block', 'Floor', 'Room', 'Allocation Mode', 'Room Type', 'Required Capacity', 'Start Date', 'End Date', 'Notes'],
    exampleRows: [
      {
        'Allocation ID': 'ALLOC-MTECH2-322',
        'Academic Calendar': 'CAL-MTECH2-2025-26',
        Department: 'Computer Science and Engineering',
        Program: 'M.Tech',
        Batch: '2025-2027',
        'Academic Year': '2025-26',
        Semester: 'Even',
        'Year / Semester': '2nd Year - 4th Semester',
        Building: 'M-Plaza',
        Block: 'North',
        Floor: 'Third Floor',
        Room: '322',
        'Allocation Mode': 'Shared',
        'Room Type': 'Classroom',
        'Required Capacity': 36,
        'Start Date': '2026-01-02',
        'End Date': '2026-05-30',
        Notes: 'Room automatically releases after the calendar ends.',
      },
      {
        'Allocation ID': 'ALLOC-BTECH3-331',
        'Academic Calendar': 'CAL-BTECH3-2025-26',
        Department: 'Computer Science and Engineering',
        Program: 'B.Tech',
        Batch: '2023-2027',
        'Academic Year': '2025-26',
        Semester: '6',
        'Year / Semester': '3rd Year - 6th Semester',
        Building: 'M-Plaza',
        Block: 'North',
        Floor: 'Third Floor',
        Room: '331',
        'Allocation Mode': 'Shared',
        'Room Type': 'Classroom',
        'Required Capacity': 60,
        'Start Date': '2026-01-02',
        'End Date': '2026-05-30',
        Notes: 'Numeric semester values are normalized automatically.',
      },
      {
        'Allocation ID': 'ALLOC-ECE2-322',
        'Academic Calendar': 'CAL-BTECH-ECE-2025-26',
        Department: 'Electronics and Communication Engineering',
        Program: 'B.Tech',
        Batch: '2024-2028',
        'Academic Year': '2025-26',
        Semester: 'Even',
        'Year / Semester': '2nd Year - 4th Semester',
        Building: 'M-Plaza',
        Block: 'North',
        Floor: 'Third Floor',
        Room: '322',
        'Allocation Mode': 'Shared',
        'Room Type': 'Classroom',
        'Required Capacity': 42,
        'Start Date': '2026-01-02',
        'End Date': '2026-05-30',
        Notes: 'Shared room across departments; timetable slots must not overlap.',
      },
    ],
    instructions: [
      'Use Academic Calendar to auto-fill department, batch, semester, start date, and end date wherever possible.',
      'For CIAT or examination windows that should suppress only one batch or year, keep Program, Batch, Academic Year, and Year / Semester aligned with the Academic Calendar row so the app can apply the exam override safely.',
      'Semester accepts Odd/Even, numeric values like 6, and Roman numeral values like VI Semester. Roman numerals are normalized automatically during import.',
      'Use Allocation Mode = Shared when the same room is used by multiple batches or different departments in different timetable slots during the same date range.',
      'Use Allocation Mode = Exclusive only when the room must stay reserved for one batch for that full date range.',
      'Only Exclusive allocations block overlapping date ranges. Shared allocations can overlap across departments and are separated later by timetable slots.',
      'Allocations are automatically shown as Released after the end date passes.',
    ],
  },
  Equipment: {
    headers: ['Equipment ID', 'Equipment Name', 'Type', 'Room Number', 'Condition'],
    exampleRows: [
      {
        'Equipment ID': 'EQ-001',
        'Equipment Name': 'Projector',
        Type: 'Display',
        'Room Number': '101',
        Condition: 'Good',
      },
    ],
  },
  Schedule: {
    headers: ['Schedule ID', 'Department', 'Year', 'Section', 'Semester', 'Course Code', 'Course Name', 'Faculty', 'Room', 'Day', 'Start Time', 'End Time', 'Import Status', 'Review Note'],
    exampleRows: [
      {
        'Schedule ID': 'SCHD-001',
        Department: 'Computer Science and Engineering',
        Year: 'II Year',
        Section: 'A1',
        Semester: 'IV Semester',
        'Course Code': 'CSE401L',
        'Course Name': 'Data Structures Lab',
        Faculty: 'Dr. Keerthi',
        Room: '328',
        Day: 'Tuesday',
        'Start Time': '09:00',
        'End Time': '10:50',
        'Import Status': 'Linked',
        'Review Note': 'Example 1: two continuous periods for a lab.',
      },
      {
        'Schedule ID': 'SCHD-002',
        Department: 'Pharmacy',
        Year: 'II Year',
        Section: 'B2',
        Semester: 'IV Semester',
        'Course Code': 'PHARM402L',
        'Course Name': 'Pharmaceutics Lab',
        Faculty: 'Dr. Anitha',
        Room: 'PH-LAB-2',
        Day: 'Wednesday',
        'Start Time': '11:00',
        'End Time': '14:00',
        'Import Status': 'Linked',
        'Review Note': 'Example 2: three continuous periods or hours for a pharmacy lab.',
      },
      {
        'Schedule ID': 'SCHD-003',
        Department: 'Computer Science and Engineering',
        Year: 'III Year',
        Section: 'A4',
        Semester: 'VI Semester',
        'Course Code': 'CSE602L',
        'Course Name': 'Cloud Computing Lab',
        Faculty: 'Dr. Purushotham',
        Room: '331',
        Day: 'Thursday',
        'Start Time': '09:00',
        'End Time': '10:50',
        'Import Status': 'Linked',
        'Review Note': 'Example 3: lab conducted inside a classroom room number.',
      },
      {
        'Schedule ID': 'SCHD-004',
        Department: 'Computer Science and Engineering',
        Year: 'II Year',
        Section: 'A2',
        Semester: 'IV Semester',
        'Course Code': 'CSE404',
        'Course Name': 'Database Management Systems',
        Faculty: 'Dr. Rao',
        Room: '101',
        Day: 'Monday',
        'Start Time': '09:00',
        'End Time': '10:00',
        'Import Status': 'Linked',
        'Review Note': 'Example 4: regular single-slot theory class for comparison.',
      },
    ],
    instructions: [
      'Department and Room are used to automatically create/update Department Room Mapping while importing timetable rows.',
      'Room can match the canonical Room Number or a Room Alias from Room Management only when that label maps to one unique room. If a label matches multiple rooms (for example across blocks), the row is kept as Unmatched Room for manual review.',
      'Timetable imports link against any matching room in Room Management, even if that room is not currently bookable for ad-hoc bookings. This keeps seminar halls, shared rooms, and internal-use venues linked correctly in schedules.',
      'For PDF timetable extraction, normal slots inherit the section header Room No automatically. The same section header also supplies Department, Semester, and Year when Gemini omits them. Only slots that explicitly mention another room such as (R.No.610) override that default room.',
      'Use Section for timetable groups like A1, A2, A10. Different sections can use the same room and time slot, so Section is part of schedule identity during import.',
      'Use the Semester column for the exact semester value such as I Semester, II Semester, IV Semester, or VI Semester.',
      'Numeric values like 6 and Roman values like VI Semester are normalized automatically to one exact semester format during import.',
      'If an older file still uses Odd/Even, the app derives the exact semester from the Year column whenever possible so the stored schedule remains precise.',
      'Year can be provided explicitly as I Year / II Year / III Year / IV Year (or 1 / 2 / 3 / 4). If omitted, it is derived from Semester during import.',
      'Lab durations are fully dynamic. Enter the real Start Time and End Time exactly as used by that department, whether the lab spans two periods, three periods, or any other continuous window.',
      'If a lab is conducted in a classroom instead of a dedicated lab room, still enter the actual classroom room number here. The app links schedules to the real room used, not only to room type labels.',
      'Different departments or schools can follow different lab lengths in the same workbook. The schedule template does not force a fixed lab duration; it only preserves the actual timed occupancy.',
      'Import Status and Review Note columns are optional in Excel. If Import Status is blank, the app auto-sets Linked / Unmatched Room / Room Missing from room matching.',
      'Department, Semester, and Section are also used by Timetable View, Room Bookings schedule review, and Digital Twin links to preserve the correct mixed-room academic context. Fill them consistently for accurate vacancy display.',
      'All workbook sheets are scanned during import. Rows without a matching room are imported as Unmatched Room schedules and can be fixed later after adding the missing room.',
      'Rows without a matching department still import as schedules but cannot create department mapping.',
      'Normal schedules stay in the master timetable, but they are suppressed automatically on dates covered by Academic Calendar rows with Event Type = Examinations for the same department and semester.',
      'If the matching Academic Calendar row is more specific and Batch Room Allocations are available, the suppression also respects Program, Batch, Academic Year, and Year / Semester so CIAT rows do not block unrelated classes.',
    ],
  },
  Maintenance: {
    headers: ['Maintenance ID', 'Room Number', 'Equipment', 'Status'],
    exampleRows: [
      {
        'Maintenance ID': 'MAIN-001',
        'Room Number': '101',
        Equipment: 'Projector',
        Status: 'Pending',
      },
    ],
  },
};

const formatExcelTime = (val: any) => {
  if (typeof val === 'number') {
    const totalMinutes = Math.round(val * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  }
  return val?.toString();
};

const formatExcelDate = (val: any) => {
  if (typeof val === 'number') {
    // Excel date is days since 1900-01-01
    const date = new Date(Math.round((val - 25569) * 86400 * 1000));
    return date.toISOString().split('T')[0];
  }
  return val?.toString();
};

const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeComparableDateValue = (value?: string | Date | null) => {
  if (!value) return '';
  if (value instanceof Date) return formatLocalDate(value);

  const text = value.toString().trim();
  if (!text) return '';

  const isoLikeMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoLikeMatch) return `${isoLikeMatch[1]}-${isoLikeMatch[2]}-${isoLikeMatch[3]}`;

  const displayMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (displayMatch) return `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}`;

  return text;
};

const formatDisplayDate = (value?: string | Date | null) => {
  const normalized = normalizeComparableDateValue(value);
  if (!normalized) return '';
  const parts = normalized.split('-');
  if (parts.length === 3) return `${parts[2]}-${parts[1]}-${parts[0]}`;
  return normalized;
};

const DEFAULT_TIMETABLE_TIME_SLOTS = [
  { start_time: '09:00', end_time: '09:55' },
  { start_time: '09:55', end_time: '10:50' },
  { start_time: '11:10', end_time: '12:05' },
  { start_time: '12:05', end_time: '13:00' },
  { start_time: '14:15', end_time: '15:10' },
  { start_time: '15:10', end_time: '16:05' },
];

const MIN_INFERRED_TIMETABLE_SLOT_MINUTES = 30;
const DEFAULT_TIMING_PROFILE_WORKING_DAYS = 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday';

const normalizeDayLabel = (value: unknown) => {
  const normalized = normalizeLookupValue(value);
  if (!normalized) return '';
  const dayMap: Record<string, string> = {
    mon: 'Monday',
    monday: 'Monday',
    tue: 'Tuesday',
    tues: 'Tuesday',
    tuesday: 'Tuesday',
    wed: 'Wednesday',
    wednesday: 'Wednesday',
    thu: 'Thursday',
    thur: 'Thursday',
    thurs: 'Thursday',
    thursday: 'Thursday',
    fri: 'Friday',
    friday: 'Friday',
    sat: 'Saturday',
    saturday: 'Saturday',
    sun: 'Sunday',
    sunday: 'Sunday',
  };
  return dayMap[normalized] || value?.toString().trim() || '';
};

const parseTimingProfileSlots = (value: unknown) => {
  const slotText = value?.toString().trim() || '';
  if (!slotText) return [];

  const validSlots = slotText
    .split(/[\n,;]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!match) return null;
      const start = match[1].padStart(5, '0');
      const end = match[2].padStart(5, '0');
      if (start >= end) return null;
      return { start_time: start, end_time: end };
    })
    .filter((slot): slot is { start_time: string; end_time: string } => Boolean(slot));

  return Array.from(new Map(validSlots.map(slot => [getTimeSlotKey(slot), slot])).values())
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '') || (a.end_time || '').localeCompare(b.end_time || ''));
};

const normalizeTimingProfileSlotPattern = (value: unknown) =>
  parseTimingProfileSlots(value)
    .map(slot => `${slot.start_time}-${slot.end_time}`)
    .join(', ');

const normalizeTimingProfileWorkingDays = (value: unknown) => {
  const parts = (value?.toString().trim() || DEFAULT_TIMING_PROFILE_WORKING_DAYS)
    .split(/[\n,;|/]+/)
    .flatMap(part => part.split('&'))
    .map(part => normalizeDayLabel(part))
    .filter(Boolean);

  const normalizedDays = Array.from(new Set(parts));
  return (normalizedDays.length > 0 ? normalizedDays : DEFAULT_TIMING_PROFILE_WORKING_DAYS.split(',')).join(', ');
};

const getTimingProfileDisplayLabel = (profile: any) => {
  if (!profile) return 'Timing profile not set';
  const primary = profile.profile_name || profile.name || profile.profile_id || 'Timing Profile';
  return profile.profile_id ? `${primary} (${profile.profile_id})` : primary;
};

const getTimingProfileSpecificityScore = (profile: any) => [
  profile?.school_id,
  profile?.department_id,
  profile?.program,
  profile?.academic_year,
  profile?.year_of_study,
  profile?.semester,
  profile?.section,
].filter(value => value !== undefined && value !== null && value.toString().trim() !== '').length;

const timingProfileMatchesContext = (profile: any, context: any) => {
  if (!profile) return false;
  if (profile.school_id && !idsMatch(profile.school_id, context.school_id)) return false;
  if (profile.department_id && !idsMatch(profile.department_id, context.department_id)) return false;
  if (profile.program && normalizeProgramValue(profile.program) !== normalizeProgramValue(context.program)) return false;
  if (profile.academic_year && normalizeLookupValue(profile.academic_year) !== normalizeLookupValue(context.academic_year)) return false;
  if (profile.year_of_study && normalizeYearOfStudyValue(profile.year_of_study, '') !== normalizeYearOfStudyValue(context.year_of_study, '')) return false;
  if (profile.semester && normalizeExactSemesterValue(profile.semester, profile.year_of_study, profile.semester || '') !== normalizeExactSemesterValue(context.semester, context.year_of_study, '')) return false;
  if (profile.section && normalizeLookupValue(profile.section) !== normalizeLookupValue(context.section)) return false;
  return true;
};

const academicCalendarMatchesTimingContext = (calendar: any, context: any, activeDate: string) => {
  if (!calendar?.timing_profile_id) return false;
  const normalizedActiveDate = normalizeComparableDateValue(activeDate);
  const normalizedCalendarStart = normalizeComparableDateValue(calendar?.start_date);
  const normalizedCalendarEnd = normalizeComparableDateValue(calendar?.end_date);
  if (normalizedActiveDate && ((normalizedCalendarStart && normalizedCalendarStart > normalizedActiveDate) || (normalizedCalendarEnd && normalizedCalendarEnd < normalizedActiveDate))) return false;
  if (normalizeLookupValue(calendar.event_type) === normalizeLookupValue('Examinations')) return false;
  if (calendar.school_id && context.school_id && !idsMatch(calendar.school_id, context.school_id)) return false;
  if (calendar.department_id && context.department_id && !idsMatch(calendar.department_id, context.department_id)) return false;
  if (calendar.program && context.program && normalizeProgramValue(calendar.program) !== normalizeProgramValue(context.program)) return false;
  if (calendar.academic_year && context.academic_year && normalizeLookupValue(calendar.academic_year) !== normalizeLookupValue(context.academic_year)) return false;
  if (calendar.year_of_study && context.year_of_study && normalizeYearOfStudyValue(calendar.year_of_study, '') !== normalizeYearOfStudyValue(context.year_of_study, '')) return false;
  if (calendar.semester && context.semester && normalizeSemesterValue(calendar.semester, '') !== normalizeSemesterValue(context.semester, '')) return false;
  return true;
};

const resolveTimingProfileForContext = ({
  timingProfiles,
  academicCalendars,
  activeDate,
  context,
}: {
  timingProfiles: any[];
  academicCalendars: any[];
  activeDate: string;
  context: any;
}) => {
  if (!Array.isArray(timingProfiles) || timingProfiles.length === 0) return null;

  const profileById = new Map(timingProfiles.map(profile => [profile.id?.toString(), profile]));
  const linkedProfile = academicCalendars
    .filter(calendar => academicCalendarMatchesTimingContext(calendar, context, activeDate))
    .sort((left, right) => getTimingProfileSpecificityScore(right) - getTimingProfileSpecificityScore(left))
    .map(calendar => profileById.get(calendar.timing_profile_id?.toString()))
    .find(Boolean);
  if (linkedProfile) return linkedProfile;

  return timingProfiles
    .filter(profile => timingProfileMatchesContext(profile, context))
    .sort((left, right) => getTimingProfileSpecificityScore(right) - getTimingProfileSpecificityScore(left))
    .at(0) || null;
};

const getTimeSlotKey = (slot?: { start_time?: string; end_time?: string } | null) =>
  `${slot?.start_time || ''}-${slot?.end_time || ''}`;

const minutesToTime = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
};

const getRangeLifecycleStatus = (startDate?: string, endDate?: string, completedLabel = 'Completed', futureLabel = 'Upcoming') => {
  const today = normalizeComparableDateValue(new Date());
  const normalizedStartDate = normalizeComparableDateValue(startDate);
  const normalizedEndDate = normalizeComparableDateValue(endDate);
  if (normalizedEndDate && normalizedEndDate < today) return completedLabel;
  if (normalizedStartDate && normalizedStartDate > today) return futureLabel;
  return 'Active';
};

const AppRouter = (((import.meta as any).env?.VITE_ROUTER_MODE || '').toString().toLowerCase() === 'hash'
  || ((import.meta as any).env?.BASE_URL || '/') !== '/')
  ? HashRouter
  : BrowserRouter;

// --- AUTH CONTEXT ---
interface AuthContextType {
  user: any;
  login: (userData: any) => void;
  logout: () => void;
  loading: boolean;
  authServiceMessage: string;
  clearAuthServiceMessage: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const getAuthServiceMessage = (status?: number) => {
  if (status === 404) {
    return 'Authentication service is unavailable. Verify that the frontend is pointing to the deployed backend API.';
  }

  return 'Unable to reach the authentication service. Check the backend deployment and VITE_API_BASE_URL configuration.';
};

const readJsonResponse = async (res: Response) => {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;

  try {
    return await res.json();
  } catch {
    return null;
  }
};

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [authServiceMessage, setAuthServiceMessage] = useState('');

  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(async res => {
        const data = await readJsonResponse(res);

        if (res.ok && data?.user) {
          setUser(data.user);
          setAuthServiceMessage('');
          return;
        }

        if (res.status !== 401) {
          setAuthServiceMessage(getAuthServiceMessage(res.status));
        }
      })
      .catch(() => {
        setAuthServiceMessage(getAuthServiceMessage());
      })
      .finally(() => setLoading(false));
  }, []);

  const login = (userData: any) => {
    setUser(userData);
    setAuthServiceMessage('');
  };
  const logout = () => {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).then(() => setUser(null));
  };
  const clearAuthServiceMessage = () => setAuthServiceMessage('');

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, authServiceMessage, clearAuthServiceMessage }}>
      {children}
    </AuthContext.Provider>
  );
}

const useAuth = () => useContext(AuthContext)!;

// --- COMPONENTS ---

// --- DEPENDENCY GUARD ---
function DependencyGuard({ children, dependencies }: { children: React.ReactNode, dependencies: { table: string, label: string }[] }) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkDeps = async () => {
      try {
        const results = await Promise.all(
          dependencies.map(async dep => {
            const res = await fetch(`/api/${dep.table}`, { credentials: 'include' });
            const data = await res.json();
            return { table: dep.table, count: data.length };
          })
        );
        const newCounts: Record<string, number> = {};
        results.forEach(r => newCounts[r.table] = r.count);
        setCounts(newCounts);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    checkDeps();
  }, [dependencies]);

  if (loading) return <div className="p-8 text-center text-slate-400">Verifying dependencies...</div>;

  const missing = dependencies.filter(dep => !counts[dep.table]);

  if (missing.length > 0) {
    return (
      <div className="p-12 max-w-2xl mx-auto text-center space-y-6">
        <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto text-amber-500">
          <AlertTriangle size={40} />
        </div>
        <h2 className="text-2xl font-bold text-slate-800">Module Dependency Required</h2>
        <p className="text-slate-500 leading-relaxed">
          Before you can manage this module, you must first populate its dependent modules:
          <span className="block mt-2 font-bold text-slate-700">
            {missing.map(m => m.label).join(', ')}
          </span>
        </p>
        <div className="flex justify-center gap-4">
          <Link to={`/management/${missing[0].table}`} className="px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all">
            Go to {missing[0].label}
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const approvalRoles = ['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)'];

  const customAccessPaths = user?.access_paths?.split(',').map((path: string) => path.trim()).filter(Boolean) || [];
  const menuItems = [
    { name: 'Dashboard', icon: LayoutDashboard, path: '/', roles: ['Administrator', 'Faculty', 'HOD', 'Event Coordinator', 'Dean (P&M)', 'Deputy Dean (P&M)', 'Maintenance Staff', 'Infrastructure Manager'] },
    { name: 'User Management', icon: Users, path: '/users', roles: ['Administrator'] },
    { name: 'Campus Management', icon: Globe, path: '/campuses', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Building Management', icon: Building2, path: '/buildings', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Block Management', icon: Layers, path: '/blocks', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Floor Management', icon: Layers, path: '/floors', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Room Management', icon: DoorOpen, path: '/rooms', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'School Management', icon: BookOpen, path: '/schools', roles: ['Administrator'] },
    { name: 'Department Management', icon: Layers, path: '/departments', roles: ['Administrator'] },
    { name: 'Timing Profile Management', icon: Clock, path: '/timing-profiles', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Academic Calendar', icon: Calendar, path: '/academic-calendars', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Batch Room Allocation', icon: DoorOpen, path: '/batch-room-allocations', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Department Room Mapping', icon: DoorOpen, path: '/dept-allocation', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Equipment Management', icon: Wrench, path: '/equipment', roles: ['Administrator', 'Infrastructure Manager', 'Maintenance Staff'] },
    { name: 'Schedule Records', icon: Calendar, path: '/scheduling', roles: ['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)'] },
    { name: 'Timetable View', icon: Clock, path: '/timetable', roles: ['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)'] },
    { name: 'Digital Twin', icon: Globe, path: '/digital-twin', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Room Bookings', icon: BookOpen, path: '/bookings', roles: approvalRoles },
    { name: 'Room Requests', icon: BookOpen, path: '/bookings', roles: ['Faculty', 'HOD', 'Event Coordinator'] },
    { name: 'AI Room Recommendation', icon: BrainCircuit, path: '/ai-allocation', roles: ['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)'] },
    { name: 'Maintenance', icon: Wrench, path: '/maintenance', roles: ['Administrator', 'Maintenance Staff', 'Infrastructure Manager'] },
    { name: 'Analytics', icon: BarChart3, path: '/analytics', roles: ['Administrator', 'Infrastructure Manager'] },
    { name: 'Utilization Reports', icon: FileText, path: '/reports', roles: ['Administrator', 'Infrastructure Manager'] },
  ];

  const filteredMenu = menuItems.filter(item => item.roles.includes(user?.role) || customAccessPaths.includes(item.path));

  return (
    <div className="w-64 bg-slate-900 text-white h-screen flex flex-col sticky top-0">
      <div className="p-6 border-b border-slate-800">
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center">
            <Building2 size={20} />
          </div>
          MBU SmartCampus AI
        </h1>
        <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-widest font-semibold">Infrastructure Management</p>
      </div>
      
      <nav className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
        {filteredMenu.map((item) => (
          <Link
            key={item.name}
            to={item.path}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white transition-colors group"
          >
            <item.icon size={18} className="group-hover:text-emerald-400 transition-colors" />
            <span className="text-sm font-medium">{item.name}</span>
          </Link>
        ))}
      </nav>

      <div className="p-4 border-t border-slate-800">
        <div className="flex items-center gap-3 mb-4 px-2">
          <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-sm font-bold">
            {user?.name?.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{user?.name}</p>
            <p className="text-xs text-slate-400 truncate">{user?.role}</p>
          </div>
        </div>
        <button
          onClick={() => { logout(); navigate('/login'); }}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-rose-400 hover:bg-rose-500/10 transition-colors"
        >
          <LogOut size={18} />
          <span className="text-sm font-medium">Logout</span>
        </button>
      </div>
    </div>
  );
}

function Header({ title }: { title: string }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [isRefreshingNotifications, setIsRefreshingNotifications] = useState(false);
  const [locallyReadNotificationIds, setLocallyReadNotificationIds] = useState<number[]>([]);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  const notificationPanelOpenRef = useRef(false);
  const notificationReadStorageKey = user?.id ? `notifications-read-${user.id}` : null;

  const persistLocallyReadNotificationIds = (notificationIds: number[]) => {
    const uniqueIds = Array.from(new Set(notificationIds.filter(id => Number.isInteger(id) && id > 0)));
    setLocallyReadNotificationIds(uniqueIds);
    if (!notificationReadStorageKey) return;

    try {
      window.localStorage.setItem(notificationReadStorageKey, JSON.stringify(uniqueIds));
    } catch {
      // Ignore storage errors and keep the in-memory state.
    }
  };

  useEffect(() => {
    if (!notificationReadStorageKey) {
      setLocallyReadNotificationIds([]);
      return;
    }

    try {
      const storedIds = JSON.parse(window.localStorage.getItem(notificationReadStorageKey) || '[]');
      const validIds = Array.isArray(storedIds)
        ? storedIds.map(id => parseInt(id, 10)).filter(id => Number.isInteger(id) && id > 0)
        : [];
      setLocallyReadNotificationIds(validIds);
    } catch {
      setLocallyReadNotificationIds([]);
    }
  }, [notificationReadStorageKey]);

  useEffect(() => {
    notificationPanelOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: MouseEvent) => {
      if (!notificationPanelRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener('mousedown', handleDocumentPointerDown);
    }

    return () => {
      document.removeEventListener('mousedown', handleDocumentPointerDown);
    };
  }, [open]);

  const isNotificationRead = (notification: any) =>
    notification?.is_read === 1 ||
    notification?.is_read === true ||
    notification?.is_read === '1' ||
    locallyReadNotificationIds.includes(notification?.id);

  const applyLocalReadState = (items: any[]) =>
    items.map(notification => (
      locallyReadNotificationIds.includes(notification.id)
        ? { ...notification, is_read: 1 }
        : notification
    ));

  const fetchNotifications = async () => {
    if (!user) {
      setNotifications([]);
      return [];
    }

    try {
      const res = await fetch('/api/notifications', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data)) {
        const mergedNotifications = applyLocalReadState(data);
        setNotifications(mergedNotifications);
        return mergedNotifications;
      }
      return [];
    } catch {
      // Preserve the current list if a background refresh fails.
      return [];
    }
  };

  const markNotificationsAsRead = async (sourceNotifications?: any[]) => {
    const items = sourceNotifications || notifications;
    const unreadIds = items
      .filter((notification: any) => !isNotificationRead(notification))
      .map((notification: any) => notification.id)
      .filter((id: any) => Number.isInteger(id) && id > 0);

    if (!user || unreadIds.length === 0) return;

    const nextLocallyReadIds = Array.from(new Set([...locallyReadNotificationIds, ...unreadIds]));
    persistLocallyReadNotificationIds(nextLocallyReadIds);
    setNotifications(currentNotifications =>
      currentNotifications.map(notification => (
        unreadIds.includes(notification.id)
          ? { ...notification, is_read: 1 }
          : notification
      ))
    );

    try {
      const res = await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ notificationIds: unreadIds }),
      });
      if (!res.ok) return;
    } catch {
      // Keep the local read state so the badge stays cleared for the current user session.
    }
  };

  const refreshNotifications = async () => {
    if (!user) return;

    setIsRefreshingNotifications(true);
    try {
      const items = await fetchNotifications();
      if (open && items.length > 0) {
        await markNotificationsAsRead(items);
      }
    } finally {
      setIsRefreshingNotifications(false);
    }
  };

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }
    const syncNotifications = async () => {
      const items = await fetchNotifications();
      if (notificationPanelOpenRef.current && items.length > 0) {
        await markNotificationsAsRead(items);
      }
    };

    syncNotifications();
    const interval = window.setInterval(syncNotifications, 10000);
    return () => window.clearInterval(interval);
  }, [user?.id, user?.role, user?.name]);

  useEffect(() => {
    if (!open) return;

    refreshNotifications();
  }, [open]);

  const unreadCount = notifications.filter((notification: any) => !isNotificationRead(notification)).length;

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 sticky top-0 z-10">
      <h2 className="text-lg font-bold text-slate-800">{title}</h2>
      <div className="flex items-center gap-4">
        <div ref={notificationPanelRef} className="relative">
          <button
            onClick={(event) => {
              event.stopPropagation();
              setOpen(currentOpen => !currentOpen);
            }}
            type="button"
            className="p-2 text-slate-400 hover:text-slate-600 relative"
            title="Notifications"
          >
            <Bell size={20} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full border-2 border-white flex items-center justify-center">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {open && (
            <div className="absolute right-0 top-12 w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden">
              <div className="p-3 border-b border-slate-100 flex items-center justify-between">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Notifications</p>
                <button
                  onClick={async () => {
                    await refreshNotifications();
                  }}
                  type="button"
                  className="text-[10px] font-bold text-emerald-600 hover:text-emerald-700 uppercase tracking-widest"
                >
                  {isRefreshingNotifications ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {notifications.slice(0, 8).map(notification => (
                  <div key={notification.id} className={cn("p-3 border-b border-slate-50", !isNotificationRead(notification) && "bg-emerald-50/40")}>
                    <p className="text-sm font-semibold text-slate-700">{notification.title}</p>
                    <p className="text-xs text-slate-500 mt-1">{notification.message}</p>
                  </div>
                ))}
                {notifications.length === 0 && <p className="p-4 text-sm text-slate-400 italic">No notifications yet.</p>}
              </div>
            </div>
          )}
        </div>
        <div className="h-8 w-px bg-slate-200 mx-2"></div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="text-xs font-bold text-slate-800 leading-none">System Status</p>
            <p className="text-[10px] text-emerald-500 font-bold uppercase">Online</p>
          </div>
          <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
        </div>
      </div>
    </header>
  );
}

function Layout({ children, title }: { children: React.ReactNode, title: string }) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Header title={title} />
        <main className="p-8 flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { login, authServiceMessage, clearAuthServiceMessage } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    clearAuthServiceMessage();
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      });
      const data = await readJsonResponse(res);

      if (res.ok && data?.user) {
        login(data.user);
        navigate('/');
        return;
      }

      if (res.status === 401) {
        setError(data?.error || 'Invalid credentials');
        return;
      }

      setError(data?.error || getAuthServiceMessage(res.status));
    } catch {
      setError(getAuthServiceMessage());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-slate-900 p-8 text-center">
          <div className="w-16 h-16 bg-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
            <Building2 size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">MBU SmartCampus AI</h1>
          <p className="text-slate-400 text-sm mt-1">Dynamic Infrastructure Management System</p>
        </div>
        
        <form onSubmit={handleLogin} className="p-8 space-y-6">
          {authServiceMessage && !error && (
            <div className="p-3 bg-amber-50 border border-amber-100 text-amber-700 text-sm rounded-lg flex items-center gap-2">
              <Info size={16} />
              {authServiceMessage}
            </div>
          )}
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-100 text-rose-600 text-sm rounded-lg flex items-center gap-2">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
          
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Email Address</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
              placeholder="admin@smartcampus.ai"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <X size={18} /> : <div className="w-4 h-4 rounded-full border-2 border-slate-400" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input type="checkbox" className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
              <span className="text-sm text-slate-600 group-hover:text-slate-900">Remember Me</span>
            </label>
            <p className="text-xs font-semibold text-slate-400">Password reset is handled by the Administrator.</p>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              className="flex-1 px-6 py-3 border border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 shadow-lg shadow-slate-900/20 transition-all disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSubmitting ? 'Signing in...' : 'Login'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ForcePasswordChangeModal() {
  const { user, login } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!user?.force_password_change) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Unable to update password.');
        return;
      }
      login(data.user);
      setPassword('');
      setConfirmPassword('');
    } catch {
      setError('Unable to update password. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h3 className="text-lg font-bold text-slate-800">Create New Password</h3>
          <p className="text-sm text-slate-500 mt-1">Your admin-issued password is temporary. Create your own password to continue.</p>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-100 text-rose-600 text-sm rounded-lg flex items-center gap-2">
              <AlertTriangle size={16} />
              {error}
            </div>
          )}
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">New Password</label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 pr-16 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
                placeholder="Enter new password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500 hover:text-slate-800"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">Confirm Password</label>
            <input
              type={showPassword ? 'text' : 'password'}
              required
              minLength={8}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
              placeholder="Confirm new password"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full px-6 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save New Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [token, setToken] = useState(''); // For demo purposes

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (data.success) {
      setMessage(data.message);
      setToken(data.token);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden p-8">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Forgot Password</h2>
        <p className="text-slate-500 text-sm mb-6">Enter your email and we'll send you a reset link.</p>
        
        {message ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-50 border border-emerald-100 text-emerald-700 rounded-xl text-sm">
              {message}
            </div>
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
              <p className="text-xs font-bold text-slate-400 uppercase mb-2">Demo Token (Normally sent via email)</p>
              <code className="text-xs break-all">{token}</code>
            </div>
            <Link to={`/reset-password?token=${token}`} className="block w-full py-3 bg-slate-900 text-white text-center font-bold rounded-xl">Proceed to Reset</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase">Email Address</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
                placeholder="admin@smartcampus.ai"
              />
            </div>
            <button type="submit" className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all">Send Reset Link</button>
            <Link to="/login" className="block text-center text-sm font-semibold text-slate-500 hover:text-slate-800">Back to Login</Link>
          </form>
        )}
      </div>
    </div>
  );
}

function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) return setError('Passwords do not match');
    
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password })
    });
    const data = await res.json();
    if (data.success) {
      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } else {
      setError(data.error);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden p-8">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Reset Password</h2>
        <p className="text-slate-500 text-sm mb-6">Create a new secure password for your account.</p>
        
        {success ? (
          <div className="p-4 bg-emerald-50 border border-emerald-100 text-emerald-700 rounded-xl text-sm flex items-center gap-2">
            <Check size={18} />
            Password reset successful! Redirecting to login...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="p-3 bg-rose-50 border border-rose-100 text-rose-600 text-sm rounded-lg">{error}</div>}
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase">New Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
                placeholder="••••••••"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-500 uppercase">Confirm Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500"
                placeholder="••••••••"
              />
            </div>
            <button type="submit" className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all">Update Password</button>
          </form>
        )}
      </div>
    </div>
  );
}

// --- MAIN APP COMPONENT ---

export default function App() {
  return (
    <AuthProvider>
      <ErrorBoundary>
        <AppRouter>
          <ForcePasswordChangeModal />
          <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<Navigate to="/login" />} />
          <Route path="/reset-password" element={<Navigate to="/login" />} />
          
          <Route path="/" element={
            <ProtectedRoute>
              <Layout title="Administrator Dashboard">
                <DashboardHome />
              </Layout>
            </ProtectedRoute>
          } />

          <Route path="/users" element={<ProtectedRoute roles={['Administrator']}><Layout title="User Management"><UserManagement /></Layout></ProtectedRoute>} />

          {/* CRUD Routes Placeholder */}
          <Route path="/campuses" element={<ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}><Layout title="Campus Management"><CampusManagement /></Layout></ProtectedRoute>} />
          <Route path="/buildings" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Building Management">
                <DependencyGuard dependencies={[{ table: 'campuses', label: 'Campuses' }]}>
                  <BuildingManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/blocks" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Block Management">
                <DependencyGuard dependencies={[
                  { table: 'campuses', label: 'Campuses' },
                  { table: 'buildings', label: 'Buildings' }
                ]}>
                  <BlockManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/floors" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Floor Management">
                <DependencyGuard dependencies={[
                  { table: 'buildings', label: 'Buildings' }
                ]}>
                  <FloorManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/rooms" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Room Management">
                <DependencyGuard dependencies={[
                  { table: 'blocks', label: 'Blocks' },
                  { table: 'floors', label: 'Floors' }
                ]}>
                  <RoomManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/schools" element={<ProtectedRoute roles={['Administrator']}><Layout title="School Management"><SchoolManagement /></Layout></ProtectedRoute>} />
          <Route path="/departments" element={
            <ProtectedRoute roles={['Administrator']}>
              <Layout title="Department Management">
                <DependencyGuard dependencies={[{ table: 'schools', label: 'Schools' }]}>
                  <DepartmentManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/timing-profiles" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Timing Profile Management">
                <TimingProfileManagement />
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/academic-calendars" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Academic Calendar Management">
                <DependencyGuard dependencies={[{ table: 'departments', label: 'Departments' }]}>
                  <AcademicCalendarManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/batch-room-allocations" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Batch Room Allocation">
                <DependencyGuard dependencies={[
                  { table: 'academic_calendars', label: 'Academic Calendar' },
                  { table: 'departments', label: 'Departments' },
                  { table: 'rooms', label: 'Rooms' }
                ]}>
                  <BatchRoomAllocationManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/dept-allocation" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="Department Room Mapping">
                <DependencyGuard dependencies={[
                  { table: 'departments', label: 'Departments' },
                  { table: 'rooms', label: 'Rooms' }
                ]}>
                  <DepartmentAllocationManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/equipment" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager', 'Maintenance Staff']}>
              <Layout title="Equipment Management">
                <DependencyGuard dependencies={[{ table: 'rooms', label: 'Rooms' }]}>
                  <EquipmentManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/scheduling" element={
            <ProtectedRoute roles={['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)']}>
              <Layout title="Schedule Records">
                <DependencyGuard dependencies={[
                  { table: 'rooms', label: 'Rooms' },
                  { table: 'departments', label: 'Departments' }
                ]}>
                  <SchedulingManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/bookings" element={
            <ProtectedRoute roles={['Administrator', 'Faculty', 'HOD', 'Event Coordinator', 'Dean (P&M)', 'Deputy Dean (P&M)']}>
              <Layout title="Room Bookings">
                <DependencyGuard dependencies={[{ table: 'rooms', label: 'Rooms' }]}>
                  <BookingManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/maintenance" element={
            <ProtectedRoute roles={['Administrator', 'Maintenance Staff', 'Infrastructure Manager']}>
              <Layout title="Maintenance Management">
                <DependencyGuard dependencies={[{ table: 'rooms', label: 'Rooms' }]}>
                  <MaintenanceManagement />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/ai-allocation" element={
            <ProtectedRoute roles={['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)']}>
              <Layout title="AI Room Recommendation">
                <DependencyGuard dependencies={[{ table: 'rooms', label: 'Rooms' }]}>
                  <AIAllocation />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/analytics" element={<ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}><Layout title="Infrastructure Analytics"><AnalyticsDashboard /></Layout></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}><Layout title="Utilization Reports"><ReportGeneration /></Layout></ProtectedRoute>} />
          <Route path="/timetable" element={
            <ProtectedRoute roles={['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)']}>
              <Layout title="Timetable View">
                <DependencyGuard dependencies={[{ table: 'rooms', label: 'Rooms' }]}>
                  <TimetableBuilder />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
          <Route path="/digital-twin" element={
            <ProtectedRoute roles={['Administrator', 'Infrastructure Manager']}>
              <Layout title="AI Smart Campus Digital Twin">
                <DependencyGuard dependencies={[{ table: 'buildings', label: 'Buildings' }, { table: 'rooms', label: 'Rooms' }]}>
                  <DigitalTwin />
                </DependencyGuard>
              </Layout>
            </ProtectedRoute>
          } />
        </Routes>
      </AppRouter>
      </ErrorBoundary>
    </AuthProvider>
  );
}

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean; error?: Error }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: any) {
    console.error('Uncaught app error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-white p-8">
          <div className="max-w-2xl bg-rose-50 border border-rose-200 p-6 rounded-2xl shadow-lg">
            <h2 className="text-xl font-bold text-rose-700 mb-3">Unexpected UI error</h2>
            <p className="text-slate-700 mb-3">An error occurred while rendering this module. Reload the page and try again.</p>
            <pre className="text-xs text-slate-500 overflow-auto">{this.state.error?.message}</pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children, roles }: { children: React.ReactNode, roles?: string[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-950 text-emerald-500 font-bold">MBU SmartCampus AI...</div>;
  if (!user) return <Navigate to="/login" />;
  const customAccessPaths = user?.access_paths?.split(',').map((path: string) => path.trim()).filter(Boolean) || [];
  const allowedByCustomRole = customAccessPaths.includes(location.pathname);
  if (roles && !roles.includes(user.role) && !allowedByCustomRole) return <Navigate to="/" />;
  return <>{children}</>;
}

// --- DASHBOARD HOME ---

function DashboardHome() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [utilizationTrend, setUtilizationTrend] = useState<any[]>([]);
  const [schoolUsage, setSchoolUsage] = useState<any[]>([]);
  const [aiInsightMessage, setAiInsightMessage] = useState('');
  const [utilizationReport, setUtilizationReport] = useState<any>({});
  const [isAnalysisPanelOpen, setIsAnalysisPanelOpen] = useState(false);

  const composeInsightMessage = (statsPayload: any, schoolReportsPayload: any[]) => {
    const rankedSchools = (Array.isArray(schoolReportsPayload) ? schoolReportsPayload : [])
      .filter((school: any) => school?.name)
      .sort((a: any, b: any) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0));
    const topSchool = rankedSchools[0];

    if (!topSchool) {
      return 'No school utilization data is available yet. Add room allocations, schedules, or approved bookings to populate live insights.';
    }

    const detailParts = [
      `${topSchool.name} is currently at ${Number(topSchool?.avgUtilization) || 0}% average utilization.`,
      `${statsPayload?.availableNow || 0} rooms are available right now.`,
    ];

    if ((statsPayload?.pendingBookings || 0) > 0) {
      detailParts.push(`${statsPayload.pendingBookings} booking request${statsPayload.pendingBookings === 1 ? '' : 's'} ${statsPayload.pendingBookings === 1 ? 'is' : 'are'} still pending.`);
    }

    if ((statsPayload?.equipmentIssues || 0) > 0) {
      detailParts.push(`${statsPayload.equipmentIssues} maintenance issue${statsPayload.equipmentIssues === 1 ? '' : 's'} need attention.`);
    }

    return detailParts.join(' ');
  };

  useEffect(() => {
    let isActive = true;

    const fetchData = async () => {
      const fetchJson = async <T,>(url: string, fallback: T, options?: RequestInit): Promise<T> => {
        try {
          const response = await fetch(url, { credentials: 'include', ...(options || {}) });
          if (!response.ok) throw new Error(`${url} responded with ${response.status}`);
          return await response.json();
        } catch (error) {
          console.error(`Dashboard fetch failed for ${url}:`, error);
          return fallback;
        }
      };

      try {
        const [statsData, utilizationData, reportData] = await Promise.all([
          fetchJson('/api/dashboard/stats', {}),
          fetchJson('/api/analytics/utilization-trends', []),
          fetchJson<any>('/api/reports/utilization', {})
        ]);

        if (!isActive) return;

        const safeStats = statsData || {};
        const safeSchoolReports = Array.isArray(reportData?.schoolReports) ? reportData.schoolReports : [];
        const fallbackInsight = composeInsightMessage(safeStats, safeSchoolReports);

        setStats(safeStats);
        setUtilizationTrend(Array.isArray(utilizationData) ? utilizationData : []);
        setSchoolUsage(safeSchoolReports);
        setAiInsightMessage(fallbackInsight);
        setUtilizationReport(reportData || {});

        const aiInsightResponse = await fetchJson<{ insight?: string; source?: string } | null>(
          '/api/ai/dashboard-insight',
          null,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              stats: safeStats,
              schoolReports: safeSchoolReports,
            }),
          }
        );

        if (!isActive) return;

        const generatedInsight = aiInsightResponse?.insight?.toString().trim() || '';
        setAiInsightMessage(generatedInsight || fallbackInsight);
      } catch (err) {
        console.error(err);
      } finally {
        if (isActive) setLoading(false);
      }
    };

    fetchData();

    const refreshTimer = window.setInterval(fetchData, 60000);
    return () => {
      isActive = false;
      window.clearInterval(refreshTimer);
    };
  }, []);

  const peakUtilization = useMemo(() => {
    if (!Array.isArray(utilizationTrend) || utilizationTrend.length === 0) return 0;
    return utilizationTrend.reduce((peak: number, item: any) => Math.max(peak, Number(item?.utilization) || 0), 0);
  }, [utilizationTrend]);

  const schoolUsageItems = useMemo(() => {
    const colorClasses = ['bg-emerald-500', 'bg-blue-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500'];
    return (Array.isArray(schoolUsage) ? schoolUsage : [])
      .filter((school: any) => school?.name)
      .sort((a: any, b: any) => (Number(b?.avgUtilization) || 0) - (Number(a?.avgUtilization) || 0))
      .map((school: any, index: number) => ({
        name: school.name,
        value: Number(school.avgUtilization) || 0,
        deptCount: Number(school.deptCount) || 0,
        color: colorClasses[index % colorClasses.length],
      }));
  }, [schoolUsage]);

  const topBusyRooms = useMemo(() => {
    const roomReports = Array.isArray(utilizationReport?.roomReports) ? utilizationReport.roomReports : [];
    return roomReports
      .filter((room: any) => Number(room?.utilization) > 0)
      .sort((a: any, b: any) => (Number(b?.utilization) || 0) - (Number(a?.utilization) || 0))
      .slice(0, 5);
  }, [utilizationReport]);

  const dashboardRoomMix = useMemo(
    () => getRoomMixCounts(Array.isArray(utilizationReport?.roomReports) ? utilizationReport.roomReports : []),
    [utilizationReport],
  );

  const lowestUsageRooms = useMemo(() => {
    const roomReports = Array.isArray(utilizationReport?.roomReports) ? utilizationReport.roomReports : [];
    return roomReports
      .filter((room: any) => Number(room?.utilization) >= 0)
      .sort((a: any, b: any) => (Number(a?.utilization) || 0) - (Number(b?.utilization) || 0))
      .slice(0, 5);
  }, [utilizationReport]);

  const openAnalysisPanel = () => {
    setIsAnalysisPanelOpen(true);
  };

  const closeAnalysisPanel = () => {
    setIsAnalysisPanelOpen(false);
  };

  const statCards = [
    { label: 'Total Buildings', value: stats?.totalBuildings || '0', icon: Building2, color: 'text-blue-600', bg: 'bg-blue-50', path: '/digital-twin?view=3D' },
    { label: 'Available Now', value: stats?.availableNow || '0', icon: DoorOpen, color: 'text-emerald-600', bg: 'bg-emerald-50', path: '/rooms', detail: formatRoomMixSummary(dashboardRoomMix) },
    { label: 'Scheduled Today', value: stats?.scheduledRooms || '0', icon: Calendar, color: 'text-indigo-600', bg: 'bg-indigo-50', path: '/digital-twin?status=ScheduledToday' },
    { label: 'Equipment Issues', value: stats?.equipmentIssues || '0', icon: AlertTriangle, color: 'text-rose-600', bg: 'bg-rose-50', path: '/maintenance?status=open' },
    { label: 'Pending Bookings', value: stats?.pendingBookings || '0', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50', path: '/bookings?status=Pending' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6">
        {statCards.map((stat) => (
          <button
            key={stat.label}
            type="button"
            onClick={() => navigate(stat.path)}
            className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all group text-left focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            aria-label={`Open ${stat.label}`}
          >
            <div className="flex items-center justify-between mb-4">
              <div className={cn("p-3 rounded-2xl transition-all group-hover:scale-110", stat.bg)}>
                <stat.icon className={stat.color} size={24} />
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Live</span>
              </div>
            </div>
            <h3 className="text-3xl font-black text-slate-800 mb-1">{stat.value}</h3>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">{stat.label}</p>
            {stat.detail && (
              <p className="text-[11px] text-slate-400 font-semibold mt-2">{stat.detail}</p>
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        <div className="lg:col-span-3 space-y-8">
          <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h3 className="text-xl font-bold text-slate-800">Top Room Utilization</h3>
                <p className="text-sm text-slate-500">Live room usage based on schedules and approved bookings</p>
              </div>
              <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100">
                <Activity size={16} className="text-emerald-500" />
                <span className="text-xs font-bold text-slate-600">Peak: {peakUtilization}%</span>
              </div>
            </div>
            <div className="h-80 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={Array.isArray(utilizationTrend) ? utilizationTrend : []}>
                  <defs>
                    <linearGradient id="colorUtil" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="name" hide />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '24px', border: 'none', boxShadow: '0 25px 50px -12px rgb(0 0 0 / 0.25)' }}
                  />
                  <Area type="monotone" dataKey="utilization" stroke="#10b981" fillOpacity={1} fill="url(#colorUtil)" strokeWidth={4} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
                  <Zap size={20} />
                </div>
                Quick Actions
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <Link to="/ai-allocation" className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-emerald-500 hover:bg-white transition-all group">
                  <BrainCircuit className="text-slate-400 group-hover:text-emerald-500 mb-3" size={24} />
                  <p className="text-xs font-bold text-slate-700">AI Allocation</p>
                </Link>
                <Link to="/bookings" className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-emerald-500 hover:bg-white transition-all group">
                  <Calendar className="text-slate-400 group-hover:text-emerald-500 mb-3" size={24} />
                  <p className="text-xs font-bold text-slate-700">Room Bookings</p>
                </Link>
                <Link to="/digital-twin" className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-emerald-500 hover:bg-white transition-all group">
                  <Globe className="text-slate-400 group-hover:text-emerald-500 mb-3" size={24} />
                  <p className="text-xs font-bold text-slate-700">Digital Twin</p>
                </Link>
                <Link to="/maintenance" className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-emerald-500 hover:bg-white transition-all group">
                  <Wrench className="text-slate-400 group-hover:text-emerald-500 mb-3" size={24} />
                  <p className="text-xs font-bold text-slate-700">Maintenance</p>
                </Link>
              </div>
            </div>

            <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-3">
                <div className="p-2 bg-rose-50 rounded-lg text-rose-600">
                  <AlertTriangle size={20} />
                </div>
                System Alerts
              </h3>
              <div className="space-y-4">
                {stats?.recentAlerts?.length > 0 ? stats.recentAlerts.slice(0, 3).map((alert: any) => (
                  <div key={alert.id} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center">
                      <AlertTriangle size={20} />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-800">Room {alert.room_number}</p>
                      <p className="text-[10px] text-slate-500 uppercase tracking-widest">{alert.building_name}</p>
                    </div>
                  </div>
                )) : (
                  <div className="text-center py-8 text-slate-400 italic text-sm">No critical alerts.</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          <div className="bg-slate-900 p-8 rounded-[40px] text-white overflow-hidden relative group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <Sparkles size={80} />
            </div>
            <h3 className="text-xl font-bold mb-4 relative z-10">AI Insights</h3>
            <p className="text-sm text-slate-400 leading-relaxed mb-6 relative z-10">
              {aiInsightMessage}
            </p>
            <button
              onClick={openAnalysisPanel}
              className="w-full py-3 bg-emerald-500 text-white rounded-2xl font-bold text-sm hover:bg-emerald-600 transition-all relative z-10"
            >
              View Analysis
            </button>
          </div>

          <div className="bg-white p-8 rounded-[40px] border border-slate-200 shadow-sm">
            <h3 className="text-lg font-bold text-slate-800 mb-6">Usage by School</h3>
            {schoolUsageItems.length > 0 ? (
              <div className="space-y-6">
                {schoolUsageItems.map((school) => (
                  <div key={school.name} className="space-y-2">
                    <div className="flex justify-between gap-4 text-xs font-bold">
                      <div className="min-w-0">
                        <span className="block text-slate-600 truncate">{school.name}</span>
                        <span className="block text-[10px] uppercase tracking-widest text-slate-400">
                          {school.deptCount} department{school.deptCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <span className="text-slate-900">{school.value}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className={cn("h-full rounded-full", school.color)} style={{ width: `${school.value}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-slate-400 italic">No school utilization data is available yet.</div>
            )}
          </div>
        </div>
      </div>

      {isAnalysisPanelOpen && (
        <div className="fixed inset-0 z-[120] bg-slate-950/60 backdrop-blur-sm p-4 md:p-8 flex justify-end">
          <div className="w-full max-w-2xl h-full bg-white rounded-3xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200 flex items-start justify-between">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Dashboard Analysis Snapshot</h3>
                <p className="text-sm text-slate-500 mt-1">Live operational summary generated from current dashboard metrics.</p>
              </div>
              <button
                type="button"
                onClick={closeAnalysisPanel}
                className="text-slate-400 hover:text-slate-700 transition-colors"
                aria-label="Close analysis panel"
              >
                <X size={22} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Buildings</p>
                  <p className="text-xl font-black text-slate-800 mt-1">{stats?.totalBuildings || 0}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Available</p>
                  <p className="text-xl font-black text-emerald-700 mt-1">{stats?.availableNow || 0}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Scheduled Today</p>
                  <p className="text-xl font-black text-indigo-700 mt-1">{stats?.scheduledRooms || 0}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Pending</p>
                  <p className="text-xl font-black text-amber-700 mt-1">{stats?.pendingBookings || 0}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-700 mb-2">AI Insight</p>
                <p className="text-sm text-slate-700 leading-relaxed">{aiInsightMessage}</p>
              </div>

              <div className="rounded-2xl border border-slate-200 p-4">
                <h4 className="text-sm font-bold text-slate-800 mb-3">Highest Utilization Rooms</h4>
                {topBusyRooms.length > 0 ? (
                  <div className="space-y-2">
                    {topBusyRooms.map((room: any) => (
                      <div key={`busy-${room.room_id}`} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-slate-800 truncate">Room {room.room_number}</p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {[room.building, room.block].filter(Boolean).join(' • ') || 'No building context'}
                          </p>
                        </div>
                        <span className="text-xs font-bold text-rose-600">{Math.round(Number(room.utilization) || 0)}%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic">No utilization records available yet.</p>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 p-4">
                <h4 className="text-sm font-bold text-slate-800 mb-3">Lowest Utilization Rooms</h4>
                {lowestUsageRooms.length > 0 ? (
                  <div className="space-y-2">
                    {lowestUsageRooms.map((room: any) => (
                      <div key={`low-${room.room_id}`} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-slate-800 truncate">Room {room.room_number}</p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {[room.building, room.block].filter(Boolean).join(' • ') || 'No building context'}
                          </p>
                        </div>
                        <span className="text-xs font-bold text-slate-700">{Math.round(Number(room.utilization) || 0)}%</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic">No utilization records available yet.</p>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-white flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={closeAnalysisPanel}
                className="flex-1 px-4 py-2 rounded-xl border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50 transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  closeAnalysisPanel();
                  navigate('/analytics');
                }}
                className="flex-1 px-4 py-2 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors"
              >
                View Full Analytics
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- CRUD COMPONENTS (Simplified for brevity, but functional) ---

function GenericCRUD({
  type,
  fields,
  apiPath,
  onImport,
  prepareSubmitData,
  prepareFormData,
  afterSubmit,
  onDataChanged,
  dataFilter,
  filterControls,
  initialSearchTerm,
  dataSorter,
  exportBuilder,
}: {
  type: string,
  fields: any[],
  apiPath: string,
  onImport?: (data: any[]) => Promise<void | ImportAuditResult>,
  prepareSubmitData?: (formData: any, editingItem: any) => Promise<any> | any,
  prepareFormData?: (item: any) => any,
  afterSubmit?: (savedItem: any, formData: any, editingItem: any) => Promise<void> | void,
  onDataChanged?: () => Promise<void> | void,
  dataFilter?: (item: any) => boolean,
  filterControls?: React.ReactNode,
  initialSearchTerm?: string,
  dataSorter?: (a: any, b: any) => number,
  exportBuilder?: (items: any[]) => { headers: string[]; rows: any[][] },
}) {
  const [data, setData] = useState<any[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);
  const [formData, setFormData] = useState<any>({});
  const [isImporting, setIsImporting] = useState(false);
  const [lastImportAudit, setLastImportAudit] = useState<ImportAuditResult | null>(null);
  const [visiblePasswordFields, setVisiblePasswordFields] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearchTerm(initialSearchTerm || '');
  }, [initialSearchTerm]);

  const fetchData = async () => {
    try {
      const res = await fetch(apiPath, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) {
        console.error(`${type} load error:`, json);
        setData([]);
        return;
      }
      setData(Array.isArray(json) ? json : []);
    } catch (err) {
      console.error(`${type} load failed:`, err);
      setData([]);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const tableFields = fields.filter(f => !f.formOnly);
  const formFields = fields.filter(f => !f.tableOnly);
  const getFieldOptions = (field: any, context: any) => {
    if (!field.options) return [];
    const options = typeof field.options === 'function' ? field.options(context) : field.options;
    return Array.isArray(options) ? options : [];
  };

  const getOptionValue = (option: any) =>
    typeof option === 'object' ? option.value : option;

  const getOptionLabel = (option: any) =>
    typeof option === 'object' ? option.label : option;

  const getFieldDisplayValue = (field: any, item: any) => {
    if (field.render) return field.render(item);
    const value = item[field.key];

    if (field.type === 'select') {
      if (field.multiple) {
        const selectedValues = value?.toString().split(',').map((part: string) => part.trim()).filter(Boolean) || [];
        const labels = selectedValues.map((selectedValue: string) => {
          const option = getFieldOptions(field, item).find((opt: any) => getOptionValue(opt)?.toString() === selectedValue);
          return option ? getOptionLabel(option) : selectedValue;
        });
        return labels.join(', ');
      }
      const option = getFieldOptions(field, item).find((opt: any) => getOptionValue(opt)?.toString() === value?.toString());
      return option ? getOptionLabel(option) : value;
    }

    return value;
  };
  const getFormFieldLabel = (field: any) =>
    typeof field.formLabel === 'function'
      ? field.formLabel(formData, editingItem)
      : (field.formLabel || field.label);

  const displayData = (dataFilter ? data.filter(dataFilter) : data)
    .slice()
    .sort(dataSorter || (() => 0));
  const filteredData = displayData.filter(item => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return true;
    return tableFields.some(field => getFieldDisplayValue(field, item)?.toString().toLowerCase().includes(query));
  });
  const sanitizeExcelName = (value: string) => value.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Export';

  const downloadTemplate = () => {
    const templateConfig = IMPORT_TEMPLATE_CONFIG[type];
    const headers = templateConfig?.headers || formFields.map(f => f.label);
    const exampleRows = templateConfig?.exampleRows || [];
    const ws = XLSX.utils.aoa_to_sheet([
      headers,
      ...exampleRows.map((row) => headers.map((header) => row[header] ?? '')),
    ]);
    const noteSheet = XLSX.utils.aoa_to_sheet([
      ['Instructions'],
      ['Keep the header row unchanged. Replace or delete the example row(s) before importing the file.'],
      ...((templateConfig?.instructions || []).map((instruction) => [instruction])),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    XLSX.utils.book_append_sheet(wb, noteSheet, "Instructions");
    XLSX.writeFile(wb, `${type}_Template.xlsx`);
  };

  const downloadExport = () => {
    const exportData = exportBuilder
      ? exportBuilder(filteredData)
      : {
          headers: tableFields.map(field => field.label),
          rows: filteredData.map(item =>
            tableFields.map(field => {
              const value = getFieldDisplayValue(field, item);
              return value === undefined || value === null ? '' : value;
            })
          ),
        };
    const worksheet = XLSX.utils.aoa_to_sheet([exportData.headers, ...exportData.rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeExcelName(`${type} Data`));
    XLSX.writeFile(workbook, `${type}_Export.xlsx`);
  };

  const downloadImportAudit = () => {
    if (!lastImportAudit?.auditRows?.length) return;
    const headers = lastImportAudit.auditHeaders?.length
      ? lastImportAudit.auditHeaders
      : Array.from(new Set(lastImportAudit.auditRows.flatMap((row) => Object.keys(row || {}))));
    const workbook = XLSX.utils.book_new();
    const summaryRows = [
      ['Metric', 'Value'],
      ['Audit Title', lastImportAudit.auditTitle || `${type} Import Audit`],
      ['Total Rows Read', lastImportAudit.summary?.totalRowsRead ?? lastImportAudit.auditRows.length],
      ['Valid Rows', lastImportAudit.summary?.validRows ?? ''],
      ['Created', lastImportAudit.summary?.created ?? 0],
      ['Updated', lastImportAudit.summary?.updated ?? 0],
      ['Skipped', lastImportAudit.summary?.skipped ?? 0],
      ['Failed', lastImportAudit.summary?.failed ?? 0],
      ['Message', lastImportAudit.message || ''],
    ];
    const auditRows = lastImportAudit.auditRows.map((row) => headers.map((header) => row?.[header] ?? ''));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), 'Summary');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, ...auditRows]), sanitizeExcelName(lastImportAudit.auditTitle || `${type} Audit`));
    XLSX.writeFile(workbook, `${type}_Import_Audit.xlsx`);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!onImport) return;
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setLastImportAudit(null);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const importSheetNames = wb.SheetNames.includes('Template')
          ? ['Template']
          : wb.SheetNames.filter((sheetName) => normalizeLookupValue(sheetName) !== 'instructions');
        const effectiveSheetNames = importSheetNames.length > 0 ? importSheetNames : wb.SheetNames;
        const jsonData = effectiveSheetNames.flatMap((sheetName) => {
          const ws = wb.Sheets[sheetName];
          return XLSX.utils.sheet_to_json(ws).map((row: any, index: number) => ({
            ...row,
            __sheetName: sheetName,
            __rowNumber: index + 2,
          }));
        });
        const importResult = await onImport(jsonData);
        await fetchData();
        if (onDataChanged) await onDataChanged();
        if (importResult && typeof importResult === 'object') {
          setLastImportAudit(importResult);
        }
        const importMessage =
          importResult && typeof importResult === 'object' && 'message' in importResult
            ? importResult.message
            : '';
        alert(importMessage || 'Import successful!');
      } catch (err: any) {
        alert(`Import failed: ${err.message}`);
      } finally {
        setIsImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.readAsBinaryString(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editingItem ? 'PUT' : 'POST';
    const url = editingItem ? `${apiPath}/${editingItem.id}` : apiPath;
    let payload = formData;
    try {
      payload = prepareSubmitData ? await prepareSubmitData(formData, editingItem) : formData;
    } catch (err: any) {
      alert(`Error: ${err.message || 'Operation failed'}`);
      return;
    }
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include'
    });
    if (res.ok) {
      const savedItem = await res.json();
      try {
        if (afterSubmit) {
          await afterSubmit(savedItem, formData, editingItem);
        }
      } catch (err: any) {
        alert(`Saved ${type}, but follow-up setup failed: ${err.message || 'Operation failed'}`);
      }
      setIsModalOpen(false);
      setEditingItem(null);
      setFormData({});
      await fetchData();
      if (onDataChanged) await onDataChanged();
    } else {
      const err = await res.json();
      alert(`Error: ${err.error || 'Operation failed'}`);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this record?')) {
      const res = await fetch(`${apiPath}/${id}`, { 
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        await fetchData();
        if (onDataChanged) await onDataChanged();
      } else {
        const err = await res.json();
        alert(`Error deleting record: ${err.error || 'Operation failed'}`);
      }
    }
  };

  const handleReset = async () => {
    if (confirm(`Are you sure you want to reset all ${type} records? This action cannot be undone.`)) {
      const res = await fetch(`${apiPath}/reset`, { 
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        await fetchData();
        if (onDataChanged) await onDataChanged();
        alert('Module reset successful!');
      } else {
        const err = await res.json();
        alert(`Error resetting module: ${err.error || 'Operation failed'}`);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder={`Search ${type}...`}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </div>
        <div className="flex items-center gap-3">
          {onImport && (
            <>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".xlsx, .xls"
                className="hidden"
              />
              <button
                onClick={downloadTemplate}
                className="flex items-center gap-2 bg-slate-50 text-slate-600 border border-slate-200 px-4 py-2 rounded-lg font-bold hover:bg-slate-100 transition-all"
              >
                <FileText size={18} />
                Template
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isImporting}
                className="flex items-center gap-2 bg-emerald-50 text-emerald-700 border border-emerald-200 px-4 py-2 rounded-lg font-bold hover:bg-emerald-100 transition-all disabled:opacity-50"
              >
                <FileSpreadsheet size={18} />
                {isImporting ? 'Importing...' : 'Import Excel'}
              </button>
            </>
          )}
          <button
            onClick={downloadExport}
            disabled={filteredData.length === 0}
            className="flex items-center gap-2 bg-sky-50 text-sky-700 border border-sky-200 px-4 py-2 rounded-lg font-bold hover:bg-sky-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <FileSpreadsheet size={18} />
            Export Excel
          </button>
          {lastImportAudit?.auditRows?.length ? (
            <button
              onClick={downloadImportAudit}
              className="flex items-center gap-2 bg-amber-50 text-amber-700 border border-amber-200 px-4 py-2 rounded-lg font-bold hover:bg-amber-100 transition-all"
            >
              <FileSpreadsheet size={18} />
              Download Audit
            </button>
          ) : null}
          <button
            onClick={handleReset}
            className="flex items-center gap-2 bg-rose-50 text-rose-600 border border-rose-200 px-4 py-2 rounded-lg font-bold hover:bg-rose-100 transition-all"
          >
            <Trash2 size={18} />
            Reset
          </button>
          <button
            onClick={() => { setEditingItem(null); setFormData({}); setIsModalOpen(true); }}
            className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-lg font-bold hover:bg-slate-800 transition-all"
          >
            <Plus size={18} />
            Create {type}
          </button>
        </div>
      </div>

      {filterControls && (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          {filterControls}
        </div>
      )}

      {lastImportAudit?.auditRows?.length ? (
        <div className="bg-white border border-amber-200 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h3 className="text-lg font-bold text-slate-800">{lastImportAudit.auditTitle || `${type} Import Audit`}</h3>
              <p className="text-sm text-slate-500">{lastImportAudit.message || 'Review the row-level results from the most recent import.'}</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Rows', value: lastImportAudit.summary?.totalRowsRead ?? lastImportAudit.auditRows.length },
                { label: 'Created', value: lastImportAudit.summary?.created ?? 0 },
                { label: 'Updated', value: lastImportAudit.summary?.updated ?? 0 },
                { label: 'Skipped', value: lastImportAudit.summary?.skipped ?? 0 },
                { label: 'Failed', value: lastImportAudit.summary?.failed ?? 0 },
              ].map((item) => (
                <div key={item.label} className="px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-center">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-slate-400">{item.label}</p>
                  <p className="text-lg font-bold text-slate-800">{item.value}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-white">
                <tr className="border-b border-slate-100">
                  {(lastImportAudit.auditHeaders?.length
                    ? lastImportAudit.auditHeaders
                    : Array.from(new Set(lastImportAudit.auditRows.flatMap((row) => Object.keys(row || {}))))
                  ).map((header) => (
                    <th key={header} className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {lastImportAudit.auditRows.map((row, index) => {
                  const headers = lastImportAudit.auditHeaders?.length
                    ? lastImportAudit.auditHeaders
                    : Array.from(new Set(lastImportAudit.auditRows!.flatMap((item) => Object.keys(item || {}))));
                  return (
                    <tr key={`${row['Row Number'] || row.RowNumber || index}-${row['Primary ID'] || row.PrimaryId || index}`} className="hover:bg-slate-50/50">
                      {headers.map((header) => (
                        <td key={`${index}-${header}`} className="px-4 py-3 text-sm text-slate-600 align-top">{row?.[header] ?? '-'}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {tableFields.map(f => (
                <th key={f.key} className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">{f.label}</th>
              ))}
              <th className="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredData.map((item) => (
              <tr key={item.id} className="hover:bg-slate-50/50 transition-colors">
                {tableFields.map(f => (
                  <td key={f.key} className="px-6 py-4 text-sm text-slate-600 font-medium">{getFieldDisplayValue(f, item)}</td>
                ))}
                <td className="px-6 py-4 text-right space-x-2">
                  <button
                    onClick={() => { setEditingItem(item); setFormData(prepareFormData ? prepareFormData(item) : item); setIsModalOpen(true); }}
                    className="p-2 text-slate-400 hover:text-emerald-600 transition-colors"
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="p-2 text-slate-400 hover:text-rose-600 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
            {filteredData.length === 0 && (
              <tr>
                <td colSpan={tableFields.length + 1} className="px-6 py-8 text-center text-sm text-slate-400 italic">
                  No {type.toLowerCase()} records found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-white">
              <h3 className="text-lg font-bold text-slate-800">{editingItem ? 'Edit' : 'Create'} {type}</h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4 bg-white max-h-[calc(90vh-80px)] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                {formFields.filter(f => !f.show || f.show(formData, editingItem)).map(f => (
                  <div key={f.key} className={cn("space-y-1", f.fullWidth && "col-span-2")}>
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{getFormFieldLabel(f)}</label>
                    {f.type === 'select' ? (
                      <select
                        multiple={!!f.multiple}
                        required={f.required !== false}
                        value={f.multiple ? (formData[f.key]?.toString().split(',').filter(Boolean) || []) : (formData[f.key] || '')}
                        onChange={e => {
                          const value = f.multiple
                            ? Array.from(e.target.selectedOptions).map(option => option.value).filter(Boolean).join(',')
                            : e.target.value;
                          const nextData = { ...formData, [f.key]: value };
                          f.resetKeys?.forEach((key: string) => { nextData[key] = ''; });
                          setFormData(f.onChange ? f.onChange(nextData, value, editingItem) : nextData);
                        }}
                        className={cn(
                          "w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500",
                          f.multiple && "min-h-28"
                        )}
                      >
                        {!f.multiple && <option value="">Select {getFormFieldLabel(f)}</option>}
                        {getFieldOptions(f, formData).map((opt: any) => {
                          const value = getOptionValue(opt);
                          const label = getOptionLabel(opt);
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    ) : f.type === 'password' ? (
                      <div className="space-y-2">
                        <div className="relative">
                          <input
                            type={visiblePasswordFields[f.key] ? 'text' : 'password'}
                            required={f.required !== false}
                            value={formData[f.key] || ''}
                            onChange={e => setFormData({ ...formData, [f.key]: e.target.value })}
                            className="w-full px-3 py-2 pr-16 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
                            placeholder={editingItem ? 'Enter new password' : `Enter ${getFormFieldLabel(f)}`}
                          />
                          <button
                            type="button"
                            onClick={() => setVisiblePasswordFields(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-500 hover:text-slate-800"
                          >
                            {visiblePasswordFields[f.key] ? 'Hide' : 'Show'}
                          </button>
                        </div>
                        {editingItem && (
                          <button
                            type="button"
                            onClick={() => setFormData({ ...formData, [f.key]: 'Welcome123' })}
                            className="w-full px-3 py-2 bg-amber-50 text-amber-700 border border-amber-100 rounded-lg text-xs font-bold hover:bg-amber-100"
                          >
                            Reset Password to Welcome123
                          </button>
                        )}
                      </div>
                    ) : (
                      <input
                        type={f.type || 'text'}
                        required={f.required !== false}
                        value={formData[f.key] || ''}
                        onChange={e => setFormData({ ...formData, [f.key]: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
                        placeholder={`Enter ${getFormFieldLabel(f)}`}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 px-4 py-2 border border-slate-200 text-slate-600 font-bold rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-slate-800"
                >
                  {editingItem ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// --- SPECIFIC MODULES ---

function UserManagement() {
  const [departments, setDepartments] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/departments', { credentials: 'include' })
      .then(res => res.json())
      .then(data => setDepartments(Array.isArray(data) ? data : []))
      .catch(() => setDepartments([]));
  }, []);

  const fields = [
    { key: 'full_name', label: 'Full Name' },
    { key: 'employee_id', label: 'Employee ID' },
    { key: 'role', label: 'Role', type: 'select', options: ['Administrator', 'Dean (P&M)', 'Deputy Dean (P&M)', 'HOD', 'Event Coordinator', 'Faculty', 'Maintenance Staff', 'Infrastructure Manager'] },
    { key: 'email', label: 'Email Address' },
    { key: 'department', label: 'Department', type: 'select', required: false, options: departments.map(department => department.name) },
    { key: 'password_status', label: 'Password', tableOnly: true, render: (item: any) => item.force_password_change ? 'Temporary - change required' : 'Hidden - reset in edit' },
    { key: 'password', label: 'Password / Admin Reset', type: 'password', formOnly: true, required: false },
  ];

  const prepareFormData = (item: any) => ({ ...item, password: '' });
  const prepareSubmitData = (data: any, editingItem: any) => {
    const payload = { ...data };
    if (editingItem && !payload.password) delete payload.password;
    if (!editingItem && !payload.password) payload.password = 'Welcome123';
    return payload;
  };

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const payload = {
        full_name: row['Full Name'],
        employee_id: row['Employee ID']?.toString(),
        role: row['Role'],
        email: row['Email Address'],
        department: row['Department'],
        password: getImportValue(row, ['Password', 'Password / Admin Reset'])?.toString() || 'Welcome123'
      };
      if (!payload.email || !payload.employee_id) continue;
      await upsertImportRecord('/api/users', payload, [['employee_id'], ['email']]);
    }
  };

  return <GenericCRUD type="User" fields={fields} apiPath="/api/users" onImport={handleImport} prepareFormData={prepareFormData} prepareSubmitData={prepareSubmitData} />;
}

function CampusManagement() {
  const fields = [
    { key: 'campus_id', label: 'Campus ID' },
    { key: 'name', label: 'Campus Name' },
    { key: 'location', label: 'Location' },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const payload = {
        campus_id: row['Campus ID']?.toString(),
        name: row['Campus Name'],
        location: row['Location'],
        description: row['Description']
      };
      if (!payload.campus_id || !payload.name) continue;
      await upsertImportRecord('/api/campuses', payload, [['campus_id'], ['name']]);
    }
  };

  return <GenericCRUD type="Campus" fields={fields} apiPath="/api/campuses" onImport={handleImport} />;
}

function BuildingManagement() {
  const [campuses, setCampuses] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/campuses').then(res => res.json()).then(setCampuses);
    fetch('/api/blocks').then(res => res.json()).then(setBlocks);
  }, []);

  const getVisibleBlocksForBuilding = (building: any) =>
    blocks.filter(block => idsMatch(block.building_id, building.id) && !isImplicitBuildingBlock(block, building));

  const getBuildingStructureType = (building: any) =>
    building?.structure_type === 'blocks' || getVisibleBlocksForBuilding(building).length > 0 ? 'blocks' : 'direct';

  const fields = [
    { key: 'building_id', label: 'Building ID' },
    { key: 'name', label: 'Building Name' },
    { key: 'campus_id', label: 'Campus', type: 'select', options: campuses.map(c => ({ value: c.id, label: c.name })) },
    {
      key: 'structure_type',
      label: 'Structure Type',
      type: 'select',
      render: (item: any) => getBuildingStructureType(item) === 'blocks' ? 'Has blocks' : 'No blocks',
      options: [
        { value: 'direct', label: 'No blocks, floors directly under building' },
        { value: 'blocks', label: 'Has blocks' },
      ],
    },
    {
      key: 'planned_block_count',
      label: 'Blocks Created / Planned',
      type: 'number',
      required: false,
      show: (formData: any) => formData.structure_type === 'blocks',
      render: (item: any) => {
        const actualBlockCount = getVisibleBlocksForBuilding(item).length;
        const plannedBlockCount = Number(item.planned_block_count) || actualBlockCount;
        return getBuildingStructureType(item) === 'blocks' ? `${actualBlockCount} of ${plannedBlockCount}` : 0;
      },
    },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const prepareSubmitData = (data: any) => {
    const structureType = data.structure_type || 'direct';
    const existingBlockCount = data.id ? getVisibleBlocksForBuilding(data).length : 0;

    if (structureType === 'direct' && existingBlockCount > 0) {
      throw new Error('This building already has blocks. Remove or edit the blocks before changing it to direct floors.');
    }

    if (structureType === 'blocks' && (parseInt(data.planned_block_count, 10) || 0) < 1) {
      throw new Error('Please enter at least 1 block');
    }

    if (structureType === 'blocks' && data.id && (parseInt(data.planned_block_count, 10) || 0) < existingBlockCount) {
      throw new Error('This building already has more blocks. Delete extra blocks before reducing the block count.');
    }

    const payload = { ...data };
    payload.structure_type = structureType;
    payload.planned_block_count = payload.structure_type === 'blocks'
      ? parseInt(data.planned_block_count, 10) || 0
      : 0;
    return payload;
  };

  const prepareFormData = (item: any) => {
    const visibleBlockCount = getVisibleBlocksForBuilding(item).length;
    const structureType = getBuildingStructureType(item);

    return {
      ...item,
      structure_type: structureType,
      planned_block_count: structureType === 'blocks'
        ? Number(item.planned_block_count) || visibleBlockCount || 1
        : 0,
    };
  };

  const handleImport = async (data: any[]) => {
    let importedCount = 0;
    const skippedRows: string[] = [];

    for (const [index, row] of data.entries()) {
      const campus = findCampusForImport(campuses, row);
      const hasBlocks = isBlocksStructureType(getImportValue(row, ['Structure Type']));
      const payload = {
        building_id: row['Building ID']?.toString(),
        name: row['Building Name'],
        campus_id: campus?.id,
        structure_type: hasBlocks ? 'blocks' : 'direct',
        planned_block_count: hasBlocks ? parseInt(getImportValue(row, ['Number of Blocks']) as any, 10) || 0 : 0,
        description: row['Description']
      };
      if (!payload.building_id || !payload.name || !payload.campus_id) {
        skippedRows.push(`row ${index + 2}`);
        continue;
      }
      await upsertImportRecord('/api/buildings', payload, [['building_id'], ['campus_id', 'name']]);
      importedCount += 1;
    }

    if (importedCount === 0) {
      throw new Error(`No buildings were imported. Check that the Campus column matches an existing campus name or campus ID. Skipped ${skippedRows.join(', ') || 'all rows'}.`);
    }
  };

  return (
    <GenericCRUD
      type="Building"
      fields={fields}
      apiPath="/api/buildings"
      onImport={handleImport}
      prepareSubmitData={prepareSubmitData}
      prepareFormData={prepareFormData}
    />
  );
}

function BlockManagement() {
  const [buildings, setBuildings] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/buildings').then(res => res.json()).then(setBuildings);
  }, []);

  const blockEligibleBuildings = buildings.filter(building =>
    building?.structure_type === 'blocks' || (Number(building?.planned_block_count) || 0) > 0
  );
  const isBlockEligibleBuilding = (building: any) =>
    !!building && blockEligibleBuildings.some(item => item.id === building.id);

  const fields = [
    { key: 'block_id', label: 'Block ID' },
    { key: 'name', label: 'Block Name' },
    { key: 'building_id', label: 'Building', type: 'select', options: blockEligibleBuildings.map(b => ({ value: b.id, label: b.name })) },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const prepareSubmitData = (data: any) => {
    const selectedBuilding = buildings.find(building => building.id?.toString() === data.building_id?.toString());

    if (!isBlockEligibleBuilding(selectedBuilding)) {
      throw new Error('Please select a building that is marked as "Has blocks".');
    }

    const payload = { ...data };
    delete payload.planned_floor_count;
    delete payload.first_floor_number;
    return payload;
  };

  const handleImport = async (data: any[]) => {
    let importedCount = 0;
    const skippedRows: string[] = [];

    for (const [index, row] of data.entries()) {
      const blockId = row['Block ID']?.toString();
      const building = findBuildingForImport(buildings, row, blockId);
      const payload = {
        block_id: blockId,
        name: row['Block Name'],
        building_id: building?.id,
        description: row['Description']
      };
      if (!payload.block_id || !payload.name || !payload.building_id || !isBlockEligibleBuilding(building)) {
        skippedRows.push(`row ${index + 2}`);
        continue;
      }
      await upsertImportRecord('/api/blocks', payload, [['block_id'], ['building_id', 'name']]);
      importedCount += 1;
    }

    if (importedCount === 0) {
      throw new Error(`No blocks were imported. Check the Building column or use the building ID, for example BLDG-001. Skipped ${skippedRows.join(', ') || 'all rows'}.`);
    }
  };

  return (
    <GenericCRUD
      type="Block"
      fields={fields}
      apiPath="/api/blocks"
      onImport={handleImport}
      prepareSubmitData={prepareSubmitData}
      dataFilter={(item: any) => {
        const building = buildings.find(b => b.id === item.building_id);
        return isBlockEligibleBuilding(building) && !isImplicitBuildingBlock(item, building);
      }}
    />
  );
}

const DIRECT_BUILDING_BLOCK_NAME = 'Main Block';

const normalizeEntityName = (value: unknown) =>
  value?.toString().trim().toLowerCase().replace(/\s+/g, ' ') || '';

const isImplicitBuildingBlock = (block: any, building?: any) => {
  const blockName = normalizeEntityName(block?.name);
  const buildingName = normalizeEntityName(building?.name);
  return blockName === normalizeEntityName(DIRECT_BUILDING_BLOCK_NAME) ||
    blockName === 'default block' ||
    (!!buildingName && blockName === buildingName);
};

const getBlockDisplayLabel = (block: any, building?: any) =>
  isImplicitBuildingBlock(block, building) ? 'Direct floors' : block?.name || 'Unknown Block';

const getFloorName = (floorNumber: number | string) => {
  const value = Number(floorNumber);
  if (Number.isNaN(value)) return `Floor ${floorNumber}`;
  if (value < 0) return `Basement ${Math.abs(value)}`;
  if (value === 0) return 'Ground Floor';
  return `Floor ${value}`;
};

const getFloorShortName = (floorNumber: number | string) => {
  const value = Number(floorNumber);
  if (Number.isNaN(value)) return floorNumber?.toString() || '';
  if (value < 0) return `B${Math.abs(value)}`;
  if (value === 0) return 'G';
  return value.toString();
};

const getGeneratedFloorId = (prefix: string, floorNumber: number) => {
  const cleanPrefix = prefix.toString().trim().replace(/-+$/, '');
  if (floorNumber < 0) return `${cleanPrefix}-B${Math.abs(floorNumber)}`;
  if (floorNumber === 0) return `${cleanPrefix}-G`;
  return `${cleanPrefix}-F${floorNumber}`;
};

const getFloorDisplayLabel = (floor: any, blocks: any[], buildings: any[]) => {
  const block = blocks.find(b => idsMatch(b.id, floor.block_id));
  const building = buildings.find(b => idsMatch(b.id, block?.building_id));
  const floorName = getFloorName(floor.floor_number);

  if (!block || !building) return `${floorName} (Unknown Building)`;
  if (isImplicitBuildingBlock(block, building)) return `${floorName} (${building.name})`;
  return `${floorName} (${building.name} - ${block.name})`;
};

const ensureDirectBuildingBlock = async (buildingId: number | string, blocks: any[], buildings: any[]) => {
  const building = buildings.find(b => b.id == buildingId);
  const latestRes = await fetch('/api/blocks', { credentials: 'include' });
  const latestBlocks = latestRes.ok ? await latestRes.json() : blocks;
  const existingBlock = latestBlocks.find((b: any) => b.building_id == buildingId && isImplicitBuildingBlock(b, building));
  if (existingBlock) return existingBlock.id;

  const res = await fetch('/api/blocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      block_id: `BLK-${buildingId}-MAIN`,
      name: building?.name || DIRECT_BUILDING_BLOCK_NAME,
      building_id: Number(buildingId),
      description: 'Direct floors for this building',
    }),
    credentials: 'include'
  });

  const data = await res.json();
  if (!res.ok) {
    const latestRes = await fetch('/api/blocks', { credentials: 'include' });
    const latestBlocks = latestRes.ok ? await latestRes.json() : [];
    const latestBlock = latestBlocks.find((block: any) =>
      block.building_id == buildingId && isImplicitBuildingBlock(block, building)
    );

    if (latestBlock) return latestBlock.id;
    throw new Error(data.error || 'Could not create direct building block');
  }

  return data.id;
};

function FloorManagement() {
  const [blocks, setBlocks] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const refreshBlocks = async () => {
    const res = await fetch('/api/blocks', { credentials: 'include' });
    const data = await res.json();
    setBlocks(Array.isArray(data) ? data : []);
  };
  const refreshBuildings = async () => {
    const res = await fetch('/api/buildings', { credentials: 'include' });
    const data = await res.json();
    setBuildings(Array.isArray(data) ? data : []);
  };
  useEffect(() => {
    refreshBlocks();
    refreshBuildings();
  }, []);

  const isBlockBasedBuilding = (building: any) =>
    building?.structure_type === 'blocks' || (Number(building?.planned_block_count) || 0) > 0;
  const isDirectFloorBuilding = (building: any) =>
    !!building && !isBlockBasedBuilding(building);
  const getFloorSequenceDescription = (description: unknown, floorNumber: number) => {
    const baseDescription = description?.toString().trim();
    return baseDescription ? `${getFloorName(floorNumber)} - ${baseDescription}` : getFloorName(floorNumber);
  };

  const fields = [
    { key: 'floor_id', label: 'Floor ID', show: (_formData: any, editingItem: any) => !!editingItem },
    {
      key: 'floor_id_prefix',
      label: 'Floor ID Prefix',
      formOnly: true,
      required: false,
      show: (_formData: any, editingItem: any) => !editingItem,
    },
    {
      key: 'building_id',
      label: 'Building',
      type: 'select',
      resetKeys: ['block_id'],
      options: buildings.map(b => ({ value: b.id, label: b.name })),
      render: (item: any) => {
        const block = blocks.find(b => idsMatch(b.id, item.block_id));
        const building = buildings.find(b => idsMatch(b.id, block?.building_id));
        return building?.name || 'Unknown';
      }
    },
    {
      key: 'block_id',
      label: 'Block / Direct Floors',
      type: 'select',
      options: (formData: any) => {
        const selectedBuildingId = formData.building_id ||
          blocks.find(b => idsMatch(b.id, formData.block_id))?.building_id;

        if (!selectedBuildingId) return [];

        const building = buildings.find(b => b.id == selectedBuildingId);
        const buildingBlocks = blocks.filter(b => b.building_id == selectedBuildingId);
        const visibleBlocks = buildingBlocks.filter(b => !isImplicitBuildingBlock(b, building));

        if (isBlockBasedBuilding(building)) {
          return visibleBlocks.map(b => ({ value: b.id, label: b.name }));
        }

        return [{ value: '__direct__', label: 'Direct floors' }];
      },
      render: (item: any) => {
        const block = blocks.find(b => idsMatch(b.id, item.block_id));
        const building = buildings.find(b => idsMatch(b.id, block?.building_id));
        return getBlockDisplayLabel(block, building);
      }
    },
    { key: 'floor_number', label: 'Floor Number', type: 'number', show: (_formData: any, editingItem: any) => !!editingItem },
    {
      key: 'floor_count',
      label: 'Number of Floors',
      type: 'number',
      formOnly: true,
      show: (_formData: any, editingItem: any) => !editingItem,
    },
    {
      key: 'first_floor_number',
      label: 'First Floor Number',
      type: 'number',
      formOnly: true,
      show: (_formData: any, editingItem: any) => !editingItem,
    },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const prepareSubmitData = async (data: any, editingItem: any) => {
    const payload = { ...data };
    const selectedBuildingId = payload.building_id || blocks.find(b => b.id === editingItem?.block_id)?.building_id;

    if (!selectedBuildingId) {
      throw new Error('Please select a building');
    }

    const selectedBuilding = buildings.find(b => b.id == selectedBuildingId);
    if (isBlockBasedBuilding(selectedBuilding) && (!payload.block_id || payload.block_id === '__direct__')) {
      throw new Error('Please select a block for this building. Direct floors are only for buildings marked as no blocks.');
    }

    if (!payload.block_id || payload.block_id === '__direct__') {
      payload.block_id = await ensureDirectBuildingBlock(selectedBuildingId, blocks, buildings);
    }

    if (editingItem) {
      if (!payload.floor_id?.toString().trim()) throw new Error('Floor ID is required.');
      if (!Number.isInteger(Number(payload.floor_number))) throw new Error('Floor number must be a whole number.');
      payload.floor_number = Number(payload.floor_number);
      delete payload.floor_id_prefix;
      delete payload.floor_count;
      delete payload.first_floor_number;
      delete payload.building_id;
      return payload;
    }

    const floorCount = Number(data.floor_count);
    const firstFloorNumber = data.first_floor_number === '' || data.first_floor_number == null
      ? 0
      : Number(data.first_floor_number);

    if (!Number.isInteger(floorCount) || floorCount < 1) {
      throw new Error('Please enter at least 1 floor.');
    }

    if (!Number.isInteger(firstFloorNumber)) {
      throw new Error('First floor number must be a whole number.');
    }

    const selectedBlock = blocks.find(block => block.id?.toString() === payload.block_id?.toString());
    const prefix = data.floor_id_prefix?.toString().trim() ||
      selectedBlock?.block_id ||
      selectedBuilding?.building_id;

    if (!prefix) {
      throw new Error('Could not determine a Floor ID prefix.');
    }

    payload.floor_id = getGeneratedFloorId(prefix, firstFloorNumber);
    payload.floor_number = firstFloorNumber;
    payload.description = getFloorSequenceDescription(data.description, firstFloorNumber);
    delete payload.floor_id_prefix;
    delete payload.floor_count;
    delete payload.first_floor_number;
    delete payload.building_id;
    return payload;
  };

  const afterSubmit = async (savedFloor: any, data: any, editingItem: any) => {
    if (editingItem) return;

    const floorCount = Number(data.floor_count);
    if (!Number.isInteger(floorCount) || floorCount <= 1) return;

    const firstFloorNumber = data.first_floor_number === '' || data.first_floor_number == null
      ? 0
      : Number(data.first_floor_number);
    const selectedBuilding = buildings.find(building => building.id?.toString() === data.building_id?.toString());
    const selectedBlock = blocks.find(block => block.id?.toString() === savedFloor.block_id?.toString());
    const prefix = data.floor_id_prefix?.toString().trim() ||
      selectedBlock?.block_id ||
      selectedBuilding?.building_id;

    if (!prefix) {
      throw new Error('Could not determine a Floor ID prefix for the remaining floors.');
    }

    for (let offset = 1; offset < floorCount; offset += 1) {
      const floorNumber = firstFloorNumber + offset;
      await upsertImportRecord('/api/floors', {
        floor_id: getGeneratedFloorId(prefix, floorNumber),
        block_id: savedFloor.block_id,
        floor_number: floorNumber,
        description: getFloorSequenceDescription(data.description, floorNumber),
      }, [['floor_id'], ['block_id', 'floor_number']]);
    }
  };

  const prepareFormData = (item: any) => {
    const block = blocks.find(b => idsMatch(b.id, item.block_id));
    const building = buildings.find(b => idsMatch(b.id, block?.building_id));

    return {
      ...item,
      building_id: block?.building_id || '',
      block_id: isImplicitBuildingBlock(block, building) ? '__direct__' : item.block_id,
      floor_count: 1,
      first_floor_number: item.floor_number ?? 0,
    };
  };

  const handleImport = async (data: any[]) => {
    let importedCount = 0;
    const skippedRows: string[] = [];

    for (const [index, row] of data.entries()) {
      const floorId = row['Floor ID']?.toString();
      const floorIdPrefix = getImportValue(row, ['Floor ID Prefix'])?.toString().trim();
      const building = findBuildingForImport(buildings, row, floorIdPrefix || floorId);
      const blockLabel = getImportValue(row, ['Block / Direct Floors', 'Block', 'Block ID']);
      const normalizedBlockLabel = normalizeLookupValue(blockLabel);
      const wantsDirectFloors = !normalizedBlockLabel ||
        normalizedBlockLabel === 'direct floors' ||
        normalizedBlockLabel === 'direct floors (no block)';
      const block = wantsDirectFloors ? undefined : blocks.find(b =>
        (!building || idsMatch(b.building_id, building.id)) &&
        (
          normalizeLookupValue(b.name) === normalizedBlockLabel ||
          normalizeLookupValue(b.block_id) === normalizedBlockLabel
        )
      );

      if (!building || (isBlockBasedBuilding(building) && !block) || (isDirectFloorBuilding(building) && block)) {
        skippedRows.push(`row ${index + 2}`);
        continue;
      }

      const blockId = block?.id || await ensureDirectBuildingBlock(building.id, blocks, buildings);
      const floorCountValue = getImportValue(row, ['Number of Floors', 'Floor Count']);
      const floorCount = floorCountValue == null ? 1 : Number(floorCountValue);
      const firstFloorNumberValue = getImportValue(row, ['First Floor Number', 'Floor Number']);
      const firstFloorNumber = firstFloorNumberValue == null ? 0 : Number(firstFloorNumberValue);
      const selectedBlock = blocks.find(item => item.id === blockId);
      const prefix = floorIdPrefix ||
        selectedBlock?.block_id ||
        building.building_id;

      if (!blockId || !Number.isInteger(floorCount) || floorCount < 1 || !Number.isInteger(firstFloorNumber) || (!prefix && !floorId)) {
        skippedRows.push(`row ${index + 2}`);
        continue;
      }

      for (let offset = 0; offset < floorCount; offset += 1) {
        const floorNumber = firstFloorNumber + offset;
        await upsertImportRecord('/api/floors', {
          floor_id: floorCount === 1 && floorId ? floorId : getGeneratedFloorId(prefix, floorNumber),
          block_id: blockId,
          floor_number: floorNumber,
          description: getFloorSequenceDescription(row['Description'], floorNumber),
        }, [['floor_id'], ['block_id', 'floor_number']]);
        importedCount += 1;
      }
    }

    if (importedCount === 0) {
      throw new Error(`No floors were imported. For block buildings, provide a valid block. For no-block buildings, use "Direct floors". Skipped ${skippedRows.join(', ') || 'all rows'}.`);
    }
  };

  return (
    <GenericCRUD
      type="Floor"
      fields={fields}
      apiPath="/api/floors"
      onImport={handleImport}
      prepareSubmitData={prepareSubmitData}
      afterSubmit={afterSubmit}
      prepareFormData={prepareFormData}
      onDataChanged={refreshBlocks}
    />
  );
}

function RoomManagement() {
  const [campuses, setCampuses] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomFilters, setRoomFilters] = useState({
    campus_id: '',
    building_id: '',
    block_id: '',
    floor_id: '',
  });

  const refreshRooms = async () => {
    const roomData = await fetch('/api/rooms').then(res => res.json());
    setRooms(Array.isArray(roomData) ? roomData : []);
  };

  useEffect(() => {
    fetch('/api/campuses').then(res => res.json()).then(setCampuses);
    fetch('/api/floors').then(res => res.json()).then(setFloors);
    fetch('/api/blocks').then(res => res.json()).then(setBlocks);
    fetch('/api/buildings').then(res => res.json()).then(setBuildings);
    refreshRooms();
  }, []);

  const getRoomLocation = (room: any) => {
    const floor = floors.find(item => idsMatch(item.id, room?.floor_id));
    const block = blocks.find(item => idsMatch(item.id, floor?.block_id));
    const building = buildings.find(item => idsMatch(item.id, block?.building_id));
    const campus = campuses.find(item => idsMatch(item.id, building?.campus_id));
    return { floor, block, building, campus };
  };

  const getRoomFilterBlockOptions = () => {
    const selectedBuilding = buildings.find(item => idsMatch(item.id, roomFilters.building_id));
    if (!selectedBuilding) return [];

    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, selectedBuilding.id));
    const visibleBlocks = buildingBlocks.filter(block => !isImplicitBuildingBlock(block, selectedBuilding));
    const directBlock = buildingBlocks.find(block => isImplicitBuildingBlock(block, selectedBuilding));
    const directHasFloors = directBlock && floors.some(floor => idsMatch(floor.block_id, directBlock.id));

    return [
      ...(directHasFloors ? [{ value: directBlock.id, label: 'Direct floors' }] : []),
      ...visibleBlocks.map(block => ({ value: block.id, label: block.name })),
    ];
  };

  const getRoomFilterFloorOptions = () => {
    if (!roomFilters.building_id) return [];
    const selectedBuilding = buildings.find(item => idsMatch(item.id, roomFilters.building_id));
    if (!selectedBuilding) return [];

    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, selectedBuilding.id));
    const allowedBlockIds = roomFilters.block_id
      ? [roomFilters.block_id]
      : buildingBlocks.map(block => block.id);

    return floors
      .filter(floor => allowedBlockIds.some(blockId => idsMatch(blockId, floor.block_id)))
      .sort((a, b) => Number(a.floor_number || 0) - Number(b.floor_number || 0))
      .map(floor => ({ value: floor.id, label: getFloorDisplayLabel(floor, blocks, buildings) }));
  };

  const roomMatchesLocationFilters = (room: any) => {
    const { floor, block, building } = getRoomLocation(room);
    if (roomFilters.campus_id && !idsMatch(building?.campus_id, roomFilters.campus_id)) return false;
    if (roomFilters.building_id && !idsMatch(building?.id, roomFilters.building_id)) return false;
    if (roomFilters.block_id && !idsMatch(block?.id, roomFilters.block_id)) return false;
    if (roomFilters.floor_id && !idsMatch(floor?.id, roomFilters.floor_id)) return false;
    return true;
  };

  const roomFilterBuildings = buildings
    .filter(building => !roomFilters.campus_id || idsMatch(building.campus_id, roomFilters.campus_id))
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);
  const roomFilterBlockOptions = getRoomFilterBlockOptions();
  const roomFilterFloorOptions = getRoomFilterFloorOptions();
  const hasActiveRoomFilters = Object.values(roomFilters).some(Boolean);
  const roomFilterControls = (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Campus</label>
        <select
          value={roomFilters.campus_id}
          onChange={(event) => setRoomFilters({
            campus_id: event.target.value,
            building_id: '',
            block_id: '',
            floor_id: '',
          })}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All campuses</option>
          {campuses
            .slice()
            .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
            .map(campus => (
              <option key={campus.id} value={campus.id}>{campus.name}</option>
            ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Building</label>
        <select
          value={roomFilters.building_id}
          onChange={(event) => setRoomFilters(prev => ({
            ...prev,
            building_id: event.target.value,
            block_id: '',
            floor_id: '',
          }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All buildings</option>
          {roomFilterBuildings.map(building => (
            <option key={building.id} value={building.id}>{building.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Block / Direct Floors</label>
        <select
          value={roomFilters.block_id}
          onChange={(event) => setRoomFilters(prev => ({
            ...prev,
            block_id: event.target.value,
            floor_id: '',
          }))}
          disabled={!roomFilters.building_id}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 disabled:text-slate-400"
        >
          <option value="">All blocks/direct floors</option>
          {roomFilterBlockOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Floor</label>
        <select
          value={roomFilters.floor_id}
          onChange={(event) => setRoomFilters(prev => ({ ...prev, floor_id: event.target.value }))}
          disabled={!roomFilters.building_id}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 disabled:text-slate-400"
        >
          <option value="">All floors</option>
          {roomFilterFloorOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={() => setRoomFilters({ campus_id: '', building_id: '', block_id: '', floor_id: '' })}
        disabled={!hasActiveRoomFilters}
        className="px-4 py-2 border border-slate-200 rounded-xl text-slate-700 font-semibold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Clear Filters
      </button>
    </div>
  );

  const normalizeRoomFormPayload = (data: any, roomPool = rooms) => {
    const roomType = normalizeRoomTypeValue(data.room_type);
    const parentRoomId = data.parent_room_id ? Number(data.parent_room_id) : null;
    const roomLayout = normalizeRoomLayoutValue(data.room_layout);
    const isChildLayout = HIERARCHY_CHILD_ROOM_LAYOUTS.includes(roomLayout);
    const parentRoomName = data.room_name?.toString().trim() || '';
    const parentLabName = data.lab_name?.toString().trim() || '';
    const childLabName = data.sub_lab_name?.toString().trim() || '';
    const effectiveLabName = (isChildLayout ? (childLabName || parentLabName) : (parentLabName || childLabName));
    const effectiveRoomName = isChildLayout ? '' : (parentRoomName || effectiveLabName || data.room_section_name?.toString().trim() || '');
    const isInfrastructureSpace = isNonCapacityRoomType(roomType);
    const requiresCapacity = isCapacityRoomType(roomType);
    const payload = {
      ...data,
      room_name: effectiveRoomName,
      room_aliases: normalizeRoomAliases(data.room_aliases),
      room_type: roomType,
      lab_name: effectiveLabName || data.room_section_name?.toString().trim() || '',
      restroom_type: normalizeRestroomTypeValue(data.restroom_type),
      parent_room_id: parentRoomId,
      room_layout: roomLayout,
      sub_room_count: data.sub_room_count === '' || data.sub_room_count == null ? null : Math.max(0, parseInt(data.sub_room_count, 10) || 0),
      room_section_name: data.room_section_name?.toString().trim() || '',
      usage_category: normalizeUsageCategoryValue(data.usage_category, roomType),
      is_bookable: isInfrastructureSpace ? 0 : normalizeBooleanLikeValue(data.is_bookable, true) ? 1 : 0,
      capacity: requiresCapacity ? parseInt(data.capacity, 10) || 0 : 0,
    };
    delete payload.sub_lab_name;

    if (!HIERARCHY_ROOM_LAYOUTS.includes(payload.room_layout)) {
      payload.parent_room_id = null;
      payload.sub_room_count = null;
      payload.room_section_name = '';
    } else if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(payload.room_layout)) {
      payload.parent_room_id = null;
    } else if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(payload.room_layout)) {
      payload.room_name = '';
      payload.sub_room_count = null;
    }

    if (parentRoomId && data.id && parentRoomId.toString() === data.id.toString()) {
      throw new Error('A room cannot be inside itself.');
    }

    const parentRoom = parentRoomId ? roomPool.find(room => room.id?.toString() === parentRoomId.toString()) : null;
    if (parentRoomId && !parentRoom) {
      throw new Error('Please select a valid parent room.');
    }

    if (parentRoom && payload.floor_id && parentRoom.floor_id?.toString() !== payload.floor_id?.toString()) {
      throw new Error('The parent room must be on the same floor.');
    }

    if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(payload.room_layout) && !payload.parent_room_id) {
      throw new Error('Please select a parent room for split child or inside child rooms.');
    }

    if (payload.parent_room_id && !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(payload.room_layout)) {
      payload.room_layout = payload.room_layout === 'Split Parent' ? 'Split Child' : 'Inside Child';
    }

    if (HIERARCHY_ROOM_LAYOUTS.includes(payload.room_layout) && !payload.room_section_name) {
      throw new Error('Please enter the sub room name for split or inside room layouts.');
    }

    if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(payload.room_layout) && (!payload.sub_room_count || payload.sub_room_count <= 0)) {
      throw new Error('Please enter the sub room count for split parent or inside parent rooms.');
    }

    if (roomType === 'Lab') {
      if (!payload.lab_name) {
        throw new Error(isChildLayout ? 'Please enter the sub lab name for this child lab room.' : 'Please enter the lab name.');
      }
      payload.restroom_type = '';
    } else if (roomType === 'Restroom') {
      if (!RESTROOM_TYPE_OPTIONS.includes(payload.restroom_type)) {
        throw new Error('Please select Male or Female for the restroom.');
      }
      payload.lab_name = '';
    } else {
      payload.lab_name = '';
      payload.restroom_type = '';
    }

    if (requiresCapacity && payload.capacity <= 0) {
      throw new Error('Please enter the capacity for classroom and lab room types.');
    }

    return payload;
  };

  const fields = [
    { key: 'room_id', label: 'Room ID' },
    {
      key: 'room_number',
      label: 'Room Number',
      render: (item: any) => getRoomDisplayLabel(item, rooms),
    },
    {
      key: 'room_name',
      label: 'Room Name',
      required: false,
      show: (formData: any) => !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)),
      render: (item: any) => getRoomNameDisplay(item) || '-',
    },
    {
      key: 'room_aliases',
      label: 'Room Aliases',
      required: false,
      render: (item: any) => getRoomAliasList(item).join(', ') || '-',
    },
    {
      key: 'building_id',
      label: 'Building',
      type: 'select',
      resetKeys: ['block_id', 'floor_id', 'parent_room_id'],
      options: buildings.map(b => ({ value: b.id, label: b.name })),
      render: (item: any) => {
        const floor = floors.find(f => idsMatch(f.id, item?.floor_id));
        const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
        const building = buildings.find(b => idsMatch(b.id, block?.building_id));
        return building?.name || 'Unknown';
      },
    },
    {
      key: 'block_id',
      label: 'Block / Direct Floors',
      type: 'select',
      resetKeys: ['floor_id', 'parent_room_id'],
      show: (formData: any) => {
        const building = buildings.find(b => b.id == formData.building_id);
        if (!building) return false;
        const buildingBlocks = blocks.filter(b => b.building_id == building.id);
        return buildingBlocks.filter(b => !isImplicitBuildingBlock(b, building)).length > 0;
      },
      options: (formData: any) => {
        const building = buildings.find(b => b.id == formData.building_id);
        if (!building) return [];

        const buildingBlocks = blocks.filter(b => b.building_id == building.id);
        const visibleBlocks = buildingBlocks.filter(b => !isImplicitBuildingBlock(b, building));
        const directBlock = buildingBlocks.find(b => isImplicitBuildingBlock(b, building));
        const directHasFloors = directBlock && floors.some(f => f.block_id === directBlock.id);

        return [
          ...(directHasFloors ? [{ value: directBlock.id, label: 'Direct floors' }] : []),
          ...visibleBlocks.map(b => ({ value: b.id, label: b.name })),
        ];
      },
      render: (item: any) => {
        const floor = floors.find(f => idsMatch(f.id, item?.floor_id));
        const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
        const building = buildings.find(b => idsMatch(b.id, block?.building_id));
        return getBlockDisplayLabel(block, building);
      },
    },
    { 
      key: 'floor_id', 
      label: 'Floor', 
      type: 'select', 
      resetKeys: ['parent_room_id'],
      options: (formData: any) => {
        if (!formData.building_id) return [];

        const building = buildings.find(b => b.id == formData.building_id);
        const buildingBlocks = blocks.filter(b => b.building_id == formData.building_id);
        const visibleBlocks = building ? buildingBlocks.filter(b => !isImplicitBuildingBlock(b, building)) : [];
        const directBlock = building ? buildingBlocks.find(b => isImplicitBuildingBlock(b, building)) : null;

        const allowedBlockIds = formData.block_id
          ? [Number(formData.block_id)]
          : visibleBlocks.length > 0
            ? []
            : directBlock
              ? [directBlock.id]
              : buildingBlocks.map(b => b.id);

        return floors
          .filter(f => allowedBlockIds.some(blockId => idsMatch(blockId, f.block_id)))
          .map(f => ({ value: f.id, label: getFloorDisplayLabel(f, blocks, buildings) }));
      },
      render: (item: any) => {
        const floor = floors.find(f => idsMatch(f.id, item?.floor_id));
        return floor ? getFloorDisplayLabel(floor, blocks, buildings) : 'Unknown Floor';
      },
    },
    {
      key: 'room_layout',
      label: 'Room Layout',
      type: 'select',
      options: ROOM_LAYOUT_OPTIONS,
      onChange: (nextData: any, value: string) => {
        if (!HIERARCHY_ROOM_LAYOUTS.includes(value)) {
          return { ...nextData, parent_room_id: '', sub_room_count: '', room_section_name: '', sub_lab_name: '' };
        }
        if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(value)) {
          return { ...nextData, parent_room_id: '', sub_lab_name: '' };
        }
        return { ...nextData, room_name: '', sub_room_count: '' };
      },
    },
    {
      key: 'sub_room_count',
      label: 'Sub Room Count',
      type: 'number',
      required: false,
      show: (formData: any) => HIERARCHY_PARENT_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)),
    },
    {
      key: 'room_type',
      label: 'Room Type',
      formLabel: (formData: any) =>
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)) ? 'Sub Room Type' : 'Room Type',
      type: 'select',
      options: ROOM_TYPE_OPTIONS,
      onChange: (nextData: any, value: string) => ({
        ...nextData,
        usage_category: normalizeUsageCategoryValue('', value),
        lab_name: normalizeRoomTypeValue(value) === 'Lab' ? nextData.lab_name : '',
        sub_lab_name: normalizeRoomTypeValue(value) === 'Lab' ? nextData.sub_lab_name : '',
        restroom_type: normalizeRoomTypeValue(value) === 'Restroom' ? nextData.restroom_type : '',
        is_bookable: isNonCapacityRoomType(value) ? '0' : nextData.is_bookable,
        capacity: isCapacityRoomType(value) ? nextData.capacity : '',
      }),
      render: (item: any) => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item.room_layout))
        ? '-'
        : getBaseRoomTypeDisplay(item),
    },
    {
      key: 'sub_room_type',
      label: 'Sub Room Type',
      tableOnly: true,
      render: (item: any) => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item.room_layout))
        ? getBaseRoomTypeDisplay(item)
        : '-',
    },
    {
      key: 'room_section_name',
      label: 'Sub Room Name',
      required: false,
      show: (formData: any) => HIERARCHY_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)),
      render: (item: any) => item.room_section_name || '-',
    },
    {
      key: 'parent_room_id',
      label: 'Inside / Parent Room',
      type: 'select',
      required: false,
      show: (formData: any) => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)),
      options: (formData: any) => rooms
        .filter(room => {
          if (formData.id && room.id?.toString() === formData.id?.toString()) return false;
          if (formData.floor_id && room.floor_id?.toString() !== formData.floor_id?.toString()) return false;
          return true;
        })
        .map(room => ({ value: room.id, label: getRoomDisplayLabel(room, rooms) })),
      render: (item: any) => {
        const parent = rooms.find(room => room.id?.toString() === item?.parent_room_id?.toString());
        return parent ? getRoomDisplayLabel(parent, rooms) : '-';
      },
    },
    {
      key: 'usage_category',
      label: 'Usage Category',
      type: 'select',
      required: false,
      options: USAGE_CATEGORY_OPTIONS,
      render: (item: any) => item.usage_category || normalizeUsageCategoryValue('', item.room_type) || '-',
    },
    {
      key: 'is_bookable',
      label: 'Is Bookable',
      type: 'select',
      required: false,
      show: (formData: any) => !isNonCapacityRoomType(formData.room_type),
      options: [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }],
      render: (item: any) => isRoomBookable(item) ? 'Yes' : 'No',
    },
    {
      key: 'lab_name',
      label: 'Lab Name',
      formLabel: (formData: any) =>
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(formData.room_layout)) ? 'Sub Lab Name' : 'Lab Name',
      required: false,
      show: (formData: any) => normalizeRoomTypeValue(formData.room_type) === 'Lab',
      render: (item: any) => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item.room_layout)) ? '-' : (item.lab_name || '-'),
    },
    {
      key: 'sub_lab_name',
      label: 'Sub Lab Name',
      tableOnly: true,
      render: (item: any) => (
        normalizeRoomTypeValue(item.room_type) === 'Lab' &&
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item.room_layout))
      ) ? (item.lab_name || '-') : '-',
    },
    {
      key: 'restroom_type',
      label: 'Restroom For',
      type: 'select',
      formOnly: true,
      required: false,
      options: RESTROOM_TYPE_OPTIONS,
      show: (formData: any) => normalizeRoomTypeValue(formData.room_type) === 'Restroom',
    },
    {
      key: 'capacity',
      label: 'Capacity',
      type: 'number',
      required: false,
      show: (formData: any) => isCapacityRoomType(formData.room_type),
      render: (item: any) => isCapacityRoomType(item.room_type) ? item.capacity : '-',
    },
    { key: 'status', label: 'Status', type: 'select', options: ['Available', 'Maintenance'] },
  ];

  const prepareFormData = (item: any) => {
    const floor = floors.find(f => idsMatch(f.id, item?.floor_id));
    const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
    const isChildLayout = HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item?.room_layout));
    const normalizedRoomType = normalizeRoomTypeValue(item?.room_type || item?.sub_room_type);
    const normalizedRestroomType = normalizeRestroomTypeValue(item?.restroom_type);
    const childLabName = isChildLayout ? (item?.sub_lab_name || item?.lab_name || '') : '';

    return {
      ...item,
      building_id: block?.building_id || '',
      block_id: block?.id || '',
      is_bookable: normalizeBooleanLikeValue(item?.is_bookable, true) ? '1' : '0',
      room_name: isChildLayout ? '' : getRoomNameDisplay(item),
      room_aliases: item?.room_aliases || '',
      parent_room_id: item?.parent_room_id || '',
      room_layout: normalizeRoomLayoutValue(item?.room_layout),
      room_type: normalizedRoomType,
      restroom_type: normalizedRestroomType,
      sub_room_count: item?.sub_room_count ?? '',
      lab_name: isChildLayout ? childLabName : (item?.lab_name || ''),
      sub_lab_name: childLabName,
      usage_category: normalizeUsageCategoryValue(item?.usage_category, normalizedRoomType),
      status: item?.status || 'Available',
    };
  };

  const prepareSubmitData = (data: any) => {
    const payload = normalizeRoomFormPayload(data);
    delete payload.building_id;
    delete payload.block_id;
    return payload;
  };

  const handleImport = async (data: any[]) => {
    const knownRooms = [...rooms];
    const getRowRoomLabels = (row: any) => [
      row['Room Number'],
      row['Room ID'],
    ].map(normalizeLookupValue).filter(Boolean);
    const getRowParentLabel = (row: any) => normalizeOptionalImportLookupValue(getImportValue(row, ['Parent Room', 'Inside / Parent Room']));
    const getRowSubRoomName = (row: any) => normalizeOptionalImportValue(getImportValue(row, ['Sub Room Name', 'Room Section Name', 'Section Name']));
    const getRowSubRoomCount = (row: any) => parseInt(getImportValue(row, ['Sub Room Count', 'Number of Splits', 'Number of Rooms Inside'])?.toString() || '0', 10) || 0;
    const getAuditRowKey = (row: any) => `${row.__sheetName || 'Template'}:${row.__rowNumber || 0}:${row['Room ID'] || ''}:${row['Room Number'] || ''}`;
    const getAuditRoomLabel = (row: any) => row['Room Number'] || row['Room ID'] || 'Unnamed room';
    const auditHeaders = ['Sheet', 'Row Number', 'Room ID', 'Room Number', 'Status', 'Action', 'Reason'];
    const auditRows: ImportAuditRow[] = [];
    const summary = {
      totalRowsRead: data.length,
      validRows: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    };
    const rowFailures = new Map<string, string[]>();
    const addRowFailure = (row: any, reason: string) => {
      const key = getAuditRowKey(row);
      const existing = rowFailures.get(key) || [];
      if (!existing.includes(reason)) {
        existing.push(reason);
        rowFailures.set(key, existing);
      }
    };
    const pushAudit = (row: any, status: 'Created' | 'Updated' | 'Skipped' | 'Failed', action: string, reason: string) => {
      auditRows.push({
        Sheet: row.__sheetName || 'Template',
        'Row Number': row.__rowNumber || '',
        'Room ID': row['Room ID']?.toString() || '',
        'Room Number': row['Room Number']?.toString() || '',
        Status: status,
        Action: action,
        Reason: reason,
      });
      if (status === 'Created') summary.created += 1;
      if (status === 'Updated') summary.updated += 1;
      if (status === 'Skipped') summary.skipped += 1;
      if (status === 'Failed') summary.failed += 1;
    };

    const parentRows = data.filter(row => HIERARCHY_PARENT_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout']))));
    const childRows = data.filter(row => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout']))));

    for (const row of data) {
      const layout = normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout']));
      const roomLabel = getAuditRoomLabel(row);

      if (HIERARCHY_ROOM_LAYOUTS.includes(layout) && !getRowSubRoomName(row)) {
        addRowFailure(row, `Room "${roomLabel}" uses ${layout}, so Sub Room Name is required.`);
      }

      if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(layout) && getRowSubRoomCount(row) <= 0) {
        addRowFailure(row, `Room "${roomLabel}" is a ${layout}, so Sub Room Count must be greater than zero.`);
      }

      if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(layout) && !getRowParentLabel(row)) {
        addRowFailure(row, `Room "${roomLabel}" is a ${layout}, so Parent Room is required.`);
      }
    }

    for (const parentRow of parentRows) {
      const parentLayout = normalizeRoomLayoutValue(getImportValue(parentRow, ['Room Layout', 'Layout']));
      const expectedChildLayout = parentLayout === 'Split Parent' ? 'Split Child' : 'Inside Child';
      const expectedCount = getRowSubRoomCount(parentRow);
      const parentLabels = getRowRoomLabels(parentRow);
      const parentLabel = getAuditRoomLabel(parentRow);
      const matchingChildren = childRows.filter(row =>
        parentLabels.includes(getRowParentLabel(row)) &&
        normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout'])) === expectedChildLayout
      );

      if (matchingChildren.length !== expectedCount) {
        addRowFailure(parentRow, `Room "${parentLabel}" has Sub Room Count ${expectedCount}, but ${matchingChildren.length} ${expectedChildLayout.toLowerCase()} row(s) were found in the import file.`);
      }
    }

    for (const childRow of childRows) {
      const childLayout = normalizeRoomLayoutValue(getImportValue(childRow, ['Room Layout', 'Layout']));
      const parentLabel = getRowParentLabel(childRow);
      const importedParent = parentRows.find(row => getRowRoomLabels(row).includes(parentLabel));
      if (!importedParent) continue;

      const expectedChildLayout = normalizeRoomLayoutValue(getImportValue(importedParent, ['Room Layout', 'Layout'])) === 'Split Parent'
        ? 'Split Child'
        : 'Inside Child';
      const childLabel = getAuditRoomLabel(childRow);
      if (childLayout !== expectedChildLayout) {
        addRowFailure(childRow, `Room "${childLabel}" should use ${expectedChildLayout} because its parent uses ${normalizeRoomLayoutValue(getImportValue(importedParent, ['Room Layout', 'Layout']))}.`);
      }
    }

    const layoutPriority = (row: any) => {
      const layout = normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout']));
      if (HIERARCHY_PARENT_ROOM_LAYOUTS.includes(layout)) return 0;
      if (HIERARCHY_CHILD_ROOM_LAYOUTS.includes(layout)) return 2;
      return 1;
    };
    const sortedRows = [...data].sort((left, right) => layoutPriority(left) - layoutPriority(right));

    for (const row of sortedRows) {
      const existingFailures = rowFailures.get(getAuditRowKey(row));
      if (existingFailures?.length) {
        pushAudit(row, 'Failed', 'Validation', existingFailures.join(' '));
        continue;
      }

      try {
        const building = buildings.find(b => normalizeLookupValue(b.name) === normalizeLookupValue(getImportValue(row, ['Building'])));
        const blockLabel = getImportValue(row, ['Block / Direct Floors', 'Block']);
        const normalizedBlockLabel = normalizeLookupValue(blockLabel);
        const block = blocks.find(b =>
          (!building || idsMatch(b.building_id, building.id)) &&
          (
            normalizeLookupValue(b.name) === normalizedBlockLabel ||
            ((normalizedBlockLabel === 'direct floors' || normalizedBlockLabel === 'direct floors (no block)' || !normalizedBlockLabel) && isImplicitBuildingBlock(b, building))
          )
        );
        const floorValue = getImportValue(row, ['Floor', 'Floor ID']);
        const floor = floors.find(f =>
          (!block || f.block_id === block.id) &&
          (
            f.id?.toString() === floorValue?.toString() ||
            f.floor_number?.toString() === floorValue?.toString() ||
            normalizeLookupValue(getFloorName(f.floor_number)) === normalizeLookupValue(floorValue) ||
            normalizeLookupValue(getFloorDisplayLabel(f, blocks, buildings)) === normalizeLookupValue(floorValue)
          )
        );
        const parentRoomValue = normalizeOptionalImportValue(getImportValue(row, ['Parent Room', 'Inside / Parent Room']));
        const parentRoom = parentRoomValue ? findRoomByImportLabel(knownRooms, parentRoomValue) : null;

        if (parentRoomValue && !parentRoom) {
          pushAudit(row, 'Failed', 'Parent lookup', `Parent room "${parentRoomValue}" was not found. Add the parent room first or check the room number.`);
          continue;
        }

        const roomLayoutValue = normalizeRoomLayoutValue(getImportValue(row, ['Room Layout', 'Layout']));
        const isChildRoomLayout = HIERARCHY_CHILD_ROOM_LAYOUTS.includes(roomLayoutValue);
        const importedRoomType = isChildRoomLayout
          ? getImportValue(row, ['Sub Room Type', 'Room Type'])
          : getImportValue(row, ['Room Type', 'Sub Room Type']);

        const payload = {
          room_id: row['Room ID']?.toString(),
          room_number: row['Room Number']?.toString(),
          room_name: normalizeOptionalImportValue(getImportValue(row, ['Room Name'])),
          room_aliases: normalizeRoomAliases(getImportValue(row, ['Room Aliases', 'Aliases', 'Alternate Room Numbers'])),
          floor_id: floor?.id ?? parseInt(floorValue as any),
          room_type: normalizeRoomTypeValue(importedRoomType),
          room_layout: roomLayoutValue,
          parent_room_id: parentRoom?.id || null,
          sub_room_count: getImportValue(row, ['Sub Room Count', 'Number of Splits', 'Number of Rooms Inside']),
          room_section_name: normalizeOptionalImportValue(getImportValue(row, ['Sub Room Name', 'Room Section Name', 'Section Name'])) || '',
          usage_category: normalizeUsageCategoryValue(getImportValue(row, ['Usage Category', 'Usage']), importedRoomType),
          is_bookable: isNonCapacityRoomType(importedRoomType) ? 0 : normalizeBooleanLikeValue(getImportValue(row, ['Is Bookable', 'Bookable']), true) ? 1 : 0,
          lab_name: normalizeOptionalImportValue(getImportValue(row, ['Lab Name'])),
          sub_lab_name: normalizeOptionalImportValue(getImportValue(row, ['Sub Lab Name'])),
          restroom_type: normalizeRestroomTypeValue(getImportValue(row, ['Restroom For', 'Restroom Type'])),
          capacity: isCapacityRoomType(importedRoomType) ? parseInt(row['Capacity']) || 0 : 0,
          status: row['Status'] || 'Available'
        };

        if (!payload.room_id || !payload.room_number) {
          pushAudit(row, 'Skipped', 'Missing primary fields', 'Room ID and Room Number are required for import.');
          continue;
        }

        if (!payload.floor_id || Number.isNaN(Number(payload.floor_id))) {
          pushAudit(row, 'Skipped', 'Missing floor match', `No floor match was found for "${floorValue || '-'}".`);
          continue;
        }

        if (
          parentRoom &&
          (
            parentRoom.room_id?.toString() === payload.room_id ||
            parentRoom.room_number?.toString() === payload.room_number
          )
        ) {
          pushAudit(row, 'Failed', 'Parent validation', `Room "${payload.room_number}" cannot use itself as the parent room.`);
          continue;
        }

        const normalizedPayload = normalizeRoomFormPayload(payload, knownRooms);
        const savedRoom: any = await upsertImportRecord('/api/rooms', normalizedPayload, [['room_id'], ['room_number']]);
        const existingIndex = knownRooms.findIndex(room => room.id?.toString() === savedRoom.id?.toString());
        if (existingIndex >= 0) {
          knownRooms[existingIndex] = savedRoom;
        } else {
          knownRooms.push(savedRoom);
        }
        pushAudit(
          row,
          savedRoom.__importAction === 'updated' ? 'Updated' : 'Created',
          savedRoom.__importAction === 'updated' ? 'Updated existing record' : 'Created new record',
          savedRoom.__importAction === 'updated'
            ? 'Matched an existing room by Room ID or Room Number and updated it.'
            : 'Inserted a new room record.'
        );
      } catch (err: any) {
        pushAudit(row, 'Failed', 'Import failed', err?.message || 'Unexpected import error.');
      }
    }

    summary.validRows = summary.totalRowsRead - summary.failed;
    return {
      message: `Room import completed. Created ${summary.created}, updated ${summary.updated}, skipped ${summary.skipped}, failed ${summary.failed}.`,
      auditRows,
      auditHeaders,
      auditTitle: 'Room Import Audit',
      summary,
    };
  };

  const buildRoomExportData = (items: any[]) => {
    const headers = IMPORT_TEMPLATE_CONFIG.Room?.headers || fields.map(field => field.label);
    const toCellValue = (value: unknown) => {
      const normalized = normalizeOptionalImportValue(value);
      return normalized || '-';
    };

    const rows = [...items].sort((left, right) => compareRoomsByNaturalOrder(left, right, rooms)).map(item => {
      const floor = floors.find(f => idsMatch(f.id, item?.floor_id));
      const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
      const building = buildings.find(b => idsMatch(b.id, block?.building_id));
      const isChildRoom = HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(item?.room_layout));
      const parentRoom = item?.parent_room_id ? rooms.find(room => idsMatch(room.id, item.parent_room_id)) : null;
      const roomType = normalizeRoomTypeValue(item?.room_type);
      const roomLayout = normalizeRoomLayoutValue(item?.room_layout);
      const labName = normalizeOptionalImportValue(item?.lab_name);
      const usageCategory = normalizeUsageCategoryValue(item?.usage_category, roomType);
      const restroomType = normalizeRestroomTypeValue(item?.restroom_type);

      const rowMap: Record<string, any> = {
        'Room ID': item?.room_id || '',
        'Room Number': item?.room_number || '',
        'Room Name': !isChildRoom ? toCellValue(getRoomNameDisplay(item)) : '-',
        'Room Aliases': toCellValue(normalizeRoomAliases(item?.room_aliases)),
        'Building': building?.name || '',
        'Block / Direct Floors': block ? getBlockDisplayLabel(block, building) : '',
        'Floor': floor ? getFloorDisplayLabel(floor, blocks, buildings) : '',
        'Room Layout': roomLayout || '',
        'Sub Room Count': HIERARCHY_PARENT_ROOM_LAYOUTS.includes(roomLayout) ? (item?.sub_room_count ?? '') : '',
        'Room Type': isChildRoom ? '-' : (roomType || ''),
        'Sub Room Type': isChildRoom ? (roomType || '-') : '-',
        'Sub Room Name': toCellValue(item?.room_section_name),
        'Inside / Parent Room': toCellValue(parentRoom?.room_number),
        'Usage Category': usageCategory || '',
        'Is Bookable': normalizeBooleanLikeValue(item?.is_bookable, true) ? 'Yes' : 'No',
        'Lab Name': roomType === 'Lab' && !isChildRoom ? toCellValue(labName) : '-',
        'Sub Lab Name': roomType === 'Lab' && isChildRoom ? toCellValue(labName) : '-',
        'Capacity': isCapacityRoomType(roomType) ? (item?.capacity ?? 0) : '-',
        'Status': item?.status || 'Available',
      };

      if (roomType === 'Restroom') {
        rowMap['Lab Name'] = '-';
        rowMap['Sub Lab Name'] = '-';
        rowMap['Restroom For'] = restroomType || '-';
      }

      return headers.map(header => rowMap[header] ?? '');
    });

    return { headers, rows };
  };

  return (
    <GenericCRUD
      type="Room"
      fields={fields}
      apiPath="/api/rooms"
      onImport={handleImport}
      exportBuilder={buildRoomExportData}
      prepareSubmitData={prepareSubmitData}
      prepareFormData={prepareFormData}
      onDataChanged={refreshRooms}
      dataFilter={roomMatchesLocationFilters}
      dataSorter={(left, right) => compareRoomsByNaturalOrder(left, right, rooms)}
      filterControls={roomFilterControls}
    />
  );
}

function SchoolManagement() {
  const fields = [
    { key: 'school_id', label: 'School ID' },
    { key: 'name', label: 'School Name' },
    { key: 'type', label: 'Type', type: 'select', options: SCHOOL_TYPE_OPTIONS },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const payload = {
        school_id: row['School ID']?.toString(),
        name: row['School Name'],
        type: normalizeSchoolTypeValue(row['Type']),
        description: row['Description']
      };
      if (!payload.school_id || !payload.name) continue;
      await upsertImportRecord('/api/schools', payload, [['school_id'], ['name']]);
    }
  };

  return <GenericCRUD type="School" fields={fields} apiPath="/api/schools" onImport={handleImport} />;
}

function DepartmentManagement() {
  const [schools, setSchools] = useState<any[]>([]);
  useEffect(() => {
    fetch('/api/schools').then(res => res.json()).then(setSchools);
  }, []);

  const schoolOptions = schools
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
    .map(school => ({ value: school.id, label: school.name }));

  const fields = [
    { key: 'department_id', label: 'Department ID' },
    { key: 'name', label: 'Department Name' },
    { key: 'school_id', label: 'School', type: 'select', resetKeys: ['department_id'], options: schoolOptions },
    { key: 'type', label: 'Type', type: 'select', options: ['Academic', 'Research', 'Administrative', 'Support'] },
    { key: 'description', label: 'Description', fullWidth: true },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const school = schools.find(s =>
        normalizeLookupValue(s.name) === normalizeLookupValue(row['School']) ||
        normalizeLookupValue(s.school_id) === normalizeLookupValue(row['School'])
      );
      const payload = {
        department_id: row['Department ID']?.toString(),
        name: row['Department Name'],
        school_id: school?.id,
        type: row['Type'],
        description: row['Description']
      };
      if (!payload.department_id || !payload.name || !payload.school_id) continue;
      await upsertImportRecord('/api/departments', payload, [['department_id'], ['school_id', 'name']]);
    }
  };

  return <GenericCRUD type="Department" fields={fields} apiPath="/api/departments" onImport={handleImport} />;
}

function TimingProfileManagement() {
  const [schools, setSchools] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);

  const refreshLookups = async () => {
    const [schoolData, departmentData] = await Promise.all([
      fetch('/api/schools', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/departments', { credentials: 'include' }).then(res => res.json()),
    ]);
    setSchools(Array.isArray(schoolData) ? schoolData : []);
    setDepartments(Array.isArray(departmentData) ? departmentData : []);
  };

  useEffect(() => {
    refreshLookups();
  }, []);

  const schoolOptions = schools
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
    .map(school => ({ value: school.id, label: school.name }));

  const sortedDepartments = departments
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);

  const fields = [
    { key: 'profile_id', label: 'Profile ID' },
    { key: 'profile_name', label: 'Profile Name' },
    { key: 'school_id', label: 'School', type: 'select', required: false, resetKeys: ['department_id'], options: schoolOptions, render: (item: any) => schools.find(school => idsMatch(school.id, item.school_id))?.name || '-' },
    {
      key: 'department_id',
      label: 'Department',
      type: 'select',
      required: false,
      options: (formData: any) => sortedDepartments
        .filter(department => !formData.school_id || idsMatch(department.school_id, formData.school_id))
        .map(department => ({ value: department.id, label: department.name })),
      render: (item: any) => departments.find(department => idsMatch(department.id, item.department_id))?.name || '-',
    },
    { key: 'program', label: 'Program', type: 'select', required: false, options: PROGRAM_OPTIONS },
    { key: 'academic_year', label: 'Academic Year', required: false },
    {
      key: 'year_of_study',
      label: 'Year / Semester',
      type: 'select',
      required: false,
      resetKeys: ['semester'],
      options: (formData: any) => getYearOfStudyOptions(formData.program, formData.semester),
      render: (item: any) => getStudyPeriodDisplay(item.year_of_study, item.semester, item.program) || '-',
    },
    {
      key: 'semester',
      label: 'Semester',
      type: 'select',
      required: false,
      options: (formData: any) => getScheduleSemesterOptions(formData.year_of_study),
      render: (item: any) => normalizeExactSemesterValue(item.semester, item.year_of_study, item.semester || '-') || '-',
    },
    { key: 'section', label: 'Section', required: false },
    { key: 'working_days', label: 'Working Days', required: false, fullWidth: true, formLabel: 'Working Days (comma separated)', render: (item: any) => item.working_days || '-' },
    { key: 'slot_pattern', label: 'Slot Timings', fullWidth: true, formLabel: 'Slot Timings (HH:mm-HH:mm)', render: (item: any) => item.slot_pattern || '-' },
    { key: 'notes', label: 'Notes', required: false, fullWidth: true },
  ];

  const prepareSubmitData = (data: any) => {
    const nextSchoolId = data.school_id || '';
    const nextDepartmentId = data.department_id || '';
    const matchingDepartment = departments.find(department => idsMatch(department.id, nextDepartmentId));

    return {
      ...data,
      school_id: matchingDepartment?.school_id || nextSchoolId || null,
      department_id: nextDepartmentId || null,
      program: normalizeProgramValue(data.program),
      academic_year: data.academic_year?.toString().trim() || null,
      year_of_study: normalizeYearOfStudyValue(data.year_of_study),
      semester: normalizeExactSemesterValue(data.semester, data.year_of_study, data.semester?.toString().trim() || ''),
      section: data.section?.toString().trim() || null,
      working_days: normalizeTimingProfileWorkingDays(data.working_days),
      slot_pattern: normalizeTimingProfileSlotPattern(data.slot_pattern),
      notes: data.notes?.toString().trim() || null,
    };
  };

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const school = schools.find(item =>
        normalizeLookupValue(item.name) === normalizeLookupValue(row['School']) ||
        normalizeLookupValue(item.school_id) === normalizeLookupValue(row['School'])
      );
      const department = sortedDepartments.find(item =>
        (
          normalizeLookupValue(item.name) === normalizeLookupValue(row['Department']) ||
          normalizeLookupValue(item.department_id) === normalizeLookupValue(row['Department'])
        ) &&
        (!school || idsMatch(item.school_id, school.id))
      );

      const payload = {
        profile_id: row['Profile ID']?.toString(),
        profile_name: row['Profile Name']?.toString() || row['Profile ID']?.toString(),
        school_id: department?.school_id || school?.id || null,
        department_id: department?.id || null,
        program: normalizeProgramValue(row['Program']),
        academic_year: row['Academic Year']?.toString() || null,
        year_of_study: normalizeYearOfStudyValue(getImportValue(row, ['Year / Semester', 'Year of Study', 'Year'])),
        semester: normalizeExactSemesterValue(getImportValue(row, ['Semester']), getImportValue(row, ['Year / Semester', 'Year of Study', 'Year']), ''),
        section: getImportValue(row, ['Section'])?.toString().trim() || null,
        working_days: normalizeTimingProfileWorkingDays(getImportValue(row, ['Working Days'])),
        slot_pattern: normalizeTimingProfileSlotPattern(getImportValue(row, ['Slot Timings', 'Slot Pattern'])),
        notes: row['Notes']?.toString() || null,
      };

      if (!payload.profile_id || !payload.profile_name || !payload.slot_pattern) continue;
      await upsertImportRecord('/api/timing_profiles', payload, [['profile_id']]);
    }
  };

  return (
    <GenericCRUD
      type="Timing Profile"
      fields={fields}
      apiPath="/api/timing_profiles"
      onImport={handleImport}
      prepareSubmitData={prepareSubmitData}
      onDataChanged={refreshLookups}
    />
  );
}

function AcademicCalendarManagement() {
  const [schools, setSchools] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [timingProfiles, setTimingProfiles] = useState<any[]>([]);

  const refreshLookups = async () => {
    const [schoolData, departmentData, timingProfileData] = await Promise.all([
      fetch('/api/schools', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/departments', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/timing_profiles', { credentials: 'include' }).then(res => res.json()),
    ]);
    setSchools(Array.isArray(schoolData) ? schoolData : []);
    setDepartments(Array.isArray(departmentData) ? departmentData : []);
    setTimingProfiles(Array.isArray(timingProfileData) ? timingProfileData : []);
  };

  useEffect(() => {
    refreshLookups();
  }, []);

  const schoolOptions = schools
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
    .map(school => ({ value: school.id, label: school.name }));

  const sortedDepartments = departments
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);

  const fields = [
    { key: 'calendar_id', label: 'Calendar ID' },
    { key: 'school_id', label: 'School', type: 'select', resetKeys: ['department_id'], options: schoolOptions },
    {
      key: 'department_id',
      label: 'Department',
      type: 'select',
      options: (formData: any) => sortedDepartments
        .filter(department => idsMatch(department.school_id, formData.school_id))
        .map(department => ({ value: department.id, label: department.name })),
      render: (item: any) => departments.find(department => idsMatch(department.id, item.department_id))?.name || 'Unknown',
    },
    { key: 'program', label: 'Program', type: 'select', options: PROGRAM_OPTIONS },
    { key: 'batch', label: 'Batch' },
    { key: 'academic_year', label: 'Academic Year' },
    { key: 'semester', label: 'Semester', type: 'select', resetKeys: ['year_of_study'], options: SEMESTER_OPTIONS },
    {
      key: 'year_of_study',
      label: 'Year / Semester',
      type: 'select',
      options: (formData: any) => getYearOfStudyOptions(formData.program, formData.semester),
      render: (item: any) => getStudyPeriodDisplay(item.year_of_study, item.semester, item.program),
    },
    {
      key: 'timing_profile_id',
      label: 'Timing Profile',
      type: 'select',
      required: false,
      options: (formData: any) => timingProfiles
        .filter(profile =>
          (!formData.school_id || !profile.school_id || idsMatch(profile.school_id, formData.school_id)) &&
          (!formData.department_id || !profile.department_id || idsMatch(profile.department_id, formData.department_id))
        )
        .map(profile => ({ value: profile.id, label: getTimingProfileDisplayLabel(profile) })),
      render: (item: any) => getTimingProfileDisplayLabel(timingProfiles.find(profile => idsMatch(profile.id, item.timing_profile_id))) || '-',
    },
    {
      key: 'event_type',
      label: 'Event Type',
      type: 'select',
      options: ACADEMIC_CALENDAR_EVENT_TYPES,
      onChange: (nextData: any, value: string) => {
        const titleOptions = getAcademicCalendarTitleOptions(value);
        if (!nextData.title?.toString().trim() && titleOptions.length > 0) {
          return { ...nextData, event_type: value, title: titleOptions[0] };
        }
        return nextData;
      },
    },
    { key: 'title', label: 'Title', fullWidth: true },
    { key: 'start_date', label: 'Start Date', type: 'date', render: (item: any) => formatDisplayDate(item.start_date) || '-' },
    { key: 'end_date', label: 'End Date', type: 'date', render: (item: any) => formatDisplayDate(item.end_date) || '-' },
    {
      key: 'status',
      label: 'Status',
      tableOnly: true,
      render: (item: any) => getRangeLifecycleStatus(item.start_date, item.end_date, 'Completed'),
    },
    { key: 'notes', label: 'Notes', fullWidth: true, required: false },
  ];

  const prepareSubmitData = (data: any) => {
    const department = departments.find(item => idsMatch(item.id, data.department_id));
    if (!department) throw new Error('Please select a valid department.');
    if (!data.start_date || !data.end_date) throw new Error('Start date and end date are required.');
    if (data.start_date > data.end_date) throw new Error('Start date cannot be after end date.');

    return {
      ...data,
      school_id: department.school_id,
      program: normalizeProgramValue(data.program),
      year_of_study: normalizeYearOfStudyValue(data.year_of_study),
      timing_profile_id: data.timing_profile_id || null,
      title: data.title?.toString().trim() || data.event_type,
      status: getRangeLifecycleStatus(data.start_date, data.end_date, 'Completed'),
    };
  };

  const academicCalendarSorter = (left: any, right: any) => {
    const departmentCompare = (departments.find(item => idsMatch(item.id, left.department_id))?.name || '')
      .localeCompare(departments.find(item => idsMatch(item.id, right.department_id))?.name || '');
    if (departmentCompare !== 0) return departmentCompare;

    const startCompare = (left.start_date || '').localeCompare(right.start_date || '');
    if (startCompare !== 0) return startCompare;

    const endCompare = (left.end_date || '').localeCompare(right.end_date || '');
    if (endCompare !== 0) return endCompare;

    const eventCompare = getAcademicCalendarEventRank(left.event_type) - getAcademicCalendarEventRank(right.event_type);
    if (eventCompare !== 0) return eventCompare;

    return (left.title || '').localeCompare(right.title || '');
  };

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const school = schools.find(item =>
        normalizeLookupValue(item.name) === normalizeLookupValue(row['School']) ||
        normalizeLookupValue(item.school_id) === normalizeLookupValue(row['School'])
      );
      const department = sortedDepartments.find(item =>
        (
          normalizeLookupValue(item.name) === normalizeLookupValue(row['Department']) ||
          normalizeLookupValue(item.department_id) === normalizeLookupValue(row['Department'])
        ) &&
        (!school || idsMatch(item.school_id, school.id))
      );
      const startDate = formatExcelDate(row['Start Date']);
      const endDate = formatExcelDate(row['End Date']);
      const timingProfile = timingProfiles.find(item =>
        normalizeLookupValue(item.profile_id) === normalizeLookupValue(row['Timing Profile']) ||
        normalizeLookupValue(item.profile_name) === normalizeLookupValue(row['Timing Profile'])
      );

      const payload = {
        calendar_id: row['Calendar ID']?.toString(),
        school_id: school?.id || department?.school_id,
        department_id: department?.id,
        program: normalizeProgramValue(row['Program']),
        batch: row['Batch'],
        academic_year: row['Academic Year'],
        year_of_study: normalizeYearOfStudyValue(getImportValue(row, ['Year / Semester', 'Year of Study'])),
        semester: normalizeSemesterValue(row['Semester'], ''),
        timing_profile_id: timingProfile?.id || null,
        event_type: row['Event Type'] || 'Semester Period',
        title: row['Title'] || row['Event Type'],
        start_date: startDate,
        end_date: endDate,
        status: getRangeLifecycleStatus(startDate, endDate, 'Completed'),
        notes: row['Notes'],
      };

      if (!payload.calendar_id || !payload.department_id || !payload.title || !payload.start_date || !payload.end_date) continue;
      await upsertImportRecord('/api/academic_calendars', payload, [
        ['calendar_id'],
        ['department_id', 'program', 'batch', 'year_of_study', 'semester', 'event_type', 'title', 'start_date', 'end_date'],
      ]);
    }
  };

  return (
    <GenericCRUD
      type="Academic Calendar"
      fields={fields}
      apiPath="/api/academic_calendars"
      onImport={handleImport}
      onDataChanged={refreshLookups}
      prepareSubmitData={prepareSubmitData}
      dataSorter={academicCalendarSorter}
    />
  );
}

function BatchRoomAllocationManagement() {
  const [schools, setSchools] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [calendars, setCalendars] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [lookupFilters, setLookupFilters] = useState({ school_id: '', department_id: '', status: '' });

  const refreshBatchAllocationLookups = async () => {
    const [
      schoolData,
      departmentData,
      roomData,
      floorData,
      blockData,
      buildingData,
      calendarData,
      allocationData,
    ] = await Promise.all([
      fetch('/api/schools', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/departments', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/rooms', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/floors', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/blocks', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/buildings', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/academic_calendars', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/batch_room_allocations', { credentials: 'include' }).then(res => res.json()),
    ]);

    setSchools(Array.isArray(schoolData) ? schoolData : []);
    setDepartments(Array.isArray(departmentData) ? departmentData : []);
    setRooms(Array.isArray(roomData) ? roomData : []);
    setFloors(Array.isArray(floorData) ? floorData : []);
    setBlocks(Array.isArray(blockData) ? blockData : []);
    setBuildings(Array.isArray(buildingData) ? buildingData : []);
    setCalendars(Array.isArray(calendarData) ? calendarData : []);
    setAllocations(Array.isArray(allocationData) ? allocationData : []);
  };

  useEffect(() => {
    refreshBatchAllocationLookups();
  }, []);

  const getRoomPath = (room: any) => {
    const floor = floors.find(f => idsMatch(f.id, room?.floor_id));
    const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
    const building = buildings.find(b => idsMatch(b.id, block?.building_id));
    return { floor, block, building };
  };

  const buildingHasVisibleBlocks = (buildingId: unknown) => {
    const building = buildings.find(b => b.id == buildingId);
    if (!building) return false;
    return blocks.some(block => idsMatch(block.building_id, building.id) && !isImplicitBuildingBlock(block, building));
  };

  const getBlockOptionsForBuilding = (formData: any) => {
    const building = buildings.find(b => b.id == formData.building_id);
    if (!building) return [];
    return blocks
      .filter(block => idsMatch(block.building_id, building.id) && !isImplicitBuildingBlock(block, building))
      .map(block => ({ value: block.id, label: block.name }));
  };

  const getFloorOptionsForSelection = (formData: any) => {
    const building = buildings.find(b => b.id == formData.building_id);
    if (!building) return [];
    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, building.id));
    const directBlock = buildingBlocks.find(block => isImplicitBuildingBlock(block, building));
    const allowedBlockIds = formData.block_id
      ? [parseInt(formData.block_id, 10)]
      : buildingHasVisibleBlocks(formData.building_id)
        ? []
        : directBlock ? [directBlock.id] : buildingBlocks.map(block => block.id);

    return floors
      .filter(floor => allowedBlockIds.some(blockId => idsMatch(blockId, floor.block_id)))
      .sort((a, b) => a.floor_number - b.floor_number)
      .map(floor => ({ value: floor.id, label: getFloorDisplayLabel(floor, blocks, buildings) }));
  };

  const getAvailableRoomOptions = (formData: any) => {
    return rooms
      .filter(room => {
        if (!isRoomReservable(room)) return false;
        const { floor, block, building } = getRoomPath(room);
        if (!floor || !block || !building) return false;
        if (formData.building_id && !idsMatch(building.id, formData.building_id)) return false;
        if (formData.block_id && !idsMatch(block.id, formData.block_id)) return false;
        if (formData.floor_id && !idsMatch(floor.id, formData.floor_id)) return false;
        if (!formData.block_id && formData.building_id && buildingHasVisibleBlocks(formData.building_id)) return false;
        return true;
      })
      .map(room => {
        const { floor } = getRoomPath(room);
        const requestedCapacity = parseInt(formData.capacity, 10) || 0;
        const fitLabel = requestedCapacity
          ? room.capacity >= requestedCapacity ? `Good fit, ${room.capacity} seats` : `Under capacity, ${room.capacity} seats`
          : `${room.capacity} seats`;
        return {
          value: room.id,
          label: `${getRoomDisplayLabel(room, rooms)} - ${fitLabel} - ${getFloorDisplayLabel(floor, blocks, buildings)}`,
        };
      });
  };

  const getRoomCapacity = (item: any) => {
    const room = rooms.find(r => idsMatch(r.id, item.room_id));
    return room?.capacity ?? 'Unknown';
  };

  const schoolOptions = schools
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
    .map(school => ({ value: school.id, label: school.name }));

  const sortedDepartments = departments
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);

  const getCalendarLabel = (calendar: any) => {
    const studyPeriod = getStudyPeriodDisplay(calendar.year_of_study, calendar.semester, calendar.program);
    const programLabel = [calendar.program || 'Program', calendar.batch || '', studyPeriod !== '-' ? studyPeriod : ''].filter(Boolean).join(' - ');
    return `${calendar.title} - ${programLabel}`.trim() + ` (${formatDisplayDate(calendar.start_date)} to ${formatDisplayDate(calendar.end_date)})`;
  };

  const filteredCalendarOptions = (formData: any) =>
    calendars
      .filter(calendar => !formData.school_id || idsMatch(calendar.school_id, formData.school_id))
      .filter(calendar => !formData.department_id || idsMatch(calendar.department_id, formData.department_id))
      .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || '') || (a.title || '').localeCompare(b.title || ''))
      .map(calendar => ({ value: calendar.id, label: getCalendarLabel(calendar) }));

  const lookupDepartments = sortedDepartments.filter(department =>
    !lookupFilters.school_id || department.school_id?.toString() === lookupFilters.school_id
  );

  const lookupResults = allocations.filter(allocation => {
    const computedStatus = getRangeLifecycleStatus(allocation.start_date, allocation.end_date, 'Released', 'Planned');
    if (lookupFilters.school_id && allocation.school_id?.toString() !== lookupFilters.school_id) return false;
    if (lookupFilters.department_id && allocation.department_id?.toString() !== lookupFilters.department_id) return false;
    if (lookupFilters.status && computedStatus !== lookupFilters.status) return false;
    return lookupFilters.school_id || lookupFilters.department_id || lookupFilters.status;
  });

  const getAllocationDetails = (allocation: any) => {
    const school = schools.find(s => idsMatch(s.id, allocation.school_id));
    const department = departments.find(d => idsMatch(d.id, allocation.department_id));
    const room = rooms.find(r => idsMatch(r.id, allocation.room_id));
    const calendar = calendars.find(c => idsMatch(c.id, allocation.academic_calendar_id));
    const { floor, block, building } = getRoomPath(room);
    return { school, department, room, calendar, floor, block, building };
  };

  const getRoomDeepLinkSearch = (room: any) => {
    const params = new URLSearchParams();
    if (room?.id !== undefined && room?.id !== null) params.set('roomId', room.id.toString());
    params.set('room', getRoomDisplayLabel(room, rooms));
    return `?${params.toString()}`;
  };

  const fields = [
    { key: 'allocation_id', label: 'Allocation ID' },
    {
      key: 'academic_calendar_id',
      label: 'Academic Calendar',
      type: 'select',
      required: false,
      options: filteredCalendarOptions,
      onChange: (nextData: any, value: string) => {
        const calendar = calendars.find(item => idsMatch(item.id, value));
        if (!calendar) return nextData;
        return {
          ...nextData,
          academic_calendar_id: calendar.id,
          school_id: calendar.school_id?.toString() || nextData.school_id,
          department_id: calendar.department_id?.toString() || nextData.department_id,
          program: calendar.program || nextData.program,
          batch: calendar.batch || nextData.batch,
          academic_year: calendar.academic_year || nextData.academic_year,
          semester: calendar.semester || nextData.semester,
          year_of_study: calendar.year_of_study || nextData.year_of_study,
          start_date: calendar.start_date || nextData.start_date,
          end_date: calendar.end_date || nextData.end_date,
        };
      },
      render: (item: any) => {
        const calendar = calendars.find(entry => idsMatch(entry.id, item.academic_calendar_id));
        return calendar ? calendar.title : '-';
      },
    },
    { key: 'school_id', label: 'School', type: 'select', resetKeys: ['department_id', 'academic_calendar_id'], options: schoolOptions },
    {
      key: 'department_id',
      label: 'Department',
      type: 'select',
      resetKeys: ['academic_calendar_id'],
      options: (formData: any) => sortedDepartments
        .filter(department => idsMatch(department.school_id, formData.school_id))
        .map(department => ({ value: department.id, label: department.name })),
      render: (item: any) => departments.find(department => idsMatch(department.id, item.department_id))?.name || 'Unknown',
    },
    { key: 'program', label: 'Program', type: 'select', options: PROGRAM_OPTIONS },
    { key: 'batch', label: 'Batch' },
    { key: 'academic_year', label: 'Academic Year' },
    { key: 'semester', label: 'Semester', type: 'select', resetKeys: ['year_of_study'], options: SEMESTER_OPTIONS },
    {
      key: 'year_of_study',
      label: 'Year / Semester',
      type: 'select',
      options: (formData: any) => getYearOfStudyOptions(formData.program, formData.semester),
      render: (item: any) => getStudyPeriodDisplay(item.year_of_study, item.semester, item.program),
    },
    { key: 'allocation_mode', label: 'Allocation Mode', type: 'select', options: BATCH_ALLOCATION_MODE_OPTIONS, required: false },
    {
      key: 'building_id',
      label: 'Building',
      type: 'select',
      resetKeys: ['block_id', 'floor_id', 'room_id'],
      options: buildings.map(building => ({ value: building.id, label: building.name })),
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        return getRoomPath(room)?.building?.name || 'Unknown';
      },
    },
    {
      key: 'block_id',
      label: 'Block',
      type: 'select',
      resetKeys: ['floor_id', 'room_id'],
      show: (formData: any) => buildingHasVisibleBlocks(formData.building_id),
      options: getBlockOptionsForBuilding,
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        const { block, building } = getRoomPath(room);
        return getBlockDisplayLabel(block, building);
      },
    },
    {
      key: 'floor_id',
      label: 'Floor',
      type: 'select',
      resetKeys: ['room_id'],
      options: getFloorOptionsForSelection,
      formOnly: true,
    },
    {
      key: 'floor_id',
      label: 'Floor',
      tableOnly: true,
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        const { floor } = getRoomPath(room);
        return floor ? getFloorName(floor.floor_number) : 'Unknown';
      },
    },
    { key: 'room_id', label: 'Room', type: 'select', options: getAvailableRoomOptions, render: (item: any) => {
      const room = rooms.find(r => idsMatch(r.id, item.room_id));
      return room ? getRoomDisplayLabel(room, rooms) : 'Unknown';
    } },
    { key: 'room_capacity', label: 'Room Capacity', tableOnly: true, render: getRoomCapacity },
    { key: 'room_type', label: 'Room Type', tableOnly: true, render: (item: any) => item.room_type || rooms.find(room => idsMatch(room.id, item.room_id))?.room_type || 'Unknown' },
    { key: 'capacity', label: 'Required Capacity', type: 'number' },
    { key: 'start_date', label: 'Start Date', type: 'date' },
    { key: 'end_date', label: 'End Date', type: 'date' },
    {
      key: 'status',
      label: 'Status',
      tableOnly: true,
      render: (item: any) => getRangeLifecycleStatus(item.start_date, item.end_date, 'Released', 'Planned'),
    },
    { key: 'notes', label: 'Notes', fullWidth: true, required: false },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const calendar = calendars.find(item =>
        normalizeLookupValue(item.calendar_id) === normalizeLookupValue(getImportValue(row, ['Academic Calendar', 'Calendar ID'])) ||
        normalizeLookupValue(item.title) === normalizeLookupValue(getImportValue(row, ['Academic Calendar', 'Title']))
      );
      const department = sortedDepartments.find(item =>
        normalizeLookupValue(item.name) === normalizeLookupValue(row['Department']) ||
        normalizeLookupValue(item.department_id) === normalizeLookupValue(row['Department']) ||
        idsMatch(item.id, calendar?.department_id)
      );
      const building = buildings.find(item => normalizeLookupValue(item.name) === normalizeLookupValue(getImportValue(row, ['Building'])));
      const blockLabel = getImportValue(row, ['Block', 'Block / Direct Floors']);
      const normalizedBlockLabel = normalizeLookupValue(blockLabel);
      const normalizedRoomValue = normalizeLookupValue(getImportValue(row, ['Room', 'Room Number']));
      const room = rooms.find(r => {
        if (!isRoomReservable(r)) return false;
        if (![
          normalizeLookupValue(r.room_id),
          normalizeLookupValue(r.room_number),
          normalizeLookupValue(getRoomDisplayLabel(r, rooms)),
        ].includes(normalizedRoomValue)) return false;
        const { block, building: roomBuilding } = getRoomPath(r);
        if (building && !idsMatch(roomBuilding?.id, building.id)) return false;
        if (normalizedBlockLabel) {
          const wantsDirectBlock = normalizedBlockLabel === 'direct floors' || normalizedBlockLabel === 'direct floors (no block)';
          if (wantsDirectBlock && !isImplicitBuildingBlock(block, roomBuilding)) return false;
          if (!wantsDirectBlock && normalizeLookupValue(block?.name) !== normalizedBlockLabel) return false;
        }
        return true;
      });

      const startDate = formatExcelDate(getImportValue(row, ['Start Date'])) || calendar?.start_date;
      const endDate = formatExcelDate(getImportValue(row, ['End Date'])) || calendar?.end_date;
      const payload = {
        allocation_id: row['Allocation ID']?.toString(),
        academic_calendar_id: calendar?.id || null,
        school_id: department?.school_id,
        department_id: department?.id,
        room_id: room?.id,
        program: normalizeProgramValue(row['Program']) || calendar?.program,
        batch: row['Batch'] || calendar?.batch,
        academic_year: row['Academic Year'] || calendar?.academic_year,
        year_of_study: normalizeYearOfStudyValue(getImportValue(row, ['Year / Semester', 'Year of Study'])) || calendar?.year_of_study,
        semester: normalizeSemesterValue(getImportValue(row, ['Semester']), '') || calendar?.semester,
        allocation_mode: getImportValue(row, ['Allocation Mode'])?.toString() || 'Shared',
        room_type: row['Room Type'] || room?.room_type,
        capacity: parseInt(getImportValue(row, ['Required Capacity', 'Capacity'])?.toString() || '0', 10) || 0,
        start_date: startDate,
        end_date: endDate,
        status: getRangeLifecycleStatus(startDate, endDate, 'Released', 'Planned'),
        notes: row['Notes'] || null,
      };

      if (!payload.allocation_id || !payload.department_id || !payload.room_id || !payload.start_date || !payload.end_date || payload.capacity <= 0) continue;
      await upsertImportRecord('/api/batch_room_allocations', payload, [
        ['allocation_id'],
        ['room_id', 'department_id', 'program', 'batch', 'year_of_study', 'semester', 'start_date', 'end_date'],
      ]);
    }
  };

  const prepareFormData = (item: any) => {
    const room = rooms.find(r => idsMatch(r.id, item.room_id));
    const { floor, block, building } = getRoomPath(room);
    return {
      ...item,
      building_id: building?.id || '',
      block_id: block && !isImplicitBuildingBlock(block, building) ? block.id : '',
      floor_id: floor?.id || '',
    };
  };

  const prepareSubmitData = (data: any) => {
    const payload = { ...data };
    const room = rooms.find(r => idsMatch(r.id, payload.room_id));
    const department = departments.find(item => idsMatch(item.id, payload.department_id));
    const calendar = calendars.find(item => idsMatch(item.id, payload.academic_calendar_id));
    const requiredCapacity = parseInt(payload.capacity, 10) || 0;

    if (!department) throw new Error('Please select a valid department.');
    if (!room) throw new Error('Please select a valid room.');
    if (!payload.start_date || !payload.end_date) throw new Error('Start date and end date are required.');
    if (payload.start_date > payload.end_date) throw new Error('Start date cannot be after end date.');
    if (requiredCapacity <= 0) throw new Error('Required capacity must be greater than zero.');
    if (requiredCapacity > room.capacity) throw new Error(`Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${requiredCapacity}.`);

    payload.school_id = department.school_id;
    payload.program = normalizeProgramValue(payload.program);
    payload.year_of_study = normalizeYearOfStudyValue(payload.year_of_study);
    payload.allocation_mode = BATCH_ALLOCATION_MODE_OPTIONS.includes(payload.allocation_mode) ? payload.allocation_mode : 'Shared';
    payload.room_type = room.room_type;
    payload.status = getRangeLifecycleStatus(payload.start_date, payload.end_date, 'Released', 'Planned');
    if (calendar) {
      payload.academic_calendar_id = calendar.id;
    } else {
      payload.academic_calendar_id = null;
    }

    delete payload.building_id;
    delete payload.block_id;
    delete payload.floor_id;
    delete payload.room_capacity;
    return payload;
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="text-lg font-bold text-slate-800">Find Batch Room Allocations</h3>
            <p className="text-sm text-slate-500">Track active, upcoming, and released room allocations by batch, year, and semester, including rooms shared across departments.</p>
          </div>
          <button
            onClick={() => setLookupFilters({ school_id: '', department_id: '', status: '' })}
            className="px-4 py-2 bg-slate-50 text-slate-600 border border-slate-200 rounded-lg font-bold hover:bg-slate-100"
          >
            Clear
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">School</label>
            <select
              value={lookupFilters.school_id}
              onChange={e => setLookupFilters({ school_id: e.target.value, department_id: '', status: lookupFilters.status })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Select School</option>
              {schoolOptions.map(school => <option key={school.value} value={school.value}>{school.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Department</label>
            <select
              value={lookupFilters.department_id}
              onChange={e => setLookupFilters({ ...lookupFilters, department_id: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Departments</option>
              {lookupDepartments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Status</label>
            <select
              value={lookupFilters.status}
              onChange={e => setLookupFilters({ ...lookupFilters, status: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Statuses</option>
              {ALLOCATION_STATUS_OPTIONS.map(status => <option key={status} value={status}>{status}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-100 rounded-xl">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {['Department', 'Program', 'Batch', 'Year / Semester', 'Semester', 'Mode', 'Building', 'Block', 'Floor', 'Room', 'From', 'To', 'Status', 'Open'].map(header => (
                  <th key={header} className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lookupResults.map(allocation => {
                const { department, room, floor, block, building } = getAllocationDetails(allocation);
                const status = getRangeLifecycleStatus(allocation.start_date, allocation.end_date, 'Released', 'Planned');
                return (
                  <tr key={allocation.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">{department?.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.program || '-'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.batch || '-'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{getStudyPeriodDisplay(allocation.year_of_study, allocation.semester, allocation.program)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.semester || '-'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.allocation_mode || 'Shared'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{building?.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{getBlockDisplayLabel(block, building)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{floor ? getFloorName(floor.floor_number) : 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm font-bold text-slate-800">{room ? getRoomDisplayLabel(room, rooms) : 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.start_date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.end_date}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{status}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Link to={`/timetable${getRoomDeepLinkSearch(room)}`} className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">Timetable</Link>
                        <Link to={`/bookings${getRoomDeepLinkSearch(room)}`} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">Bookings</Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {lookupResults.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-4 py-8 text-center text-sm text-slate-400 italic">
                    Select a school, department, or status to view batch room allocations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <GenericCRUD
        type="Batch Room Allocation"
        fields={fields}
        apiPath="/api/batch_room_allocations"
        onImport={handleImport}
        onDataChanged={refreshBatchAllocationLookups}
        prepareFormData={prepareFormData}
        prepareSubmitData={prepareSubmitData}
      />
    </div>
  );
}

function DepartmentAllocationManagement() {
  const [schools, setSchools] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [lookupFilters, setLookupFilters] = useState({ school_id: '', department_id: '', semester: '' });
  const semesterOptions = ['Odd', 'Even'];

  const normalizeSemester = (value: unknown) => {
    const normalized = normalizeLookupValue(value);
    if (!normalized) return '';
    if (normalized.includes('odd') || normalized.includes('fall')) return 'Odd';
    if (normalized.includes('even') || normalized.includes('spring') || normalized.includes('summer')) return 'Even';
    return value?.toString().trim() || '';
  };

  const refreshAllocations = async () => {
    const res = await fetch('/api/department_allocations', { credentials: 'include' });
    const data = await res.json();
    setAllocations(Array.isArray(data) ? data : []);
  };

  useEffect(() => {
    fetch('/api/schools').then(res => res.json()).then(setSchools);
    fetch('/api/departments').then(res => res.json()).then(setDepartments);
    fetch('/api/rooms').then(res => res.json()).then(setRooms);
    fetch('/api/floors').then(res => res.json()).then(setFloors);
    fetch('/api/blocks').then(res => res.json()).then(setBlocks);
    fetch('/api/buildings').then(res => res.json()).then(setBuildings);
    refreshAllocations();
  }, []);

  const getRoomPath = (room: any) => {
    const floor = floors.find(f => idsMatch(f.id, room?.floor_id));
    const block = blocks.find(b => idsMatch(b.id, floor?.block_id));
    const building = buildings.find(b => idsMatch(b.id, block?.building_id));
    return { floor, block, building };
  };

  const buildingHasVisibleBlocks = (buildingId: unknown) => {
    const building = buildings.find(b => b.id == buildingId);
    if (!building) return false;
    return blocks.some(block => idsMatch(block.building_id, building.id) && !isImplicitBuildingBlock(block, building));
  };

  const getBlockOptionsForBuilding = (formData: any) => {
    const building = buildings.find(b => b.id == formData.building_id);
    if (!building) return [];
    return blocks
      .filter(block => idsMatch(block.building_id, building.id) && !isImplicitBuildingBlock(block, building))
      .map(block => ({ value: block.id, label: block.name }));
  };

  const getFloorOptionsForSelection = (formData: any) => {
    const building = buildings.find(b => b.id == formData.building_id);
    if (!building) return [];
    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, building.id));
    const directBlock = buildingBlocks.find(block => isImplicitBuildingBlock(block, building));
    const allowedBlockIds = formData.block_id
      ? [parseInt(formData.block_id)]
      : buildingHasVisibleBlocks(formData.building_id)
        ? []
        : directBlock ? [directBlock.id] : buildingBlocks.map(block => block.id);

    return floors
      .filter(floor => allowedBlockIds.some(blockId => idsMatch(blockId, floor.block_id)))
      .sort((a, b) => a.floor_number - b.floor_number)
      .map(floor => ({ value: floor.id, label: getFloorDisplayLabel(floor, blocks, buildings) }));
  };

  const getAvailableRoomOptions = (formData: any) => {
    return rooms
      .filter(room => {
        if (!isRoomReservable(room)) return false;

        const { floor, block, building } = getRoomPath(room);
        if (!floor || !block || !building) return false;
        if (formData.building_id && building.id?.toString() !== formData.building_id?.toString()) return false;
        if (formData.block_id && block.id?.toString() !== formData.block_id?.toString()) return false;
        if (formData.floor_id && floor.id?.toString() !== formData.floor_id?.toString()) return false;
        if (!formData.block_id && formData.building_id && buildingHasVisibleBlocks(formData.building_id)) return false;
        return true;
      })
      .map(room => {
        const { floor, block, building } = getRoomPath(room);
        const requestedCapacity = parseInt(formData.capacity, 10) || 0;
        const fitLabel = requestedCapacity
          ? room.capacity >= requestedCapacity ? `Good fit, ${room.capacity} seats` : `Under capacity, ${room.capacity} seats`
          : `${room.capacity} seats`;
        return {
          value: room.id,
          label: `${getRoomDisplayLabel(room, rooms)} - ${fitLabel} - ${getFloorDisplayLabel(floor, blocks, buildings)}`,
        };
      });
  };

  const getRoomCapacity = (item: any) => {
    const room = rooms.find(r => idsMatch(r.id, item.room_id));
    return room?.capacity ?? 'Unknown';
  };

  const schoolOptions = schools
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
    .map(school => ({ value: school.id, label: school.name }));
  const sortedDepartments = departments
    .slice()
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);
  const lookupDepartments = sortedDepartments.filter(department =>
    !lookupFilters.school_id || department.school_id?.toString() === lookupFilters.school_id
  );

  const lookupResults = allocations.filter(allocation => {
    if (lookupFilters.school_id && allocation.school_id?.toString() !== lookupFilters.school_id) return false;
    if (lookupFilters.department_id && allocation.department_id?.toString() !== lookupFilters.department_id) return false;
    if (lookupFilters.semester && allocation.semester !== lookupFilters.semester) return false;
    return lookupFilters.school_id || lookupFilters.department_id || lookupFilters.semester;
  });

  const getAllocationDetails = (allocation: any) => {
    const school = schools.find(s => idsMatch(s.id, allocation.school_id));
    const department = departments.find(d => idsMatch(d.id, allocation.department_id));
    const room = rooms.find(r => idsMatch(r.id, allocation.room_id));
    const { floor, block, building } = getRoomPath(room);
    return { school, department, room, floor, block, building };
  };

  const fields = [
    { key: 'school_id', label: 'School', type: 'select', resetKeys: ['department_id'], options: schoolOptions },
    { 
      key: 'department_id', 
      label: 'Department', 
      type: 'select', 
      options: (formData: any) => {
        return sortedDepartments
          .filter(d => idsMatch(d.school_id, formData.school_id))
          .map(d => ({ value: d.id, label: d.name }));
      }
    },
    { key: 'semester', label: 'Semester', type: 'select', resetKeys: ['room_id'], options: semesterOptions },
    {
      key: 'building_id',
      label: 'Building',
      type: 'select',
      resetKeys: ['block_id', 'floor_id', 'room_id'],
      options: buildings.map(building => ({ value: building.id, label: building.name })),
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        return getRoomPath(room)?.building?.name || 'Unknown';
      },
    },
    {
      key: 'block_id',
      label: 'Block',
      type: 'select',
      resetKeys: ['floor_id', 'room_id'],
      show: (formData: any) => buildingHasVisibleBlocks(formData.building_id),
      options: getBlockOptionsForBuilding,
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        const { block, building } = getRoomPath(room);
        return getBlockDisplayLabel(block, building);
      },
    },
    {
      key: 'floor_id',
      label: 'Floor',
      type: 'select',
      resetKeys: ['room_id'],
      options: getFloorOptionsForSelection,
      formOnly: true,
    },
    {
      key: 'floor_id',
      label: 'Floor',
      tableOnly: true,
      render: (item: any) => {
        const room = rooms.find(r => idsMatch(r.id, item.room_id));
        const { floor } = getRoomPath(room);
        return floor ? getFloorName(floor.floor_number) : 'Unknown';
      },
    },
    {
      key: 'room_id',
      label: 'Room',
      type: 'select',
      options: getAvailableRoomOptions,
      onChange: (nextData: any, roomId: string) => {
        const room = rooms.find(r => r.id?.toString() === roomId?.toString());
        return room ? { ...nextData, room_type: room.room_type } : nextData;
      },
    },
    {
      key: 'room_capacity',
      label: 'Room Capacity',
      tableOnly: true,
      render: getRoomCapacity,
    },
    {
      key: 'room_type',
      label: 'Room Type',
      type: 'select',
      options: ROOM_TYPE_OPTIONS,
      onChange: (nextData: any) => nextData,
    },
    { key: 'capacity', label: 'Required Capacity', type: 'number', formOnly: true },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const school = schools.find(s =>
        normalizeLookupValue(s.name) === normalizeLookupValue(row['School']) ||
        normalizeLookupValue(s.school_id) === normalizeLookupValue(row['School'])
      );
      const department = departments.find(d =>
        (!school || idsMatch(d.school_id, school.id)) &&
        (
          normalizeLookupValue(d.name) === normalizeLookupValue(row['Department']) ||
          normalizeLookupValue(d.department_id) === normalizeLookupValue(row['Department'])
        )
      );
      const building = buildings.find(b => normalizeLookupValue(b.name) === normalizeLookupValue(getImportValue(row, ['Building'])));
      const blockLabel = getImportValue(row, ['Block', 'Block / Direct Floors']);
      const normalizedBlockLabel = normalizeLookupValue(blockLabel);
      const normalizedRoomValue = normalizeLookupValue(getImportValue(row, ['Room', 'Room Number']));
      const room = rooms.find(r => {
        if (!isRoomReservable(r)) return false;
        if (![
          normalizeLookupValue(r.room_id),
          normalizeLookupValue(r.room_number),
          normalizeLookupValue(getRoomDisplayLabel(r, rooms)),
        ].includes(normalizedRoomValue)) return false;
        const { block, building: roomBuilding } = getRoomPath(r);
        if (building && !idsMatch(roomBuilding?.id, building.id)) return false;
        if (normalizedBlockLabel) {
          const wantsDirectBlock = normalizedBlockLabel === 'direct floors' || normalizedBlockLabel === 'direct floors (no block)';
          if (wantsDirectBlock && !isImplicitBuildingBlock(block, roomBuilding)) return false;
          if (!wantsDirectBlock && normalizeLookupValue(block?.name) !== normalizedBlockLabel) return false;
        }
        return true;
      });
      
      const payload = {
        school_id: school?.id,
        department_id: department?.id,
        room_id: room?.id,
        semester: normalizeSemester(row['Semester']),
        room_type: row['Room Type'],
        capacity: parseInt(getImportValue(row, ['Required Capacity', 'Capacity'])?.toString() || '0', 10) || 0
      };
      
      if (room && payload.capacity > room.capacity) continue;

      if (
        !payload.school_id ||
        !payload.department_id ||
        !payload.room_id ||
        !semesterOptions.includes(payload.semester)
      ) continue;
      
      await upsertImportRecord('/api/department_allocations', payload, [['room_id', 'department_id', 'semester']]);
    }
  };

  const prepareFormData = (item: any) => {
    const room = rooms.find(r => idsMatch(r.id, item.room_id));
    const { floor, block, building } = getRoomPath(room);

    return {
      ...item,
      building_id: building?.id || '',
      block_id: block && !isImplicitBuildingBlock(block, building) ? block.id : '',
      floor_id: floor?.id || '',
    };
  };

  const prepareSubmitData = (data: any) => {
    const payload = { ...data };
    const room = rooms.find(r => r.id?.toString() === payload.room_id?.toString());
    const requiredCapacity = parseInt(payload.capacity, 10) || 0;
    const duplicateAllocation = allocations.some(allocation =>
      allocation.id !== payload.id &&
      allocation.room_id?.toString() === payload.room_id?.toString() &&
      allocation.department_id?.toString() === payload.department_id?.toString() &&
      allocation.semester === payload.semester
    );

    if (!payload.semester) throw new Error('Semester is required.');
    if (!room) throw new Error('Please select a valid room.');
    if (requiredCapacity <= 0) throw new Error('Required capacity must be greater than zero.');
    if (requiredCapacity > room.capacity) throw new Error(`Room ${room.room_number} capacity is ${room.capacity}, but required capacity is ${requiredCapacity}.`);
    if (duplicateAllocation) throw new Error('This room is already mapped to this department for the selected semester.');

    payload.room_type = room.room_type;
    delete payload.building_id;
    delete payload.block_id;
    delete payload.floor_id;
    delete payload.room_capacity;
    return payload;
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5">
          <div>
            <h3 className="text-lg font-bold text-slate-800">Find Allocated Rooms</h3>
            <p className="text-sm text-slate-500">Search by school and department to see every mapped room.</p>
          </div>
          <button
            onClick={() => setLookupFilters({ school_id: '', department_id: '', semester: '' })}
            className="px-4 py-2 bg-slate-50 text-slate-600 border border-slate-200 rounded-lg font-bold hover:bg-slate-100"
          >
            Clear
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">School</label>
            <select
              value={lookupFilters.school_id}
              onChange={e => setLookupFilters({ school_id: e.target.value, department_id: '', semester: lookupFilters.semester })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Select School</option>
              {schoolOptions.map(school => <option key={school.value} value={school.value}>{school.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Department</label>
            <select
              value={lookupFilters.department_id}
              onChange={e => setLookupFilters({ ...lookupFilters, department_id: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Departments</option>
              {lookupDepartments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Semester</label>
            <select
              value={lookupFilters.semester}
              onChange={e => setLookupFilters({ ...lookupFilters, semester: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Semesters</option>
              {semesterOptions.map(semester => <option key={semester} value={semester}>{semester}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto border border-slate-100 rounded-xl">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                {['School', 'Department', 'Building', 'Block', 'Floor', 'Room', 'Type', 'Capacity', 'Semester', 'Open'].map(header => (
                  <th key={header} className="px-4 py-3 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lookupResults.map(allocation => {
                const { school, department, room, floor, block, building } = getAllocationDetails(allocation);
                return (
                  <tr key={allocation.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">{school?.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm font-medium text-slate-700">{department?.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{building?.name || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{getBlockDisplayLabel(block, building)}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{floor ? getFloorName(floor.floor_number) : 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm font-bold text-slate-800">{room ? getRoomDisplayLabel(room, rooms) : 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{room?.room_type || allocation.room_type || 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{room?.capacity ?? 'Unknown'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{allocation.semester}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Link to="/rooms" className="px-2 py-1 bg-slate-100 text-slate-600 rounded text-xs font-bold">Rooms</Link>
                        <Link to="/timetable" className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">Timetable</Link>
                        <Link to="/bookings" className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">Bookings</Link>
                        <Link to="/equipment" className="px-2 py-1 bg-amber-50 text-amber-700 rounded text-xs font-bold">Equipment</Link>
                        <Link to="/maintenance" className="px-2 py-1 bg-rose-50 text-rose-700 rounded text-xs font-bold">Maintenance</Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {lookupResults.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-400 italic">
                    Select a school, department, or semester to view allocated rooms.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <GenericCRUD
        type="Department Allocation"
        fields={fields}
        apiPath="/api/department_allocations"
        onImport={handleImport}
        onDataChanged={refreshAllocations}
        prepareFormData={prepareFormData}
        prepareSubmitData={prepareSubmitData}
      />
    </div>
  );
}

function EquipmentManagement() {
  const location = useLocation();
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomSearchTerm, setRoomSearchTerm] = useState('');

  useEffect(() => {
    fetch('/api/rooms').then(res => res.json()).then((roomData) => {
      const safeRooms = Array.isArray(roomData) ? roomData : [];
      setRooms(safeRooms);
      const params = new URLSearchParams(location.search);
      const roomId = params.get('roomId');
      const roomLabel = params.get('room');
      const linkedRoom = roomId
        ? safeRooms.find(room => idsMatch(room.id, roomId))
        : findRoomByImportLabel(safeRooms, roomLabel);
      setRoomSearchTerm(linkedRoom ? getRoomDisplayLabel(linkedRoom, safeRooms) : roomLabel || '');
    });
  }, [location.search]);

  const fields = [
    { key: 'equipment_id', label: 'Equipment ID' },
    { key: 'name', label: 'Equipment Name' },
    { key: 'type', label: 'Type' },
    { key: 'room_id', label: 'Room', type: 'select', options: rooms.map(r => ({ value: r.id, label: getRoomDisplayLabel(r, rooms) })) },
    { key: 'condition', label: 'Condition', type: 'select', options: ['Excellent', 'Good', 'Fair', 'Poor'] },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const roomValue = getImportValue(row, ['Room Number', 'Room']);
      const room = findRoomByImportLabel(rooms, roomValue);
      const payload = {
        equipment_id: row['Equipment ID']?.toString(),
        name: row['Equipment Name'],
        type: row['Type'],
        room_id: room?.id,
        condition: row['Condition']
      };
      if (!payload.equipment_id || !payload.name || !payload.room_id) continue;
      await upsertImportRecord('/api/equipment', payload, [['equipment_id'], ['room_id', 'name']]);
    }
  };

  return <GenericCRUD type="Equipment" fields={fields} apiPath="/api/equipment" onImport={handleImport} initialSearchTerm={roomSearchTerm} />;
}

function SchedulingManagement() {
  const [campuses, setCampuses] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scheduleFilters, setScheduleFilters] = useState({
    campus_id: '',
    building_id: '',
    block_id: '',
    floor_id: '',
    department_id: '',
    year: '',
    room_id: '',
    day_of_week: '',
  });

  const refreshSchedulingLookups = async () => {
    const [campusData, buildingData, blockData, floorData, roomData, departmentData, allocationData] = await Promise.all([
      fetch('/api/campuses').then(res => res.json()),
      fetch('/api/buildings').then(res => res.json()),
      fetch('/api/blocks').then(res => res.json()),
      fetch('/api/floors').then(res => res.json()),
      fetch('/api/rooms').then(res => res.json()),
      fetch('/api/departments').then(res => res.json()),
      fetch('/api/department_allocations').then(res => res.json()),
    ]);
    setCampuses(Array.isArray(campusData) ? campusData : []);
    setBuildings(Array.isArray(buildingData) ? buildingData : []);
    setBlocks(Array.isArray(blockData) ? blockData : []);
    setFloors(Array.isArray(floorData) ? floorData : []);
    setRooms(Array.isArray(roomData) ? roomData : []);
    setDepartments(Array.isArray(departmentData) ? departmentData : []);
    setAllocations(Array.isArray(allocationData) ? allocationData : []);
  };

  useEffect(() => {
    refreshSchedulingLookups();
  }, []);

  const scheduleDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const scheduleYearOptions = ['I Year', 'II Year', 'III Year', 'IV Year'];
  const scheduleImportStatusOptions = ['Linked', 'Unmatched Room', 'Room Missing'];

  const getScheduleRoomLocation = (room: any) => {
    const floor = floors.find(item => idsMatch(item.id, room?.floor_id));
    const block = blocks.find(item => idsMatch(item.id, floor?.block_id));
    const building = buildings.find(item => idsMatch(item.id, block?.building_id));
    const campus = campuses.find(item => idsMatch(item.id, building?.campus_id));
    return { floor, block, building, campus };
  };

  const scheduleFilterBuildings = buildings
    .filter(building => !scheduleFilters.campus_id || idsMatch(building.campus_id, scheduleFilters.campus_id))
    .sort((a, b) => a.name?.localeCompare(b.name || '') || 0);

  const getScheduleFilterBlockOptions = () => {
    const selectedBuilding = buildings.find(item => idsMatch(item.id, scheduleFilters.building_id));
    if (!selectedBuilding) return [];

    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, selectedBuilding.id));
    const visibleBlocks = buildingBlocks.filter(block => !isImplicitBuildingBlock(block, selectedBuilding));
    const directBlock = buildingBlocks.find(block => isImplicitBuildingBlock(block, selectedBuilding));
    const directHasFloors = directBlock && floors.some(floor => idsMatch(floor.block_id, directBlock.id));

    return [
      ...(directHasFloors ? [{ value: directBlock.id, label: 'Direct floors' }] : []),
      ...visibleBlocks.map(block => ({ value: block.id, label: block.name })),
    ];
  };

  const getScheduleFilterFloorOptions = () => {
    if (!scheduleFilters.building_id) return [];
    const selectedBuilding = buildings.find(item => idsMatch(item.id, scheduleFilters.building_id));
    if (!selectedBuilding) return [];

    const buildingBlocks = blocks.filter(block => idsMatch(block.building_id, selectedBuilding.id));
    const allowedBlockIds = scheduleFilters.block_id
      ? [scheduleFilters.block_id]
      : buildingBlocks.map(block => block.id);

    return floors
      .filter(floor => allowedBlockIds.some(blockId => idsMatch(blockId, floor.block_id)))
      .sort((a, b) => Number(a.floor_number || 0) - Number(b.floor_number || 0))
      .map(floor => ({ value: floor.id, label: getFloorDisplayLabel(floor, blocks, buildings) }));
  };

  const roomMatchesScheduleLocationFilters = (room: any) => {
    const { floor, block, building } = getScheduleRoomLocation(room);
    if (scheduleFilters.campus_id && !idsMatch(building?.campus_id, scheduleFilters.campus_id)) return false;
    if (scheduleFilters.building_id && !idsMatch(building?.id, scheduleFilters.building_id)) return false;
    if (scheduleFilters.block_id && !idsMatch(block?.id, scheduleFilters.block_id)) return false;
    if (scheduleFilters.floor_id && !idsMatch(floor?.id, scheduleFilters.floor_id)) return false;
    return true;
  };

  const scheduleRoomOptions = rooms
    .filter(isRoomReservable)
    .filter(roomMatchesScheduleLocationFilters)
    .sort((a, b) => getRoomDisplayLabel(a, rooms).localeCompare(getRoomDisplayLabel(b, rooms)))
    .map(room => {
      const { floor, block, building } = getScheduleRoomLocation(room);
      const locationLabel = floor ? getFloorDisplayLabel(floor, blocks, buildings) : getBlockDisplayLabel(block, building);
      return {
        value: room.id,
        label: `${getRoomDisplayLabel(room, rooms)} - ${locationLabel || 'Location not set'}`,
      };
    });

  const scheduleMatchesFilters = (schedule: any) => {
    if (scheduleFilters.department_id && !idsMatch(schedule.department_id, scheduleFilters.department_id)) return false;
    if (scheduleFilters.year && getYearDisplayLabel(schedule?.year_of_study, schedule?.semester) !== scheduleFilters.year) return false;
    if (scheduleFilters.room_id && !idsMatch(schedule.room_id, scheduleFilters.room_id)) return false;
    if (scheduleFilters.day_of_week && schedule.day_of_week !== scheduleFilters.day_of_week) return false;

    if (scheduleFilters.campus_id || scheduleFilters.building_id || scheduleFilters.block_id || scheduleFilters.floor_id) {
      const room = rooms.find(item => idsMatch(item.id, schedule.room_id));
      if (!room || !roomMatchesScheduleLocationFilters(room)) return false;
    }

    return true;
  };

  const hasActiveScheduleFilters = Object.values(scheduleFilters).some(Boolean);
  const scheduleFilterControls = (
    <div className="grid grid-cols-1 md:grid-cols-4 xl:grid-cols-8 gap-3 items-end">
      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Campus</label>
        <select
          value={scheduleFilters.campus_id}
          onChange={(event) => setScheduleFilters({
            campus_id: event.target.value,
            building_id: '',
            block_id: '',
            floor_id: '',
            department_id: scheduleFilters.department_id,
            year: scheduleFilters.year,
            room_id: '',
            day_of_week: scheduleFilters.day_of_week,
          })}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All campuses</option>
          {campuses
            .slice()
            .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
            .map(campus => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Building</label>
        <select
          value={scheduleFilters.building_id}
          onChange={(event) => setScheduleFilters(prev => ({
            ...prev,
            building_id: event.target.value,
            block_id: '',
            floor_id: '',
            room_id: '',
          }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All buildings</option>
          {scheduleFilterBuildings.map(building => <option key={building.id} value={building.id}>{building.name}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Block / Direct Floors</label>
        <select
          value={scheduleFilters.block_id}
          onChange={(event) => setScheduleFilters(prev => ({
            ...prev,
            block_id: event.target.value,
            floor_id: '',
            room_id: '',
          }))}
          disabled={!scheduleFilters.building_id}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 disabled:text-slate-400"
        >
          <option value="">All blocks/direct floors</option>
          {getScheduleFilterBlockOptions().map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Floor</label>
        <select
          value={scheduleFilters.floor_id}
          onChange={(event) => setScheduleFilters(prev => ({ ...prev, floor_id: event.target.value, room_id: '' }))}
          disabled={!scheduleFilters.building_id}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-slate-100 disabled:text-slate-400"
        >
          <option value="">All floors</option>
          {getScheduleFilterFloorOptions().map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Department</label>
        <select
          value={scheduleFilters.department_id}
          onChange={(event) => setScheduleFilters(prev => ({ ...prev, department_id: event.target.value }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All departments</option>
          {departments
            .slice()
            .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
            .map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Year</label>
        <select
          value={scheduleFilters.year}
          onChange={(event) => setScheduleFilters(prev => ({ ...prev, year: event.target.value }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All years</option>
          {scheduleYearOptions.map(year => <option key={year} value={year}>{year}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Room</label>
        <select
          value={scheduleFilters.room_id}
          onChange={(event) => setScheduleFilters(prev => ({ ...prev, room_id: event.target.value }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All rooms</option>
          {scheduleRoomOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Day</label>
        <select
          value={scheduleFilters.day_of_week}
          onChange={(event) => setScheduleFilters(prev => ({ ...prev, day_of_week: event.target.value }))}
          className="w-full px-3 py-2 border border-slate-200 rounded-xl bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <option value="">All days</option>
          {scheduleDays.map(day => <option key={day} value={day}>{day}</option>)}
        </select>
      </div>

      <button
        type="button"
        onClick={() => setScheduleFilters({ campus_id: '', building_id: '', block_id: '', floor_id: '', department_id: '', year: '', room_id: '', day_of_week: '' })}
        disabled={!hasActiveScheduleFilters}
        className="px-4 py-2 border border-slate-200 rounded-xl text-slate-700 font-semibold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Clear Filters
      </button>
    </div>
  );

  const fields = [
    { key: 'schedule_id', label: 'Schedule ID' },
    { key: 'department_id', label: 'Department', type: 'select', options: departments.map(d => ({ value: d.id, label: d.name })) },
    {
      key: 'year_of_study',
      label: 'Year',
      formOnly: true,
      type: 'select',
      required: false,
      options: scheduleYearOptions,
    },
    {
      key: 'year_label',
      label: 'Year',
      tableOnly: true,
      render: (schedule: any) => getYearDisplayLabel(schedule?.year_of_study, schedule?.semester),
    },
    { key: 'section', label: 'Section' },
    {
      key: 'semester',
      label: 'Semester',
      type: 'select',
      options: (formData: any) => getScheduleSemesterOptions(formData.year_of_study),
      render: (schedule: any) => normalizeExactSemesterValue(schedule?.semester, schedule?.year_of_study, schedule?.semester || '-') || '-',
    },
    { key: 'course_code', label: 'Course Code' },
    { key: 'course_name', label: 'Course Name' },
    { key: 'faculty', label: 'Faculty' },
    {
      key: 'room_id',
      label: 'Room',
      type: 'select',
      options: scheduleRoomOptions,
      render: (schedule: any) => {
        const room = rooms.find(item => idsMatch(item.id, schedule.room_id));
        if (room) return getRoomDisplayLabel(room, rooms);
        return schedule.room_label ? `Unmatched: ${schedule.room_label}` : 'Unassigned';
      },
    },
    { key: 'day_of_week', label: 'Day', type: 'select', options: scheduleDays },
    { key: 'start_time', label: 'Start Time', type: 'time' },
    { key: 'end_time', label: 'End Time', type: 'time' },
    { key: 'import_status', label: 'Import Status', tableOnly: true },
    {
      key: 'import_status',
      label: 'Import Status',
      formOnly: true,
      type: 'select',
      required: false,
      options: scheduleImportStatusOptions,
    },
    { key: 'review_note', label: 'Review Note', tableOnly: true },
    { key: 'review_note', label: 'Review Note', formOnly: true, required: false, fullWidth: true },
  ];

  const findDepartmentForSchedule = (value: unknown) =>
    departments.find(department =>
      normalizeLookupValue(department.name) === normalizeLookupValue(value) ||
      normalizeLookupValue(department.department_id) === normalizeLookupValue(value)
    );

  const normalizeScheduleImportStatus = (value: unknown) => {
    const normalized = normalizeLookupValue(value);
    if (!normalized) return null;
    if (normalized === 'linked') return 'Linked';
    if (normalized === 'unmatched room') return 'Unmatched Room';
    if (normalized === 'room missing') return 'Room Missing';
    return null;
  };

  const prepareScheduleFormData = (item: any) => ({
    ...item,
    year_of_study: getYearDisplayLabel(item?.year_of_study, item?.semester) !== '-'
      ? getYearDisplayLabel(item?.year_of_study, item?.semester)
      : '',
    semester: normalizeExactSemesterValue(item?.semester, item?.year_of_study, item?.semester || ''),
    import_status: item?.import_status || '',
    review_note: item?.review_note || '',
  });

  const prepareScheduleSubmitData = (data: any) => {
    const selectedRoom = rooms.find(room => idsMatch(room.id, data.room_id));
    const normalizedSemester = normalizeExactSemesterValue(data.semester, data.year_of_study, '');
    const derivedYearNumber = getYearNumberFromAcademicContext(data.year_of_study, normalizedSemester);
    const inferredImportStatus = selectedRoom ? 'Linked' : 'Room Missing';

    return {
      ...data,
      room_id: data.room_id || null,
      semester: normalizedSemester || data.semester,
      year_of_study: derivedYearNumber ? derivedYearNumber.toString() : normalizeYearOfStudyValue(data.year_of_study) || null,
      import_status: normalizeScheduleImportStatus(data.import_status) || inferredImportStatus,
      review_note: data.review_note?.toString().trim() || null,
    };
  };

  const ensureAllocationFromSchedule = async (room: any, department: any, semesterValue: unknown) => {
    if (!room?.id || !department?.id || !department?.school_id) return null;

    const payload = {
      school_id: department.school_id,
      department_id: department.id,
      room_id: room.id,
      semester: normalizeSemesterValue(semesterValue),
      room_type: room.room_type,
      capacity: room.capacity || 1,
    };

    const savedAllocation = await upsertImportRecord('/api/department_allocations', payload, [
      ['room_id', 'department_id', 'semester'],
    ]);

    setAllocations(prev => {
      const existingIndex = prev.findIndex(allocation => allocation.id?.toString() === savedAllocation.id?.toString());
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], ...savedAllocation };
        return next;
      }
      return [...prev, savedAllocation];
    });

    return savedAllocation;
  };

  const handleImport = async (data: any[]) => {
    let importedCount = 0;
    let linkedCount = 0;
    let unmatchedRoomCount = 0;
    let ambiguousRoomCount = 0;
    let skippedCount = 0;

    for (const row of data) {
      const scheduleId = row['Schedule ID']?.toString().trim();
      const courseName = row['Course Name']?.toString().trim();
      const dayOfWeek = row['Day']?.toString().trim();
      const startTime = formatExcelTime(row['Start Time']);
      const endTime = formatExcelTime(row['End Time']);
      const roomLabel = getImportValue(row, ['Room', 'Room Number'])?.toString().trim() || '';
      const section = getImportValue(row, ['Section'])?.toString().trim() || '';

      if (!scheduleId || !courseName || !dayOfWeek || !startTime || !endTime) {
        skippedCount += 1;
        continue;
      }

      const roomResolution = resolveRoomForImport(rooms, roomLabel);
      const room = roomResolution.room;
      const dept = findDepartmentForSchedule(row['Department']);
      const inferredImportStatus = room
        ? 'Linked'
        : roomLabel
          ? 'Unmatched Room'
          : 'Room Missing';
      const importStatus = normalizeScheduleImportStatus(getImportValue(row, ['Import Status'])) || inferredImportStatus;
      const normalizedImportStatus = room ? importStatus : (roomLabel ? 'Unmatched Room' : 'Room Missing');
      const reviewNote = room
        ? (row['Review Note'] || null)
        : (row['Review Note'] || roomResolution.note || 'Room label from import did not match a unique room in Room Management.');
      const normalizedYear = normalizeYearOfStudyValue(getImportValue(row, ['Year', 'Year / Semester'])) ||
        normalizeYearOfStudyValue(getImportValue(row, ['Semester', 'Term']));
      const normalizedSemester = normalizeExactSemesterValue(getImportValue(row, ['Semester', 'Term']), normalizedYear, '');
      const derivedYearNumber = getYearNumberFromAcademicContext(normalizedYear, normalizedSemester);
      
      const payload = {
        schedule_id: scheduleId,
        department_id: dept?.id,
        year_of_study: derivedYearNumber ? derivedYearNumber.toString() : normalizedYear || null,
        section: section || null,
        course_code: row['Course Code'],
        course_name: courseName,
        faculty: row['Faculty'],
        room_id: room?.id ?? null,
        room_label: roomLabel || null,
        day_of_week: dayOfWeek,
        start_time: startTime,
        end_time: endTime,
        semester: normalizedSemester || null,
        import_status: normalizedImportStatus,
        review_note: reviewNote,
        source_file: row['Source File'] || null,
      };

      await upsertImportRecord('/api/schedules', payload, [['schedule_id'], ['room_id', 'section', 'day_of_week', 'start_time', 'end_time'], ['room_label', 'section', 'day_of_week', 'start_time', 'end_time']]);
      importedCount += 1;
      if (room) linkedCount += 1;
      else {
        unmatchedRoomCount += 1;
        if (roomResolution.reason === 'ambiguous') ambiguousRoomCount += 1;
      }
      await ensureAllocationFromSchedule(room, dept, normalizedSemester || getImportValue(row, ['Semester', 'Term']));
    }
    setRefreshKey(prev => prev + 1);
    await refreshSchedulingLookups();

    const ambiguousText = ambiguousRoomCount > 0
      ? `, ${ambiguousRoomCount} ambiguous labels kept unmatched`
      : '';
    return {
      message: `Schedule import complete. Imported/updated ${importedCount} rows (${linkedCount} linked to rooms, ${unmatchedRoomCount} kept for review${ambiguousText}). Skipped ${skippedCount} non-schedule rows.`,
    };
  };

  const handleFileUpload = async (file: File) => {
    setIsExtracting(true);
    try {
      const supportedTypes = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ];
      if (!supportedTypes.includes(file.type)) {
        throw new Error("Unsupported file type. Please upload a PDF or DOCX file.");
      }

      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Failed to read timetable file.'));
        reader.readAsDataURL(file);
      });

      const extractResponse = await fetch('/api/ai/extract-timetable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          data: fileData,
        }),
      });
      const extractResult = await extractResponse.json().catch(() => ({}));
      if (!extractResponse.ok) {
        throw new Error(extractResult?.error || 'Failed to extract timetable.');
      }

      const extractedSchedules = extractResult.schedules;
      
      if (Array.isArray(extractedSchedules)) {
        const validSchedules = extractedSchedules
          .map(sanitizeExtractedSchedule)
          .filter(Boolean);

        let importedCount = 0;
        let linkedCount = 0;
        let unmatchedRoomCount = 0;
        let ambiguousRoomCount = 0;

        for (const schedule of validSchedules) {
          const roomResolution = resolveRoomForImport(rooms, schedule.room);
          const room = roomResolution.room;
          const dept = findDepartmentForSchedule(schedule.department);
          const reviewNote = room
            ? null
            : roomResolution.note || 'Room label from AI import did not match a unique room in Room Management.';

          const payload = {
            schedule_id: `SCH-${Math.random().toString(36).substring(2, 9).toUpperCase()}`,
            department_id: dept?.id ?? null,
            section: schedule.section || null,
            course_code: schedule.course_code || null,
            course_name: schedule.course_name,
            faculty: schedule.faculty || 'TBA',
            room_id: room?.id ?? null,
            room_label: schedule.room || null,
            day_of_week: schedule.day_of_week,
            start_time: schedule.start_time,
            end_time: schedule.end_time,
            student_count: schedule.student_count ?? null,
            year_of_study: normalizeYearOfStudyValue(schedule.year_of_study, getYearNumberFromAcademicContext('', schedule.semester)?.toString() || ''),
            semester: normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, ''),
            import_status: room ? 'Linked' : 'Unmatched Room',
            review_note: reviewNote,
            source_file: file.name,
          };

          await upsertImportRecord('/api/schedules', payload, [
            ['schedule_id'],
            ['room_id', 'section', 'day_of_week', 'start_time', 'end_time'],
            ['room_label', 'section', 'day_of_week', 'start_time', 'end_time'],
          ]);
          importedCount += 1;
          if (room) {
            linkedCount += 1;
            await ensureAllocationFromSchedule(room, dept, schedule.semester);
          } else {
            unmatchedRoomCount += 1;
            if (roomResolution.reason === 'ambiguous') ambiguousRoomCount += 1;
          }
        }
        setRefreshKey(prev => prev + 1);
        await refreshSchedulingLookups();

        if (importedCount === 0) {
          throw new Error('Timetable was read, but no usable schedule rows were extracted from the file.');
        }

        const ambiguousText = ambiguousRoomCount > 0
          ? `, ${ambiguousRoomCount} ambiguous labels kept unmatched`
          : '';
        alert(`Successfully extracted and imported ${importedCount} schedule entries (${linkedCount} linked to rooms, ${unmatchedRoomCount} kept for review${ambiguousText}).`);
      }
    } catch (err: any) {
      console.error(err);
      let msg = err.message || 'Unknown error';
      if (msg === 'Failed to fetch') {
        msg = 'Network connection to the timetable extraction API was interrupted. This usually means the serverless function timed out or restarted before sending a response. Please try again.';
      }
      const invalidKey = /API key not valid|API_KEY_INVALID|Invalid API Key/i.test(msg);
      if (invalidKey) {
        msg = `${msg}. Please set a valid GEMINI_API_KEY on the backend and restart the server.`;
      }
      alert(`Failed to extract timetable: ${msg}`);
    } finally {
      setIsExtracting(false);
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="space-y-6">
      {/* AI Upload Zone */}
      <div 
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={cn(
          "relative p-8 border-2 border-dashed rounded-2xl transition-all flex flex-col items-center justify-center text-center gap-4",
          dragActive ? "border-emerald-500 bg-emerald-50/50" : "border-slate-200 bg-white",
          isExtracting && "opacity-50 pointer-events-none"
        )}
      >
        <div className={cn(
          "w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg transition-colors",
          dragActive ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-400"
        )}>
          {isExtracting ? (
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
          ) : (
            <Sparkles size={32} />
          )}
        </div>
        <div>
          <h3 className="text-lg font-bold text-slate-800">AI Timetable Importer</h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto mt-1">
            Drag and drop your PDF or DOCX timetable here. Our AI will automatically extract all schedules and populate the database.
          </p>
        </div>
        <input 
          type="file" 
          className="absolute inset-0 opacity-0 cursor-pointer" 
          accept=".pdf,.docx"
          onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])}
        />
        {isExtracting && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/80 rounded-2xl">
            <div className="flex flex-col items-center gap-3">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-500"></div>
              <p className="text-sm font-bold text-slate-800">AI is analyzing your document...</p>
              <p className="text-xs text-slate-500 italic">This may take a few seconds</p>
            </div>
          </div>
        )}
      </div>
      <GenericCRUD
        key={refreshKey}
        type="Schedule"
        fields={fields}
        apiPath="/api/schedules"
        onImport={handleImport}
        prepareFormData={prepareScheduleFormData}
        prepareSubmitData={prepareScheduleSubmitData}
        dataFilter={scheduleMatchesFilters}
        filterControls={scheduleFilterControls}
      />
    </div>
  );
}

function BookingManagement() {
  const { user } = useAuth();
  const location = useLocation();
  const getToday = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const addHoursToTime = (time: string, duration: string) => {
    const [hours, minutes] = time.split(':').map(Number);
    const end = new Date();
    end.setHours(hours, minutes || 0, 0, 0);
    end.setMinutes(end.getMinutes() + Math.round((parseFloat(duration) || 1) * 60));
    return `${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
  };

  const isPastSearchTime = () => {
    const selected = new Date(`${searchCriteria.date}T${searchCriteria.time}`);
    return selected.getTime() < Date.now();
  };

  const [searchCriteria, setSearchCriteria] = useState({
    date: getToday(),
    time: '09:00',
    durationUnit: 'hours',
    duration: '1',
    dailyDuration: '8',
    members: '30',
    buildingId: '',
    blockId: '',
    floorId: '',
    departmentId: '',
    semester: '',
    section: '',
    roomType: '',
    equipment: '',
    sortBy: 'best-fit'
  });
  const [vacantRooms, setVacantRooms] = useState<any[]>([]);
  const [combinedOptions, setCombinedOptions] = useState<any[]>([]);
  const [myBookings, setMyBookings] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [academicCalendars, setAcademicCalendars] = useState<any[]>([]);
  const [timingProfiles, setTimingProfiles] = useState<any[]>([]);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [bookingMessage, setBookingMessage] = useState<{ type: 'error' | 'success'; text: string } | null>(null);
  const [bookingModal, setBookingModal] = useState<{ rooms: any[]; combined?: boolean } | null>(null);
  const [bookingForm, setBookingForm] = useState({
    eventName: '',
    purpose: '',
    departmentId: '',
    equipmentRequired: '',
    notes: '',
    recurring: false,
    recurringWeeks: '2'
  });
  const [statusTab, setStatusTab] = useState('Active');
  const [bookingSearch, setBookingSearch] = useState('');
  const [selectedRoomForSchedule, setSelectedRoomForSchedule] = useState<any>(null);
  const [roomSchedule, setRoomSchedule] = useState<any>(null);
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);

  const fetchMyBookings = async () => {
    const res = await fetch('/api/bookings', { credentials: 'include' });
    const data = await res.json();
    setMyBookings(data.filter((b: any) => b.faculty_name === user?.name || canApproveBookings || canRecommendBookings));
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedStatus = params.get('status');
    const allowedStatuses = ['Active', 'Pending', 'HOD Recommended', 'Approved', 'Postponed', 'Rejected', 'Past'];
    setStatusTab(requestedStatus && allowedStatuses.includes(requestedStatus) ? requestedStatus : 'Active');
  }, [location.search]);

  useEffect(() => {
    fetchMyBookings();
    Promise.all([
      fetch('/api/rooms', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/floors', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/blocks', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/buildings', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/departments', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/academic_calendars', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/timing_profiles', { credentials: 'include' }).then(res => res.json()),
      fetch('/api/equipment', { credentials: 'include' }).then(res => res.json())
    ]).then(([roomData, floorData, blockData, buildingData, departmentData, calendarData, timingProfileData, equipmentData]) => {
      const safeRooms = Array.isArray(roomData) ? roomData : [];
      const safeFloors = Array.isArray(floorData) ? floorData : [];
      const safeBlocks = Array.isArray(blockData) ? blockData : [];
      const safeBuildings = Array.isArray(buildingData) ? buildingData : [];
      setRooms(safeRooms);
      setFloors(safeFloors);
      setBlocks(safeBlocks);
      setBuildings(safeBuildings);
      setDepartments(Array.isArray(departmentData) ? departmentData : []);
      setAcademicCalendars(Array.isArray(calendarData) ? calendarData : []);
      setTimingProfiles(Array.isArray(timingProfileData) ? timingProfileData : []);
      setEquipment(Array.isArray(equipmentData) ? equipmentData : []);

      const params = new URLSearchParams(location.search);
      const requestedRoomId = params.get('roomId');
      const requestedRoomLabel = params.get('room');
      const requestedDepartmentId = params.get('departmentId') || '';
      const requestedSemester = normalizeExactSemesterValue(params.get('semester'), params.get('year'), '');
      const requestedSection = params.get('section')?.trim() || '';
      const requestedRoom = requestedRoomId
        ? safeRooms.find(room => idsMatch(room.id, requestedRoomId))
        : findRoomByImportLabel(safeRooms, requestedRoomLabel);
      setSearchCriteria(prev => ({
        ...prev,
        departmentId: requestedDepartmentId || prev.departmentId,
        semester: requestedSemester || prev.semester,
        section: requestedSection || prev.section,
      }));
      if (requestedRoom) {
        const floor = safeFloors.find(item => idsMatch(item.id, requestedRoom.floor_id));
        const block = safeBlocks.find(item => idsMatch(item.id, floor?.block_id));
        const building = safeBuildings.find(item => idsMatch(item.id, block?.building_id));
        const memberHint = parseInt(requestedRoom.capacity, 10);
        setBookingSearch(getRoomDisplayLabel(requestedRoom, safeRooms));
        setSearchCriteria(prev => ({
          ...prev,
          buildingId: building?.id?.toString() || prev.buildingId,
          blockId: block && building && isImplicitBuildingBlock(block, building) ? '__direct__' : block?.id?.toString() || prev.blockId,
          floorId: floor?.id?.toString() || prev.floorId,
          roomType: requestedRoom.room_type || prev.roomType,
          members: Number.isFinite(memberHint) && memberHint > 0 ? String(Math.min(memberHint, parseInt(prev.members, 10) || memberHint)) : prev.members,
        }));
      } else if (requestedRoomLabel) {
        setBookingSearch(requestedRoomLabel);
      }
    }).catch(console.error);
  }, [location.search]);

  const canDirectDecideBookings = ['Administrator', 'Dean (P&M)'].includes(user?.role);
  const canDeputyDecideBookings = user?.role === 'Deputy Dean (P&M)';
  const canRecommendBookings = user?.role === 'HOD';
  const canApproveBookings = canDirectDecideBookings || canDeputyDecideBookings;
  const canChooseAnyRequestDepartment = canApproveBookings || user?.role === 'Administrator';
  const userDepartmentId = departments.find(dept => normalizeLookupValue(dept.name) === normalizeLookupValue(user?.department))?.id?.toString() || '';
  const bookingDepartmentOptions = canChooseAnyRequestDepartment || !user?.department
    ? departments
    : departments.filter(dept => normalizeLookupValue(dept.name) === normalizeLookupValue(user.department));
  const selectedAcademicContextLabel = [
    departments.find(dept => idsMatch(dept.id, searchCriteria.departmentId))?.name,
    searchCriteria.semester,
    searchCriteria.section ? `Section ${searchCriteria.section}` : '',
  ].filter(Boolean).join(' • ');

  const selectedBookingTimingProfile = useMemo(() => resolveTimingProfileForContext({
    timingProfiles,
    academicCalendars,
    activeDate: searchCriteria.date,
    context: {
      department_id: searchCriteria.departmentId,
      year_of_study: normalizeYearOfStudyValue(getYearNumberFromAcademicContext('', searchCriteria.semester)?.toString() || '', ''),
      semester: searchCriteria.semester,
      section: searchCriteria.section,
    },
  }), [academicCalendars, searchCriteria.date, searchCriteria.departmentId, searchCriteria.section, searchCriteria.semester, timingProfiles]);
  const selectedBookingTimingSlots = useMemo(
    () => parseTimingProfileSlots(selectedBookingTimingProfile?.slot_pattern),
    [selectedBookingTimingProfile],
  );

  useEffect(() => {
    const interval = window.setInterval(fetchMyBookings, 10000);
    return () => window.clearInterval(interval);
  }, [user?.name, user?.role, user?.department]);

  const activeDailyDuration = searchCriteria.durationUnit === 'hours' ? searchCriteria.duration : searchCriteria.dailyDuration;
  const bookingEndTime = addHoursToTime(searchCriteria.time, activeDailyDuration);
  const getBookingDates = () => {
    const count = Math.max(1, parseInt(searchCriteria.duration, 10) || 1);
    const totalDays = searchCriteria.durationUnit === 'weeks' ? count * 7 : searchCriteria.durationUnit === 'days' ? count : 1;
    return Array.from({ length: totalDays }, (_, index) => {
      const date = new Date(`${searchCriteria.date}T00:00:00`);
      date.setDate(date.getDate() + index);
      return formatLocalDate(date);
    });
  };
  const getDurationLabel = () => {
    if (searchCriteria.durationUnit === 'hours') {
      if (searchCriteria.duration === '0.5') return `30 minutes (${searchCriteria.time} - ${bookingEndTime})`;
      return `${searchCriteria.duration} hour${searchCriteria.duration === '1' ? '' : 's'} (${searchCriteria.time} - ${bookingEndTime})`;
    }
    const count = parseInt(searchCriteria.duration, 10) || 1;
    const unit = searchCriteria.durationUnit === 'weeks' ? 'week' : 'day';
    return `${count} ${unit}${count === 1 ? '' : 's'} (${searchCriteria.time} - ${bookingEndTime} each day)`;
  };
  const getBookingItems = (booking: any) => booking.bookingItems || [booking];
  function getBookingRoomNumber(booking: any) {
    if (booking.room_numbers?.length) return booking.room_numbers.join(', ');
    const room = rooms.find(item => item.id == booking.room_id);
    return room ? getRoomDisplayLabel(room, rooms) : booking.room_number || 'Not selected';
  }
  const groupedBookings = useMemo(() => {
    const groups = new Map<string, any[]>();

    myBookings.forEach((booking: any) => {
      const key = booking.request_group_id || `single-${booking.id}`;
      const existing = groups.get(key) || [];
      existing.push(booking);
      groups.set(key, existing);
    });

    return Array.from(groups.entries()).map(([key, group]) => {
      const items = [...group].sort((a, b) => {
        const dateCompare = (a.date || '').localeCompare(b.date || '');
        if (dateCompare !== 0) return dateCompare;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
      const primary = items[0];
      const roomNumbers = Array.from(new Set(items.map(item => getBookingRoomNumber(item)).filter(Boolean)));
      const dates = Array.from(new Set(items.map(item => item.date).filter(Boolean)));
      const statuses = Array.from(new Set(items.map(item => item.status).filter(Boolean)));

      return {
        ...primary,
        id: primary.id,
        request_group_id: key.startsWith('single-') ? null : key,
        bookingItems: items,
        room_numbers: roomNumbers,
        booking_dates: dates,
        grouped_count: items.length,
        grouped_room_count: roomNumbers.length,
        room_number: roomNumbers.join(', '),
        status: statuses.length === 1 ? statuses[0] : primary.status,
      };
    });
  }, [myBookings]);
  const getBookingDateLabel = (booking: any) => {
    const dates = booking.booking_dates || [booking.date];
    if (!dates.length) return 'Date not set';
    if (dates.length === 1) return dates[0];

    const sortedDates = [...dates].sort();
    const isConsecutive = sortedDates.every((date: string, index: number) => {
      if (index === 0) return true;
      const previous = new Date(`${sortedDates[index - 1]}T00:00:00`);
      const current = new Date(`${date}T00:00:00`);
      return Math.round((current.getTime() - previous.getTime()) / 86400000) === 1;
    });

    if (isConsecutive) {
      return `${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`;
    }

    return `${sortedDates[0]} +${sortedDates.length - 1} more date${sortedDates.length > 2 ? 's' : ''}`;
  };
  const getBookingTimeLabel = (booking: any) => `${booking.start_time} - ${booking.end_time}`;
  const selectedBuilding = buildings.find(b => b.id == searchCriteria.buildingId);
  const selectedBuildingBlocks = blocks.filter(block => block.building_id == searchCriteria.buildingId);
  const visibleBlocks = selectedBuilding ? selectedBuildingBlocks.filter(block => !isImplicitBuildingBlock(block, selectedBuilding)) : [];
  const directBlock = selectedBuilding ? selectedBuildingBlocks.find(block => isImplicitBuildingBlock(block, selectedBuilding)) : null;
  const floorOptions = floors.filter(floor => {
    if (!searchCriteria.buildingId) return true;
    if (searchCriteria.blockId === '__direct__') return idsMatch(directBlock?.id, floor.block_id);
    if (searchCriteria.blockId) return floor.block_id == searchCriteria.blockId;
    return selectedBuildingBlocks.some(block => idsMatch(block.id, floor.block_id));
  });
  const roomTypes = Array.from(new Set(rooms.filter(isRoomReservable).map(room => room.room_type).filter(Boolean))).sort();
  const equipmentNames = Array.from(new Set(equipment.map(item => item.name).filter(Boolean))).sort();
  const getRoomDetails = (room: any) => {
    const fullRoom = room ? (rooms.find(r => idsMatch(r.id, room.id)) || room) : null;
    const floor = floors.find(f => idsMatch(f.id, fullRoom?.floor_id));
    const block = floor ? blocks.find(b => idsMatch(b.id, floor.block_id)) : null;
    const building = block ? buildings.find(b => idsMatch(b.id, block.building_id)) : null;
    return { floor, block, building };
  };
  const getRoomPath = (room: any) => {
    const { floor, block, building } = getRoomDetails(room);
    const blockLabel = block && building && !isImplicitBuildingBlock(block, building) ? ` - ${block.name}` : '';
    return `${building?.name || 'Building not set'}${blockLabel} - ${floor ? getFloorName(floor.floor_number) : 'Floor not set'}`;
  };
  const getRoomEquipment = (roomId: number) => equipment.filter(item => item.room_id === roomId).map(item => item.name).filter(Boolean);
  const scheduleMatchesSelectedAcademicContext = (schedule: any) => {
    if (searchCriteria.departmentId && !idsMatch(schedule.department_id, searchCriteria.departmentId)) return false;
    if (searchCriteria.semester && normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, '') !== searchCriteria.semester) return false;
    if (searchCriteria.section && (schedule.section?.toString().trim() || '') !== searchCriteria.section.trim()) return false;
    return true;
  };
  const filterAndSortRooms = (roomList: any[]) => {
    const requestedCapacity = parseInt(searchCriteria.members, 10) || 0;
    return roomList.filter(room => {
      const { floor, block, building } = getRoomDetails(room);
      if (searchCriteria.buildingId && building?.id != searchCriteria.buildingId) return false;
      if (searchCriteria.blockId === '__direct__' && block && building && !isImplicitBuildingBlock(block, building)) return false;
      if (searchCriteria.blockId && searchCriteria.blockId !== '__direct__' && block?.id != searchCriteria.blockId) return false;
      if (searchCriteria.floorId && floor?.id != searchCriteria.floorId) return false;
      if (searchCriteria.roomType && room.room_type !== searchCriteria.roomType) return false;
      if (searchCriteria.equipment && !getRoomEquipment(room.id).some(name => name.toLowerCase().includes(searchCriteria.equipment.toLowerCase()))) return false;
      return true;
    }).sort((a, b) => {
      const aDetails = getRoomDetails(a);
      const bDetails = getRoomDetails(b);
      if (searchCriteria.sortBy === 'largest-capacity') return (b.capacity || 0) - (a.capacity || 0);
      if (searchCriteria.sortBy === 'building') return (aDetails.building?.name || '').localeCompare(bDetails.building?.name || '');
      if (searchCriteria.sortBy === 'room-number') return a.room_number.toString().localeCompare(b.room_number.toString(), undefined, { numeric: true });
      return Math.abs((a.capacity || 0) - requestedCapacity) - Math.abs((b.capacity || 0) - requestedCapacity);
    });
  };
  const getDisplayStatus = (booking: any) => {
    const bookingDates = booking.booking_dates || [booking.date];
    const lastDate = [...bookingDates].filter(Boolean).sort().at(-1) || booking.date;
    const bookingEnd = new Date(`${lastDate}T${booking.end_time || booking.start_time || '00:00'}`);
    return booking.status === 'Approved' && bookingEnd.getTime() < Date.now() ? 'Past' : booking.status || 'Pending';
  };
  const filteredBookings = groupedBookings.filter(booking => {
    const displayStatus = getDisplayStatus(booking);
    if (user?.role === 'HOD') {
      const bookingDepartmentName = booking.department_name || departments.find(department => department.id === booking.department_id)?.name;
      if (user.department && booking.faculty_name !== user?.name && bookingDepartmentName !== user.department) return false;
    }
    if (statusTab === 'Active' && displayStatus === 'Past') return false;
    if (statusTab !== 'Active' && displayStatus !== statusTab) return false;
    const query = bookingSearch.toLowerCase();
    return !query || [booking.event_name, getBookingRoomNumber(booking), booking.faculty_name, getBookingDateLabel(booking), displayStatus]
      .some(value => value?.toString().toLowerCase().includes(query));
  });

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBookingMessage(null);
    if (isPastSearchTime()) {
      setBookingMessage({ type: 'error', text: 'Please select a current or future date and time.' });
      setVacantRooms([]);
      setCombinedOptions([]);
      setIsSearching(false);
      return;
    }
    if ((parseFloat(searchCriteria.duration) || 0) <= 0 || (parseFloat(activeDailyDuration) || 0) <= 0 || (parseInt(searchCriteria.members, 10) || 0) <= 0) {
      setBookingMessage({ type: 'error', text: 'Duration and members must be greater than zero.' });
      return;
    }

    setLoading(true);
    setIsSearching(true);
    try {
      const bookingDates = getBookingDates();
      const availableByDate = await Promise.all(bookingDates.map(async date => {
        const params = new URLSearchParams({
          date,
          time: searchCriteria.time,
          duration: activeDailyDuration,
          members: searchCriteria.members
        });
        const res = await fetch(`/api/rooms/vacant?${params.toString()}`, { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Failed to search vacant rooms for ${date}.`);
        return data;
      }));
      const commonRoomIds = availableByDate.reduce((common: Set<number> | null, roomList) => {
        const ids = new Set(roomList.map((room: any) => room.id));
        if (!common) return ids;
        return new Set([...common].filter(id => ids.has(id)));
      }, null);
      const allCandidateRooms = availableByDate[0] || [];
      const filteredRooms = filterAndSortRooms(allCandidateRooms.filter((room: any) => commonRoomIds?.has(room.id)));
      setVacantRooms(filteredRooms);

      const eventParams = new URLSearchParams({
        date: searchCriteria.date,
        startTime: searchCriteria.time,
        endTime: bookingEndTime,
        strength: searchCriteria.members
      });
      const eventRes = await fetch(`/api/events/search-rooms?${eventParams.toString()}`, { credentials: 'include' });
      const eventData = eventRes.ok ? await eventRes.json() : { multiOptions: [] };
      const filteredCombined = (eventData.multiOptions || [])
        .map((option: any) => ({ ...option, rooms: filterAndSortRooms((option.rooms || []).filter((room: any) => commonRoomIds?.has(room.id))) }))
        .filter((option: any) => option.rooms.length > 1 && option.rooms.reduce((sum: number, room: any) => sum + (room.capacity || 0), 0) >= (parseInt(searchCriteria.members, 10) || 0));
      setCombinedOptions(filteredCombined);
      if (filteredRooms.length === 0) {
        setBookingMessage({
          type: 'error',
          text: filteredCombined.length > 0 ? 'No single room matched. Combined room options are available below.' : 'No rooms matched. Try removing filters, changing time, or lowering capacity.'
        });
      }
    } catch (err) {
      console.error(err);
      setBookingMessage({ type: 'error', text: 'Failed to search vacant rooms. Please try again.' });
    } finally {
      setLoading(false);
    }
  };

  const openBookingModal = (bookingRooms: any[], combined = false) => {
    setBookingMessage(null);
    setBookingForm({
      eventName: '',
      purpose: '',
      departmentId: searchCriteria.departmentId || userDepartmentId,
      equipmentRequired: searchCriteria.equipment,
      notes: '',
      recurring: false,
      recurringWeeks: '2'
    });
    setBookingModal({ rooms: bookingRooms, combined });
  };

  const handleBook = async () => {
    if (!bookingModal) return;
    setBookingMessage(null);
    if (isPastSearchTime()) {
      setBookingMessage({ type: 'error', text: 'Please select a current or future date and time.' });
      return;
    }
    if (!bookingForm.eventName.trim()) {
      setBookingMessage({ type: 'error', text: 'Event name is required.' });
      return;
    }
    if (!bookingForm.departmentId) {
      setBookingMessage({ type: 'error', text: 'Please select a department so the request can go to the respective HOD.' });
      return;
    }
    const status = canDirectDecideBookings ? 'Approved' : 'Pending';
    const bookingDates = searchCriteria.durationUnit === 'hours' && bookingForm.recurring
      ? Array.from({ length: Math.max(1, parseInt(bookingForm.recurringWeeks, 10) || 1) }, (_, week) => {
        const bookingDate = new Date(`${searchCriteria.date}T00:00:00`);
        bookingDate.setDate(bookingDate.getDate() + (week * 7));
        return formatLocalDate(bookingDate);
      })
      : getBookingDates();
    const requestGroupId = bookingDates.length > 1 || bookingModal.rooms.length > 1
      ? `REQ-GROUP-${Date.now()}`
      : null;
    const errors: string[] = [];

    for (let dateIndex = 0; dateIndex < bookingDates.length; dateIndex += 1) {
      const date = bookingDates[dateIndex];
      for (const room of bookingModal.rooms) {
        const payload = {
          request_id: `REQ-${Date.now()}-${dateIndex}-${room.id}`,
          request_group_id: requestGroupId,
          faculty_name: user?.name || 'Unknown',
          department_id: bookingForm.departmentId || null,
          event_name: bookingForm.eventName.trim(),
          purpose: bookingForm.purpose.trim(),
          notes: bookingForm.notes.trim(),
          student_count: parseInt(searchCriteria.members, 10),
          room_type: room.room_type,
          room_id: room.id,
          equipment_required: bookingForm.equipmentRequired.trim(),
          date,
          start_time: searchCriteria.time,
          end_time: bookingEndTime,
          status
        };
        const res = await fetch('/api/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'include'
        });
        if (!res.ok) {
          const err = await res.json();
          errors.push(`Room ${getRoomDisplayLabel(room, rooms)}: ${err.error || 'Operation failed'}`);
        }
      }
    }
    setBookingModal(null);
    await fetchMyBookings();
    await handleSearch({ preventDefault: () => {} } as any);
    setBookingMessage(errors.length
      ? { type: 'error', text: errors.join(' ') }
      : {
          type: 'success',
          text: status === 'Approved'
            ? 'Room booking saved successfully.'
            : requestGroupId
              ? 'Booking request submitted as a single grouped request.'
              : 'Booking request submitted for approval.'
        });
  };

  const updateBookingStatus = async (booking: any, status: string) => {
    const bookingItems = getBookingItems(booking);
    const errors: string[] = [];

    for (const item of bookingItems) {
      const res = await fetch(`/api/bookings/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        errors.push(err.error || `Failed to update booking for ${getBookingRoomNumber(item)} on ${item.date}.`);
      }
    }
    if (errors.length) {
      setBookingMessage({ type: 'error', text: errors.join(' ') });
      return;
    }
    setBookingMessage({
      type: 'success',
      text: status === 'Rejected'
        ? (booking.faculty_name === user?.name ? 'Request cancelled.' : 'Request rejected.')
        : status === 'Postponed'
          ? 'Postpone request sent to the requester.'
          : `Booking marked as ${status}.`
    });
    await fetchMyBookings();
  };

  const deleteBookingRequest = async (booking: any) => {
    if (!confirm(`Delete request "${booking.event_name || 'room request'}"? This cannot be undone.`)) return;
    const bookingItems = getBookingItems(booking);
    const errors: string[] = [];

    for (const item of bookingItems) {
      const res = await fetch(`/api/bookings/${item.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json();
        errors.push(err.error || `Failed to delete request for ${getBookingRoomNumber(item)} on ${item.date}.`);
      }
    }
    if (errors.length) {
      setBookingMessage({ type: 'error', text: errors.join(' ') });
      return;
    }
    setBookingMessage({ type: 'success', text: 'Request deleted successfully.' });
    await fetchMyBookings();
  };

  const exportBookings = () => {
    const worksheet = XLSX.utils.json_to_sheet(filteredBookings.map(booking => ({
      Event: booking.event_name,
      Faculty: booking.faculty_name,
      Room: getBookingRoomNumber(booking),
      Date: getBookingDateLabel(booking),
      Time: getBookingTimeLabel(booking),
      Status: getDisplayStatus(booking),
      Purpose: booking.purpose || '',
      Notes: booking.notes || ''
    })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Bookings');
    XLSX.writeFile(workbook, 'room-bookings-report.xlsx');
  };

  const fetchRoomSchedule = async (room: any) => {
    setSelectedRoomForSchedule(room);
    setIsScheduleModalOpen(true);
    setRoomSchedule(null);
    try {
      const res = await fetch(`/api/rooms/${room.id}/schedule?date=${searchCriteria.date}`, { credentials: 'include' });
      const data = await res.json();
      setRoomSchedule(data);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-8">
      {/* Search Section */}
      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-2">
          <Search className="text-emerald-500" />
          Find Vacant Rooms
        </h3>
        <form onSubmit={handleSearch} className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Date</label>
            <input
              type="date"
              min={getToday()}
              value={searchCriteria.date}
              onChange={e => setSearchCriteria({ ...searchCriteria, date: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Start Time</label>
            <input
              type="time"
              value={searchCriteria.time}
              onChange={e => setSearchCriteria({ ...searchCriteria, time: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Duration Type</label>
            <select
              value={searchCriteria.durationUnit}
              onChange={e => setSearchCriteria({ ...searchCriteria, durationUnit: e.target.value, duration: '1' })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
              {searchCriteria.durationUnit === 'hours' ? 'Duration' : searchCriteria.durationUnit === 'days' ? 'Number of Days' : 'Number of Weeks'}
            </label>
            <select
              value={searchCriteria.duration}
              onChange={e => setSearchCriteria({ ...searchCriteria, duration: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              {searchCriteria.durationUnit === 'hours' ? (
                <>
                  <option value="0.5">30 minutes</option>
                  <option value="1">1 hour</option>
                  <option value="1.5">1.5 hours</option>
                  <option value="2">2 hours</option>
                  <option value="2.5">2.5 hours</option>
                  <option value="3">3 hours</option>
                  <option value="3.5">3.5 hours</option>
                  <option value="4">4 hours</option>
                  <option value="4.5">4.5 hours</option>
                  <option value="5">5 hours</option>
                  <option value="5.5">5.5 hours</option>
                  <option value="6">6 hours</option>
                  <option value="6.5">6.5 hours</option>
                  <option value="7">7 hours</option>
                  <option value="7.5">7.5 hours</option>
                  <option value="8">8 hours</option>
                  <option value="8.5">8.5 hours</option>
                  <option value="9">9 hours</option>
                </>
              ) : (
                <>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="7">7</option>
                </>
              )}
            </select>
          </div>
          {searchCriteria.durationUnit !== 'hours' && (
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Daily Hours</label>
              <select
                value={searchCriteria.dailyDuration}
                onChange={e => setSearchCriteria({ ...searchCriteria, dailyDuration: e.target.value })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
              >
                <option value="1">1 hour / day</option>
                <option value="2">2 hours / day</option>
                <option value="3">3 hours / day</option>
                <option value="4">4 hours / day</option>
                <option value="5">5 hours / day</option>
                <option value="6">6 hours / day</option>
                <option value="7">7 hours / day</option>
                <option value="8">8 hours / day</option>
                <option value="9">9 hours / day</option>
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Members (Capacity)</label>
            <input
              type="number"
              value={searchCriteria.members}
              onChange={e => setSearchCriteria({ ...searchCriteria, members: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{searchCriteria.durationUnit === 'hours' ? 'End Time' : 'Daily End Time'}</label>
            <div className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-bold text-slate-700">{bookingEndTime}</div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Building</label>
            <select
              value={searchCriteria.buildingId}
              onChange={e => setSearchCriteria({ ...searchCriteria, buildingId: e.target.value, blockId: '', floorId: '' })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Buildings</option>
              {buildings.map(building => <option key={building.id} value={building.id}>{building.name}</option>)}
            </select>
          </div>
          {searchCriteria.buildingId && visibleBlocks.length > 0 && (
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Block</label>
              <select
                value={searchCriteria.blockId}
                onChange={e => setSearchCriteria({ ...searchCriteria, blockId: e.target.value, floorId: '' })}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
              >
                <option value="">All Blocks</option>
                {directBlock && <option value="__direct__">Direct floors</option>}
                {visibleBlocks.map(block => <option key={block.id} value={block.id}>{block.name}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Floor</label>
            <select
              value={searchCriteria.floorId}
              onChange={e => setSearchCriteria({ ...searchCriteria, floorId: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">All Floors</option>
              {floorOptions.map(floor => <option key={floor.id} value={floor.id}>{getFloorName(floor.floor_number)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Academic Department</label>
            <select
              value={searchCriteria.departmentId}
              onChange={e => setSearchCriteria({ ...searchCriteria, departmentId: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Any Department</option>
              {departments
                .slice()
                .sort((a, b) => a.name?.localeCompare(b.name || '') || 0)
                .map(department => <option key={department.id} value={department.id}>{department.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Academic Semester</label>
            <select
              value={searchCriteria.semester}
              onChange={e => setSearchCriteria({ ...searchCriteria, semester: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Any Semester</option>
              {SCHEDULE_SEMESTER_OPTIONS.map(semester => <option key={semester} value={semester}>{semester}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Academic Section</label>
            <input
              value={searchCriteria.section}
              onChange={e => setSearchCriteria({ ...searchCriteria, section: e.target.value })}
              placeholder="Any Section"
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Room Type</label>
            <select
              value={searchCriteria.roomType}
              onChange={e => setSearchCriteria({ ...searchCriteria, roomType: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Any Type</option>
              {roomTypes.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Equipment</label>
            <select
              value={searchCriteria.equipment}
              onChange={e => setSearchCriteria({ ...searchCriteria, equipment: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="">Any Equipment</option>
              {equipmentNames.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Sort</label>
            <select
              value={searchCriteria.sortBy}
              onChange={e => setSearchCriteria({ ...searchCriteria, sortBy: e.target.value })}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
            >
              <option value="best-fit">Best fit</option>
              <option value="largest-capacity">Largest capacity</option>
              <option value="building">Building</option>
              <option value="room-number">Room number</option>
            </select>
          </div>
          {bookingMessage && (
            <div className={cn(
              "md:col-span-4 p-3 rounded-xl border text-sm font-bold",
              bookingMessage.type === 'error' ? "bg-rose-50 border-rose-100 text-rose-700" : "bg-emerald-50 border-emerald-100 text-emerald-700"
            )}>
              {bookingMessage.text}
            </div>
          )}
          {selectedAcademicContextLabel && (
            <div className="md:col-span-4 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
              Academic context selected: <span className="font-bold">{selectedAcademicContextLabel}</span>. Vacancy still uses actual time overlaps, and this context is carried into room schedule review and request defaults for mixed-use rooms.
            </div>
          )}
          {selectedBookingTimingProfile && (
            <div className={cn(
              "md:col-span-4 rounded-xl px-3 py-2 text-xs",
              selectedBookingTimingSlots.length > 0 && selectedBookingTimingSlots.some(slot => searchCriteria.time >= slot.start_time && bookingEndTime <= slot.end_time)
                ? "border border-emerald-100 bg-emerald-50 text-emerald-700"
                : "border border-amber-100 bg-amber-50 text-amber-700"
            )}>
              Timing profile in effect: <span className="font-bold">{getTimingProfileDisplayLabel(selectedBookingTimingProfile)}</span>.
              {selectedBookingTimingSlots.length > 0 && (
                <span> Preferred slots: {selectedBookingTimingSlots.map(slot => `${slot.start_time}-${slot.end_time}`).join(', ')}.</span>
              )}
              {selectedBookingTimingSlots.length > 0 && !selectedBookingTimingSlots.some(slot => searchCriteria.time >= slot.start_time && bookingEndTime <= slot.end_time) && (
                <span> The selected request time does not fully fit inside any configured academic slot for this context, so booking overlap checks still run but this should be reviewed carefully.</span>
              )}
            </div>
          )}
          <div className="md:col-span-4 mt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Search size={18} />
              {loading ? 'Searching...' : 'Check Vacant Rooms'}
            </button>
          </div>
        </form>
      </div>

      {/* Results Section */}
      {isSearching && (
        <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-6">Vacant Rooms Found</h3>
          {vacantRooms.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {vacantRooms.map(room => (
                <div key={room.id} className="p-4 border border-slate-100 rounded-xl bg-slate-50 hover:border-emerald-200 transition-all">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="font-bold text-slate-800 text-lg">Room {getRoomDisplayLabel(room, rooms)}</h4>
                      <p className="text-xs text-slate-500">{getRoomPath(room)}</p>
                    </div>
                    <div className="px-2 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded uppercase">
                      {room.room_type}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mb-4 text-sm text-slate-600">
                    <div className="flex items-center gap-1">
                      <Users size={14} />
                      <span>Cap: {room.capacity}</span>
                    </div>
                  </div>
                  {getRoomAliasList(room).length > 0 && (
                    <p className="text-xs text-blue-600 mb-2">Aliases: {getRoomAliasList(room).join(', ')}</p>
                  )}
                  <p className="text-xs text-slate-500 mb-4">Equipment: {getRoomEquipment(room.id).join(', ') || 'No equipment recorded'}</p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openBookingModal([room])}
                      className="flex-1 py-2 bg-emerald-500 text-white font-bold rounded-lg hover:bg-emerald-600 transition-all text-sm"
                    >
                      Book Now
                    </button>
                    <button
                      onClick={() => fetchRoomSchedule(room)}
                      className="px-3 py-2 bg-slate-100 text-slate-600 font-bold rounded-lg hover:bg-slate-200 transition-all text-sm"
                      title="View Day Schedule"
                    >
                      <Calendar size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-slate-400">
              <DoorOpen size={48} className="mx-auto mb-4 opacity-20" />
              <p>No vacant rooms found for the selected criteria.</p>
            </div>
          )}
          {combinedOptions.length > 0 && (
            <div className="mt-8 pt-6 border-t border-slate-100">
              <h4 className="text-sm font-bold text-slate-800 mb-4">Combined Room Options</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {combinedOptions.map((option, index) => (
                  <div key={index} className="p-4 bg-blue-50 border border-blue-100 rounded-xl">
                    <div className="flex justify-between items-start gap-3 mb-2">
                      <div>
                        <p className="font-bold text-blue-900">Option {index + 1}</p>
                        <p className="text-xs text-blue-700">Total capacity: {option.rooms.reduce((sum: number, room: any) => sum + (room.capacity || 0), 0)}</p>
                      </div>
                      <button
                        onClick={() => openBookingModal(option.rooms, true)}
                        className="px-3 py-2 bg-blue-600 text-white text-xs font-bold rounded-lg hover:bg-blue-700"
                      >
                        Book Together
                      </button>
                    </div>
                    <p className="text-xs text-blue-800">{option.rooms.map((room: any) => `Room ${getRoomDisplayLabel(room, rooms)}`).join(', ')}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* My Bookings Section */}
      <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{canApproveBookings ? 'Current Bookings' : 'My Room Requests'}</h3>
            <p className="text-sm text-slate-500">
              {canApproveBookings ? 'Review requests raised by users and approve, reject, or request postponement.' : 'Raise room requests and track approval status here.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {['Active', 'Pending', 'HOD Recommended', 'Approved', 'Postponed', 'Rejected', 'Past'].map(tab => (
              <button
                key={tab}
                onClick={() => setStatusTab(tab)}
                className={cn(
                  "px-3 py-2 rounded-lg text-xs font-bold border",
                  statusTab === tab ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200"
                )}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col md:flex-row gap-3 mb-4">
          <input
            value={bookingSearch}
            onChange={e => setBookingSearch(e.target.value)}
            placeholder="Search bookings..."
            className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={exportBookings}
            className="px-4 py-2 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-lg font-bold flex items-center justify-center gap-2"
          >
            <FileSpreadsheet size={16} />
            Export
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="py-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Event</th>
                <th className="py-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                <th className="py-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date & Time</th>
                <th className="py-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Status</th>
                <th className="py-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map(booking => {
                const displayStatus = getDisplayStatus(booking);
                return (
                <tr key={booking.request_group_id || booking.id} className="border-b border-slate-50 hover:bg-slate-50 transition-all">
                  <td className="py-4 px-4">
                    <p className="font-bold text-slate-800">{booking.event_name}</p>
                    <p className="text-xs text-slate-500">{booking.faculty_name}</p>
                    {booking.purpose && <p className="text-xs text-slate-400">{booking.purpose}</p>}
                  </td>
                  <td className="py-4 px-4 font-medium text-slate-700">{getBookingRoomNumber(booking)}</td>
                  <td className="py-4 px-4">
                    <p className="text-sm text-slate-700">{getBookingDateLabel(booking)}</p>
                    <p className="text-xs text-slate-500">{getBookingTimeLabel(booking)}</p>
                    {booking.grouped_count > 1 && (
                      <p className="text-xs text-slate-400">{booking.grouped_count} booking entries in this request</p>
                    )}
                  </td>
                  <td className="py-4 px-4">
                    <span className={cn(
                      "px-2 py-1 text-[10px] font-bold rounded uppercase",
                      displayStatus === 'Approved' ? "bg-emerald-100 text-emerald-700" :
                      displayStatus === 'Rejected' ? "bg-rose-100 text-rose-700" :
                      displayStatus === 'HOD Recommended' ? "bg-indigo-100 text-indigo-700" :
                      displayStatus === 'Postponed' ? "bg-blue-100 text-blue-700" :
                      displayStatus === 'Past' ? "bg-slate-100 text-slate-500" : "bg-orange-100 text-orange-700"
                    )}>
                      {displayStatus}
                    </span>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex flex-wrap gap-2">
                      {canRecommendBookings && displayStatus === 'Pending' && (
                        <button onClick={() => updateBookingStatus(booking, 'HOD Recommended')} className="px-2 py-1 bg-indigo-50 text-indigo-700 rounded text-xs font-bold">Recommend</button>
                      )}
                      {canDirectDecideBookings && ['Pending', 'HOD Recommended'].includes(displayStatus) && (
                        <>
                          <button onClick={() => updateBookingStatus(booking, 'Approved')} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">Approve</button>
                          <button onClick={() => updateBookingStatus(booking, 'Postponed')} className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">Request Postpone</button>
                          <button onClick={() => updateBookingStatus(booking, 'Rejected')} className="px-2 py-1 bg-rose-50 text-rose-700 rounded text-xs font-bold">Reject</button>
                        </>
                      )}
                      {canDeputyDecideBookings && displayStatus === 'HOD Recommended' && (
                        <>
                          <button onClick={() => updateBookingStatus(booking, 'Approved')} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">Approve</button>
                          <button onClick={() => updateBookingStatus(booking, 'Postponed')} className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs font-bold">Request Postpone</button>
                          <button onClick={() => updateBookingStatus(booking, 'Rejected')} className="px-2 py-1 bg-rose-50 text-rose-700 rounded text-xs font-bold">Reject</button>
                        </>
                      )}
                      {displayStatus !== 'Past' && displayStatus !== 'Rejected' && displayStatus !== 'Postponed' && booking.faculty_name === user?.name && !canApproveBookings && (
                        <button onClick={() => updateBookingStatus(booking, 'Rejected')} className="px-2 py-1 bg-slate-100 text-slate-600 rounded text-xs font-bold">Cancel Request</button>
                      )}
                      {['Rejected', 'Postponed'].includes(displayStatus) && booking.faculty_name === user?.name && (
                        <button onClick={() => updateBookingStatus(booking, 'Pending')} className="px-2 py-1 bg-orange-50 text-orange-700 rounded text-xs font-bold">Reopen Request</button>
                      )}
                      {displayStatus === 'Past' && (
                        <button onClick={() => openBookingModal(getBookingItems(booking).map((item: any) => ({ id: item.room_id, room_number: getBookingRoomNumber(item), room_type: item.room_type })), booking.grouped_room_count > 1)} className="px-2 py-1 bg-emerald-50 text-emerald-700 rounded text-xs font-bold">Book Again</button>
                      )}
                      <button onClick={() => deleteBookingRequest(booking)} className="px-2 py-1 bg-rose-50 text-rose-700 rounded text-xs font-bold">Delete</button>
                    </div>
                  </td>
                </tr>
                );
              })}
              {filteredBookings.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400 italic">No bookings found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {bookingModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Book Room</h3>
                <p className="text-xs text-slate-500">
                  {bookingModal.rooms.map(room => `Room ${getRoomDisplayLabel(room, rooms)}`).join(', ')} - {getDurationLabel()}
                </p>
                {selectedAcademicContextLabel && (
                  <p className="mt-1 text-[11px] font-bold text-blue-700">Academic Context: {selectedAcademicContextLabel}</p>
                )}
              </div>
              <button onClick={() => setBookingModal(null)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              {bookingMessage?.type === 'error' && (
                <div className="md:col-span-2 p-3 bg-rose-50 border border-rose-100 text-rose-700 rounded-xl text-sm font-bold">
                  {bookingMessage.text}
                </div>
              )}
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Event Name</label>
                <input value={bookingForm.eventName} onChange={e => setBookingForm({ ...bookingForm, eventName: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Purpose</label>
                <input value={bookingForm.purpose} onChange={e => setBookingForm({ ...bookingForm, purpose: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Department</label>
                <select required value={bookingForm.departmentId} onChange={e => setBookingForm({ ...bookingForm, departmentId: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500">
                  <option value="">Select Department</option>
                  {bookingDepartmentOptions.map(dept => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Equipment Required</label>
                <input value={bookingForm.equipmentRequired} onChange={e => setBookingForm({ ...bookingForm, equipmentRequired: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500" />
              </div>
              <div className="md:col-span-2 space-y-1">
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Notes</label>
                <input value={bookingForm.notes} onChange={e => setBookingForm({ ...bookingForm, notes: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-emerald-500" />
              </div>
              <div className="md:col-span-2 flex flex-col md:flex-row gap-3 md:items-center p-3 bg-slate-50 border border-slate-100 rounded-xl">
                {searchCriteria.durationUnit === 'hours' ? (
                  <>
                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                      <input type="checkbox" checked={bookingForm.recurring} onChange={e => setBookingForm({ ...bookingForm, recurring: e.target.checked })} />
                      Repeat weekly
                    </label>
                    {bookingForm.recurring && (
                      <select value={bookingForm.recurringWeeks} onChange={e => setBookingForm({ ...bookingForm, recurringWeeks: e.target.value })} className="px-3 py-2 bg-white border border-slate-200 rounded-lg">
                        <option value="2">2 weeks</option>
                        <option value="4">4 weeks</option>
                        <option value="8">8 weeks</option>
                        <option value="16">16 weeks</option>
                      </select>
                    )}
                  </>
                ) : (
                  <p className="text-sm font-bold text-slate-700">This creates one grouped request that covers every selected date.</p>
                )}
                <p className="text-xs text-slate-500">{canApproveBookings ? 'This booking will be approved immediately.' : 'This booking will be submitted as pending.'}</p>
              </div>
            </div>
            <div className="p-6 border-t border-slate-100 flex gap-3">
              <button onClick={() => setBookingModal(null)} className="flex-1 py-3 bg-white border border-slate-200 text-slate-600 font-bold rounded-xl">Cancel</button>
              <button onClick={handleBook} className="flex-1 py-3 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800">Submit Booking</button>
            </div>
          </div>
        </div>
      )}

      {isScheduleModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Room {getRoomDisplayLabel(selectedRoomForSchedule, rooms)} Schedule</h3>
                {selectedAcademicContextLabel && (
                  <p className="mt-1 text-[11px] font-bold text-blue-700">Academic Context: {selectedAcademicContextLabel}</p>
                )}
                <p className="text-xs text-slate-500">{searchCriteria.date} • {new Date(searchCriteria.date).toLocaleDateString('en-US', { weekday: 'long' })}</p>
              </div>
              <button onClick={() => setIsScheduleModalOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
            </div>
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              {!roomSchedule ? (
                <div className="flex justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div>
                    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Academic Schedules</h4>
                    {roomSchedule.schedules.length > 0 ? (
                      <div className="space-y-2">
                        {roomSchedule.schedules.map((s: any) => (
                          <div key={s.id} className={cn(
                            "p-3 rounded-xl flex justify-between items-center",
                            scheduleMatchesSelectedAcademicContext(s)
                              ? "bg-blue-50 border border-blue-200"
                              : "bg-slate-50 border border-slate-200"
                          )}>
                            <div>
                              <p className={cn("font-bold text-sm", scheduleMatchesSelectedAcademicContext(s) ? "text-blue-800" : "text-slate-700")}>{s.course_name}</p>
                              <p className={cn("text-xs", scheduleMatchesSelectedAcademicContext(s) ? "text-blue-600" : "text-slate-500")}>
                                {[s.faculty, getScheduleAcademicContextLabel(s, departments)].filter(Boolean).join(' • ')}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className={cn("text-xs font-bold", scheduleMatchesSelectedAcademicContext(s) ? "text-blue-700" : "text-slate-600")}>{s.start_time} - {s.end_time}</p>
                              {selectedAcademicContextLabel && scheduleMatchesSelectedAcademicContext(s) && (
                                <p className="text-[10px] font-bold text-blue-500 uppercase tracking-widest">Matching Context</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">No academic schedules for this day.</p>
                    )}
                  </div>

                  <div>
                    <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Event Bookings</h4>
                    {roomSchedule.bookings.length > 0 ? (
                      <div className="space-y-2">
                        {roomSchedule.bookings.map((b: any) => (
                          <div key={b.id} className="p-3 bg-emerald-50 border border-emerald-100 rounded-xl flex justify-between items-center">
                            <div>
                              <p className="font-bold text-emerald-800 text-sm">{b.event_name}</p>
                              <p className="text-xs text-emerald-600">{b.faculty_name}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs font-bold text-emerald-700">{b.start_time} - {b.end_time}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">No event bookings for this day.</p>
                    )}
                  </div>

                  <div className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                    <p className="text-xs text-slate-500 leading-relaxed">
                      <span className="font-bold text-slate-700">Note:</span> Only approved schedules and bookings are shown. Available time slots are those not covered by the entries above.
                    </p>
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                onClick={() => setIsScheduleModalOpen(false)}
                className="px-6 py-2 bg-slate-900 text-white font-bold rounded-lg hover:bg-slate-800 transition-all"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MaintenanceManagement() {
  const location = useLocation();
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomSearchTerm, setRoomSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    fetch('/api/rooms').then(res => res.json()).then((roomData) => {
      const safeRooms = Array.isArray(roomData) ? roomData : [];
      setRooms(safeRooms);
      const params = new URLSearchParams(location.search);
      const roomId = params.get('roomId');
      const roomLabel = params.get('room');
      const requestedStatus = params.get('status');
      const linkedRoom = roomId
        ? safeRooms.find(room => idsMatch(room.id, roomId))
        : findRoomByImportLabel(safeRooms, roomLabel);
      setRoomSearchTerm(linkedRoom ? getRoomDisplayLabel(linkedRoom, safeRooms) : roomLabel || '');
      setStatusFilter(requestedStatus || '');
    });
  }, [location.search]);

  const fields = [
    { key: 'maintenance_id', label: 'Maintenance ID' },
    { key: 'room_id', label: 'Room', type: 'select', options: rooms.map(r => ({ value: r.id, label: getRoomDisplayLabel(r, rooms) })) },
    { key: 'equipment_name', label: 'Equipment' },
    { key: 'status', label: 'Status', type: 'select', options: ['Pending', 'In Progress', 'Completed'] },
  ];

  const handleImport = async (data: any[]) => {
    for (const row of data) {
      const roomValue = getImportValue(row, ['Room Number', 'Room']);
      const room = findRoomByImportLabel(rooms, roomValue);
      const payload = {
        maintenance_id: row['Maintenance ID']?.toString(),
        room_id: room?.id,
        equipment_name: row['Equipment'],
        status: row['Status'] || 'Pending'
      };
      if (!payload.maintenance_id || !payload.room_id) continue;
      await upsertImportRecord('/api/maintenance', payload, [['maintenance_id']]);
    }
  };

  const maintenanceMatchesFilter = (item: any) => {
    if (!statusFilter) return true;
    if (statusFilter === 'open') return ['Pending', 'In Progress'].includes(item?.status);
    return item?.status === statusFilter;
  };

  const maintenanceFilterControls = (
    <div className="flex flex-col md:flex-row gap-3 items-end">
      <div className="w-full md:w-64">
        <label className="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Status</label>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-sm font-medium focus:outline-none focus:border-emerald-500"
        >
          <option value="">All statuses</option>
          <option value="open">Open Issues</option>
          <option value="Pending">Pending</option>
          <option value="In Progress">In Progress</option>
          <option value="Completed">Completed</option>
        </select>
      </div>
      <button
        type="button"
        onClick={() => setStatusFilter('')}
        disabled={!statusFilter}
        className="px-4 py-3 rounded-2xl border border-slate-200 text-sm font-bold text-slate-600 disabled:opacity-50"
      >
        Clear Filter
      </button>
    </div>
  );

  return <GenericCRUD type="Maintenance" fields={fields} apiPath="/api/maintenance" onImport={handleImport} initialSearchTerm={roomSearchTerm} dataFilter={maintenanceMatchesFilter} filterControls={maintenanceFilterControls} />;
}

function AIAllocation() {
  const [formData, setFormData] = useState({
    eventType: 'Lecture',
    roomType: 'Classroom',
    preferredBuilding: '',
    preferredBlock: '',
    equipmentRequired: { required: false, types: [] as string[] },
    accessibilityRequired: { required: false, types: [] as string[] },
    floorPreference: { required: false, floor: 'Ground Floor' },
    studentCount: '',
    date: new Date().toISOString().split('T')[0],
    startTime: '09:00',
    duration: '1'
  });
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleAllocate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const [rRes, bRes, eRes, sRes, bkRes] = await Promise.all([
        fetch('/api/rooms', { credentials: 'include' }),
        fetch('/api/buildings', { credentials: 'include' }),
        fetch('/api/equipment', { credentials: 'include' }),
        fetch('/api/schedules', { credentials: 'include' }),
        fetch('/api/bookings', { credentials: 'include' })
      ]);
      
      const rooms = (await rRes.json()).filter(isRoomReservable);
      const buildings = await bRes.json();
      const equipment = await eRes.json();
      const schedules = await sRes.json();
      const bookings = await bkRes.json();

      const ai = getGenAIClient();
      const model = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: `As a Senior Campus Operations AI, perform a high-precision room allocation.
        
        REQUEST:
        - Event: ${formData.eventType} (${formData.roomType})
        - Capacity Needed: ${formData.studentCount} students
        - Timing: ${formData.date} at ${formData.startTime} for ${formData.duration} hours
        - Preferences: Building: ${formData.preferredBuilding || 'Any'}, Block: ${formData.preferredBlock || 'Any'}, Floor: ${formData.floorPreference?.required ? formData.floorPreference.floor : 'Any'}
        - Requirements: Equipment: ${formData.equipmentRequired?.required ? formData.equipmentRequired.types.join(', ') : 'None'}, Accessibility: ${formData.accessibilityRequired?.required ? formData.accessibilityRequired.types.join(', ') : 'None'}
        
        DATA CONTEXT:
        - Rooms: ${JSON.stringify(rooms)}
        - Buildings: ${JSON.stringify(buildings)}
        - Equipment: ${JSON.stringify(equipment)}
        - Schedules: ${JSON.stringify(schedules)}
        - Bookings: ${JSON.stringify(bookings)}
        
        PRECISION LOGIC:
        1. HARD CONSTRAINTS:
           - Room must be 'Available'.
           - Capacity must be >= Student Count.
           - NO overlap with Schedules (match day_of_week, check time range).
           - NO overlap with Bookings (match date, check time range).
           - Must meet ALL 'Accessibility' requirements if specified.
        
        2. EFFECTIVENESS SCORING (0-100):
           - [30pts] Capacity Efficiency: 30pts if capacity is 100-115% of student count. Deduct 2pts for every 10% over.
           - [20pts] Equipment Match: 20pts if ALL required equipment is present AND condition is 'Good'. 10pts if present but condition is 'Fair'.
           - [20pts] Location Preference: 10pts for Building match, 10pts for Block match.
           - [15pts] Floor/Accessibility: 15pts if matches floor preference or accessibility needs perfectly.
           - [15pts] Maintenance Health: Deduct 10pts if room has any 'Pending' maintenance issues in the last 30 days.
        
        OUTPUT FORMAT (JSON):
        {
          "recommendedRoom": "Room Name (Building - Block)",
          "roomDetails": { "room_number": "...", "building": "...", "floor": "...", "capacity": 0, "block": "..." },
          "alternativeRooms": ["Room A", "Room B"],
          "allocationScore": 0-100,
          "reasoning": "Detailed breakdown of the score and why this is the most effective choice."
        }` ,
        config: { responseMimeType: "application/json" }
      });

      const response = await model;
      setResult(parseAIResponse(await getAIResponseText(response)));
    } catch (err: any) {
      console.error(err);
      setResult({ error: err.message || "Failed to generate allocation. Please check your connection and try again." });
    } finally {
      setLoading(false);
    }
  };

  const toggleEquipment = (type: string) => {
    const current = formData.equipmentRequired.types;
    const next = current.includes(type) ? current.filter(t => t !== type) : [...current, type];
    setFormData({ ...formData, equipmentRequired: { ...formData.equipmentRequired, types: next } });
  };

  const toggleAccessibility = (type: string) => {
    const current = formData.accessibilityRequired.types;
    const next = current.includes(type) ? current.filter(t => t !== type) : [...current, type];
    setFormData({ ...formData, accessibilityRequired: { ...formData.accessibilityRequired, types: next } });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 pb-12">
      <div className="lg:col-span-1 bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
        <h3 className="text-lg font-bold text-slate-800 mb-8 flex items-center gap-3">
          <div className="p-2 bg-emerald-50 rounded-lg">
            <BrainCircuit className="text-emerald-500" size={20} />
          </div>
          Smart Allocation Input
        </h3>
        <form onSubmit={handleAllocate} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Event Type</label>
              <select
                value={formData.eventType}
                onChange={e => setFormData({ ...formData, eventType: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              >
                {['Lecture', 'Seminar', 'Meeting', 'Workshop', 'Others'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Room Type</label>
              <select
                value={formData.roomType}
                onChange={e => setFormData({ ...formData, roomType: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              >
                {EVENT_ROOM_TYPE_OPTIONS.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Preferred Building</label>
              <select
                value={formData.preferredBuilding}
                onChange={e => setFormData({ ...formData, preferredBuilding: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              >
                <option value="">No Preference</option>
                {['M-Plazza', 'NAB', 'MNS'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Campus Block</label>
              <select
                value={formData.preferredBlock}
                onChange={e => setFormData({ ...formData, preferredBlock: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              >
                <option value="">No Preference</option>
                {['East', 'West', 'North', 'South', 'Others'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Equipment Required?</label>
            <div className="flex gap-6">
              {['Yes', 'No'].map(opt => (
                <label key={opt} className="flex items-center gap-2.5 cursor-pointer group">
                  <input 
                    type="radio" 
                    checked={(opt === 'Yes') === formData.equipmentRequired.required} 
                    onChange={() => setFormData({ ...formData, equipmentRequired: { ...formData.equipmentRequired, required: opt === 'Yes' } })}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-slate-600 group-hover:text-slate-900 transition-colors">{opt}</span>
                </label>
              ))}
            </div>
            {formData.equipmentRequired.required && (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl grid grid-cols-2 gap-3">
                {['Projector', 'Smart Board', 'Sound System', 'Computers', 'AC', 'Others'].map(eq => (
                  <label key={eq} className="flex items-center gap-2.5 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      checked={formData.equipmentRequired.types.includes(eq)}
                      onChange={() => toggleEquipment(eq)}
                      className="w-4 h-4 rounded accent-emerald-500"
                    />
                    <span className="text-xs font-medium text-slate-600 group-hover:text-slate-900 transition-colors">{eq}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Accessibility Needs?</label>
            <div className="flex gap-6">
              {['Yes', 'No'].map(opt => (
                <label key={opt} className="flex items-center gap-2.5 cursor-pointer group">
                  <input 
                    type="radio" 
                    checked={(opt === 'Yes') === formData.accessibilityRequired.required} 
                    onChange={() => setFormData({ ...formData, accessibilityRequired: { ...formData.accessibilityRequired, required: opt === 'Yes' } })}
                    className="w-4 h-4 accent-emerald-500"
                  />
                  <span className="text-sm font-medium text-slate-600 group-hover:text-slate-900 transition-colors">{opt}</span>
                </label>
              ))}
            </div>
            {formData.accessibilityRequired.required && (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl grid grid-cols-2 gap-3">
                {['Wheelchair Access', 'Elevator Nearby', 'Braille Signage', 'Hearing Loop', 'Others'].map(acc => (
                  <label key={acc} className="flex items-center gap-2.5 cursor-pointer group">
                    <input 
                      type="checkbox" 
                      checked={formData.accessibilityRequired.types.includes(acc)}
                      onChange={() => toggleAccessibility(acc)}
                      className="w-4 h-4 rounded accent-emerald-500"
                    />
                    <span className="text-xs font-medium text-slate-600 group-hover:text-slate-900 transition-colors">{acc}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Expected Strength</label>
              <input 
                type="number" 
                placeholder="e.g. 60"
                value={formData.studentCount}
                onChange={e => setFormData({ ...formData, studentCount: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Event Date</label>
              <input 
                type="date" 
                value={formData.date}
                onChange={e => setFormData({ ...formData, date: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-500 text-sm font-medium"
              />
            </div>
          </div>

          <button 
            type="submit"
            disabled={loading}
            className="w-full py-4 bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all disabled:opacity-50 flex items-center justify-center gap-3 shadow-xl shadow-slate-900/10"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Processing Allocation...
              </>
            ) : (
              <>
                <Zap size={20} className="text-emerald-400" />
                Run AI Allocation
              </>
            )}
          </button>
        </form>
      </div>

      <div className="lg:col-span-2 space-y-8">
        {result ? (
          result.error ? (
            <div className="bg-rose-50 border border-rose-200 p-8 rounded-3xl text-center">
              <div className="w-16 h-16 bg-rose-100 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <AlertCircle className="text-rose-600" size={32} />
              </div>
              <h4 className="text-lg font-bold text-rose-900 mb-2">Allocation Failed</h4>
              <p className="text-sm text-rose-700">{result.error}</p>
            </div>
          ) : (
            <>
              <div className="bg-white p-10 rounded-[40px] border border-slate-200 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 p-8">
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Match Score</span>
                    <span className={cn(
                      "text-4xl font-black",
                      result.allocationScore > 80 ? "text-emerald-500" : 
                      result.allocationScore > 50 ? "text-amber-500" : "text-rose-500"
                    )}>
                      {result.allocationScore}%
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-6 mb-10">
                  <div className="w-20 h-20 bg-emerald-50 rounded-3xl flex items-center justify-center border border-emerald-100">
                    <CheckCircle2 className="text-emerald-500" size={40} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-emerald-600 uppercase tracking-widest mb-1">Top Recommendation</h4>
                    <h2 className="text-3xl font-bold text-slate-900">{result.recommendedRoom}</h2>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-10">
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Building</p>
                    <p className="text-sm font-bold text-slate-800">{result.roomDetails.building}</p>
                  </div>
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Block</p>
                    <p className="text-sm font-bold text-slate-800">{result.roomDetails.block}</p>
                  </div>
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Floor</p>
                    <p className="text-sm font-bold text-slate-800">{result.roomDetails.floor}</p>
                  </div>
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Capacity</p>
                    <p className="text-sm font-bold text-slate-800">{result.roomDetails.capacity} Seats</p>
                  </div>
                </div>

                <div className="p-8 bg-slate-900 rounded-3xl text-white">
                  <h4 className="text-sm font-bold text-emerald-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                    <Info size={16} />
                    AI Reasoning
                  </h4>
                  <p className="text-sm text-slate-300 leading-relaxed font-medium">{result.reasoning}</p>
                </div>

                <div className="mt-10 pt-10 border-t border-slate-100">
                  <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Alternative Options</h4>
                  <div className="flex flex-wrap gap-3">
                    {result.alternativeRooms.map((room: string) => (
                      <span key={room} className="px-5 py-2.5 bg-slate-50 text-slate-700 rounded-xl text-xs font-bold border border-slate-100 hover:border-emerald-200 transition-all cursor-pointer">
                        {room}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )
        ) : (
          <div className="h-full bg-slate-50 rounded-[40px] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center p-12 text-center">
            <div className="w-24 h-24 bg-white rounded-3xl shadow-sm flex items-center justify-center mb-8">
              <Sparkles className="text-slate-200" size={48} />
            </div>
            <h4 className="text-xl font-bold text-slate-400 mb-2">Awaiting Allocation Request</h4>
            <p className="text-sm text-slate-400 max-w-[300px]">Fill in the details and click "Run AI Allocation" to find the perfect space.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsDashboard() {
  const [utilizationData, setUtilizationData] = useState<any[]>([]);
  const [frequencyData, setFrequencyData] = useState<any[]>([]);
  const [reportData, setReportData] = useState<any>(null);
  const [bookings, setBookings] = useState<any[]>([]);
  const [maintenance, setMaintenance] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyticsFilters, setAnalyticsFilters] = useState({
    dateFrom: '',
    dateTo: '',
    building: '',
    department: '',
    roomType: '',
    bookingStatus: ''
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [uRes, fRes, rRes, bRes, mRes] = await Promise.all([
          fetch('/api/analytics/utilization-trends', { credentials: 'include' }),
          fetch('/api/analytics/booking-frequency', { credentials: 'include' }),
          fetch('/api/reports/utilization', { credentials: 'include' }),
          fetch('/api/bookings', { credentials: 'include' }),
          fetch('/api/maintenance', { credentials: 'include' })
        ]);
        setUtilizationData(await uRes.json());
        setFrequencyData(await fRes.json());
        setReportData(await rRes.json());
        setBookings(await bRes.json());
        setMaintenance(await mRes.json());
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <div className="p-8 text-center text-slate-400">Loading Analytics...</div>;

  const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
  const roomReports = reportData?.roomReports || [];
  const dateInRange = (date?: string) => {
    if (!date) return true;
    if (analyticsFilters.dateFrom && date < analyticsFilters.dateFrom) return false;
    if (analyticsFilters.dateTo && date > analyticsFilters.dateTo) return false;
    return true;
  };
  const matchesAnalyticsValue = (value: any, expected: string) =>
    !expected || value?.toString().trim().toLowerCase() === expected.trim().toLowerCase();
  const roomMetaByNumber = new Map<string, any>(roomReports.map((room: any) => [room.room_number?.toString(), room]));
  const roomMetaById = new Map<string, any>(roomReports.map((room: any) => [room.room_id?.toString(), room]));
  const getBookingRoomMeta = (booking: any) =>
    roomMetaById.get(booking.room_id?.toString()) || roomMetaByNumber.get(booking.room_number?.toString());
  const getRoomBookings = (room: any) => bookings.filter(booking =>
    booking.room_id?.toString() === room.room_id?.toString() ||
    booking.room_number?.toString() === room.room_number?.toString()
  );
  const bookingMatchesFilters = (booking: any, roomMeta = getBookingRoomMeta(booking)) => {
    if (!dateInRange(booking.date)) return false;
    if (analyticsFilters.bookingStatus && !matchesAnalyticsValue(booking.status, analyticsFilters.bookingStatus)) return false;
    if (analyticsFilters.building && !matchesAnalyticsValue(roomMeta?.building, analyticsFilters.building)) return false;
    if (analyticsFilters.department && !matchesAnalyticsValue(booking.department_name || roomMeta?.department, analyticsFilters.department)) return false;
    if (analyticsFilters.roomType && !matchesAnalyticsValue(booking.room_type || roomMeta?.room_type, analyticsFilters.roomType)) return false;
    return true;
  };
  const filteredRoomReports = roomReports.filter((room: any) => {
    const roomBookings = getRoomBookings(room);
    const hasBookingScopedFilters = !!(analyticsFilters.dateFrom || analyticsFilters.dateTo || analyticsFilters.bookingStatus);
    const hasMatchingBooking = roomBookings.some(booking => bookingMatchesFilters(booking, room));
    if (analyticsFilters.building && !matchesAnalyticsValue(room.building, analyticsFilters.building)) return false;
    if (analyticsFilters.department && !matchesAnalyticsValue(room.department, analyticsFilters.department) && !roomBookings.some(booking => matchesAnalyticsValue(booking.department_name, analyticsFilters.department))) return false;
    if (analyticsFilters.roomType && !matchesAnalyticsValue(room.room_type, analyticsFilters.roomType) && !roomBookings.some(booking => matchesAnalyticsValue(booking.room_type, analyticsFilters.roomType))) return false;
    if (hasBookingScopedFilters && !hasMatchingBooking) return false;
    return true;
  });
  const filteredBookings = bookings.filter(booking => bookingMatchesFilters(booking));
  const filteredMaintenance = maintenance.filter(item => {
    const roomMeta = roomMetaById.get(item.room_id?.toString()) || roomMetaByNumber.get(item.room_number?.toString());
    if (!dateInRange(item.reported_date)) return false;
    if (analyticsFilters.building && !matchesAnalyticsValue(roomMeta?.building, analyticsFilters.building)) return false;
    if (analyticsFilters.department && !matchesAnalyticsValue(roomMeta?.department, analyticsFilters.department)) return false;
    if (analyticsFilters.roomType && !matchesAnalyticsValue(roomMeta?.room_type, analyticsFilters.roomType)) return false;
    return true;
  });
  const filteredUtilizationData = filteredRoomReports
    .map((room: any) => ({ name: room.room_number, utilization: room.utilization }))
    .sort((a: any, b: any) => b.utilization - a.utilization)
    .slice(0, 10);
  const filteredFrequencyData = Array.from(new Set<string>(filteredRoomReports.map((room: any) => room.building))).map(building => ({
    name: building,
    count: filteredBookings.filter(booking => matchesAnalyticsValue(getBookingRoomMeta(booking)?.building, building)).length
  })).filter(item => item.count > 0);
  const bookingStatusData = ['Pending', 'HOD Recommended', 'Approved', 'Postponed', 'Rejected'].map(status => ({
    name: status,
    count: filteredBookings.filter(booking => booking.status === status).length
  })).filter(item => item.count > 0);
  const maintenanceStatusData = ['Pending', 'In Progress', 'Completed'].map(status => ({
    name: status,
    count: filteredMaintenance.filter(item => item.status === status).length
  })).filter(item => item.count > 0);
  const departmentRequestData = Array.from(new Set<string>(filteredBookings.map(booking => booking.department_name || getBookingRoomMeta(booking)?.department || 'Unmapped'))).map(department => ({
    name: department,
    count: filteredBookings.filter(booking => matchesAnalyticsValue(booking.department_name || getBookingRoomMeta(booking)?.department || 'Unmapped', department)).length
  })).sort((a, b) => b.count - a.count).slice(0, 8);
  const avgUtilization = Math.round(filteredRoomReports.reduce((acc: number, curr: any) => acc + curr.utilization, 0) / (filteredRoomReports.length || 1));
  const pendingRequests = filteredBookings.filter(item => item.status === 'Pending').length;
  const approvedRequests = filteredBookings.filter(item => item.status === 'Approved').length;
  const maintenanceRisks = filteredRoomReports.filter((item: any) => item.maintenanceIssues > 0).length;
  const unmappedRooms = filteredRoomReports.filter((item: any) => item.department === 'Unmapped').length;
  const totalRiskRooms = filteredRoomReports.filter((item: any) => item.maintenanceIssues > 0 || item.department === 'Unmapped').length;
  const hourBuckets = filteredBookings.reduce((acc: Record<string, number>, booking) => {
    const hour = booking.start_time?.slice(0, 2);
    if (!hour) return acc;
    acc[hour] = (acc[hour] || 0) + 1;
    return acc;
  }, {});
  const peakHour = Object.entries(hourBuckets).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
  const peakHourLabel = peakHour ? `${Number(peakHour)}:00 - ${Number(peakHour) + 1}:00` : 'No data';
  const alertItems = [
    ...filteredRoomReports.filter((room: any) => room.maintenanceIssues > 0 && room.utilization > 60).map((room: any) => `Room ${room.room_number} is highly used and has maintenance risk.`),
    ...filteredRoomReports.filter((room: any) => room.department === 'Unmapped').map((room: any) => `Room ${room.room_number} is not mapped to any department.`),
    ...filteredBookings.filter(booking => booking.status === 'Pending').slice(0, 3).map(booking => `${booking.event_name || 'Room request'} is still pending.`)
  ].slice(0, 6);
  const standardRoomTypes = ROOM_TYPE_OPTIONS;
  const buildingOptions = Array.from(new Set(roomReports.map((room: any) => room.building).filter(Boolean))).sort();
  const departmentOptions = Array.from(new Set([
    ...(reportData?.deptReports || []).map((department: any) => department.name),
    ...roomReports.map((room: any) => room.department),
    ...bookings.map(booking => booking.department_name)
  ].filter(Boolean))).sort();
  const roomTypeOptions = Array.from(new Set([
    ...standardRoomTypes,
    ...roomReports.map((room: any) => room.room_type),
    ...bookings.map(booking => booking.room_type)
  ].filter(Boolean))).sort();
  const exportAnalytics = () => {
    const worksheet = XLSX.utils.json_to_sheet(filteredRoomReports.map((room: any) => ({
      Room: room.room_number,
      RoomName: getRoomNameDisplay(room),
      Building: room.building,
      Department: room.department,
      Type: getRoomTypeDisplay(room),
      SubRoomType: HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout)) ? getRoomTypeDisplay(room) : '',
      Layout: room.room_layout || 'Normal',
      RoomAliases: getRoomAliasList(room).join(', '),
      ParentRoom: room.parent_room_number || '',
      SubRoomCount: room.sub_room_count ?? '',
      SubRoomName: room.room_section_name || '',
      UsageCategory: room.usage_category || normalizeUsageCategoryValue('', room.room_type) || '',
      IsBookable: isRoomReservable(room) ? 'Yes' : 'No',
      'Lab Name': room.lab_name || '',
      'Sub Lab Name': (
        normalizeRoomTypeValue(room.room_type) === 'Lab' &&
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout))
      ) ? (room.lab_name || '') : '',
      'Restroom For': room.restroom_type || '',
      Capacity: room.capacity,
      Utilization: `${room.utilization}%`,
      Flags: (room.flags || []).join(', ')
    })));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Analytics');
    XLSX.writeFile(workbook, 'analytics-summary.xlsx');
  };

  return (
    <div className="space-y-8">
      <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Analytics Filters</h3>
            <p className="text-xs text-slate-500">Filter the live dashboard by date, building, department, room type, or booking status.</p>
          </div>
          <button onClick={exportAnalytics} className="px-4 py-2 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
            <FileSpreadsheet size={16} />
            Export Analytics
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <input type="date" value={analyticsFilters.dateFrom} onChange={e => setAnalyticsFilters({ ...analyticsFilters, dateFrom: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500" />
          <input type="date" value={analyticsFilters.dateTo} onChange={e => setAnalyticsFilters({ ...analyticsFilters, dateTo: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500" />
          <select value={analyticsFilters.building} onChange={e => setAnalyticsFilters({ ...analyticsFilters, building: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Buildings</option>
            {buildingOptions.map((building: any) => <option key={building} value={building}>{building}</option>)}
          </select>
          <select value={analyticsFilters.department} onChange={e => setAnalyticsFilters({ ...analyticsFilters, department: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Departments</option>
            {departmentOptions.map((department: any) => <option key={department} value={department}>{department}</option>)}
          </select>
          <select value={analyticsFilters.roomType} onChange={e => setAnalyticsFilters({ ...analyticsFilters, roomType: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Room Types</option>
            {roomTypeOptions.map((type: any) => <option key={type} value={type}>{type}</option>)}
          </select>
          <select value={analyticsFilters.bookingStatus} onChange={e => setAnalyticsFilters({ ...analyticsFilters, bookingStatus: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Statuses</option>
            {['Pending', 'HOD Recommended', 'Approved', 'Postponed', 'Rejected'].map(status => <option key={status} value={status}>{status}</option>)}
          </select>
        </div>
      </div>
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600">
              <Activity size={20} />
            </div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Avg Utilization</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">
            {avgUtilization}%
          </p>
          <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
            <TrendingUp size={12} className="text-emerald-500" />
            +4.2% from last month
          </p>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
              <Calendar size={20} />
            </div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Bookings</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">
            {filteredBookings.length}
          </p>
          <p className="text-xs text-slate-500 mt-2 flex items-center gap-1">
            <TrendingUp size={12} className="text-emerald-500" />
            +12% from last month
          </p>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-amber-50 rounded-lg text-amber-600">
              <Zap size={20} />
            </div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Peak Hours</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{peakHourLabel}</p>
          <p className="text-xs text-slate-500 mt-2">Highest demand period</p>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-orange-50 rounded-lg text-orange-600"><Clock size={20} /></div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Pending</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{pendingRequests}</p>
          <p className="text-xs text-slate-500 mt-2">Requests awaiting action</p>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600"><CheckCircle2 size={20} /></div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Approved</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{approvedRequests}</p>
          <p className="text-xs text-slate-500 mt-2">Confirmed bookings</p>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-rose-50 rounded-lg text-rose-600"><AlertTriangle size={20} /></div>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Risks</span>
          </div>
          <p className="text-3xl font-bold text-slate-800">{totalRiskRooms}</p>
          <p className="text-xs text-slate-500 mt-2">{maintenanceRisks} maintenance risks, {unmappedRooms} unmapped rooms</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-lg font-bold text-slate-800">Top 10 Room Utilization (%)</h3>
            <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600">
              <TrendingUp size={20} />
            </div>
          </div>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={filteredUtilizationData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <Tooltip 
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }}
                  cursor={{ fill: '#f8fafc' }}
                />
                <Bar dataKey="utilization" fill="#10b981" radius={[6, 6, 0, 0]} barSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-lg font-bold text-slate-800">Booking Frequency by Building</h3>
            <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
              <PieChartIcon size={20} />
            </div>
          </div>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={filteredFrequencyData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={100}
                  paddingAngle={8}
                  dataKey="count"
                >
                  {filteredFrequencyData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }}
                />
                <Legend verticalAlign="bottom" height={36} iconType="circle" />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-8">Booking Requests by Status</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bookingStatusData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }} />
                <Bar dataKey="count" fill="#3b82f6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-8">Maintenance Status</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={maintenanceStatusData} cx="50%" cy="50%" outerRadius={95} dataKey="count" label>
                  {maintenanceStatusData.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-8">Requests by Department</h3>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={departmentRequestData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#64748b' }} />
                <Tooltip contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)' }} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
          <h3 className="text-lg font-bold text-slate-800 mb-6">Actionable Alerts</h3>
          <div className="space-y-3">
            {alertItems.map((alert, index) => (
              <div key={index} className="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex items-start gap-3">
                <AlertTriangle size={18} className="text-amber-600 mt-0.5" />
                <p className="text-sm font-medium text-amber-900">{alert}</p>
              </div>
            ))}
            {alertItems.length === 0 && (
              <div className="p-8 text-center border-2 border-dashed border-slate-100 rounded-2xl">
                <p className="text-sm text-slate-400 font-medium">No analytics alerts for the selected filters.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportGeneration() {
  const [utilizationData, setUtilizationData] = useState<any>(null);
  const [reportBookings, setReportBookings] = useState<any[]>([]);
  const [reportSchedules, setReportSchedules] = useState<any[]>([]);
  const [reportAcademicCalendars, setReportAcademicCalendars] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [suggestionError, setSuggestionError] = useState('');
  const [activeTab, setActiveTab] = useState<'utilization' | 'methodology' | 'kpis'>('utilization');
  const [loading, setLoading] = useState(true);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState<any>(null);
  const [filters, setFilters] = useState({
    reportType: 'room_utilization',
    dateFrom: '',
    dateTo: '',
    campus: '',
    building: '',
    block: '',
    floor: '',
    department: '',
    year: '',
    semester: '',
    section: '',
    room: '',
    roomType: '',
    bookingStatus: '',
    flag: '',
    snapshotMode: 'date',
    snapshotDay: '',
    snapshotTime: '',
    roomCategoryType: 'room_type',
    roomCategoryValue: '',
  });
  const REPORT_TYPE_OPTIONS = [
    { value: 'room_utilization', label: 'Room Utilization' },
    { value: 'available_room_summary', label: 'Available Room Summary' },
    { value: 'category_room_list', label: 'Category-wise Room List' },
    { value: 'room_level_detail', label: 'Room-level Detail' },
    { value: 'campus_utilization', label: 'Campus Utilization' },
    { value: 'building_utilization', label: 'Building Utilization' },
    { value: 'department_allocation', label: 'Department Allocation' },
    { value: 'room_type_utilization', label: 'Room Type Utilization' },
    { value: 'usage_category_utilization', label: 'Usage Category Utilization' },
    { value: 'year_utilization', label: 'Year-wise Utilization' },
    { value: 'semester_utilization', label: 'Semester-wise Utilization' },
    { value: 'section_utilization', label: 'Section-wise Utilization' },
    { value: 'booking_approvals', label: 'Booking Approvals' },
    { value: 'maintenance_impact', label: 'Maintenance Impact' },
    { value: 'underused', label: 'Underused Rooms' },
    { value: 'overused', label: 'Overused Rooms' },
    { value: 'time_band_utilization', label: 'Time Band Utilization' },
    { value: 'hourly_utilization', label: 'Hourly Utilization' },
    { value: 'day_wise_utilization', label: 'Day-wise Utilization' },
    { value: 'date_wise_occupancy', label: 'Date-wise Occupancy' },
    { value: 'per_room_occupancy', label: 'Per-room Occupancy Snapshot' },
    { value: 'department_roomtype_demand', label: 'Department vs Room-Type Demand' },
    { value: 'clash_overlap', label: 'Clash / Overlap Report' },
    { value: 'vacancy_opportunity', label: 'Vacancy Opportunity Report' },
    { value: 'capacity_mismatch', label: 'Capacity Mismatch Report' },
    { value: 'exam_impact', label: 'Exam Impact Report' },
    { value: 'booking_lifecycle', label: 'Booking Lead-Time & Cancellation' },
    { value: 'no_show_risk', label: 'No-Show / Unused Booking Risk' },
    { value: 'shared_room_conflict', label: 'Shared Room Conflict Risk' },
    { value: 'semester_peak_forecast', label: 'Semester Peak Load Forecast' },
  ];
  const REPORT_EXPORT_COLUMNS: Record<string, string[]> = {
    room_utilization: ['Room', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Layout', 'Utilization', 'ScheduledHours', 'BookedHours', 'Capacity', 'Status', 'Flags'],
    available_room_summary: ['SummaryScope', 'Category', 'AvailableRooms', 'RoomNumbers'],
    category_room_list: ['CategoryType', 'CategoryValue', 'ReportCategory', 'RoomId', 'Room', 'RoomName', 'Campus', 'Building', 'Block', 'Floor', 'Type', 'HierarchyLevel', 'ParentRoom', 'Layout', 'UsageCategory', 'Status', 'Capacity'],
    room_level_detail: ['RoomId', 'Room', 'Aliases', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Layout', 'Status', 'Capacity', 'Utilization', 'ScheduledHours', 'BookedHours', 'Years', 'Semesters', 'Sections', 'Flags'],
    campus_utilization: ['Campus', 'Buildings', 'Rooms', 'AvgUtilization'],
    school_utilization: ['School', 'Departments', 'Rooms', 'TotalCapacity', 'AvgUtilization', 'UnmappedRooms'],
    building_utilization: ['Building', 'Rooms', 'MaintenanceIssues', 'AvgUtilization'],
    department_allocation: ['Department', 'School', 'Rooms', 'TotalCapacity', 'AvgUtilization'],
    room_type_utilization: ['RoomType', 'Rooms', 'AvgUtilization'],
    usage_category_utilization: ['UsageCategory', 'Rooms', 'AvgUtilization'],
    year_utilization: ['Year', 'Rooms', 'AvgUtilization'],
    semester_utilization: ['Semester', 'Rooms', 'AvgUtilization'],
    section_utilization: ['Section', 'Rooms', 'AvgUtilization'],
    booking_approvals: ['Status', 'Count'],
    maintenance_impact: ['Room', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Layout', 'Utilization', 'ScheduledHours', 'BookedHours', 'Capacity', 'Status', 'Flags'],
    underused: ['Room', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Layout', 'Utilization', 'ScheduledHours', 'BookedHours', 'Capacity', 'Status', 'Flags'],
    overused: ['Room', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Layout', 'Utilization', 'ScheduledHours', 'BookedHours', 'Capacity', 'Status', 'Flags'],
    time_band_utilization: ['TimeBand', 'ScheduledHours', 'BookedHours', 'Utilization'],
    hourly_utilization: ['HourBand', 'ScheduledHours', 'BookedHours', 'Utilization', 'ScheduledEntries', 'ApprovedBookings', 'OccupiedRooms', 'RoomNumbers'],
    day_wise_utilization: ['Day', 'ScheduledHours', 'BookedHours', 'Utilization', 'ScheduledEntries', 'ApprovedBookings', 'OccupiedRooms', 'RoomNumbers'],
    date_wise_occupancy: ['Date', 'Day', 'ScheduledHours', 'BookedHours', 'Utilization', 'ScheduledEntries', 'ApprovedBookings', 'OccupiedRooms', 'RoomNumbers'],
    per_room_occupancy: ['Date', 'Day', 'HourBand', 'Room', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Type', 'Capacity', 'OccupancyStatus', 'ScheduledEntries', 'ApprovedBookings', 'SuppressedSchedules', 'Details'],
    department_roomtype_demand: ['Department', 'TotalDemand'],
    clash_overlap: ['Source', 'Room', 'DayOrDate', 'YearA', 'SemesterA', 'EntryA', 'YearB', 'SemesterB', 'EntryB'],
    vacancy_opportunity: ['Room', 'Building', 'Department', 'IdleHoursPerWeek', 'Utilization', 'Opportunity'],
    capacity_mismatch: ['Date', 'Room', 'Department', 'Event', 'Students', 'Capacity', 'OccupancyPercent', 'MismatchType'],
    exam_impact: ['ExamWindow', 'Department', 'Semester', 'StartDate', 'EndDate', 'Days', 'AffectedWeeklyClasses', 'EstimatedBlockedSessions'],
    booking_lifecycle: ['TotalRequests', 'Approvals', 'Cancellations', 'CancellationRate', 'AverageLeadDays', 'LeadTimeCapturedCount'],
    no_show_risk: ['Booking', 'Date', 'Room', 'Department', 'Event', 'Students', 'Capacity', 'OccupancyPercent', 'RiskScore'],
    shared_room_conflict: ['Room', 'Building', 'RoomLayout', 'Aliases', 'Departments', 'Sections', 'Overlaps', 'RiskScore'],
    semester_peak_forecast: ['Semester', 'Day', 'PeakBand', 'PeakSlots', 'TotalClasses'],
  };
  const [individualReportType, setIndividualReportType] = useState('room_utilization');

  const methodologyData = [
    { 
      title: "Room Utilization Rate (RUR)", 
      formula: "((Scheduled Hours + Approved Booking Hours) / Total Available Hours) × 100", 
      description: "Measures the time-based usage of a room against a standard 72-hour academic week (12h × 6 days).",
      target: "75% - 85%"
    },
    { 
      title: "Seat Occupancy Rate (SOR)", 
      formula: "(Actual Student Count / Room Capacity) × 100", 
      description: "Evaluates how effectively the physical space is filled during scheduled sessions.",
      target: "65% - 80%"
    },
    { 
      title: "Capacity Fit Ratio (CFR)", 
      formula: "Expected Event Strength / Total Allocated Capacity", 
      description: "Used for ad hoc events to ensure the right-sized room is selected to avoid space waste.",
      target: "0.90+"
    },
    { 
      title: "Idle-Time Percentage", 
      formula: "100% - RUR", 
      description: "Identifies the percentage of time a room remains vacant during operational hours.",
      target: "< 20%"
    }
  ];

  const fetchUtilization = async () => {
    try {
      const [reportRes, bookingRes, scheduleRes, academicRes] = await Promise.all([
        fetch('/api/reports/utilization', { credentials: 'include' }),
        fetch('/api/bookings', { credentials: 'include' }),
        fetch('/api/schedules', { credentials: 'include' }),
        fetch('/api/academic_calendars', { credentials: 'include' }),
      ]);
      const data = await reportRes.json();
      const bookingData = await bookingRes.json();
      const scheduleData = await scheduleRes.json();
      const academicData = await academicRes.json();
      setUtilizationData(data);
      setReportBookings(Array.isArray(bookingData) ? bookingData : []);
      setReportSchedules(Array.isArray(scheduleData) ? scheduleData : []);
      setReportAcademicCalendars(Array.isArray(academicData) ? academicData : []);
    } catch (err) {
      console.error(err);
      setReportBookings([]);
      setReportSchedules([]);
      setReportAcademicCalendars([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUtilization();
  }, []);

  const generateSuggestions = async () => {
    if (!utilizationData) return;
    setIsGeneratingSuggestions(true);
    setSuggestionError('');
    try {
      // Summarize data to avoid token limits
      const summarizedData = filteredRoomReports.map((r: any) => ({
        room: r.room_number,
        util: r.utilization,
        dept: r.department
      })).sort((a: any, b: any) => a.util - b.util).slice(0, 20); // Focus on bottom 20 underutilized rooms

      const response = await fetch('/api/ai/utilization-optimization', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: summarizedData }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to generate AI optimization suggestions right now.');
      }

      const nextSuggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
      setSuggestions(nextSuggestions);
      if (!nextSuggestions.length) {
        setSuggestionError('No AI suggestions were returned for the current filter context.');
      }
    } catch (err: any) {
      console.error(err);
      setSuggestionError(err?.message || 'Failed to generate AI suggestions.');
    } finally {
      setIsGeneratingSuggestions(false);
    }
  };

  const roomReports = Array.isArray(utilizationData?.roomReports) ? utilizationData.roomReports : [];
  const deptReports = Array.isArray(utilizationData?.deptReports) ? utilizationData.deptReports : [];

  const kpis = [
    { label: 'Campus-wide RUR', value: `${Math.round(roomReports.reduce((acc: any, r: any) => acc + r.utilization, 0) / (roomReports.length || 1))}%`, trend: '+4%', status: 'Good' },
    { label: 'Avg Seat Occupancy', value: '52%', trend: '-2%', status: 'Low' },
    { label: 'Space Waste Index', value: '14%', trend: '-5%', status: 'Improving' },
    { label: 'Event Success Rate', value: '92%', trend: '+1%', status: 'Excellent' },
  ];

  if (loading) return <div className="p-8 text-center text-slate-400">Loading utilization data...</div>;
  const dateMatches = (dates: string[] = []) => {
    if (!filters.dateFrom && !filters.dateTo) return true;
    return dates.some(date => {
      if (!date) return false;
      if (filters.dateFrom && date < filters.dateFrom) return false;
      if (filters.dateTo && date > filters.dateTo) return false;
      return true;
    });
  };
  const matchesReportFilterValue = (value: unknown, expected: string) =>
    !expected || value?.toString().trim().toLowerCase() === expected.trim().toLowerCase();
  const roomMetaById = new Map<string, any>(roomReports.map((room: any) => [room.room_id?.toString(), room]));
  const roomMetaByNumber = new Map<string, any>(roomReports.map((room: any) => [room.room_number?.toString(), room]));
  const getBookingRoomMeta = (booking: any) =>
    roomMetaById.get(booking.room_id?.toString()) || roomMetaByNumber.get(booking.room_number?.toString());
  const shouldApplyBookingDateScope = Boolean(filters.dateFrom || filters.dateTo) && (filters.reportType === 'booking_approvals' || !!filters.bookingStatus);
  const filteredRoomReports = roomReports.filter((room: any) => {
    const bookingDates = filters.bookingStatus === 'Approved' ? room.approvedBookingDates : room.bookingDates;
    if (shouldApplyBookingDateScope && !dateMatches(bookingDates || [])) return false;
    if (filters.campus && room.campus !== filters.campus) return false;
    if (filters.building && room.building !== filters.building) return false;
    if (filters.block && room.block !== filters.block) return false;
    if (filters.floor && room.floor_number?.toString() !== filters.floor) return false;
    if (filters.department && room.department !== filters.department) return false;
    if (filters.year && !(room.yearTags || []).includes(filters.year)) return false;
    if (filters.semester && !(room.semesterTags || []).includes(filters.semester)) return false;
    if (filters.section && !(room.sectionTags || []).includes(filters.section)) return false;
    if (filters.room && room.room_number?.toString().trim() !== filters.room) return false;
    if (filters.roomType && room.room_type !== filters.roomType) return false;
    if (filters.bookingStatus && !(room.bookingStatuses || []).includes(filters.bookingStatus)) return false;
    if (filters.flag && !(room.flags || []).includes(filters.flag)) return false;
    if (filters.reportType === 'underused' && !(room.flags || []).includes('Underused')) return false;
    if (filters.reportType === 'overused' && !(room.flags || []).includes('Overused')) return false;
    if (filters.reportType === 'maintenance_impact' && room.maintenanceIssues <= 0) return false;
    if (filters.reportType === 'department_allocation' && room.department === 'Unmapped') return false;
    if (filters.reportType === 'booking_approvals' && !(room.bookingStatuses || []).length) return false;
    return true;
  });
  const filteredReportBookings = reportBookings.filter((booking: any) => {
    const roomMeta = getBookingRoomMeta(booking);
    const bookingDate = booking.date?.toString();
    if (filters.dateFrom && (!bookingDate || bookingDate < filters.dateFrom)) return false;
    if (filters.dateTo && (!bookingDate || bookingDate > filters.dateTo)) return false;
    if (filters.bookingStatus && !matchesReportFilterValue(booking.status, filters.bookingStatus)) return false;
    if (filters.campus && !matchesReportFilterValue(roomMeta?.campus, filters.campus)) return false;
    if (filters.building && !matchesReportFilterValue(roomMeta?.building, filters.building)) return false;
    if (filters.block && !matchesReportFilterValue(roomMeta?.block, filters.block)) return false;
    if (filters.floor && roomMeta?.floor_number?.toString() !== filters.floor) return false;
    if (filters.department && !matchesReportFilterValue(booking.department_name || roomMeta?.department, filters.department)) return false;
    if (filters.year && !(roomMeta?.yearTags || []).includes(filters.year)) return false;
    if (filters.semester && !(roomMeta?.semesterTags || []).includes(filters.semester)) return false;
    if (filters.section && !(roomMeta?.sectionTags || []).includes(filters.section)) return false;
    if (filters.room && !matchesReportFilterValue(booking.room_number || booking.room_label || roomMeta?.room_number, filters.room)) return false;
    if (filters.roomType && !matchesReportFilterValue(booking.room_type || roomMeta?.room_type, filters.roomType)) return false;
    return true;
  });
  const sortedFilteredRoomReports = [...filteredRoomReports].sort((left: any, right: any) =>
    compareRoomsByNaturalOrder(left, right)
  );
  const campusOptions = Array.from(new Set(roomReports.map((room: any) => room.campus).filter(Boolean))).sort();
  const buildingOptions = Array.from(new Set(roomReports.map((room: any) => room.building).filter(Boolean))).sort();
  const blockOptions = Array.from(new Set(roomReports
    .filter((room: any) => (!filters.campus || room.campus === filters.campus) && (!filters.building || room.building === filters.building))
    .map((room: any) => room.block)
    .filter(Boolean))).sort();
  const floorOptions = Array.from(new Set(roomReports
    .filter((room: any) =>
      (!filters.campus || room.campus === filters.campus) &&
      (!filters.building || room.building === filters.building) &&
      (!filters.block || room.block === filters.block))
    .map((room: any) => room.floor_number)
    .filter((floor: any) => floor !== undefined && floor !== null)))
    .sort((a: any, b: any) => Number(a) - Number(b));
  const roomOptions = Array.from(new Set(roomReports
    .filter((room: any) =>
      (!filters.campus || room.campus === filters.campus) &&
      (!filters.building || room.building === filters.building) &&
      (!filters.block || room.block === filters.block) &&
      (!filters.floor || room.floor_number?.toString() === filters.floor) &&
      (!filters.department || room.department === filters.department) &&
      (!filters.year || (room.yearTags || []).includes(filters.year)) &&
      (!filters.semester || (room.semesterTags || []).includes(filters.semester)) &&
      (!filters.section || (room.sectionTags || []).includes(filters.section)) &&
      (!filters.roomType || room.room_type === filters.roomType)
    )
    .map((room: any) => room.room_number?.toString().trim())
    .filter(Boolean)))
    .sort((a: any, b: any) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const yearOptions = Array.from(new Set(filteredRoomReports.flatMap((room: any) => room.yearTags || [])))
    .sort((a: any, b: any) => Number(a) - Number(b));
  const semesterOptions = Array.from(new Set(filteredRoomReports.flatMap((room: any) => room.semesterTags || [])))
    .sort((a: any, b: any) => a.localeCompare(b));
  const sectionOptions = Array.from(new Set(filteredRoomReports.flatMap((room: any) => room.sectionTags || [])))
    .sort((a: any, b: any) => a.localeCompare(b));
  const departmentOptions = Array.from(new Set([
    ...deptReports.map((department: any) => department.name),
    ...roomReports.map((room: any) => room.department)
  ].filter(Boolean))).sort();
  const roomTypeOptions = Array.from(new Set([
    ...ROOM_TYPE_OPTIONS,
    ...roomReports.map((room: any) => room.room_type)
  ].filter(Boolean))).sort();
  const flagOptions = Array.from(new Set(roomReports.flatMap((room: any) => room.flags || []))).sort();
  const bookingStatusOptions = ['Pending', 'HOD Recommended', 'Approved', 'Postponed', 'Rejected'];
  const schoolSummary = Array.from(new Set(filteredRoomReports.map((room: any) => room.school).filter(Boolean))).map((school) => {
    const schoolRooms = filteredRoomReports.filter((room: any) => room.school === school);
    const schoolDepartments = Array.from(new Set(schoolRooms.map((room: any) => room.department).filter((department: string) => department && department !== 'Unmapped')));

    return {
      name: school,
      roomCount: schoolRooms.length,
      deptCount: schoolDepartments.length,
      avgUtilization: Math.round(schoolRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (schoolRooms.length || 1)),
      totalCapacity: schoolRooms.reduce((acc: number, room: any) => acc + Number(room.capacity || 0), 0),
      unmappedRooms: schoolRooms.filter((room: any) => room.department === 'Unmapped').length,
    };
  }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const buildingSummary = Array.from(new Set(filteredRoomReports.map((room: any) => room.building))).map(building => {
    const buildingRooms = filteredRoomReports.filter((room: any) => room.building === building);
    return {
      name: building,
      roomCount: buildingRooms.length,
      avgUtilization: Math.round(buildingRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (buildingRooms.length || 1)),
      maintenanceIssues: buildingRooms.reduce((acc: number, room: any) => acc + room.maintenanceIssues, 0)
    };
  }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const campusSummary = Array.from(new Set(filteredRoomReports.map((room: any) => room.campus).filter(Boolean))).map(campus => {
    const campusRooms = filteredRoomReports.filter((room: any) => room.campus === campus);
    return {
      name: campus,
      roomCount: campusRooms.length,
      buildingCount: new Set(campusRooms.map((room: any) => room.building).filter(Boolean)).size,
      avgUtilization: Math.round(campusRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (campusRooms.length || 1)),
    };
  }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const roomTypeSummary = Array.from(new Set(filteredRoomReports.map((room: any) => getRoomTypeDisplay(room)).filter(Boolean))).map(type => {
    const typeRooms = filteredRoomReports.filter((room: any) => getRoomTypeDisplay(room) === type);
    return {
      name: type,
      roomCount: typeRooms.length,
      avgUtilization: Math.round(typeRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (typeRooms.length || 1)),
    };
  }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const usageCategorySummary = Array.from(new Set(filteredRoomReports
    .map((room: any) => room.usage_category || normalizeUsageCategoryValue('', room.room_type) || 'Unspecified')
    .filter(Boolean))).map(category => {
      const usageRooms = filteredRoomReports.filter((room: any) =>
        (room.usage_category || normalizeUsageCategoryValue('', room.room_type) || 'Unspecified') === category
      );
      return {
        name: category,
        roomCount: usageRooms.length,
        avgUtilization: Math.round(usageRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (usageRooms.length || 1)),
      };
    }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const collectSortedRoomNumbers = (values: Array<any>) =>
    Array.from(new Set(
      values
        .map((value) => value?.toString().trim())
        .filter(Boolean)
    )).sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
  const availableRoomReports = sortedFilteredRoomReports.filter((room: any) => room.status === 'Available');
  const summarizeAvailableRooms = (scope: string, rows: any[], getLabel: (room: any) => string) => Array.from(new Set(
    rows.map((room: any) => getLabel(room)).filter(Boolean)
  )).map((label) => {
    const matchingRooms = rows.filter((room: any) => getLabel(room) === label);
    const roomNumbers = collectSortedRoomNumbers(matchingRooms.map((room: any) => room.room_number));
    return {
      SummaryScope: scope,
      Category: label,
      AvailableRooms: matchingRooms.length,
      RoomNumbers: roomNumbers.join(', '),
    };
  }).sort((left: any, right: any) => {
    if (right.AvailableRooms !== left.AvailableRooms) return right.AvailableRooms - left.AvailableRooms;
    return left.Category.localeCompare(right.Category, undefined, { numeric: true, sensitivity: 'base' });
  });
  const availableRoomSummaryRows = [
    ...summarizeAvailableRooms(
      'Room Type',
      availableRoomReports.filter((room: any) => !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout))),
      (room: any) => getBaseRoomTypeDisplay(room)
    ),
    ...summarizeAvailableRooms(
      'Sub Room Type',
      availableRoomReports.filter((room: any) => HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout))),
      (room: any) => getBaseRoomTypeDisplay(room)
    ),
    ...summarizeAvailableRooms(
      'Lab Name',
      availableRoomReports.filter((room: any) =>
        normalizeRoomTypeValue(room.room_type) === 'Lab' &&
        !HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout)) &&
        room.lab_name
      ),
      (room: any) => room.lab_name?.toString().trim() || ''
    ),
    ...summarizeAvailableRooms(
      'Sub Lab Name',
      availableRoomReports.filter((room: any) =>
        normalizeRoomTypeValue(room.room_type) === 'Lab' &&
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout)) &&
        (room.sub_lab_name || room.lab_name)
      ),
      (room: any) => room.sub_lab_name?.toString().trim() || room.lab_name?.toString().trim() || ''
    ),
  ];
  const categoryTypeOptions = [
    { value: 'room_type', label: 'Room Type' },
    { value: 'sub_room_type', label: 'Sub Room Type' },
    { value: 'usage_category', label: 'Usage Category' },
    { value: 'lab_name', label: 'Lab Name' },
    { value: 'sub_lab_name', label: 'Sub Lab Name' },
    { value: 'restroom_for', label: 'Restroom For' },
    { value: 'building', label: 'Building' },
    { value: 'floor', label: 'Floor' },
    { value: 'status', label: 'Status' },
  ];
  const getCategoryValueForRoom = (room: any, categoryType: string) => {
    switch (categoryType) {
      case 'room_type':
        return getEffectiveBaseRoomTypeDisplay(room);
      case 'sub_room_type':
        return HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout))
          ? getEffectiveBaseRoomTypeDisplay(room)
          : '';
      case 'usage_category':
        return room.usage_category || normalizeUsageCategoryValue('', room.room_type) || '';
      case 'lab_name':
        return room.lab_name?.toString().trim() || '';
      case 'sub_lab_name':
        return room.sub_lab_name?.toString().trim() || '';
      case 'restroom_for':
        return room.restroom_type?.toString().trim() || '';
      case 'building':
        return room.building || '';
      case 'floor':
        return getFloorName(room.floor_number);
      case 'status':
        return room.status || '';
      default:
        return '';
    }
  };
  const categoryValueOptions = Array.from(new Set(
    filteredRoomReports
      .map((room: any) => getCategoryValueForRoom(room, filters.roomCategoryType))
      .filter(Boolean)
  )).sort((left: any, right: any) => left.toString().localeCompare(right.toString(), undefined, { numeric: true, sensitivity: 'base' }));
  const categoryWiseRoomListRows = sortedFilteredRoomReports
    .filter((room: any) => {
      const categoryValue = getCategoryValueForRoom(room, filters.roomCategoryType);
      if (!categoryValue) return false;
      if (filters.roomCategoryValue && categoryValue !== filters.roomCategoryValue) return false;
      return true;
    })
    .map((room: any) => ({
      CategoryType: categoryTypeOptions.find((option) => option.value === filters.roomCategoryType)?.label || 'Category',
      CategoryValue: getCategoryValueForRoom(room, filters.roomCategoryType),
      ReportCategory: getCategoryRoomReportGroup(room),
      RoomId: room.room_id || '',
      Room: room.room_number || '',
      RoomName: getRoomNameDisplay(room),
      Campus: room.campus || '',
      Building: room.building || '',
      Block: room.block || '',
      Floor: getFloorName(room.floor_number),
      Type: getEffectiveBaseRoomTypeDisplay(room),
      HierarchyLevel: getHierarchyLevelDisplay(room),
      ParentRoom: getParentRoomDisplay(room),
      Layout: room.room_layout || 'Normal',
      UsageCategory: room.usage_category || normalizeUsageCategoryValue('', room.room_type) || '',
      Status: room.status || '',
      Capacity: room.capacity ?? '',
    }))
    .sort((left: any, right: any) => compareRoomsByNaturalOrder(left, right));
  const categoryWiseReportGroups = CATEGORY_ROOM_REPORT_GROUP_ORDER.reduce((acc: Record<string, any[]>, groupName) => {
    acc[groupName] = categoryWiseRoomListRows.filter((row: any) => row.ReportCategory === groupName);
    return acc;
  }, {} as Record<string, any[]>);
  const categoryWiseReportGroupSummary = CATEGORY_ROOM_REPORT_GROUP_ORDER
    .map((value) => ({
      value,
      roomCount: (categoryWiseReportGroups[value] || []).length,
    }))
    .filter((item) => item.roomCount > 0);
  const categoryWiseRoomGroups = categoryWiseRoomListRows.reduce((acc: Record<string, any[]>, row: any) => {
    const key = row.CategoryValue || 'Unspecified';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
  const categoryWiseGroupSummary = Object.entries(categoryWiseRoomGroups)
    .map(([value, rows]) => ({
      value,
      roomCount: (rows as any[]).length,
    }))
    .sort((left, right) => {
      if (right.roomCount !== left.roomCount) return right.roomCount - left.roomCount;
      return left.value.localeCompare(right.value, undefined, { numeric: true, sensitivity: 'base' });
    });
  const topCategoryGroup = categoryWiseGroupSummary[0];
  const topReportCategoryGroup = categoryWiseReportGroupSummary[0];
  const filteredRoomMix = getRoomMixCounts(filteredRoomReports);
  const categoryWiseRoomMix = categoryWiseRoomListRows.reduce((acc, row) => {
    if (row?.ReportCategory === 'Class Rooms') acc.classrooms += 1;
    if (row?.ReportCategory === 'Labs') acc.labs += 1;
    return acc;
  }, { classrooms: 0, labs: 0 });
  const yearSummary = yearOptions.map((year: any) => {
    const yearRooms = filteredRoomReports.filter((room: any) => (room.yearTags || []).includes(year));
    return {
      name: `Year ${year}`,
      roomCount: yearRooms.length,
      avgUtilization: Math.round(yearRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (yearRooms.length || 1)),
    };
  });
  const semesterSummary = semesterOptions.map((semester: any) => {
    const semesterRooms = filteredRoomReports.filter((room: any) => (room.semesterTags || []).includes(semester));
    return {
      name: semester,
      roomCount: semesterRooms.length,
      avgUtilization: Math.round(semesterRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (semesterRooms.length || 1)),
    };
  });
  const sectionSummary = sectionOptions.map((section: any) => {
    const sectionRooms = filteredRoomReports.filter((room: any) => (room.sectionTags || []).includes(section));
    return {
      name: section,
      roomCount: sectionRooms.length,
      avgUtilization: Math.round(sectionRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (sectionRooms.length || 1)),
    };
  }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization);
  const departmentSummary = Array.from(new Set(filteredRoomReports.map((room: any) => room.department))).map(department => {
    const departmentRooms = filteredRoomReports.filter((room: any) => room.department === department);
    const schools = Array.from(new Set(departmentRooms.map((room: any) => room.school).filter(Boolean)));
    return {
      name: department,
      school: schools.join(', ') || 'Unmapped',
      roomCount: departmentRooms.length,
      totalCapacity: departmentRooms.reduce((acc: number, room: any) => acc + Number(room.capacity || 0), 0),
      avgUtilization: Math.round(departmentRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (departmentRooms.length || 1))
    };
  }).sort((a: any, b: any) => b.roomCount - a.roomCount);
  const bookingStatusSummary = bookingStatusOptions.map(status => ({
    name: status,
    count: filteredReportBookings.filter((booking: any) => booking.status === status).length
  })).filter(item => item.count > 0);
  const avgFilteredUtilization = Math.round(filteredRoomReports.reduce((acc: number, room: any) => acc + room.utilization, 0) / (filteredRoomReports.length || 1));
  const mostUsedRoom = [...filteredRoomReports].sort((a: any, b: any) => b.utilization - a.utilization)[0];
  const leastUsedRoom = [...filteredRoomReports].sort((a: any, b: any) => a.utilization - b.utilization)[0];
  const categorySummaryCards = filters.reportType === 'category_room_list'
    ? [
        {
          label: 'Rooms Listed',
          value: `${categoryWiseRoomListRows.length}`,
          detail: formatRoomMixSummary(categoryWiseRoomMix),
        },
        {
          label: 'Unique Categories',
          value: `${categoryWiseGroupSummary.length}`,
        },
        {
          label: filters.roomCategoryValue ? 'Selected Category' : 'Top Category',
          value: filters.roomCategoryValue || topCategoryGroup?.value || topReportCategoryGroup?.value || '-',
        },
        {
          label: filters.roomCategoryValue ? 'Matching Rooms' : 'Largest Group',
          value: `${filters.roomCategoryValue ? categoryWiseRoomListRows.length : (topCategoryGroup?.roomCount ?? topReportCategoryGroup?.roomCount ?? 0)}`,
        },
      ]
      : [
        {
          label: 'Rooms Analyzed',
          value: `${filteredRoomReports.length}`,
          detail: formatRoomMixSummary(filteredRoomMix),
        },
        {
          label: 'Avg Utilization',
          value: `${avgFilteredUtilization}%`,
        },
        {
          label: 'Most Used',
          value: mostUsedRoom?.room_number || '-',
        },
        {
          label: 'Least Used',
          value: leastUsedRoom?.room_number || '-',
        },
      ];
  const filteredRoomIdSet = new Set<string>(filteredRoomReports.map((room: any) => room.room_id?.toString()).filter(Boolean));
  const filteredRoomNumberSet = new Set<string>(filteredRoomReports.map((room: any) => room.room_number?.toString().trim()).filter(Boolean));
  const roomMetaByRoomId = new Map<string, any>(filteredRoomReports.map((room: any) => [room.room_id?.toString(), room]));
  const reportDayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const parseTimeToMinutes = (time?: string) => {
    if (!time || !time.includes(':')) return null;
    const [h, m] = time.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return (h * 60) + m;
  };
  const safeDate = (value?: string) => {
    if (!value) return null;
    const normalizedValue = normalizeComparableDateValue(value);
    if (!normalizedValue) return null;
    const date = new Date(`${normalizedValue}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const getDaysBetweenInclusive = (start?: string, end?: string) => {
    const startDate = safeDate(start);
    const endDate = safeDate(end);
    if (!startDate || !endDate || endDate < startDate) return 0;
    const diff = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000);
    return diff + 1;
  };
  const getDateDayName = (value?: string) => {
    const date = safeDate(value);
    return date ? date.toLocaleDateString('en-US', { weekday: 'long' }) : '';
  };
  const overlaps = (startA?: string, endA?: string, startB?: string, endB?: string) => {
    const aStart = parseTimeToMinutes(startA);
    const aEnd = parseTimeToMinutes(endA);
    const bStart = parseTimeToMinutes(startB);
    const bEnd = parseTimeToMinutes(endB);
    if ([aStart, aEnd, bStart, bEnd].some(value => value === null)) return false;
    return (aStart as number) < (bEnd as number) && (bStart as number) < (aEnd as number);
  };
  const semMatches = (scheduleValue: any, selectedValue: string) => {
    if (!selectedValue) return true;
    return normalizeSemesterValue(scheduleValue, '').toLowerCase() === selectedValue.toLowerCase();
  };
  const yearMatches = (scheduleValue: any, selectedValue: string) => {
    if (!selectedValue) return true;
    const normalized = normalizeYearOfStudyValue(scheduleValue);
    return normalized ? normalized === selectedValue : false;
  };
  const sectionMatches = (scheduleValue: any, selectedValue: string) => {
    if (!selectedValue) return true;
    return scheduleValue?.toString().trim().toLowerCase() === selectedValue.toLowerCase();
  };
  const departmentMatches = (_scheduleDepartmentId: any, scheduleDepartmentName: any) => {
    if (!filters.department) return true;
    if (scheduleDepartmentName?.toString().trim().toLowerCase() === filters.department.toLowerCase()) return true;
    return false;
  };
  const filteredScheduleRows = reportSchedules.filter((schedule: any) => {
    const roomIdKey = schedule.room_id?.toString();
    const roomLabel = schedule.room_label?.toString().trim() || '';
    if (roomIdKey && filteredRoomIdSet.has(roomIdKey)) {
      // pass
    } else if (roomLabel && filteredRoomNumberSet.has(roomLabel)) {
      // pass
    } else {
      return false;
    }
    if (!departmentMatches(schedule.department_id, schedule.department_name)) return false;
    if (!semMatches(schedule.semester, filters.semester)) return false;
    if (!yearMatches(schedule.year_of_study, filters.year)) return false;
    if (!sectionMatches(schedule.section, filters.section)) return false;
    return true;
  });
  const filteredApprovedBookings = filteredReportBookings.filter((booking: any) => booking.status === 'Approved');
  const hourlyWindows = Array.from({ length: 10 }, (_, index) => {
    const start = (8 + index) * 60;
    const end = start + 60;
    return {
      label: `${minutesToTime(start)}-${minutesToTime(end)}`,
      start,
      end,
    };
  });
  const occupancySnapshotTimeOptions = [
    { value: '', label: 'Full Day' },
    ...hourlyWindows.map((band) => ({ value: band.label, label: band.label })),
  ];
  const occupancySnapshotModeOptions = [
    { value: 'date', label: 'By Date' },
    { value: 'day', label: 'By Day' },
    { value: 'hour', label: 'By Hour' },
  ];
  const timeBandWindows = [
    { label: '08:00-10:00', start: 8 * 60, end: 10 * 60 },
    { label: '10:00-12:00', start: 10 * 60, end: 12 * 60 },
    { label: '12:00-14:00', start: 12 * 60, end: 14 * 60 },
    { label: '14:00-16:00', start: 14 * 60, end: 16 * 60 },
    { label: '16:00-18:00', start: 16 * 60, end: 18 * 60 },
  ];
  const summarizeWindowUtilization = (windowStart: number, windowEnd: number) => {
    const scheduledMinutes = filteredScheduleRows.reduce((acc: number, schedule: any) => {
      const start = parseTimeToMinutes(schedule.start_time);
      const end = parseTimeToMinutes(schedule.end_time);
      if (start === null || end === null || end <= start) return acc;
      const overlapMinutes = Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
      return acc + overlapMinutes;
    }, 0);
    const bookedMinutes = filteredApprovedBookings.reduce((acc: number, booking: any) => {
      const start = parseTimeToMinutes(booking.start_time);
      const end = parseTimeToMinutes(booking.end_time);
      if (start === null || end === null || end <= start) return acc;
      const overlapMinutes = Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
      return acc + overlapMinutes;
    }, 0);
    const totalMinutes = scheduledMinutes + bookedMinutes;
    const roomCount = Math.max(filteredRoomReports.length, 1);
    const scheduledEntries = filteredScheduleRows.filter((schedule: any) => {
      const start = parseTimeToMinutes(schedule.start_time);
      const end = parseTimeToMinutes(schedule.end_time);
      return start !== null && end !== null && end > start && Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart)) > 0;
    }).length;
    const approvedBookings = filteredApprovedBookings.filter((booking: any) => {
      const start = parseTimeToMinutes(booking.start_time);
      const end = parseTimeToMinutes(booking.end_time);
      return start !== null && end !== null && end > start && Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart)) > 0;
    }).length;
    const maxMinutes = roomCount * (windowEnd - windowStart) * reportDayOrder.length;
    const utilization = maxMinutes > 0 ? Math.min(100, Math.round((totalMinutes / maxMinutes) * 100)) : 0;
    return {
      scheduledHours: Math.round((scheduledMinutes / 60) * 10) / 10,
      bookedHours: Math.round((bookedMinutes / 60) * 10) / 10,
      utilization,
      scheduledEntries,
      approvedBookings,
    };
  };
  const getScheduleReportRoomNumber = (schedule: any) => {
    const roomIdKey = schedule.room_id?.toString();
    return roomMetaByRoomId.get(roomIdKey)?.room_number?.toString().trim()
      || roomMetaByNumber.get(schedule.room_label?.toString().trim())?.room_number?.toString().trim()
      || schedule.room_label?.toString().trim()
      || roomIdKey
      || '';
  };
  const getBookingReportRoomNumber = (booking: any) =>
    getBookingRoomMeta(booking)?.room_number?.toString().trim()
    || booking.room_number?.toString().trim()
    || booking.room_label?.toString().trim()
    || booking.room_id?.toString()
    || '';
  const roomTimeBandUtilization = timeBandWindows.map((band) => {
    const summary = summarizeWindowUtilization(band.start, band.end);
    return {
      band: band.label,
      ...summary,
    };
  });
  const hourlyUtilizationReport = hourlyWindows.map((band) => {
    const activeSchedules = filteredScheduleRows.filter((schedule: any) => {
      const start = parseTimeToMinutes(schedule.start_time);
      const end = parseTimeToMinutes(schedule.end_time);
      return start !== null && end !== null && end > start && Math.max(0, Math.min(end, band.end) - Math.max(start, band.start)) > 0;
    });
    const activeBookings = filteredApprovedBookings.filter((booking: any) => {
      const start = parseTimeToMinutes(booking.start_time);
      const end = parseTimeToMinutes(booking.end_time);
      return start !== null && end !== null && end > start && Math.max(0, Math.min(end, band.end) - Math.max(start, band.start)) > 0;
    });
    const roomNumbers = collectSortedRoomNumbers([
      ...activeSchedules.map((schedule: any) => getScheduleReportRoomNumber(schedule)),
      ...activeBookings.map((booking: any) => getBookingReportRoomNumber(booking)),
    ]);
    return {
      hourBand: band.label,
      ...summarizeWindowUtilization(band.start, band.end),
      occupiedRooms: roomNumbers.length,
      roomNumbers: roomNumbers.join(', '),
    };
  });
  const dayWiseUtilizationReport = reportDayOrder.map((day) => {
    const daySchedules = filteredScheduleRows.filter((schedule: any) => schedule.day_of_week === day);
    const dayBookings = filteredApprovedBookings.filter((booking: any) => getDateDayName(booking.date) === day);
    const scheduledMinutes = daySchedules.reduce((acc: number, schedule: any) => {
      const start = parseTimeToMinutes(schedule.start_time);
      const end = parseTimeToMinutes(schedule.end_time);
      if (start === null || end === null || end <= start) return acc;
      return acc + (end - start);
    }, 0);
    const bookedMinutes = dayBookings.reduce((acc: number, booking: any) => {
      const start = parseTimeToMinutes(booking.start_time);
      const end = parseTimeToMinutes(booking.end_time);
      if (start === null || end === null || end <= start) return acc;
      return acc + (end - start);
    }, 0);
    const roomNumbers = collectSortedRoomNumbers([
      ...daySchedules.map((schedule: any) => getScheduleReportRoomNumber(schedule)),
      ...dayBookings.map((booking: any) => getBookingReportRoomNumber(booking)),
    ]);
    const occupiedRooms = roomNumbers.length;
    const roomCount = Math.max(filteredRoomReports.length, 1);
    const maxMinutes = roomCount * 12 * 60;
    const utilization = maxMinutes > 0 ? Math.min(100, Math.round(((scheduledMinutes + bookedMinutes) / maxMinutes) * 100)) : 0;
    return {
      day,
      scheduledHours: Math.round((scheduledMinutes / 60) * 10) / 10,
      bookedHours: Math.round((bookedMinutes / 60) * 10) / 10,
      utilization,
      scheduledEntries: daySchedules.length,
      approvedBookings: dayBookings.length,
      occupiedRooms,
      roomNumbers: roomNumbers.join(', '),
    };
  });
  const dateScopeForOccupancy = (() => {
    const explicitFrom = normalizeComparableDateValue(filters.dateFrom);
    const explicitTo = normalizeComparableDateValue(filters.dateTo);
    if (explicitFrom && explicitTo) {
      const start = safeDate(explicitFrom);
      const end = safeDate(explicitTo);
      if (!start || !end || end < start) return [];
      const rows: string[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        rows.push(formatLocalDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return rows;
    }
    if (explicitFrom || explicitTo) {
      const seed = safeDate(explicitFrom || explicitTo);
      if (!seed) return [];
      const rows: string[] = [];
      const cursor = new Date(seed);
      if (!explicitFrom && explicitTo) cursor.setDate(cursor.getDate() - 5);
      for (let index = 0; index < 6; index += 1) {
        rows.push(formatLocalDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return rows;
    }
    return Object.values(getWeekDatesForReferenceDate(formatLocalDate(new Date())));
  })();
  const dateWiseOccupancyReport = dateScopeForOccupancy.map((date) => {
    const dayName = getDateDayName(date);
    const dateSchedules = filteredScheduleRows.filter((schedule: any) =>
      schedule.day_of_week === dayName &&
      !isScheduleSuppressedForDate(schedule, date, reportAcademicCalendars)
    );
    const dateBookings = filteredApprovedBookings.filter((booking: any) =>
      normalizeComparableDateValue(booking.date) === date
    );
    const scheduledMinutes = dateSchedules.reduce((acc: number, schedule: any) => {
      const start = parseTimeToMinutes(schedule.start_time);
      const end = parseTimeToMinutes(schedule.end_time);
      if (start === null || end === null || end <= start) return acc;
      return acc + (end - start);
    }, 0);
    const bookedMinutes = dateBookings.reduce((acc: number, booking: any) => {
      const start = parseTimeToMinutes(booking.start_time);
      const end = parseTimeToMinutes(booking.end_time);
      if (start === null || end === null || end <= start) return acc;
      return acc + (end - start);
    }, 0);
    const roomNumbers = collectSortedRoomNumbers([
      ...dateSchedules.map((schedule: any) => getScheduleReportRoomNumber(schedule)),
      ...dateBookings.map((booking: any) => getBookingReportRoomNumber(booking)),
    ]);
    const occupiedRooms = roomNumbers.length;
    const roomCount = Math.max(filteredRoomReports.length, 1);
    const maxMinutes = roomCount * 12 * 60;
    const utilization = maxMinutes > 0 ? Math.min(100, Math.round(((scheduledMinutes + bookedMinutes) / maxMinutes) * 100)) : 0;
    return {
      date,
      day: dayName,
      scheduledHours: Math.round((scheduledMinutes / 60) * 10) / 10,
      bookedHours: Math.round((bookedMinutes / 60) * 10) / 10,
      utilization,
      scheduledEntries: dateSchedules.length,
      approvedBookings: dateBookings.length,
      occupiedRooms,
      roomNumbers: roomNumbers.join(', '),
    };
  });
  const detailedRoomReportRows = sortedFilteredRoomReports.map((room: any) => ({
    RoomId: room.room_id?.toString() || '',
    Room: room.room_number,
    RoomName: getRoomNameDisplay(room),
    Aliases: getRoomAliasList(room).join(', '),
    Campus: room.campus || '',
    Building: room.building,
    Block: room.block || '',
    Floor: getFloorName(room.floor_number),
    Department: room.department,
    School: room.school,
    Type: getRoomTypeDisplay(room),
    Layout: room.room_layout || 'Normal',
    Status: room.status,
    Capacity: room.capacity,
    Utilization: `${room.utilization}%`,
    ScheduledHours: room.scheduledHours,
    BookedHours: room.bookedHours,
    Years: (room.yearTags || []).map((year: string) => `Year ${year}`).join(', '),
    Semesters: (room.semesterTags || []).join(', '),
    Sections: (room.sectionTags || []).join(', '),
    Flags: (room.flags || []).join(', '),
  }));
  const parseTimeWindowLabel = (value?: string) => {
    if (!value || !value.includes('-')) return null;
    const [startLabel, endLabel] = value.split('-').map((item) => item.trim());
    const start = parseTimeToMinutes(startLabel);
    const end = parseTimeToMinutes(endLabel);
    if (start === null || end === null || end <= start) return null;
    return { label: value, start, end };
  };
  const occupancySnapshotMode = filters.snapshotMode || 'date';
  const occupancySnapshotWindow = parseTimeWindowLabel(filters.snapshotTime);
  const occupancySnapshotDates = (() => {
    if (occupancySnapshotMode === 'day') return [];
    const explicitFrom = normalizeComparableDateValue(filters.dateFrom);
    const explicitTo = normalizeComparableDateValue(filters.dateTo);
    if (explicitFrom && explicitTo) {
      const start = safeDate(explicitFrom);
      const end = safeDate(explicitTo);
      if (!start || !end || end < start) return [];
      const rows: string[] = [];
      const cursor = new Date(start);
      while (cursor <= end) {
        rows.push(formatLocalDate(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      return rows;
    }
    if (explicitFrom || explicitTo) {
      return [explicitFrom || explicitTo].filter(Boolean) as string[];
    }
    if (occupancySnapshotMode === 'hour' && filters.snapshotDay) return [];
    return [formatLocalDate(new Date())];
  })();
  const getEntryWindowOverlap = (startTime?: string, endTime?: string) => {
    const start = parseTimeToMinutes(startTime);
    const end = parseTimeToMinutes(endTime);
    if (start === null || end === null || end <= start) return false;
    if (occupancySnapshotMode !== 'hour' || !occupancySnapshotWindow) return true;
    return Math.max(0, Math.min(end, occupancySnapshotWindow.end) - Math.max(start, occupancySnapshotWindow.start)) > 0;
  };
  const formatOccupancyEntry = (entry: any, source: 'Schedule' | 'Booking') => {
    const title = source === 'Schedule'
      ? [entry.course_name, entry.course_code, entry.faculty].filter(Boolean).join(' | ')
      : [entry.event_name || entry.purpose, entry.department_name, entry.status].filter(Boolean).join(' | ');
    return title || `${source} ${entry.start_time || ''}-${entry.end_time || ''}`.trim();
  };
  const perRoomOccupancySnapshotRows = (() => {
    const rows: any[] = [];
    const selectedDay = (occupancySnapshotMode === 'day' || occupancySnapshotMode === 'hour')
      ? (filters.snapshotDay || getDateDayName(formatLocalDate(new Date())))
      : '';
    const pushSnapshotRow = (room: any, dateLabel: string, dayLabel: string, matchingSchedules: any[], matchingBookings: any[], suppressedSchedules: any[]) => {
      const details = [
        ...matchingSchedules.map((entry) => formatOccupancyEntry(entry, 'Schedule')),
        ...matchingBookings.map((entry) => formatOccupancyEntry(entry, 'Booking')),
        ...suppressedSchedules.map((entry) => `Exam suppressed: ${formatOccupancyEntry(entry, 'Schedule')}`),
      ].filter(Boolean);
      const activeCount = matchingSchedules.length + matchingBookings.length;
      const occupancyStatus = activeCount > 1
        ? 'Multiple'
        : activeCount === 1
          ? 'Occupied'
          : suppressedSchedules.length > 0
            ? 'Exam Blocked'
            : 'Vacant';
      rows.push({
        Date: dateLabel,
        Day: dayLabel,
        HourBand: occupancySnapshotMode === 'hour'
          ? (occupancySnapshotWindow?.label || 'Full Day')
          : 'All Hours',
        Room: room.room_number,
        RoomName: getRoomNameDisplay(room),
        Campus: room.campus || '',
        Building: room.building,
        Block: room.block || '',
        Floor: getFloorName(room.floor_number),
        Department: room.department,
        School: room.school,
        Type: getRoomTypeDisplay(room),
        Capacity: room.capacity,
        OccupancyStatus: occupancyStatus,
        ScheduledEntries: matchingSchedules.length,
        ApprovedBookings: matchingBookings.length,
        SuppressedSchedules: suppressedSchedules.length,
        Details: details.join(' || '),
      });
    };
    filteredRoomReports.forEach((room: any) => {
      const roomId = room.room_id?.toString();
      const roomNumber = room.room_number?.toString().trim();
      const roomScheduleRows = filteredScheduleRows.filter((schedule: any) => {
        const scheduleRoomId = schedule.room_id?.toString();
        const scheduleRoomLabel = schedule.room_label?.toString().trim();
        return (roomId && scheduleRoomId === roomId) || (roomNumber && scheduleRoomLabel === roomNumber);
      });
      const roomBookingRows = filteredApprovedBookings.filter((booking: any) => {
        const bookingRoomId = booking.room_id?.toString();
        const bookingRoomNumber = (booking.room_number || booking.room_label)?.toString().trim();
        return (roomId && bookingRoomId === roomId) || (roomNumber && bookingRoomNumber === roomNumber);
      });
      if (occupancySnapshotDates.length > 0) {
        occupancySnapshotDates.forEach((date) => {
          const dayLabel = getDateDayName(date);
          const matchingSchedules = roomScheduleRows.filter((schedule: any) =>
            schedule.day_of_week === dayLabel &&
            !isScheduleSuppressedForDate(schedule, date, reportAcademicCalendars) &&
            getEntryWindowOverlap(schedule.start_time, schedule.end_time)
          );
          const suppressedSchedules = roomScheduleRows.filter((schedule: any) =>
            schedule.day_of_week === dayLabel &&
            isScheduleSuppressedForDate(schedule, date, reportAcademicCalendars) &&
            getEntryWindowOverlap(schedule.start_time, schedule.end_time)
          );
          const matchingBookings = roomBookingRows.filter((booking: any) =>
            normalizeComparableDateValue(booking.date) === date &&
            getEntryWindowOverlap(booking.start_time, booking.end_time)
          );
          pushSnapshotRow(room, date, dayLabel, matchingSchedules, matchingBookings, suppressedSchedules);
        });
      } else if (selectedDay) {
        const matchingSchedules = roomScheduleRows.filter((schedule: any) =>
          schedule.day_of_week === selectedDay &&
          getEntryWindowOverlap(schedule.start_time, schedule.end_time)
        );
        const matchingBookings = roomBookingRows.filter((booking: any) =>
          getDateDayName(booking.date) === selectedDay &&
          getEntryWindowOverlap(booking.start_time, booking.end_time)
        );
        pushSnapshotRow(room, '-', selectedDay, matchingSchedules, matchingBookings, []);
      }
    });
    return rows;
  })();
  const detectTimeConflict = (entries: any[]) =>
    entries.some((entry: any, index: number) =>
      entries.slice(index + 1).some((other: any) => overlaps(entry.start_time, entry.end_time, other.start_time, other.end_time))
    );
  const selectedPerRoomMatrixRoom = filters.reportType === 'per_room_occupancy' && filteredRoomReports.length === 1
    ? filteredRoomReports[0]
    : null;
  const perRoomOccupancyMatrix = (() => {
    if (!selectedPerRoomMatrixRoom) return null;
    const roomId = selectedPerRoomMatrixRoom.room_id?.toString();
    const roomNumber = selectedPerRoomMatrixRoom.room_number?.toString().trim();
    const roomScheduleRows = filteredScheduleRows.filter((schedule: any) => {
      const scheduleRoomId = schedule.room_id?.toString();
      const scheduleRoomLabel = schedule.room_label?.toString().trim();
      return (roomId && scheduleRoomId === roomId) || (roomNumber && scheduleRoomLabel === roomNumber);
    });
    const roomBookingRows = filteredApprovedBookings.filter((booking: any) => {
      const bookingRoomId = booking.room_id?.toString();
      const bookingRoomNumber = (booking.room_number || booking.room_label)?.toString().trim();
      return (roomId && bookingRoomId === roomId) || (roomNumber && bookingRoomNumber === roomNumber);
    });
    const entryMatchesWindow = (entry: any, window?: { start: number; end: number }) => {
      const start = parseTimeToMinutes(entry.start_time);
      const end = parseTimeToMinutes(entry.end_time);
      if (start === null || end === null || end <= start) return false;
      if (!window) return true;
      return Math.max(0, Math.min(end, window.end) - Math.max(start, window.start)) > 0;
    };
    const sumMinutes = (entries: any[], window?: { start: number; end: number }) => entries.reduce((acc: number, entry: any) => {
      const start = parseTimeToMinutes(entry.start_time);
      const end = parseTimeToMinutes(entry.end_time);
      if (start === null || end === null || end <= start) return acc;
      if (!window) return acc + (end - start);
      return acc + Math.max(0, Math.min(end, window.end) - Math.max(start, window.start));
    }, 0);
    const summarizeSegment = (params: { date?: string; day?: string; window?: { label: string; start: number; end: number } }) => {
      const normalizedDate = params.date ? normalizeComparableDateValue(params.date) : '';
      const dayLabel = params.date ? getDateDayName(params.date) : (params.day || '');
      const matchingSchedules = roomScheduleRows.filter((schedule: any) =>
        schedule.day_of_week === dayLabel &&
        (!normalizedDate || !isScheduleSuppressedForDate(schedule, normalizedDate, reportAcademicCalendars)) &&
        entryMatchesWindow(schedule, params.window)
      );
      const suppressedSchedules = normalizedDate
        ? roomScheduleRows.filter((schedule: any) =>
            schedule.day_of_week === dayLabel &&
            isScheduleSuppressedForDate(schedule, normalizedDate, reportAcademicCalendars) &&
            entryMatchesWindow(schedule, params.window)
          )
        : [];
      const matchingBookings = roomBookingRows.filter((booking: any) =>
        ((normalizedDate && normalizeComparableDateValue(booking.date) === normalizedDate) ||
          (!normalizedDate && getDateDayName(booking.date) === dayLabel)) &&
        entryMatchesWindow(booking, params.window)
      );
      const scheduledMinutes = sumMinutes(matchingSchedules, params.window);
      const bookedMinutes = sumMinutes(matchingBookings, params.window);
      const activeEntries = [...matchingSchedules, ...matchingBookings];
      const hasConflict = detectTimeConflict(activeEntries);
      const occupancyStatus = hasConflict
        ? 'Multiple'
        : activeEntries.length > 0
          ? 'Occupied'
          : suppressedSchedules.length > 0
            ? 'Exam Blocked'
            : 'Vacant';
      const baseWindowMinutes = params.window ? (params.window.end - params.window.start) : 12 * 60;
      const utilization = baseWindowMinutes > 0
        ? Math.min(100, Math.round(((scheduledMinutes + bookedMinutes) / baseWindowMinutes) * 100))
        : 0;
      return {
        scheduledHours: Math.round((scheduledMinutes / 60) * 10) / 10,
        bookedHours: Math.round((bookedMinutes / 60) * 10) / 10,
        utilization: `${utilization}%`,
        scheduledEntries: matchingSchedules.length,
        approvedBookings: matchingBookings.length,
        status: occupancyStatus,
      };
    };
    const segments = occupancySnapshotMode === 'hour'
      ? hourlyWindows.map((window) => ({
          label: window.label,
          summary: summarizeSegment({
            date: occupancySnapshotDates[0] || '',
            day: occupancySnapshotDates.length === 0 ? (filters.snapshotDay || getDateDayName(formatLocalDate(new Date()))) : '',
            window,
          }),
        }))
      : occupancySnapshotMode === 'day'
        ? reportDayOrder.map((day) => ({
            label: day,
            summary: summarizeSegment({ day }),
          }))
        : occupancySnapshotDates.map((date) => ({
            label: formatDisplayDate(date),
            summary: summarizeSegment({ date }),
          }));
    const metricRows = [
      {
        Metric: 'Scheduled Hours',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.scheduledHours])),
      },
      {
        Metric: 'Booked Hours',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.bookedHours])),
      },
      {
        Metric: 'Utilization',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.utilization])),
      },
      {
        Metric: 'Scheduled Entries',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.scheduledEntries])),
      },
      {
        Metric: 'Approved Bookings',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.approvedBookings])),
      },
      {
        Metric: 'Status',
        ...Object.fromEntries(segments.map((segment) => [segment.label, segment.summary.status])),
      },
    ];
    return {
      room: selectedPerRoomMatrixRoom.room_number,
      columns: segments.map((segment) => segment.label),
      rows: metricRows,
    };
  })();
  const perRoomOccupancyMatrixColumns = perRoomOccupancyMatrix
    ? ['Metric', ...perRoomOccupancyMatrix.columns]
    : [];
  const departmentNamesForDemand = Array.from(new Set<string>([
    ...filteredScheduleRows.map((schedule: any) => schedule.department_name || roomMetaByRoomId.get(schedule.room_id?.toString())?.department || 'Unmapped'),
    ...filteredApprovedBookings.map((booking: any) => booking.department_name || getBookingRoomMeta(booking)?.department || 'Unmapped'),
  ].filter(Boolean))).sort();
  const departmentRoomTypeDemand = departmentNamesForDemand.map((department: string) => {
    const roomTypeCounts = roomTypeOptions.reduce<Record<string, number>>((acc: Record<string, number>, roomType: string) => {
      const normalizedRoomType = roomType.toLowerCase();
      const scheduleCount = filteredScheduleRows.filter((schedule: any) => {
        const scheduleDepartment = schedule.department_name || roomMetaByRoomId.get(schedule.room_id?.toString())?.department || 'Unmapped';
        const scheduleRoomType = getRoomTypeDisplay(roomMetaByRoomId.get(schedule.room_id?.toString()) || { room_type: schedule.room_type || '' }).toLowerCase();
        return scheduleDepartment === department && scheduleRoomType === normalizedRoomType;
      }).length;
      const bookingCount = filteredApprovedBookings.filter((booking: any) => {
        const bookingDepartment = booking.department_name || getBookingRoomMeta(booking)?.department || 'Unmapped';
        const bookingRoomType = getRoomTypeDisplay(getBookingRoomMeta(booking) || { room_type: booking.room_type || '' }).toLowerCase();
        return bookingDepartment === department && bookingRoomType === normalizedRoomType;
      }).length;
      acc[roomType] = scheduleCount + bookingCount;
      return acc;
    }, {});
    const totalDemand: number = Object.values(roomTypeCounts).reduce((sum: number, value) => sum + Number(value || 0), 0);
    return { department, totalDemand, roomTypeCounts };
  }).filter((row) => row.totalDemand > 0).sort((a, b) => b.totalDemand - a.totalDemand);
  const scheduleOverlapRows = (() => {
    const clashes: any[] = [];
    const grouped = new Map<string, any[]>();
    filteredScheduleRows.forEach((schedule: any) => {
      const key = `${schedule.room_id || schedule.room_label || 'unknown'}__${schedule.day_of_week || ''}`;
      const rows = grouped.get(key) || [];
      rows.push(schedule);
      grouped.set(key, rows);
    });
    grouped.forEach((rows, key) => {
      const sorted = rows
        .filter((row: any) => row.start_time && row.end_time)
        .sort((a: any, b: any) => (a.start_time || '').localeCompare(b.start_time || ''));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          if (!overlaps(sorted[i].start_time, sorted[i].end_time, sorted[j].start_time, sorted[j].end_time)) break;
          clashes.push({
            room: sorted[i].room_label || roomMetaByRoomId.get(sorted[i].room_id?.toString())?.room_number || sorted[i].room_id,
            day: sorted[i].day_of_week,
            yearA: getYearDisplayLabel(sorted[i].year_of_study, sorted[i].semester),
            semesterA: normalizeSemesterValue(sorted[i].semester, '-') || '-',
            startA: sorted[i].start_time,
            endA: sorted[i].end_time,
            courseA: sorted[i].course_name || sorted[i].course_code || 'Schedule A',
            sectionA: sorted[i].section || '',
            yearB: getYearDisplayLabel(sorted[j].year_of_study, sorted[j].semester),
            semesterB: normalizeSemesterValue(sorted[j].semester, '-') || '-',
            startB: sorted[j].start_time,
            endB: sorted[j].end_time,
            courseB: sorted[j].course_name || sorted[j].course_code || 'Schedule B',
            sectionB: sorted[j].section || '',
            source: 'Timetable',
            key,
          });
        }
      }
    });
    return clashes;
  })();
  const bookingOverlapRows = (() => {
    const clashes: any[] = [];
    const grouped = new Map<string, any[]>();
    filteredApprovedBookings.forEach((booking: any) => {
      const key = `${booking.room_id || booking.room_number || 'unknown'}__${booking.date || ''}`;
      const rows = grouped.get(key) || [];
      rows.push(booking);
      grouped.set(key, rows);
    });
    grouped.forEach((rows) => {
      const sorted = rows
        .filter((row: any) => row.start_time && row.end_time)
        .sort((a: any, b: any) => (a.start_time || '').localeCompare(b.start_time || ''));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          if (!overlaps(sorted[i].start_time, sorted[i].end_time, sorted[j].start_time, sorted[j].end_time)) break;
          clashes.push({
            room: getBookingRoomMeta(sorted[i])?.room_number || sorted[i].room_number || sorted[i].room_id,
            day: sorted[i].date || '',
            yearA: '-',
            semesterA: '-',
            startA: sorted[i].start_time,
            endA: sorted[i].end_time,
            courseA: sorted[i].event_name || 'Booking A',
            sectionA: sorted[i].faculty_name || '',
            yearB: '-',
            semesterB: '-',
            startB: sorted[j].start_time,
            endB: sorted[j].end_time,
            courseB: sorted[j].event_name || 'Booking B',
            sectionB: sorted[j].faculty_name || '',
            source: 'Booking',
          });
        }
      }
    });
    return clashes;
  })();
  const overlapConflictReport = [...scheduleOverlapRows, ...bookingOverlapRows];
  const vacancyOpportunityReport = filteredRoomReports
    .map((room: any) => {
      const weeklyHours = 72;
      const usedHours = Number(room.totalUsedHours || 0);
      const idleHours = Math.max(0, weeklyHours - usedHours);
      return {
        room: room.room_number,
        building: room.building,
        department: room.department,
        utilization: room.utilization,
        idleHours: Math.round(idleHours * 10) / 10,
        opportunity: idleHours >= 50 ? 'High' : idleHours >= 30 ? 'Medium' : 'Low',
      };
    })
    .sort((a: any, b: any) => b.idleHours - a.idleHours)
    .slice(0, 50);
  const capacityMismatchReport = filteredApprovedBookings
    .map((booking: any) => {
      const roomMeta = getBookingRoomMeta(booking);
      const roomCapacity = Number(roomMeta?.capacity || 0);
      const studentCount = Number(booking?.student_count || 0);
      const occupancyPercent = roomCapacity > 0 ? Math.round((studentCount / roomCapacity) * 100) : 0;
      const mismatchType = roomCapacity <= 0 || studentCount <= 0
        ? 'Missing Strength'
        : occupancyPercent > 100
          ? 'Over Capacity'
          : occupancyPercent < 40
            ? 'Underutilized Capacity'
            : 'Good Fit';
      return {
        date: booking.date,
        room: roomMeta?.room_number || booking.room_number || booking.room_id,
        department: booking.department_name || roomMeta?.department || 'Unmapped',
        event: booking.event_name || 'Booking',
        roomCapacity,
        studentCount,
        occupancyPercent,
        mismatchType,
      };
    })
    .filter((row: any) => row.mismatchType !== 'Good Fit')
    .sort((a: any, b: any) => b.occupancyPercent - a.occupancyPercent);
  const examImpactReport = reportAcademicCalendars
    .filter((calendar: any) =>
      isExaminationCalendarEvent(calendar) &&
      (!filters.department || matchesReportFilterValue(calendar.department_name, filters.department)) &&
      (!filters.semester || normalizeSemesterValue(calendar.semester, '').toLowerCase() === filters.semester.toLowerCase()) &&
      (!filters.year || normalizeYearOfStudyValue(calendar.year_of_study) === filters.year) &&
      (!filters.dateFrom || normalizeComparableDateValue(calendar.end_date || calendar.start_date) >= normalizeComparableDateValue(filters.dateFrom)) &&
      (!filters.dateTo || normalizeComparableDateValue(calendar.start_date || calendar.end_date) <= normalizeComparableDateValue(filters.dateTo)),
    )
    .map((calendar: any) => {
      const scheduleMatches = filteredScheduleRows.filter((schedule: any) => {
        const semesterMatch = normalizeSemesterValue(schedule.semester, '').toLowerCase() === normalizeSemesterValue(calendar.semester, '').toLowerCase();
        const deptMatch = matchesReportFilterValue(schedule.department_name, calendar.department_name);
        return semesterMatch && deptMatch;
      });
      const days = getDaysBetweenInclusive(calendar.start_date, calendar.end_date);
      const blockedClassSessions = scheduleMatches.length * Math.max(1, Math.min(days, 6));
      return {
        title: calendar.title || 'Examination Window',
        department: calendar.department_name || 'Unmapped',
        semester: calendar.semester || '-',
        startDate: calendar.start_date,
        endDate: calendar.end_date,
        days,
        affectedWeeklyClasses: scheduleMatches.length,
        estimatedBlockedSessions: blockedClassSessions,
      };
    })
    .sort((a: any, b: any) => b.estimatedBlockedSessions - a.estimatedBlockedSessions);
  const bookingLifecycleReport = (() => {
    const leadTimes = filteredReportBookings
      .map((booking: any) => {
        const eventDate = safeDate(booking.date);
        const requestedDateRaw = booking.requested_date || booking.created_at || booking.requested_at || '';
        const requestedDate = requestedDateRaw ? safeDate(requestedDateRaw.toString().slice(0, 10)) : null;
        if (!eventDate || !requestedDate) return null;
        return Math.floor((eventDate.getTime() - requestedDate.getTime()) / 86400000);
      })
      .filter((value: any) => value !== null && value >= 0) as number[];
    const averageLeadDays = leadTimes.length
      ? Math.round((leadTimes.reduce((sum, value) => sum + value, 0) / leadTimes.length) * 10) / 10
      : null;
    const cancellations = filteredReportBookings.filter((booking: any) => ['Rejected', 'Postponed'].includes(booking.status)).length;
    const approvals = filteredReportBookings.filter((booking: any) => booking.status === 'Approved').length;
    const cancellationRate = filteredReportBookings.length > 0 ? Math.round((cancellations / filteredReportBookings.length) * 100) : 0;
    return {
      totalRequests: filteredReportBookings.length,
      approvals,
      cancellations,
      cancellationRate,
      averageLeadDays,
      leadTimeCapturedCount: leadTimes.length,
    };
  })();
  const noShowRiskReport = filteredApprovedBookings
    .map((booking: any) => {
      const roomMeta = getBookingRoomMeta(booking);
      const roomCapacity = Number(roomMeta?.capacity || 0);
      const studentCount = Number(booking?.student_count || 0);
      const occupancyPercent = roomCapacity > 0 && studentCount > 0 ? Math.round((studentCount / roomCapacity) * 100) : 0;
      const bookingDate = safeDate(booking.date);
      const isPast = bookingDate ? bookingDate.getTime() < Date.now() : false;
      const riskScore =
        (studentCount <= 0 ? 60 : 0) +
        (roomCapacity > 0 && occupancyPercent < 25 ? 30 : 0) +
        (isPast ? 10 : 0);
      return {
        bookingId: booking.request_id || booking.id,
        date: booking.date,
        room: roomMeta?.room_number || booking.room_number || booking.room_id,
        department: booking.department_name || roomMeta?.department || 'Unmapped',
        event: booking.event_name || 'Booking',
        studentCount,
        roomCapacity,
        occupancyPercent,
        riskScore,
      };
    })
    .filter((row: any) => row.riskScore >= 40)
    .sort((a: any, b: any) => b.riskScore - a.riskScore);
  const sharedRoomConflictRiskReport = filteredRoomReports
    .map((room: any) => {
      const roomId = room.room_id?.toString();
      const roomSchedules = filteredScheduleRows.filter((schedule: any) => schedule.room_id?.toString() === roomId);
      const departments = new Set(roomSchedules.map((schedule: any) => schedule.department_name).filter(Boolean));
      const sections = new Set(roomSchedules.map((schedule: any) => schedule.section?.toString().trim()).filter(Boolean));
      const overlapsCount = overlapConflictReport.filter((conflict: any) =>
        conflict.room?.toString().trim().toLowerCase() === room.room_number?.toString().trim().toLowerCase()
      ).length;
      const aliasCount = getRoomAliasList(room).length;
      const isSharedRoom = (room.room_layout || '').toLowerCase() === 'shared room' || aliasCount > 0 || room.room_number?.toString().includes('&');
      const riskScore =
        (isSharedRoom ? 35 : 0) +
        Math.min(30, departments.size * 10) +
        Math.min(20, sections.size * 5) +
        Math.min(15, overlapsCount * 5);
      return {
        room: room.room_number,
        building: room.building,
        roomLayout: room.room_layout || 'Normal',
        aliases: getRoomAliasList(room).join(', '),
        departments: departments.size,
        sections: sections.size,
        overlaps: overlapsCount,
        riskScore,
      };
    })
    .filter((row: any) => row.riskScore >= 35)
    .sort((a: any, b: any) => b.riskScore - a.riskScore);
  const semesterPeakLoadForecast = (() => {
    const grouped = new Map<string, { semester: string; day: string; peakSlots: number; totalClasses: number; peakBand: string }>();
    const bandNames = timeBandWindows.map((band) => band.label);
    const rows = filteredScheduleRows.filter((schedule: any) => schedule.day_of_week && schedule.start_time && schedule.end_time);
    const semesters = Array.from(new Set(rows.map((schedule: any) => normalizeSemesterValue(schedule.semester, 'Unknown'))));
    semesters.forEach((semester) => {
      reportDayOrder.forEach((day) => {
        const dayRows = rows.filter((schedule: any) =>
          normalizeSemesterValue(schedule.semester, 'Unknown') === semester &&
          schedule.day_of_week === day
        );
        if (dayRows.length === 0) return;
        const bandCounts = new Map<string, number>(bandNames.map((name) => [name, 0]));
        dayRows.forEach((schedule: any) => {
          const start = parseTimeToMinutes(schedule.start_time);
          const end = parseTimeToMinutes(schedule.end_time);
          if (start === null || end === null || end <= start) return;
          timeBandWindows.forEach((band) => {
            const overlapMinutes = Math.max(0, Math.min(end, band.end) - Math.max(start, band.start));
            if (overlapMinutes > 0) bandCounts.set(band.label, (bandCounts.get(band.label) || 0) + 1);
          });
        });
        const peakEntry = Array.from(bandCounts.entries()).sort((a, b) => b[1] - a[1])[0];
        grouped.set(`${semester}-${day}`, {
          semester,
          day,
          peakSlots: peakEntry?.[1] || 0,
          totalClasses: dayRows.length,
          peakBand: peakEntry?.[0] || 'N/A',
        });
      });
    });
    return Array.from(grouped.values()).sort((a, b) =>
      normalizeSemesterValue(a.semester, '').localeCompare(normalizeSemesterValue(b.semester, '')) ||
      reportDayOrder.indexOf(a.day) - reportDayOrder.indexOf(b.day)
    );
  })();
  const buildWorksheetFromRows = (rows: any[], columns?: string[]) => {
    const safeRows = Array.isArray(rows) ? rows : [];
    const resolvedColumns = (columns && columns.length > 0)
      ? columns
      : (safeRows[0] ? Object.keys(safeRows[0]) : []);
    if (resolvedColumns.length === 0) {
      return XLSX.utils.aoa_to_sheet([['No data available']]);
    }
    const orderedRows = safeRows.map((row: any) => resolvedColumns.reduce((acc: any, column) => {
      acc[column] = row?.[column] ?? '';
      return acc;
    }, {}));
    return XLSX.utils.json_to_sheet(orderedRows, { header: resolvedColumns });
  };
  const sanitizeReportSheetName = (value: string) =>
    value.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Export';
  const toNumericValue = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = value
      .toString()
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim();
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const buildVisualizationRows = (rows: any[], columns?: string[]) => {
    const safeRows = Array.isArray(rows) ? rows : [];
    const resolvedColumns = (columns && columns.length > 0)
      ? columns
      : (safeRows[0] ? Object.keys(safeRows[0]) : []);
    if (safeRows.length === 0 || resolvedColumns.length === 0) {
      return [{
        'Visualization Type': 'info',
        Label: 'No data available',
        Value: '',
        Metric: '',
        Note: 'Source report has no rows for the current filters.',
      }];
    }

    const numericColumns = resolvedColumns.filter((column) =>
      safeRows.some((row: any) => toNumericValue(row?.[column]) != null)
    );
    const categoricalColumns = resolvedColumns.filter((column) =>
      safeRows.some((row: any) => {
        const value = row?.[column];
        return value != null && toNumericValue(value) == null && value.toString().trim() !== '';
      })
    );

    const visualizationRows: Array<Record<string, any>> = [{
      'Visualization Type': 'kpi',
      Label: 'Total Rows',
      Value: safeRows.length,
      Metric: 'count',
      Note: 'Total records in this report.',
    }];

    numericColumns.forEach((column) => {
      const values = safeRows
        .map((row: any) => toNumericValue(row?.[column]))
        .filter((value): value is number => value != null);
      if (values.length === 0) return;
      const sum = values.reduce((acc, value) => acc + value, 0);
      const avg = sum / values.length;
      visualizationRows.push({
        'Visualization Type': 'metric',
        Label: column,
        Value: Math.round(sum * 100) / 100,
        Metric: 'sum',
        Note: `Average: ${Math.round(avg * 100) / 100}`,
      });
    });

    const primaryCategory = categoricalColumns[0];
    if (primaryCategory) {
      const distribution = new Map<string, number>();
      safeRows.forEach((row: any) => {
        const label = (row?.[primaryCategory] ?? 'Unknown').toString().trim() || 'Unknown';
        distribution.set(label, (distribution.get(label) || 0) + 1);
      });
      Array.from(distribution.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .forEach(([label, count]) => {
          visualizationRows.push({
            'Visualization Type': 'distribution',
            Label: label,
            Value: count,
            Metric: primaryCategory,
            Note: `Top distribution by ${primaryCategory}`,
          });
        });
    }

    return visualizationRows;
  };
  const appendVisualizationSheet = (workbook: XLSX.WorkBook, baseSheetName: string, rows: any[], columns?: string[]) => {
    const visualRows = buildVisualizationRows(rows, columns);
    const visualWorksheet = buildWorksheetFromRows(
      visualRows,
      ['Visualization Type', 'Label', 'Value', 'Metric', 'Note'],
    );
    XLSX.utils.book_append_sheet(workbook, visualWorksheet, sanitizeReportSheetName(`${baseSheetName} Visual`));
  };
  const getChartRecommendationMeta = (
    reportType: string,
    columns: string[],
  ): { chart: string; xAxis: string; yAxis: string; sortBy: string; note: string } => {
    const defaults = {
      chart: 'Column Chart',
      xAxis: columns[0] || 'Category',
      yAxis: columns[1] || 'Value',
      sortBy: columns[1] || 'Value',
      note: 'Use this chart for a quick category-vs-value comparison.',
    };
    const known: Record<string, { chart: string; xAxis: string; yAxis: string; sortBy: string; note: string }> = {
      room_utilization: {
        chart: 'Horizontal Bar',
        xAxis: 'Room',
        yAxis: 'Utilization',
        sortBy: 'Utilization (desc)',
        note: 'Best for top/bottom utilized rooms.',
      },
      room_level_detail: {
        chart: 'Horizontal Bar',
        xAxis: 'Room',
        yAxis: 'Utilization',
        sortBy: 'Utilization (desc)',
        note: 'Detailed room-by-room operational picture with academic context tags.',
      },
      category_room_list: {
        chart: 'Column Chart',
        xAxis: 'ReportCategory',
        yAxis: 'Room Count',
        sortBy: 'Room Count (desc)',
        note: 'Shows how filtered rooms are distributed by grouped room categories and location.',
      },
      campus_utilization: {
        chart: 'Column Chart',
        xAxis: 'Campus',
        yAxis: 'AvgUtilization',
        sortBy: 'AvgUtilization (desc)',
        note: 'Compares campus-wise average utilization.',
      },
      school_utilization: {
        chart: 'Column Chart',
        xAxis: 'School',
        yAxis: 'AvgUtilization',
        sortBy: 'AvgUtilization (desc)',
        note: 'Shows school-wise utilization distribution.',
      },
      building_utilization: {
        chart: 'Column Chart',
        xAxis: 'Building',
        yAxis: 'AvgUtilization',
        sortBy: 'AvgUtilization (desc)',
        note: 'Highlights high/low performing buildings.',
      },
      department_allocation: {
        chart: 'Clustered Bar',
        xAxis: 'Department',
        yAxis: 'Rooms / TotalCapacity',
        sortBy: 'Rooms (desc)',
        note: 'Compares room allocation and capacity by department.',
      },
      room_type_utilization: {
        chart: 'Bar Chart',
        xAxis: 'RoomType',
        yAxis: 'AvgUtilization',
        sortBy: 'AvgUtilization (desc)',
        note: 'Useful for room-type-wise performance.',
      },
      usage_category_utilization: {
        chart: 'Donut Chart',
        xAxis: 'UsageCategory',
        yAxis: 'Rooms',
        sortBy: 'Rooms (desc)',
        note: 'Shows usage share by category.',
      },
      year_utilization: {
        chart: 'Bar Chart',
        xAxis: 'Year',
        yAxis: 'AvgUtilization',
        sortBy: 'Year (asc)',
        note: 'Tracks utilization across years of study.',
      },
      semester_utilization: {
        chart: 'Bar Chart',
        xAxis: 'Semester',
        yAxis: 'AvgUtilization',
        sortBy: 'Semester (asc)',
        note: 'Compares odd/even semester utilization.',
      },
      section_utilization: {
        chart: 'Bar Chart',
        xAxis: 'Section',
        yAxis: 'AvgUtilization',
        sortBy: 'AvgUtilization (desc)',
        note: 'Identifies heavily utilized sections.',
      },
      booking_approvals: {
        chart: 'Pie Chart',
        xAxis: 'Status',
        yAxis: 'Count',
        sortBy: 'Count (desc)',
        note: 'Best for approval status composition.',
      },
      maintenance_impact: {
        chart: 'Bar Chart',
        xAxis: 'Room',
        yAxis: 'MaintenanceIssues',
        sortBy: 'MaintenanceIssues (desc)',
        note: 'Surfaces rooms with maintenance burden.',
      },
      underused: {
        chart: 'Horizontal Bar',
        xAxis: 'Room',
        yAxis: 'Utilization',
        sortBy: 'Utilization (asc)',
        note: 'Shows lowest utilized rooms first.',
      },
      overused: {
        chart: 'Horizontal Bar',
        xAxis: 'Room',
        yAxis: 'Utilization',
        sortBy: 'Utilization (desc)',
        note: 'Shows highest utilized rooms first.',
      },
      time_band_utilization: {
        chart: 'Line Chart',
        xAxis: 'TimeBand',
        yAxis: 'Utilization',
        sortBy: 'TimeBand (asc)',
        note: 'Best for utilization trend across time windows.',
      },
      hourly_utilization: {
        chart: 'Line Chart',
        xAxis: 'HourBand',
        yAxis: 'Utilization',
        sortBy: 'HourBand (asc)',
        note: 'Highlights the busiest and quietest hourly windows.',
      },
      day_wise_utilization: {
        chart: 'Column Chart',
        xAxis: 'Day',
        yAxis: 'Utilization',
        sortBy: 'Day order',
        note: 'Compares academic day load across the week.',
      },
      date_wise_occupancy: {
        chart: 'Line Chart',
        xAxis: 'Date',
        yAxis: 'Utilization',
        sortBy: 'Date (asc)',
        note: 'Shows occupancy changes across actual calendar dates.',
      },
      per_room_occupancy: {
        chart: 'Column Chart',
        xAxis: 'Room',
        yAxis: 'ScheduledEntries',
        sortBy: 'ScheduledEntries (desc)',
        note: 'Best for room-wise date, day, or hour occupancy snapshots.',
      },
      department_roomtype_demand: {
        chart: 'Stacked Bar',
        xAxis: 'Department',
        yAxis: 'TotalDemand + RoomType Columns',
        sortBy: 'TotalDemand (desc)',
        note: 'Compares room-type demand by department.',
      },
      clash_overlap: {
        chart: 'Column Chart',
        xAxis: 'Room',
        yAxis: 'Overlap Count',
        sortBy: 'Overlap Count (desc)',
        note: 'Highlights rooms with frequent clashes.',
      },
      vacancy_opportunity: {
        chart: 'Bar Chart',
        xAxis: 'Room',
        yAxis: 'IdleHoursPerWeek',
        sortBy: 'IdleHoursPerWeek (desc)',
        note: 'Prioritize high-idle rooms for optimization.',
      },
      capacity_mismatch: {
        chart: 'Scatter Plot',
        xAxis: 'Students',
        yAxis: 'Capacity',
        sortBy: 'OccupancyPercent (desc)',
        note: 'Detect over/under capacity allocations visually.',
      },
      exam_impact: {
        chart: 'Column Chart',
        xAxis: 'Department/Semester',
        yAxis: 'EstimatedBlockedSessions',
        sortBy: 'EstimatedBlockedSessions (desc)',
        note: 'Shows impact of exam windows on normal schedules.',
      },
      booking_lifecycle: {
        chart: 'Funnel / Column',
        xAxis: 'Lifecycle Stage',
        yAxis: 'Count',
        sortBy: 'Lifecycle flow',
        note: 'Represents request-to-approval lifecycle.',
      },
      no_show_risk: {
        chart: 'Scatter Plot',
        xAxis: 'OccupancyPercent',
        yAxis: 'RiskScore',
        sortBy: 'RiskScore (desc)',
        note: 'Prioritize no-show risk follow-up.',
      },
      shared_room_conflict: {
        chart: 'Bar Chart',
        xAxis: 'Room',
        yAxis: 'RiskScore',
        sortBy: 'RiskScore (desc)',
        note: 'Identifies high-risk shared-room conflicts.',
      },
      semester_peak_forecast: {
        chart: 'Line Chart',
        xAxis: 'Day',
        yAxis: 'PeakSlots',
        sortBy: 'Day order',
        note: 'Forecasts semester-wise peak load bands.',
      },
      raw_usage_data: {
        chart: 'Pivot Chart',
        xAxis: 'Building / Department / Room Type',
        yAxis: 'Utilization / ScheduledHours',
        sortBy: 'Utilization (desc)',
        note: 'Use pivot chart for multi-dimensional raw usage analysis.',
      },
    };
    return known[reportType] || defaults;
  };
  const buildChartRecommendationRows = (items: Array<{
    reportType: string;
    reportName: string;
    sheetName: string;
    rows: any[];
    columns: string[];
  }>) => items.map((item) => {
    const recommendation = getChartRecommendationMeta(item.reportType, item.columns);
    return {
      'Report Type': item.reportType,
      'Report Name': item.reportName,
      'Source Sheet': item.sheetName,
      'Recommended Chart': recommendation.chart,
      'X Axis': recommendation.xAxis,
      'Y Axis': recommendation.yAxis,
      'Sort By': recommendation.sortBy,
      'Top N Suggested': item.rows.length > 100 ? 20 : Math.min(10, Math.max(item.rows.length, 1)),
      'Data Rows': item.rows.length,
      Note: recommendation.note,
    };
  });
  const appendChartRecommendationsSheet = (
    workbook: XLSX.WorkBook,
    items: Array<{
      reportType: string;
      reportName: string;
      sheetName: string;
      rows: any[];
      columns: string[];
    }>,
  ) => {
    const rows = buildChartRecommendationRows(items);
    const worksheet = buildWorksheetFromRows(
      rows,
      ['Report Type', 'Report Name', 'Source Sheet', 'Recommended Chart', 'X Axis', 'Y Axis', 'Sort By', 'Top N Suggested', 'Data Rows', 'Note'],
    );
    XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeReportSheetName('Chart Recommendations'));
  };

  type ReportConfigMap = Record<string, { fileName: string; sheetName: string; rows: any[] }>;
  type ReportRecommendationItem = {
    reportType: string;
    reportName: string;
    sheetName: string;
    rows: any[];
    columns: string[];
  };
  type ChartPoint = {
    label: string;
    value: number;
    secondaryValue?: number;
  };
  type ExcelWorkbook = import('exceljs').Workbook;
  type ExcelWorksheet = import('exceljs').Worksheet;

  const createExcelWorkbook = async () => {
    const module = await import('exceljs');
    const ExcelJSRuntime = (module as any).default || module;
    return new ExcelJSRuntime.Workbook() as ExcelWorkbook;
  };

  const getReportColumns = (reportType: string, rows: any[]) => {
    if (reportType === 'department_roomtype_demand' && rows.length > 0) {
      return Array.from(new Set(rows.flatMap((row: any) => Object.keys(row || {})))) as string[];
    }
    return REPORT_EXPORT_COLUMNS[reportType] || (rows[0] ? Object.keys(rows[0]) : []);
  };
  const toExcelCellValue = (value: unknown) => {
    if (value == null) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return value as string | number | boolean;
  };
  const getUniqueExcelSheetName = (workbook: ExcelWorkbook, value: string) => {
    const baseName = sanitizeReportSheetName(value);
    let candidate = baseName;
    let index = 2;
    while (workbook.getWorksheet(candidate)) {
      const suffix = ` ${index}`;
      candidate = `${baseName.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
      index += 1;
    }
    return candidate;
  };
  const applyExcelHeaderStyle = (worksheet: ExcelWorksheet) => {
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
    headerRow.alignment = { vertical: 'middle', wrapText: true };
    headerRow.height = 22;
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const appendExcelDataSheet = (
    workbook: ExcelWorkbook,
    sheetName: string,
    rows: any[],
    columns?: string[],
  ) => {
    const safeRows = Array.isArray(rows) ? rows : [];
    const resolvedColumns = (columns && columns.length > 0)
      ? columns
      : (safeRows[0] ? Object.keys(safeRows[0]) : []);
    const worksheet = workbook.addWorksheet(getUniqueExcelSheetName(workbook, sheetName));
    if (resolvedColumns.length === 0) {
      worksheet.addRow(['No data available']);
      applyExcelHeaderStyle(worksheet);
      worksheet.getColumn(1).width = 24;
      return worksheet;
    }
    worksheet.addRow(resolvedColumns);
    safeRows.forEach((row: any) => {
      worksheet.addRow(resolvedColumns.map((column) => toExcelCellValue(row?.[column])));
    });
    applyExcelHeaderStyle(worksheet);
    resolvedColumns.forEach((column, columnIndex) => {
      const maxLength = Math.max(
        column.length,
        ...safeRows.slice(0, 250).map((row: any) => String(toExcelCellValue(row?.[column])).length),
      );
      worksheet.getColumn(columnIndex + 1).width = Math.min(Math.max(maxLength + 2, 12), 36);
    });
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.alignment = { vertical: 'top', wrapText: true };
    });
    return worksheet;
  };
  const appendExcelVisualizationDataSheet = (
    workbook: ExcelWorkbook,
    baseSheetName: string,
    rows: any[],
    columns?: string[],
  ) => {
    const visualRows = buildVisualizationRows(rows, columns);
    appendExcelDataSheet(
      workbook,
      `${baseSheetName} Visual`,
      visualRows,
      ['Visualization Type', 'Label', 'Value', 'Metric', 'Note'],
    );
  };
  const normalizeChartFieldName = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const findMatchingReportColumn = (columns: string[], preferred: string) => {
    const preferredParts = preferred.split(/[\/+]/).map((part) => part.trim()).filter(Boolean);
    const candidates = preferredParts.length > 0 ? preferredParts : [preferred];
    const normalizedColumns = columns.map((column) => ({ column, normalized: normalizeChartFieldName(column) }));
    for (const candidate of candidates) {
      const normalizedCandidate = normalizeChartFieldName(candidate);
      const directMatch = normalizedColumns.find((item) => item.normalized === normalizedCandidate);
      if (directMatch) return directMatch.column;
      const looseMatch = normalizedColumns.find((item) =>
        item.normalized.includes(normalizedCandidate) || normalizedCandidate.includes(item.normalized)
      );
      if (looseMatch) return looseMatch.column;
    }
    return '';
  };
  const getChartDataPoints = (
    reportType: string,
    rows: any[],
    columns: string[],
  ): { points: ChartPoint[]; xLabel: string; yLabel: string; chartType: string; note: string } => {
    const safeRows = Array.isArray(rows) ? rows : [];
    const recommendation = getChartRecommendationMeta(reportType, columns);
    if (safeRows.length === 0) {
      return { points: [], xLabel: recommendation.xAxis, yLabel: recommendation.yAxis, chartType: recommendation.chart, note: recommendation.note };
    }

    if (reportType === 'booking_lifecycle') {
      const lifecycleRow = safeRows[0] || {};
      const lifecyclePoints: ChartPoint[] = ['TotalRequests', 'Approvals', 'Cancellations', 'LeadTimeCapturedCount']
        .map((key) => ({ label: key.replace(/([A-Z])/g, ' $1').trim(), value: toNumericValue(lifecycleRow[key]) || 0 }))
        .filter((point) => point.value > 0);
      return { points: lifecyclePoints, xLabel: 'Lifecycle Stage', yLabel: 'Count', chartType: recommendation.chart, note: recommendation.note };
    }

    if (reportType === 'category_room_list') {
      const buildCountPoints = (field: string) => {
        const grouped = new Map<string, number>();
        safeRows.forEach((row: any) => {
          const label = (row?.[field] ?? '').toString().trim();
          if (!label) return;
          grouped.set(label, (grouped.get(label) || 0) + 1);
        });
        return Array.from(grouped.entries())
          .map(([label, value]) => ({ label, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 12);
      };
      const reportCategoryPoints = buildCountPoints('ReportCategory');
      if (reportCategoryPoints.length > 1) {
        return {
          points: reportCategoryPoints,
          xLabel: 'Report Category',
          yLabel: 'Room Count',
          chartType: recommendation.chart,
          note: 'Shows how filtered rooms are distributed across grouped room categories.',
        };
      }
      const buildingPoints = buildCountPoints('Building');
      if (buildingPoints.length > 1) {
        return {
          points: buildingPoints,
          xLabel: 'Building',
          yLabel: 'Room Count',
          chartType: recommendation.chart,
          note: 'Shows how rooms in this category are distributed across buildings.',
        };
      }
      const hierarchyPoints = buildCountPoints('HierarchyLevel');
      if (hierarchyPoints.length > 1) {
        return {
          points: hierarchyPoints,
          xLabel: 'Hierarchy Level',
          yLabel: 'Room Count',
          chartType: recommendation.chart,
          note: 'Shows the parent/child mix for the filtered category rooms.',
        };
      }
      const statusPoints = buildCountPoints('Status');
      if (statusPoints.length > 1) {
        return {
          points: statusPoints,
          xLabel: 'Status',
          yLabel: 'Room Count',
          chartType: recommendation.chart,
          note: 'Shows the room-status distribution for the filtered category rooms.',
        };
      }
      const typePoints = buildCountPoints('Type');
      if (typePoints.length > 1) {
        return {
          points: typePoints,
          xLabel: 'Effective Room Type',
          yLabel: 'Room Count',
          chartType: recommendation.chart,
          note: 'Shows the effective room types represented inside the filtered category rooms.',
        };
      }
      const singleCategoryLabel =
        (safeRows[0]?.CategoryValue ?? safeRows[0]?.ReportCategory ?? safeRows[0]?.Type ?? 'Rooms').toString().trim() || 'Rooms';
      return {
        points: [{ label: singleCategoryLabel, value: safeRows.length }],
        xLabel: 'Category',
        yLabel: 'Room Count',
        chartType: recommendation.chart,
        note: 'Shows the total rooms matched for the selected category filters.',
      };
    }

    const xColumn = findMatchingReportColumn(columns, recommendation.xAxis) || columns.find((column) =>
      safeRows.some((row: any) => row?.[column] != null && toNumericValue(row?.[column]) == null)
    ) || columns[0] || 'Category';
    const yColumn = findMatchingReportColumn(columns, recommendation.yAxis) || columns.find((column) =>
      safeRows.some((row: any) => toNumericValue(row?.[column]) != null)
    ) || '';

    if (!yColumn || reportType === 'clash_overlap') {
      const grouped = new Map<string, number>();
      safeRows.forEach((row: any) => {
        const label = (row?.[xColumn] ?? 'Unknown').toString().trim() || 'Unknown';
        grouped.set(label, (grouped.get(label) || 0) + 1);
      });
      const groupedPoints: ChartPoint[] = Array.from(grouped.entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 12);
      return { points: groupedPoints, xLabel: xColumn, yLabel: reportType === 'clash_overlap' ? 'Overlap Count' : 'Count', chartType: recommendation.chart, note: recommendation.note };
    }

    const chartPoints: ChartPoint[] = safeRows
      .map((row: any) => ({
        label: (row?.[xColumn] ?? 'Unknown').toString().trim() || 'Unknown',
        value: toNumericValue(row?.[yColumn]) || 0,
        secondaryValue: toNumericValue(row?.Capacity ?? row?.TotalCapacity ?? row?.Rooms),
      }))
      .filter((point) => Number.isFinite(point.value))
      .sort((a, b) => {
        if (recommendation.sortBy.toLowerCase().includes('asc')) return a.value - b.value;
        return b.value - a.value;
      })
      .slice(0, 12);
    return { points: chartPoints, xLabel: xColumn, yLabel: yColumn, chartType: recommendation.chart, note: recommendation.note };
  };
  const drawRoundedRect = (
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ) => {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  };
  const drawChartImage = (
    reportName: string,
    reportType: string,
    rows: any[],
    columns: string[],
  ) => {
    if (typeof document === 'undefined') return '';
    const width = 1120;
    const height = 620;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const palette = ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#14B8A6', '#F97316', '#64748B'];
    const chart = getChartDataPoints(reportType, rows, columns);
    context.fillStyle = '#F8FAFC';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#0F172A';
    context.font = 'bold 30px Calibri, Arial, sans-serif';
    context.fillText(reportName, 42, 58);
    context.fillStyle = '#64748B';
    context.font = '16px Calibri, Arial, sans-serif';
    context.fillText(`${chart.chartType} | ${chart.xLabel} vs ${chart.yLabel}`, 42, 88);
    context.fillText(chart.note, 42, 114);
    drawRoundedRect(context, 32, 136, width - 64, height - 176, 18);
    context.fillStyle = '#FFFFFF';
    context.fill();
    context.strokeStyle = '#E2E8F0';
    context.lineWidth = 2;
    context.stroke();

    if (chart.points.length === 0) {
      context.fillStyle = '#94A3B8';
      context.font = 'bold 28px Calibri, Arial, sans-serif';
      context.textAlign = 'center';
      context.fillText('No report data available for visualization', width / 2, height / 2);
      context.textAlign = 'left';
      return canvas.toDataURL('image/png');
    }

    const chartKind = chart.chartType.toLowerCase();
    const isPie = chartKind.includes('pie') || chartKind.includes('donut');
    const isLine = chartKind.includes('line') || chartKind.includes('forecast');
    const isScatter = chartKind.includes('scatter');
    const isHorizontal = chartKind.includes('horizontal') || chartKind.includes('clustered');

    if (isPie) {
      const total = chart.points.reduce((sum, point) => sum + Math.max(point.value, 0), 0) || 1;
      const centerX = 430;
      const centerY = 350;
      const radius = 150;
      let startAngle = -Math.PI / 2;
      chart.points.forEach((point, index) => {
        const slice = (Math.max(point.value, 0) / total) * Math.PI * 2;
        context.beginPath();
        context.moveTo(centerX, centerY);
        context.arc(centerX, centerY, radius, startAngle, startAngle + slice);
        context.closePath();
        context.fillStyle = palette[index % palette.length];
        context.fill();
        startAngle += slice;
      });
      if (chartKind.includes('donut')) {
        context.beginPath();
        context.arc(centerX, centerY, 78, 0, Math.PI * 2);
        context.fillStyle = '#FFFFFF';
        context.fill();
      }
      chart.points.slice(0, 8).forEach((point, index) => {
        const y = 230 + index * 36;
        context.fillStyle = palette[index % palette.length];
        context.fillRect(680, y - 12, 18, 18);
        context.fillStyle = '#0F172A';
        context.font = '16px Calibri, Arial, sans-serif';
        context.fillText(`${point.label} (${point.value})`, 710, y + 2);
      });
    } else {
      const plotX = 92;
      const plotY = 190;
      const plotWidth = 940;
      const plotHeight = 330;
      const values = chart.points.map((point) => Math.max(point.value, 0));
      const maxValue = Math.max(...values, 1);
      context.strokeStyle = '#E2E8F0';
      context.lineWidth = 1;
      context.fillStyle = '#64748B';
      context.font = '13px Calibri, Arial, sans-serif';
      for (let i = 0; i <= 4; i += 1) {
        const y = plotY + plotHeight - (plotHeight * i / 4);
        context.beginPath();
        context.moveTo(plotX, y);
        context.lineTo(plotX + plotWidth, y);
        context.stroke();
        context.fillText(String(Math.round(maxValue * i / 4)), 42, y + 4);
      }

      if (isLine) {
        const step = chart.points.length > 1 ? plotWidth / (chart.points.length - 1) : plotWidth;
        context.beginPath();
        chart.points.forEach((point, index) => {
          const x = plotX + index * step;
          const y = plotY + plotHeight - (Math.max(point.value, 0) / maxValue) * plotHeight;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.strokeStyle = '#10B981';
        context.lineWidth = 5;
        context.stroke();
        chart.points.forEach((point, index) => {
          const x = plotX + index * step;
          const y = plotY + plotHeight - (Math.max(point.value, 0) / maxValue) * plotHeight;
          context.beginPath();
          context.arc(x, y, 7, 0, Math.PI * 2);
          context.fillStyle = '#0EA5E9';
          context.fill();
        });
      } else if (isScatter) {
        const secondaryValues = chart.points.map((point) => Math.max(point.secondaryValue || point.value, 0));
        const maxSecondary = Math.max(...secondaryValues, 1);
        chart.points.forEach((point, index) => {
          const x = plotX + (Math.max(point.secondaryValue || point.value, 0) / maxSecondary) * plotWidth;
          const y = plotY + plotHeight - (Math.max(point.value, 0) / maxValue) * plotHeight;
          context.beginPath();
          context.arc(x, y, 10, 0, Math.PI * 2);
          context.fillStyle = palette[index % palette.length];
          context.fill();
        });
      } else if (isHorizontal) {
        const rowHeight = Math.min(32, plotHeight / Math.max(chart.points.length, 1));
        chart.points.forEach((point, index) => {
          const y = plotY + index * rowHeight + 4;
          const barWidth = (Math.max(point.value, 0) / maxValue) * (plotWidth - 220);
          context.fillStyle = '#334155';
          context.font = '13px Calibri, Arial, sans-serif';
          context.fillText(point.label.slice(0, 24), plotX, y + 16);
          drawRoundedRect(context, plotX + 220, y, barWidth, rowHeight - 8, 7);
          context.fillStyle = palette[index % palette.length];
          context.fill();
          context.fillStyle = '#0F172A';
          context.fillText(String(point.value), plotX + 230 + barWidth, y + 16);
        });
      } else {
        const barGap = 16;
        const barWidth = Math.max(22, (plotWidth - barGap * (chart.points.length - 1)) / Math.max(chart.points.length, 1));
        chart.points.forEach((point, index) => {
          const barHeight = (Math.max(point.value, 0) / maxValue) * plotHeight;
          const x = plotX + index * (barWidth + barGap);
          const y = plotY + plotHeight - barHeight;
          drawRoundedRect(context, x, y, Math.min(barWidth, 58), barHeight, 8);
          context.fillStyle = palette[index % palette.length];
          context.fill();
          context.save();
          context.translate(x + 8, plotY + plotHeight + 18);
          context.rotate(-Math.PI / 5);
          context.fillStyle = '#475569';
          context.font = '12px Calibri, Arial, sans-serif';
          context.fillText(point.label.slice(0, 18), 0, 0);
          context.restore();
        });
      }
    }

    return canvas.toDataURL('image/png');
  };
  const appendExcelImageSheet = (
    workbook: ExcelWorkbook,
    reportType: string,
    reportName: string,
    sheetName: string,
    rows: any[],
    columns: string[],
  ) => {
    const worksheet = workbook.addWorksheet(getUniqueExcelSheetName(workbook, `${sheetName} Image`));
    worksheet.getCell('A1').value = reportName;
    worksheet.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF0F172A' } };
    worksheet.getCell('A2').value = `Image-based visualization generated from ${rows.length} rows.`;
    worksheet.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };
    worksheet.getColumn(1).width = 24;
    worksheet.getRow(1).height = 26;
    const imageData = drawChartImage(reportName, reportType, rows, columns);
    if (imageData) {
      const imageId = workbook.addImage({ base64: imageData, extension: 'png' });
      worksheet.addImage(imageId, { tl: { col: 0, row: 3 }, ext: { width: 960, height: 532 } });
      for (let rowIndex = 4; rowIndex < 32; rowIndex += 1) worksheet.getRow(rowIndex).height = 18;
      for (let columnIndex = 1; columnIndex <= 14; columnIndex += 1) worksheet.getColumn(columnIndex).width = 12;
    } else {
      worksheet.getCell('A4').value = 'Image visualization is available only in the browser runtime.';
    }
  };
  const appendExcelChartRecommendationsSheet = (
    workbook: ExcelWorkbook,
    items: ReportRecommendationItem[],
  ) => {
    const rows = buildChartRecommendationRows(items);
    appendExcelDataSheet(
      workbook,
      'Chart Recommendations',
      rows,
      ['Report Type', 'Report Name', 'Source Sheet', 'Recommended Chart', 'X Axis', 'Y Axis', 'Sort By', 'Top N Suggested', 'Data Rows', 'Note'],
    );
  };
  const saveExcelWorkbook = async (workbook: ExcelWorkbook, fileName: string) => {
    workbook.creator = 'MBU SmartCampus AI';
    workbook.created = new Date();
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const sanitizeExportFilePart = (value?: string | null) =>
    (value || '')
      .toString()
      .trim()
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  const getReportLabelByType = (reportType: string, fallback: string) =>
    REPORT_TYPE_OPTIONS.find((option) => option.value === reportType)?.label || fallback;
  const buildActiveFilterSummaryRows = (
    reportName: string,
    options: { includeCategory?: boolean; includeSnapshot?: boolean } = {},
  ) => {
    const rows: Array<{ Section: string; Field: string; Value: string }> = [
      { Section: 'Report', Field: 'Report Name', Value: reportName },
      { Section: 'Report', Field: 'Generated On', Value: new Date().toLocaleString('en-GB') },
    ];
    const addFilter = (field: string, value?: string | null) => {
      const safeValue = value?.toString().trim();
      if (!safeValue) return;
      rows.push({ Section: 'Filters', Field: field, Value: safeValue });
    };
    addFilter('From Date', filters.dateFrom ? formatDisplayDate(filters.dateFrom) : '');
    addFilter('To Date', filters.dateTo ? formatDisplayDate(filters.dateTo) : '');
    addFilter('Campus', filters.campus);
    addFilter('Building', filters.building);
    addFilter('Block / Direct Floors', filters.block);
    addFilter('Floor', filters.floor);
    addFilter('Department', filters.department);
    addFilter('Year', filters.year);
    addFilter('Semester', filters.semester);
    addFilter('Section', filters.section);
    addFilter('Room', filters.room);
    addFilter('Room Type', filters.roomType);
    addFilter('Booking Status', filters.bookingStatus);
    addFilter('Flag', filters.flag);
    if (options.includeCategory) {
      addFilter('Category Type', categoryTypeOptions.find((option) => option.value === filters.roomCategoryType)?.label || filters.roomCategoryType);
      addFilter('Category Value', filters.roomCategoryValue);
    }
    if (options.includeSnapshot && filters.reportType === 'per_room_occupancy') {
      addFilter('Snapshot Mode', filters.snapshotMode);
      addFilter('Snapshot Day', filters.snapshotDay);
      addFilter('Snapshot Time', filters.snapshotTime);
    }
    return rows;
  };
  const buildExportFileName = (
    baseLabel: string,
    options: { includeCategory?: boolean; includeSnapshot?: boolean } = {},
  ) => {
    const parts: string[] = [];
    const pushPart = (value?: string | null) => {
      const sanitized = sanitizeExportFilePart(value);
      if (sanitized) parts.push(sanitized);
    };
    pushPart(filters.campus);
    pushPart(filters.building);
    pushPart(filters.block);
    pushPart(filters.floor);
    pushPart(filters.department);
    pushPart(filters.year);
    pushPart(filters.semester);
    pushPart(filters.section);
    pushPart(filters.room);
    pushPart(filters.roomType);
    if (options.includeCategory) {
      pushPart(categoryTypeOptions.find((option) => option.value === filters.roomCategoryType)?.label || filters.roomCategoryType);
      pushPart(filters.roomCategoryValue);
    }
    if (options.includeSnapshot && filters.reportType === 'per_room_occupancy') {
      pushPart(filters.snapshotMode);
      pushPart(filters.snapshotDay);
      pushPart(filters.snapshotTime);
    }
    if (filters.dateFrom) pushPart(`From-${formatDisplayDate(filters.dateFrom)}`);
    if (filters.dateTo) pushPart(`To-${formatDisplayDate(filters.dateTo)}`);
    pushPart(baseLabel);
    const joined = parts.filter(Boolean).join('_') || sanitizeExportFilePart(baseLabel) || 'report';
    return `${joined.slice(0, 180)}.xlsx`;
  };

  const buildCategoryRoomWorkbookSummaryRows = (reportName: string) => [
    ...buildActiveFilterSummaryRows(reportName, { includeCategory: true }),
    { Section: 'Summary', Field: 'Rooms Listed', Value: `${categoryWiseRoomListRows.length}` },
    { Section: 'Summary', Field: 'Grouped Categories', Value: `${categoryWiseReportGroupSummary.length}` },
    {
      Section: 'Summary',
      Field: filters.roomCategoryValue ? 'Selected Category' : 'Largest Group',
      Value: filters.roomCategoryValue || topReportCategoryGroup?.value || '-',
    },
    {
      Section: 'Summary',
      Field: filters.roomCategoryValue ? 'Matching Rooms' : 'Largest Group Count',
      Value: `${filters.roomCategoryValue ? categoryWiseRoomListRows.length : (topReportCategoryGroup?.roomCount ?? 0)}`,
    },
  ];

  const appendCategoryRoomWorkbookSections = (
    workbook: ExcelWorkbook,
    reportName: string,
    options: {
      summarySheetName?: string;
      completeSheetName?: string;
    } = {},
  ) => {
    const completeSheetName = options.completeSheetName || 'Complete Room List';
    const summarySheetName = options.summarySheetName;
    const exportColumns = getReportColumns('category_room_list', categoryWiseRoomListRows);
    const groupedSheetColumns = exportColumns.filter((column) => column !== 'ReportCategory');
    const recommendationItems: ReportRecommendationItem[] = [];

    if (summarySheetName) {
      appendExcelDataSheet(
        workbook,
        summarySheetName,
        buildCategoryRoomWorkbookSummaryRows(reportName),
        ['Section', 'Field', 'Value'],
      );
    }

    appendExcelDataSheet(workbook, completeSheetName, categoryWiseRoomListRows, exportColumns);
    appendExcelImageSheet(workbook, 'category_room_list', reportName, completeSheetName, categoryWiseRoomListRows, exportColumns);
    recommendationItems.push({
      reportType: 'category_room_list',
      reportName,
      sheetName: completeSheetName,
      rows: categoryWiseRoomListRows,
      columns: exportColumns || [],
    });

    CATEGORY_ROOM_REPORT_GROUP_ORDER.forEach((groupName) => {
      const rows = categoryWiseReportGroups[groupName] || [];
      appendExcelDataSheet(workbook, groupName, rows, groupedSheetColumns);
      appendExcelImageSheet(workbook, 'category_room_list', `${reportName} - ${groupName}`, groupName, rows, groupedSheetColumns);
      recommendationItems.push({
        reportType: 'category_room_list',
        reportName: `${reportName} - ${groupName}`,
        sheetName: groupName,
        rows,
        columns: groupedSheetColumns || [],
      });
    });

    return recommendationItems;
  };

  const buildWorkbookFromReportConfigs = async (reportConfigs: ReportConfigMap, reportOrder: string[], fileName: string) => {
    const workbook = await createExcelWorkbook();
    const recommendationItems: Array<{
      reportType: string;
      reportName: string;
      sheetName: string;
      rows: any[];
      columns: string[];
    }> = [];
    reportOrder.forEach((reportType) => {
      const config = reportConfigs[reportType];
      if (!config) return;
      const exportColumns = getReportColumns(reportType, config.rows);
      const reportName = REPORT_TYPE_OPTIONS.find((option) => option.value === reportType)?.label || config.sheetName;
      if (reportType === 'category_room_list') {
        recommendationItems.push(
          ...appendCategoryRoomWorkbookSections(workbook, reportName, {
            summarySheetName: 'Category Room Report Summary',
            completeSheetName: config.sheetName,
          }),
        );
        return;
      }
      appendExcelDataSheet(workbook, config.sheetName, config.rows, exportColumns);
      appendExcelImageSheet(workbook, reportType, reportName, config.sheetName, config.rows, exportColumns);
      recommendationItems.push({
        reportType,
        reportName,
        sheetName: config.sheetName,
        rows: config.rows,
        columns: exportColumns || [],
      });
    });
    appendExcelChartRecommendationsSheet(workbook, recommendationItems);
    await saveExcelWorkbook(workbook, fileName);
  };
  const exportUtilizationReport = async () => {
    const reportConfigs = buildUtilizationReportConfigs();
    await buildWorkbookFromReportConfigs(
      reportConfigs,
      Object.keys(reportConfigs),
      buildExportFileName('Utilization Report'),
    );
  };
  const exportSchoolSummaryReport = async () => {
    const reportConfigs = buildUtilizationReportConfigs();
    const config = reportConfigs.school_utilization;
    await exportRowsToWorkbook(
      config.rows,
      buildExportFileName('School Utilization Summary'),
      config.sheetName,
      REPORT_EXPORT_COLUMNS.school_utilization,
      'school_utilization',
      'School Utilization Summary',
    );
  };
  const exportRawUsageData = async () => {
    const rows = sortedFilteredRoomReports.map((room: any) => ({
      Room: room.room_number,
      RoomName: getRoomNameDisplay(room),
      Campus: room.campus || '',
      Building: room.building,
      Block: room.block || '',
      Floor: getFloorName(room.floor_number),
      Department: room.department,
      School: room.school,
      Years: (room.yearTags || []).map((year: string) => `Year ${year}`).join(', '),
      Semesters: (room.semesterTags || []).join(', '),
      Sections: (room.sectionTags || []).join(', '),
      Type: getRoomTypeDisplay(room),
      SubRoomType: HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout)) ? getRoomTypeDisplay(room) : '',
      Layout: room.room_layout || 'Normal',
      RoomAliases: getRoomAliasList(room).join(', '),
      ParentRoom: room.parent_room_number || '',
      SubRoomCount: room.sub_room_count ?? '',
      SubRoomName: room.room_section_name || '',
      UsageCategory: room.usage_category || normalizeUsageCategoryValue('', room.room_type) || '',
      IsBookable: isRoomReservable(room) ? 'Yes' : 'No',
      LabName: room.lab_name || '',
      SubLabName: (
        normalizeRoomTypeValue(room.room_type) === 'Lab' &&
        HIERARCHY_CHILD_ROOM_LAYOUTS.includes(normalizeRoomLayoutValue(room.room_layout))
      ) ? (room.lab_name || '') : '',
      RestroomFor: room.restroom_type || '',
      Capacity: room.capacity,
      Status: room.status,
      Utilization: room.utilization,
      ScheduledHours: room.scheduledHours,
      BookedHours: room.bookedHours,
      MaintenanceIssues: room.maintenanceIssues,
      BookingStatuses: (room.bookingStatuses || []).join(', '),
      BookingDates: (room.bookingDates || []).join(', '),
      Flags: (room.flags || []).join(', '),
    }));
    const rawUsageColumns = [
      'Room', 'RoomName', 'Campus', 'Building', 'Block', 'Floor', 'Department', 'School', 'Years', 'Semesters', 'Sections',
      'Type', 'SubRoomType', 'Layout', 'RoomAliases', 'ParentRoom', 'SubRoomCount', 'SubRoomName', 'UsageCategory',
      'IsBookable', 'LabName', 'SubLabName', 'RestroomFor', 'Capacity', 'Status', 'Utilization', 'ScheduledHours',
      'BookedHours', 'MaintenanceIssues', 'BookingStatuses', 'BookingDates', 'Flags'
    ];
    await exportRowsToWorkbook(rows, buildExportFileName('Raw Usage Data'), 'Raw Usage Data', rawUsageColumns, 'raw_usage_data', 'Raw Usage Data');
  };
  const exportRowsToWorkbook = async (rows: any[], fileName: string, sheetName: string, columns?: string[], reportType = 'custom_report', reportName = sheetName) => {
    const workbook = await createExcelWorkbook();
    const resolvedColumns = columns || (rows[0] ? Object.keys(rows[0]) : []);
    appendExcelDataSheet(workbook, sheetName, rows, resolvedColumns);
    appendExcelImageSheet(workbook, reportType, reportName, sheetName, rows, resolvedColumns);
    appendExcelChartRecommendationsSheet(workbook, [{
      reportType,
      reportName,
      sheetName,
      rows,
      columns: resolvedColumns,
    }]);
    await saveExcelWorkbook(workbook, fileName);
  };
  const buildUtilizationReportConfigs = () => {
    const roomDetailRows = sortedFilteredRoomReports.map((room: any) => ({
      Room: room.room_number,
      RoomName: getRoomNameDisplay(room),
      Campus: room.campus || '',
      Building: room.building,
      Block: room.block || '',
      Floor: getFloorName(room.floor_number),
      Department: room.department,
      School: room.school,
      Type: getRoomTypeDisplay(room),
      Layout: room.room_layout || 'Normal',
      Utilization: `${room.utilization}%`,
      ScheduledHours: room.scheduledHours,
      BookedHours: room.bookedHours,
      Capacity: room.capacity,
      Status: room.status,
      Flags: (room.flags || []).join(', '),
    }));

    return {
      room_utilization: {
        fileName: 'room-utilization-report.xlsx',
        sheetName: 'Room Utilization',
        rows: roomDetailRows,
      },
      available_room_summary: {
        fileName: 'available-room-summary-report.xlsx',
        sheetName: 'Available Room Summary',
        rows: availableRoomSummaryRows,
      },
      category_room_list: {
        fileName: 'category-wise-room-list-report.xlsx',
        sheetName: 'Category-wise Room List',
        rows: categoryWiseRoomListRows,
      },
      room_level_detail: {
        fileName: 'room-level-detail-report.xlsx',
        sheetName: 'Room-level Detail',
        rows: detailedRoomReportRows,
      },
      campus_utilization: {
        fileName: 'campus-utilization-report.xlsx',
        sheetName: 'Campus Utilization',
        rows: campusSummary.map((campus: any) => ({
          Campus: campus.name,
          Buildings: campus.buildingCount,
          Rooms: campus.roomCount,
          AvgUtilization: `${campus.avgUtilization}%`,
        })),
      },
      school_utilization: {
        fileName: 'school-utilization-summary.xlsx',
        sheetName: 'School Summary',
        rows: schoolSummary.map((school: any) => ({
          School: school.name,
          Departments: school.deptCount,
          Rooms: school.roomCount,
          TotalCapacity: school.totalCapacity,
          AvgUtilization: `${school.avgUtilization}%`,
          UnmappedRooms: school.unmappedRooms,
        })),
      },
      building_utilization: {
        fileName: 'building-utilization-report.xlsx',
        sheetName: 'Building Utilization',
        rows: buildingSummary.map((building: any) => ({
          Building: building.name,
          Rooms: building.roomCount,
          MaintenanceIssues: building.maintenanceIssues,
          AvgUtilization: `${building.avgUtilization}%`,
        })),
      },
      department_allocation: {
        fileName: 'department-allocation-report.xlsx',
        sheetName: 'Department Allocation',
        rows: departmentSummary.map((department: any) => ({
          Department: department.name,
          School: department.school,
          Rooms: department.roomCount,
          TotalCapacity: department.totalCapacity,
          AvgUtilization: `${department.avgUtilization}%`,
        })),
      },
      room_type_utilization: {
        fileName: 'room-type-utilization-report.xlsx',
        sheetName: 'Room Type Utilization',
        rows: roomTypeSummary.map((item: any) => ({
          RoomType: item.name,
          Rooms: item.roomCount,
          AvgUtilization: `${item.avgUtilization}%`,
        })),
      },
      usage_category_utilization: {
        fileName: 'usage-category-utilization-report.xlsx',
        sheetName: 'Usage Category Utilization',
        rows: usageCategorySummary.map((item: any) => ({
          UsageCategory: item.name,
          Rooms: item.roomCount,
          AvgUtilization: `${item.avgUtilization}%`,
        })),
      },
      year_utilization: {
        fileName: 'year-utilization-report.xlsx',
        sheetName: 'Year Utilization',
        rows: yearSummary.map((item: any) => ({
          Year: item.name,
          Rooms: item.roomCount,
          AvgUtilization: `${item.avgUtilization}%`,
        })),
      },
      semester_utilization: {
        fileName: 'semester-utilization-report.xlsx',
        sheetName: 'Semester Utilization',
        rows: semesterSummary.map((item: any) => ({
          Semester: item.name,
          Rooms: item.roomCount,
          AvgUtilization: `${item.avgUtilization}%`,
        })),
      },
      section_utilization: {
        fileName: 'section-utilization-report.xlsx',
        sheetName: 'Section Utilization',
        rows: sectionSummary.map((item: any) => ({
          Section: item.name,
          Rooms: item.roomCount,
          AvgUtilization: `${item.avgUtilization}%`,
        })),
      },
      booking_approvals: {
        fileName: 'booking-approvals-report.xlsx',
        sheetName: 'Booking Approvals',
        rows: bookingStatusSummary.map((status: any) => ({
          Status: status.name,
          Count: status.count,
        })),
      },
      maintenance_impact: {
        fileName: 'maintenance-impact-report.xlsx',
        sheetName: 'Maintenance Impact',
        rows: roomDetailRows,
      },
      underused: {
        fileName: 'underused-rooms-report.xlsx',
        sheetName: 'Underused Rooms',
        rows: roomDetailRows,
      },
      overused: {
        fileName: 'overused-rooms-report.xlsx',
        sheetName: 'Overused Rooms',
        rows: roomDetailRows,
      },
      time_band_utilization: {
        fileName: 'time-band-utilization-report.xlsx',
        sheetName: 'Time Band Utilization',
        rows: roomTimeBandUtilization.map((item: any) => ({
          TimeBand: item.band,
          ScheduledHours: item.scheduledHours,
          BookedHours: item.bookedHours,
          Utilization: `${item.utilization}%`,
        })),
      },
      hourly_utilization: {
        fileName: 'hourly-utilization-report.xlsx',
        sheetName: 'Hourly Utilization',
        rows: hourlyUtilizationReport.map((item: any) => ({
          HourBand: item.hourBand,
          ScheduledHours: item.scheduledHours,
          BookedHours: item.bookedHours,
          Utilization: `${item.utilization}%`,
          ScheduledEntries: item.scheduledEntries,
          ApprovedBookings: item.approvedBookings,
          OccupiedRooms: item.occupiedRooms,
          RoomNumbers: item.roomNumbers,
        })),
      },
      day_wise_utilization: {
        fileName: 'day-wise-utilization-report.xlsx',
        sheetName: 'Day-wise Utilization',
        rows: dayWiseUtilizationReport.map((item: any) => ({
          Day: item.day,
          ScheduledHours: item.scheduledHours,
          BookedHours: item.bookedHours,
          Utilization: `${item.utilization}%`,
          ScheduledEntries: item.scheduledEntries,
          ApprovedBookings: item.approvedBookings,
          OccupiedRooms: item.occupiedRooms,
          RoomNumbers: item.roomNumbers,
        })),
      },
      date_wise_occupancy: {
        fileName: 'date-wise-occupancy-report.xlsx',
        sheetName: 'Date-wise Occupancy',
        rows: dateWiseOccupancyReport.map((item: any) => ({
          Date: item.date,
          Day: item.day,
          ScheduledHours: item.scheduledHours,
          BookedHours: item.bookedHours,
          Utilization: `${item.utilization}%`,
          ScheduledEntries: item.scheduledEntries,
          ApprovedBookings: item.approvedBookings,
          OccupiedRooms: item.occupiedRooms,
          RoomNumbers: item.roomNumbers,
        })),
      },
      per_room_occupancy: {
        fileName: 'per-room-occupancy-report.xlsx',
        sheetName: 'Per-room Occupancy',
        rows: perRoomOccupancySnapshotRows,
      },
      department_roomtype_demand: {
        fileName: 'department-roomtype-demand-report.xlsx',
        sheetName: 'Department RoomType Demand',
        rows: departmentRoomTypeDemand.map((item: any) => ({
          Department: item.department,
          TotalDemand: item.totalDemand,
          ...item.roomTypeCounts,
        })),
      },
      clash_overlap: {
        fileName: 'clash-overlap-report.xlsx',
        sheetName: 'Clash Overlap',
        rows: overlapConflictReport.map((item: any) => ({
          Source: item.source,
          Room: item.room,
          DayOrDate: item.day,
          YearA: item.yearA || '-',
          SemesterA: item.semesterA || '-',
          EntryA: `${item.startA} - ${item.endA} | ${item.courseA}`,
          YearB: item.yearB || '-',
          SemesterB: item.semesterB || '-',
          EntryB: `${item.startB} - ${item.endB} | ${item.courseB}`,
        })),
      },
      vacancy_opportunity: {
        fileName: 'vacancy-opportunity-report.xlsx',
        sheetName: 'Vacancy Opportunity',
        rows: vacancyOpportunityReport.map((item: any) => ({
          Room: item.room,
          Building: item.building,
          Department: item.department,
          IdleHoursPerWeek: item.idleHours,
          Utilization: `${item.utilization}%`,
          Opportunity: item.opportunity,
        })),
      },
      capacity_mismatch: {
        fileName: 'capacity-mismatch-report.xlsx',
        sheetName: 'Capacity Mismatch',
        rows: capacityMismatchReport.map((item: any) => ({
          Date: item.date,
          Room: item.room,
          Department: item.department,
          Event: item.event,
          Students: item.studentCount,
          Capacity: item.roomCapacity,
          OccupancyPercent: `${item.occupancyPercent}%`,
          MismatchType: item.mismatchType,
        })),
      },
      exam_impact: {
        fileName: 'exam-impact-report.xlsx',
        sheetName: 'Exam Impact',
        rows: examImpactReport.map((item: any) => ({
          ExamWindow: item.title,
          Department: item.department,
          Semester: item.semester,
          StartDate: item.startDate,
          EndDate: item.endDate,
          Days: item.days,
          AffectedWeeklyClasses: item.affectedWeeklyClasses,
          EstimatedBlockedSessions: item.estimatedBlockedSessions,
        })),
      },
      booking_lifecycle: {
        fileName: 'booking-lifecycle-report.xlsx',
        sheetName: 'Booking Lifecycle',
        rows: [{
          TotalRequests: bookingLifecycleReport.totalRequests,
          Approvals: bookingLifecycleReport.approvals,
          Cancellations: bookingLifecycleReport.cancellations,
          CancellationRate: `${bookingLifecycleReport.cancellationRate}%`,
          AverageLeadDays: bookingLifecycleReport.averageLeadDays ?? 'N/A',
          LeadTimeCapturedCount: bookingLifecycleReport.leadTimeCapturedCount,
        }],
      },
      no_show_risk: {
        fileName: 'no-show-risk-report.xlsx',
        sheetName: 'No Show Risk',
        rows: noShowRiskReport.map((item: any) => ({
          Booking: item.bookingId,
          Date: item.date,
          Room: item.room,
          Department: item.department,
          Event: item.event,
          Students: item.studentCount,
          Capacity: item.roomCapacity,
          OccupancyPercent: `${item.occupancyPercent}%`,
          RiskScore: item.riskScore,
        })),
      },
      shared_room_conflict: {
        fileName: 'shared-room-conflict-risk-report.xlsx',
        sheetName: 'Shared Room Conflict',
        rows: sharedRoomConflictRiskReport.map((item: any) => ({
          Room: item.room,
          Building: item.building,
          RoomLayout: item.roomLayout,
          Aliases: item.aliases,
          Departments: item.departments,
          Sections: item.sections,
          Overlaps: item.overlaps,
          RiskScore: item.riskScore,
        })),
      },
      semester_peak_forecast: {
        fileName: 'semester-peak-forecast-report.xlsx',
        sheetName: 'Semester Peak Forecast',
        rows: semesterPeakLoadForecast.map((item: any) => ({
          Semester: item.semester,
          Day: item.day,
          PeakBand: item.peakBand,
          PeakSlots: item.peakSlots,
          TotalClasses: item.totalClasses,
        })),
      },
    };
  };
  const exportCategoryWiseRoomWorkbook = async () => {
    const workbook = await createExcelWorkbook();
    const reportType = 'category_room_list';
    const reportName = getReportLabelByType(reportType, 'Category-wise Room List');
    const recommendationItems = appendCategoryRoomWorkbookSections(workbook, reportName, {
      summarySheetName: 'Report Summary',
      completeSheetName: 'Complete Room List',
    });

    appendExcelChartRecommendationsSheet(workbook, recommendationItems);
    await saveExcelWorkbook(workbook, buildExportFileName(reportName, { includeCategory: true }));
  };

  const exportReportByType = async (reportType: string) => {
    const reportConfigs = buildUtilizationReportConfigs();
    const config = reportConfigs[reportType as keyof typeof reportConfigs];
    if (!config) {
      alert('Selected report type is not available for individual export.');
      return;
    }
    if (reportType === 'category_room_list') {
      await exportCategoryWiseRoomWorkbook();
      return;
    }
    if (reportType === 'per_room_occupancy' && perRoomOccupancyMatrix) {
      const workbook = await createExcelWorkbook();
      const reportName = getReportLabelByType(reportType, config.sheetName);
      const exportColumns = getReportColumns(reportType, config.rows);
      appendExcelDataSheet(workbook, 'Summary', buildActiveFilterSummaryRows(reportName, { includeSnapshot: true }), ['Section', 'Field', 'Value']);
      appendExcelDataSheet(workbook, config.sheetName, config.rows, exportColumns);
      appendExcelDataSheet(workbook, `${config.sheetName} Matrix`, perRoomOccupancyMatrix.rows, perRoomOccupancyMatrixColumns);
      appendExcelImageSheet(workbook, reportType, reportName, config.sheetName, config.rows, exportColumns);
      appendExcelChartRecommendationsSheet(workbook, [{
        reportType,
        reportName,
        sheetName: config.sheetName,
        rows: config.rows,
        columns: exportColumns,
      }]);
      await saveExcelWorkbook(workbook, buildExportFileName(reportName, { includeSnapshot: true }));
      return;
    }
    const exportColumns = getReportColumns(reportType, config.rows);
    const reportName = getReportLabelByType(reportType, config.sheetName);
    await exportRowsToWorkbook(
      config.rows,
      buildExportFileName(reportName, { includeSnapshot: reportType === 'per_room_occupancy' }),
      config.sheetName,
      exportColumns,
      reportType,
      reportName,
    );
  };
  const exportComprehensiveWorkbook = async () => {
    const reportConfigs = buildUtilizationReportConfigs();
    const reportLabels = new Map(REPORT_TYPE_OPTIONS.map((option) => [option.value, option.label]));
    const reportTypesFromFilters = REPORT_TYPE_OPTIONS
      .map((option) => option.value)
      .filter((key) => !!reportConfigs[key as keyof typeof reportConfigs]);
    const additionalReportTypes = Object.keys(reportConfigs).filter((key) => !reportTypesFromFilters.includes(key));
    const orderedReportTypes = [...reportTypesFromFilters, ...additionalReportTypes];
    const reportSummaryRows: Array<{
      'S. No': number | string;
      'Report Type': string;
      'Report Name': string;
      'Sheet Name': string;
      'Total Rows': number;
    }> = orderedReportTypes.map((reportType, index) => {
      const report = reportConfigs[reportType as keyof typeof reportConfigs];
      return {
        'S. No': index + 1,
        'Report Type': reportType,
        'Report Name': reportLabels.get(reportType) || reportType,
        'Sheet Name': report.sheetName,
        'Total Rows': report.rows.length,
      };
    });
    const totalRowsAcrossReports = reportSummaryRows.reduce((total, row) => total + Number(row['Total Rows'] || 0), 0);
    reportSummaryRows.push({
      'S. No': 'TOTAL',
      'Report Type': 'all_reports',
      'Report Name': 'All Reports Combined',
      'Sheet Name': `${orderedReportTypes.length} sheets`,
      'Total Rows': totalRowsAcrossReports,
    });

    const completeDataDynamicColumns = Array.from(new Set(
      orderedReportTypes.flatMap((reportType) => {
        const report = reportConfigs[reportType as keyof typeof reportConfigs];
        return report.rows.flatMap((row: any) => Object.keys(row || {}));
      })
    ));
    const completeDataHeaders = ['Report Type', 'Report Name', 'Sheet Name', 'Row No', ...completeDataDynamicColumns];
    const completeDataRows = orderedReportTypes.flatMap((reportType) => {
      const report = reportConfigs[reportType as keyof typeof reportConfigs];
      const reportName = reportLabels.get(reportType) || report.sheetName;
      return report.rows.map((row: any, rowIndex: number) => {
        const baseRow: Record<string, any> = {
          'Report Type': reportType,
          'Report Name': reportName,
          'Sheet Name': report.sheetName,
          'Row No': rowIndex + 1,
        };
        completeDataDynamicColumns.forEach((column) => {
          baseRow[column] = row?.[column] ?? '';
        });
        return baseRow;
      });
    });

    const workbook = await createExcelWorkbook();
    appendExcelDataSheet(workbook, 'Overall Summary', reportSummaryRows, ['S. No', 'Report Type', 'Report Name', 'Sheet Name', 'Total Rows']);
    appendExcelDataSheet(workbook, 'Applied Filters', buildActiveFilterSummaryRows('Comprehensive Utilization Workbook', { includeCategory: true, includeSnapshot: true }), ['Section', 'Field', 'Value']);
    appendExcelDataSheet(workbook, 'Complete Data', completeDataRows, completeDataHeaders);
    const recommendationItems: ReportRecommendationItem[] = [];
    orderedReportTypes.forEach((reportType) => {
      const report = reportConfigs[reportType as keyof typeof reportConfigs];
      const exportColumns = getReportColumns(reportType, report.rows);
      const reportName = reportLabels.get(reportType) || report.sheetName;
      if (reportType === 'category_room_list') {
        recommendationItems.push(
          ...appendCategoryRoomWorkbookSections(workbook, reportName, {
            summarySheetName: 'Category Room Report Summary',
            completeSheetName: report.sheetName,
          }),
        );
      } else {
        appendExcelDataSheet(workbook, report.sheetName, report.rows, exportColumns);
        appendExcelImageSheet(workbook, reportType, reportName, report.sheetName, report.rows, exportColumns);
        recommendationItems.push({
          reportType,
          reportName,
          sheetName: report.sheetName,
          rows: report.rows,
          columns: exportColumns || [],
        });
      }
      if (reportType === 'per_room_occupancy' && perRoomOccupancyMatrix) {
        appendExcelDataSheet(workbook, `${report.sheetName} Matrix`, perRoomOccupancyMatrix.rows, perRoomOccupancyMatrixColumns);
      }
    });
    appendExcelChartRecommendationsSheet(workbook, recommendationItems);
    await saveExcelWorkbook(workbook, buildExportFileName('Comprehensive Utilization Workbook', { includeCategory: true, includeSnapshot: true }));
  };
  const exportCurrentReport = () => { void exportReportByType(filters.reportType); };
  const selectedSchoolRooms = selectedSchool
    ? filteredRoomReports.filter((room: any) => room.school === selectedSchool.name)
    : [];
  const selectedSchoolDepartments = selectedSchool
    ? Array.from(new Set(selectedSchoolRooms.map((room: any) => room.department).filter(Boolean))).map((department) => {
        const departmentRooms = selectedSchoolRooms.filter((room: any) => room.department === department);
        return {
          name: department,
          roomCount: departmentRooms.length,
          avgUtilization: Math.round(departmentRooms.reduce((acc: number, room: any) => acc + room.utilization, 0) / (departmentRooms.length || 1)),
          totalCapacity: departmentRooms.reduce((acc: number, room: any) => acc + Number(room.capacity || 0), 0),
        };
      }).sort((a: any, b: any) => b.avgUtilization - a.avgUtilization)
    : [];
  const selectedSchoolTopRooms = [...selectedSchoolRooms].sort((a: any, b: any) => b.utilization - a.utilization).slice(0, 5);

  return (
    <div className="space-y-8">
      <div className="flex gap-1 p-1 bg-slate-100 rounded-2xl w-fit">
        {(['utilization', 'methodology', 'kpis'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-8 py-2.5 rounded-xl text-xs font-bold transition-all capitalize",
              activeTab === tab ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Report Filters</h3>
            <p className="text-xs text-slate-500">Generate focused utilization reports by type, date, location, department, room type, booking status, or issue flag.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCurrentReport}
              className="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-100 rounded-xl text-xs font-bold flex items-center gap-2"
            >
              <FileSpreadsheet size={16} />
              Export Current Report
            </button>
            <button
              onClick={exportComprehensiveWorkbook}
              className="px-4 py-2 bg-violet-50 text-violet-700 border border-violet-100 rounded-xl text-xs font-bold flex items-center gap-2"
            >
              <FileSpreadsheet size={16} />
              Export Comprehensive Workbook
            </button>
            <button
              onClick={exportUtilizationReport}
              className="px-4 py-2 bg-emerald-50 text-emerald-700 border border-emerald-100 rounded-xl text-xs font-bold flex items-center gap-2"
            >
              <FileSpreadsheet size={16} />
              Export Full Workbook
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3">
          <select value={filters.reportType} onChange={e => setFilters({ ...filters, reportType: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            {REPORT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <input type="date" value={filters.dateFrom} onChange={e => setFilters({ ...filters, dateFrom: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500" />
          <input type="date" value={filters.dateTo} onChange={e => setFilters({ ...filters, dateTo: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500" />
          <select value={filters.campus} onChange={e => setFilters({ ...filters, campus: e.target.value, building: '', block: '', floor: '' })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Campuses</option>
            {campusOptions.map((campus: any) => <option key={campus} value={campus}>{campus}</option>)}
          </select>
          <select value={filters.building} onChange={e => setFilters({ ...filters, building: e.target.value, block: '', floor: '' })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Buildings</option>
            {buildingOptions.map((building: any) => <option key={building} value={building}>{building}</option>)}
          </select>
          <select value={filters.block} onChange={e => setFilters({ ...filters, block: e.target.value, floor: '' })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Blocks</option>
            {blockOptions.map((block: any) => <option key={block} value={block}>{block}</option>)}
          </select>
          <select value={filters.floor} onChange={e => setFilters({ ...filters, floor: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Floors</option>
            {floorOptions.map((floor: any) => <option key={floor} value={floor}>{getFloorName(floor)}</option>)}
          </select>
          <select value={filters.department} onChange={e => setFilters({ ...filters, department: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Departments</option>
            {departmentOptions.map((department: any) => <option key={department} value={department}>{department}</option>)}
          </select>
          <select value={filters.year} onChange={e => setFilters({ ...filters, year: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Years</option>
            {yearOptions.map((year: any) => <option key={year} value={year}>{`Year ${year}`}</option>)}
          </select>
          <select value={filters.semester} onChange={e => setFilters({ ...filters, semester: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Semesters</option>
            {semesterOptions.map((semester: any) => <option key={semester} value={semester}>{semester}</option>)}
          </select>
          <select value={filters.section} onChange={e => setFilters({ ...filters, section: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Sections</option>
            {sectionOptions.map((section: any) => <option key={section} value={section}>{section}</option>)}
          </select>
          <select value={filters.room} onChange={e => setFilters({ ...filters, room: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Rooms</option>
            {roomOptions.map((room: any) => <option key={room} value={room}>{room}</option>)}
          </select>
          <select value={filters.roomType} onChange={e => setFilters({ ...filters, roomType: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Room Types</option>
            {roomTypeOptions.map((type: any) => <option key={type} value={type}>{type}</option>)}
          </select>
          <select value={filters.bookingStatus} onChange={e => setFilters({ ...filters, bookingStatus: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Booking Statuses</option>
            {bookingStatusOptions.map(status => <option key={status} value={status}>{status}</option>)}
          </select>
          <select value={filters.flag} onChange={e => setFilters({ ...filters, flag: e.target.value })} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500">
            <option value="">All Flags</option>
            {flagOptions.map((flag: any) => <option key={flag} value={flag}>{flag}</option>)}
          </select>
          {filters.reportType === 'category_room_list' && (
            <>
              <select
                value={filters.roomCategoryType}
                onChange={e => setFilters({ ...filters, roomCategoryType: e.target.value, roomCategoryValue: '' })}
                className="px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl text-sm focus:outline-none focus:border-indigo-500"
              >
                {categoryTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select
                value={filters.roomCategoryValue}
                onChange={e => setFilters({ ...filters, roomCategoryValue: e.target.value })}
                className="px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl text-sm focus:outline-none focus:border-indigo-500"
              >
                <option value="">All Category Values</option>
                {categoryValueOptions.map((value: any) => <option key={value} value={value}>{value}</option>)}
              </select>
            </>
          )}
          {filters.reportType === 'per_room_occupancy' && (
            <>
              <select value={filters.snapshotMode} onChange={e => setFilters({ ...filters, snapshotMode: e.target.value, snapshotTime: e.target.value === 'hour' ? filters.snapshotTime : '', snapshotDay: e.target.value === 'date' ? '' : filters.snapshotDay })} className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-sm focus:outline-none focus:border-amber-500">
                {occupancySnapshotModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              {(filters.snapshotMode === 'day' || filters.snapshotMode === 'hour') && (
              <select value={filters.snapshotDay} onChange={e => setFilters({ ...filters, snapshotDay: e.target.value })} className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-sm focus:outline-none focus:border-amber-500">
                <option value="">{filters.snapshotMode === 'hour' ? 'Today' : 'Current Day'}</option>
                {reportDayOrder.map((day: string) => <option key={day} value={day}>{day}</option>)}
              </select>
              )}
              {filters.snapshotMode === 'hour' && (
              <select value={filters.snapshotTime} onChange={e => setFilters({ ...filters, snapshotTime: e.target.value })} className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-sm focus:outline-none focus:border-amber-500">
                {occupancySnapshotTimeOptions.map((option) => <option key={option.label} value={option.value}>{option.label}</option>)}
              </select>
              )}
            </>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {categorySummaryCards.map((card) => (
            <div key={card.label} className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{card.label}</p>
              <p className="text-xl font-bold text-slate-800">{card.value}</p>
              {card.detail && (
                <p className="text-[11px] text-slate-400 font-semibold mt-2">{card.detail}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {activeTab === 'utilization' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-8 flex items-center gap-3">
                <div className="p-2 bg-emerald-50 rounded-lg">
                  <Building2 className="text-emerald-500" size={20} />
                </div>
                School Utilization Overview
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {schoolSummary.map((school: any) => (
                  <div key={school.name} className="p-6 bg-slate-50 rounded-2xl border border-slate-100 group hover:border-emerald-200 transition-all">
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-sm font-bold text-slate-700">{school.name}</span>
                      <span className={cn(
                        "text-xs font-bold px-3 py-1 rounded-full",
                        school.avgUtilization > 70 ? "bg-emerald-100 text-emerald-700" : 
                        school.avgUtilization > 40 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"
                      )}>
                        {school.avgUtilization}%
                      </span>
                    </div>
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                      <div 
                        className={cn(
                          "h-full transition-all duration-700 ease-out",
                          school.avgUtilization > 70 ? "bg-emerald-500" : 
                          school.avgUtilization > 40 ? "bg-amber-500" : "bg-rose-500"
                        )}
                        style={{ width: `${school.avgUtilization}%` }}
                      />
                    </div>
                    <div className="flex justify-between items-center mt-4">
                      <p className="text-[10px] text-slate-400 uppercase font-bold tracking-widest">{school.deptCount} Departments</p>
                      <button
                        type="button"
                        onClick={() => setSelectedSchool(school)}
                        className="text-[10px] font-bold text-emerald-600 hover:underline uppercase tracking-widest"
                      >
                        Details
                      </button>
                    </div>
                  </div>
                ))}
                {schoolSummary.length === 0 && (
                  <div className="md:col-span-2 p-8 text-center text-sm text-slate-400 italic border border-dashed border-slate-200 rounded-2xl">
                    No school utilization data matches the selected filters.
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-8 flex items-center gap-3">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <Layers className="text-blue-500" size={20} />
                </div>
                Department Utilization
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">School</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {departmentSummary.map((dept: any) => (
                      <tr key={dept.name} className="hover:bg-slate-50/50 transition-colors group">
                        <td className="py-5 text-sm font-bold text-slate-700">{dept.name}</td>
                        <td className="py-5 text-sm text-slate-500">{dept.school}</td>
                        <td className="py-5 text-sm text-slate-500">{dept.roomCount}</td>
                        <td className="py-5 text-right">
                          <span className={cn(
                            "text-xs font-bold px-3 py-1 rounded-lg",
                            dept.avgUtilization > 70 ? "bg-emerald-50 text-emerald-600" : 
                            dept.avgUtilization > 40 ? "bg-amber-50 text-amber-600" : "bg-rose-50 text-rose-600"
                          )}>
                            {dept.avgUtilization}%
                          </span>
                        </td>
                      </tr>
                    ))}
                    {departmentSummary.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-sm text-slate-400 italic">
                          No department utilization data matches the selected filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {filters.reportType === 'building_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Building Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Building</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Maintenance Issues</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {buildingSummary.map((building: any) => (
                        <tr key={building.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{building.name}</td>
                          <td className="py-4 text-sm text-slate-500">{building.roomCount}</td>
                          <td className="py-4 text-sm text-slate-500">{building.maintenanceIssues}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{building.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'campus_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Campus Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Campus</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Buildings</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {campusSummary.map((campus: any) => (
                        <tr key={campus.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{campus.name}</td>
                          <td className="py-4 text-sm text-slate-500">{campus.buildingCount}</td>
                          <td className="py-4 text-sm text-slate-500">{campus.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{campus.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'department_allocation' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Department Allocation Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Capacity</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {departmentSummary.map((department: any) => (
                        <tr key={department.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{department.name}</td>
                          <td className="py-4 text-sm text-slate-500">{department.roomCount}</td>
                          <td className="py-4 text-sm text-slate-500">{department.totalCapacity}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{department.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'available_room_summary' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Available Room Summary</h3>
                <p className="text-sm text-slate-500 mb-6">
                  Summarizes only rooms whose current room-management status is <span className="font-semibold text-slate-700">Available</span>, including base room types, child sub room types, and named labs.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
                  <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                    <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Available Rooms</p>
                    <p className="text-2xl font-bold text-slate-800">{availableRoomReports.length}</p>
                  </div>
                  <div className="p-4 bg-blue-50 rounded-2xl border border-blue-100">
                    <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">Room Types</p>
                    <p className="text-2xl font-bold text-slate-800">{availableRoomSummaryRows.filter((row: any) => row.SummaryScope === 'Room Type').length}</p>
                  </div>
                  <div className="p-4 bg-amber-50 rounded-2xl border border-amber-100">
                    <p className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Sub Room Types</p>
                    <p className="text-2xl font-bold text-slate-800">{availableRoomSummaryRows.filter((row: any) => row.SummaryScope === 'Sub Room Type').length}</p>
                  </div>
                  <div className="p-4 bg-violet-50 rounded-2xl border border-violet-100">
                    <p className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">Named Labs</p>
                    <p className="text-2xl font-bold text-slate-800">{availableRoomSummaryRows.filter((row: any) => row.SummaryScope === 'Lab Name' || row.SummaryScope === 'Sub Lab Name').length}</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Summary Scope</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Category</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Available Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room Numbers</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {availableRoomSummaryRows.map((item: any) => (
                        <tr key={`${item.SummaryScope}-${item.Category}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.SummaryScope}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Category}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.AvailableRooms}</td>
                          <td className="py-4 text-sm text-slate-500">{item.RoomNumbers || '-'}</td>
                        </tr>
                      ))}
                      {availableRoomSummaryRows.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-sm text-slate-400 italic">
                            No available-room summary rows match the selected filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'category_room_list' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Category-wise Room List</h3>
                <p className="text-sm text-slate-500 mb-6">
                  Use the category dropdowns above to review rooms grouped by a single room category such as room type, sub room type, usage category, lab name, restroom type, building, floor, or status.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                  <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
                    <p className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest">Category Type</p>
                    <p className="text-lg font-bold text-slate-800">{categoryTypeOptions.find((option) => option.value === filters.roomCategoryType)?.label || 'Category'}</p>
                  </div>
                  <div className="p-4 bg-sky-50 rounded-2xl border border-sky-100">
                    <p className="text-[10px] font-bold text-sky-600 uppercase tracking-widest">Selected Value</p>
                    <p className="text-lg font-bold text-slate-800">{filters.roomCategoryValue || 'All Category Values'}</p>
                  </div>
                  <div className="p-4 bg-emerald-50 rounded-2xl border border-emerald-100">
                    <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">Matching Rooms</p>
                    <p className="text-2xl font-bold text-slate-800">{categoryWiseRoomListRows.length}</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        {['Category Type', 'Category Value', 'Report Category', 'Room ID', 'Room', 'Room Name', 'Campus', 'Building', 'Block', 'Floor', 'Type', 'Hierarchy Level', 'Parent Room', 'Layout', 'Usage Category', 'Status', 'Capacity'].map((column) => (
                          <th key={column} className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {categoryWiseRoomListRows.map((item: any, index: number) => (
                        <tr key={`${item.RoomId || item.Room}-${index}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.CategoryType}</td>
                          <td className="py-4 text-sm text-slate-500">{item.CategoryValue}</td>
                          <td className="py-4 text-sm text-slate-500">{item.ReportCategory || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.RoomId}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.Room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.RoomName || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Campus || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Building || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Block || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Floor || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Type || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.HierarchyLevel || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.ParentRoom || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Layout || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.UsageCategory || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Status || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Capacity ?? '-'}</td>
                        </tr>
                      ))}
                      {categoryWiseRoomListRows.length === 0 && (
                        <tr>
                          <td colSpan={17} className="py-8 text-center text-sm text-slate-400 italic">
                            No rooms match the selected category filters.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'room_type_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Room Type Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room Type</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {roomTypeSummary.map((item: any) => (
                        <tr key={item.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.name}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'usage_category_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Usage Category Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Usage Category</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {usageCategorySummary.map((item: any) => (
                        <tr key={item.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.name}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'year_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Year-wise Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Year</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {yearSummary.map((item: any) => (
                        <tr key={item.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.name}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'semester_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Semester-wise Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Semester</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {semesterSummary.map((item: any) => (
                        <tr key={item.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.name}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'section_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Section-wise Utilization Summary</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Section</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {sectionSummary.map((item: any) => (
                        <tr key={item.name} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.name}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomCount}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.avgUtilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'booking_approvals' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Booking Approval Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                  {bookingStatusSummary.map(status => (
                    <div key={status.name} className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{status.name}</p>
                      <p className="text-2xl font-bold text-slate-800">{status.count}</p>
                    </div>
                  ))}
                  {bookingStatusSummary.length === 0 && (
                    <p className="text-sm text-slate-400 italic">No booking request activity matches the selected filters.</p>
                  )}
                </div>
              </div>
            )}

            {filters.reportType === 'room_level_detail' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Room-level Detail Report</h3>
                <p className="text-sm text-slate-500 mb-6">Provides one row per room with location, academic usage tags, operational status, and utilization context.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        {['Room', 'Building', 'Block', 'Floor', 'Department', 'Type', 'Capacity', 'Utilization', 'Scheduled Hours', 'Booked Hours', 'Years', 'Semesters', 'Sections', 'Flags'].map((column) => (
                          <th key={column} className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {detailedRoomReportRows.map((item: any) => (
                        <tr key={item.RoomId || item.Room} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.Room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Building}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Block || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Floor}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Department}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Type}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.Capacity}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.Utilization}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.ScheduledHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.BookedHours}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Years || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Semesters || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Sections || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Flags || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'time_band_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Room Utilization by Time Band</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Time Band</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Booked Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {roomTimeBandUtilization.map((item: any) => (
                        <tr key={item.band} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.band}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.bookedHours}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.utilization}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'hourly_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Hourly Utilization Report</h3>
                <p className="text-sm text-slate-500 mb-6">Shows room usage in one-hour bands across the academic week using the currently filtered schedules and approved bookings.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Hour Band</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Booked Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Utilization</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Entries</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Approved Bookings</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Occupied Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room Numbers</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {hourlyUtilizationReport.map((item: any) => (
                        <tr key={item.hourBand} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.hourBand}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.bookedHours}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.utilization}%</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledEntries}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.approvedBookings}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.occupiedRooms}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomNumbers || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'day_wise_utilization' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Day-wise Utilization Report</h3>
                <p className="text-sm text-slate-500 mb-6">Summarizes weekly room usage by weekday so you can compare which academic days are most heavily occupied.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Day</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Booked Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Utilization</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Entries</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Approved Bookings</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Occupied Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room Numbers</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {dayWiseUtilizationReport.map((item: any) => (
                        <tr key={item.day} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.day}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.bookedHours}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.utilization}%</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledEntries}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.approvedBookings}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.occupiedRooms}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomNumbers || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'date_wise_occupancy' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Date-wise Occupancy Report</h3>
                <p className="text-sm text-slate-500 mb-6">Projects occupancy across actual calendar dates. If no date range is selected, the report defaults to the current academic week.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Day</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Booked Hours</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Utilization</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Scheduled Entries</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Approved Bookings</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Occupied Rooms</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room Numbers</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {dateWiseOccupancyReport.map((item: any) => (
                        <tr key={item.date} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{formatDisplayDate(item.date)}</td>
                          <td className="py-4 text-sm text-slate-500">{item.day}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.bookedHours}</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.utilization}%</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.scheduledEntries}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.approvedBookings}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.occupiedRooms}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomNumbers || '-'}</td>
                        </tr>
                      ))}
                      {dateWiseOccupancyReport.length === 0 && (
                        <tr><td colSpan={9} className="py-8 text-center text-slate-400 italic">No date-wise occupancy rows found for the selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'per_room_occupancy' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Per-room Occupancy Snapshot</h3>
                <p className="text-sm text-slate-500 mb-6">
                  Switch between date-wise, day-wise, and hour-wise room snapshots to see whether each room is vacant, occupied, has multiple simultaneous entries, or is suppressed by an exam override.
                </p>
                {perRoomOccupancyMatrix && (
                  <div className="mb-8 p-5 bg-amber-50 border border-amber-100 rounded-2xl">
                    <div className="flex items-center justify-between gap-4 mb-4">
                      <div>
                        <h4 className="text-sm font-bold text-slate-800">Selected Room Matrix: {perRoomOccupancyMatrix.room}</h4>
                        <p className="text-xs text-slate-500">A transposed room-wise summary showing the selected room across the active {filters.snapshotMode === 'hour' ? 'hour bands' : filters.snapshotMode === 'day' ? 'weekdays' : 'dates'}.</p>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="border-b border-amber-100">
                            <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Metric</th>
                            {perRoomOccupancyMatrix.columns.map((column: string) => (
                              <th key={column} className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-amber-100/70">
                          {perRoomOccupancyMatrix.rows.map((row: any) => (
                            <tr key={row.Metric} className="hover:bg-white/60">
                              <td className="py-4 text-sm font-bold text-slate-700">{row.Metric}</td>
                              {perRoomOccupancyMatrix.columns.map((column: string) => (
                                <td key={`${row.Metric}-${column}`} className="py-4 text-sm text-slate-500 text-right">{row[column] ?? '-'}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {!perRoomOccupancyMatrix && (
                  <div className="mb-8 p-4 bg-slate-50 border border-slate-100 rounded-2xl text-sm text-slate-500">
                    Select a single room in the report filters to generate the transposed per-room matrix view.
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        {['Date', 'Day', 'Hour Band', 'Room', 'Building', 'Block', 'Floor', 'Department', 'Type', 'Status', 'Schedules', 'Bookings', 'Exam Suppressed', 'Details'].map((column) => (
                          <th key={column} className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {perRoomOccupancySnapshotRows.map((item: any) => (
                        <tr key={`${item.Date}-${item.Day}-${item.Room}-${item.HourBand}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm text-slate-500">{item.Date === '-' ? '-' : formatDisplayDate(item.Date)}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Day}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.HourBand}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.Room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Building}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Block || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Floor}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Department}</td>
                          <td className="py-4 text-sm text-slate-500">{item.Type}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.OccupancyStatus}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.ScheduledEntries}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.ApprovedBookings}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.SuppressedSchedules}</td>
                          <td className="py-4 text-sm text-slate-500 min-w-[320px]">{item.Details || '-'}</td>
                        </tr>
                      ))}
                      {perRoomOccupancySnapshotRows.length === 0 && (
                        <tr><td colSpan={14} className="py-8 text-center text-slate-400 italic">No room snapshot rows found for the selected date, day, or hour band.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'department_roomtype_demand' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Department vs Room-Type Demand Matrix</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        {roomTypeOptions.slice(0, 8).map((type: string) => (
                          <th key={type} className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">{type}</th>
                        ))}
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {departmentRoomTypeDemand.map((item: any) => (
                        <tr key={item.department} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.department}</td>
                          {roomTypeOptions.slice(0, 8).map((type: string) => (
                            <td key={type} className="py-4 text-sm text-slate-500 text-right">{item.roomTypeCounts[type] || 0}</td>
                          ))}
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.totalDemand}</td>
                        </tr>
                      ))}
                      {departmentRoomTypeDemand.length === 0 && (
                        <tr><td colSpan={10} className="py-8 text-center text-slate-400 italic">No department demand rows match the selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'clash_overlap' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Clash / Overlap Report</h3>
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Source</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Day/Date</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Year A</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Semester A</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Entry A</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Year B</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Semester B</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Entry B</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {overlapConflictReport.map((item: any, index: number) => (
                        <tr key={`${item.source}-${item.room}-${item.day}-${index}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-xs font-bold text-rose-600">{item.source}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.day}</td>
                          <td className="py-4 text-sm text-slate-500">{item.yearA || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.semesterA || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.startA} - {item.endA} | {item.courseA}</td>
                          <td className="py-4 text-sm text-slate-500">{item.yearB || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.semesterB || '-'}</td>
                          <td className="py-4 text-sm text-slate-500">{item.startB} - {item.endB} | {item.courseB}</td>
                        </tr>
                      ))}
                      {overlapConflictReport.length === 0 && (
                        <tr><td colSpan={9} className="py-8 text-center text-slate-400 italic">No overlap conflicts found for current filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'vacancy_opportunity' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Vacancy Opportunity Report</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Building</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Idle Hours/Week</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Utilization</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Opportunity</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {vacancyOpportunityReport.map((item: any) => (
                        <tr key={`${item.room}-${item.building}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.building}</td>
                          <td className="py-4 text-sm text-slate-500">{item.department}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.idleHours}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.utilization}%</td>
                          <td className="py-4 text-sm font-bold text-slate-700 text-right">{item.opportunity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'capacity_mismatch' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Capacity Mismatch Report</h3>
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Event</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Students</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Capacity</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Occupancy</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {capacityMismatchReport.map((item: any) => (
                        <tr key={`${item.date}-${item.room}-${item.event}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm text-slate-500">{item.date || '-'}</td>
                          <td className="py-4 text-sm font-bold text-slate-700">{item.room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.department}</td>
                          <td className="py-4 text-sm text-slate-500">{item.event}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.studentCount || '-'}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.roomCapacity || '-'}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.occupancyPercent}%</td>
                          <td className="py-4 text-xs font-bold text-rose-600">{item.mismatchType}</td>
                        </tr>
                      ))}
                      {capacityMismatchReport.length === 0 && (
                        <tr><td colSpan={8} className="py-8 text-center text-slate-400 italic">No capacity mismatch rows found for selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'exam_impact' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Exam Impact Report</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Exam Window</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Semester</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date Range</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Days</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Affected/Week</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Estimated Blocked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {examImpactReport.map((item: any) => (
                        <tr key={`${item.title}-${item.department}-${item.startDate}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.title}</td>
                          <td className="py-4 text-sm text-slate-500">{item.department}</td>
                          <td className="py-4 text-sm text-slate-500">{item.semester}</td>
                          <td className="py-4 text-sm text-slate-500">{item.startDate} to {item.endDate}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.days}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.affectedWeeklyClasses}</td>
                          <td className="py-4 text-sm font-bold text-amber-700 text-right">{item.estimatedBlockedSessions}</td>
                        </tr>
                      ))}
                      {examImpactReport.length === 0 && (
                        <tr><td colSpan={7} className="py-8 text-center text-slate-400 italic">No examination impact found for selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'booking_lifecycle' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Booking Lead-Time & Cancellation Trends</h3>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Requests</p><p className="text-2xl font-bold text-slate-800">{bookingLifecycleReport.totalRequests}</p></div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Approvals</p><p className="text-2xl font-bold text-emerald-700">{bookingLifecycleReport.approvals}</p></div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Cancellations</p><p className="text-2xl font-bold text-rose-700">{bookingLifecycleReport.cancellations}</p></div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Cancellation Rate</p><p className="text-2xl font-bold text-slate-800">{bookingLifecycleReport.cancellationRate}%</p></div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100"><p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Avg Lead Days</p><p className="text-2xl font-bold text-slate-800">{bookingLifecycleReport.averageLeadDays ?? 'N/A'}</p><p className="text-[10px] text-slate-400 mt-1">captured: {bookingLifecycleReport.leadTimeCapturedCount}</p></div>
                </div>
              </div>
            )}

            {filters.reportType === 'no_show_risk' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">No-Show / Unused Booking Risk</h3>
                <div className="overflow-x-auto max-h-96">
                  <table className="w-full text-left">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Booking</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Date</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Students</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Capacity</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Risk Score</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {noShowRiskReport.map((item: any) => (
                        <tr key={`${item.bookingId}-${item.room}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.bookingId}</td>
                          <td className="py-4 text-sm text-slate-500">{item.date}</td>
                          <td className="py-4 text-sm text-slate-500">{item.room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.department}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.studentCount || '-'}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.roomCapacity || '-'}</td>
                          <td className="py-4 text-sm font-bold text-rose-700 text-right">{item.riskScore}</td>
                        </tr>
                      ))}
                      {noShowRiskReport.length === 0 && (
                        <tr><td colSpan={7} className="py-8 text-center text-slate-400 italic">No no-show risk rows for selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'shared_room_conflict' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Shared-Room Conflict Risk</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Building</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Layout / Aliases</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Departments</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Sections</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Overlaps</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Risk</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {sharedRoomConflictRiskReport.map((item: any) => (
                        <tr key={`${item.room}-${item.building}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.room}</td>
                          <td className="py-4 text-sm text-slate-500">{item.building}</td>
                          <td className="py-4 text-sm text-slate-500">{item.roomLayout}{item.aliases ? ` (${item.aliases})` : ''}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.departments}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.sections}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.overlaps}</td>
                          <td className="py-4 text-sm font-bold text-rose-700 text-right">{item.riskScore}</td>
                        </tr>
                      ))}
                      {sharedRoomConflictRiskReport.length === 0 && (
                        <tr><td colSpan={7} className="py-8 text-center text-slate-400 italic">No high-risk shared room conflicts for selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filters.reportType === 'semester_peak_forecast' && (
              <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
                <h3 className="text-lg font-bold text-slate-800 mb-6">Semester-wise Peak Load Forecast</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Semester</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Day</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Peak Band</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Peak Slots</th>
                        <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Total Classes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {semesterPeakLoadForecast.map((item: any) => (
                        <tr key={`${item.semester}-${item.day}`} className="hover:bg-slate-50/50">
                          <td className="py-4 text-sm font-bold text-slate-700">{item.semester}</td>
                          <td className="py-4 text-sm text-slate-500">{item.day}</td>
                          <td className="py-4 text-sm text-slate-500">{item.peakBand}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.peakSlots}</td>
                          <td className="py-4 text-sm text-slate-500 text-right">{item.totalClasses}</td>
                        </tr>
                      ))}
                      {semesterPeakLoadForecast.length === 0 && (
                        <tr><td colSpan={5} className="py-8 text-center text-slate-400 italic">No forecast rows available for selected filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
              <h3 className="text-lg font-bold text-slate-800 mb-6 flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <DoorOpen className="text-indigo-500" size={20} />
                </div>
                Filtered Room Report
              </h3>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-100">
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Room</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Building</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Block</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Floor</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Usage</th>
                      <th className="pb-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {sortedFilteredRoomReports.map((room: any) => (
                      <tr key={`${room.building}-${room.room_number}`} className="hover:bg-slate-50/50">
                        <td className="py-4 text-sm font-bold text-slate-700">{room.room_number}</td>
                        <td className="py-4 text-sm text-slate-500">{room.building}</td>
                        <td className="py-4 text-sm text-slate-500">{room.block || '-'}</td>
                        <td className="py-4 text-sm text-slate-500">{getFloorName(room.floor_number)}</td>
                        <td className="py-4 text-sm text-slate-500">{room.department}</td>
                        <td className="py-4">
                          <span className={cn(
                            "text-xs font-bold px-3 py-1 rounded-lg",
                            room.utilization > 80 ? "bg-rose-50 text-rose-600" :
                            room.utilization > 40 ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"
                          )}>
                            {room.utilization}%
                          </span>
                        </td>
                        <td className="py-4">
                          <div className="flex flex-wrap gap-1">
                            {(room.flags || ['Good']).map((flag: string) => (
                              <span key={flag} className="px-2 py-1 bg-slate-100 text-slate-500 rounded text-[10px] font-bold">{flag}</span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredRoomReports.length === 0 && (
                      <tr><td colSpan={7} className="py-8 text-center text-slate-400 italic">No rooms match the selected filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="space-y-8">
            <div className="bg-slate-900 text-white p-8 rounded-3xl shadow-2xl shadow-slate-900/20 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-16 -mt-16"></div>
              <div className="flex items-center justify-between mb-8 relative z-10">
                <h3 className="text-lg font-bold flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/20 rounded-lg">
                    <Sparkles className="text-emerald-400" size={20} />
                  </div>
                  AI Optimization
                </h3>
                <button 
                  onClick={generateSuggestions}
                  disabled={isGeneratingSuggestions}
                  className="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl transition-all disabled:opacity-50 group"
                >
                  <Zap size={18} className={cn(isGeneratingSuggestions ? "animate-pulse text-emerald-400" : "group-hover:scale-110 transition-transform")} />
                </button>
              </div>
              
              <div className="space-y-4 relative z-10">
                {suggestionError && (
                  <div className="p-4 bg-rose-500/10 border border-rose-400/30 rounded-xl text-xs text-rose-200 font-medium">
                    {suggestionError}
                  </div>
                )}
                {suggestions.length > 0 ? suggestions.map((s, i) => (
                  <div key={i} className="p-5 bg-white/5 rounded-2xl border border-white/10 hover:bg-white/10 transition-all group">
                    <div className="flex justify-between items-start mb-3">
                      <h4 className="text-sm font-bold text-emerald-400 group-hover:text-emerald-300 transition-colors">{s.title}</h4>
                      <span className={cn(
                        "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-widest",
                        s.impact === 'High' ? "bg-rose-500/20 text-rose-400" : "bg-amber-500/20 text-amber-400"
                      )}>
                        {s.impact}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed font-medium">{s.suggestion}</p>
                  </div>
                )) : (
                  <div className="text-center py-12">
                    <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-white/10">
                      <BrainCircuit className="text-slate-700" size={32} />
                    </div>
                    <p className="text-sm text-slate-400 font-medium max-w-[200px] mx-auto">Click the lightning bolt to generate AI insights.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm">
              <h3 className="text-sm font-bold text-slate-800 mb-6 uppercase tracking-widest">Export Reports</h3>
              <div className="space-y-3">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Individual Report</p>
                  <select
                    value={individualReportType}
                    onChange={e => setIndividualReportType(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
                  >
                    {REPORT_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => exportReportByType(individualReportType)}
                    className="w-full px-4 py-2 bg-blue-50 text-blue-700 border border-blue-100 rounded-xl text-xs font-bold flex items-center justify-center gap-2"
                  >
                    <FileSpreadsheet size={16} />
                    Download Selected Report
                  </button>
                </div>
                <button onClick={exportComprehensiveWorkbook} className="w-full flex items-center justify-between px-5 py-4 bg-violet-50 text-violet-700 rounded-2xl hover:bg-violet-100 transition-all group border border-violet-100">
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-white rounded-lg shadow-sm">
                      <FileSpreadsheet className="text-violet-500" size={20} />
                    </div>
                    <span className="text-sm font-bold">Comprehensive Workbook</span>
                  </div>
                  <ChevronRight size={18} className="text-violet-300 group-hover:translate-x-1 transition-transform" />
                </button>
                <button onClick={exportSchoolSummaryReport} className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 text-slate-700 rounded-2xl hover:bg-slate-100 transition-all group border border-slate-100">
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-white rounded-lg shadow-sm">
                      <FileText className="text-rose-500" size={20} />
                    </div>
                    <span className="text-sm font-bold">Utilization Summary</span>
                  </div>
                  <ChevronRight size={18} className="text-slate-300 group-hover:translate-x-1 transition-transform" />
                </button>
                <button onClick={exportRawUsageData} className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 text-slate-700 rounded-2xl hover:bg-slate-100 transition-all group border border-slate-100">
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-white rounded-lg shadow-sm">
                      <FileSpreadsheet className="text-emerald-500" size={20} />
                    </div>
                    <span className="text-sm font-bold">Raw Usage Data</span>
                  </div>
                  <ChevronRight size={18} className="text-slate-300 group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedSchool && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-4xl max-h-[90vh] rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-slate-800">{selectedSchool.name}</h3>
                <p className="text-sm text-slate-500">
                  {selectedSchool.roomCount} rooms, {selectedSchool.deptCount} departments, {selectedSchool.avgUtilization}% average utilization
                </p>
              </div>
              <button type="button" onClick={() => setSelectedSchool(null)} className="text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>
            <div className="p-6 space-y-6 overflow-y-auto max-h-[calc(90vh-88px)]">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Departments</p>
                  <p className="text-2xl font-bold text-slate-800">{selectedSchool.deptCount}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</p>
                  <p className="text-2xl font-bold text-slate-800">{selectedSchool.roomCount}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total Capacity</p>
                  <p className="text-2xl font-bold text-slate-800">{selectedSchool.totalCapacity}</p>
                </div>
                <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Unmapped Rooms</p>
                  <p className="text-2xl font-bold text-slate-800">{selectedSchool.unmappedRooms}</p>
                </div>
              </div>

              <div className="bg-slate-50 rounded-2xl border border-slate-100 p-5">
                <h4 className="text-sm font-bold text-slate-800 mb-4">Department Breakdown</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="pb-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Department</th>
                        <th className="pb-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Rooms</th>
                        <th className="pb-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Capacity</th>
                        <th className="pb-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest text-right">Avg Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedSchoolDepartments.map((department: any) => (
                        <tr key={department.name}>
                          <td className="py-3 text-sm font-semibold text-slate-700">{department.name}</td>
                          <td className="py-3 text-sm text-slate-500">{department.roomCount}</td>
                          <td className="py-3 text-sm text-slate-500">{department.totalCapacity}</td>
                          <td className="py-3 text-sm font-bold text-slate-700 text-right">{department.avgUtilization}%</td>
                        </tr>
                      ))}
                      {selectedSchoolDepartments.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-6 text-center text-sm text-slate-400 italic">No department data available for this school.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-slate-50 rounded-2xl border border-slate-100 p-5">
                <h4 className="text-sm font-bold text-slate-800 mb-4">Top Rooms</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {selectedSchoolTopRooms.map((room: any) => (
                    <div key={`${room.building}-${room.room_number}`} className="p-4 bg-white rounded-xl border border-slate-100">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold text-slate-800">Room {room.room_number}</p>
                          <p className="text-xs text-slate-500">{room.department} • {getRoomTypeDisplay(room)}</p>
                        </div>
                        <span className="text-xs font-bold px-3 py-1 rounded-lg bg-emerald-50 text-emerald-600">
                          {room.utilization}%
                        </span>
                      </div>
                    </div>
                  ))}
                  {selectedSchoolTopRooms.length === 0 && (
                    <p className="text-sm text-slate-400 italic">No room utilization data is available for this school.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'methodology' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {methodologyData.map((item) => (
            <div key={item.title} className="bg-white p-10 rounded-[40px] border border-slate-200 shadow-sm space-y-6 group hover:border-emerald-500 transition-all">
              <h4 className="text-xl font-bold text-slate-800">{item.title}</h4>
              <div className="p-6 bg-slate-50 rounded-3xl border border-slate-100 font-mono text-sm text-emerald-600 group-hover:bg-emerald-50 transition-colors">
                {item.formula}
              </div>
              <p className="text-sm text-slate-600 leading-relaxed font-medium">{item.description}</p>
              <div className="flex items-center gap-3 pt-4 border-t border-slate-50">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Recommended Target:</span>
                <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl">{item.target}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'kpis' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm hover:shadow-md transition-all">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4">{kpi.label}</p>
              <div className="flex items-end justify-between">
                <h3 className="text-4xl font-bold text-slate-800 tracking-tight">{kpi.value}</h3>
                <div className={cn(
                  "flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-lg",
                  kpi.trend.startsWith('+') ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
                )}>
                  {kpi.trend.startsWith('+') ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {kpi.trend}
                </div>
              </div>
              <div className="mt-6 flex items-center gap-3">
                <div className={cn(
                  "w-2.5 h-2.5 rounded-full",
                  kpi.status === 'Excellent' || kpi.status === 'Good' || kpi.status === 'Improving' ? "bg-emerald-500" : "bg-amber-500"
                )}></div>
                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{kpi.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimetableBuilder() {
  const location = useLocation();
  const [schedules, setSchedules] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [academicCalendars, setAcademicCalendars] = useState<any[]>([]);
  const [timingProfiles, setTimingProfiles] = useState<any[]>([]);
  const [batchRoomAllocations, setBatchRoomAllocations] = useState<any[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<string>('');
  const [referenceDate, setReferenceDate] = useState(formatLocalDate(new Date()));
  const [timetableContext, setTimetableContext] = useState({ department_id: '', year: '', semester: '', section: '' });
  const [loading, setLoading] = useState(true);

  const timeToMinutes = (time?: string) => {
    const match = time?.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };

  const activeRoom = useMemo(
    () => rooms.find(r => r.id?.toString() === selectedRoom) ?? null,
    [rooms, selectedRoom],
  );

  const roomScopedSchedules = useMemo(() => schedules.filter(schedule => {
    if (activeRoom && schedule.room_id != null) return idsMatch(schedule.room_id, activeRoom.id);
    return activeRoom ? false : schedule.room === selectedRoom;
  }), [activeRoom, schedules, selectedRoom]);

  const roomDepartmentOptions = useMemo(() => Array.from(new Map(
    roomScopedSchedules
      .filter(schedule => schedule.department_id != null)
      .map(schedule => [
        schedule.department_id?.toString(),
        {
          value: schedule.department_id?.toString(),
          label: departments.find(department => idsMatch(department.id, schedule.department_id))?.name || schedule.department || `Department ${schedule.department_id}`,
        },
      ]),
  ).values()).sort((a, b) => a.label.localeCompare(b.label)), [departments, roomScopedSchedules]);

  const roomSemesterOptions = useMemo(() => Array.from(new Set(
    roomScopedSchedules
      .map(schedule => normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, ''))
      .filter(Boolean),
  )).sort((a, b) => {
    const left = parseSemesterNumber(a) || 0;
    const right = parseSemesterNumber(b) || 0;
    return left - right || a.localeCompare(b);
  }), [roomScopedSchedules]);

  const roomYearOptions = useMemo(() => Array.from(new Set(
    roomScopedSchedules
      .filter(schedule =>
        (!timetableContext.department_id || idsMatch(schedule.department_id, timetableContext.department_id)) &&
        (!timetableContext.semester || normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, '') === timetableContext.semester),
      )
      .map(schedule => getYearDisplayLabel(schedule?.year_of_study, schedule?.semester))
      .filter(year => year && year !== '-'),
  )).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [roomScopedSchedules, timetableContext.department_id, timetableContext.semester]);

  const roomSectionOptions = useMemo(() => Array.from(new Set(
    roomScopedSchedules
      .filter(schedule =>
        (!timetableContext.department_id || idsMatch(schedule.department_id, timetableContext.department_id)) &&
        (!timetableContext.year || getYearDisplayLabel(schedule?.year_of_study, schedule?.semester) === timetableContext.year) &&
        (!timetableContext.semester || normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, '') === timetableContext.semester),
      )
      .map(schedule => schedule.section?.toString().trim())
      .filter((section): section is string => Boolean(section)),
  )).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [roomScopedSchedules, timetableContext.department_id, timetableContext.year, timetableContext.semester]);

  useEffect(() => {
    setTimetableContext(current => ({
      department_id: current.department_id && roomDepartmentOptions.some(option => option.value === current.department_id) ? current.department_id : '',
      year: current.year && roomYearOptions.includes(current.year) ? current.year : '',
      semester: current.semester && roomSemesterOptions.includes(current.semester) ? current.semester : '',
      section: current.section && roomSectionOptions.includes(current.section) ? current.section : '',
    }));
  }, [roomDepartmentOptions, roomSectionOptions, roomSemesterOptions, roomYearOptions]);

  const hasContextFilter = Boolean(timetableContext.department_id || timetableContext.year || timetableContext.semester || timetableContext.section);

  const distinctContextCount = useMemo(() => new Set(
    roomScopedSchedules.map(schedule => [
      schedule.department_id?.toString() || '',
      getYearDisplayLabel(schedule?.year_of_study, schedule?.semester),
      normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, ''),
      schedule.section?.toString().trim() || '',
    ].join('|')),
  ).size, [roomScopedSchedules]);

  const requiresContextFilterForVacancy = distinctContextCount > 1 && !hasContextFilter;

  const contextSchedules = useMemo(() => roomScopedSchedules.filter(schedule => {
    if (timetableContext.department_id && !idsMatch(schedule.department_id, timetableContext.department_id)) return false;
    if (timetableContext.year && getYearDisplayLabel(schedule?.year_of_study, schedule?.semester) !== timetableContext.year) return false;
    if (timetableContext.semester && normalizeExactSemesterValue(schedule.semester, schedule.year_of_study, '') !== timetableContext.semester) return false;
    if (timetableContext.section && (schedule.section?.toString().trim() || '') !== timetableContext.section) return false;
    return true;
  }), [roomScopedSchedules, timetableContext.department_id, timetableContext.year, timetableContext.section, timetableContext.semester]);

  const resolvedTimingContext = useMemo(() => {
    const candidateSchedules = contextSchedules.length > 0 ? contextSchedules : roomScopedSchedules;
    const uniqueDepartmentIds = Array.from(new Set(candidateSchedules.map(schedule => schedule.department_id?.toString()).filter(Boolean)));
    const uniqueYears = Array.from(new Set(candidateSchedules.map(schedule => normalizeYearOfStudyValue(schedule?.year_of_study, '')).filter(Boolean)));
    const uniqueSemesters = Array.from(new Set(candidateSchedules.map(schedule => normalizeExactSemesterValue(schedule?.semester, schedule?.year_of_study, '')).filter(Boolean)));
    const uniqueSections = Array.from(new Set(candidateSchedules.map(schedule => schedule.section?.toString().trim()).filter(Boolean)));
    const matchingCalendar = academicCalendars.find(calendar =>
      normalizeComparableDateValue(calendar?.start_date) <= normalizeComparableDateValue(referenceDate) &&
      normalizeComparableDateValue(calendar?.end_date) >= normalizeComparableDateValue(referenceDate) &&
      (!timetableContext.department_id || idsMatch(calendar.department_id, timetableContext.department_id)) &&
      (!timetableContext.year || normalizeYearOfStudyValue(calendar.year_of_study, '') === normalizeYearOfStudyValue(timetableContext.year, '')) &&
      (!timetableContext.semester || normalizeSemesterValue(calendar.semester, '') === normalizeSemesterValue(timetableContext.semester, ''))
    );

    return {
      school_id: matchingCalendar?.school_id || '',
      department_id: timetableContext.department_id || (uniqueDepartmentIds.length === 1 ? uniqueDepartmentIds[0] : ''),
      program: matchingCalendar?.program || '',
      academic_year: matchingCalendar?.academic_year || '',
      year_of_study: normalizeYearOfStudyValue(timetableContext.year, '') || (uniqueYears.length === 1 ? uniqueYears[0] : ''),
      semester: timetableContext.semester || (uniqueSemesters.length === 1 ? uniqueSemesters[0] : ''),
      section: timetableContext.section || (uniqueSections.length === 1 ? uniqueSections[0] : ''),
    };
  }, [academicCalendars, contextSchedules, referenceDate, roomScopedSchedules, timetableContext.department_id, timetableContext.section, timetableContext.semester, timetableContext.year]);

  const activeTimingProfile = useMemo(() => resolveTimingProfileForContext({
    timingProfiles,
    academicCalendars,
    activeDate: referenceDate,
    context: resolvedTimingContext,
  }), [academicCalendars, referenceDate, resolvedTimingContext, timingProfiles]);

  const activeTimingProfileSlots = useMemo(
    () => parseTimingProfileSlots(activeTimingProfile?.slot_pattern),
    [activeTimingProfile],
  );

  const roomTimeSlots = useMemo(() => {
    if (activeTimingProfileSlots.length > 0 && (!requiresContextFilterForVacancy || hasContextFilter || distinctContextCount <= 1)) {
      return activeTimingProfileSlots;
    }

    const intervals = contextSchedules
      .map(schedule => ({
        start: timeToMinutes(schedule.start_time),
        end: timeToMinutes(schedule.end_time),
      }))
      .filter((interval): interval is { start: number; end: number } =>
        interval.start != null && interval.end != null && interval.end > interval.start,
      );

    const boundaryPoints = Array.from(new Set(intervals.flatMap(interval => [interval.start, interval.end])))
      .sort((a, b) => a - b);

    const uniqueSlots = Array.from(new Map(
      boundaryPoints
        .slice(0, -1)
        .map((start, index) => ({ start, end: boundaryPoints[index + 1] }))
        .filter(segment =>
          segment.end > segment.start &&
          segment.end - segment.start >= MIN_INFERRED_TIMETABLE_SLOT_MINUTES &&
          intervals.some(interval => interval.start <= segment.start && interval.end >= segment.end),
        )
        .map(segment => {
          const slot = {
            start_time: minutesToTime(segment.start),
            end_time: minutesToTime(segment.end),
          };
          return [getTimeSlotKey(slot), slot] as const;
        }),
    ).values()).sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

    return uniqueSlots.length > 0 ? uniqueSlots : DEFAULT_TIMETABLE_TIME_SLOTS;
  }, [activeTimingProfileSlots, contextSchedules, distinctContextCount, hasContextFilter, requiresContextFilterForVacancy]);

  const fetchData = async () => {
    try {
      const [sRes, rRes, dRes, cRes, tpRes, baRes] = await Promise.all([
        fetch('/api/schedules', { credentials: 'include' }),
        fetch('/api/rooms', { credentials: 'include' }),
        fetch('/api/departments', { credentials: 'include' }),
        fetch('/api/academic_calendars', { credentials: 'include' }),
        fetch('/api/timing_profiles', { credentials: 'include' }),
        fetch('/api/batch_room_allocations', { credentials: 'include' }),
      ]);
      const sData = await sRes.json();
      const rData = await rRes.json();
      const dData = await dRes.json();
      const cData = await cRes.json();
      const tpData = await tpRes.json();
      const baData = await baRes.json();
      setSchedules(deduplicateScheduleRows(Array.isArray(sData) ? sData : []));
      setRooms(rData);
      setDepartments(dData);
      setAcademicCalendars(Array.isArray(cData) ? cData : []);
      setTimingProfiles(Array.isArray(tpData) ? tpData : []);
      setBatchRoomAllocations(Array.isArray(baData) ? baData : []);
      const params = new URLSearchParams(location.search);
      const requestedRoomId = params.get('roomId');
      const requestedRoomLabel = params.get('room');
      const requestedDepartmentId = params.get('departmentId') || '';
      const requestedSemester = normalizeExactSemesterValue(params.get('semester'), params.get('year'), '');
      const requestedSection = params.get('section')?.trim() || '';
      const requestedRoom = requestedRoomId
        ? rData.find((room: any) => idsMatch(room.id, requestedRoomId))
        : findRoomByImportLabel(rData, requestedRoomLabel);
      const firstBookableRoom = rData.find(isRoomReservable);
      const activeRoom = requestedRoom || (selectedRoom ? rData.find((room: any) => idsMatch(room.id, selectedRoom)) : null) || firstBookableRoom;
      const requestedYear = params.get('year')?.trim() || '';
      setTimetableContext({
        department_id: requestedDepartmentId,
        year: requestedYear,
        semester: requestedSemester,
        section: requestedSection,
      });
      if (activeRoom) {
        setSelectedRoom(activeRoom.id?.toString());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [location.search]);

  const handleDelete = async (id: number) => {
    if (confirm('Remove this class from the timetable?')) {
      const res = await fetch(`/api/schedules/${id}`, { 
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        fetchData();
      }
    }
  };

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const timetableRoomOptions = rooms
    .filter(room => isRoomReservable(room) || idsMatch(room.id, selectedRoom))
    .sort((a, b) => getRoomDisplayLabel(a, rooms).localeCompare(getRoomDisplayLabel(b, rooms), undefined, { numeric: true }));

  const weekDates = useMemo(() => getWeekDatesForReferenceDate(referenceDate), [referenceDate]);

  const getSchedulesForDay = (day: string) => {
    const dayDate = weekDates[day];
    const baseSchedules = contextSchedules.filter(s => s.day_of_week === day);
    const suppressedSchedules = deduplicateScheduleRows(baseSchedules.filter(schedule =>
      isScheduleSuppressedForDate(schedule, dayDate, academicCalendars, batchRoomAllocations)
    ))
      .map(s => ({
        ...s,
        department_name: departments.find(d => idsMatch(d.id, s.department_id))?.name ?? s.department,
      }))
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

    const effectiveSchedules = deduplicateScheduleRows(baseSchedules.filter(schedule =>
      !isScheduleSuppressedForDate(schedule, dayDate, academicCalendars, batchRoomAllocations)
    ))
      .map(s => ({
        ...s,
        department_name: departments.find(d => idsMatch(d.id, s.department_id))?.name ?? s.department,
      }))
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

    const hasExamOverride = suppressedSchedules.length > 0;
    return { schedules: effectiveSchedules, suppressedSchedules, hasExamOverride, date: dayDate };
  };

  const getDisplaySlotsForDay = (daySchedules: any[], suppressedSchedules: any[]) => {
    const scheduleCoversSlot = (schedule: any, slot: any) => {
      const scheduleStart = timeToMinutes(schedule.start_time);
      const scheduleEnd = timeToMinutes(schedule.end_time);
      const slotStart = timeToMinutes(slot.start_time);
      const slotEnd = timeToMinutes(slot.end_time);
      if (scheduleStart == null || scheduleEnd == null || slotStart == null || slotEnd == null) return false;
      return scheduleStart <= slotStart && scheduleEnd >= slotEnd;
    };

    return roomTimeSlots
      .map(slot => {
        const coveringSchedules = daySchedules.filter(schedule => scheduleCoversSlot(schedule, slot));
        const coveringSuppressedSchedules = suppressedSchedules.filter(schedule => scheduleCoversSlot(schedule, slot));
        return {
          ...slot,
          key: getTimeSlotKey(slot),
          schedules: coveringSchedules,
          state: coveringSchedules.length > 1
            ? 'multi'
            : coveringSchedules.length === 1
              ? 'scheduled'
              : coveringSuppressedSchedules.length > 0
                ? 'exam'
                : 'vacant',
        };
      })
      .sort((a, b) => {
        const startCompare = (a.start_time || '').localeCompare(b.start_time || '');
        if (startCompare !== 0) return startCompare;
        return (a.end_time || '').localeCompare(b.end_time || '');
      });
  };

  if (loading) return <div className="p-8 text-center text-slate-400 font-medium">Loading Timetable...</div>;

  return (
    <div className="space-y-8">
      <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center text-white">
            <Clock size={24} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">Timetable View</h3>
            <p className="text-xs text-slate-500">Visualizing schedules with precise timing slots</p>
            {activeRoom && getRoomAliasList(activeRoom).length > 0 && (
              <p className="text-[11px] font-bold text-blue-700">Aliases: {getRoomAliasList(activeRoom).join(', ')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Week Of:</span>
            <input
              type="date"
              value={referenceDate}
              onChange={e => setReferenceDate(e.target.value)}
              className="bg-transparent text-sm font-bold text-slate-700 focus:outline-none cursor-pointer"
            />
          </div>
          <div className="flex items-center gap-3 bg-slate-50 px-4 py-2 rounded-xl border border-slate-200">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Active Room:</span>
            <select 
              value={selectedRoom}
              onChange={(e) => setSelectedRoom(e.target.value)}
              className="bg-transparent text-sm font-bold text-slate-700 focus:outline-none cursor-pointer"
            >
              {timetableRoomOptions.map(r => (
                <option key={r.id} value={r.id}>Room {getRoomDisplayLabel(r, rooms)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Department Context</p>
            <select
              value={timetableContext.department_id}
              onChange={e => setTimetableContext(prev => ({ ...prev, department_id: e.target.value, section: '' }))}
              className="w-full bg-transparent text-sm font-bold text-slate-700 focus:outline-none"
            >
              <option value="">All Departments</option>
              {roomDepartmentOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Year Context</p>
            <select
              value={timetableContext.year}
              onChange={e => setTimetableContext(prev => ({ ...prev, year: e.target.value, section: '' }))}
              className="w-full bg-transparent text-sm font-bold text-slate-700 focus:outline-none"
            >
              <option value="">All Years</option>
              {roomYearOptions.map(year => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Semester Context</p>
            <select
              value={timetableContext.semester}
              onChange={e => setTimetableContext(prev => ({ ...prev, semester: e.target.value, section: '' }))}
              className="w-full bg-transparent text-sm font-bold text-slate-700 focus:outline-none"
            >
              <option value="">All Semesters</option>
              {roomSemesterOptions.map(semester => (
                <option key={semester} value={semester}>{semester}</option>
              ))}
            </select>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Section Context</p>
            <select
              value={timetableContext.section}
              onChange={e => setTimetableContext(prev => ({ ...prev, section: e.target.value }))}
              className="w-full bg-transparent text-sm font-bold text-slate-700 focus:outline-none"
            >
              <option value="">All Sections</option>
              {roomSectionOptions.map(section => (
                <option key={section} value={section}>{section}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          Vacancy is computed inside the selected academic context. Use these filters when the same room is shared by multiple years, semesters, or sections with different timing patterns.
        </p>
        {activeTimingProfile && (
          <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            Active timing profile: <span className="font-bold">{getTimingProfileDisplayLabel(activeTimingProfile)}</span>
            {activeTimingProfileSlots.length > 0 && (
              <span> with {activeTimingProfileSlots.length} configured slot{activeTimingProfileSlots.length === 1 ? '' : 's'}.</span>
            )}
          </div>
        )}
      </div>

      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Slot Legend</span>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1">
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500"></div>
            <span className="text-[11px] font-bold text-emerald-700">Scheduled</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-rose-200 bg-rose-50 px-3 py-1">
            <div className="h-2.5 w-2.5 rounded-full bg-rose-500"></div>
            <span className="text-[11px] font-bold text-rose-700">Multiple Classes</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
            <div className="h-2.5 w-2.5 rounded-full border-2 border-slate-400 bg-white"></div>
            <span className="text-[11px] font-bold text-slate-600">Vacant</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1">
            <div className="h-2.5 w-2.5 rounded-full bg-amber-500"></div>
            <span className="text-[11px] font-bold text-amber-700">Exam Blocked</span>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          Vacant slots are inferred from the selected room&apos;s actual timetable timings and reduced to the smallest valid periods, while short break gaps under 30 minutes are ignored and scheduled classes keep their original imported duration.
        </p>
        {activeTimingProfileSlots.length > 0 && (
          <p className="mt-2 text-[11px] text-emerald-700">
            This room is currently using the configured timing profile slot pattern instead of purely inferred timetable boundaries.
          </p>
        )}
      </div>

      {requiresContextFilterForVacancy && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
          <p className="text-sm font-bold text-blue-800">Mixed timetable patterns detected for this room.</p>
          <p className="mt-1 text-xs text-blue-700">
            This room is used by multiple department, year, semester, or section contexts. Vacant slots are inferred from the room&apos;s combined timing patterns; select a context above to see more accurate context-specific vacancy.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-6">
        {days.map(day => {
          const { schedules: daySchedules, suppressedSchedules, hasExamOverride, date } = getSchedulesForDay(day);
          const displaySlots = getDisplaySlotsForDay(daySchedules, suppressedSchedules);
          const occupiedSlotCount = displaySlots.filter(slot => slot.schedules.length > 0).length;
          return (
            <div key={day} className="space-y-4">
              <div className="flex items-center justify-between px-2">
                <div>
                  <h4 className="font-bold text-slate-800">{day}</h4>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{date}</p>
                </div>
                <span className="text-[10px] font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
                  {hasExamOverride
                    ? 'Exam Override'
                    : requiresContextFilterForVacancy
                      ? `${daySchedules.length} Classes`
                      : `${occupiedSlotCount}/${displaySlots.length} Slots Used`}
                </span>
              </div>
              
              <div className="space-y-3">
                {displaySlots.map(slot => (
                  <div
                    key={slot.key}
                    className={cn(
                      "rounded-xl border p-4 transition-all",
                      slot.state === 'multi'
                        ? "bg-rose-100 border-rose-300 shadow-sm hover:shadow-md"
                        : slot.state === 'scheduled'
                        ? "bg-emerald-100 border-emerald-300 shadow-sm hover:shadow-md"
                        : slot.state === 'exam'
                          ? "border-amber-300 bg-amber-100/90 shadow-sm"
                          : "border-dashed border-slate-300 bg-slate-100/90",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <div
                          className={cn(
                            "w-2.5 h-2.5 rounded-full",
                            slot.state === 'multi' ? "bg-rose-600" : slot.state === 'scheduled' ? "bg-emerald-600" : slot.state === 'exam' ? "bg-amber-600" : "border-2 border-slate-500 bg-white",
                          )}
                        ></div>
                        <span
                          className={cn(
                            "text-[10px] font-bold uppercase tracking-wider",
                            slot.state === 'multi' ? "text-rose-800" : slot.state === 'scheduled' ? "text-emerald-800" : slot.state === 'exam' ? "text-amber-800" : "text-slate-600",
                          )}
                        >
                          {slot.start_time} - {slot.end_time}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-widest border",
                          slot.state === 'multi'
                            ? "border-rose-300 bg-rose-200 text-rose-800"
                            : slot.state === 'scheduled'
                            ? "border-emerald-300 bg-emerald-200 text-emerald-800"
                            : slot.state === 'exam'
                              ? "border-amber-300 bg-amber-200 text-amber-800"
                              : "border-slate-300 bg-slate-200 text-slate-600",
                        )}
                      >
                        {slot.state === 'multi' ? 'Multiple' : slot.state === 'scheduled' ? 'Scheduled' : slot.state === 'exam' ? 'Blocked' : 'Vacant'}
                      </span>
                    </div>
                    {slot.schedules.length > 0 ? (
                      <div className="space-y-3">
                        {slot.schedules.map((s: any) => (
                          <div
                            key={s.display_id ?? s.id}
                            className={cn(
                              "group relative rounded-lg bg-white p-3 shadow-sm",
                              slot.state === 'multi'
                                ? "border border-rose-200 ring-1 ring-rose-100"
                                : "border border-emerald-200 ring-1 ring-emerald-100"
                            )}
                          >
                            <button
                              onClick={() => handleDelete(s.id)}
                              className="absolute top-2 right-2 p-1 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <X size={14} />
                            </button>
                            <h5 className="pr-6 text-sm font-bold text-slate-800 mb-1 line-clamp-1">{s.course_name}</h5>
                            <p className="text-[10px] text-slate-500 font-medium mb-2">
                              {[s.section ? `Section ${s.section}` : '', s.course_code, s.faculty].filter(Boolean).join(' | ')}
                            </p>
                            <div className="flex items-center justify-between pt-2 border-t border-slate-50">
                              <span className="text-[10px] font-bold text-slate-400">
                                {[s.department_name, getYearDisplayLabel(s?.year_of_study, s?.semester)].filter(value => value && value !== '-').join(' • ')}
                              </span>
                              <div className="flex items-center gap-1 text-[10px] font-bold text-slate-600">
                                <Users size={10} />
                                {s.student_count}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : slot.state === 'exam' ? (
                      <div className="rounded-lg border border-amber-300 bg-amber-100 p-3">
                        <p className="text-[10px] font-bold text-amber-800 uppercase tracking-widest">Exam Override</p>
                        <p className="mt-1 text-xs text-amber-900/80">Normal classes are suppressed by the Academic Calendar for this period.</p>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-100 p-3">
                        <p className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Vacant Slot</p>
                        <p className="mt-1 text-xs text-slate-600">No class is mapped for this period.</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- DIGITAL TWIN MODULE ---

function Building3D({ building, metrics, onClick, isSelected, heatmapMode }: any) {
  const meshRef = useRef<THREE.Mesh>(null);
  const buildingHeight = Math.max((metrics?.floorCount || 1) * 0.5, 1);

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'default';
    };
  }, []);
  
  // Calculate building color based on heatmap or status
  const getBuildingColor = () => {
    if (heatmapMode) {
      const ratio = metrics?.utilizationRatio || 0;
      if (ratio > 0.7) return '#ef4444'; // Red - High
      if (ratio > 0.3) return '#f59e0b'; // Yellow - Medium
      return '#10b981'; // Green - Low
    }
    return isSelected ? '#10b981' : '#334155';
  };

  const hasAlert = !!metrics?.hasAlert;

  return (
    <group position={building.position || [0, 0, 0]}>
      <mesh 
        ref={meshRef} 
        onClick={(e) => { e.stopPropagation(); onClick(building); }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { document.body.style.cursor = 'default'; }}
      >
        <boxGeometry args={[2, buildingHeight, 2]} />
        <meshStandardMaterial 
          color={getBuildingColor()} 
          metalness={0.5} 
          roughness={0.2} 
          emissive={isSelected ? '#10b981' : '#000000'}
          emissiveIntensity={isSelected ? 0.5 : 0}
        />
      </mesh>
      
      {hasAlert && (
        <Float speed={5} rotationIntensity={0.5} floatIntensity={0.5}>
          <mesh position={[0, buildingHeight / 2 + 0.5, 0]}>
            <sphereGeometry args={[0.2, 16, 16]} />
            <meshStandardMaterial color="#ef4444" emissive="#ef4444" emissiveIntensity={2} />
          </mesh>
        </Float>
      )}

      <Text
        position={[0, buildingHeight / 2 + 0.8, 0]}
        fontSize={0.3}
        color="white"
        anchorX="center"
        anchorY="middle"
      >
        {building.name}
      </Text>

      {heatmapMode && (
        <Text
          position={[0, -buildingHeight / 2 - 0.35, 0]}
          fontSize={0.18}
          color="#cbd5e1"
          anchorX="center"
          anchorY="middle"
        >
          {`${metrics?.utilizationPercent || 0}% used`}
        </Text>
      )}
    </group>
  );
}

function DigitalTwin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [campuses, setCampuses] = useState<any[]>([]);
  const [buildings, setBuildings] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [floors, setFloors] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [maintenance, setMaintenance] = useState<any[]>([]);
  const [schedules, setSchedules] = useState<any[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [equipment, setEquipment] = useState<any[]>([]);
  const [allocations, setAllocations] = useState<any[]>([]);
  const [batchRoomAllocations, setBatchRoomAllocations] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [academicCalendars, setAcademicCalendars] = useState<any[]>([]);
  
  const [selectedBuilding, setSelectedBuilding] = useState<any>(null);
  const [selectedBlock, setSelectedBlock] = useState<any>(null);
  const [selectedFloor, setSelectedFloor] = useState<any>(null);
  
  const [viewMode, setViewMode] = useState<'2D' | '3D'>('2D');
  const [heatmapMode, setHeatmapMode] = useState(false);
  const [aiRecommendations, setAiRecommendations] = useState<any>(null);
  const [loadingAi, setLoadingAi] = useState(false);
  const [aiOptimizationError, setAiOptimizationError] = useState('');
  const [aiOptimizationSource, setAiOptimizationSource] = useState<'ai' | 'fallback' | ''>('');
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    roomType: '',
    minCapacity: ''
  });

  const open2DView = () => {
    setViewMode('2D');
  };

  const open3DView = () => {
    // Always enter 3D from campus scope to avoid UI lockups in deep hierarchy.
    setSelectedBuilding(null);
    setSelectedBlock(null);
    setSelectedFloor(null);
    setViewMode('3D');
  };

  useEffect(() => {
    const fetchData = async () => {
      const [cRes, bRes, blRes, fRes, rRes, mRes, sRes, bkRes, eRes, aRes, baRes, dRes, acRes] = await Promise.all([
        fetch('/api/campuses', { credentials: 'include' }),
        fetch('/api/buildings', { credentials: 'include' }),
        fetch('/api/blocks', { credentials: 'include' }),
        fetch('/api/floors', { credentials: 'include' }),
        fetch('/api/rooms', { credentials: 'include' }),
        fetch('/api/maintenance', { credentials: 'include' }),
        fetch('/api/schedules', { credentials: 'include' }),
        fetch('/api/bookings', { credentials: 'include' }),
        fetch('/api/equipment', { credentials: 'include' }),
        fetch('/api/department_allocations', { credentials: 'include' }),
        fetch('/api/batch_room_allocations', { credentials: 'include' }),
        fetch('/api/departments', { credentials: 'include' }),
        fetch('/api/academic_calendars', { credentials: 'include' }),
      ]);
      const [cData, bData, blData, fData, rData, mData, sData, bkData, eData, aData, baData, dData, acData] = await Promise.all([
        cRes.json(), bRes.json(), blRes.json(), fRes.json(), rRes.json(), mRes.json(), sRes.json(), bkRes.json(), eRes.json(), aRes.json(), baRes.json(), dRes.json(), acRes.json()
      ]);
      
      setCampuses(cData);
      setBlocks(blData);
      setFloors(fData);
      setBuildings(bData);
      setRooms(rData);
      setMaintenance(mData);
      setSchedules(sData);
      setBookings(bkData);
      setEquipment(eData);
      setAllocations(aData);
      setBatchRoomAllocations(Array.isArray(baData) ? baData : []);
      setDepartments(dData);
      setAcademicCalendars(Array.isArray(acData) ? acData : []);
    };
    fetchData();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const requestedView = params.get('view');
    const requestedStatus = params.get('status');

    if (requestedView === '3D' || requestedView === '2D') {
      if (requestedView === '3D') {
        setSelectedBuilding(null);
        setSelectedBlock(null);
        setSelectedFloor(null);
      }
      setViewMode(requestedView);
    }

    setFilters(current => ({
      ...current,
      status: requestedStatus || '',
    }));

    if (!params.get('buildingId')) {
      setSelectedBuilding(null);
      setSelectedBlock(null);
      setSelectedFloor(null);
    }
  }, [location.search]);

  const buildDigitalTwinOptimizationSummary = () => {
    const safeSchedules = Array.isArray(schedules) ? deduplicateScheduleRows(schedules) : [];
    const safeBookings = Array.isArray(bookings) ? bookings : [];
    const safeRooms = Array.isArray(rooms) ? rooms : [];
    const safeMaintenance = Array.isArray(maintenance) ? maintenance : [];
    const safeBuildings = Array.isArray(buildings) ? buildings : [];
    const safeBlocks = Array.isArray(blocks) ? blocks : [];
    const safeFloors = Array.isArray(floors) ? floors : [];

    const currentDayName = new Date(`${currentDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
    const scheduledNowRoomIds = new Set(
      safeSchedules
        .filter(item => item?.day_of_week === currentDayName && item?.start_time <= currentTime && item?.end_time > currentTime)
        .map(item => item?.room_id?.toString())
        .filter(Boolean)
    );
    const bookedNowRoomIds = new Set(
      safeBookings
        .filter(item => item?.status === 'Approved' && item?.date === currentDate && item?.start_time <= currentTime && item?.end_time > currentTime)
        .map(item => item?.room_id?.toString())
        .filter(Boolean)
    );
    const maintenanceRoomIds = new Set(
      safeMaintenance
        .filter(item => item?.status !== 'Completed' && item?.room_id !== undefined && item?.room_id !== null)
        .map(item => item.room_id.toString())
    );

    const activeRoomIds = new Set<string>([...scheduledNowRoomIds, ...bookedNowRoomIds]);
    const availableNow = Math.max(0, safeRooms.length - activeRoomIds.size - maintenanceRoomIds.size);

    const buildingStats = safeBuildings.map((building: any) => {
      const buildingBlockIds = safeBlocks.filter((block: any) => idsMatch(block?.building_id, building?.id)).map((block: any) => block.id);
      const buildingFloorIds = safeFloors.filter((floor: any) => buildingBlockIds.some((blockId: any) => idsMatch(blockId, floor?.block_id))).map((floor: any) => floor.id);
      const buildingRooms = safeRooms.filter((room: any) => buildingFloorIds.some((floorId: any) => idsMatch(floorId, room?.floor_id)));
      const buildingRoomIds = new Set(buildingRooms.map((room: any) => room?.id?.toString()).filter(Boolean));

      const usedHours = safeSchedules
        .filter((schedule: any) => buildingRoomIds.has(schedule?.room_id?.toString()))
        .reduce((acc: number, schedule: any) => {
          const [sh, sm] = (schedule?.start_time || '00:00').split(':').map(Number);
          const [eh, em] = (schedule?.end_time || '00:00').split(':').map(Number);
          if ([sh, sm, eh, em].some(value => Number.isNaN(value))) return acc;
          const duration = Math.max(0, (eh + em / 60) - (sh + sm / 60));
          return acc + duration;
        }, 0);
      const denominator = Math.max(buildingRooms.length * 72, 1);
      const utilizationPercent = Math.min(100, Math.round((usedHours / denominator) * 100));

      return {
        name: building?.name || 'Unknown Building',
        roomCount: buildingRooms.length,
        utilizationPercent,
      };
    }).sort((a: any, b: any) => b.utilizationPercent - a.utilizationPercent);

    const roomTypeMix = Array.from(
      safeRooms.reduce((acc: Map<string, number>, room: any) => {
        const key = room?.room_type?.toString()?.trim() || 'Unknown';
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
      }, new Map<string, number>())
    ).map(([roomType, count]) => ({ roomType, count }));

    return {
      timestamp: new Date().toISOString(),
      scope: {
        selectedBuilding: selectedBuilding?.name || null,
        selectedBlock: selectedBlock?.name || null,
        selectedFloor: selectedFloor ? getFloorName(selectedFloor.floor_number) : null,
      },
      totals: {
        campuses: campuses.length,
        buildings: safeBuildings.length,
        blocks: safeBlocks.length,
        floors: safeFloors.length,
        rooms: safeRooms.length,
      },
      live: {
        scheduledNow: scheduledNowRoomIds.size,
        bookedNow: bookedNowRoomIds.size,
        maintenanceRooms: maintenanceRoomIds.size,
        availableNow,
      },
      topBuildings: buildingStats.slice(0, 5),
      roomTypeMix,
      pendingBookings: safeBookings.filter(item => item?.status === 'Pending').length,
      openMaintenanceTickets: safeMaintenance.filter(item => item?.status !== 'Completed').length,
    };
  };

  const runAiOptimization = async () => {
    setLoadingAi(true);
    setAiOptimizationError('');
    try {
      const summary = buildDigitalTwinOptimizationSummary();
      const response = await fetch('/api/ai/digital-twin-optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ summary }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || 'AI optimization failed.');
      }
      if (!Array.isArray(result?.recommendations) || !result?.futureForecast) {
        throw new Error('AI optimization response format is invalid.');
      }
      setAiRecommendations({
        recommendations: result.recommendations,
        futureForecast: result.futureForecast,
        efficiencyScore: Number(result.efficiencyScore) || 0,
        simulationImpact: result.simulationImpact || '',
      });
      setAiOptimizationSource(result?.source === 'fallback' ? 'fallback' : 'ai');
    } catch (err) {
      console.error(err);
      setAiOptimizationError('AI optimization is temporarily unavailable. Please try again in a moment.');
    } finally {
      setLoadingAi(false);
    }
  };

  const toKey = (value: any) =>
    value === undefined || value === null ? '' : value.toString();

  const currentDate = formatLocalDate(new Date());
  const currentTime = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`;
  const currentDayName = new Date(`${currentDate}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  const scheduleDaysOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const roomTypes = useMemo(
    () => Array.from(new Set(rooms.map(room => room.room_type).filter(Boolean))).sort(),
    [rooms],
  );

  const departmentsById = useMemo(
    () => new Map(departments.map((department: any) => [toKey(department?.id), department])),
    [departments],
  );
  const buildingById = useMemo(
    () => new Map(buildings.map((building: any) => [toKey(building?.id), building])),
    [buildings],
  );
  const blockById = useMemo(
    () => new Map(blocks.map((block: any) => [toKey(block?.id), block])),
    [blocks],
  );
  const floorById = useMemo(
    () => new Map(floors.map((floor: any) => [toKey(floor?.id), floor])),
    [floors],
  );

  const blocksByBuildingId = useMemo(() => {
    const map = new Map<string, any[]>();
    blocks.forEach((block: any) => {
      const key = toKey(block?.building_id);
      if (!key) return;
      const next = map.get(key) || [];
      next.push(block);
      map.set(key, next);
    });
    return map;
  }, [blocks]);

  const floorsByBlockId = useMemo(() => {
    const map = new Map<string, any[]>();
    floors.forEach((floor: any) => {
      const key = toKey(floor?.block_id);
      if (!key) return;
      const next = map.get(key) || [];
      next.push(floor);
      map.set(key, next);
    });
    return map;
  }, [floors]);

  const roomsByFloorId = useMemo(() => {
    const map = new Map<string, any[]>();
    rooms.forEach((room: any) => {
      const key = toKey(room?.floor_id);
      if (!key) return;
      const next = map.get(key) || [];
      next.push(room);
      map.set(key, next);
    });
    return map;
  }, [rooms]);

  const roomsByBuildingId = useMemo(() => {
    const map = new Map<string, any[]>();
    buildings.forEach((building: any) => {
      const buildingKey = toKey(building?.id);
      if (!buildingKey) return;
      const buildingBlocks = blocksByBuildingId.get(buildingKey) || [];
      const buildingRooms = buildingBlocks.flatMap((block: any) =>
        (floorsByBlockId.get(toKey(block?.id)) || []).flatMap((floor: any) => roomsByFloorId.get(toKey(floor?.id)) || []),
      );
      map.set(buildingKey, buildingRooms);
    });
    return map;
  }, [buildings, blocksByBuildingId, floorsByBlockId, roomsByFloorId]);

  const dedupedSchedules = useMemo(
    () => deduplicateScheduleRows(schedules),
    [schedules],
  );

  const roomSchedulesByRoomId = useMemo(() => {
    const map = new Map<string, any[]>();
    dedupedSchedules.forEach((schedule: any) => {
      const roomKey = toKey(schedule?.room_id);
      if (!roomKey) return;
      const next = map.get(roomKey) || [];
      next.push({
        ...schedule,
        department_name: departmentsById.get(toKey(schedule?.department_id))?.name || '',
      });
      map.set(roomKey, next);
    });
    map.forEach((items) => {
      items.sort((a: any, b: any) => {
        const dayCompare = scheduleDaysOrder.indexOf(a.day_of_week) - scheduleDaysOrder.indexOf(b.day_of_week);
        if (dayCompare !== 0) return dayCompare;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
    });
    return map;
  }, [dedupedSchedules, departmentsById]);

  const approvedBookingsByRoomId = useMemo(() => {
    const map = new Map<string, any[]>();
    bookings.forEach((booking: any) => {
      if (booking?.status !== 'Approved') return;
      const roomKey = toKey(booking?.room_id);
      if (!roomKey) return;
      const next = map.get(roomKey) || [];
      next.push(booking);
      map.set(roomKey, next);
    });
    return map;
  }, [bookings]);

  const activeMaintenanceByRoomId = useMemo(() => {
    const map = new Map<string, any[]>();
    maintenance.forEach((item: any) => {
      if (item?.status === 'Completed') return;
      const roomKey = toKey(item?.room_id);
      if (!roomKey) return;
      const next = map.get(roomKey) || [];
      next.push(item);
      map.set(roomKey, next);
    });
    return map;
  }, [maintenance]);

  const equipmentLabelsByRoomId = useMemo(() => {
    const map = new Map<string, string[]>();
    equipment.forEach((item: any) => {
      const roomKey = toKey(item?.room_id);
      const label = item?.name?.toString?.().trim();
      if (!roomKey || !label) return;
      const next = map.get(roomKey) || [];
      next.push(label);
      map.set(roomKey, next);
    });
    return map;
  }, [equipment]);

  const roomDepartmentLabelByRoomId = useMemo(() => {
    const namesByRoom = new Map<string, Set<string>>();
    allocations
      .filter(item => getRangeLifecycleStatus(item.start_date, item.end_date, 'Released', 'Planned') !== 'Released')
      .forEach((item: any) => {
        const roomKey = toKey(item?.room_id);
        if (!roomKey) return;
        const departmentName = departmentsById.get(toKey(item?.department_id))?.name;
        if (!departmentName) return;
        if (!namesByRoom.has(roomKey)) namesByRoom.set(roomKey, new Set<string>());
        namesByRoom.get(roomKey)!.add(departmentName);
      });

    const labels = new Map<string, string>();
    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      const names = Array.from(namesByRoom.get(roomKey) || []);
      if (names.length === 0) {
        labels.set(roomKey, 'Unmapped');
      } else if (names.length === 1) {
        labels.set(roomKey, names[0]);
      } else {
        labels.set(roomKey, `Shared: ${names.join(', ')}`);
      }
    });
    return labels;
  }, [allocations, departmentsById, rooms]);

  const calculateUsageHours = (start?: string, end?: string) => {
    if (!start || !end) return 0;
    const [startHour, startMinute] = start.split(':').map(Number);
    const [endHour, endMinute] = end.split(':').map(Number);
    if ([startHour, startMinute, endHour, endMinute].some(value => Number.isNaN(value))) return 0;
    return Math.max(0, (endHour + endMinute / 60) - (startHour + startMinute / 60));
  };

  const roomUsageMetricsByRoomId = useMemo(() => {
    const map = new Map<string, { scheduledHours: number; bookedHours: number; totalUsedHours: number; utilizationPercent: number }>();
    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      const roomSchedules = roomSchedulesByRoomId.get(roomKey) || [];
      const roomBookings = approvedBookingsByRoomId.get(roomKey) || [];
      const scheduledHours = roomSchedules.reduce((acc: number, schedule: any) => acc + calculateUsageHours(schedule.start_time, schedule.end_time), 0);
      const bookedHours = roomBookings.reduce((acc: number, booking: any) => acc + calculateUsageHours(booking.start_time, booking.end_time), 0);
      const totalUsedHours = scheduledHours + bookedHours;
      map.set(roomKey, {
        scheduledHours: Math.round(scheduledHours * 10) / 10,
        bookedHours: Math.round(bookedHours * 10) / 10,
        totalUsedHours: Math.round(totalUsedHours * 10) / 10,
        utilizationPercent: Math.min(100, Math.round((totalUsedHours / 72) * 100)),
      });
    });
    return map;
  }, [rooms, roomSchedulesByRoomId, approvedBookingsByRoomId]);

  const effectiveTodaySchedulesByRoomId = useMemo(() => {
    const map = new Map<string, any[]>();
    roomSchedulesByRoomId.forEach((roomSchedules, roomKey) => {
      const scoped = roomSchedules
        .filter(schedule => schedule.day_of_week === currentDayName)
        .filter(schedule => !isScheduleSuppressedForDate(schedule, currentDate, academicCalendars, batchRoomAllocations));
      map.set(roomKey, scoped);
    });
    return map;
  }, [roomSchedulesByRoomId, currentDayName, currentDate, academicCalendars, batchRoomAllocations]);

  const roomCurrentScheduleByRoomId = useMemo(() => {
    const map = new Map<string, any | null>();
    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      const current = (effectiveTodaySchedulesByRoomId.get(roomKey) || [])
        .find((schedule: any) => schedule.start_time <= currentTime && schedule.end_time > currentTime) || null;
      map.set(roomKey, current);
    });
    return map;
  }, [rooms, effectiveTodaySchedulesByRoomId, currentTime]);

  const roomNextScheduleByRoomId = useMemo(() => {
    const map = new Map<string, any | null>();
    const dateEntries = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(`${currentDate}T00:00:00`);
      date.setDate(date.getDate() + offset);
      const dateKey = formatLocalDate(date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
      return { offset, dateKey, dayName };
    });

    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      const roomSchedules = roomSchedulesByRoomId.get(roomKey) || [];
      let next: any = null;
      for (const { offset, dateKey, dayName } of dateEntries) {
        const dateSchedules = roomSchedules
          .filter(schedule => schedule.day_of_week === dayName)
          .filter(schedule => !isScheduleSuppressedForDate(schedule, dateKey, academicCalendars, batchRoomAllocations));
        const upcoming = offset === 0
          ? dateSchedules.filter(schedule => schedule.start_time > currentTime)
          : dateSchedules;
        if (upcoming.length > 0) {
          next = { ...upcoming[0], effective_date: dateKey };
          break;
        }
      }
      map.set(roomKey, next);
    });
    return map;
  }, [rooms, roomSchedulesByRoomId, currentDate, currentTime, academicCalendars, batchRoomAllocations]);

  const roomLiveStatusByRoomId = useMemo(() => {
    const nowBookedRoomIds = new Set(
      bookings
        .filter((booking: any) =>
          booking?.status === 'Approved' &&
          booking?.date === currentDate &&
          booking?.start_time <= currentTime &&
          booking?.end_time > currentTime,
        )
        .map((booking: any) => toKey(booking?.room_id))
        .filter(Boolean),
    );

    const map = new Map<string, string>();
    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      if ((activeMaintenanceByRoomId.get(roomKey)?.length || 0) > 0 || room?.status === 'Maintenance') {
        map.set(roomKey, 'Maintenance');
      } else if (nowBookedRoomIds.has(roomKey)) {
        map.set(roomKey, 'Booked');
      } else if (roomCurrentScheduleByRoomId.get(roomKey)) {
        map.set(roomKey, 'Scheduled');
      } else {
        map.set(roomKey, room?.status || 'Available');
      }
    });
    return map;
  }, [rooms, bookings, currentDate, currentTime, activeMaintenanceByRoomId, roomCurrentScheduleByRoomId]);

  const roomSearchTextByRoomId = useMemo(() => {
    const map = new Map<string, string>();
    rooms.forEach((room: any) => {
      const roomKey = toKey(room?.id);
      const floor = floorById.get(toKey(room?.floor_id));
      const block = blockById.get(toKey(floor?.block_id));
      const building = buildingById.get(toKey(block?.building_id));
      const roomSchedules = roomSchedulesByRoomId.get(roomKey) || [];
      const searchText = [
        room?.room_number,
        room?.room_aliases,
        room?.room_type,
        roomLiveStatusByRoomId.get(roomKey),
        roomDepartmentLabelByRoomId.get(roomKey),
        ...roomSchedules.flatMap((schedule: any) => [
          schedule.course_name,
          schedule.course_code,
          schedule.faculty,
          schedule.department_name,
          schedule.semester,
          schedule.section,
          schedule.day_of_week,
        ]),
        building?.name,
        block?.name,
        floor ? getFloorName(floor.floor_number) : '',
      ]
        .map(normalizeLookupValue)
        .join(' ');
      map.set(roomKey, searchText);
    });
    return map;
  }, [rooms, floorById, blockById, buildingById, roomSchedulesByRoomId, roomLiveStatusByRoomId, roomDepartmentLabelByRoomId]);

  const getBlocksForBuilding = (buildingId: number) =>
    blocksByBuildingId.get(toKey(buildingId)) || [];

  const getVisibleBlocksForBuilding = (building: any) =>
    getBlocksForBuilding(building.id).filter(block => !isImplicitBuildingBlock(block, building));

  const getDirectBlockForBuilding = (building: any) =>
    getBlocksForBuilding(building.id).find(block => isImplicitBuildingBlock(block, building));

  const getFloorsForBlock = (blockId: number) =>
    floorsByBlockId.get(toKey(blockId)) || [];

  const getRoomsForBuilding = (building: any) =>
    roomsByBuildingId.get(toKey(building?.id)) || [];

  const getRoomMaintenance = (room: any) =>
    activeMaintenanceByRoomId.get(toKey(room?.id)) || [];

  const getRoomEquipmentLabels = (room: any) =>
    equipmentLabelsByRoomId.get(toKey(room?.id)) || [];

  const getRoomDepartmentLabel = (room: any) =>
    roomDepartmentLabelByRoomId.get(toKey(room?.id)) || 'Unmapped';

  const getRoomSchedules = (room: any) =>
    roomSchedulesByRoomId.get(toKey(room?.id)) || [];

  const getApprovedRoomBookings = (room: any) =>
    approvedBookingsByRoomId.get(toKey(room?.id)) || [];

  const getRoomUsageMetrics = (room: any) => {
    return roomUsageMetricsByRoomId.get(toKey(room?.id)) || {
      scheduledHours: 0,
      bookedHours: 0,
      totalUsedHours: 0,
      utilizationPercent: 0,
    };
  };

  const getEffectiveRoomSchedulesForDate = (room: any, date: string) =>
    getRoomSchedules(room)
      .filter(schedule => schedule.day_of_week === new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' }))
      .filter(schedule => !isScheduleSuppressedForDate(schedule, date, academicCalendars, batchRoomAllocations));

  const getCurrentSchedule = (room: any) =>
    roomCurrentScheduleByRoomId.get(toKey(room?.id)) || null;

  const getNextSchedule = (room: any) =>
    roomNextScheduleByRoomId.get(toKey(room?.id)) || null;

  const getRoomLiveStatus = (room: any) => {
    return roomLiveStatusByRoomId.get(toKey(room?.id)) || room?.status || 'Available';
  };

  const hasRoomScheduledToday = (room: any) =>
    (effectiveTodaySchedulesByRoomId.get(toKey(room?.id)) || []).length > 0;

  const roomMatchesFilters = (room: any) => {
    if (!room) return false;
    const query = normalizeLookupValue(filters.search);
    const haystack = roomSearchTextByRoomId.get(toKey(room?.id)) || '';

    if (query && !haystack.includes(query)) return false;
    if (filters.status) {
      if (filters.status === 'ScheduledToday') {
        if (!hasRoomScheduledToday(room)) return false;
      } else if (getRoomLiveStatus(room) !== filters.status) {
        return false;
      }
    }
    if (filters.roomType && room.room_type !== filters.roomType) return false;
    if (filters.minCapacity && (parseInt(room.capacity, 10) || 0) < (parseInt(filters.minCapacity, 10) || 0)) return false;
    return true;
  };

  const matchingRoomIds = useMemo(() => {
    const set = new Set<string>();
    rooms.forEach((room: any) => {
      if (roomMatchesFilters(room)) set.add(toKey(room?.id));
    });
    return set;
  }, [rooms, filters, roomSearchTextByRoomId, roomLiveStatusByRoomId]);

  const roomPassesFilters = (room: any) => matchingRoomIds.has(toKey(room?.id));

  const filteredBuildings = buildings.filter(building => {
    const query = normalizeLookupValue(filters.search);
    const buildingRooms = getRoomsForBuilding(building).filter(roomPassesFilters);
    return buildingRooms.length > 0 || (!query && !filters.status && !filters.roomType && !filters.minCapacity);
  });

  const getBuildingUtilization = (building: any) => {
    const buildingRooms = getRoomsForBuilding(building);
    if (buildingRooms.length === 0) return 0;
    return Math.round(
      buildingRooms.reduce((acc, room) => acc + getRoomUsageMetrics(room).utilizationPercent, 0) / (buildingRooms.length || 1)
    );
  };

  const getBuilding3DMetrics = (building: any) => {
    const buildingBlocks = getBlocksForBuilding(building.id);
    const buildingFloors = floors.filter(floor => buildingBlocks.some(block => idsMatch(block.id, floor.block_id)));
    const buildingRooms = getRoomsForBuilding(building);
    const visibleRooms = buildingRooms.filter(roomPassesFilters);
    const usageRooms = visibleRooms.length > 0 ? visibleRooms : buildingRooms;
    const activeRooms = usageRooms.filter(room => getRoomUsageMetrics(room).totalUsedHours > 0).length;
    const maintenanceCount = visibleRooms.filter(room => getRoomMaintenance(room).length > 0 || room.status === 'Maintenance').length;
    const roomCount = usageRooms.length;
    const utilizationPercent = roomCount > 0
      ? Math.round(usageRooms.reduce((acc, room) => acc + getRoomUsageMetrics(room).utilizationPercent, 0) / roomCount)
      : 0;
    const utilizationRatio = utilizationPercent / 100;

    return {
      floorCount: Math.max(buildingFloors.length, Number(building.planned_floor_count) || 0, 1),
      roomCount,
      activeRooms,
      maintenanceCount,
      utilizationRatio,
      utilizationPercent,
      hasAlert: maintenanceCount > 0,
    };
  };

  const getHeatmapCardClass = (building: any) => {
    if (!heatmapMode) return '';
    const ratio = getBuilding3DMetrics(building).utilizationRatio;
    if (ratio > 0.7) return 'border-rose-500/70 bg-rose-500/10';
    if (ratio > 0.3) return 'border-amber-500/70 bg-amber-500/10';
    return 'border-emerald-500/70 bg-emerald-500/10';
  };

  const selectedBuildingVisibleBlocks = selectedBuilding ? getVisibleBlocksForBuilding(selectedBuilding) : [];
  const selectedBuildingDirectBlock = selectedBuilding ? getDirectBlockForBuilding(selectedBuilding) : null;
  const selectedBuildingBlockOptions =
    selectedBuilding && selectedBuildingDirectBlock && selectedBuildingVisibleBlocks.length > 0 && getFloorsForBlock(selectedBuildingDirectBlock.id).length > 0
      ? [selectedBuildingDirectBlock, ...selectedBuildingVisibleBlocks]
      : selectedBuildingVisibleBlocks;
  const shouldShowBlockLevel = selectedBuildingBlockOptions.length > 0;
  const activeBlock = selectedBlock || (!shouldShowBlockLevel ? selectedBuildingDirectBlock : null);
  const scopeBuildings = selectedBuilding ? [selectedBuilding] : filteredBuildings;
  const scopeBlocks = selectedFloor
    ? (activeBlock ? [activeBlock] : [])
    : activeBlock
      ? [activeBlock]
      : selectedBuilding
        ? selectedBuildingBlockOptions
        : scopeBuildings.flatMap(building => getBlocksForBuilding(building.id));
  const scopeFloors = selectedFloor
    ? [selectedFloor]
    : activeBlock
      ? floors.filter(floor => idsMatch(floor.block_id, activeBlock.id))
      : selectedBuilding
        ? floors.filter(floor => getBlocksForBuilding(selectedBuilding.id).some(block => idsMatch(block.id, floor.block_id)))
        : floors.filter(floor => scopeBlocks.some(block => idsMatch(block.id, floor.block_id)));
  const scopeRooms = selectedFloor
    ? rooms.filter(room => idsMatch(room.floor_id, selectedFloor.id) && roomPassesFilters(room))
    : activeBlock
      ? rooms.filter(room =>
          scopeFloors.some(floor => idsMatch(floor.id, room.floor_id)) &&
          roomPassesFilters(room)
        )
      : selectedBuilding
        ? getRoomsForBuilding(selectedBuilding).filter(roomPassesFilters)
        : rooms.filter(roomPassesFilters);
  const scopeSchedules = dedupedSchedules.filter(schedule =>
    scopeRooms.some(room => idsMatch(room.id, schedule.room_id))
  );
  const scopeUtilizationRaw = scopeRooms.reduce((acc, room) => acc + getRoomUsageMetrics(room).utilizationPercent, 0) / (scopeRooms.length || 1);
  const scopeUtilizationDisplay =
    scopeRooms.some(room => getRoomUsageMetrics(room).totalUsedHours > 0) && scopeUtilizationRaw > 0 && scopeUtilizationRaw < 1
      ? '<1%'
      : `${Math.round(scopeUtilizationRaw)}%`;
  const scopeRoomMix = getRoomMixCounts(scopeRooms);
  const stats = {
    totalRooms: scopeRooms.length,
    availableRooms: scopeRooms.filter(r => getRoomLiveStatus(r) === 'Available').length,
    maintenanceRooms: scopeRooms.filter(r => getRoomLiveStatus(r) === 'Maintenance').length,
    utilization: scopeUtilizationDisplay,
    totalBuildings: scopeBuildings.length,
    totalBlocks: scopeBlocks.length,
    totalSchedules: scopeSchedules.length,
  };
  const twinStatCards = [
    { label: 'Total Rooms', value: stats.totalRooms, detail: formatRoomMixSummary(scopeRoomMix), icon: DoorOpen, iconBg: 'bg-emerald-50', iconClass: 'text-emerald-500', path: '/rooms' },
    { label: 'Utilization', value: stats.utilization, icon: Activity, iconBg: 'bg-blue-50', iconClass: 'text-blue-500', path: '/reports' },
    { label: 'Maintenance', value: stats.maintenanceRooms, icon: Wrench, iconBg: 'bg-amber-50', iconClass: 'text-amber-500', path: '/maintenance' },
    { label: 'Buildings', value: stats.totalBuildings, icon: Building2, iconBg: 'bg-indigo-50', iconClass: 'text-indigo-500', path: '/buildings' },
    { label: 'Timetable Rows', value: stats.totalSchedules, icon: Calendar, iconBg: 'bg-cyan-50', iconClass: 'text-cyan-500', path: '/scheduling' },
  ];
  const getRoomContextCount = (room: any) => new Set(
    getRoomSchedules(room).map(schedule => getScheduleAcademicContextKey(schedule)),
  ).size;

  const getRoomLinkContextSchedule = (room: any) => getCurrentSchedule(room) || getNextSchedule(room) || getRoomSchedules(room)[0] || null;

  const getRoomDeepLinkSearch = (room: any, schedule?: any) => {
    const params = new URLSearchParams();
    if (room?.id !== undefined && room?.id !== null) params.set('roomId', room.id.toString());
    params.set('room', getRoomDisplayLabel(room, rooms));
    if (schedule?.department_id !== undefined && schedule?.department_id !== null) params.set('departmentId', schedule.department_id.toString());
    const normalizedSemester = normalizeExactSemesterValue(schedule?.semester, schedule?.year_of_study, '');
    if (normalizedSemester) params.set('semester', normalizedSemester);
    if (schedule?.section) params.set('section', schedule.section.toString());
    return `?${params.toString()}`;
  };

  const isCampus3DOverview = viewMode === '3D' && !selectedBuilding;

  return (
    <div className="space-y-8">
      {/* Digital Twin Header Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-6">
        {twinStatCards.map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => navigate(card.path)}
            className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm flex items-center gap-4 text-left hover:shadow-md hover:-translate-y-0.5 transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
            aria-label={`Open ${card.label}`}
          >
            <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center", card.iconBg, card.iconClass)}>
              <card.icon size={24} />
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{card.label}</p>
              <p className="text-xl font-bold text-slate-800">{card.value}</p>
              {card.detail && (
                <p className="text-[11px] text-slate-400 font-semibold mt-1">{card.detail}</p>
              )}
            </div>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200">
            <button 
              onClick={open2DView}
              className={cn(
                "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                viewMode === '2D' ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              2D View
            </button>
            <button 
              onClick={open3DView}
              className={cn(
                "px-4 py-2 rounded-lg text-xs font-bold transition-all",
                viewMode === '3D' ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              3D View
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
          <button 
            onClick={() => { setSelectedBuilding(null); setSelectedBlock(null); setSelectedFloor(null); }}
            className="hover:text-emerald-500 transition-colors"
          >
            Campus
          </button>
          {selectedBuilding && (
            <>
              <ChevronRight size={16} />
              <button 
                onClick={() => { setSelectedBlock(null); setSelectedFloor(null); }}
                className="hover:text-emerald-500 transition-colors"
              >
                {selectedBuilding.name}
              </button>
            </>
          )}
          {selectedBlock && (
            <>
              <ChevronRight size={16} />
              <button 
                onClick={() => { setSelectedFloor(null); }}
                className="hover:text-emerald-500 transition-colors"
              >
                {selectedBlock.name}
              </button>
            </>
          )}
          {selectedFloor && (
            <>
              <ChevronRight size={16} />
              <span className="text-slate-800">{getFloorName(selectedFloor.floor_number)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex gap-2">
          <button 
            onClick={() => setHeatmapMode(!heatmapMode)}
            className={cn("px-4 py-2 rounded-xl text-xs font-bold transition-all", heatmapMode ? "bg-emerald-500 text-white" : "bg-white text-slate-600 border border-slate-200")}
          >
            Heatmap {heatmapMode ? 'ON' : 'OFF'}
          </button>
          <button 
            onClick={runAiOptimization}
            disabled={loadingAi}
            className="bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-slate-800 transition-all flex items-center gap-2"
          >
            <BrainCircuit size={14} />
            {loadingAi ? 'Analyzing...' : 'AI Optimization'}
          </button>
        </div>
      </div>
      {aiOptimizationError && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          {aiOptimizationError}
        </div>
      )}
      {aiOptimizationSource === 'fallback' && !aiOptimizationError && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
          AI service is busy. Showing safe fallback optimization based on live campus data.
        </div>
      )}

      {heatmapMode && !selectedBuilding && (
        <div className="flex flex-wrap items-center gap-3 px-1">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Heatmap</span>
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            Low
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
            Medium
          </span>
          <span className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
            High
          </span>
        </div>
      )}

      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            value={filters.search}
            onChange={e => setFilters({ ...filters, search: e.target.value })}
            placeholder="Search room, building, department..."
            className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
          />
        </div>
        <select
          value={filters.status}
          onChange={e => setFilters({ ...filters, status: e.target.value })}
          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
        >
          <option value="">All statuses</option>
          <option value="ScheduledToday">Scheduled Today</option>
          <option value="Available">Available</option>
          <option value="Scheduled">Scheduled</option>
          <option value="Booked">Booked</option>
          <option value="Maintenance">Maintenance</option>
        </select>
        <select
          value={filters.roomType}
          onChange={e => setFilters({ ...filters, roomType: e.target.value })}
          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
        >
          <option value="">All room types</option>
          {roomTypes.map(type => <option key={type} value={type}>{type}</option>)}
        </select>
        <input
          type="number"
          value={filters.minCapacity}
          onChange={e => setFilters({ ...filters, minCapacity: e.target.value })}
          placeholder="Minimum capacity"
          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-emerald-500"
        />
      </div>

      <div className="bg-slate-900 rounded-[40px] min-h-[600px] relative overflow-hidden border border-slate-800 shadow-2xl">
        {/* Digital Twin Background Grid */}
        <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ 
          backgroundImage: 'radial-gradient(#10b981 1px, transparent 1px)', 
          backgroundSize: '40px 40px' 
        }} />
        
        {isCampus3DOverview && (
          <div className="absolute inset-0 z-0">
            <Canvas shadows camera={{ position: [10, 10, 10], fov: 45 }}>
              <PerspectiveCamera makeDefault position={[15, 15, 15]} />
              <OrbitControls enablePan={true} enableZoom={true} maxPolarAngle={Math.PI / 2.1} />
              <Environment preset="city" />
              <ambientLight intensity={0.5} />
              <pointLight position={[10, 10, 10]} intensity={1} castShadow />
              <ContactShadows position={[0, 0, 0]} opacity={0.4} scale={20} blur={2} far={4.5} />
              
              <group>
                {filteredBuildings.map((b, i) => (
                  <Building3D 
                    key={b.id} 
                    building={{...b, position: [((i % 3) - 1) * 8, 0, (Math.floor(i / 3) - 1) * 8]}} 
                    metrics={getBuilding3DMetrics(b)}
                    onClick={(building: any) => { setSelectedBuilding(building); setViewMode('2D'); }}
                    isSelected={idsMatch(selectedBuilding?.id, b.id)}
                    heatmapMode={heatmapMode}
                  />
                ))}
              </group>
              
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
                <planeGeometry args={[100, 100]} />
                <meshStandardMaterial color="#0f172a" />
              </mesh>
              <gridHelper args={[100, 50, '#1e293b', '#1e293b']} position={[0, 0, 0]} />
            </Canvas>
          </div>
        )}

        {!isCampus3DOverview && (
          <div className="p-12 relative z-10">
            {(() => {
              if (!selectedBuilding) {
                return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {filteredBuildings.map(b => {
              const visibleBlocks = getVisibleBlocksForBuilding(b);
              const buildingRooms = getRoomsForBuilding(b);
              const visibleRooms = buildingRooms.filter(roomPassesFilters);
              const buildingScheduleCount = buildingRooms.reduce((count, room) => count + getRoomSchedules(room).length, 0);
              const utilization = getBuildingUtilization(b);

              return (
                <div 
                  key={b.id} 
                  onClick={() => setSelectedBuilding(b)}
                  className={cn(
                    "group cursor-pointer bg-slate-800/40 border border-slate-700/50 p-8 rounded-[40px] hover:bg-slate-800 hover:border-emerald-500 transition-all transform hover:-translate-y-2 backdrop-blur-sm",
                    getHeatmapCardClass(b)
                  )}
                >
                  <div className="w-full aspect-video bg-slate-700/50 rounded-3xl mb-8 flex items-center justify-center relative overflow-hidden border border-slate-600/30">
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <Building2 size={64} className="text-slate-500 group-hover:text-emerald-500 transition-all group-hover:scale-110" />
                  </div>
                  <h4 className="text-2xl font-bold text-white mb-3">{b.name}</h4>
                  <p className="text-sm text-slate-400 mb-6 leading-relaxed">{b.description}</p>
                  <div className="flex items-center justify-between pt-6 border-t border-slate-700/50">
                    <div className="flex gap-4">
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Blocks</span>
                        <span className="text-sm font-bold text-white">{visibleBlocks.length || 'Direct'}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Rooms</span>
                        <span className="text-sm font-bold text-white">{visibleRooms.length}/{buildingRooms.length}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Utilization</span>
                        <span className="text-sm font-bold text-white">{utilization}%</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Classes</span>
                        <span className="text-sm font-bold text-white">{buildingScheduleCount}</span>
                      </div>
                    </div>
                    <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center text-slate-500 group-hover:text-emerald-500 group-hover:bg-emerald-500/10 transition-all">
                      <ChevronRight size={20} />
                    </div>
                  </div>
                </div>
              );
            })}
            {filteredBuildings.length === 0 && (
              <div className="md:col-span-3 p-12 text-center border-2 border-dashed border-slate-700 rounded-3xl">
                <p className="text-sm font-bold text-slate-400">No buildings match the current Digital Twin filters.</p>
              </div>
            )}
          </div>
                );
              }
              if (shouldShowBlockLevel && !selectedBlock) {
                return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative z-10">
            {selectedBuildingBlockOptions
              .filter(block => floors.some(floor => idsMatch(floor.block_id, block.id) && rooms.some(room => idsMatch(room.floor_id, floor.id) && roomPassesFilters(room))))
              .map(bl => (
              <div 
                key={bl.id} 
                onClick={() => setSelectedBlock(bl)}
                className="group cursor-pointer bg-slate-800/50 border border-slate-700 p-8 rounded-3xl hover:bg-slate-800 hover:border-emerald-500 transition-all"
              >
                <div className="w-full h-48 bg-slate-700 rounded-2xl mb-6 flex items-center justify-center">
                  <LayoutGrid size={48} className="text-slate-500 group-hover:text-emerald-500" />
                </div>
                <h4 className="text-xl font-bold text-white mb-2">{getBlockDisplayLabel(bl, selectedBuilding)}</h4>
                <p className="text-sm text-slate-400">{bl.description}</p>
                <p className="text-xs text-slate-500 mt-3 font-bold">{floors.filter(floor => idsMatch(floor.block_id, bl.id)).reduce((count, floor) => count + rooms.filter(room => idsMatch(room.floor_id, floor.id) && roomPassesFilters(room)).length, 0)} matching rooms</p>
              </div>
            ))}
          </div>
                );
              }
              if (!selectedFloor) {
                return (
          <div className="space-y-4 relative z-10 max-w-2xl mx-auto">
            {floors.filter(f => idsMatch(f.block_id, activeBlock?.id) && rooms.some(room => idsMatch(room.floor_id, f.id) && roomPassesFilters(room))).sort((a,b) => a.floor_number - b.floor_number).map(f => (
              <div 
                key={f.id} 
                onClick={() => setSelectedFloor(f)}
                className="group cursor-pointer bg-slate-800/50 border border-slate-700 p-6 rounded-2xl hover:bg-slate-800 hover:border-emerald-500 transition-all flex items-center justify-between"
              >
                <div className="flex items-center gap-6">
                  <div className="w-16 h-16 bg-slate-700 rounded-2xl flex items-center justify-center font-bold text-2xl text-white group-hover:bg-emerald-500/20 group-hover:text-emerald-500 transition-all">
                    {getFloorShortName(f.floor_number)}
                  </div>
                  <div>
                    <h4 className="text-lg font-bold text-white">{getFloorName(f.floor_number)}</h4>
                    <p className="text-sm text-slate-400">{f.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Rooms</p>
                    <p className="text-sm font-bold text-white">{rooms.filter(r => idsMatch(r.floor_id, f.id) && roomPassesFilters(r)).length}/{rooms.filter(r => idsMatch(r.floor_id, f.id)).length}</p>
                  </div>
                  <ChevronRight className="text-slate-500 group-hover:text-emerald-500" />
                </div>
              </div>
            ))}
          </div>
                );
              }
              return (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 relative z-10">
            {rooms.filter(r => idsMatch(r.floor_id, selectedFloor.id) && roomPassesFilters(r)).map(r => {
              const liveStatus = getRoomLiveStatus(r);
              const equipmentLabels = getRoomEquipmentLabels(r);
              const departmentLabel = getRoomDepartmentLabel(r);
              const roomSchedules = getRoomSchedules(r);
              const currentSchedule = getCurrentSchedule(r);
              const nextSchedule = currentSchedule ? null : getNextSchedule(r);
              const linkContextSchedule = getRoomLinkContextSchedule(r);
              const roomContextCount = getRoomContextCount(r);
              const statusClass =
                liveStatus === 'Available' ? "bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20" :
                liveStatus === 'Booked' || liveStatus === 'Scheduled' ? "bg-rose-500/10 border-rose-500/30 hover:bg-rose-500/20" :
                liveStatus === 'Maintenance' ? "bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20" :
                "bg-slate-700/50 border-slate-600";
              const dotClass =
                liveStatus === 'Available' ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.6)]" :
                liveStatus === 'Maintenance' ? "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.6)]" :
                "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)]";
              return (
              <div 
                key={r.id} 
                className={cn(
                  "p-6 rounded-2xl border transition-all relative group cursor-default",
                  statusClass
                )}
              >
                <div className="flex justify-between items-start mb-4">
                  <span className="text-lg font-bold text-white">{r.room_number}</span>
                  <div className={cn("w-3 h-3 rounded-full", dotClass)} />
                </div>
                <p className="text-[10px] text-slate-400 uppercase font-bold tracking-widest mb-1">{getRoomTypeDisplay(r)}</p>
                <p className="text-[10px] text-slate-300 font-bold mb-1">{liveStatus}</p>
                <p className="text-[10px] text-slate-500 mb-1">{departmentLabel}</p>
                {getRoomAliasList(r).length > 0 && (
                  <p className="text-[10px] text-cyan-300 mb-1">Aliases: {getRoomAliasList(r).join(', ')}</p>
                )}
                {roomContextCount > 1 && (
                  <p className="text-[10px] font-bold text-blue-300 mb-1">Mixed Contexts: {roomContextCount}</p>
                )}
                {currentSchedule ? (
                  <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-rose-300">Current Class</p>
                    <p className="mt-1 text-xs font-bold text-white line-clamp-1">{currentSchedule.course_name}</p>
                    <p className="text-[10px] text-slate-500">{getScheduleAcademicContextLabel(currentSchedule, departments) || 'Academic context not set'}</p>
                    <p className="text-[10px] text-slate-400">{currentSchedule.start_time} - {currentSchedule.end_time} • {currentSchedule.faculty || 'Faculty not set'}</p>
                  </div>
                ) : nextSchedule ? (
                  <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300">Next Class</p>
                    <p className="mt-1 text-xs font-bold text-white line-clamp-1">{nextSchedule.course_name}</p>
                    <p className="text-[10px] text-slate-500">{getScheduleAcademicContextLabel(nextSchedule, departments) || 'Academic context not set'}</p>
                    <p className="text-[10px] text-slate-400">{nextSchedule.day_of_week} • {nextSchedule.start_time} - {nextSchedule.end_time}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-[10px] text-slate-500">No timetable rows linked to this room.</p>
                )}
                <p className="text-[10px] text-slate-500 line-clamp-1">Equipment: {equipmentLabels.join(', ') || 'None'}</p>
                <div className="flex items-center justify-between mt-4">
                  <span className="text-[10px] font-bold text-slate-500">CAP: {r.capacity}</span>
                  <span className="text-[10px] font-bold text-slate-500">CLS: {roomSchedules.length}</span>
                  {getRoomMaintenance(r).length > 0 && (
                    <AlertTriangle size={14} className="text-amber-500" />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 mt-4">
                  <Link to={`/timetable${getRoomDeepLinkSearch(r, linkContextSchedule)}`} className="px-2 py-1 rounded-lg bg-white/5 text-[10px] font-bold text-slate-300 hover:text-white text-center">Timetable</Link>
                  <Link to={`/bookings${getRoomDeepLinkSearch(r, linkContextSchedule)}`} className="px-2 py-1 rounded-lg bg-white/5 text-[10px] font-bold text-slate-300 hover:text-white text-center">Bookings</Link>
                  <Link to={`/equipment${getRoomDeepLinkSearch(r)}`} className="px-2 py-1 rounded-lg bg-white/5 text-[10px] font-bold text-slate-300 hover:text-white text-center">Equipment</Link>
                  <Link to={`/maintenance${getRoomDeepLinkSearch(r)}`} className="px-2 py-1 rounded-lg bg-white/5 text-[10px] font-bold text-slate-300 hover:text-white text-center">Maintenance</Link>
                </div>
              </div>
            );})}
            {rooms.filter(r => idsMatch(r.floor_id, selectedFloor.id) && roomPassesFilters(r)).length === 0 && (
              <div className="col-span-full p-12 text-center border-2 border-dashed border-slate-700 rounded-3xl">
                <p className="text-sm font-bold text-slate-400">No rooms match the current filters on this floor.</p>
              </div>
            )}
          </div>
              );
            })()}
          </div>
        )}
      </div>

    {aiRecommendations && (
        <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-xl font-bold text-slate-800 flex items-center gap-3">
              <div className="p-2 bg-emerald-100 rounded-lg">
                <BrainCircuit className="text-emerald-600" size={24} />
              </div>
              AI Infrastructure Insights
            </h3>
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 rounded-xl border border-slate-100">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Efficiency Score:</span>
              <span className="text-lg font-bold text-emerald-600">{aiRecommendations.efficiencyScore}%</span>
            </div>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest">Strategic Recommendations</h4>
              {aiRecommendations.recommendations.map((rec: string, i: number) => (
                <div key={i} className="flex gap-4 p-4 bg-slate-50 rounded-2xl border border-slate-100 group hover:border-emerald-200 transition-all">
                  <div className="w-8 h-8 bg-white rounded-lg border border-slate-200 flex items-center justify-center text-sm font-bold text-slate-400 group-hover:text-emerald-500 group-hover:border-emerald-500 transition-all">
                    {i + 1}
                  </div>
                  <p className="text-sm text-slate-700 font-medium leading-relaxed">{rec}</p>
                </div>
              ))}
            </div>
            <div className="space-y-6">
              <div className="p-6 bg-indigo-50 border border-indigo-100 rounded-2xl">
                <h4 className="text-sm font-bold text-indigo-900 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <TrendingUp size={16} />
                  Future Forecast
                </h4>
                <p className="text-sm text-indigo-800 leading-relaxed font-medium">{aiRecommendations.futureForecast}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
