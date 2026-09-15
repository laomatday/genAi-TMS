import { TMS_LIMITS } from '@/shared/constants';
import type { Cell, CellObject, SheetData } from 'write-excel-file/browser';

type ExcelValue = string | number | boolean | Date | null | undefined;

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

/** A workbook cannot read CSS, so the palette is resolved from the brand tokens
 *  in style.css. Only theme-independent tokens are read, so an export never
 *  comes out tinted by whichever theme the viewer happened to have open.
 *
 *  Resolved on first use rather than at import time: the stylesheet is guaranteed
 *  to be applied by the time someone triggers an export, but not necessarily when
 *  this module is first evaluated. */
const brandHexCache = new Map<string, string>();

/** Normalizes a CSS colour to the `#RRGGBB` form the workbook writer expects.
 *  Production CSS minification rewrites every brand hex into its shortest form,
 *  so `--color-on-dark: #FFFFFF` reaches the browser as `#fff`. The writer only
 *  concatenates `FF` with everything after the `#`, so a short hex would silently
 *  produce a malformed ARGB value instead of failing.
 *
 *  Exported for direct unit testing — this only diverges from dev builds in a
 *  minified bundle, which is exactly where a regression would go unnoticed. */
export function normalizeBrandHex(value: string): string | null {
  const input = value.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(input)?.[1];
  if (hex) {
    // 4- and 8-digit forms carry an alpha channel that Excel fills cannot use.
    if (hex.length === 3 || hex.length === 4) return `#${[...hex.slice(0, 3)].map((digit) => digit + digit).join('')}`.toUpperCase();
    if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`.toUpperCase();
    return null;
  }
  const channels = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(input)?.slice(1, 4).map(Number);
  if (!channels || channels.some((channel) => channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Minifiers also collapse a hex into a colour keyword whenever that is shorter
 *  (`#FF0000` becomes `red`). Only the browser knows the full keyword table, so
 *  let a canvas context serialize the value back into a hex. */
function canvasBrandHex(value: string) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;
  // An unparseable assignment leaves `fillStyle` untouched, so probe with two
  // different seeds: only a colour the browser accepts overrides both.
  const readings = ['#000000', '#ffffff'].map((seed) => {
    context.fillStyle = seed;
    context.fillStyle = value;
    return String(context.fillStyle);
  });
  return readings[0] === readings[1] ? normalizeBrandHex(readings[0] ?? '') : null;
}

function brandHex(token: string) {
  const cached = brandHexCache.get(token);
  if (cached) return cached;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = raw ? normalizeBrandHex(raw) ?? canvasBrandHex(raw) : null;
  if (!value) {
    throw new Error(`Thiếu token màu ${token} trong style.css — không thể xuất file.`);
  }
  brandHexCache.set(token, value);
  return value;
}

const headerBackground = () => brandHex('--brand-navy');
const headerText = () => brandHex('--color-on-dark');
const cellBorder = () => brandHex('--brand-ice');

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
    borderColor: cellBorder(),
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
    textColor: headerText(),
    backgroundColor: headerBackground(),
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

function excelValue(row: ImportedExcelRow, ...headers: string[]) {
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
