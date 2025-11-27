import ccxt from "ccxt";

/**
 * Z-Score 计算核心模块
 * ==========================================
 * 用于量化交易策略中的均值回归与收敛分析。
 * 该模块计算当前价格相对于小时开盘价的"标准化偏离度" (Z-Score)。
 *
 * 核心逻辑：
 * 1. 波动率估计 (σ): 基于历史 5m K线数据，使用 MAE/EWMA 估算当前市场波动率。
 * 2. 时间衰减 (Time Decay): 随着小时临近结束，剩余时间 (τ) 减少，相同的价格偏离会被放大为更高的 Z 值。
 * 3. Z-Score 公式: z = |St - S0| / (S0 * σ1h * sqrt(τ/60))
 *    - St: 当前价格
 *    - S0: 小时开盘价
 *    - σ1h: 1小时波动率
 *    - τ: 剩余时间(分钟)
 *
 * 优化说明：
 * - 复用 ccxt 实例，避免重复连接开销
 * - 缓存 σ1h (5分钟) 和 S0 (每小时)，减少 API 请求
 * - 简化函数签名，配置参数内置
 */

// 1. 全局复用 ccxt 实例
const ex = new ccxt.binance({ enableRateLimit: true, options: { defaultType: "spot" } });

// 2. 简单的内存缓存
// 结构: { [symbol]: { sigma: { val, ts }, s0: { val, hour } } }
const CACHE = {};
const SIGMA_TTL = 5 * 60 * 1000; // σ 缓存有效期 5 分钟

// 3. 配置参数
const CONFIG = {
    limit: 240,         // 回溯 240 根 5m K 线
    dist: "normal",     // 分布假设
    lambda: 0.98,       // EWMA 系数 数值越小短期越敏感
    winsorLow: 0.0,
    winsorHigh: 0.995,  // 保留更多极端值
    sigmaMin: 0.003,    // 0.3%/h
    sigmaMax: 0.06,     // 6%/h
};

/** ===== 内部工具 ===== */
function logReturns5m(closes) {
    if (!Array.isArray(closes) || closes.length < 2) throw new Error("closes 长度需>=2");
    const out = [];
    for (let i = 1; i < closes.length; i++) {
        const a = closes[i - 1],
            b = closes[i];
        if (!(a > 0 && b > 0)) throw new Error("收盘价必须为正数");
        out.push(Math.log(b / a));
    }
    return out;
}

