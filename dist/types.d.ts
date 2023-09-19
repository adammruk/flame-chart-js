import { ChartPoints, ChartStyle } from './plugins/utils/chart-render';
export declare const EVENT_NAMES: readonly ["down", "up", "move", "click", "select"];
export interface Mark {
    shortName: string;
    fullName: string;
    timestamp: number;
    color: string;
}
export type Marks = Array<Mark>;
export interface FlameChartNode {
    name: string;
    start: number;
    duration: number;
    type?: string;
    color?: string;
    children?: FlameChartNode[];
}
export type FlameChartNodes = FlameChartNode[];
export type WaterfallItems = WaterfallItem[];
export type WaterfallItem = {
    name: string;
    intervals: WaterfallInterval[] | string;
    timing: {
        [key: string]: number;
    };
    meta?: WaterfallItemMeta[];
};
export type WaterfallItemMeta = {
    name: string;
    value: string;
    color: string;
};
export type WaterfallInterval = {
    name: string;
    color: string;
    type: 'block' | 'line';
    start: string | number;
    end: string | number;
};
export interface WaterfallIntervals {
    [intervalName: string]: WaterfallInterval[];
}
export interface Waterfall {
    items: WaterfallItems;
    intervals: WaterfallIntervals;
}
export type Colors = Record<string, string>;
export interface Mouse {
    x: number;
    y: number;
}
interface Dot {
    x: number;
    y: number;
}
export type Dots = [Dot, Dot, Dot];
interface Rect {
    x: number;
    y: number;
    w: number;
}
export interface RectRenderQueue {
    [color: string]: Rect[];
}
export interface Text {
    text: string;
    x: number;
    y: number;
    w: number;
    textMaxWidth: number;
}
export interface Stroke {
    color: string;
    x: number;
    y: number;
    w: number;
    h: number;
}
export type FlatTreeNode = {
    source: FlameChartNode;
    end: number;
    parent: FlatTreeNode | null;
    level: number;
    index: number;
};
export type FlatTree = FlatTreeNode[];
export interface MetaClusterizedFlatTreeNode {
    nodes: FlatTreeNode[];
}
export type MetaClusterizedFlatTree = MetaClusterizedFlatTreeNode[];
export interface ClusterizedFlatTreeNode {
    start: number;
    end: number;
    duration: number;
    type?: string;
    color?: string;
    level: number;
    nodes: FlatTreeNode[];
}
export type ClusterizedFlatTree = ClusterizedFlatTreeNode[];
export interface TooltipField {
    color?: string;
    text: string;
}
export declare const enum RegionTypes {
    WATERFALL_NODE = "waterfall-node",
    CLUSTER = "cluster",
    TIMEFRAME = "timeframe",
    TIMEFRAME_AREA = "timeframeArea",
    TIMEFRAME_KNOB = "timeframeKnob",
    KNOB_RESIZE = "knob-resize",
    TOGGLE = "toggle",
    TIMESTAMP = "timestamp",
    TIMESERIES = "timeseries"
}
export declare const enum CursorTypes {
    TEXT = "text",
    ROW_RESIZE = "row-resize",
    POINTER = "pointer",
    EW_RESIZE = "ew-resize",
    GRABBING = "grabbing"
}
export interface HitRegion<S = any> {
    type: RegionTypes;
    data: S;
    x: number;
    y: number;
    w: number;
    h: number;
    cursor?: CursorTypes;
    id?: number;
}
export type TimeseriesChart = {
    points: ChartPoints;
    group?: string;
    units?: string;
    name?: string;
    style?: Partial<ChartStyle>;
    min?: number;
    max?: number;
    dynamicMinMax?: boolean;
};
export type Timeseries = TimeseriesChart[];
export {};