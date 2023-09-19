
/**
* @license
* author: Nikolay Ryabov
* flame-chart-js v2.3.1
* Released under the MIT license.
*/

import { EventEmitter } from 'events';
import Color from 'color';

class UIPlugin extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
    }
    init(renderEngine, interactionsEngine) {
        this.renderEngine = renderEngine;
        this.interactionsEngine = interactionsEngine;
    }
}

const mergeObjects = (defaultStyles, styles = {}) => Object.keys(defaultStyles).reduce((acc, key) => {
    if (styles[key]) {
        acc[key] = styles[key];
    }
    else {
        acc[key] = defaultStyles[key];
    }
    return acc;
}, {});
const isNumber = (val) => typeof val === 'number';
const last = (array) => array[array.length - 1];

const MIN_BLOCK_SIZE = 1;
const STICK_DISTANCE = 0.25;
const MIN_CLUSTER_SIZE = MIN_BLOCK_SIZE * 2 + STICK_DISTANCE;
const walk = (treeList, cb, parent = null, level = 0) => {
    treeList.forEach((child) => {
        const res = cb(child, parent, level);
        if (child.children) {
            walk(child.children, cb, res || child, level + 1);
        }
    });
};
const flatTree = (treeList) => {
    const result = [];
    let index = 0;
    walk(treeList, (node, parent, level) => {
        const newNode = {
            source: node,
            end: node.start + node.duration,
            parent,
            level,
            index: index++,
        };
        result.push(newNode);
        return newNode;
    });
    return result.sort((a, b) => a.level - b.level || a.source.start - b.source.start);
};
const getFlatTreeMinMax = (flatTree) => {
    let isFirst = true;
    let min = 0;
    let max = 0;
    flatTree.forEach(({ source: { start }, end }) => {
        if (isFirst) {
            min = start;
            max = end;
            isFirst = false;
        }
        else {
            min = min < start ? min : start;
            max = max > end ? max : end;
        }
    });
    return { min, max };
};
const calcClusterDuration = (nodes) => {
    const firstNode = nodes[0];
    const lastNode = last(nodes);
    return lastNode.source.start + lastNode.source.duration - firstNode.source.start;
};
const checkNodeTimeboundNesting = (node, start, end) => (node.source.start < end && node.end > start) || (node.source.start > start && node.end < end);
const checkClusterTimeboundNesting = (node, start, end) => (node.start < end && node.end > start) || (node.start > start && node.end < end);
const defaultClusterizeCondition = (prevNode, node) => prevNode.source.color === node.source.color && prevNode.source.type === node.source.type;
function metaClusterizeFlatTree(flatTree, condition = defaultClusterizeCondition) {
    return flatTree
        .reduce((acc, node) => {
        const lastCluster = last(acc);
        const lastNode = lastCluster && last(lastCluster);
        if (lastNode && lastNode.level === node.level && condition(lastNode, node)) {
            lastCluster.push(node);
        }
        else {
            acc.push([node]);
        }
        return acc;
    }, [])
        .filter((nodes) => nodes.length)
        .map((nodes) => ({
        nodes,
    }));
}
const clusterizeFlatTree = (metaClusterizedFlatTree, zoom, start = 0, end = 0, stickDistance = STICK_DISTANCE, minBlockSize = MIN_BLOCK_SIZE) => {
    let lastCluster = null;
    let lastNode = null;
    let index = 0;
    return metaClusterizedFlatTree
        .reduce((acc, { nodes }) => {
        lastCluster = null;
        lastNode = null;
        index = 0;
        for (const node of nodes) {
            if (checkNodeTimeboundNesting(node, start, end)) {
                if (lastCluster && !lastNode) {
                    lastCluster[index] = node;
                    index++;
                }
                else if (lastCluster &&
                    lastNode &&
                    (node.source.start - (lastNode.source.start + lastNode.source.duration)) * zoom <
                        stickDistance &&
                    node.source.duration * zoom < minBlockSize &&
                    lastNode.source.duration * zoom < minBlockSize) {
                    lastCluster[index] = node;
                    index++;
                }
                else {
                    lastCluster = [node];
                    index = 1;
                    acc.push(lastCluster);
                }
                lastNode = node;
            }
        }
        return acc;
    }, [])
        .map((nodes) => {
        const node = nodes[0];
        const duration = calcClusterDuration(nodes);
        return {
            start: node.source.start,
            end: node.source.start + duration,
            duration,
            type: node.source.type,
            color: node.source.color,
            level: node.level,
            nodes,
        };
    });
};
const reclusterizeClusteredFlatTree = (clusteredFlatTree, zoom, start, end, stickDistance, minBlockSize) => {
    return clusteredFlatTree.reduce((acc, cluster) => {
        if (checkClusterTimeboundNesting(cluster, start, end)) {
            if (cluster.duration * zoom <= MIN_CLUSTER_SIZE) {
                acc.push(cluster);
            }
            else {
                acc.push(...clusterizeFlatTree([cluster], zoom, start, end, stickDistance, minBlockSize));
            }
        }
        return acc;
    }, []);
};

const DEFAULT_COLOR = Color.hsl(180, 30, 70);
class FlameChartPlugin extends UIPlugin {
    constructor({ data, colors = {}, name = 'flameChartPlugin', }) {
        super(name);
        this.height = 0;
        this.flatTree = [];
        this.positionY = 0;
        this.colors = {};
        this.selectedRegion = null;
        this.hoveredRegion = null;
        this.lastRandomColor = DEFAULT_COLOR;
        this.metaClusterizedFlatTree = [];
        this.actualClusterizedFlatTree = [];
        this.initialClusterizedFlatTree = [];
        this.lastUsedColor = null;
        this.renderChartTimeout = -1;
        this.data = data;
        this.userColors = colors;
        this.parseData();
        this.reset();
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.interactionsEngine.on('change-position', this.handlePositionChange.bind(this));
        this.interactionsEngine.on('select', this.handleSelect.bind(this));
        this.interactionsEngine.on('hover', this.handleHover.bind(this));
        this.interactionsEngine.on('up', this.handleMouseUp.bind(this));
        this.initData();
    }
    handlePositionChange({ deltaX, deltaY }) {
        const startPositionY = this.positionY;
        const startPositionX = this.renderEngine.parent.positionX;
        this.interactionsEngine.setCursor('grabbing');
        if (this.positionY + deltaY >= 0) {
            this.setPositionY(this.positionY + deltaY);
        }
        else {
            this.setPositionY(0);
        }
        this.renderEngine.tryToChangePosition(deltaX);
        if (startPositionX !== this.renderEngine.parent.positionX || startPositionY !== this.positionY) {
            this.renderEngine.parent.render();
        }
    }
    handleMouseUp() {
        this.interactionsEngine.clearCursor();
    }
    setPositionY(y) {
        this.positionY = y;
    }
    reset() {
        this.colors = {};
        this.lastRandomColor = DEFAULT_COLOR;
        this.positionY = 0;
        this.selectedRegion = null;
    }
    calcMinMax() {
        const { flatTree } = this;
        const { min, max } = getFlatTreeMinMax(flatTree);
        this.min = min;
        this.max = max;
    }
    handleSelect(region) {
        var _a, _b;
        const selectedRegion = this.findNodeInCluster(region);
        if (this.selectedRegion !== selectedRegion) {
            this.selectedRegion = selectedRegion;
            this.renderEngine.render();
            this.emit('select', { node: (_b = (_a = this.selectedRegion) === null || _a === void 0 ? void 0 : _a.data) !== null && _b !== void 0 ? _b : null, type: 'flame-chart-node' });
        }
    }
    handleHover(region) {
        this.hoveredRegion = this.findNodeInCluster(region);
    }
    findNodeInCluster(region) {
        const mouse = this.interactionsEngine.getMouse();
        if (region && region.type === "cluster" /* RegionTypes.CLUSTER */) {
            const hoveredNode = region.data.nodes.find(({ level, source: { start, duration } }) => {
                const { x, y, w } = this.calcRect(start, duration, level);
                return mouse.x >= x && mouse.x <= x + w && mouse.y >= y && mouse.y <= y + this.renderEngine.blockHeight;
            });
            if (hoveredNode) {
                return {
                    data: hoveredNode,
                    type: 'node',
                };
            }
        }
        return null;
    }
    getColor(type = '_default', defaultColor) {
        if (defaultColor) {
            return defaultColor;
        }
        else if (this.colors[type]) {
            return this.colors[type];
        }
        else if (this.userColors[type]) {
            const color = new Color(this.userColors[type]);
            this.colors[type] = color.rgb().toString();
            return this.colors[type];
        }
        this.lastRandomColor = this.lastRandomColor.rotate(27);
        this.colors[type] = this.lastRandomColor.rgb().toString();
        return this.colors[type];
    }
    setData(data) {
        this.data = data;
        this.parseData();
        this.initData();
        this.reset();
        this.renderEngine.recalcMinMax();
        this.renderEngine.resetParentView();
    }
    parseData() {
        this.flatTree = flatTree(this.data);
        this.calcMinMax();
    }
    initData() {
        this.metaClusterizedFlatTree = metaClusterizeFlatTree(this.flatTree);
        this.initialClusterizedFlatTree = clusterizeFlatTree(this.metaClusterizedFlatTree, this.renderEngine.zoom, this.min, this.max);
        this.reclusterizeClusteredFlatTree();
    }
    reclusterizeClusteredFlatTree() {
        this.actualClusterizedFlatTree = reclusterizeClusteredFlatTree(this.initialClusterizedFlatTree, this.renderEngine.zoom, this.renderEngine.positionX, this.renderEngine.positionX + this.renderEngine.getRealView());
    }
    calcRect(start, duration, level) {
        const w = duration * this.renderEngine.zoom;
        return {
            x: this.renderEngine.timeToPosition(start),
            y: level * (this.renderEngine.blockHeight + 1) - this.positionY,
            w: w <= 0.1 ? 0.1 : w >= 3 ? w - 1 : w - w / 3,
        };
    }
    renderTooltip() {
        if (this.hoveredRegion) {
            if (this.renderEngine.options.tooltip === false) {
                return true;
            }
            else if (typeof this.renderEngine.options.tooltip === 'function') {
                this.renderEngine.options.tooltip(this.hoveredRegion, this.renderEngine, this.interactionsEngine.getGlobalMouse());
            }
            else {
                const { data: { source: { start, duration, name, children }, }, } = this.hoveredRegion;
                const timeUnits = this.renderEngine.getTimeUnits();
                const selfTime = duration - (children ? children.reduce((acc, { duration }) => acc + duration, 0) : 0);
                const nodeAccuracy = this.renderEngine.getAccuracy() + 2;
                const header = `${name}`;
                const dur = `duration: ${duration.toFixed(nodeAccuracy)} ${timeUnits} ${(children === null || children === void 0 ? void 0 : children.length) ? `(self ${selfTime.toFixed(nodeAccuracy)} ${timeUnits})` : ''}`;
                const st = `start: ${start.toFixed(nodeAccuracy)}`;
                this.renderEngine.renderTooltipFromData([{ text: header }, { text: dur }, { text: st }], this.interactionsEngine.getGlobalMouse());
            }
            return true;
        }
        return false;
    }
    render() {
        const { width, blockHeight, height, minTextWidth } = this.renderEngine;
        this.lastUsedColor = null;
        this.reclusterizeClusteredFlatTree();
        const processCluster = (cb) => {
            return (cluster) => {
                const { start, duration, level } = cluster;
                const { x, y, w } = this.calcRect(start, duration, level);
                if (x + w > 0 && x < width && y + blockHeight > 0 && y < height) {
                    cb(cluster, x, y, w);
                }
            };
        };
        const renderCluster = (cluster, x, y, w) => {
            const { type, nodes, color } = cluster;
            const mouse = this.interactionsEngine.getMouse();
            if (mouse.y >= y && mouse.y <= y + blockHeight) {
                addHitRegion(cluster, x, y, w);
            }
            if (w >= 0.25) {
                this.renderEngine.addRectToRenderQueue(this.getColor(type, color), x, y, w);
            }
            if (w >= minTextWidth && nodes.length === 1) {
                this.renderEngine.addTextToRenderQueue(nodes[0].source.name, x, y, w);
            }
        };
        const addHitRegion = (cluster, x, y, w) => {
            this.interactionsEngine.addHitRegion("cluster" /* RegionTypes.CLUSTER */, cluster, x, y, w, blockHeight);
        };
        this.actualClusterizedFlatTree.forEach(processCluster(renderCluster));
        if (this.selectedRegion && this.selectedRegion.type === 'node') {
            const { source: { start, duration }, level, } = this.selectedRegion.data;
            const { x, y, w } = this.calcRect(start, duration, level);
            this.renderEngine.addStrokeToRenderQueue('green', x, y, w, this.renderEngine.blockHeight);
        }
        clearTimeout(this.renderChartTimeout);
        this.renderChartTimeout = window.setTimeout(() => {
            this.interactionsEngine.clearHitRegions();
            this.actualClusterizedFlatTree.forEach(processCluster(addHitRegion));
        }, 16);
    }
}

