// The one place ECharts modules are registered. Import `echarts` from here,
// never from 'echarts' itself, so the bundle only carries what is listed.
// A chart that needs another series type or component adds it below.
import * as echarts from 'echarts/core';
import { BarChart, HeatmapChart, LineChart, SankeyChart, ScatterChart, SunburstChart, TreemapChart } from 'echarts/charts';
import {
  AriaComponent,
  BrushComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapContinuousComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  SankeyChart,
  // History's process start/end marker track (12).
  ScatterChart,
  // History's hour × weekday heatmap (06), colored by a continuous visualMap.
  HeatmapChart,
  VisualMapContinuousComponent,
  // History's uid → process → app treemap (07) and its sunburst view.
  TreemapChart,
  SunburstChart,
  AriaComponent,
  BrushComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  // The brush (History throughput's drag-to-zoom) needs it registered; no toolbox is shown.
  ToolboxComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };
export type { EChartsType } from 'echarts/core';
export type { EChartsCoreOption } from 'echarts/core';
