import dayjs from "dayjs";
import { listLimitKlines } from "./common.js";
import logger from "../../core/Logger.js";

/**
 * 检查方向稳定性（基于价格历史）
 * @param {Object} params
 * @param {Object} params.client - PolyClient实例
 * @param {string} params.tokenId - Token ID
 * @param {string} params.symbol - 交易对符号
 * @param {number} params.currentLoopHour - 当前循环小时
 * @param {number} params.priceThreshold - 价格阈值，默认0.5
 * @param {number} params.upPriceRatioThreshold - 上涨价格占比阈值，默认0.7
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
export async function checkDirectionStability({
    client,
    tokenId,
    symbol,
    currentLoopHour,
    priceThreshold = 0.5,
    upPriceRatioThreshold = 0.7,
}) {
    try {
        // 检查过去30分钟价格p>priceThreshold的次数占比是否高于upPriceRatioThreshold、如果不在、则不进行额外买入
        const priceHistory = await client.getPricesHistory(tokenId);
        const recentPriceHistory = priceHistory.history.filter(
            (price) => price.t > (Date.now() - 30 * 60 * 1000) / 1000,
        );
        if (recentPriceHistory.length === 0) {
            return { allowed: false, reason: "最近30分钟价格数据为空，无法进行价格趋势判断" };
        }
        const upPriceCount = recentPriceHistory.filter((price) => price.p > priceThreshold).length;
        const totalCount = recentPriceHistory.length;
        const upPriceRatio = upPriceCount / totalCount;
        if (upPriceRatio < upPriceRatioThreshold) {
            return {
                allowed: false,
                reason: `风控-方向稳定性检查不通过、最近30分钟价格p>${priceThreshold}的次数占比(${(upPriceRatio * 100).toFixed(1)}%)小于${(upPriceRatioThreshold * 100).toFixed(0)}%，方向不明确，不进行额外买入`,
            };
        }
        logger.info(
            `[${symbol}-${currentLoopHour}时] 风控-方向稳定性检查通过: 最近30分钟价格p>${priceThreshold}的次数占比=${(upPriceRatio * 100).toFixed(1)}%、可以进行额外买入、upPriceRatio=${upPriceRatio.toFixed(4)}`,
        );
        return { allowed: true, reason: "方向稳定性检查通过" };
    } catch (error) {
        logger.error(
            `[${symbol}-${currentLoopHour}时] 风控-方向稳定性检查失败`,
            error?.message ?? error,
        );
        return { allowed: false, reason: "风控-方向稳定性检查失败" };
    }
}

/**
 * 检查价格位置和价格趋势（基于K线数据）
 * @param {Object} params
 * @param {string} params.symbol - 交易对符号
 * @param {string} params.outcome - 信号方向 "UP" 或 "DOWN"
 * @param {number} params.currentLoopHour - 当前循环小时
 * @param {number} params.pricePositionThreshold - 价格位置阈值，默认0.2
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
export async function checkPricePositionAndTrend({
    symbol,
    outcome,
    currentLoopHour,
    pricePositionThreshold = 0.2,
}) {
    try {
        // 检查价格k线、查询最近10根1min级别k线的价格、如果涨跌趋势整体朝反转方向发展、则不进行额外买入
        // 需要避免的情况、比如
        // 1.上涨1%后、回踩到+0.2%、且仍有向下的趋势、此时可能UP方向概率仍然在90%以上、但实际具备反转可能、不进行额外买入
        // 2.下跌1%后、反弹到-0.2%、且仍有向上的趋势、此时可能DOWN方向概率仍然在90%以上、但实际具备反转可能、不进行额外买入
        //
        // 获取当前小时内所有1min级别k线数据
        const limitKlines = await listLimitKlines(symbol, dayjs().minute() + 1);
        if (!limitKlines || limitKlines.length <= 1) {
            logger.error(`[${symbol}-${currentLoopHour}时] 无法获取k线数据，跳过价格趋势检查`);
            return { allowed: false, reason: "无法获取k线数据，跳过价格趋势检查" };
        }
        // 检查当前价格所在位置
        // 如果是上涨、检查当前价格在开盘价和最高价之间的位置、如果位置较低、则不进行额外买入
        // 如果是下跌、检查当前价格在开盘价和最低价之间的位置、如果位置较高、则不进行额外买入
        const curP = limitKlines[limitKlines.length - 1][4];
        const openP = limitKlines[0][1];
        if (curP > openP) {
            // 上涨
            const highP = limitKlines.reduce((max, kline) => Math.max(max, kline[2]), limitKlines[0][2]);
            const pricePosition = (curP - openP) / (highP - openP);
            if (pricePosition < pricePositionThreshold) {
                const msg = `风控-价格位置检查不通过、
                        当前价格${curP}
                        在开盘价${openP}
                        和最高价${highP}之间位置=${(pricePosition * 100).toFixed(1)}% 偏离开盘价低于${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较高、不进行额外买入`;
                logger.info(`[${symbol}-${currentLoopHour}时] ${msg}`);
                return { allowed: false, reason: msg };
            }
            logger.info(
                `[${symbol}-${currentLoopHour}时] 风控-价格位置检查通过、
                        当前价格${curP}
                        在开盘价${openP}
                        和最高价${highP}之间位置=${(pricePosition * 100).toFixed(1)}%、偏离开盘价超过${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较低、进行额外买入`,
            );
        } else {
            // 下跌
            const lowP = limitKlines.reduce((min, kline) => Math.min(min, kline[3]), limitKlines[0][3]);
            const pricePosition = (openP - curP) / (openP - lowP);
            if (pricePosition < pricePositionThreshold) {
                const msg = `风控-价格位置检查不通过、
                        当前价格${curP}
                        在开盘价${openP}
                        和最低价${lowP}之间位置=${(pricePosition * 100).toFixed(1)}% 偏离开盘价低于${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较高、不进行额外买入`;
                logger.info(`[${symbol}-${currentLoopHour}时] ${msg}`);
                return { allowed: false, reason: msg };
            }
            logger.info(
                `[${symbol}-${currentLoopHour}时] 风控-价格位置检查通过、
                        当前价格${curP}
                        在开盘价${openP}
                        和最低价${lowP}之间位置=${(pricePosition * 100).toFixed(1)}% 偏离开盘价超过${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较低、进行额外买入`,
            );
        }
        // 价格趋势检查、检查1min背离强度
        // 获取最近3根k线的最高价和最低价、计算价差、如果价差大于当前价和开盘价的差值、则不进行额外买入
        const recentKlines = limitKlines.slice(-3);
        const highP = recentKlines.reduce((max, kline) => Math.max(max, kline[2]), recentKlines[0][2]);
        const lowP = recentKlines.reduce((min, kline) => Math.min(min, kline[3]), recentKlines[0][3]);
        const priceDiff = highP - lowP;
        const openDiff = openP - curP;
        // 检查最近3分钟趋势是否与信号方向背离，且波动幅度可能带来反转风险
        const lastCloseP = recentKlines[2][4];
        const firstOpenP = recentKlines[0][1];
        if (outcome === "UP") {
            // 信号方向为上涨、最新价格大于开盘价、但是最近3分钟整体方向是下跌、并且下跌预期程度有跌破风险、则不进行额外买入
            if (curP > openP && firstOpenP > lastCloseP && priceDiff > Math.abs(openDiff)) {
                const msg = `风控-价格趋势检查不通过、信号方向为上涨、最新价格大于开盘价、但是最近3分钟整体方向是下跌、并且下跌预期程度有跌破风险、则不进行额外买入
                        lastCloseP:${lastCloseP}
                        firstOpenP:${firstOpenP}
                        priceDiff:${priceDiff}
                        openDiff:${openDiff}
                        curP:${curP}
                        openP:${openP}
                    `;
                logger.info(`[${symbol}-${currentLoopHour}时] ${msg}`);
                return { allowed: false, reason: msg };
            }
        } else {
            // 信号方向为下跌、最新价格小于开盘价、但是最近3分钟整体方向是上涨、并且上涨预期程度有突破风险、则不进行额外买入
            if (curP < openP && firstOpenP < lastCloseP && priceDiff > Math.abs(openDiff)) {
                const msg = `风控-价格趋势检查不通过、信号方向为下跌、最新价格小于开盘价、但是最近3分钟整体方向是上涨、并且上涨预期程度有突破风险、则不进行额外买入
                        lastCloseP:${lastCloseP}
                        firstOpenP:${firstOpenP}
                        priceDiff:${priceDiff}
                        openDiff:${openDiff}
                        curP:${curP}
                        openP:${openP}
                    `;
                logger.info(`[${symbol}-${currentLoopHour}时] ${msg}`);
                return { allowed: false, reason: msg };
            }
        }
        logger.info(`[${symbol}-${currentLoopHour}时] 风控-价格趋势检查通过`);

        return { allowed: true, reason: "价格位置和趋势检查通过" };
    } catch (error) {
        logger.error(
            `[${symbol}-${currentLoopHour}时] 风控-价格趋势检查失败`,
            error?.message ?? error,
        );
        return { allowed: false, reason: "风控-价格趋势检查失败" };
    }
}

