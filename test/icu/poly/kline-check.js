import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const BINANCE_BASE_URL = 'https://api.binance.com/api/v3/klines';
const INTERVAL = '5m';

const MS_IN_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * MS_IN_MINUTE;
const ONE_HOUR = 60 * MS_IN_MINUTE;
const FLOAT_TOLERANCE = 1e-8;
const TARGET_TIMEZONE = 'Asia/Shanghai';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatPct = (value) => `${(value * 100).toFixed(2)}%`;

const median = (values) => {
    if (!values.length) {
        return 0;
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[mid];
    }
    return (sorted[mid - 1] + sorted[mid]) / 2;
};

const calcChange = (start, end) => {
    if (Math.abs(start) <= FLOAT_TOLERANCE) {
        return 0;
    }
    return (end - start) / start;
};

const formatHourStart = (timestamp) =>
    dayjs(timestamp).tz(TARGET_TIMEZONE).format('YYYY-MM-DD HH:mm');

async function fetchFiveMinuteKlines({ symbol, startTime, endTime }) {
    let cursor = startTime;
    const klines = [];

    while (cursor < endTime) {
        const { data } = await axios.get(BINANCE_BASE_URL, {
            params: {
                symbol,
                interval: INTERVAL,
                startTime: cursor,
                endTime,
                limit: 1000,
            },
        });

        if (!data.length) {
            break;
        }

        for (const item of data) {
            klines.push({
                openTime: item[0],
                open: parseFloat(item[1]),
                high: parseFloat(item[2]),
                low: parseFloat(item[3]),
                close: parseFloat(item[4]),
                volume: parseFloat(item[5]),
                closeTime: item[6],
            });
        }

        const lastOpenTime = data[data.length - 1][0];
        cursor = lastOpenTime + FIVE_MINUTES;

        if (data.length < 1000) {
            break;
        }

        // be gentle with the public API
        await wait(200);
    }

    return klines;
}

function groupIntoFullHours(klines) {
    const buckets = new Map();

    for (const kline of klines) {
        const hourStart = Math.floor(kline.openTime / ONE_HOUR) * ONE_HOUR;
        if (!buckets.has(hourStart)) {
            buckets.set(hourStart, []);
        }
        buckets.get(hourStart).push(kline);
    }

    const fullHours = [];
    for (const [hourStart, entries] of buckets.entries()) {
        if (entries.length < 12) {
            continue;
        }
        const sorted = entries
            .slice()
            .sort((a, b) => a.openTime - b.openTime)
            .slice(0, 12);

        if (sorted.length === 12) {
            fullHours.push({ hourStart, candles: sorted });
        }
    }

    return fullHours.sort((a, b) => a.hourStart - b.hourStart);
}

function directionSign(delta) {
    if (Math.abs(delta) <= FLOAT_TOLERANCE) {
        return 0;
    }
    return delta > 0 ? 1 : -1;
}

function buildHourSummaries(hourBuckets) {
    const summaries = [];

    for (const bucket of hourBuckets) {
        const [first, ...rest] = bucket.candles;
        const preFinal = rest[rest.length - 2];
        const last = rest[rest.length - 1];

        if (!first || !preFinal || !last) {
            continue;
        }

        const openPrice = first.open;
        const preClose = preFinal.close;
        const finalClose = last.close;

        const firstDirection = directionSign(preClose - openPrice);
        const finalDirection = directionSign(finalClose - openPrice);
        const preChange = calcChange(openPrice, preClose);
        const fullChange = calcChange(openPrice, finalClose);
        const amplitude = Math.abs(fullChange);
        const isReversal = firstDirection !== 0 && firstDirection === -finalDirection;

        summaries.push({
            timestamp: formatHourStart(bucket.hourStart),
            hourStart: bucket.hourStart,
            open: openPrice,
            preClose,
            finalClose,
            firstDirection,
            finalDirection,
            preChange,
            preChangeAbs: Math.abs(preChange),
            fullChange,
            amplitude,
            isReversal,
        });
    }

    return summaries;
}

function computeStats(hourSummaries) {
    const totalHours = hourSummaries.length;
    const reversalEntries = hourSummaries.filter((item) => item.isReversal);
    const reversalCount = reversalEntries.length;

    const probability = totalHours === 0 ? 0 : reversalCount / totalHours;
    const amplitudeMedian = median(hourSummaries.map((item) => item.amplitude));
    const reversalAmplitudeMedian = median(reversalEntries.map((item) => item.amplitude));

    return {
        totalHours,
        reversalCount,
        probability,
        amplitudeMedian,
        reversalAmplitudeMedian,
        reversals: reversalEntries,
    };
}

