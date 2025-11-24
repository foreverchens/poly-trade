import dayjs from "dayjs";
import { resolveSlugList, fetchMarkets, getAsksLiq, resolvePositionSize } from "./common.js";
import logger from "../../core/Logger.js";

export class UpBotCache {
    constructor(config) {
        this.slugTemplate = config.slug;
        this.maxMinutesToEnd = config.maxMinutesToEnd;

        // 运行时数据存储
        this.store = {
            hour: null,
            targetSlug: null,
            market: null,         // 明确只缓存单个 market 对象
            balance: { val: 0, ts: 0 },
            liquidity: new Map(), // tokenId -> { val: boolean, ts: number }
        };

        // TTL 配置 (毫秒)
        this.TTL = {
            BALANCE: 60_000,    // 余额缓存 1分钟
            LIQUIDITY: 5_000      // 流动性缓存 5秒
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
            this.store.balance = { val: 0, ts: 0 }; // 重置余额，强制下一次刷新
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
                logger.info(`[UpBotCache] 市场已缓存更新: ${this.store.market.slug} (Slug=${slug})`);
            } else {
                logger.info(`[UpBotCache] 未找到市场, 缓存为空: ${slug}`);
                return null;
            }
        }
        // 市场对象较大，仅在首次获取时打印，后续不打印命中日志，以免刷屏
        return this.store.market;
    }

    /**
     * 获取余额 (带TTL)
     * @param {Object} client - PolyClient 实例
     */
    async getBalance(client, maxBalance = 100) {
        const now = Date.now();

        // 如果缓存有效，直接返回
        if (this.store.balance.val > 0 && (now - this.store.balance.ts <= this.TTL.BALANCE)) {
            return this.store.balance.val;
        }

        try {
            let val = await resolvePositionSize(client);
            val = Math.min(val, maxBalance);
            this.store.balance = { val, ts: now };
            logger.info(`[UpBotCache] 余额更新完毕: ${val} USDC`);
        } catch (err) {
            logger.error("[UpBotCache] 余额刷新失败, 保持旧值", err);
        }
        return this.store.balance.val;
    }

    /**
     * 本地扣减余额 (乐观更新)
     * @param {number} amount - 扣减金额
     */
    deductBalance(amount) {
        // 向上取整
        amount = Math.ceil(amount);
        if (this.store.balance && typeof this.store.balance.val === 'number') {
            const oldVal = this.store.balance.val;
            this.store.balance.val = Math.max(0, oldVal - amount);
            // 更新时间戳，以此推迟下一次自动刷新，避免刚扣减就被旧的API数据覆盖
            this.store.balance.ts = Date.now();
            logger.info(`[UpBotCache] 本地扣减余额: ${oldVal} -> ${this.store.balance.val} (-${amount})`);
        }
    }

    /**
     * 获取卖方流动性 (带TTL)
     */
    async getAsksLiq(client, tokenId) {
        const now = Date.now();
        const cached = this.store.liquidity.get(tokenId);

        // 如果缓存存在且未过期
        if (cached && (now - cached.ts < this.TTL.LIQUIDITY)) {
            return cached.val;
        }

        // 缓存过期或不存在
        const val = await getAsksLiq(client, tokenId);
        this.store.liquidity.set(tokenId, { val, ts: now });
        return val;
    }
}