const defaultTimeGridPluginStyles = {
    font: '10px sans-serif',
    fontColor: 'black',
};
class TimeGridPlugin extends UIPlugin {
    constructor(settings = {}) {
        super('timeGridPlugin');
        this.styles = defaultTimeGridPluginStyles;
        this.height = 0;
        this.setSettings(settings);
    }
    setSettings({ styles }) {
        this.styles = mergeObjects(defaultTimeGridPluginStyles, styles);
        if (this.renderEngine) {
            this.overrideEngineSettings();
        }
    }
    overrideEngineSettings() {
        this.renderEngine.setSettingsOverrides({ styles: this.styles });
        this.height = Math.round(this.renderEngine.charHeight + 10);
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.overrideEngineSettings();
    }
    render() {
        this.renderEngine.parent.timeGrid.renderTimes(this.renderEngine);
        this.renderEngine.parent.timeGrid.renderLines(0, this.renderEngine.height, this.renderEngine);
        return true;
    }
}

class MarksPlugin extends UIPlugin {
    constructor({ data, name = 'marksPlugin' }) {
        super(name);
        this.hoveredRegion = null;
        this.selectedRegion = null;
        this.marks = this.prepareMarks(data);
        this.calcMinMax();
    }
    calcMinMax() {
        const { marks } = this;
        if (marks.length) {
            this.min = marks.reduce((acc, { timestamp }) => (timestamp < acc ? timestamp : acc), marks[0].timestamp);
            this.max = marks.reduce((acc, { timestamp }) => (timestamp > acc ? timestamp : acc), marks[0].timestamp);
        }
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.interactionsEngine.on('hover', this.handleHover.bind(this));
        this.interactionsEngine.on('select', this.handleSelect.bind(this));
    }
    handleHover(region) {
        this.hoveredRegion = region;
    }
    handleSelect(region) {
        var _a;
        if (this.selectedRegion !== region) {
            this.selectedRegion = region;
            this.emit('select', { node: (_a = region === null || region === void 0 ? void 0 : region.data) !== null && _a !== void 0 ? _a : null, type: 'mark' });
            this.renderEngine.render();
        }
    }
    get height() {
        return this.renderEngine.blockHeight + 2;
    }
    prepareMarks(marks) {
        return marks
            .map(({ color, ...rest }) => ({
            ...rest,
            color: new Color(color).alpha(0.7).rgb().toString(),
        }))
            .sort((a, b) => a.timestamp - b.timestamp);
    }
    setMarks(marks) {
        this.marks = this.prepareMarks(marks);
        this.calcMinMax();
        this.renderEngine.recalcMinMax();
        this.renderEngine.resetParentView();
    }
    calcMarksBlockPosition(position, prevEnding) {
        if (position > 0) {
            if (prevEnding > position) {
                return prevEnding;
            }
            return position;
        }
        return position;
    }
    render() {
        this.marks.reduce((prevEnding, node) => {
            const { timestamp, color, shortName } = node;
            const { width } = this.renderEngine.ctx.measureText(shortName);
            const fullWidth = width + this.renderEngine.blockPaddingLeftRight * 2;
            const position = this.renderEngine.timeToPosition(timestamp);
            const blockPosition = this.calcMarksBlockPosition(position, prevEnding);
            this.renderEngine.addRectToRenderQueue(color, blockPosition, 1, fullWidth);
            this.renderEngine.addTextToRenderQueue(shortName, blockPosition, 1, fullWidth);
            this.interactionsEngine.addHitRegion("timestamp" /* RegionTypes.TIMESTAMP */, node, blockPosition, 1, fullWidth, this.renderEngine.blockHeight);
            return blockPosition + fullWidth;
        }, 0);
    }
    postRender() {
        this.marks.forEach((node) => {
            const { timestamp, color } = node;
            const position = this.renderEngine.timeToPosition(timestamp);
            this.renderEngine.parent.setCtxValue('strokeStyle', color);
            this.renderEngine.parent.setCtxValue('lineWidth', 1);
            this.renderEngine.parent.callCtx('setLineDash', [8, 7]);
            this.renderEngine.parent.ctx.beginPath();
            this.renderEngine.parent.ctx.moveTo(position, this.renderEngine.position);
            this.renderEngine.parent.ctx.lineTo(position, this.renderEngine.parent.height);
            this.renderEngine.parent.ctx.stroke();
        });
    }
    renderTooltip() {
        if (this.hoveredRegion && this.hoveredRegion.type === 'timestamp') {
            if (this.renderEngine.options.tooltip === false) {
                return true;
            }
            else if (typeof this.renderEngine.options.tooltip === 'function') {
                this.renderEngine.options.tooltip(this.hoveredRegion, this.renderEngine, this.interactionsEngine.getGlobalMouse());
            }
            else {
                const { data: { fullName, timestamp }, } = this.hoveredRegion;
                const marksAccuracy = this.renderEngine.getAccuracy() + 2;
                const header = `${fullName}`;
                const time = `${timestamp.toFixed(marksAccuracy)} ${this.renderEngine.timeUnits}`;
                this.renderEngine.renderTooltipFromData([{ text: header }, { text: time }], this.interactionsEngine.getGlobalMouse());
            }
            return true;
        }
        return false;
    }
}

const MIN_PIXEL_DELTA = 85;
const defaultTimeGridStyles = {
    color: 'rgba(90,90,90,0.20)',
};
class TimeGrid {
    constructor(settings) {
        this.styles = defaultTimeGridStyles;
        this.timeUnits = 'ms';
        this.start = 0;
        this.end = 0;
        this.accuracy = 0;
        this.delta = 0;
        this.setSettings(settings);
    }
    setDefaultRenderEngine(renderEngine) {
        this.renderEngine = renderEngine;
        this.timeUnits = this.renderEngine.getTimeUnits();
    }
    setSettings({ styles }) {
        this.styles = mergeObjects(defaultTimeGridStyles, styles);
        if (this.renderEngine) {
            this.timeUnits = this.renderEngine.getTimeUnits();
        }
    }
    recalc() {
        const timeWidth = this.renderEngine.max - this.renderEngine.min;
        const initialLinesCount = this.renderEngine.width / MIN_PIXEL_DELTA;
        const initialTimeLineDelta = timeWidth / initialLinesCount;
        const realView = this.renderEngine.getRealView();
        const proportion = realView / (timeWidth || 1);
        this.delta = initialTimeLineDelta / Math.pow(2, Math.floor(Math.log2(1 / proportion)));
        this.start = Math.floor((this.renderEngine.positionX - this.renderEngine.min) / this.delta);
        this.end = Math.ceil(realView / this.delta) + this.start;
        this.accuracy = this.calcNumberFix();
    }
    calcNumberFix() {
        var _a;
        const strTimelineDelta = (this.delta / 2).toString();
        if (strTimelineDelta.includes('e')) {
            return Number((_a = strTimelineDelta.match(/\d+$/)) === null || _a === void 0 ? void 0 : _a[0]);
        }
        const zeros = strTimelineDelta.match(/(0\.0*)/);
        return zeros ? zeros[0].length - 1 : 0;
    }
    getTimelineAccuracy() {
        return this.accuracy;
    }
    forEachTime(cb) {
        for (let i = this.start; i <= this.end; i++) {
            const timePosition = i * this.delta + this.renderEngine.min;
            const pixelPosition = this.renderEngine.timeToPosition(Number(timePosition.toFixed(this.accuracy)));
            cb(pixelPosition, timePosition);
        }
    }
    renderLines(start, height, renderEngine = this.renderEngine) {
        renderEngine.setCtxValue('fillStyle', this.styles.color);
        this.forEachTime((pixelPosition) => {
            renderEngine.fillRect(pixelPosition, start, 1, height);
        });
    }
    renderTimes(renderEngine = this.renderEngine) {
        renderEngine.setCtxValue('fillStyle', renderEngine.styles.fontColor);
        renderEngine.setCtxFont(renderEngine.styles.font);
        this.forEachTime((pixelPosition, timePosition) => {
            renderEngine.fillText(timePosition.toFixed(this.accuracy) + this.timeUnits, pixelPosition + renderEngine.blockPaddingLeftRight, renderEngine.charHeight);
        });
    }
}

function getValueByChoice(array, property, comparator, defaultValue) {
    if (array.length) {
        return array.reduce((acc, { [property]: value }) => comparator(acc, value), array[0][property]);
    }
    return defaultValue;
}
const parseWaterfall = (waterfall) => {
    return waterfall.items
        .map(({ name, intervals, timing, meta }, index) => {
        const resolvedIntervals = typeof intervals === 'string' ? waterfall.intervals[intervals] : intervals;
        const preparedIntervals = resolvedIntervals
            .map(({ start, end, color, type, name }) => ({
            start: typeof start === 'string' ? timing[start] : start,
            end: typeof end === 'string' ? timing[end] : end,
            color,
            name,
            type,
        }))
            .filter(({ start, end }) => typeof start === 'number' && typeof end === 'number');
        const blocks = preparedIntervals.filter(({ type }) => type === 'block');
        const blockStart = getValueByChoice(blocks, 'start', Math.min, 0);
        const blockEnd = getValueByChoice(blocks, 'end', Math.max, 0);
        const min = getValueByChoice(preparedIntervals, 'start', Math.min, 0);
        const max = getValueByChoice(preparedIntervals, 'end', Math.max, 0);
        return {
            intervals: preparedIntervals,
            textBlock: {
                start: blockStart,
                end: blockEnd,
            },
            name,
            timing,
            min,
            max,
            index,
            meta,
        };
    })
        .filter(({ intervals }) => intervals.length)
        .sort((a, b) => a.min - b.min || b.max - a.max);
};

