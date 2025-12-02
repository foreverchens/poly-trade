import prisma from './client.js';

/**
 * Initialize hour_overview record when market opens
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function initHourOverview(data) {
    try {
        return await prisma.hour_overview.create({
            data: {
                symbol: data.symbol,
                event_slug: data.event_slug,
                market_slug: data.market_slug,
                market_end_time: data.market_end_time,
                day: data.day,
                hour: data.hour,
                open_price: data.open_price,
                close_price: data.close_price || '',
            },
        });
    } catch (error) {
        console.error('Failed to init hour_overview:', error);
        throw error;
    }
}

/**
 * Update hour_overview with closing data
 * @param {string} market_slug
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function updateHourOverview(market_slug, data) {
    try {
        return await prisma.hour_overview.update({
            where: { market_slug },
            data: {
                close_price: data.close_price,
                z_55: data.z_55,
                z_60: data.z_60,
                amp_55: data.amp_55,
                amp_60: data.amp_60,
                vol: data.vol,
            },
        });
    } catch (error) {
        console.error('Failed to update hour_overview:', error);
        throw error;
    }
}

/**
 * Get hour_overview by market_slug
 * @param {string} market_slug
 * @returns {Promise<Object|null>}
 */
export async function getHourOverview(market_slug) {
    try {
        return await prisma.hour_overview.findUnique({
            where: { market_slug },
        });
    } catch (error) {
        console.error('Failed to get hour_overview:', error);
        return null;
    }
}

/**
 * Create minute sample record
 * @param {Object} data
 * @returns {Promise<Object>}
 */
export async function createMinuteSample(data) {
    try {
        return await prisma.hour_minute_samples.create({
            data: {
                market_slug: data.market_slug,
                minute_idx: data.minute_idx,
                assert_price: data.assert_price,
                assert_amp: data.assert_amp,
                up_price: data.up_price,
                down_price: data.down_price,
                top_side: data.top_side,
                top_price: data.top_price,
                top_price_spread: data.top_price_spread,
                top_z: data.top_z,
                top_vol: data.top_vol,
                liq_sum: data.liq_sum,
            },
        });
    } catch (error) {
        console.error('Failed to create minute sample:', error);
        throw error;
    }
}

/**
 * Get minute samples for a market
 * @param {string} market_slug
 * @returns {Promise<Array>}
 */
export async function getMinuteSamples(market_slug) {
    try {
        return await prisma.hour_minute_samples.findMany({
            where: { market_slug },
            orderBy: { minute_idx: 'asc' },
        });
    } catch (error) {
        console.error('Failed to get minute samples:', error);
        return [];
    }
}

/**
 * Get recent minute samples for a market (ordered by minute_idx desc, limited)
 * @param {string} market_slug
 * @param {number} limit - Maximum number of samples to return
 * @returns {Promise<Array>}
 */
export async function getRecentMinuteSamples(market_slug, limit = 30) {
    try {
        return await prisma.hour_minute_samples.findMany({
            where: { market_slug },
            orderBy: { minute_idx: 'desc' },
            take: limit,
        });
    } catch (error) {
        console.error('Failed to get recent minute samples:', error);
        return [];
    }
}

/**
 * Get minute sample at specific minute
 * @param {string} market_slug
 * @param {number} minute_idx
 * @returns {Promise<Object|null>}
 */
export async function getMinuteSample(market_slug, minute_idx) {
    try {
        return await prisma.hour_minute_samples.findUnique({
            where: {
                market_slug_minute_idx: {
                    market_slug,
                    minute_idx,
                },
            },
        });
    } catch (error) {
        console.error('Failed to get minute sample:', error);
        return null;
    }
}

/**
 * Query hour overviews by day and hour range
 * @param {number} day - YYYYMMDD
 * @param {number} hourStart
 * @param {number} hourEnd
 * @returns {Promise<Array>}
 */
export async function queryHourOverviewsByTimeRange(day, hourStart, hourEnd) {
    try {
        return await prisma.hour_overview.findMany({
            where: {
                day,
                hour: {
                    gte: hourStart,
                    lte: hourEnd,
                },
            },
            orderBy: [{ day: 'asc' }, { hour: 'asc' }],
        });
    } catch (error) {
        console.error('Failed to query hour overviews:', error);
        return [];
    }
}

/**
 * Delete hour_overview/hour_minute_samples records older than the provided UTC+8 day/hour
 * @param {number} thresholdDay - YYYYMMDD
 * @param {number} thresholdHour - 0-23
 * @returns {Promise<{overviews: number, samples: number}>}
 */
export async function deleteHourDataBefore(thresholdDay, thresholdHour) {
    try {
        const oldOverviews = await prisma.hour_overview.findMany({
            where: {
                OR: [
                    { day: { lt: thresholdDay } },
                    {
                        day: thresholdDay,
                        hour: { lt: thresholdHour },
                    },
                ],
            },
            select: { market_slug: true },
        });

        if (!oldOverviews.length) {
            return { overviews: 0, samples: 0 };
        }

        const marketSlugs = oldOverviews.map(item => item.market_slug);

        const deleteSamplesResult = await prisma.hour_minute_samples.deleteMany({
            where: { market_slug: { in: marketSlugs } },
        });

        const deleteOverviewResult = await prisma.hour_overview.deleteMany({
            where: { market_slug: { in: marketSlugs } },
        });

        return {
            overviews: deleteOverviewResult.count,
            samples: deleteSamplesResult.count,
        };
    } catch (error) {
        console.error('Failed to delete old hour data:', error);
        return { overviews: 0, samples: 0 };
    }
}
