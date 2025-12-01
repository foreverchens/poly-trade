import dayjs from "dayjs";
import cron from "node-cron";
import { resolveSlugList, fetchMarkets, getAsksLiq, resolvePositionSize } from "./common.js";
import logger from "../../core/Logger.js";

export class UpBotCache {
    constructor(config) {
        this.slugTemplate = config.slug;
        this.maxMinutesToEnd = config.maxMinutesToEnd;
        this.maxSizeUsdc = config.maxSizeUsdc;
        this.cronExpression = config.cronExpression || "* 30-59 * * * *";
        this.client = config.client;
        // 运行时数据存储
        this.store = {
            hour: null,
            targetSlug: null,
            market: null, // 明确只缓存单个 market 对象
            balance: 0,
            liquidity: new Map(), // tokenId -> [val1, val2, val3, ...]
        };

        this.tokenIds = null; // [upTokenId, downTokenId] 当前市场tokenIds
        this.orderBookCache = new Map(); // tokenId -> { asks, bestBidPrice, bestAskPrice, updatedAt }

        // 订单簿轮询任务
        this.orderBookCronTask = cron.schedule(this.cronExpression, async () => {
            this.getTargetSlug();
            const market = await this.getMarket();
            this._resolveTokenIds(market);
            if (!this.tokenIds) {
                return;
            }
            // 立即执行一次，确保缓存迅速可用
            for (const tokenId of this.tokenIds) {
                await this._fetchAndCacheOrderBook(tokenId);
            }
        });

        // 命中次数队列、用于计算命中率、 [getAsksLiq走缓存, getAsksLiq走查询,getBestPrice走缓存,getBestPrice走查询] 4个位置分别记录命中次数
        this.hitArr = new Array(4).fill(1);
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

            // 重置tokenIds和订单簿缓存
            this.tokenIds = null;
            this.orderBookCache.clear();

            // 打印命中率
            logger.info(`[UpBotCache] 缓存命中率:
                getAsksLiq函数缓存命中率为 ${this.hitArr[0]}/(${this.hitArr[0]} + ${this.hitArr[1]}) = ${((this.hitArr[0] / (this.hitArr[0] + this.hitArr[1])) * 100).toFixed(2)}%,
                getBestPrice函数缓存命中率为 ${this.hitArr[2]}/(${this.hitArr[2]} + ${this.hitArr[3]}) = ${((this.hitArr[2] / (this.hitArr[2] + this.hitArr[3])) * 100).toFixed(2)}%`);
            // 重置命中次数队列
            this.hitArr.fill(1);
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

    _resolveTokenIds(market) {
        if (this.tokenIds) {
            return this.tokenIds;
        }
        try {
            const tokenIds = JSON.parse(market.clobTokenIds || "[]");
            if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
                return null;
            }
            let upTokenId = tokenIds[0];
            let downTokenId = tokenIds[1];
            this.tokenIds = [upTokenId, downTokenId];
            return this.tokenIds;
        } catch (err) {
            logger.error("[UpBotCache] 解析clobTokenIds失败", err?.message ?? err);
            return null;
        }
    }

    async _fetchAndCacheOrderBook(tokenId) {
        if (!tokenId) {
            return null;
        }
        const orderBook = await this.client.getOrderBook(tokenId);
        if (!orderBook) {
            return null;
        }
        const asksSnapshot = orderBook.asks || [];
        const bestBidPrice =
            orderBook.bids && orderBook.bids.length
                ? orderBook.bids[orderBook.bids.length - 1]?.price
                : 0;
        const bestAskPrice =
            orderBook.asks && orderBook.asks.length
                ? orderBook.asks[orderBook.asks.length - 1]?.price
                : 0;
        const rlt = {
            asks: asksSnapshot,
            bestBidPrice: bestBidPrice,
            bestAskPrice: bestAskPrice,
            updatedAt: Date.now(),
        };
        this.orderBookCache.set(tokenId, rlt);
        return rlt;
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
            let val = await resolvePositionSize();
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
        let asks = [];
        const cachedOrderBook = this.orderBookCache.get(tokenId);
        if (cachedOrderBook?.updatedAt && cachedOrderBook?.updatedAt > Date.now() - 1000) {
            // 从缓存中获取
            asks = cachedOrderBook.asks;
            this.hitArr[0]++;
        } else {
            // 直接查询并缓存
            const rlt = await this._fetchAndCacheOrderBook(tokenId);
            if (rlt) {
                asks = rlt.asks;
            }
            this.hitArr[1]++;
        }
        // 计算流动性
        const newVal = asks.reduce((sum, ask) => {
            if (Number(ask.price) > 0.99) {
                return sum;
            }
            return sum + Number(ask.size|| 0);
        }, 0);

        // 更新流动性队列
        let queue = this.store.liquidity.get(tokenId) ?? [];
        queue.push(newVal);
        if (queue.length > 3) {
            queue.shift();
        }
        this.store.liquidity.set(tokenId, queue);
        // 求平均值
        const avg = queue.reduce((sum, val) => sum + val, 0) / queue.length;
        return Number(avg.toFixed(1));
    }

    async getBestPrice(tokenId) {
        const cachedOrderBook = this.orderBookCache.get(tokenId);
        if (cachedOrderBook?.updatedAt && cachedOrderBook?.updatedAt > Date.now() - 1000) {
            this.hitArr[2]++;
            return [
                Number(cachedOrderBook.bestBidPrice) ?? 0,
                Number(cachedOrderBook.bestAskPrice) ?? 0,
            ];
        }
        this.hitArr[3]++;
        const rlt = await this._fetchAndCacheOrderBook(tokenId);
        if (rlt) {
            return [Number(rlt.bestBidPrice) ?? 0, Number(rlt.bestAskPrice) ?? 0];
        }
        return [0, 0];
    }
}
