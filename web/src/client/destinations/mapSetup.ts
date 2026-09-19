// Loaded on demand by WorldMap (a separate chunk): the ECharts map series and
// the bundled world outline, Natural Earth 1:110m admin-0 countries (public
// domain), cut to a `name` and ISO alpha-2 `cc` per feature, coordinates
// rounded to 0.01°, Antarctica left out. Nothing is fetched at runtime.
import { MapChart } from 'echarts/charts';
import { echarts } from '../charts/echarts.ts';
import world from './world.json';

echarts.use([MapChart]);
echarts.registerMap('world', world as any);

export const MAP_NAME = 'world';

/** The country codes the map can color; traffic elsewhere is listed under it. */
export const MAP_CCS: ReadonlySet<string> = new Set(world.features.map((f) => f.properties.cc).filter((cc): cc is string => !!cc));