const castLevelToHeight = (level, minLevel, levelHeight, totalheight) => {
    return totalheight - (level - minLevel) * levelHeight;
};
const defaultChartStyle = {
    fillColor: 'rgba(0, 0, 0, 0.1)',
    lineWidth: 1,
    lineDash: [],
    lineColor: 'rgba(0, 0, 0, 0.5)',
    type: 'smooth',
};
const prepareTmeseries = (timeseries) => {
    const timeboxes = [];
    const preparedTimeseries = timeseries.map((chart) => {
        var _a;
        return ({
            group: chart.units && !chart.group ? chart.units : 'default',
            ...chart,
            style: {
                lineWidth: 1,
                fillColor: 'rgba(0, 0, 0, 0.15)',
                lineColor: 'rgba(0, 0, 0, 0.20)',
                lineDash: [],
                type: 'smooth',
                ...((_a = chart.style) !== null && _a !== void 0 ? _a : {}),
            },
        });
    });
    const summary = preparedTimeseries.reduce((acc, { points, group, min, max }, index) => {
        if (!acc[group]) {
            acc[group] = {
                min: min !== null && min !== void 0 ? min : points[0][1],
                max: max !== null && max !== void 0 ? max : points[0][1],
            };
        }
        timeboxes[index] = {
            start: points[0][0],
            end: last(points)[0],
        };
        points.forEach(([time, value]) => {
            if (min === undefined) {
                acc[group].min = Math.min(acc[group].min, value);
            }
            if (max === undefined) {
                acc[group].max = Math.max(acc[group].max, value);
            }
            timeboxes[index].start = Math.min(timeboxes[index].start, time);
            timeboxes[index].end = Math.max(timeboxes[index].end, time);
        });
        return acc;
    }, {});
    const min = Math.min(...timeboxes.map(({ start }) => start));
    const max = Math.max(...timeboxes.map(({ end }) => end));
    return {
        summary,
        total: {
            min,
            max,
        },
        timeseries: preparedTimeseries,
        timeboxes: timeboxes,
    };
};
const getMinMax = (points, chart, summary) => {
    var _a, _b;
    return chart.dynamicMinMax
        ? points.reduce((acc, [, value]) => {
            acc.min = Math.min(acc.min, value);
            acc.max = Math.max(acc.max, value);
            return acc;
        }, { min: (_a = chart.min) !== null && _a !== void 0 ? _a : Infinity, max: (_b = chart.max) !== null && _b !== void 0 ? _b : -Infinity })
        : chart.group
            ? summary[chart.group]
            : {
                min: -Infinity,
                max: Infinity,
            };
};
const renderChartTooltipFields = (timestamp, { timeseries }) => {
    const targetPoints = timeseries.reduce((acc, { points, units, name, group }) => {
        const point = chartPointsBinarySearch(points, timestamp);
        const hasGroup = group !== units && group !== 'default';
        const resolvedGroup = hasGroup ? group : 'default';
        let result = '';
        if (point) {
            if (name) {
                result += name + ': ';
            }
            result += point[1].toFixed(2);
            if (units) {
                result += units;
            }
        }
        if (!acc[resolvedGroup]) {
            acc[resolvedGroup] = [];
        }
        acc[resolvedGroup].push(result);
        return acc;
    }, {});
    return Object.entries(targetPoints).reduce((acc, [group, values]) => {
        if (group !== 'default') {
            acc.push({
                text: group,
                color: 'black',
            });
        }
        values.forEach((value) => {
            acc.push({
                text: value,
            });
        });
        return acc;
    }, []);
};
const renderChart = ({ engine, points, style, min, max, }) => {
    const resolvedStyle = {
        ...defaultChartStyle,
        ...(style !== null && style !== void 0 ? style : {}),
    };
    engine.setCtxValue('strokeStyle', resolvedStyle.lineColor);
    engine.setCtxValue('fillStyle', resolvedStyle.fillColor);
    engine.setCtxValue('lineWidth', resolvedStyle.lineWidth);
    engine.callCtx('setLineDash', resolvedStyle.lineDash);
    engine.ctx.beginPath();
    const levelHeight = (engine.height - engine.charHeight - 4) / (max - min);
    if (points.length > 1) {
        const xy = points.map(([time, level]) => [
            engine.timeToPosition(time),
            castLevelToHeight(level, min, levelHeight, engine.height),
        ]);
        engine.ctx.moveTo(xy[0][0], engine.height);
        engine.ctx.lineTo(xy[0][0], xy[0][1]);
        if (resolvedStyle.type === 'smooth' || !resolvedStyle.type) {
            for (let i = 1; i < xy.length - 2; i++) {
                const xc = (xy[i][0] + xy[i + 1][0]) / 2;
                const yc = (xy[i][1] + xy[i + 1][1]) / 2;
                engine.ctx.quadraticCurveTo(xy[i][0], xy[i][1], xc, yc);
            }
            const preLastPoint = xy[xy.length - 2];
            const lastPoint = last(xy);
            engine.ctx.quadraticCurveTo(preLastPoint[0], preLastPoint[1], lastPoint[0], lastPoint[1]);
            engine.ctx.quadraticCurveTo(lastPoint[0], lastPoint[1], lastPoint[0], engine.height);
        }
        else if (resolvedStyle.type === 'line') {
            for (let i = 1; i < xy.length; i++) {
                engine.ctx.lineTo(xy[i][0], xy[i][1]);
            }
        }
        else if (resolvedStyle.type === 'bar') {
            for (let i = 0; i < xy.length; i++) {
                const currentPoint = xy[i];
                const prevPoint = xy[i - 1] || currentPoint;
                const nextPoint = xy[i + 1];
                const barWidthLeft = (currentPoint[0] - prevPoint[0]) / 2;
                const barWidthRight = nextPoint ? (nextPoint[0] - currentPoint[0]) / 2 : barWidthLeft;
                engine.ctx.lineTo(prevPoint[0] + barWidthLeft, currentPoint[1]);
                engine.ctx.lineTo(currentPoint[0] + barWidthRight, currentPoint[1]);
                if (nextPoint) {
                    engine.ctx.lineTo(currentPoint[0] + barWidthRight, nextPoint[1]);
                }
                else {
                    engine.ctx.lineTo(currentPoint[0] + barWidthRight, engine.height);
                }
            }
            engine.ctx.lineTo(last(xy)[0], engine.height);
        }
    }
    engine.ctx.closePath();
    engine.ctx.stroke();
    engine.ctx.fill();
};
const chartPointsBinarySearch = (array, value, outside = true) => {
    if (array[0][0] >= value) {
        return outside ? array[0] : null;
    }
    if (last(array)[0] <= value) {
        return outside ? last(array) : null;
    }
    if (array.length <= 1) {
        return array[0];
    }
    let start = 0;
    let end = array.length - 1;
    while (start <= end) {
        const mid = Math.ceil((end + start) / 2);
        if (value >= array[mid - 1][0] && value <= array[mid][0]) {
            const index = Math.abs(value - array[mid - 1][0]) < Math.abs(value - array[mid][0]) ? mid - 1 : mid;
            return array[index];
        }
        if (array[mid][0] < value) {
            start = mid + 1;
        }
        else {
            end = mid - 1;
        }
    }
    return null;
};

const TIMEFRAME_STICK_DISTANCE = 2;
const defaultTimeframeSelectorPluginStyles = {
    font: '9px sans-serif',
    fontColor: 'black',
    overlayColor: 'rgba(112, 112, 112, 0.5)',
    graphStrokeColor: 'rgba(0, 0, 0, 0.10)',
    graphFillColor: 'rgba(0, 0, 0, 0.15)',
    flameChartGraphType: 'smooth',
    waterfallStrokeOpacity: 0.4,
    waterfallFillOpacity: 0.35,
    waterfallGraphType: 'smooth',
    bottomLineColor: 'rgba(0, 0, 0, 0.25)',
    knobColor: 'rgb(131, 131, 131)',
    knobStrokeColor: 'white',
    knobSize: 6,
    height: 60,
    backgroundColor: 'white',
};
class TimeframeSelectorPlugin extends UIPlugin {
    constructor({ waterfall, flameChartNodes, timeseries, settings, name = 'timeframeSelectorPlugin', }) {
        super(name);
        this.styles = defaultTimeframeSelectorPluginStyles;
        this.height = 0;
        this.leftKnobMoving = false;
        this.rightKnobMoving = false;
        this.selectingActive = false;
        this.startSelectingPosition = 0;
        this.actualClusters = [];
        this.clusters = [];
        this.flameChartMaxLevel = 0;
        this.flameChartDots = [];
        this.waterfallDots = [];
        this.waterfallMaxLevel = 0;
        this.actualClusterizedFlatTree = [];
        this.hoveredRegion = null;
        this.flameChartNodes = flameChartNodes;
        this.waterfall = waterfall;
        this.timeseries = timeseries;
        this.shouldRender = true;
        this.setSettings(settings);
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.interactionsEngine.on('down', this.handleMouseDown.bind(this));
        this.interactionsEngine.on('up', this.handleMouseUp.bind(this));
        this.interactionsEngine.on('move', this.handleMouseMove.bind(this));
        this.interactionsEngine.on('hover', this.handleHover.bind(this));
        this.setSettings();
    }
    handleHover(region) {
        this.hoveredRegion = region;
    }
    handleMouseDown(region, mouse) {
        if (region) {
            if (region.type === "timeframeKnob" /* RegionTypes.TIMEFRAME_KNOB */) {
                if (region.data === 'left') {
                    this.leftKnobMoving = true;
                }
                else {
                    this.rightKnobMoving = true;
                }
                this.interactionsEngine.setCursor('ew-resize');
            }
            else if (region.type === "timeframeArea" /* RegionTypes.TIMEFRAME_AREA */) {
                this.selectingActive = true;
                this.startSelectingPosition = mouse.x;
            }
        }
    }
    handleMouseUp(_, mouse, isClick) {
        let isDoubleClick = false;
        if (this.timeout) {
            isDoubleClick = true;
        }
        clearTimeout(this.timeout);
        this.timeout = window.setTimeout(() => (this.timeout = void 0), 300);
        this.leftKnobMoving = false;
        this.rightKnobMoving = false;
        this.interactionsEngine.clearCursor();
        if (this.selectingActive && !isClick) {
            this.applyChanges();
        }
        this.selectingActive = false;
        if (isClick && !isDoubleClick) {
            const rightKnobPosition = this.getRightKnobPosition();
            const leftKnobPosition = this.getLeftKnobPosition();
            if (mouse.x > rightKnobPosition) {
                this.setRightKnobPosition(mouse.x);
            }
            else if (mouse.x > leftKnobPosition && mouse.x < rightKnobPosition) {
                if (mouse.x - leftKnobPosition > rightKnobPosition - mouse.x) {
                    this.setRightKnobPosition(mouse.x);
                }
                else {
                    this.setLeftKnobPosition(mouse.x);
                }
            }
            else {
                this.setLeftKnobPosition(mouse.x);
            }
            this.applyChanges();
        }
        if (isDoubleClick) {
            this.renderEngine.parent.setZoom(this.renderEngine.getInitialZoom());
            this.renderEngine.parent.setPositionX(this.renderEngine.min);
            this.renderEngine.parent.render();
        }
    }
    handleMouseMove(_, mouse) {
        if (this.leftKnobMoving) {
            this.setLeftKnobPosition(mouse.x);
            this.applyChanges();
        }
        if (this.rightKnobMoving) {
            this.setRightKnobPosition(mouse.x);
            this.applyChanges();
        }
        if (this.selectingActive) {
            if (this.startSelectingPosition >= mouse.x) {
                this.setLeftKnobPosition(mouse.x);
                this.setRightKnobPosition(this.startSelectingPosition);
            }
            else {
                this.setRightKnobPosition(mouse.x);
                this.setLeftKnobPosition(this.startSelectingPosition);
            }
            this.renderEngine.render();
        }
    }
    postInit() {
        this.offscreenRenderEngine = this.renderEngine.makeChild();
        this.offscreenRenderEngine.setSettingsOverrides({ styles: this.styles });
        this.timeGrid = new TimeGrid({ styles: this.renderEngine.parent.timeGrid.styles });
        this.timeGrid.setDefaultRenderEngine(this.offscreenRenderEngine);
        this.offscreenRenderEngine.on('resize', () => {
            this.offscreenRenderEngine.setZoom(this.renderEngine.getInitialZoom());
            this.offscreenRender();
        });
        this.offscreenRenderEngine.on('min-max-change', () => (this.shouldRender = true));
        this.setData({
            flameChartNodes: this.flameChartNodes,
            waterfall: this.waterfall,
            timeseries: this.timeseries,
        });
    }
    setLeftKnobPosition(mouseX) {
        const maxPosition = this.getRightKnobPosition();
        if (mouseX < maxPosition - 1) {
            const realView = this.renderEngine.getRealView();
            const delta = this.renderEngine.setPositionX(this.offscreenRenderEngine.pixelToTime(mouseX) + this.renderEngine.min);
            const zoom = this.renderEngine.width / (realView - delta);
            this.renderEngine.setZoom(zoom);
        }
    }
    setRightKnobPosition(mouseX) {
        const minPosition = this.getLeftKnobPosition();
        if (mouseX > minPosition + 1) {
            const realView = this.renderEngine.getRealView();
            const delta = this.renderEngine.positionX +
                realView -
                (this.offscreenRenderEngine.pixelToTime(mouseX) + this.renderEngine.min);
            const zoom = this.renderEngine.width / (realView - delta);
            this.renderEngine.setZoom(zoom);
        }
    }
    getLeftKnobPosition() {
        return (this.renderEngine.positionX - this.renderEngine.min) * this.renderEngine.getInitialZoom();
    }
    getRightKnobPosition() {
        return ((this.renderEngine.positionX - this.renderEngine.min + this.renderEngine.getRealView()) *
            this.renderEngine.getInitialZoom());
    }
    applyChanges() {
        this.renderEngine.parent.setPositionX(this.renderEngine.positionX);
        this.renderEngine.parent.setZoom(this.renderEngine.zoom);
        this.renderEngine.parent.render();
    }
    setSettings({ styles } = { styles: this.styles }) {
        this.styles = mergeObjects(defaultTimeframeSelectorPluginStyles, styles);
        this.height = this.styles.height;
        if (this.offscreenRenderEngine) {
            this.offscreenRenderEngine.setSettingsOverrides({ styles: this.styles });
            this.timeGrid.setSettings({ styles: this.renderEngine.parent.timeGrid.styles });
        }
        this.shouldRender = true;
    }
    makeFlameChartDots() {
        if (this.flameChartNodes) {
            const flameChartDots = [];
            const tree = flatTree(this.flameChartNodes);
            const { min, max } = getFlatTreeMinMax(tree);
            this.min = min;
            this.max = max;
            this.clusters = metaClusterizeFlatTree(tree, () => true);
            this.actualClusters = clusterizeFlatTree(this.clusters, this.renderEngine.zoom, this.min, this.max, TIMEFRAME_STICK_DISTANCE, Infinity);
            this.actualClusterizedFlatTree = reclusterizeClusteredFlatTree(this.actualClusters, this.renderEngine.zoom, this.min, this.max, TIMEFRAME_STICK_DISTANCE, Infinity).sort((a, b) => a.start - b.start);
            this.actualClusterizedFlatTree.forEach(({ start, end }) => {
                flameChartDots.push({
                    time: start,
                    type: 'start',
                }, {
                    time: end,
                    type: 'end',
                });
            });
            flameChartDots.sort((a, b) => a.time - b.time);
            const { dots, maxLevel } = this.makeRenderDots(flameChartDots);
            this.flameChartDots = dots;
            this.flameChartMaxLevel = maxLevel;
        }
    }
    makeRenderDots(dots) {
        const renderDots = [];
        let level = 0;
        let maxLevel = 0;
        dots.forEach(({ type, time }) => {
            if (type === 'start' || type === 'end') {
                renderDots.push([time, level]);
            }
            if (type === 'start') {
                level++;
            }
            else {
                level--;
            }
            maxLevel = Math.max(maxLevel, level);
            renderDots.push([time, level]);
        });
        return {
            dots: renderDots,
            maxLevel,
        };
    }
    makeWaterfallDots() {
        if (this.waterfall) {
            const data = parseWaterfall(this.waterfall);
            const intervals = Object.entries(data.reduce((acc, { intervals }) => {
                intervals.forEach((interval) => {
                    if (!acc[interval.color]) {
                        acc[interval.color] = [];
                    }
                    acc[interval.color].push(interval);
                });
                return acc;
            }, {}));
            const points = intervals.map(([color, intervals]) => {
                const newPoints = [];
                intervals.forEach(({ start, end }) => {
                    newPoints.push({ type: 'start', time: start });
                    newPoints.push({ type: 'end', time: end });
                });
                newPoints.sort((a, b) => a.time - b.time);
                return {
                    color,
                    points: newPoints,
                };
            });
            let globalMaxLevel = 0;
            this.waterfallDots = points.map(({ color, points }) => {
                const { dots, maxLevel } = this.makeRenderDots(points);
                globalMaxLevel = Math.max(globalMaxLevel, maxLevel);
                return {
                    color,
                    dots,
                };
            });
            this.waterfallMaxLevel = globalMaxLevel;
        }
    }
    prepareTimeseries() {
        var _a;
        if ((_a = this.timeseries) === null || _a === void 0 ? void 0 : _a.length) {
            this.preparedTimeseries = prepareTmeseries(this.timeseries);
        }
        else {
            this.preparedTimeseries = undefined;
        }
    }
    setData({ flameChartNodes, waterfall, timeseries, }) {
        this.flameChartNodes = flameChartNodes;
        this.waterfall = waterfall;
        this.timeseries = timeseries;
        this.makeFlameChartDots();
        this.makeWaterfallDots();
        this.prepareTimeseries();
        this.offscreenRender();
    }
    setTimeseries(timeseries) {
        this.timeseries = timeseries;
        this.prepareTimeseries();
        this.offscreenRender();
    }
    setFlameChartNodes(flameChartNodes) {
        this.flameChartNodes = flameChartNodes;
        this.makeFlameChartDots();
        this.offscreenRender();
    }
    setWaterfall(waterfall) {
        this.waterfall = waterfall;
        this.makeWaterfallDots();
        this.offscreenRender();
    }
    offscreenRender() {
        const zoom = this.offscreenRenderEngine.getInitialZoom();
        this.offscreenRenderEngine.setZoom(zoom);
        this.offscreenRenderEngine.setPositionX(this.offscreenRenderEngine.min);
        this.offscreenRenderEngine.clear();
        this.timeGrid.recalc();
        this.timeGrid.renderLines(0, this.offscreenRenderEngine.height);
        this.timeGrid.renderTimes();
        renderChart({
            engine: this.offscreenRenderEngine,
            points: this.flameChartDots,
            min: 0,
            max: this.flameChartMaxLevel,
            style: {
                lineColor: this.styles.graphStrokeColor,
                fillColor: this.styles.graphFillColor,
                type: this.styles.flameChartGraphType,
            },
        });
        this.waterfallDots.forEach(({ color, dots }) => {
            const colorObj = new Color(color);
            renderChart({
                engine: this.offscreenRenderEngine,
                points: dots,
                min: 0,
                max: this.waterfallMaxLevel,
                style: {
                    lineColor: colorObj.alpha(this.styles.waterfallStrokeOpacity).rgb().toString(),
                    fillColor: colorObj.alpha(this.styles.waterfallFillOpacity).rgb().toString(),
                    type: this.styles.waterfallGraphType,
                },
            });
        });
        if (this.preparedTimeseries) {
            const { summary, timeseries } = this.preparedTimeseries;
            timeseries.forEach((chart) => {
                const minmax = getMinMax(chart.points, chart, summary);
                renderChart({
                    engine: this.offscreenRenderEngine,
                    points: chart.points,
                    min: minmax.min,
                    max: minmax.max,
                    style: chart.style,
                });
            });
        }
        this.offscreenRenderEngine.setCtxValue('fillStyle', this.styles.bottomLineColor);
        this.offscreenRenderEngine.ctx.fillRect(0, this.height - 1, this.offscreenRenderEngine.width, 1);
    }
    renderTimeframe() {
        const relativePositionX = this.renderEngine.positionX - this.renderEngine.min;
        const currentLeftPosition = relativePositionX * this.renderEngine.getInitialZoom();
        const currentRightPosition = (relativePositionX + this.renderEngine.getRealView()) * this.renderEngine.getInitialZoom();
        const currentLeftKnobPosition = currentLeftPosition - this.styles.knobSize / 2;
        const currentRightKnobPosition = currentRightPosition - this.styles.knobSize / 2;
        const knobHeight = this.renderEngine.height / 3;
        this.renderEngine.setCtxValue('fillStyle', this.styles.overlayColor);
        this.renderEngine.fillRect(0, 0, currentLeftPosition, this.renderEngine.height);
        this.renderEngine.fillRect(currentRightPosition, 0, this.renderEngine.width - currentRightPosition, this.renderEngine.height);
        this.renderEngine.setCtxValue('fillStyle', this.styles.overlayColor);
        this.renderEngine.fillRect(currentLeftPosition - 1, 0, 1, this.renderEngine.height);
        this.renderEngine.fillRect(currentRightPosition + 1, 0, 1, this.renderEngine.height);
        this.renderEngine.setCtxValue('fillStyle', this.styles.knobColor);
        this.renderEngine.fillRect(currentLeftKnobPosition, 0, this.styles.knobSize, knobHeight);
        this.renderEngine.fillRect(currentRightKnobPosition, 0, this.styles.knobSize, knobHeight);
        this.renderEngine.renderStroke(this.styles.knobStrokeColor, currentLeftKnobPosition, 0, this.styles.knobSize, knobHeight);
        this.renderEngine.renderStroke(this.styles.knobStrokeColor, currentRightKnobPosition, 0, this.styles.knobSize, knobHeight);
        this.interactionsEngine.addHitRegion("timeframeKnob" /* RegionTypes.TIMEFRAME_KNOB */, 'left', currentLeftKnobPosition, 0, this.styles.knobSize, knobHeight, "ew-resize" /* CursorTypes.EW_RESIZE */);
        this.interactionsEngine.addHitRegion("timeframeKnob" /* RegionTypes.TIMEFRAME_KNOB */, 'right', currentRightKnobPosition, 0, this.styles.knobSize, knobHeight, "ew-resize" /* CursorTypes.EW_RESIZE */);
        this.interactionsEngine.addHitRegion("timeframeArea" /* RegionTypes.TIMEFRAME_AREA */, null, 0, 0, this.renderEngine.width, this.renderEngine.height, "text" /* CursorTypes.TEXT */);
    }
    renderTooltip() {
        if (this.hoveredRegion) {
            const mouseX = this.interactionsEngine.getMouse().x;
            const currentTimestamp = mouseX / this.renderEngine.getInitialZoom() + this.renderEngine.min;
            const time = `${currentTimestamp.toFixed(this.renderEngine.getAccuracy() + 2)} ${this.renderEngine.timeUnits}`;
            const timeseriesFields = this.preparedTimeseries
                ? renderChartTooltipFields(currentTimestamp, this.preparedTimeseries)
                : [];
            this.renderEngine.renderTooltipFromData([
                {
                    text: time,
                },
                ...timeseriesFields,
            ], this.interactionsEngine.getGlobalMouse());
            return true;
        }
        return false;
    }
    render() {
        if (this.shouldRender) {
            this.shouldRender = false;
            this.offscreenRender();
        }
        this.renderEngine.copy(this.offscreenRenderEngine);
        this.renderTimeframe();
        this.interactionsEngine.addHitRegion("timeframe" /* RegionTypes.TIMEFRAME */, null, 0, 0, this.renderEngine.width, this.height);
        return true;
    }
}

