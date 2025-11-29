import axios from 'axios';
import { getPolyClient } from '../core/poly-client-manage.js';
import { getZ } from '../core/z-score.js';
import logger from '../core/Logger.js';
import {
    initHourOverview,
    updateHourOverview,
    getHourOverview,
    createMinuteSample,
    getMinuteSamples,
} from '../db/statistics-repository.js';

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
    return { day, hour };
}

/**
 * Get current minute index (1-60) for the current hour in UTC+8
 * @returns {number} 1-60
 */
function getCurrentMinuteIndex() {
    const now = Date.now();
    const utc8Time = new Date(now + UTC8_OFFSET);
    return utc8Time.getUTCMinutes() + 1; // 1-based index
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
function calculateLiquiditySum(asks, topPrice) {
    if (topPrice < 0.90) {
        return null;
    }

    let sum = 0;
    for (const ask of asks) {
        const price = Number(ask.price);
        const size = Number(ask.size);
        if (price >= 0.90 && price <= 0.99) {
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
 * Initialize main table record when hour market opens
 * @param {Object} market - Market object from PolyMarket API
 * @param {string} symbol - Asset symbol (e.g., 'ETH')
 * @param {string} eventSlug - Event slug
 */
export async function initializeHourMarket(market, symbol, eventSlug) {
    try {
        const marketSlug = market.marketSlug || market.slug;
        const endDate = new Date(market.endDate);
        const { day, hour } = getUtc8DayHour(endDate.getTime());

        // Fetch opening price
        const openPrice = await fetchAssetPrice(symbol);

        // Format market end time as UTC+8 string
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
            close_price: '', // Will be filled later
        };

        await initHourOverview(data);
        logger.info(`[HourRecorder] Initialized market ${marketSlug} for ${symbol} ${day} ${hour}:00`);
    } catch (error) {
        logger.error('[HourRecorder] Failed to initialize hour market:', error);
        throw error;
    }
}

/**
 * Record minute sample data
 * @param {string} marketSlug
 * @param {string} symbol - Asset symbol
 * @param {string} upTokenId - UP token ID
 * @param {string} downTokenId - DOWN token ID
 */
export async function recordMinuteSample(marketSlug, symbol, upTokenId, downTokenId) {
    try {
        const minuteIdx = getCurrentMinuteIndex();

        // Fetch asset price from Binance
        const assertPrice = await fetchAssetPrice(symbol);

        const client = getPolyClient();

        // Fetch orderbooks for UP and DOWN tokens
        const [upOrderbook, downOrderbook] = await Promise.all([
            client.getOrderBook(upTokenId),
            client.getOrderBook(downTokenId),
        ]);

        if (!upOrderbook || !downOrderbook) {
            logger.warn(`[HourRecorder] Missing orderbook for ${marketSlug} at minute ${minuteIdx}`);
            return;
        }

        // Extract best ask prices (概率价)
        const [, upPrice] = await client.getBestPrice(upTokenId);
        const [, downPrice] = await client.getBestPrice(downTokenId);

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
        if (overview?.market_end_time) {
            try {
                const endTime = new Date(overview.market_end_time.replace(' ', 'T') + '+08:00');
                const remainingSec = Math.max(0, (endTime.getTime() - Date.now()) / 1000);
                const z = await getZ(symbol, remainingSec);
                topZ = Math.round(z * 10); // Store as z×10
            } catch (error) {
                logger.warn(`[HourRecorder] Failed to calculate z-score: ${error.message}`);
            }
        }

        // Get top volume
        const topVol = getTopVolume(topOrderbook, topSide);

        // Calculate liquidity sum (when top_price >= 0.90)
        const liqSum = topPrice >= 0.90
            ? calculateLiquiditySum(topOrderbook.asks, topPrice)
            : null;

        const data = {
            market_slug: marketSlug,
            minute_idx: minuteIdx,
            assert_price: assertPrice,
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
        logger.info(`[HourRecorder] Recorded minute ${minuteIdx} for ${marketSlug}`);
    } catch (error) {
        logger.error(`[HourRecorder] Failed to record minute sample for ${marketSlug}:`, error);
    }
}

/**
 * Finalize hour overview after market ends
 * @param {string} marketSlug
 * @param {string} symbol
 */
export async function finalizeHourMarket(marketSlug, symbol) {
    try {
        const overview = await getHourOverview(marketSlug);
        if (!overview) {
            logger.warn(`[HourRecorder] No overview found for ${marketSlug}`);
            return;
        }

        // Fetch closing price from Binance
        const closePrice = await fetchAssetPrice(symbol);

        // Get minute samples
        const samples = await getMinuteSamples(marketSlug);
        if (!samples || samples.length === 0) {
            logger.warn(`[HourRecorder] No minute samples found for ${marketSlug}`);
            return;
        }

        // Get z-scores at minute 55 and 60
        const sample55 = samples.find(s => s.minute_idx === 55);
        const sample60 = samples.find(s => s.minute_idx === 60);

        const z55 = sample55?.top_z || null;
        const z60 = sample60?.top_z || null;

        // Calculate amplitudes
        const openPrice = Number(overview.open_price);
        let amp55 = null;
        let amp60 = null;

        if (sample55 && openPrice > 0) {
            const price55 = Number(sample55.assert_price);
            amp55 = Math.round(((price55 - openPrice) / openPrice) * 10000); // ×100 for percentage
        }

        if (sample60 && openPrice > 0) {
            const price60 = Number(sample60.assert_price);
            amp60 = Math.round(((price60 - openPrice) / openPrice) * 10000);
        }

        // Get volume from last sample
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
        logger.info(`[HourRecorder] Finalized market ${marketSlug}`);
    } catch (error) {
        logger.error(`[HourRecorder] Failed to finalize hour market ${marketSlug}:`, error);
    }
}
