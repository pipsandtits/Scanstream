import { useQuery } from '@tanstack/react-query';
import { marketFramesKey } from '@/lib/queryKeys';

export default function useMarketFrames(exchange = 'default') {
  const key = marketFramesKey(exchange);
  const result = useQuery(key as any, {
    // queryFn will be the default getQueryFn from queryClient which joins the key
    // consumers can invalidate/refetch via queryClient.invalidateQueries(key)
    staleTime: 1000, // short-lived stale so realtime deltas keep UI fresh
  });

  return result;
}