const defaultTimeseriesPluginStyles = {
    height: 56,
};
const EXTRA_POINTS_FOR_RENDER = 2;
class TimeseriesPlugin extends UIPlugin {
    constructor({ name = 'timeseriesPlugin', data, settings, }) {
        super(name);
        this.height = 56;
        this.hoveredRegion = null;
        this.setSettings(settings);
        this.setData(data);
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.interactionsEngine.on('change-position', this.handlePositionChange.bind(this));
        this.interactionsEngine.on('hover', this.handleHover.bind(this));
        this.interactionsEngine.on('up', this.handleMouseUp.bind(this));
    }
    handlePositionChange(position) {
        const startPositionX = this.renderEngine.parent.positionX;
        this.interactionsEngine.setCursor("grabbing" /* CursorTypes.GRABBING */);
        this.renderEngine.tryToChangePosition(position.deltaX);
        if (startPositionX !== this.renderEngine.parent.positionX) {
            this.renderEngine.parent.render();
        }
    }
    handleMouseUp() {
        this.interactionsEngine.clearCursor();
    }
    setSettings({ styles } = { styles: this.styles }) {
        this.styles = mergeObjects(defaultTimeseriesPluginStyles, styles);
        this.height = this.styles.height;
    }
    setData(data) {
        const preparedTmeseries = prepareTmeseries(data);
        this.data = preparedTmeseries;
        this.min = preparedTmeseries.total.min;
        this.max = preparedTmeseries.total.max;
        if (this.renderEngine) {
            this.renderEngine.recalcMinMax();
            this.renderEngine.resetParentView();
        }
    }
    handleHover(region) {
        this.hoveredRegion = region;
    }
    renderTooltip() {
        if (this.hoveredRegion) {
            const mouseX = this.interactionsEngine.getMouse().x;
            const currentTimestamp = this.renderEngine.pixelToTime(mouseX) + this.renderEngine.positionX;
            const time = `${currentTimestamp.toFixed(this.renderEngine.getAccuracy() + 2)} ${this.renderEngine.timeUnits}`;
            const values = renderChartTooltipFields(currentTimestamp, this.data);
            this.renderEngine.renderTooltipFromData([
                {
                    text: time,
                },
                ...values,
            ], this.interactionsEngine.getGlobalMouse());
            return true;
        }
        return false;
    }
    render() {
        if (this.data.timeseries.length === 0) {
            return;
        }
        const timestampStart = this.renderEngine.positionX;
        const timestampEnd = this.renderEngine.positionX + this.renderEngine.getRealView();
        this.data.timeseries.forEach((chart, index) => {
            if (this.data.timeboxes[index].end < timestampStart || this.data.timeboxes[index].start > timestampEnd) {
                return;
            }
            const leftIndex = timestampStart <= this.data.timeboxes[index].start
                ? 0
                : Math.max(chart.points.findIndex(([timestamp]) => timestamp >= timestampStart) -
                    EXTRA_POINTS_FOR_RENDER, 0);
            const rightIndex = timestampEnd >= this.data.timeboxes[index].end
                ? chart.points.length
                : chart.points.findIndex(([timestamp]) => timestamp >= timestampEnd) + EXTRA_POINTS_FOR_RENDER;
            const visiblePoints = chart.points.slice(leftIndex, rightIndex);
            const minmax = getMinMax(visiblePoints, chart, this.data.summary);
            renderChart({
                engine: this.renderEngine,
                points: visiblePoints,
                min: minmax.min,
                max: minmax.max,
                style: chart.style,
            });
        });
        this.interactionsEngine.addHitRegion("timeseries" /* RegionTypes.TIMESERIES */, null, 0, 0, this.renderEngine.width, this.height);
    }
}

