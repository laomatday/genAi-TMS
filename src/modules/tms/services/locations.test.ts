import { describe, expect, it } from 'vitest';
import type { DashboardData } from '@/shared/types';
import { buildLocationNameMap } from './locations';

type NameMapInput = Pick<DashboardData, 'locations' | 'locationDirectory'>;

// `locations` mirrors metadata.locations: only branches that are active AND inside the
// viewer's geofence scope. `locationDirectory` mirrors directory_context.locations:
// every branch of the organization, labels only.
const DATA: NameMapInput = {
  locations: [
    {
      center_id: 'DN1',
      location_name: 'Đà Nẵng 1',
      center_name: 'Đà Nẵng 1',
      latitude: 16.07,
      longitude: 108.21,
      radius_meters: 200,
      active: true,
    },
  ],
  locationDirectory: [
    { center_id: 'DN1', center_name: 'Đà Nẵng 1', city: 'Đà Nẵng', active: true },
    { center_id: 'AQX', center_name: 'Army Quảng Xương', city: 'Thanh Hóa', active: false },
    { center_id: 'ATH1', center_name: 'Army Thanh Hóa 1', city: 'Thanh Hóa', active: false },
  ],
};

describe('buildLocationNameMap', () => {
  it('names a branch the viewer can also see in the geofence list', () => {
    expect(buildLocationNameMap(DATA).DN1).toBe('Đà Nẵng 1');
  });

  it('names inactive and out-of-scope branches, which the geofence list omits', () => {
    const map = buildLocationNameMap(DATA);
    expect(map.AQX).toBe('Army Quảng Xương');
    expect(map.ATH1).toBe('Army Thanh Hóa 1');
  });

  it('leaves an unknown branch unmapped so callers can fall back to the code', () => {
    expect(buildLocationNameMap(DATA).TEST).toBeUndefined();
  });

  it('tolerates a bundle from a server that has no directory context yet', () => {
    expect(buildLocationNameMap({ locations: DATA.locations, locationDirectory: [] })).toEqual({ DN1: 'Đà Nẵng 1' });
    expect(buildLocationNameMap(null)).toEqual({});
  });
});
