export interface AttendancePosition {
  lat: number;
  lng: number;
  accuracy: number;
}

/**
 * Reject malformed sensor output only. Tenant policy on the server owns the
 * accepted accuracy and geofence thresholds for every attendance action.
 */
export function assertValidAttendancePosition(position: AttendancePosition) {
  if (
    !Number.isFinite(position.lat)
    || position.lat < -90
    || position.lat > 90
    || !Number.isFinite(position.lng)
    || position.lng < -180
    || position.lng > 180
  ) {
    throw new Error('Thiết bị không trả về tọa độ GPS hợp lệ.');
  }
  if (!Number.isFinite(position.accuracy) || position.accuracy <= 0) {
    throw new Error('Thiết bị không trả về độ chính xác GPS hợp lệ.');
  }
}