const defaultWaterfallPluginStyles = {
    defaultHeight: 68,
};
class WaterfallPlugin extends UIPlugin {
    constructor({ data, name = 'waterfallPlugin', settings, }) {
        super(name);
        this.styles = defaultWaterfallPluginStyles;
        this.height = defaultWaterfallPluginStyles.defaultHeight;
        this.data = [];
        this.positionY = 0;
        this.hoveredRegion = null;
        this.selectedRegion = null;
        this.initialData = [];
        this.setData(data);
        this.setSettings(settings);
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        this.interactionsEngine.on('change-position', this.handlePositionChange.bind(this));
        this.interactionsEngine.on('hover', this.handleHover.bind(this));
        this.interactionsEngine.on('select', this.handleSelect.bind(this));
        this.interactionsEngine.on('up', this.handleMouseUp.bind(this));
    }
    handlePositionChange({ deltaX, deltaY }) {
        const startPositionY = this.positionY;
        const startPositionX = this.renderEngine.parent.positionX;
        this.interactionsEngine.setCursor('grabbing');
        if (this.positionY + deltaY >= 0) {
            this.setPositionY(this.positionY + deltaY);
        }
        else {
            this.setPositionY(0);
        }
        this.renderEngine.tryToChangePosition(deltaX);
        if (startPositionX !== this.renderEngine.parent.positionX || startPositionY !== this.positionY) {
            this.renderEngine.parent.render();
        }
    }
    handleMouseUp() {
        this.interactionsEngine.clearCursor();
    }
    handleHover(region) {
        this.hoveredRegion = region;
    }
    handleSelect(region) {
        if (this.selectedRegion !== region) {
            this.selectedRegion = region;
            this.emit('select', {
                node: (region === null || region === void 0 ? void 0 : region.data) ? this.initialData[region.data] : null,
                type: 'waterfall-node',
            });
            this.renderEngine.render();
        }
    }
    setPositionY(y) {
        this.positionY = y;
    }
    setSettings({ styles }) {
        this.styles = mergeObjects(defaultWaterfallPluginStyles, styles);
        this.height = this.styles.defaultHeight;
        this.positionY = 0;
    }
    setData(waterfall) {
        this.positionY = 0;
        this.initialData = waterfall.items;
        this.data = parseWaterfall(waterfall);
        if (waterfall.items.length) {
            this.min = this.data.reduce((acc, { min }) => Math.min(acc, min), this.data[0].min);
            this.max = this.data.reduce((acc, { max }) => Math.max(acc, max), this.data[0].max);
        }
        if (this.renderEngine) {
            this.renderEngine.recalcMinMax();
            this.renderEngine.resetParentView();
        }
    }
    calcRect(start, duration, isEnd) {
        const w = duration * this.renderEngine.zoom;
        return {
            x: this.renderEngine.timeToPosition(start),
            w: isEnd ? (w <= 0.1 ? 0.1 : w >= 3 ? w - 1 : w - w / 3) : w,
        };
    }
    renderTooltip() {
        if (this.hoveredRegion) {
            if (this.renderEngine.options.tooltip === false) {
                return true;
            }
            else if (typeof this.renderEngine.options.tooltip === 'function') {
                const { data: index } = this.hoveredRegion;
                const data = { ...this.hoveredRegion };
                // @ts-ignore data type on waterfall item is number but here it is something else?
                data.data = this.data.find(({ index: i }) => index === i);
                this.renderEngine.options.tooltip(data, this.renderEngine, this.interactionsEngine.getGlobalMouse());
            }
            else {
                const { data: index } = this.hoveredRegion;
                const dataItem = this.data.find(({ index: i }) => index === i);
                if (dataItem) {
                    const { name, intervals, timing, meta = [] } = dataItem;
                    const timeUnits = this.renderEngine.getTimeUnits();
                    const nodeAccuracy = this.renderEngine.getAccuracy() + 2;
                    const header = { text: `${name}` };
                    const intervalsHeader = {
                        text: 'intervals',
                        color: this.renderEngine.styles.tooltipHeaderFontColor,
                    };
                    const intervalsTexts = intervals.map(({ name, start, end }) => ({
                        text: `${name}: ${(end - start).toFixed(nodeAccuracy)} ${timeUnits}`,
                    }));
                    const timingHeader = { text: 'timing', color: this.renderEngine.styles.tooltipHeaderFontColor };
                    const timingTexts = Object.entries(timing)
                        .filter(([, time]) => typeof time === 'number')
                        .map(([name, time]) => ({
                        text: `${name}: ${time.toFixed(nodeAccuracy)} ${timeUnits}`,
                    }));
                    const metaHeader = { text: 'meta', color: this.renderEngine.styles.tooltipHeaderFontColor };
                    const metaTexts = meta
                        ? meta.map(({ name, value, color }) => ({
                            text: `${name}: ${value}`,
                            color,
                        }))
                        : [];
                    this.renderEngine.renderTooltipFromData([
                        header,
                        intervalsHeader,
                        ...intervalsTexts,
                        timingHeader,
                        ...timingTexts,
                        ...(metaTexts.length ? [metaHeader, ...metaTexts] : []),
                    ], this.interactionsEngine.getGlobalMouse());
                }
            }
            return true;
        }
        return false;
    }
    render() {
        const rightSide = this.renderEngine.positionX + this.renderEngine.getRealView();
        const leftSide = this.renderEngine.positionX;
        const blockHeight = this.renderEngine.blockHeight + 1;
        const stack = [];
        const viewedData = this.data
            .filter(({ min, max }) => !((rightSide < min && rightSide < max) || (leftSide > max && rightSide > min)))
            .map((entry) => {
            while (stack.length && entry.min - last(stack).max > 0) {
                stack.pop();
            }
            const level = stack.length;
            const result = {
                ...entry,
                level,
            };
            stack.push(entry);
            return result;
        });
        viewedData.forEach(({ name, intervals, textBlock, level, index }) => {
            const y = level * blockHeight - this.positionY;
            if (y + blockHeight >= 0 && y - blockHeight <= this.renderEngine.height) {
                const textStart = this.renderEngine.timeToPosition(textBlock.start);
                const textEnd = this.renderEngine.timeToPosition(textBlock.end);
                this.renderEngine.addTextToRenderQueue(name, textStart, y, textEnd - textStart);
                const { x, w } = intervals.reduce((acc, { color, start, end, type }, index) => {
                    const { x, w } = this.calcRect(start, end - start, index === intervals.length - 1);
                    if (type === 'block') {
                        this.renderEngine.addRectToRenderQueue(color, x, y, w);
                    }
                    return {
                        x: acc.x === null ? x : acc.x,
                        w: w + acc.w,
                    };
                }, { x: null, w: 0 });
                if (this.selectedRegion && this.selectedRegion.type === 'waterfall-node') {
                    const selectedIndex = this.selectedRegion.data;
                    if (selectedIndex === index) {
                        this.renderEngine.addStrokeToRenderQueue('green', x !== null && x !== void 0 ? x : 0, y, w, this.renderEngine.blockHeight);
                    }
                }
                this.interactionsEngine.addHitRegion("waterfall-node" /* RegionTypes.WATERFALL_NODE */, index, x !== null && x !== void 0 ? x : 0, y, w, this.renderEngine.blockHeight);
            }
        }, 0);
    }
}

const defaultTogglePluginStyles = {
    height: 16,
    color: 'rgb(202,202,202, 0.25)',
    strokeColor: 'rgb(138,138,138, 0.50)',
    dotsColor: 'rgb(97,97,97)',
    fontColor: 'black',
    font: '10px sans-serif',
    triangleWidth: 10,
    triangleHeight: 7,
    triangleColor: 'black',
    leftPadding: 10,
};
class TogglePlugin extends UIPlugin {
    constructor(title, settings) {
        super('togglePlugin');
        this.styles = defaultTogglePluginStyles;
        this.height = 0;
        this.resizeActive = false;
        this.resizeStartHeight = 0;
        this.resizeStartPosition = 0;
        this.setSettings(settings);
        this.title = title;
    }
    setSettings({ styles } = {}) {
        this.styles = mergeObjects(defaultTogglePluginStyles, styles);
        this.height = this.styles.height + 1;
    }
    init(renderEngine, interactionsEngine) {
        super.init(renderEngine, interactionsEngine);
        const nextEngine = this.getNextEngine();
        nextEngine.setFlexible();
        this.interactionsEngine.on('click', (region) => {
            if (region && region.type === 'toggle' && region.data === this.renderEngine.id) {
                const nextEngine = this.getNextEngine();
                if (nextEngine.collapsed) {
                    nextEngine.expand();
                }
                else {
                    nextEngine.collapse();
                }
                this.renderEngine.parent.recalcChildrenSizes();
                this.renderEngine.parent.render();
            }
        });
        this.interactionsEngine.on('down', (region) => {
            if (region && region.type === 'knob-resize' && region.data === this.renderEngine.id) {
                const prevEngine = this.getPrevEngine();
                this.interactionsEngine.setCursor('row-resize');
                this.resizeActive = true;
                this.resizeStartHeight = prevEngine.height;
                this.resizeStartPosition = this.interactionsEngine.getGlobalMouse().y;
            }
        });
        this.interactionsEngine.parent.on('move', () => {
            if (this.resizeActive) {
                const prevEngine = this.getPrevEngine();
                const mouse = this.interactionsEngine.getGlobalMouse();
                if (prevEngine.flexible) {
                    const newPosition = this.resizeStartHeight - (this.resizeStartPosition - mouse.y);
                    if (newPosition <= 0) {
                        prevEngine.collapse();
                        prevEngine.resize({ height: 0 });
                    }
                    else {
                        if (prevEngine.collapsed) {
                            prevEngine.expand();
                        }
                        prevEngine.resize({ height: newPosition });
                    }
                    this.renderEngine.parent.render();
                }
            }
        });
        this.interactionsEngine.parent.on('up', () => {
            this.interactionsEngine.clearCursor();
            this.resizeActive = false;
        });
    }
    getPrevEngine() {
        var _a;
        const prevRenderEngineId = ((_a = this.renderEngine.id) !== null && _a !== void 0 ? _a : 0) - 1;
        return this.renderEngine.parent.children[prevRenderEngineId];
    }
    getNextEngine() {
        var _a;
        const nextRenderEngineId = ((_a = this.renderEngine.id) !== null && _a !== void 0 ? _a : 0) + 1;
        return this.renderEngine.parent.children[nextRenderEngineId];
    }
    render() {
        const nextEngine = this.getNextEngine();
        const prevEngine = this.getPrevEngine();
        const triangleFullWidth = this.styles.leftPadding + this.styles.triangleWidth;
        const centerW = this.renderEngine.width / 2;
        const centerH = this.styles.height / 2;
        this.renderEngine.setCtxFont(this.styles.font);
        this.renderEngine.setCtxValue('fillStyle', this.styles.color);
        this.renderEngine.setCtxValue('strokeStyle', this.styles.strokeColor);
        this.renderEngine.fillRect(0, 0, this.renderEngine.width, this.styles.height);
        this.renderEngine.setCtxValue('fillStyle', this.styles.fontColor);
        this.renderEngine.addTextToRenderQueue(this.title, triangleFullWidth, 0, this.renderEngine.width);
        this.renderEngine.renderTriangle(this.styles.triangleColor, this.styles.leftPadding, this.styles.height / 2, this.styles.triangleWidth, this.styles.triangleHeight, nextEngine.collapsed ? 'right' : 'bottom');
        const { width: titleWidth } = this.renderEngine.ctx.measureText(this.title);
        const buttonWidth = titleWidth + triangleFullWidth;
        this.interactionsEngine.addHitRegion("toggle" /* RegionTypes.TOGGLE */, this.renderEngine.id, 0, 0, buttonWidth, this.styles.height, "pointer" /* CursorTypes.POINTER */);
        if (prevEngine.flexible) {
            this.renderEngine.renderCircle(this.styles.dotsColor, centerW, centerH, 1.5);
            this.renderEngine.renderCircle(this.styles.dotsColor, centerW - 10, centerH, 1.5);
            this.renderEngine.renderCircle(this.styles.dotsColor, centerW + 10, centerH, 1.5);
            this.interactionsEngine.addHitRegion("knob-resize" /* RegionTypes.KNOB_RESIZE */, this.renderEngine.id, buttonWidth, 0, this.renderEngine.width - buttonWidth, this.styles.height, "row-resize" /* CursorTypes.ROW_RESIZE */);
        }
    }
}

