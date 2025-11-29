import axios from 'axios';
import dayjs from "dayjs";
import {getPolyClient} from '../core/poly-client-manage.js';
import {getZ} from '../core/z-score.js';
import logger from '../core/Logger.js';
import {
    initHourOverview,
    updateHourOverview,
    getHourOverview,
    createMinuteSample,
    getMinuteSamples,
} from '../db/statisc-repository.js';

const UTC8_OFFSET = 8 * 60 * 60 * 1000;

/**
 * Convert UTC timestamp to UTC+8 day and hour
 * @param {number} timestamp - UTC timestamp in milliseconds
 * @returns {{day: number, hour: number}}
 */
function getUtc8DayHour(timestamp) {
    const utc8Time = new Date(timestamp + UTC8_OFFSET);
    const year = utc8Time.getUTCFullYear();
    const month = String(utc8Time.getUTCMonth() + 1).padStart(2, '0');
    const date = String(utc8Time.getUTCDate()).padStart(2, '0');
    const day = parseInt(`${year}${month}${date}`, 10);
    const hour = utc8Time.getUTCHours();
    return {day, hour};
}

/**
 * 获取UTC+8当前分钟数（0-59）
 * @returns {number} 0-59
 */
export function getCurrentMinute() {
    const now = Date.now();
    const utc8Time = new Date(now + UTC8_OFFSET);
    return utc8Time.getUTCMinutes(); // 0-59
}

/**
 * Fetch asset price from Binance spot API
 * @param {string} symbol - e.g., 'ETH', 'BTC'
 * @returns {Promise<string>} - Price as string
 */