function quantileSorted(sortedArr, q) {
    if (!sortedArr.length) return 0;
    const pos = (sortedArr.length - 1) * q;
    const lo = Math.floor(pos),
        hi = Math.ceil(pos);
    if (lo === hi) return sortedArr[lo];
    const w = pos - lo;
    return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

function winsorize(arr, lowQ = 0.0, highQ = 0.99) {
    if (!arr.length) return [];
    const sorted = [...arr].sort((a, b) => a - b);
    const lo = quantileSorted(sorted, lowQ);
    const hi = quantileSorted(sorted, highQ);
    return arr.map((x) => Math.min(hi, Math.max(lo, x)));
}

function ewma(series, lambda = 0.95) {
    if (!series.length) return 0;
    let s = series[0];
    for (let i = 1; i < series.length; i++) s = lambda * s + (1 - lambda) * series[i];
    return s;
}

export function sigma1hFrom5mCloses(
    closes5m,
    {
        dist = "normal",
        lambda = 0.95,
        winsorLow = 0.0,
        winsorHigh = 0.99,
        sigmaMin = 0.003,
        sigmaMax = 0.06,
    } = {},
) {
    const r = logReturns5m(closes5m);
    const absrW = winsorize(r.map(Math.abs), winsorLow, winsorHigh);
    const mae =
        lambda == null
            ? absrW.reduce((a, b) => a + b, 0) / Math.max(1, absrW.length)
            : ewma(absrW, lambda);
    const conv = dist === "laplace" ? Math.SQRT2 : Math.sqrt(Math.PI / 2);
    const sigma5m = mae * conv;
    let sigma1h = sigma5m * Math.sqrt(12); // 5m -> 1h
    sigma1h = Math.min(sigmaMax, Math.max(sigmaMin, sigma1h)); // 护栏
    return sigma1h;
}

/**
 * 纯数学计算 Z-Score
 * @returns {number} 原始 Z 值 (未保留小数)
 */
export function calculateRawZ(St, S0, sigma1h, tSec) {
    const tauMin = Math.max(0.5, tSec / 60); // 剩余分钟，设 0.5 下限防数值发散
    const denom = S0 * sigma1h * Math.sqrt(tauMin / 60);
    if (!(denom > 0)) throw new Error("分母无效，sigma 或 S0 异常");
    const z = Math.abs(St - S0) / denom;
    return z;
}

/** ===== 缓存获取逻辑 ===== */

async function getSigmaCached(symbol) {
    const now = Date.now();
    if (!CACHE[symbol]) CACHE[symbol] = {};

    // 检查缓存是否有效
    const cached = CACHE[symbol].sigma;
    if (cached && (now - cached.ts < SIGMA_TTL)) {
        return cached.val;
    }

    // 获取新数据 (240 根 5m K 线)
    const ohlc = await ex.fetchOHLCV(symbol, "5m", undefined, CONFIG.limit);
    if (!ohlc?.length) throw new Error("获取 5m K 线失败");

    const closes = ohlc.map((x) => x[4]);
    const val = sigma1hFrom5mCloses(closes, CONFIG);

    // 更新缓存
    CACHE[symbol].sigma = { val, ts: now };
    return val;
}

async function getS0Cached(symbol) {
    const now = Date.now();
    const hourStart = now - (now % 3600000); // UTC 小时起点

    if (!CACHE[symbol]) CACHE[symbol] = {};

    // 检查缓存: 如果已经有本小时的 S0，直接返回
    const cached = CACHE[symbol].s0;
    if (cached && cached.hour === hourStart) {
        return cached.val;
    }

    // 获取当前小时数据 (取前几根即可)
    const currHour5m = await ex.fetchOHLCV(symbol, "5m", hourStart, 12);
    if (!currHour5m?.length) throw new Error("未能获取当前小时 5m 数据");

    const firstCandle = currHour5m.find((k) => k[0] === hourStart) || currHour5m[0];
    const val = firstCandle[1]; // open

    // 更新缓存
    CACHE[symbol].s0 = { val, hour: hourStart };
    return val;
}

/**
 * 获取当前市场状态的 Z-Score
 *
 * 物理意义：
 * - z ≈ 0: 价格在开盘价附近，属正常波动。
 * - z > 2: 价格出现显著偏离。
 * - z > 5: 价格极端偏离，通常意味着本小时趋势已定（对于 Fixed-Time 策略），或者即将发生反转（对于均值回归策略）。
 *
 * @param {string} symbol - 交易对符号，如 'ETH/USDT'
 * @param {number} tSec   - 当前小时剩余时间（秒），例如 300 表示还剩 5 分钟
 * @returns {Promise<number>} z 值（保留 1 位小数，如 4.2）
 */
export async function getZ(symbol, tSec) {
    symbol = symbol + "/USDT";
    if (!(tSec >= 0)) throw new Error("tSec 必须是非负秒数（当前小时剩余时间，单位秒）");

    // 1) 获取缓存或计算 σ1h 和 S0 (并行执行)
    const [sigma1h, S0] = await Promise.all([
        getSigmaCached(symbol),
        getS0Cached(symbol)
    ]);

    // 2) 取最新价 St（ticker.last）- 必须实时
    const ticker = await ex.fetchTicker(symbol);
    const St = Number(ticker.last);
    if (!(St > 0)) throw new Error("最新成交价无效");

    // 3) 计算 z
    const z = calculateRawZ(St, S0, sigma1h, tSec);

    // 保留1位小数并转回数字
    return Number(z.toFixed(1));
}