// eslint-disable-next-line prettier/prettier -- prettier complains about escaping of the " character
const allChars = 'QWERTYUIOPASDFGHJKLZXCVBNMqwertyuiopasdfghjklzxcvbnm1234567890_-+()[]{}\\/|\'";:.,?~';
const checkSafari = () => {
    const ua = navigator.userAgent.toLowerCase();
    return ua.includes('safari') ? !ua.includes('chrome') : false;
};
function getPixelRatio(context) {
    // Unfortunately using any here, since typescript is not aware of all of the browser prefixes
    const ctx = context;
    const dpr = window.devicePixelRatio || 1;
    const bsr = ctx.webkitBackingStorePixelRatio ||
        ctx.mozBackingStorePixelRatio ||
        ctx.msBackingStorePixelRatio ||
        ctx.oBackingStorePixelRatio ||
        ctx.backingStorePixelRatio ||
        1;
    return dpr / bsr;
}
const defaultRenderSettings = {
    tooltip: undefined,
    timeUnits: 'ms',
};
const defaultRenderStyles = {
    blockHeight: 16,
    blockPaddingLeftRight: 4,
    backgroundColor: 'white',
    font: '10px sans-serif',
    fontColor: 'black',
    tooltipHeaderFontColor: 'black',
    tooltipBodyFontColor: '#688f45',
    tooltipBackgroundColor: 'white',
    tooltipShadowColor: 'black',
    tooltipShadowBlur: 6,
    tooltipShadowOffsetX: 0,
    tooltipShadowOffsetY: 0,
    headerHeight: 14,
    headerColor: 'rgba(112, 112, 112, 0.25)',
    headerStrokeColor: 'rgba(112, 112, 112, 0.5)',
    headerTitleLeftPadding: 16,
};
class BasicRenderEngine extends EventEmitter {
    constructor(canvas, settings) {
        super();
        this.options = defaultRenderSettings;
        this.timeUnits = 'ms';
        this.styles = defaultRenderStyles;
        this.blockPaddingLeftRight = 0;
        this.blockHeight = 0;
        this.blockPaddingTopBottom = 0;
        this.charHeight = 0;
        this.placeholderWidth = 0;
        this.avgCharWidth = 0;
        this.minTextWidth = 0;
        this.textRenderQueue = [];
        this.strokeRenderQueue = [];
        this.rectRenderQueue = {};
        this.zoom = 0;
        this.positionX = 0;
        this.min = 0;
        this.max = 0;
        this.ctxCachedSettings = {};
        this.ctxCachedCalls = {};
        this.setCtxValue = (field, value) => {
            if (this.ctxCachedSettings[field] !== value) {
                this.ctx[field] = value;
                this.ctxCachedSettings[field] = value;
            }
        };
        this.callCtx = (fn, value) => {
            if (!this.ctxCachedCalls[fn] || this.ctxCachedCalls[fn] !== value) {
                this.ctx[fn](value);
                this.ctxCachedCalls[fn] = value;
            }
        };
        this.width = canvas.width;
        this.height = canvas.height;
        this.isSafari = checkSafari();
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false });
        this.pixelRatio = getPixelRatio(this.ctx);
        this.setSettings(settings);
        this.applyCanvasSize();
        this.reset();
    }
    setSettings({ options, styles }) {
        this.options = mergeObjects(defaultRenderSettings, options);
        this.styles = mergeObjects(defaultRenderStyles, styles);
        this.timeUnits = this.options.timeUnits;
        this.blockHeight = this.styles.blockHeight;
        this.ctx.font = this.styles.font;
        const { actualBoundingBoxAscent: fontAscent, actualBoundingBoxDescent: fontDescent, width: allCharsWidth, } = this.ctx.measureText(allChars);
        const { width: placeholderWidth } = this.ctx.measureText('…');
        const fontHeight = fontAscent + fontDescent;
        this.blockPaddingLeftRight = this.styles.blockPaddingLeftRight;
        this.blockPaddingTopBottom = Math.ceil((this.blockHeight - fontHeight) / 2);
        this.charHeight = fontHeight + 1;
        this.placeholderWidth = placeholderWidth;
        this.avgCharWidth = allCharsWidth / allChars.length;
        this.minTextWidth = this.avgCharWidth + this.placeholderWidth;
    }
    reset() {
        this.textRenderQueue = [];
        this.strokeRenderQueue = [];
        this.rectRenderQueue = {};
        this.ctxCachedCalls = {};
        this.ctxCachedSettings = {};
    }
    setCtxShadow(shadow) {
        var _a, _b;
        this.setCtxValue('shadowBlur', shadow.blur);
        this.setCtxValue('shadowColor', shadow.color);
        this.setCtxValue('shadowOffsetY', (_a = shadow.offsetY) !== null && _a !== void 0 ? _a : 0);
        this.setCtxValue('shadowOffsetX', (_b = shadow.offsetX) !== null && _b !== void 0 ? _b : 0);
    }
    setCtxFont(font) {
        if (font && this.ctx.font !== font) {
            this.ctx.font = font;
        }
    }
    fillRect(x, y, w, h) {
        this.ctx.fillRect(x, y, w, h);
    }
    fillText(text, x, y) {
        this.ctx.fillText(text, x, y);
    }
    renderBlock(color, x, y, w) {
        this.setCtxValue('fillStyle', color);
        this.ctx.fillRect(x, y, w, this.blockHeight);
    }
    renderStroke(color, x, y, w, h) {
        this.setCtxValue('strokeStyle', color);
        this.ctx.setLineDash([]);
        this.ctx.strokeRect(x, y, w, h);
    }
    clear(w = this.width, h = this.height, x = 0, y = 0) {
        this.setCtxValue('fillStyle', this.styles.backgroundColor);
        this.ctx.clearRect(x, y, w, h - 1);
        this.ctx.fillRect(x, y, w, h);
        this.ctxCachedCalls = {};
        this.ctxCachedSettings = {};
        this.emit('clear');
    }
    timeToPosition(time) {
        return time * this.zoom - this.positionX * this.zoom;
    }
    pixelToTime(width) {
        return width / this.zoom;
    }
    setZoom(zoom) {
        this.zoom = zoom;
    }
    setPositionX(x) {
        const currentPos = this.positionX;
        this.positionX = x;
        return x - currentPos;
    }
    addRectToRenderQueue(color, x, y, w) {
        if (!this.rectRenderQueue[color]) {
            this.rectRenderQueue[color] = [];
        }
        this.rectRenderQueue[color].push({ x, y, w });
    }
    addTextToRenderQueue(text, x, y, w) {
        if (text) {
            const textMaxWidth = w - (this.blockPaddingLeftRight * 2 - (x < 0 ? x : 0));
            if (textMaxWidth > 0) {
                this.textRenderQueue.push({ text, x, y, w, textMaxWidth });
            }
        }
    }
    addStrokeToRenderQueue(color, x, y, w, h) {
        this.strokeRenderQueue.push({ color, x, y, w, h });
    }
    resolveRectRenderQueue() {
        Object.entries(this.rectRenderQueue).forEach(([color, items]) => {
            this.setCtxValue('fillStyle', color);
            items.forEach(({ x, y, w }) => this.renderBlock(color, x, y, w));
        });
        this.rectRenderQueue = {};
    }
    resolveTextRenderQueue() {
        this.setCtxValue('fillStyle', this.styles.fontColor);
        this.textRenderQueue.forEach(({ text, x, y, textMaxWidth }) => {
            const { width: textWidth } = this.ctx.measureText(text);
            if (textWidth > textMaxWidth) {
                const avgCharWidth = textWidth / text.length;
                const maxChars = Math.floor((textMaxWidth - this.placeholderWidth) / avgCharWidth);
                const halfChars = (maxChars - 1) / 2;
                if (halfChars > 0) {
                    text =
                        text.slice(0, Math.ceil(halfChars)) +
                            '…' +
                            text.slice(text.length - Math.floor(halfChars), text.length);
                }
                else {
                    text = '';
                }
            }
            if (text) {
                this.ctx.fillText(text, (x < 0 ? 0 : x) + this.blockPaddingLeftRight, y + this.blockHeight - this.blockPaddingTopBottom);
            }
        });
        this.textRenderQueue = [];
    }
    resolveStrokeRenderQueue() {
        this.strokeRenderQueue.forEach(({ color, x, y, w, h }) => {
            this.renderStroke(color, x, y, w, h);
        });
        this.strokeRenderQueue = [];
    }
    setMinMax(min, max) {
        const hasChanges = min !== this.min || max !== this.max;
        this.min = min;
        this.max = max;
        if (hasChanges) {
            this.emit('min-max-change', min, max);
        }
    }
    getTimeUnits() {
        return this.timeUnits;
    }
    tryToChangePosition(positionDelta) {
        const realView = this.getRealView();
        if (this.positionX + positionDelta + realView <= this.max && this.positionX + positionDelta >= this.min) {
            this.setPositionX(this.positionX + positionDelta);
        }
        else if (this.positionX + positionDelta <= this.min) {
            this.setPositionX(this.min);
        }
        else if (this.positionX + positionDelta + realView >= this.max) {
            this.setPositionX(this.max - realView);
        }
    }
    getInitialZoom() {
        if (this.max - this.min > 0) {
            return this.width / (this.max - this.min);
        }
        return 1;
    }
    getRealView() {
        return this.width / this.zoom;
    }
    resetView() {
        this.setZoom(this.getInitialZoom());
        this.setPositionX(this.min);
    }
    resize(width, height) {
        const isWidthChanged = typeof width === 'number' && this.width !== width;
        const isHeightChanged = typeof height === 'number' && this.height !== height;
        if (isWidthChanged || isHeightChanged) {
            this.width = isWidthChanged ? width : this.width;
            this.height = isHeightChanged ? height : this.height;
            this.applyCanvasSize();
            this.emit('resize', { width: this.width, height: this.height });
            return isHeightChanged;
        }
        return false;
    }
    applyCanvasSize() {
        this.canvas.style.backgroundColor = 'white';
        this.canvas.style.overflow = 'hidden';
        this.canvas.style.width = this.width + 'px';
        this.canvas.style.height = this.height + 'px';
        this.canvas.width = this.width * this.pixelRatio;
        this.canvas.height = this.height * this.pixelRatio;
        this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        this.ctx.font = this.styles.font;
    }
    copy(engine) {
        const ratio = this.isSafari ? 1 : engine.pixelRatio;
        if (engine.canvas.height) {
            this.ctx.drawImage(engine.canvas, 0, 0, engine.canvas.width * ratio, engine.canvas.height * ratio, 0, engine.position || 0, engine.width * ratio, engine.height * ratio);
        }
    }
    renderTooltipFromData(fields, mouse) {
        const mouseX = mouse.x + 10;
        const mouseY = mouse.y + 10;
        const maxWidth = fields
            .map(({ text }) => text)
            .map((text) => this.ctx.measureText(text))
            .reduce((acc, { width }) => Math.max(acc, width), 0);
        const fullWidth = maxWidth + this.blockPaddingLeftRight * 2;
        this.setCtxShadow({
            color: this.styles.tooltipShadowColor,
            blur: this.styles.tooltipShadowBlur,
            offsetX: this.styles.tooltipShadowOffsetX,
            offsetY: this.styles.tooltipShadowOffsetY,
        });
        this.setCtxValue('fillStyle', this.styles.tooltipBackgroundColor);
        this.ctx.fillRect(mouseX, mouseY, fullWidth + this.blockPaddingLeftRight * 2, (this.charHeight + 2) * fields.length + this.blockPaddingLeftRight * 2);
        this.setCtxShadow({
            color: 'transparent',
            blur: 0,
        });
        fields.forEach(({ text, color }, index) => {
            if (color) {
                this.setCtxValue('fillStyle', color);
            }
            else if (!index) {
                this.setCtxValue('fillStyle', this.styles.tooltipHeaderFontColor);
            }
            else {
                this.setCtxValue('fillStyle', this.styles.tooltipBodyFontColor);
            }
            this.ctx.fillText(text, mouseX + this.blockPaddingLeftRight, mouseY + this.blockHeight - this.blockPaddingTopBottom + (this.charHeight + 2) * index);
        });
    }
    renderShape(color, dots, posX, posY) {
        this.setCtxValue('fillStyle', color);
        this.ctx.beginPath();
        this.ctx.moveTo(dots[0].x + posX, dots[0].y + posY);
        dots.slice(1).forEach(({ x, y }) => this.ctx.lineTo(x + posX, y + posY));
        this.ctx.closePath();
        this.ctx.fill();
    }
    renderTriangle(color, x, y, width, height, direction) {
        const halfHeight = height / 2;
        const halfWidth = width / 2;
        let dots;
        switch (direction) {
            case 'top':
                dots = [
                    { x: 0 - halfWidth, y: halfHeight },
                    { x: 0, y: 0 - halfHeight },
                    { x: halfWidth, y: halfHeight },
                ];
                break;
            case 'right':
                dots = [
                    { x: 0 - halfHeight, y: 0 - halfWidth },
                    { x: 0 - halfHeight, y: halfWidth },
                    { x: halfHeight, y: 0 },
                ];
                break;
            case 'bottom':
                dots = [
                    { x: 0 - halfWidth, y: 0 - halfHeight },
                    { x: halfWidth, y: 0 - halfHeight },
                    { x: 0, y: halfHeight },
                ];
                break;
            case 'left':
                dots = [
                    { x: halfHeight, y: 0 - halfWidth },
                    { x: halfHeight, y: halfWidth },
                    { x: 0 - halfHeight, y: 0 },
                ];
                break;
        }
        this.renderShape(color, dots, x, y);
    }
    renderCircle(color, x, y, radius) {
        this.ctx.beginPath();
        this.ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
        this.setCtxValue('fillStyle', color);
        this.ctx.fill();
    }
}

