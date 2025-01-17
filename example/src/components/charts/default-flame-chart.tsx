import { FlameChartWrapper, NodeTypes } from './flame-chart-wrapper';
import { FlameChartNode, FlameChartStyles, Marks, Timeseries, WaterfallItems } from '../../../../src';
import { FlameChartContainerStyles } from '../../../../src/flame-chart-container';
import styles from './default-flame-chart.module.css';
import { waterfallIntervals } from '../../test-data';
import { useMemo } from 'react';

export type DefaultFlameChartProps = {
    flameChartData: FlameChartNode[];
    waterfallData: WaterfallItems;
    marksData: Marks;
    timeseriesData: Timeseries;
    timeframeTimeseriesData: Timeseries;
    stylesSettings?: FlameChartContainerStyles<FlameChartStyles>;
    onSelect?: (node: NodeTypes) => void;
};

export const DefaultFlameChart = ({
    flameChartData,
    waterfallData,
    marksData,
    timeseriesData,
    timeframeTimeseriesData,
    stylesSettings,
    onSelect,
}: DefaultFlameChartProps) => {
    const waterfall = useMemo(
        () => ({
            intervals: waterfallIntervals,
            items: waterfallData,
        }),
        [waterfallData]
    );

    const settings = useMemo(
        () => ({
            styles: stylesSettings,
        }),
        [stylesSettings]
    );

    return (
        <FlameChartWrapper
            data={flameChartData}
            waterfall={waterfall}
            marks={marksData}
            timeseries={timeseriesData}
            timeframeTimeseries={timeframeTimeseriesData}
            settings={settings}
            className={styles.flameChart}
            onSelect={onSelect}
        />
    );
};