async function runScenario({ label, symbol, hoursToCover, preChangeFilter }) {
    const scenarioLabel =
        label ??
        `${symbol} | last ${(hoursToCover / 24).toFixed(1)}d | filter ${formatPct(
            preChangeFilter
        )}`;

    const endTime = Date.now();
    const startTime = endTime - hoursToCover * ONE_HOUR;

    const klines = await fetchFiveMinuteKlines({
        symbol,
        startTime,
        endTime,
    });

    const hourBuckets = groupIntoFullHours(klines);
    const hourSummaries = buildHourSummaries(hourBuckets);
    const overallStats = computeStats(hourSummaries);
    const filteredSummaries = hourSummaries.filter((item) => item.preChangeAbs >= preChangeFilter);
    const filteredStats = computeStats(filteredSummaries);

    return {
        label: scenarioLabel,
        symbol,
        hoursToCover,
        preChangeFilter,
        overall: {
            probability: overallStats.probability,
            amplitudeMedian: overallStats.amplitudeMedian,
            reversalAmplitudeMedian: overallStats.reversalAmplitudeMedian,
        },
        filtered: {
            ratio: hourSummaries.length === 0 ? 0 : filteredSummaries.length / hourSummaries.length,
            sampleSize: filteredSummaries.length,
            probability: filteredStats.probability,
            amplitudeMedian: filteredStats.amplitudeMedian,
            reversalAmplitudeMedian: filteredStats.reversalAmplitudeMedian,
        },
    };
}

const SCENARIO_GROUP = [
    // {
    //     label: 'BTCUSDT | last 7d | filter 0.10%',
    //     symbol: 'BTCUSDT',
    //     hoursToCover: 24 * 7,
    //     preChangeFilter: 0.001,
    // },
    // {
    //     label: 'BTCUSDT | last 28d | filter 0.20%',
    //     symbol: 'BTCUSDT',
    //     hoursToCover: 24 * 28,
    //     preChangeFilter: 0.002,
    // },
    {
        label: 'ETHUSDT | last 7d | filter 0.10%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 7,
        preChangeFilter: 0.001,
    },
    {
        label: 'ETHUSDT | last 7d | filter 0.15%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 7,
        preChangeFilter: 0.0015,
    },
    {
        label: 'ETHUSDT | last 7d | filter 0.20%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 7,
        preChangeFilter: 0.002,
    },
    {
        label: 'ETHUSDT | last 28d | filter 0.10%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 28,
        preChangeFilter: 0.001,
    },
    {
        label: 'ETHUSDT | last 28d | filter 0.15%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 28,
        preChangeFilter: 0.0015,
    },
    {
        label: 'ETHUSDT | last 28d | filter 0.20%',
        symbol: 'ETHUSDT',
        hoursToCover: 24 * 28,
        preChangeFilter: 0.002,
    },
];
async function main() {
    const results = [];
    for (const scenario of SCENARIO_GROUP) {
        // eslint-disable-next-line no-await-in-loop
        const summary = await runScenario(scenario);
        results.push(summary);
    }

    console.table(
        results.map((item) => ({
            // scenario: item.label,
            symbol: item.symbol,
            // windowHours: item.hoursToCover,
            windowDays: (item.hoursToCover / 24).toFixed(1),
            filter: formatPct(item.preChangeFilter),
            整体反转率: formatPct(item.overall.probability),
            整体振幅中位数: formatPct(item.overall.amplitudeMedian),
            反转K振幅中位数: formatPct(item.overall.reversalAmplitudeMedian),
            保留率: formatPct(item.filtered.ratio),
            过滤后反转率: formatPct(item.filtered.probability),
            过滤后振幅中位数: formatPct(item.filtered.amplitudeMedian),
            过滤后反转K振幅中位数: formatPct(item.filtered.reversalAmplitudeMedian),
        }))
    );
}
/**
 * 
 * 
 │ (index) │  symbol   │ windowDays │ filter  │ 整体反转率 │ 整体振幅中位数 │ 反转K振幅中位数 │  保留率  │ 过滤后反转率 │ 过滤后振幅中位数 │ 过滤后反转K振幅中位数 │
├─────────┼───────────┼────────────┼─────────┼────────────┼────────────────┼─────────────────┼──────────┼──────────────┼──────────────────┼───────────────────────┤
│    0    │ 'ETHUSDT' │   '7.0'    │ '0.10%' │  '8.98%'   │    '0.46%'     │     '0.13%'     │ '86.83%' │   '4.14%'    │     '0.54%'      │        '0.13%'        │
│    1    │ 'ETHUSDT' │   '7.0'    │ '0.15%' │  '8.98%'   │    '0.46%'     │     '0.13%'     │ '85.03%' │   '4.23%'    │     '0.57%'      │        '0.13%'        │
│    2    │ 'ETHUSDT' │   '7.0'    │ '0.20%' │  '8.98%'   │    '0.46%'     │     '0.13%'     │ '78.44%' │   '3.05%'    │     '0.60%'      │        '0.36%'        │
│    3    │ 'ETHUSDT' │   '28.0'   │ '0.10%' │  '7.60%'   │    '0.35%'     │     '0.06%'     │ '82.56%' │   '1.99%'    │     '0.46%'      │        '0.06%'        │
│    4    │ 'ETHUSDT' │   '28.0'   │ '0.15%' │  '7.60%'   │    '0.35%'     │     '0.06%'     │ '77.20%' │   '1.74%'    │     '0.50%'      │        '0.09%'        │
│    5    │ 'ETHUSDT' │   '28.0'   │ '0.20%' │  '7.60%'   │    '0.35%'     │     '0.06%'     │ '69.45%' │   '1.29%'    │     '0.53%'      │        '0.11%'        │
└─────────┴───────────┴────────────┴─────────┴────────────┴────────────────┴─────────────────┴──────────┴──────────────┴──────────────────┴───────────────────────┘
 */

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        console.error('Failed to analyze klines:', error);
        process.exit(1);
    });
}

