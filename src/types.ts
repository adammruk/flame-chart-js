interface Mark {
    shortName: string;
    fullName: string;
    timestamp: number;
    color: string;
}

export type Marks = Array<Mark>;

export interface Node {
    name: string; // node name
    start: number; // node start time
    duration: number; // node duration
    type?: string; // node type (use it for custom colorization)
    color?: string; // node color (use it for current node colorization)
    children?: Array<Node>; // node children (same structure as for node)
}

export type Data = Array<Node>;

type WaterfallItems = Array<{
    name: string;
    intervals: string | WaterfallInterval;
    timing: {
        [key: string]: number;
    };
}>;

type WaterfallInterval = {
    name: string;
    color: string;
    type: 'block' | 'line';
    start: string; // timing name
    end: string; // timing name
};

interface WaterfallIntervals {
    [intervalName: string]: WaterfallInterval;
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