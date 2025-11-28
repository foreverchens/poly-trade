import dayjs from "dayjs";
import { resolveSlugList, fetchMarkets, getAsksLiq, resolvePositionSize } from "./common.js";
import logger from "../../core/Logger.js";
import { getPolyClient } from "../../core/poly-client-manage.js";

export class UpBotCache {
    constructor(config) {
        this.slugTemplate = config.slug;
        this.maxMinutesToEnd = config.maxMinutesToEnd;
        this.maxSizeUsdc = config.maxSizeUsdc;

        // 运行时数据存储
        this.store = {
            hour: null,
            targetSlug: null,
            market: null, // 明确只缓存单个 market 对象
            balance: 0,
            liquidity: new Map(), // tokenId -> [val1, val2, val3, ...]
        };
    }

    /**
     * 检查小时轮转,如果跨小时则重置长效缓存
     */
    _rotate() {
        const currentHour = dayjs().hour();
        if (this.store.hour !== currentHour) {
            logger.info(`[UpBotCache] 小时轮转 ${this.store.hour} -> ${currentHour}, 重置缓存`);
            this.store.hour = currentHour;
            this.store.targetSlug = null;
            this.store.market = null;
            this.store.balance = 0;
            this.store.liquidity.clear();
        }
    }

    /**
     * 获取当前 Slug (每小时解析一次)
     */
    getTargetSlug() {
        this._rotate();
        if (!this.store.targetSlug) {
            this.store.targetSlug = resolveSlugList(this.slugTemplate);
            logger.info(`[UpBotCache] 重新解析TargetSlug: ${this.store.targetSlug}`);
        }
        // Slug 变化不频繁，不需要每次命中都打印，仅在解析时打印
        return this.store.targetSlug;
    }

    /**
     * 获取单一市场信息 (每小时请求一次)
     * UpBot 场景下一个 Slug 只对应一个 Market
     */
    async getMarket() {
        this._rotate();
        if (!this.store.market) {
            const slug = this.getTargetSlug();
            // false 代表不进行时间过滤(由Bot自行控制)
            const markets = await fetchMarkets(slug, this.maxMinutesToEnd, false);

            if (markets && markets.length > 0) {
                this.store.market = markets[0];
                logger.info(
                    `[UpBotCache] 市场已缓存更新: ${this.store.market.slug} (Slug=${slug})`,
                );
            } else {
                logger.info(`[UpBotCache] 未找到市场, 缓存为空: ${slug}`);
                return null;
            }
        }
        // 市场对象较大，仅在首次获取时打印，后续不打印命中日志，以免刷屏
        return this.store.market;
    }

    /**
     * 获取余额
     */
    async getBalance(extraSizeUsdc) {
        // 如果已有缓存值（大于0），直接返回
        if (this.store.balance > 0) {
            logger.info(`[UpBotCache] 余额缓存: ${this.store.balance} USDC`);
            return this.store.balance;
        }

        try {
            let val = await resolvePositionSize(getPolyClient());
            if (val < 1) {
                logger.error(`[UpBotCache] 余额为0，可能是API异常或钱包确实无余额`);
                return 0;
            }
            val = Math.min(val, extraSizeUsdc);
            this.store.balance = val;
            logger.info(`[UpBotCache] 余额更新: ${val} USDC`);
            return val;
        } catch (err) {
            logger.error("[UpBotCache] 余额查询失败", err);
            return 0;
        }
    }

    /**
     * 本地扣减余额 (乐观更新)
     * @param {number} amount - 扣减金额
     */
    async deductBalance(amount) {
        // 向上取整
        amount = Math.ceil(amount);
        if (this.store.balance < 1) {
            // 如果余额小于1，尝试获取余额
            const balance = await this.getBalance(this.maxSizeUsdc);
            if (balance < amount) {
                logger.error(`[UpBotCache] 余额${balance}不足${amount}，无法扣减`);
                return;
            }
            this.store.balance = Math.floor(balance);
        }
        const oldVal = this.store.balance;
        this.store.balance = oldVal - amount;
        logger.info(`[UpBotCache] 本地扣减余额: ${oldVal} -> ${this.store.balance} (-${amount})`);
    }

    /**
     * 获取卖方流动性 历史3个样本求平均值
     */
    async getAsksLiq(tokenId) {
        const newVal = await getAsksLiq(getPolyClient(), tokenId);
        let queue = this.store.liquidity.get(tokenId) ?? [];
        queue.push(newVal);
        if (queue.length > 3) {
            queue.shift();
        }
        this.store.liquidity.set(tokenId, queue);
        const avg = queue.reduce((sum, val) => sum + val, 0) / queue.length;
        return Number(avg.toFixed(1));
    }
}
