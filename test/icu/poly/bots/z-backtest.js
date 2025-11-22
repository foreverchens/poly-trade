import ccxt from "ccxt";
import dayjs from "dayjs";
import { sigma1hFrom5mCloses, calculateRawZ } from "../../../../src/icu/poly/core/z-score.js";

/** ================= 回测逻辑 ================= */

async function fetchHistoricalData(symbol, days = 8) {
    console.log(`正在拉取 ${days} 天的 ${symbol} 5m K线数据...`);
    const ex = new ccxt.binance({ enableRateLimit: true });

    const end = Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;

    let allOHLCV = [];
    let since = start;

    while (since < end) {
        try {
            // 每次拉取 1000 根
            const ohlcv = await ex.fetchOHLCV(symbol, "5m", since, 1000);
            if (!ohlcv || ohlcv.length === 0) break;

            allOHLCV = allOHLCV.concat(ohlcv);
            const lastTime = ohlcv[ohlcv.length - 1][0];
            if (lastTime >= end) break;
            since = lastTime + 5 * 60 * 1000; // 下一根
        } catch (e) {
            console.error("Fetch error:", e.message);
            break;
        }
    }

    // 去重并排序
    const uniqueMap = new Map();
    allOHLCV.forEach((k) => uniqueMap.set(k[0], k));
    const sorted = Array.from(uniqueMap.values()).sort((a, b) => a[0] - b[0]);

    console.log(`成功获取 ${sorted.length} 根K线`);
    return sorted;
}

async function runBacktest(symbol = "ETH/USDT", days = 8) {
    // 拉取天数数据 或 回测最近天数，保证有足够的历史计算sigma
    const candles = await fetchHistoricalData(symbol, days);
    if (!candles.length) {
        console.error("无数据，退出");
        return;
    }
    console.log(`时间范围: ${dayjs(candles[0][0]).format('YYYY-MM-DD HH:mm:ss')} - ${dayjs(candles[candles.length - 1][0]).format('YYYY-MM-DD HH:mm:ss')}`);

    // 构建时间索引以便快速查找
    // Map<Timestamp, Candle>
    const candleMap = new Map();
    candles.forEach((c) => candleMap.set(c[0], c));

    const hoursToTest = days * 24;
    const now = Date.now();
    const currentHourStart = now - (now % 3600000);

    // 从最近一个完整小时倒推
    const results = [];

    for (let i = 1; i <= hoursToTest; i++) {
        const hourStart = currentHourStart - i * 3600000;

        // 1. 获取 S0 (小时第一根K线 Open)
        const c0 = candleMap.get(hourStart);
        if (!c0) continue;
        const S0 = c0[1];

        // 2. 获取 S55 (第55分钟的价格)
        // 对应的是 XX:50:00 开始的那根K线的 Close，或者 XX:55:00 开始的那根的 Open
        // 这里取 XX:50:00 这根K线的 Close 作为 55分的参考价
        const ts55 = hourStart + 50 * 60 * 1000;
        const c55 = candleMap.get(ts55);

        if (!c55) continue;
        const S55 = c55[4]; // Close

        // 3. 获取 S_close (小时收盘价)
        // 对应 XX:55:00 开始的那根K线的 Close
        const tsEnd = hourStart + 55 * 60 * 1000;
        const cEnd = candleMap.get(tsEnd);
        if (!cEnd) continue;
        const SClose = cEnd[4];

        // 4. 计算第55分钟时的 sigma1h
        // 需要获取截止到 ts55 的前 240 根K线
        // 在 candles 数组中找到 c55 的索引
        const idx55 = candles.findIndex((c) => c[0] === ts55);
        if (idx55 < 240) continue; // 数据不足

        // 取过去 240 根（包含 c55 本身作为最新数据点）
        const historyCloses = candles.slice(idx55 - 240 + 1, idx55 + 1).map((c) => c[4]);

        // 使用导入的计算函数
        let sigma1h;
        try {
             sigma1h = sigma1hFrom5mCloses(historyCloses);
        } catch (e) {
            continue;
        }

        // 5. 计算 z 值
        // 剩余时间 5 分钟
        const tSec = 300;

        let z;
        try {
            z = calculateRawZ(S55, S0, sigma1h, tSec);
        } catch (e) {
            continue;
        }

        // 6. 判定结果
        const isUpOpen = S55 > S0; // 55分时是涨的
        const isUpClose = SClose > S0; // 收盘时是涨的
        const reversed = isUpOpen !== isUpClose; // 是否反转了

        results.push({
            time: dayjs(hourStart).format("MM-DD HH:mm"),
            S0,
            S55,
            SClose,
            sigma1h: (sigma1h * 100).toFixed(2) + "%",
            z: z.toFixed(2),
            reversed: reversed ? "❌ 反转" : "✅ 稳住",
            delta55: (((S55 - S0) / S0) * 100).toFixed(2) + "%", // 55分时的涨跌幅
            deltaFinal: (((SClose - S0) / S0) * 100).toFixed(2) + "%", // 最终涨跌幅
        });
    }

    // 按时间正序打印
    const sortedResults = results.reverse();


    // console.table(sortedResults);

    // 统计分析
    console.log("\n===== 统计分析 (55分 -> 60分) =====");
    const zBuckets = [
        { min: 0, max: 1, label: "0 <= z < 1" },
        { min: 1, max: 1.5, label: "1 <= z < 1.5" },
        { min: 1.5, max: 2, label: "1.5 <= z < 2" },
        { min: 2, max: 3, label: "2 <= z < 3" },
        { min: 3, max: 4, label: "3 <= z < 4" },
        { min: 4, max: 5, label: "4 <= z < 5" },
        { min: 5, max: 99, label: "5 <= z < 99" },
    ];

    const rltTotal = sortedResults.length ; // 去除最后20个样本，因为它们是当前小时的数据
    console.log('总样本数: ', rltTotal);

    // sortedResults.forEach((r) => {
    //     if(parseFloat(r.z) >= 5 && parseFloat(r.z) < 55 && r.reversed.includes("反转")) {
    //         console.log(r);
    //     }
    // });
    console.table(sortedResults.slice(sortedResults.length - 10));

    zBuckets.forEach((bucket) => {
        const subset = sortedResults.filter((r) => {
            const zVal = parseFloat(r.z);
            return zVal >= bucket.min && zVal < bucket.max;
        });
        const total = subset.length;
        const reversedCount = subset.filter((r) => r.reversed.includes("反转")).length;
        const safeCount = total - reversedCount;
        const safeRate = total ? ((safeCount / total) * 100).toFixed(1) : "0.0";
        const avgDelta55 = subset.reduce((acc, r) => acc + Math.abs(parseFloat(r.delta55)), 0) / total;
        const avgDeltaFinal = subset.reduce((acc, r) => acc + Math.abs(parseFloat(r.deltaFinal)), 0) / total;

        console.log(
            `[${bucket.label}]: 总数 ${total}  | 占比 ${((total / rltTotal) * 100).toFixed(1)}% | 反转 ${reversedCount} 次| ✅ 胜率 ${safeRate}% | 平均55分涨跌幅 ${avgDelta55 ? avgDelta55.toFixed(2) : "0.00"}% | 平均最终涨跌幅 ${avgDeltaFinal ? avgDeltaFinal.toFixed(2) : "0.00"}%`,
        );
    });
}

runBacktest("ETH/USDT", 15).catch(console.error);
