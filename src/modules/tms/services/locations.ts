import type { DashboardData, Location } from '@/shared/types';
import { queryWorkforce } from './workforceApi';

export async function getActiveLocations() {
  const metadata = await queryWorkforce('metadata', {}, { force: true });
  return (Array.isArray(metadata.locations) ? metadata.locations : []) as Location[];
}

/**
 * Single source of truth for center_id -> branch name in the employee app.
 *
 * `data.locations` is the geofence list: the server trims it to branches that are
 * active AND inside the viewer's scope, so it never covers every branch the
 * directory, calendar or timesheet history can reference. `data.locationDirectory`
 * is the label-only registry that does. Merging them keeps the name available even
 * when only one source knows the branch.
 */
export function buildLocationNameMap(data: Pick<DashboardData, 'locations' | 'locationDirectory'> | null | undefined) {
  const map: Record<string, string> = {};
  data?.locationDirectory?.forEach((item) => {
    if (item.center_id && item.center_name) map[item.center_id] = item.center_name;
  });
  data?.locations?.forEach((item) => {
    const name = item.location_name || item.center_name;
    if (item.center_id && name) map[item.center_id] = name;
  });
  return map;
}
