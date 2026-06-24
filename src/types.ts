export type Role =
  | 'Administrator'
  | 'Admin'
  | 'Master Admin'
  | 'Vice Chancellor'
  | 'Pro-Chancellor'
  | 'Dean'
  | 'Dean (P&M)'
  | 'Deputy Dean (P&M)'
  | 'HOD'
  | 'Event Coordinator'
  | 'Faculty'
  | 'Maintenance Staff'
  | 'Infrastructure Manager';

export interface User {
  id: number;
  full_name: string;
  employee_id: string;
  department?: string;
  designation?: string;
  role: Role;
  email: string;
  mobile_number?: string;
  dashboard_view_mode?: 'Visual' | 'Text' | 'Hybrid' | null;
}

export interface Building {
  id: number;
  building_id: string;
  name: string;
  campus_block?: string;
  floors_count?: number;
  description?: string;
}

export interface Floor {
  id: number;
  floor_id: string;
  building_name: string;
  floor_number: number;
  description?: string;
}

export interface Room {
  id: number;
  room_id: string;
  room_number: string;
  building: string;
  floor: string;
  room_type: string;
  lab_name?: string;
  restroom_type?: 'Male' | 'Female';
  capacity: number;
  accessibility?: string;
  status: 'Available' | 'Maintenance';
  allocated_department?: string;
}

export interface School {
  id: number;
  school_id: string;
  name: string;
  type: string;
  description?: string;
}

export interface Department {
  id: number;
  department_id: string;
  name: string;
  school_name: string;
  type: string;
  description?: string;
}

export interface Equipment {
  id: number;
  equipment_id: string;
  room_number: string;
  type: string;
  name: string;
  installation_date?: string;
  condition?: string;
  maintenance_status?: string;
}

export interface Schedule {
  id: number;
  schedule_id: string;
  department?: string;
  course_code?: string;
  course_name?: string;
  faculty?: string;
  room?: string;
  day_of_week?: string;
  start_time?: string;
  end_time?: string;
  student_count?: number;
}

export interface Booking {
  id: number;
  request_id: string;
  faculty_name: string;
  department?: string;
  event_name?: string;
  student_count?: number;
  room_type?: string;
  equipment_required?: string;
  preferred_building?: string;
  date?: string;
  time_slot?: string;
  duration?: string;
  status: 'Pending' | 'Approved' | 'Rejected';
}

export interface MaintenanceRecord {
  id: number;
  maintenance_id: string;
  room_number: string;
  equipment_name?: string;
  issue_description?: string;
  reported_date?: string;
  assigned_staff?: string;
  status: 'Pending' | 'In Progress' | 'Completed';
}