class OffscreenRenderEngine extends BasicRenderEngine {
    constructor({ width, height, parent, id }) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        super(canvas, { options: parent.options, styles: parent.styles });
        this.flexible = false;
        this.collapsed = false;
        this.position = 0;
        this.width = width;
        this.height = height;
        this.parent = parent;
        this.id = id;
        this.children = [];
        this.applyCanvasSize();
    }
    makeChild() {
        const child = new OffscreenRenderEngine({
            width: this.width,
            height: this.height,
            parent: this.parent,
            id: void 0,
        });
        this.children.push(child);
        child.setMinMax(this.min, this.max);
        child.resetView();
        return child;
    }
    setFlexible() {
        this.flexible = true;
    }
    collapse() {
        this.collapsed = true;
        this.clear();
    }
    expand() {
        this.collapsed = false;
    }
    setSettingsOverrides(settings) {
        this.setSettings({
            styles: mergeObjects(this.styles, settings.styles),
            options: mergeObjects(this.options, settings.options),
        });
        this.children.forEach((child) => child.setSettingsOverrides(settings));
    }
    // @ts-ignore - overrides a parent function which has different signature
    resize({ width, height, position }, isParentCall) {
        const isHeightChanged = super.resize(width, height);
        if (!isParentCall && isHeightChanged) {
            this.parent.recalcChildrenSizes();
        }
        if (typeof position === 'number') {
            this.position = position;
        }
        this.children.forEach((child) => child.resize({ width, height, position }));
    }
    setMinMax(min, max) {
        super.setMinMax(min, max);
        this.children.forEach((child) => child.setMinMax(min, max));
    }
    setSettings(settings) {
        super.setSettings(settings);
        if (this.children) {
            this.children.forEach((child) => child.setSettings(settings));
        }
    }
    tryToChangePosition(positionDelta) {
        this.parent.tryToChangePosition(positionDelta);
    }
    recalcMinMax() {
        this.parent.calcMinMax();
    }
    getTimeUnits() {
        return this.parent.getTimeUnits();
    }
    getAccuracy() {
        return this.parent.timeGrid.accuracy;
    }
    renderTimeGrid() {
        this.parent.timeGrid.renderLines(0, this.height, this);
    }
    renderTimeGridTimes() {
        this.parent.timeGrid.renderTimes(this);
    }
    standardRender() {
        this.resolveRectRenderQueue();
        this.resolveTextRenderQueue();
        this.resolveStrokeRenderQueue();
        this.renderTimeGrid();
    }
    renderTooltipFromData(fields, mouse) {
        this.parent.renderTooltipFromData(fields, mouse);
    }
    resetParentView() {
        this.parent.resetView();
        this.parent.render();
    }
    render() {
        this.parent.partialRender(this.id);
    }
}

const MAX_ACCURACY = 6;
class RenderEngine extends BasicRenderEngine {
    constructor({ canvas, settings, timeGrid, plugins }) {
        super(canvas, settings);
        this.freeSpace = 0;
        this.lastPartialAnimationFrame = null;
        this.lastGlobalAnimationFrame = null;
        this.plugins = plugins;
        this.children = [];
        this.requestedRenders = [];
        this.timeGrid = timeGrid;
        this.timeGrid.setDefaultRenderEngine(this);
    }
    makeInstance() {
        const offscreenRenderEngine = new OffscreenRenderEngine({
            width: this.width,
            height: 0,
            id: this.children.length,
            parent: this,
        });
        offscreenRenderEngine.setMinMax(this.min, this.max);
        offscreenRenderEngine.resetView();
        this.children.push(offscreenRenderEngine);
        return offscreenRenderEngine;
    }
    calcMinMax() {
        const min = this.plugins
            .map(({ min }) => min)
            .filter(isNumber)
            .reduce((acc, min) => Math.min(acc, min));
        const max = this.plugins
            .map(({ max }) => max)
            .filter(isNumber)
            .reduce((acc, max) => Math.max(acc, max));
        this.setMinMax(min, max);
    }
    calcTimeGrid() {
        this.timeGrid.recalc();
    }
    setMinMax(min, max) {
        super.setMinMax(min, max);
        this.children.forEach((engine) => engine.setMinMax(min, max));
    }
    setSettings(data) {
        super.setSettings(data);
        if (this.children) {
            this.children.forEach((engine) => engine.setSettings(data));
            this.recalcChildrenSizes();
        }
    }
    resize(width, height) {
        const currentWidth = this.width;
        super.resize(width, height);
        this.recalcChildrenSizes();
        if (this.getInitialZoom() > this.zoom) {
            this.resetView();
        }
        else if (this.positionX > this.min) {
            this.tryToChangePosition(-this.pixelToTime((width - currentWidth) / 2));
        }
        return true;
    }
    recalcChildrenSizes() {
        const childrenSizes = this.getChildrenSizes();
        this.freeSpace = childrenSizes.reduce((acc, { height }) => acc - height, this.height);
        this.children.forEach((engine, index) => {
            engine.resize(childrenSizes[index], true);
        });
    }
    getChildrenSizes() {
        const indexes = this.children.map((_, index) => index);
        const enginesTypes = indexes.map((index) => {
            const plugin = this.plugins[index];
            const engine = this.children[index];
            if (engine.flexible && plugin.height) {
                return 'flexibleStatic';
            }
            else if (!plugin.height) {
                return 'flexibleGrowing';
            }
            return 'static';
        });
        const freeSpace = enginesTypes.reduce((acc, type, index) => {
            var _a, _b;
            const plugin = this.plugins[index];
            const engine = this.children[index];
            if (engine.collapsed) {
                return acc;
            }
            else if (type === 'flexibleGrowing') {
                return acc - (engine.height || 0);
            }
            else if (type === 'flexibleStatic') {
                return acc - ((engine === null || engine === void 0 ? void 0 : engine.height) || (plugin === null || plugin === void 0 ? void 0 : plugin.height) || 0);
            }
            else if (type === 'static') {
                return acc - ((_b = (_a = this.plugins[index]) === null || _a === void 0 ? void 0 : _a.height) !== null && _b !== void 0 ? _b : 0);
            }
            return acc;
        }, this.height);
        const flexibleGrowingCount = enginesTypes.filter((type) => type === 'flexibleGrowing').length;
        const freeSpacePart = Math.floor(freeSpace / flexibleGrowingCount);
        return enginesTypes.reduce((acc, type, index) => {
            var _a, _b;
            const engine = this.children[index];
            const plugin = this.plugins[index];
            let height = 0;
            if (engine.collapsed) {
                height = 0;
            }
            else {
                switch (type) {
                    case 'static':
                        height = (_a = plugin.height) !== null && _a !== void 0 ? _a : 0;
                        break;
                    case 'flexibleGrowing':
                        height = (engine.height || 0) + freeSpacePart;
                        break;
                    case 'flexibleStatic':
                        height = (_b = (engine.height || this.plugins[index].height)) !== null && _b !== void 0 ? _b : 0;
                        break;
                }
            }
            acc.result.push({
                width: this.width,
                position: acc.position,
                height,
            });
            acc.position += height;
            return acc;
        }, {
            position: 0,
            result: [],
        }).result;
    }
    getAccuracy() {
        return this.timeGrid.accuracy;
    }
    setZoom(zoom) {
        if (this.getAccuracy() < MAX_ACCURACY || zoom <= this.zoom) {
            super.setZoom(zoom);
            this.children.forEach((engine) => engine.setZoom(zoom));
            return true;
        }
        return false;
    }
    setPositionX(x) {
        const res = super.setPositionX(x);
        this.children.forEach((engine) => engine.setPositionX(x));
        return res;
    }
    renderPlugin(index) {
        var _a;
        const plugin = this.plugins[index];
        const engine = this.children[index];
        engine === null || engine === void 0 ? void 0 : engine.clear();
        if (!engine.collapsed) {
            const isFullRendered = (_a = plugin === null || plugin === void 0 ? void 0 : plugin.render) === null || _a === void 0 ? void 0 : _a.call(plugin);
            if (!isFullRendered) {
                engine.standardRender();
            }
        }
    }
    partialRender(id) {
        if (typeof id === 'number') {
            this.requestedRenders.push(id);
        }
        if (!this.lastPartialAnimationFrame) {
            this.lastPartialAnimationFrame = requestAnimationFrame(() => {
                this.requestedRenders.forEach((index) => this.renderPlugin(index));
                this.shallowRender();
                this.requestedRenders = [];
                this.lastPartialAnimationFrame = null;
            });
        }
    }
    shallowRender() {
        this.clear();
        this.timeGrid.renderLines(this.height - this.freeSpace, this.freeSpace);
        this.children.forEach((engine) => {
            if (!engine.collapsed) {
                this.copy(engine);
            }
        });
        let tooltipRendered = false;
        this.plugins.forEach((plugin) => {
            if (plugin.postRender) {
                plugin.postRender();
            }
        });
        this.plugins.forEach((plugin) => {
            if (plugin.renderTooltip) {
                tooltipRendered = tooltipRendered || Boolean(plugin.renderTooltip());
            }
        });
        if (!tooltipRendered && typeof this.options.tooltip === 'function') {
            // notify tooltip of nothing to render
            this.options.tooltip(null, this, null);
        }
    }
    render(prepare) {
        if (typeof this.lastPartialAnimationFrame === 'number') {
            cancelAnimationFrame(this.lastPartialAnimationFrame);
        }
        this.requestedRenders = [];
        this.lastPartialAnimationFrame = null;
        if (!this.lastGlobalAnimationFrame) {
            this.lastGlobalAnimationFrame = requestAnimationFrame(() => {
                prepare === null || prepare === void 0 ? void 0 : prepare();
                this.timeGrid.recalc();
                this.children.forEach((_, index) => this.renderPlugin(index));
                this.shallowRender();
                this.lastGlobalAnimationFrame = null;
            });
        }
    }
}

const EVENT_NAMES = ['down', 'up', 'move', 'click', 'select'];

class SeparatedInteractionsEngine extends EventEmitter {
    static getId() {
        return SeparatedInteractionsEngine.count++;
    }
    constructor(parent, renderEngine) {
        super();
        this.id = SeparatedInteractionsEngine.getId();
        this.parent = parent;
        this.renderEngine = renderEngine;
        renderEngine.on('clear', () => this.clearHitRegions());
        EVENT_NAMES.forEach((eventName) => parent.on(eventName, (region, mouse, isClick) => {
            if (!region || region.id === this.id) {
                this.resend(eventName, region, mouse, isClick);
            }
        }));
        ['hover'].forEach((eventName) => parent.on(eventName, (region, mouse) => {
            if (!region || region.id === this.id) {
                this.emit(eventName, region, mouse);
            }
        }));
        parent.on('change-position', (data, startMouse, endMouse, instance) => {
            if (instance === this) {
                this.emit('change-position', data, startMouse, endMouse);
            }
        });
        this.hitRegions = [];
    }
    resend(event, ...args) {
        if (this.renderEngine.position <= this.parent.mouse.y &&
            this.renderEngine.height + this.renderEngine.position >= this.parent.mouse.y) {
            this.emit(event, ...args);
        }
    }
    getMouse() {
        const { x, y } = this.parent.mouse;
        return {
            x,
            y: y - this.renderEngine.position,
        };
    }
    getGlobalMouse() {
        return this.parent.mouse;
    }
    clearHitRegions() {
        this.hitRegions = [];
    }
    addHitRegion(type, data, x, y, w, h, cursor) {
        this.hitRegions.push({
            type,
            data,
            x,
            y,
            w,
            h,
            cursor,
            id: this.id,
        });
    }
    setCursor(cursor) {
        this.parent.setCursor(cursor);
    }
    clearCursor() {
        this.parent.clearCursor();
    }
}
SeparatedInteractionsEngine.count = 0;

