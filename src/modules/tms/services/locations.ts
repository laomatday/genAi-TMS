import { supabase } from '@/core/supabase';
import type { Location } from '@/shared/types';

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export async function getActiveLocations() {
  const { data, error } = await supabase.from('locations').select('*').eq('active', true).order('center_name');
  throwIfError(error);
  return (data || []) as Location[];
}
