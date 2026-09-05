import { TMS_LIMITS } from '@/shared/constants';
import type { Cell, CellObject, SheetData } from 'write-excel-file/browser';

export type ExcelValue = string | number | boolean | Date | null | undefined;

export interface ExcelColumn<Row> {
  header: string;
  width?: number;
  format?: string;
  align?: 'left' | 'center' | 'right';
  value: (row: Row) => ExcelValue;
}

export interface ImportedExcelRow {
  rowNumber: number;
  values: ReadonlyMap<string, ExcelValue>;
}

const HEADER_BACKGROUND = '#233f98';
const HEADER_TEXT = '#ffffff';
const CELL_BORDER = '#d8e0ec';

function normalizeHeader(value: unknown) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim()
    .toLocaleLowerCase('vi')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function excelCell(value: ExcelValue, column: ExcelColumn<unknown>): Cell {
  const shared: Partial<CellObject> = {
    borderColor: CELL_BORDER,
    bottomBorderStyle: 'thin',
    alignVertical: 'center',
    align: column.align,
    wrap: true,
  };
  if (value == null) return { ...shared, value: '' } as CellObject;
  if (value instanceof Date) return { ...shared, value, type: Date, format: column.format || 'yyyy-mm-dd' } as CellObject;
  if (typeof value === 'number') return { ...shared, value, type: Number, format: column.format } as CellObject;
  if (typeof value === 'boolean') return { ...shared, value, type: Boolean } as CellObject;
  return { ...shared, value: String(value), type: String } as CellObject;
}

export async function exportExcel<Row>({
  filename,
  sheetName,
  columns,
  rows,
}: {
  filename: string;
  sheetName: string;
  columns: ExcelColumn<Row>[];
  rows: Row[];
}) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header: Cell[] = columns.map((column) => ({
    value: column.header,
    type: String,
    fontWeight: 'bold',
    textColor: HEADER_TEXT,
    backgroundColor: HEADER_BACKGROUND,
    alignVertical: 'center',
    wrap: true,
    height: 30,
  }));
  const data: SheetData = [
    header,
    ...rows.map((row) => columns.map((column) => excelCell(column.value(row), column as ExcelColumn<unknown>))),
  ];
  await writeXlsxFile(data, {
    sheet: sheetName.slice(0, 31),
    columns: columns.map((column) => ({ width: column.width || 16 })),
    stickyRowsCount: 1,
    showGridLines: false,
    zoomScale: 90,
  }).toFile(filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export async function readExcelRows(file: File): Promise<ImportedExcelRow[]> {
  if (!file.name.toLocaleLowerCase().endsWith('.xlsx')) {
    throw new Error('Chỉ hỗ trợ file Excel định dạng .xlsx.');
  }
  if (file.size > TMS_LIMITS.MAX_SPREADSHEET_FILE_BYTES) {
    throw new Error('File Excel vượt quá dung lượng cho phép.');
  }

  const { readSheet } = await import('read-excel-file/browser');
  const sheet = await readSheet(file);
  if (sheet.length < 2) throw new Error('File Excel chưa có dòng dữ liệu.');
  const populatedRows = sheet.slice(1)
    .map((cells, index) => ({ cells, rowNumber: index + 2 }))
    .filter(({ cells }) => cells.some((value) => value != null && String(value).trim() !== ''));
  if (populatedRows.length > TMS_LIMITS.MAX_SPREADSHEET_IMPORT_ROWS) {
    throw new Error(`Mỗi lần chỉ nhập tối đa ${TMS_LIMITS.MAX_SPREADSHEET_IMPORT_ROWS} dòng.`);
  }

  const headers = sheet[0]?.map(normalizeHeader) || [];
  if (!headers.some(Boolean)) throw new Error('Không nhận diện được tiêu đề cột trong file Excel.');
  const duplicate = headers.find((header, index) => header && headers.indexOf(header) !== index);
  if (duplicate) throw new Error(`Tiêu đề cột bị trùng: ${duplicate}.`);

  return populatedRows.map(({ cells, rowNumber }) => ({
    rowNumber,
    values: new Map(headers.map((header, columnIndex) => [header, cells[columnIndex] as ExcelValue])),
  }));
}

export function excelValue(row: ImportedExcelRow, ...headers: string[]) {
  for (const header of headers) {
    const value = row.values.get(normalizeHeader(header));
    if (value != null && value !== '') return value;
  }
  return undefined;
}

export function excelText(row: ImportedExcelRow, ...headers: string[]) {
  const value = excelValue(row, ...headers);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value == null ? '' : String(value).trim();
}

export function excelNumber(row: ImportedExcelRow, fallback: number, ...headers: string[]) {
  const value = excelValue(row, ...headers);
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function excelBoolean(row: ImportedExcelRow, fallback: boolean, ...headers: string[]) {
  const value = excelValue(row, ...headers);
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = normalizeHeader(value);
  if (['1', 'true', 'yes', 'co', 'bat', 'hoat dong', 'active'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'khong', 'tat', 'tam khoa', 'inactive'].includes(normalized)) return false;
  return fallback;
}

export function excelDate(row: ImportedExcelRow, ...headers: string[]) {
  const value = excelValue(row, ...headers);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = value == null ? '' : String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : '';
  }
  const vietnameseDate = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!vietnameseDate) return '';
  const day = vietnameseDate[1];
  const month = vietnameseDate[2];
  const year = vietnameseDate[3];
  if (!day || !month || !year) return '';
  const normalized = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : '';
}

export function excelList(row: ImportedExcelRow, ...headers: string[]) {
  return excelText(row, ...headers).split(/[,;|]/).map((value) => value.trim()).filter(Boolean);
}
