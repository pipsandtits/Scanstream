import React, { useEffect, useState } from 'react';

const Loader: React.FC = () => (
  <div className="flex items-center justify-center h-full">
    <div className="flex items-center space-x-2">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
      <span className="text-gray-600">Loading chart...</span>
    </div>
  </div>
);

export default function ApexChartWrapper(props: any) {
  const { options, series, type = 'line', height } = props;
  const [ChartComp, setChartComp] = useState<any | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const mod = await import('react-apexcharts');
        if (mounted) setChartComp(() => (mod.default || mod));
      } catch (err) {
        console.error('ApexChartWrapper: failed to load react-apexcharts', err);
      }
    })();
    return () => { mounted = false; };
  }, []);

  if (!ChartComp) return <Loader />;

  return (
    <ChartComp options={options} series={series} type={type} height={height} />
  );
}
