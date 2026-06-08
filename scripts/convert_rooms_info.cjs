const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const sourcePath = 'D:/MBU_Apps/Data/Rooms_Info.xlsx';
const templatePath = 'D:/MBU_Apps/Data/Room_Template.xlsx';
const referencePath = 'D:/MBU_Apps/Data/Room_Export.xlsx';
const outputPath = 'D:/MBU_Apps/Data/Rooms_Info_Converted_To_Template.xlsx';

const TEMPLATE_HEADERS = [
  'Room ID',
  'Room Number',
  'Room Aliases',
  'Building',
  'Block / Direct Floors',
  'Floor',
  'Room Layout',
  'Sub Room Count',
  'Room Type',
  'Sub Room Type',
  'Sub Room Name',
  'Parent Room',
  'Usage Category',
  'Is Bookable',
  'Capacity',
  'Status',
  'Lab Name',
  'Sub Lab Name',
  'Restroom For',
];

const PLACEHOLDER_VALUES = new Set(['', '-', '--', 'N/A', 'NA', 'NONE', 'NULL', 'NIL']);

const BUILDING_MAP = {
  'M-PLAZA': 'M-Plaza',
  'M PLAZA': 'M-Plaza',
  MPLAZA: 'M-Plaza',
  MNS: 'MNS',
  MAV: 'MAV',
  NAB: 'NAB',
  PHARMACY: 'Pharmacy',
  'PHARMACY BLOCK': 'Pharmacy',
  'OLD SVIM': 'MAV',
  OLDSVIM: 'MAV',
  SVIM: 'MAV',
  CIVIL: 'MAV',
  MECHANICAL: 'MAV',
};

const TYPE_CONFIG = {
  Classroom: { usage: 'Teaching', bookable: 'Yes' },
  Lab: { usage: 'Lab Work', bookable: 'Yes' },
  Restroom: { usage: 'Restricted', bookable: 'No' },
  'Faculty Room': { usage: 'Office', bookable: 'No' },
  'HOD Cabin': { usage: 'Office', bookable: 'No' },
  Office: { usage: 'Office', bookable: 'No' },
  'Seminar Hall': { usage: 'Teaching', bookable: 'Yes' },
  Auditorium: { usage: 'Teaching', bookable: 'Yes' },
  'Common Room': { usage: 'Restricted', bookable: 'No' },
  'Electrical Room': { usage: 'Restricted', bookable: 'No' },
  'Server Room': { usage: 'Restricted', bookable: 'No' },
  Utility: { usage: 'Restricted', bookable: 'No' },
  Entrance: { usage: 'Restricted', bookable: 'No' },
  Exit: { usage: 'Restricted', bookable: 'No' },
  'Emergency Exit': { usage: 'Restricted', bookable: 'No' },
  'Examination Section': { usage: 'Office', bookable: 'No' },
  'Store Room': { usage: 'Restricted', bookable: 'No' },
};

function normalizeText(value) {
  return (value ?? '').toString().replace(/\s+/g, ' ').trim();
}

function normalizeOptional(value) {
  const text = normalizeText(value);
  return PLACEHOLDER_VALUES.has(text.toUpperCase()) ? '' : text;
}

function normalizeBuilding(value) {
  const text = normalizeText(value).toUpperCase();
  return BUILDING_MAP[text] || normalizeText(value);
}

function normalizeRoomKey(value) {
  return normalizeText(value)
    .toUpperCase()
    .replace(/\s+INSIDE\s+.+$/g, '')
    .replace(/\s+/g, '')
    .replace(/[()]/g, '')
    .replace(/&/g, 'AND');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  const text = normalizeText(value).replace(/[^0-9.]/g, '');
  if (!text) return '';
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : '';
}

