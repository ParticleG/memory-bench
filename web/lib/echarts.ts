import * as echarts from 'echarts/core';
import { BarChart, CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import type {
  BarSeriesOption,
  CustomSeriesOption,
  HeatmapSeriesOption,
  LineSeriesOption,
  ScatterSeriesOption,
} from 'echarts/charts';
import type {
  AriaComponentOption,
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
  VisualMapComponentOption,
} from 'echarts/components';
import type { ComposeOption } from 'echarts/core';
import type { CustomSeriesRenderItem } from 'echarts';
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { LabelLayout } from 'echarts/features';

echarts.use([
  BarChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
  LabelLayout,
]);

export { echarts };
export type {
  CustomSeriesRenderItem,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  CustomSeriesRenderItemReturn,
} from 'echarts';

/** Draw a vertical confidence-interval bar at a numeric x coordinate. */
export function verticalCiRenderer(color: string): CustomSeriesRenderItem {
  return (_params, api) => {
    const x = Number(api.value(0));
    const lowPoint = api.coord([x, Number(api.value(1))]);
    const highPoint = api.coord([x, Number(api.value(2))]);
    return {
      type: 'line',
      shape: {
        x1: lowPoint[0],
        y1: lowPoint[1],
        x2: highPoint[0],
        y2: highPoint[1],
      },
      style: {
        stroke: color,
        lineWidth: 1.5,
        opacity: 0.8,
      },
    };
  };
}

export type DashboardSeriesOption =
  | BarSeriesOption
  | CustomSeriesOption
  | HeatmapSeriesOption
  | LineSeriesOption
  | ScatterSeriesOption;

export type DashboardOption = ComposeOption<
  | DashboardSeriesOption
  | AriaComponentOption
  | DataZoomComponentOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | VisualMapComponentOption
>;

export const CHART_FONT =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const TOOLTIP_STYLE = {
  backgroundColor: 'rgba(15, 20, 31, 0.97)',
  borderColor: '#2b3850',
  borderWidth: 1,
  padding: [8, 10] as [number, number],
  textStyle: { color: '#e6edf7', fontSize: 12, fontFamily: CHART_FONT },
  extraCssText: 'box-shadow: 0 8px 28px rgba(0,0,0,.45); border-radius: 8px;',
};
