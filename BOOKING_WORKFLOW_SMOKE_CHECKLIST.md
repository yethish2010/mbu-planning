# Booking Workflow Smoke Checklist

Use this checklist after changes to room requests, HOD review, dean allocation, or booking dashboards.

## Recommended Test Accounts

- `HOD` user mapped to more than one department
- `Dean (P&M)` or `Deputy Dean (P&M)` user
- Optional `Faculty` user for plain room-request checks

## Core Smoke Pass

### 1. HOD Department Context

- Log in as an `HOD` user with multiple department assignments.
- Open `/`.
- Confirm the dashboard department selector appears.
- Switch departments.
- Expected:
  - department cards refresh
  - request counters change with the selected department
  - opening `/bookings` keeps the selected department context

### 2. Additional Room Request Submission

- As the same `HOD`, open `/bookings`.
- Click `Request Additional Room`.
- Submit a request with:
  - event name
  - department
  - required capacity
  - optional preferred building
- Expected:
  - request is created without selecting a room
  - request row shows `Additional Room`
  - room shows `Allocation Pending`
  - request appears under pending workflow counts

### 3. HOD Request Visibility

- Stay on `/bookings` as HOD.
- Open the row `View Details`.
- Expected:
  - workflow snapshot shows request submitted
  - activity timeline contains the submission entry
  - requester note, if entered, is visible

### 4. Dean Allocation Queue

- Log in as `Dean (P&M)` or `Deputy Dean (P&M)`.
- Open `/`.
- Confirm the workflow queue cards appear:
  - `Waiting HOD Recommendation`
  - `Waiting Allocation`
  - `Ready For Decision`
  - `Additional Room Requests`
- Click `Waiting Allocation`.
- Expected:
  - `/bookings` opens
  - active workflow filter chips are visible
  - list is narrowed to additional-room requests with no assigned room

### 5. Vacancy-Aware Assignment

- On the filtered dean bookings page, find the pending additional-room request.
- Click `Find Vacant Rooms`.
- Choose an offered room.
- Click `Assign Room`.
- Enter an allocation note if needed.
- Expected:
  - only vacant matching rooms are offered
  - row updates from `Allocation Pending` to a real room
  - activity timeline later shows allocation entry
  - `Approve` becomes available only after assignment

### 6. Final Decision

- Approve the same request.
- Enter a decision remark.
- Expected:
  - status changes to `Approved`
  - `decided_by` is visible in details
  - decision note is shown
  - activity timeline records the status change

### 7. Details Modal Timeline

- Open `View Details` on the approved request.
- Expected:
  - readable timestamp formatting
  - clear event labels such as `Submitted`, `Allocated`, `Decision`
  - room/status badges appear where relevant
  - notes are visible in the timeline and summary sections

### 8. Dashboard Shortcut Deep Links

- From the dashboard, click:
  - `Additional Room Requests`
  - `Waiting Allocation`
  - `Ready For Decision`
- Expected:
  - bookings page opens with matching workflow chips
  - result list matches the queue meaning
  - removing chips broadens the result set correctly

### 9. Workflow Filter Chips

- On `/bookings`, confirm active workflow chips are shown for deep-linked views.
- Remove one chip.
- Remove all chips.
- Expected:
  - list updates immediately
  - URL query params update
  - status tabs still work alongside workflow chips

### 10. Standard Room Booking Regression

- Submit a normal `Department Room` booking with a selected room.
- Expected:
  - room is still required
  - booking flow behaves as before
  - additional-room changes do not block standard bookings

### 11. Alternative Suggestion Flow

- As `Dean (P&M)` or `Deputy Dean (P&M)`, open an additional-room request that cannot be approved directly.
- Use the alternative suggestion action.
- Enter an alternative note and submit it.
- Expected:
  - request status changes to `Awaiting Alternative Response`
  - `View Details` shows the suggested alternative block
  - activity timeline records the suggestion

### 12. Requester Response Flow

- As the requester, open the same booking from `/bookings`.
- Accept the suggested alternative once, or decline it for a negative-path test.
- Expected:
  - accept path moves the request back into dean/HOD decision flow with the assigned option visible
  - decline path moves the request to `No Room Available`
  - response note is visible in details and timeline

### 13. Clarification / Waitlist / No-Room Branches

- As dean, open one additional-room request and manually trigger:
  - `Waitlist`
  - `Need Clarification`
  - `No Room`
- Expected:
  - each status appears as its own tab/filter state on `/bookings`
  - the status badge color matches the workflow meaning
  - requester controls appear only for the statuses that allow requester action
  - details modal summary and timeline reflect the selected branch

### 14. Temporary Allocation Lifecycle

- Approve an additional-room request that results in a temporary allocation.
- Open `View Details` on the booking.
- Expected:
  - `Temporary Allocation Lifecycle` section is visible
  - allocation dates, room, and current lifecycle status are shown
- Open the room schedule/timetable context for the allocated room.
- Expected:
  - temporary allocation appears alongside schedules/bookings
  - vacancy checks treat the room as occupied for the temporary window
  - timetable warning/notice appears when the selected reference date falls inside the allocation window

### 15. Reporting Parity

- Open `/reports`.
- Check `Booking Approvals` and `Booking Workflow, Lead-Time & Resolution Trends`.
- Expected:
  - booking-status filter includes `Awaiting Alternative Response`, `Clarification Required`, `Waitlisted`, and `No Room Available`
  - booking lifecycle cards include:
    - `No Room / Waitlist`
    - `Need Clarification`
    - `Alt Response Pending`
    - `Open Workflow`
  - exported report sheets include the same workflow columns shown on screen

## Good Failure Signals To Watch For

- additional-room request cannot be created without a room
- dean can approve an additional-room request before assignment
- dashboard queue opens a broad list instead of the intended filtered slice
- activity timeline is empty for a newly created or updated request
- active workflow chips are missing even though the URL contains workflow filters
- standard room booking starts showing `Allocation Pending`
- alternative suggestion does not move the request into `Awaiting Alternative Response`
- requester response updates the note but not the status
- temporary allocation exists in booking details but does not affect vacancy/timetable availability
- reports/export sheets still show only the original five booking statuses

## Quick Regression Sequence

If time is short, run only these:

1. Submit one additional-room request as HOD.
2. Open `Waiting Allocation` from dean dashboard.
3. Find vacant rooms, assign one, approve it.
4. Open `View Details` and confirm the timeline shows submission, allocation, and decision.
5. Submit one normal room booking and confirm it still requires a room.
6. Open `/reports` and confirm the expanded booking workflow statuses/cards are visible.