function titleCaseWords(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function inferTypeInfo(purpose, extra) {
  const rawPurpose = normalizeText(purpose);
  const rawExtra = normalizeText(extra);
  const combined = `${rawPurpose} ${rawExtra}`.toUpperCase();

  const result = {
    roomType: 'Classroom',
    subRoomType: '',
    subRoomName: '',
    labName: '',
    subLabName: '',
    restroomFor: '',
    usage: 'Teaching',
    bookable: 'Yes',
  };

  if (!combined) return result;

  if (combined.includes('TOILET') || combined.includes('REST ROOM') || combined.includes('WASHROOM')) {
    result.roomType = 'Restroom';
    result.usage = 'Restricted';
    result.bookable = 'No';
    if (combined.includes('FEMALE') || combined.includes('L-TOILET') || combined.includes('L TOILET')) {
      result.restroomFor = 'Female';
    } else if (combined.includes('MALE') || combined.includes('M-TOILET') || combined.includes('M TOILET')) {
      result.restroomFor = 'Male';
    }
    return result;
  }

  if (combined.includes('HOD')) {
    result.roomType = 'HOD Cabin';
    result.usage = 'Office';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('FACULTY')) {
    result.roomType = 'Faculty Room';
    result.usage = 'Office';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('DIRECTOR') || combined.includes('DEAN') || combined.includes('OFFICE') || combined.includes('CAMU')) {
    result.roomType = 'Office';
    result.usage = 'Office';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('EXAM')) {
    result.roomType = 'Examination Section';
    result.usage = 'Office';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('SERVER') || combined.includes('NETWORK ROOM')) {
    result.roomType = 'Server Room';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('ELECTRICAL')) {
    result.roomType = 'Electrical Room';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('STORE')) {
    result.roomType = 'Store Room';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('UTILITY')) {
    result.roomType = 'Utility';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('EMERGENCY EXIT')) {
    result.roomType = 'Emergency Exit';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('EXIT')) {
    result.roomType = 'Exit';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('ENTRANCE') || combined.includes('DOOR')) {
    result.roomType = 'Entrance';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('COMMON ROOM')) {
    result.roomType = 'Common Room';
    result.usage = 'Restricted';
    result.bookable = 'No';
    return result;
  }

  if (combined.includes('SEMINAR')) {
    result.roomType = 'Seminar Hall';
    result.usage = 'Teaching';
    result.bookable = 'Yes';
    return result;
  }

  if (combined.includes('AUDITORIUM')) {
    result.roomType = 'Auditorium';
    result.usage = 'Teaching';
    result.bookable = 'Yes';
    return result;
  }

  if (combined.includes('LAB')) {
    result.roomType = 'Lab';
    result.usage = 'Lab Work';
    result.bookable = 'Yes';
    const displayLabName = rawExtra || rawPurpose;
    result.labName = titleCaseWords(displayLabName.replace(/^LAB\s*[-:]?\s*/i, ''));
    if (!result.labName.toUpperCase().includes('LAB')) {
      result.labName = `${result.labName} Lab`.trim();
    }
    return result;
  }

  if (combined.includes('CLASS ROOM') || combined.includes('CLASSROOM')) {
    result.roomType = 'Classroom';
    result.usage = 'Teaching';
    result.bookable = 'Yes';
    return result;
  }

  return result;
}

function referenceToTemplateRow(row) {
  return {
    'Room ID': row?.['Room ID'] ?? '',
    'Room Number': row?.['Room Number'] ?? '',
    'Room Aliases': row?.['Room Aliases'] ?? '-',
    Building: row?.Building ?? '',
    'Block / Direct Floors': row?.['Block / Direct Floors'] ?? '',
    Floor: row?.Floor ?? '',
    'Room Layout': row?.['Room Layout'] ?? '',
    'Sub Room Count': row?.['Sub Room Count'] ?? '',
    'Room Type': row?.['Room Type'] ?? '',
    'Sub Room Type': row?.['Sub Room Type'] ?? '',
    'Sub Room Name': row?.['Sub Room Name'] ?? '',
    'Parent Room': row?.['Parent Room'] ?? row?.['Inside / Parent Room'] ?? '',
    'Usage Category': row?.['Usage Category'] ?? '',
    'Is Bookable': row?.['Is Bookable'] ?? '',
    Capacity: row?.Capacity ?? '',
    Status: row?.Status ?? 'Available',
    'Lab Name': row?.['Lab Name'] ?? '',
    'Sub Lab Name': row?.['Sub Lab Name'] ?? '',
    'Restroom For': row?.['Restroom For'] ?? '',
  };
}

function readWorkbookRows(filePath, sheetName) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found in ${filePath}`);
  }
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function buildReferenceMaps(referenceRows) {
  const byRoomId = new Map();
  const byBuildingRoom = new Map();
  const byBuildingAlias = new Map();

  for (const row of referenceRows) {
    const cloned = referenceToTemplateRow(row);
    const building = normalizeBuilding(cloned.Building);
    const roomNumber = normalizeOptional(cloned['Room Number']);
    const roomId = normalizeOptional(cloned['Room ID']);
    if (building && roomId) {
      byRoomId.set(`${building}||${normalizeRoomKey(roomId.replace(/^ROOM-/i, ''))}`, cloned);
    }
    if (building && roomNumber) {
      byBuildingRoom.set(`${building}||${normalizeRoomKey(roomNumber)}`, cloned);
    }
    const aliases = normalizeOptional(cloned['Room Aliases'])
      .split(/[,\n/|]+/)
      .map((alias) => normalizeOptional(alias))
      .filter(Boolean);
    for (const alias of aliases) {
      byBuildingAlias.set(`${building}||${normalizeRoomKey(alias)}`, cloned);
    }
  }

  return { byRoomId, byBuildingRoom, byBuildingAlias };
}

function buildConvertedRows(sourceRows, referenceRows) {
  const { byRoomId, byBuildingRoom, byBuildingAlias } = buildReferenceMaps(referenceRows);
  const converted = [];
  const review = [];

  for (const rawRow of sourceRows) {
    const roomNo = normalizeOptional(rawRow['Room No']);
    const sourceBlock = normalizeOptional(rawRow.Block);
    const purpose = normalizeOptional(rawRow['Room Purpose']);
    const extra = normalizeOptional(rawRow.__EMPTY);
    const capacity = toNumber(rawRow['Exact Capacity as per avl Desks']);

    if (!roomNo || !sourceBlock) continue;

    const building = normalizeBuilding(sourceBlock);
    const lookupKey = `${building}||${normalizeRoomKey(roomNo)}`;
    const reference =
      byRoomId.get(lookupKey) ||
      byBuildingRoom.get(lookupKey) ||
      byBuildingAlias.get(lookupKey) ||
      null;

    let outputRow;
    if (reference) {
      outputRow = referenceToTemplateRow(reference);
      outputRow.Building = building || outputRow.Building;
      if (capacity !== '') outputRow.Capacity = capacity;
      if (!normalizeOptional(outputRow['Room Aliases'])) outputRow['Room Aliases'] = '-';
      if (!normalizeOptional(outputRow['Parent Room'])) outputRow['Parent Room'] = '-';
      if (!normalizeOptional(outputRow['Sub Room Type'])) outputRow['Sub Room Type'] = '-';
      if (!normalizeOptional(outputRow['Sub Room Name'])) outputRow['Sub Room Name'] = '-';
      if (!normalizeOptional(outputRow['Lab Name'])) outputRow['Lab Name'] = '-';
      if (!normalizeOptional(outputRow['Sub Lab Name'])) outputRow['Sub Lab Name'] = '-';
      if (!normalizeOptional(outputRow.Status)) outputRow.Status = 'Available';
    } else {
      const inferred = inferTypeInfo(purpose, extra);
      const typeDefaults = TYPE_CONFIG[inferred.roomType] || {
        usage: inferred.usage,
        bookable: inferred.bookable,
      };
      outputRow = Object.fromEntries(TEMPLATE_HEADERS.map((header) => [header, '']));
      outputRow['Room ID'] = `ROOM-${roomNo.replace(/\s+/g, '')}`;
      outputRow['Room Number'] = roomNo;
      outputRow['Room Aliases'] = '-';
      outputRow.Building = building;
      outputRow['Block / Direct Floors'] =
        building === 'MAV' || building === 'MNS' || building === 'NAB' || building === 'Pharmacy'
          ? 'Direct floors'
          : '';
      outputRow.Floor = '';
      outputRow['Room Layout'] = 'Normal';
      outputRow['Sub Room Count'] = '';
      outputRow['Room Type'] = inferred.roomType;
      outputRow['Sub Room Type'] = '-';
      outputRow['Sub Room Name'] = '-';
      outputRow['Parent Room'] = '-';
      outputRow['Usage Category'] = inferred.usage || typeDefaults.usage || '';
      outputRow['Is Bookable'] = inferred.bookable || typeDefaults.bookable || '';
      outputRow.Capacity = capacity;
      outputRow.Status = 'Available';
      outputRow['Lab Name'] = inferred.labName || '-';
      outputRow['Sub Lab Name'] = inferred.subLabName || '-';
      outputRow['Restroom For'] = inferred.restroomFor || '';
      review.push({
        SourceRoom: roomNo,
        SourceBlock: sourceBlock,
        Purpose: purpose,
        Extra: extra,
        Reason: 'No exact room match found in current room export; generated a heuristic template row.',
      });
    }

    converted.push(outputRow);
  }

  return { converted, review };
}

function addInstructionNote(instructionsRows) {
  const rows = instructionsRows.map((row) => ({ ...row }));
  rows.push({});
  rows.push({
    Instructions:
      'Converted workbook note: this file was generated by matching Rooms_Info source rows against the current Room Export. Exact matches preserve existing floor, block, parent-room, layout, and type metadata. Unmatched rows are appended using heuristic room-type inference and are also listed in the Review Needed sheet.',
  });
  return rows;
}

function main() {
  const templateWorkbook = XLSX.readFile(templatePath);
  const sourceRows = readWorkbookRows(sourcePath, 'Total_Rooms');
  const referenceWorkbook = XLSX.readFile(referencePath);
  const referenceRows = readWorkbookRows(referencePath, referenceWorkbook.SheetNames[0]);
  const instructionsRows = XLSX.utils.sheet_to_json(templateWorkbook.Sheets.Instructions, { defval: '' });
  const { converted, review } = buildConvertedRows(sourceRows, referenceRows);

  const outWorkbook = XLSX.utils.book_new();
  const templateSheet = XLSX.utils.json_to_sheet(converted, { header: TEMPLATE_HEADERS });
  const instructionsSheet = XLSX.utils.json_to_sheet(addInstructionNote(instructionsRows), { skipHeader: false });
  const reviewSheet = XLSX.utils.json_to_sheet(review);

  XLSX.utils.book_append_sheet(outWorkbook, templateSheet, 'Template');
  XLSX.utils.book_append_sheet(outWorkbook, instructionsSheet, 'Instructions');
  XLSX.utils.book_append_sheet(outWorkbook, reviewSheet, 'Review Needed');

  XLSX.writeFile(outWorkbook, outputPath);

  const summary = {
    sourceRows: sourceRows.length,
    convertedRows: converted.length,
    reviewRows: review.length,
    outputPath,
  };
  fs.writeFileSync(
    path.join(process.cwd(), 'scripts', 'convert_rooms_info.summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
  console.log(JSON.stringify(summary, null, 2));
}

main();
