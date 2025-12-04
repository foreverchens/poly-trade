import dayjs from "dayjs";
import { listLimitKlines } from "./common.js";

/**
 * 检查方向稳定性（基于价格历史，使用加权平均价格）
 * 使用非线性权重：价格越接近0或1，权重调整越大（使用平方函数）
 * 权重范围：[0.9, 1.1]，价格>0.5时权重更高，价格<0.5时权重更低
 * 市场价格已包含时间因素，因此不添加时间权重
 * @param {Object} params
 * @param {Object} params.client - PolyClient实例
 * @param {string} params.tokenId - Token ID
 * @param {number} params.lookbackMinutes - 回看时间（分钟），默认30
 * @param {number} params.weightedThreshold - 加权平均价格阈值，默认0.75
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
export async function checkDirectionStability({
    client,
    tokenId,
    lookbackMinutes = 30,
    weightedThreshold = 0.75,
}) {
    try {
        const priceHistory = await client.getPricesHistory(tokenId);
        const now = Date.now() / 1000;
        const cutoffTime = now - lookbackMinutes * 60;
        // 过滤掉时间小于cutoffTime的价格
        const recentPriceHistory = priceHistory.history.filter((price) => price.t > cutoffTime);
        if (recentPriceHistory.length === 0) {
            return {
                allowed: false,
                reason: `风控-方向稳定性检查不通过、最近${lookbackMinutes}分钟价格数据为空，无法进行价格趋势判断`,
            };
        }

        // 计算加权价格数组：每个价格乘以对应权重
        const weightedPrices = recentPriceHistory.map((price) => {
            // 计算距离0.5的距离
            const distance = Math.abs(price.p - 0.5);
            const direction = price.p > 0.5 ? 1 : -1;

            // 归一化距离到[0, 1]并平方，让极端价格的影响更大
            const normalizedDistance = distance / 0.5;
            const squaredDistance = normalizedDistance * normalizedDistance;

            // 权重调整：基础1.0 ± 0.1 * squaredDistance
            // 价格>0.5时：权重在[1.0, 1.1]范围，价格<0.5时：权重在[0.9, 1.0]范围
            const weight = 1.0 + direction * 0.1 * squaredDistance;

            return price.p * weight;
        });
        // 计算加权平均价格
        let weightedAveragePrice =
            weightedPrices.reduce((sum, wp) => sum + wp, 0) / recentPriceHistory.length;
        // 获取当前小数、如果是美国时间 22点和4点
        const currentHour = dayjs().hour();
        if (currentHour === 22 || currentHour === 4) {
            // 美股时间 22点和4点、加权平均价格权重调整为0.95、增加通过难度
            weightedAveragePrice = weightedAveragePrice * 0.95;
        }
        // 获取当前剩余分钟数、对最后三分钟 额外增加权重
        const currentMinute = dayjs().minute();
        if (currentMinute >= 57) {
            // 最后三分钟、额外增加权重、直接增加价格
            weightedAveragePrice = weightedAveragePrice + ((currentMinute - 56) * 2)/100;
        }


        // 判断是否通过
        if (weightedAveragePrice < weightedThreshold) {
            return {
                allowed: false,
                reason: `风控-方向稳定性检查不通过、加权平均价格(${weightedAveragePrice.toFixed(4)})小于阈值(${weightedThreshold})，方向不明确，不进行额外买入`,
            };
        }
        return {
            allowed: true,
            reason: `风控-方向稳定性检查通过、加权平均价格=${weightedAveragePrice.toFixed(4)}、大于阈值${weightedThreshold}、可以进行额外买入`,
        };
    } catch (error) {
        return { allowed: false, reason: `风控-方向稳定性检查失败: ${error?.message ?? error}` };
    }
}

/**
 * 检查价格位置和价格趋势（基于K线数据）
 * @param {Object} params
 * @param {string} params.symbol - 交易对符号
 * @param {string} params.outcome - 信号方向 "UP" 或 "DOWN"
 * @param {number} params.pricePositionThreshold - 价格位置阈值，默认0.2
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
export async function checkPricePositionAndTrend({
    symbol,
    outcome,
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
            return { allowed: false, reason: "无法获取k线数据，跳过价格趋势检查" };
        }
        // 检查当前价格所在位置
        // 如果是上涨、检查当前价格在开盘价和最高价之间的位置、如果位置较低、则不进行额外买入
        // 如果是下跌、检查当前价格在开盘价和最低价之间的位置、如果位置较高、则不进行额外买入
        const curP = limitKlines[limitKlines.length - 1][4];
        const openP = limitKlines[0][1];
        if (curP > openP) {
            // 上涨
            const highP = limitKlines.reduce(
                (max, kline) => Math.max(max, kline[2]),
                limitKlines[0][2],
            );
            const pricePosition = (curP - openP) / (highP - openP);
            if (pricePosition < pricePositionThreshold) {
                const msg = `风控-价格位置检查不通过、当前价格${curP}在开盘价${openP}和最高价${highP}之间位置=${(pricePosition * 100).toFixed(1)}% 偏离开盘价低于${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较高、不进行额外买入`;
                return { allowed: false, reason: msg };
            }
        } else {
            // 下跌
            const lowP = limitKlines.reduce(
                (min, kline) => Math.min(min, kline[3]),
                limitKlines[0][3],
            );
            const pricePosition = (openP - curP) / (openP - lowP);
            if (pricePosition < pricePositionThreshold) {
                const msg = `风控-价格位置检查不通过、当前价格${curP}在开盘价${openP}和最低价${lowP}之间位置=${(pricePosition * 100).toFixed(1)}% 偏离开盘价低于${(pricePositionThreshold * 100).toFixed(0)}%、反转概率较高、不进行额外买入`;
                return { allowed: false, reason: msg };
            }
        }
        // 价格趋势检查、检查1min背离强度
        // 获取最近3根k线的第一根k线的最高价和最后一根k线的最低价、计算价差、如果价差大于当前价和开盘价的差值、则不进行额外买入
        const recentKlines = limitKlines.slice(-3);
        let highP = recentKlines[0][2];
        let lowP = recentKlines[2][3];
        const priceDiff = highP - lowP;
        const openDiff = openP - curP;
        // 检查最近3分钟趋势是否与信号方向背离，且波动幅度可能带来反转风险
        const lastCloseP = recentKlines[2][4];
        const firstOpenP = recentKlines[0][1];
        // 获取当前剩余分钟数、值域位 [1, 3]
        const remainingMinutes = Math.min(3, 60 - dayjs().minute());
        // 对价格差值进行加权、剩余时间越长、价格差值权重越大
        const priceWightDiff = priceDiff * remainingMinutes / 3;

        if (outcome === "UP") {
            // 信号方向为上涨、最新价格大于开盘价、但是最近3分钟整体方向是下跌、并且下跌预期程度有跌破风险、则不进行额外买入
            if (curP > openP && firstOpenP > lastCloseP && priceWightDiff > Math.abs(openDiff)) {
                const msg = `风控-价格趋势检查不通过、信号方向为上涨、最新价格大于开盘价、但是最近3分钟整体方向是下跌、并且下跌预期程度有跌破风险、则不进行额外买入 lastCloseP:${lastCloseP} firstOpenP:${firstOpenP} priceDiff:${priceWightDiff} openDiff:${openDiff} curP:${curP} openP:${openP}`;
                return { allowed: false, reason: msg };
            }
        } else {
            // 信号方向为下跌、最新价格小于开盘价、但是最近3分钟整体方向是上涨、并且上涨预期程度有突破风险、则不进行额外买入
            if (curP < openP && firstOpenP < lastCloseP && priceWightDiff > Math.abs(openDiff)) {
                const msg = `风控-价格趋势检查不通过、信号方向为下跌、最新价格小于开盘价、但是最近3分钟整体方向是上涨、并且上涨预期程度有突破风险、则不进行额外买入 lastCloseP:${lastCloseP} firstOpenP:${firstOpenP} priceDiff:${priceWightDiff} openDiff:${openDiff} curP:${curP} openP:${openP}`;
                return { allowed: false, reason: msg };
            }
        }
        return { allowed: true, reason: "风控-价格位置和趋势检查通过" };
    } catch (error) {
        return { allowed: false, reason: `风控-价格趋势检查失败: ${error?.message ?? error}` };
    }
}
