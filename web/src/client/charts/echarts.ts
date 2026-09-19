// The one place ECharts modules are registered. Import `echarts` from here,
// never from 'echarts' itself, so the bundle only carries what is listed.
// A chart that needs another series type or component adds it below.
import * as echarts from 'echarts/core';
import { BarChart, LineChart, SankeyChart } from 'echarts/charts';
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
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  SankeyChart,
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
