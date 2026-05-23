import { useQuery } from '@tanstack/react-query';
import { worldTicksKey } from '@/lib/queryKeys';
import type { UITick } from '@/types';

export default function useWorldTicks() {
  const result = useQuery<UITick[] | null>(worldTicksKey as any, {
    staleTime: 500,
    select: (data: UITick[] | null) => data || [],
  });

  return result;
}