async function fetchAssetPrice(symbol) {
    try {
        const response = await axios.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`,
        );
        return response.data.price;
    } catch (error) {
        logger.error(`Failed to fetch ${symbol} price from Binance:`, error.message);
        throw error;
    }
}

/**
 * Calculate liquidity sum in the range [0.90, 0.99] from orderbook
 * @param {Array} asks - Orderbook asks array
 * @param {number} topPrice - Top price (0-1)
 * @returns {number|null} - Liquidity sum or null
 */
function calculateLiquiditySum(asks) {
    let sum = 0;
    for (const ask of asks) {
        const price = Number(ask.price);
        const size = Number(ask.size);
        if (price <= 0.99) {
            sum += size;
        }
    }
    return Math.round(sum);
}

/**
 * Get top side volume from orderbook
 * @param {Object} orderbook
 * @param {string} topSide - 'UP' or 'DOWN'
 * @returns {number|null}
 */
function getTopVolume(orderbook, topSide) {
    try {
        const side = topSide === 'UP' ? 'asks' : 'bids';
        const orders = orderbook[side];
        if (!orders || !orders.length) return null;

        // Get total volume
        const totalVol = orders.reduce((sum, order) => sum + Number(order.size || 0), 0);
        return Math.round(totalVol);
    } catch (error) {
        logger.error('Failed to get top volume:', error.message);
        return null;
    }
}

/**
 * 初始化小时市场主表记录
 * @param {Object} market - 从PolyMarket API获取的市场对象
 * @param {string} symbol - 资产符号 (例如: 'ETH')
 * @param {string} eventSlug - 事件slug
 */
export async function initializeHourMarket(market, symbol, eventSlug) {
    try {
        const marketSlug = market.marketSlug || market.slug;
        const endDate = new Date(market.endDate);
        const {day, hour} = getUtc8DayHour(endDate.getTime());

        // 获取开盘价
        const openPrice = await fetchAssetPrice(symbol);
        logger.info(`[小时数据录入] 获取 ${symbol} 开盘价: ${openPrice}`);

        // 格式化市场结束时间为UTC+8字符串
        const utc8EndDate = new Date(endDate.getTime() + UTC8_OFFSET);
        const marketEndTime = utc8EndDate.toISOString().slice(0, 19).replace('T', ' ');

        const data = {
            symbol,
            event_slug: eventSlug,
            market_slug: marketSlug,
            market_end_time: marketEndTime,
            day,
            hour,
            open_price: openPrice,
            close_price: '', // 稍后填充
        };

        await initHourOverview(data);
        logger.info(`[小时数据录入] ✓ 已初始化市场 ${marketSlug} (${symbol} ${day} ${hour}:00)`);
    } catch (error) {
        logger.error('[小时数据录入] ✗ 初始化小时市场失败:', error);
        throw error;
    }
}

/**
 * 录入分钟采样数据
 * @param {string} marketSlug
 * @param {string} symbol - 资产符号
 * @param {string} upTokenId - UP token ID
 * @param {string} downTokenId - DOWN token ID
 * @param {number} minuteIdx - 分钟索引 (0-59)
 */
export async function recordMinuteSample(marketSlug, symbol, upTokenId, downTokenId, minuteIdx) {
    try {

        // Fetch asset price from Binance
        const assertPrice = await fetchAssetPrice(symbol);
        const numericAssertPrice = Number(assertPrice);

        const client = getPolyClient();

        // Fetch orderbooks for UP and DOWN tokens
        const [upOrderbook, downOrderbook] = await Promise.all([
            client.getOrderBook(upTokenId),
            client.getOrderBook(downTokenId),
        ]);

        if (!upOrderbook || !downOrderbook) {
            logger.warn(`[小时数据录入] 市场 ${marketSlug} 第 ${minuteIdx} 分钟缺少订单簿数据`);
            return;
        }

        // Extract best ask prices (概率价)
        let [, upPrice] = await client.getBestPrice(upTokenId);
        let [, downPrice] = await client.getBestPrice(downTokenId);
        upPrice = upPrice === 0 ? 1 : upPrice;
        downPrice = downPrice === 0 ? 1 : downPrice;
        // Determine top side
        const topSide = upPrice > downPrice ? 'UP' : 'DOWN';
        const topPrice = Math.max(upPrice, downPrice);

        // Calculate top price spread (bestAsk - bestBid)
        const topOrderbook = topSide === 'UP' ? upOrderbook : downOrderbook;
        const [topBid, topAsk] = topSide === 'UP'
            ? await client.getBestPrice(upTokenId)
            : await client.getBestPrice(downTokenId);
        const topPriceSpread = topBid && topAsk ? Math.abs(topAsk - topBid) : null;

        // Calculate z-score for top side
        // Remaining time: calculate based on market end time
        const overview = await getHourOverview(marketSlug);
        let topZ = null;
        let assertAmp = 0;

        const openPrice = Number(overview?.open_price || 0);
        if (openPrice > 0 && Number.isFinite(numericAssertPrice)) {
            assertAmp = Math.round(((numericAssertPrice - openPrice) / openPrice) * 10000);
        }

        if (overview?.market_end_time) {
            try {
                const endTime = new Date(overview.market_end_time.replace(' ', 'T') + '+08:00');
                const remainingSec = Math.max(0, (endTime.getTime() - Date.now()) / 1000);
                const z = await getZ(symbol, remainingSec);
                topZ = Math.round(z * 10); // Store as z×10
            } catch (error) {
                logger.warn(`[小时数据录入] 计算z-score失败: ${error.message}`);
            }
        }

        // Get top volume
        const topVol = getTopVolume(topOrderbook, topSide);

        // Calculate liquidity sum (when top_price >= 0.90)
        const liqSum = calculateLiquiditySum(topOrderbook.asks);

        const data = {
            market_slug: marketSlug,
            minute_idx: minuteIdx,
            assert_price: assertPrice,
            assert_amp: assertAmp,
            up_price: Math.round(upPrice * 1000), // Store as ×1000
            down_price: Math.round(downPrice * 1000),
            top_side: topSide,
            top_price: Math.round(topPrice * 1000),
            top_price_spread: topPriceSpread ? Math.round(topPriceSpread * 1000) : null,
            top_z: topZ,
            top_vol: topVol,
            liq_sum: liqSum,
        };

        await createMinuteSample(data);
        logger.info(`[小时数据录入] 已录入市场 ${marketSlug} 第 ${minuteIdx} 分钟数据`);
    } catch (error) {
        logger.error(`[小时数据录入] 录入市场 ${marketSlug} 分钟数据失败:`, error);
    }
}

/**
 * 完成小时市场数据录入（市场结束后）
 * @param {string} marketSlug
 * @param {string} symbol
 */
export async function finalizeHourMarket(marketSlug, symbol) {
    try {
        const overview = await getHourOverview(marketSlug);
        if (!overview) {
            logger.warn(`[小时数据录入] 未找到市场 ${marketSlug} 的主表记录`);
            return;
        }

        logger.info(`[小时数据录入] 开始完成市场 ${marketSlug} 的数据录入...`);

        // 获取收盘价
        const closePrice = await fetchAssetPrice(symbol);
        logger.info(`[小时数据录入] 获取 ${symbol} 收盘价: ${closePrice}`);

        // 获取分钟采样数据
        const samples = await getMinuteSamples(marketSlug);
        if (!samples || samples.length === 0) {
            logger.warn(`[小时数据录入] 市场 ${marketSlug} 没有分钟采样数据`);
            return;
        }

        // 获取第55和60分钟的z值
        const sample55 = samples.find(s => s.minute_idx === 55);
        const sample59 = samples.find(s => s.minute_idx === 59);

        const z55 = sample55?.top_z || null;
        const z60 = sample59?.top_z || null;

        // 计算涨跌幅
        const openPrice = Number(overview.open_price);
        let amp55 = null;
        let amp60 = null;

        if (sample55 && openPrice > 0) {
            const price55 = Number(sample55.assert_price);
            amp55 = Math.round(((price55 - openPrice) / openPrice) * 10000); // ×100 for percentage
        }

        if (sample59 && openPrice > 0) {
            const price60 = Number(sample59.assert_price);
            amp60 = Math.round(((price60 - openPrice) / openPrice) * 10000);
        }

        // 获取最后一个采样的交易量
        const lastSample = samples[samples.length - 1];
        const vol = lastSample?.top_vol || null;

        const updateData = {
            close_price: closePrice,
            z_55: z55,
            z_60: z60,
            amp_55: amp55,
            amp_60: amp60,
            vol,
        };

        await updateHourOverview(marketSlug, updateData);
        logger.info(`[小时数据录入] ✓ 已完成市场 ${marketSlug} 数据录入 (共 ${samples.length} 条分钟数据)`);
    } catch (error) {
        logger.error(`[小时数据录入] ✗ 完成市场 ${marketSlug} 数据录入失败:`, error);
    }
}