class InteractionsEngine extends EventEmitter {
    constructor(canvas, renderEngine) {
        super();
        this.selectedRegion = null;
        this.hoveredRegion = null;
        this.moveActive = false;
        this.currentCursor = null;
        this.renderEngine = renderEngine;
        this.canvas = canvas;
        this.hitRegions = [];
        this.instances = [];
        this.mouse = {
            x: 0,
            y: 0,
        };
        this.handleMouseWheel = this.handleMouseWheel.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.initListeners();
        this.reset();
    }
    makeInstance(renderEngine) {
        const separatedInteractionsEngine = new SeparatedInteractionsEngine(this, renderEngine);
        this.instances.push(separatedInteractionsEngine);
        return separatedInteractionsEngine;
    }
    reset() {
        this.selectedRegion = null;
        this.hoveredRegion = null;
        this.hitRegions = [];
    }
    destroy() {
        this.removeListeners();
    }
    initListeners() {
        if (this.canvas) {
            this.canvas.addEventListener('wheel', this.handleMouseWheel);
            this.canvas.addEventListener('mousedown', this.handleMouseDown);
            this.canvas.addEventListener('mouseup', this.handleMouseUp);
            this.canvas.addEventListener('mouseleave', this.handleMouseUp);
            this.canvas.addEventListener('mousemove', this.handleMouseMove);
        }
    }
    removeListeners() {
        if (this.canvas) {
            this.canvas.removeEventListener('wheel', this.handleMouseWheel);
            this.canvas.removeEventListener('mousedown', this.handleMouseDown);
            this.canvas.removeEventListener('mouseup', this.handleMouseUp);
            this.canvas.removeEventListener('mouseleave', this.handleMouseUp);
            this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        }
    }
    handleMouseWheel(e) {
        const { deltaY, deltaX } = e;
        e.preventDefault();
        const realView = this.renderEngine.getRealView();
        const initialZoom = this.renderEngine.getInitialZoom();
        const startPosition = this.renderEngine.positionX;
        const startZoom = this.renderEngine.zoom;
        const positionScrollDelta = deltaX / this.renderEngine.zoom;
        let zoomDelta = (deltaY / 1000) * this.renderEngine.zoom;
        this.renderEngine.tryToChangePosition(positionScrollDelta);
        zoomDelta =
            this.renderEngine.zoom - zoomDelta >= initialZoom ? zoomDelta : this.renderEngine.zoom - initialZoom;
        if (zoomDelta !== 0) {
            const zoomed = this.renderEngine.setZoom(this.renderEngine.zoom - zoomDelta);
            if (zoomed) {
                const proportion = this.mouse.x / this.renderEngine.width;
                const timeDelta = realView - this.renderEngine.width / this.renderEngine.zoom;
                const positionDelta = timeDelta * proportion;
                this.renderEngine.tryToChangePosition(positionDelta);
            }
        }
        this.checkRegionHover();
        if (startPosition !== this.renderEngine.positionX || startZoom !== this.renderEngine.zoom) {
            this.renderEngine.render();
        }
    }
    handleMouseDown() {
        this.moveActive = true;
        this.mouseDownPosition = {
            x: this.mouse.x,
            y: this.mouse.y,
        };
        this.mouseDownHoveredInstance = this.hoveredInstance;
        this.emit('down', this.hoveredRegion, this.mouse);
    }
    handleMouseUp() {
        this.moveActive = false;
        const isClick = this.mouseDownPosition &&
            this.mouseDownPosition.x === this.mouse.x &&
            this.mouseDownPosition.y === this.mouse.y;
        if (isClick) {
            this.handleRegionHit();
        }
        this.emit('up', this.hoveredRegion, this.mouse, isClick);
        if (isClick) {
            this.emit('click', this.hoveredRegion, this.mouse);
        }
    }
    handleMouseMove(e) {
        if (this.moveActive) {
            const mouseDeltaY = this.mouse.y - e.offsetY;
            const mouseDeltaX = (this.mouse.x - e.offsetX) / this.renderEngine.zoom;
            if (mouseDeltaY || mouseDeltaX) {
                this.emit('change-position', {
                    deltaX: mouseDeltaX,
                    deltaY: mouseDeltaY,
                }, this.mouseDownPosition, this.mouse, this.mouseDownHoveredInstance);
            }
        }
        this.mouse.x = e.offsetX;
        this.mouse.y = e.offsetY;
        this.checkRegionHover();
        this.emit('move', this.hoveredRegion, this.mouse);
    }
    handleRegionHit() {
        const selectedRegion = this.getHoveredRegion();
        this.emit('select', selectedRegion, this.mouse);
    }
    checkRegionHover() {
        const hoveredRegion = this.getHoveredRegion();
        if (hoveredRegion && this.hoveredRegion && hoveredRegion.id !== this.hoveredRegion.id) {
            this.emit('hover', null, this.mouse);
        }
        if (hoveredRegion) {
            if (!this.currentCursor && hoveredRegion.cursor) {
                this.renderEngine.canvas.style.cursor = hoveredRegion.cursor;
            }
            else if (!this.currentCursor) {
                this.clearCursor();
            }
            this.hoveredRegion = hoveredRegion;
            this.emit('hover', hoveredRegion, this.mouse);
            this.renderEngine.partialRender();
        }
        else if (this.hoveredRegion && !hoveredRegion) {
            if (!this.currentCursor) {
                this.clearCursor();
            }
            this.hoveredRegion = null;
            this.emit('hover', null, this.mouse);
            this.renderEngine.partialRender();
        }
    }
    getHoveredRegion() {
        const hoveredRegion = this.hitRegions.find(({ x, y, w, h }) => this.mouse.x >= x && this.mouse.x <= x + w && this.mouse.y >= y && this.mouse.y <= y + h);
        if (hoveredRegion) {
            return hoveredRegion;
        }
        const hoveredInstance = this.instances.find(({ renderEngine }) => renderEngine.position <= this.mouse.y && renderEngine.height + renderEngine.position >= this.mouse.y);
        this.hoveredInstance = hoveredInstance;
        if (hoveredInstance) {
            const offsetTop = hoveredInstance.renderEngine.position;
            return hoveredInstance.hitRegions.find(({ x, y, w, h }) => this.mouse.x >= x &&
                this.mouse.x <= x + w &&
                this.mouse.y >= y + offsetTop &&
                this.mouse.y <= y + h + offsetTop);
        }
        return null;
    }
    clearHitRegions() {
        this.hitRegions = [];
    }
    addHitRegion(type, data, x, y, w, h, cursor) {
        this.hitRegions.push({
            type,
            data,
            x,
            y,
            w,
            h,
            cursor,
        });
    }
    setCursor(cursor) {
        this.renderEngine.canvas.style.cursor = cursor;
        this.currentCursor = cursor;
    }
    clearCursor() {
        const hoveredRegion = this.getHoveredRegion();
        this.currentCursor = null;
        if (hoveredRegion === null || hoveredRegion === void 0 ? void 0 : hoveredRegion.cursor) {
            this.renderEngine.canvas.style.cursor = hoveredRegion.cursor;
        }
        else {
            this.renderEngine.canvas.style.cursor = '';
        }
    }
}

class FlameChartContainer extends EventEmitter {
    constructor({ canvas, plugins, settings }) {
        var _a;
        super();
        const styles = (_a = settings === null || settings === void 0 ? void 0 : settings.styles) !== null && _a !== void 0 ? _a : {};
        this.timeGrid = new TimeGrid({ styles: styles === null || styles === void 0 ? void 0 : styles.timeGrid });
        this.renderEngine = new RenderEngine({
            canvas,
            settings: {
                styles: styles === null || styles === void 0 ? void 0 : styles.main,
                options: settings === null || settings === void 0 ? void 0 : settings.options,
            },
            plugins,
            timeGrid: this.timeGrid,
        });
        this.interactionsEngine = new InteractionsEngine(canvas, this.renderEngine);
        this.plugins = plugins;
        const children = Array(this.plugins.length)
            .fill(null)
            .map(() => {
            const renderEngine = this.renderEngine.makeInstance();
            const interactionsEngine = this.interactionsEngine.makeInstance(renderEngine);
            return { renderEngine, interactionsEngine };
        });
        this.plugins.forEach((plugin, index) => {
            plugin.init(children[index].renderEngine, children[index].interactionsEngine);
        });
        this.renderEngine.calcMinMax();
        this.renderEngine.resetView();
        this.renderEngine.recalcChildrenSizes();
        this.renderEngine.calcTimeGrid();
        this.plugins.forEach((plugin) => { var _a; return (_a = plugin.postInit) === null || _a === void 0 ? void 0 : _a.call(plugin); });
        this.renderEngine.render();
    }
    render() {
        this.renderEngine.render();
    }
    resize(width, height) {
        this.renderEngine.render(() => this.renderEngine.resize(width, height));
    }
    execOnPlugins(fnName, ...args) {
        let index = 0;
        while (index < this.plugins.length) {
            if (this.plugins[index][fnName]) {
                this.plugins[index][fnName](...args);
            }
            index++;
        }
    }
    setSettings(settings) {
        var _a, _b;
        this.timeGrid.setSettings({ styles: (_a = settings.styles) === null || _a === void 0 ? void 0 : _a.timeGrid });
        this.renderEngine.setSettings({ options: settings.options, styles: (_b = settings.styles) === null || _b === void 0 ? void 0 : _b.main });
        this.plugins.forEach((plugin) => { var _a, _b; return (_a = plugin.setSettings) === null || _a === void 0 ? void 0 : _a.call(plugin, { styles: (_b = settings.styles) === null || _b === void 0 ? void 0 : _b[plugin.name] }); });
        this.renderEngine.render();
    }
    setZoom(start, end) {
        const zoom = this.renderEngine.width / (end - start);
        this.renderEngine.setPositionX(start);
        this.renderEngine.setZoom(zoom);
        this.renderEngine.render();
    }
}

const defaultSettings = {};
class FlameChart extends FlameChartContainer {
    constructor({ canvas, data, marks, waterfall, timeframeTimeseries, timeseries, colors, settings = defaultSettings, plugins = [], }) {
        var _a;
        const activePlugins = [];
        const { headers: { waterfall: waterfallName = 'waterfall', flameChart: flameChartName = 'flame chart' } = {} } = settings;
        const styles = (_a = settings === null || settings === void 0 ? void 0 : settings.styles) !== null && _a !== void 0 ? _a : {};
        const timeGridPlugin = new TimeGridPlugin({ styles: styles === null || styles === void 0 ? void 0 : styles.timeGridPlugin });
        activePlugins.push(timeGridPlugin);
        let marksPlugin;
        let waterfallPlugin;
        let timeframeSelectorPlugin;
        let flameChartPlugin;
        let timeseriesPlugin;
        if (timeseries) {
            timeseriesPlugin = new TimeseriesPlugin({
                data: timeseries,
                settings: { styles: styles === null || styles === void 0 ? void 0 : styles.timeseriesPlugin },
            });
            activePlugins.push(timeseriesPlugin);
        }
        if (marks) {
            marksPlugin = new MarksPlugin({ data: marks });
            marksPlugin.on('select', (data) => this.emit('select', data));
            activePlugins.push(marksPlugin);
        }
        if (waterfall) {
            waterfallPlugin = new WaterfallPlugin({ data: waterfall, settings: { styles: styles === null || styles === void 0 ? void 0 : styles.waterfallPlugin } });
            waterfallPlugin.on('select', (data) => this.emit('select', data));
            if (data) {
                activePlugins.push(new TogglePlugin(waterfallName, { styles: styles === null || styles === void 0 ? void 0 : styles.togglePlugin }));
            }
            activePlugins.push(waterfallPlugin);
        }
        if (data) {
            flameChartPlugin = new FlameChartPlugin({ data, colors });
            flameChartPlugin.on('select', (data) => this.emit('select', data));
            if (waterfall) {
                activePlugins.push(new TogglePlugin(flameChartName, { styles: styles === null || styles === void 0 ? void 0 : styles.togglePlugin }));
            }
            activePlugins.push(flameChartPlugin);
        }
        if (data || waterfall || timeframeTimeseries) {
            timeframeSelectorPlugin = new TimeframeSelectorPlugin({
                flameChartNodes: data,
                waterfall: waterfall,
                timeseries: timeframeTimeseries,
                settings: { styles: styles === null || styles === void 0 ? void 0 : styles.timeframeSelectorPlugin },
            });
            activePlugins.unshift(timeframeSelectorPlugin);
        }
        super({
            canvas,
            settings,
            plugins: [...activePlugins, ...plugins],
        });
        if (flameChartPlugin && timeframeSelectorPlugin) {
            this.setNodes = (data) => {
                if (flameChartPlugin) {
                    flameChartPlugin.setData(data);
                }
                if (timeframeSelectorPlugin) {
                    timeframeSelectorPlugin.setFlameChartNodes(data);
                }
            };
            this.setFlameChartPosition = ({ x, y }) => {
                if (typeof x === 'number') {
                    this.renderEngine.setPositionX(x);
                }
                if (typeof y === 'number' && flameChartPlugin) {
                    flameChartPlugin.setPositionY(y);
                }
                this.renderEngine.render();
            };
        }
        if (marksPlugin) {
            this.setMarks = (data) => {
                if (marksPlugin) {
                    marksPlugin.setMarks(data);
                }
            };
        }
        if (waterfallPlugin) {
            this.setWaterfall = (data) => {
                if (waterfallPlugin) {
                    waterfallPlugin.setData(data);
                }
                if (timeframeSelectorPlugin) {
                    timeframeSelectorPlugin.setWaterfall(data);
                }
            };
        }
        if (timeseriesPlugin) {
            this.setTimeseries = (data) => {
                if (timeseriesPlugin) {
                    timeseriesPlugin.setData(data);
                }
            };
        }
        if (timeframeSelectorPlugin) {
            this.setTimeframeTimeseries = (data) => {
                timeframeSelectorPlugin === null || timeframeSelectorPlugin === void 0 ? void 0 : timeframeSelectorPlugin.setTimeseries(data);
            };
        }
    }
}

export { EVENT_NAMES, FlameChart, FlameChartContainer, FlameChartPlugin, MarksPlugin, TimeGridPlugin, TimeframeSelectorPlugin, TimeseriesPlugin, TogglePlugin, UIPlugin, WaterfallPlugin };
