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
  school?: string;
  primary_school_id?: string | null;
  primary_school?: string | null;
  assigned_school_ids?: string[];
  assigned_schools?: string[];
  school_assignments?: Array<{
    id: number;
    school_id: number;
    school_name: string;
    school_code?: string;
    is_primary: boolean;
    valid_from?: string | null;
    valid_until?: string | null;
    status?: string;
  }>;
  department?: string;
  primary_department_id?: string | null;
  primary_department?: string | null;
  assigned_department_ids?: string[];
  assigned_departments?: string[];
  department_assignments?: Array<{
    id: number;
    department_id: number;
    department_name: string;
    department_code?: string;
    school_id?: number;
    is_primary: boolean;
    valid_from?: string | null;
    valid_until?: string | null;
    status?: string;
  }>;
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
  required_capacity?: number;
  room_type?: string;
  equipment_required?: string;
  preferred_building?: string;
  request_type?: 'Department Room' | 'Additional Room';
  status_remark?: string;
  allocation_note?: string;
  date?: string;
  time_slot?: string;
  duration?: string;
  status: 'Pending' | 'HOD Recommended' | 'Approved' | 'Rejected' | 'Postponed' | 'No Room Available' | 'Awaiting Alternative Response' | 'Waitlisted' | 'Clarification Required';
}

export interface BookingAlternative {
  id: number;
  booking_id?: number;
  request_group_id?: string | null;
  status: 'Pending Response' | 'Accepted' | 'Declined';
  suggested_date?: string;
  suggested_start_time?: string;
  suggested_end_time?: string;
  suggested_capacity?: number;
  suggested_room_type?: string;
  suggested_building?: string;
  suggested_room_count?: number;
  suggestion_note?: string;
  response_note?: string;
  created_by?: string;
  created_role?: string;
  responded_by?: string;
  responded_role?: string;
  responded_at?: string;
  created_at?: string;
}

export interface TemporaryRoomAllocation {
  id: number;
  booking_id: number;
  request_group_id?: string | null;
  room_id: number;
  temporary_department_id: number;
  original_department_id?: number | null;
  approved_date: string;
  start_time: string;
  end_time: string;
  purpose?: string;
  request_type?: string;
  allocation_note?: string;
  assigned_by?: string;
  assigned_role?: string;
  released_at?: string;
  status: 'Upcoming' | 'Active' | 'Completed' | 'Revoked';
  created_at?: string;
  updated_at?: string;
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
