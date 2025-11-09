import "dotenv/config";
import pkg from "@polymarket/clob-client";
import {PriceHistoryInterval} from "@polymarket/clob-client/dist/types.js";
import {SignatureType} from "@polymarket/order-utils";
import {Wallet} from "@ethersproject/wallet";
import axios from "axios";

const {ClobClient, OrderType, Side, AssetType} = pkg;

const DEFAULT_HOST = "https://clob.polymarket.com";
const DEFAULT_CHAIN_ID = 137;
const DEFAULT_TOKEN_ID = "87769991026114894163580777793845523168226980076553814689875238288185044414090";

const DEFAULT_ORDER_TYPE = OrderType.GTC;
const DEFAULT_SIGNATURE_TYPE = SignatureType.EOA;
const DEFAULT_REWARDS_HOST = "https://polymarket.com/api";
const DEFAULT_DATA_HOST = "https://data-api.polymarket.com";
const DEFAULT_MARKET_HOST = "https://gamma-api.polymarket.com";
const VALID_PRICE_HISTORY_INTERVALS = new Set(Object.values(PriceHistoryInterval));

export class PolyClient {
    constructor() {
        const privateKey = process.env.PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("Missing PRIVATE_KEY for PolyClient");
        }

        this.host = DEFAULT_HOST;
        this.chainId = DEFAULT_CHAIN_ID;
        this.tokenId = DEFAULT_TOKEN_ID;
        this.signatureType = DEFAULT_SIGNATURE_TYPE;
        this.orderType = DEFAULT_ORDER_TYPE;
        this.rewardsHost = DEFAULT_REWARDS_HOST;
        this.dataHost = DEFAULT_DATA_HOST;
        this.marketHost = DEFAULT_MARKET_HOST;
        this.signer = new Wallet(privateKey);
        this.funderAddress = this.signer.address;
        this.clientPromise = null;
    }

    async getClient() {
        if (!this.clientPromise) {
            this.clientPromise = (async () => {
                const baseClient = new ClobClient(this.host, this.chainId, this.signer);
                const creds = await baseClient.deriveApiKey();
                return new ClobClient(this.host, this.chainId, this.signer, creds, this.signatureType, this.funderAddress,);
            })();
        }
        return this.clientPromise;
    }


    /*================市场API===================*/

    /**
     * todo 获取token历史价格
     * @param market tokenId
     * @param interval 周期 1h
     * @returns {Promise<void>｜{
     *   "history": [
     *     {
     *       "t": 1762606026,
     *       "p": 0.025
     *     },
     *     {
     *       "t": 1762606087,
     *       "p": 0.023
     *     },
     *     {
     *       "t": 1762606146,
     *       "p": 0.022
     *     }
     *    }}
     */
    async getPricesHistory(market, interval) {
        const normalizeMarket = (value) => {
            if (typeof value === "string") {
                return value.trim();
            }
            if (typeof value === "number") {
                return String(value);
            }
            return "";
        };

        const resolvedMarket = normalizeMarket(market) || normalizeMarket(this.tokenId);
        if (!resolvedMarket) {
            throw new Error("market is required to fetch price history");
        }

        const resolvedInterval = interval ?? PriceHistoryInterval.ONE_HOUR;
        const intervalToUse = typeof resolvedInterval === "string" ? resolvedInterval.trim() : resolvedInterval;
        if (!VALID_PRICE_HISTORY_INTERVALS.has(intervalToUse)) {
            throw new Error(`Invalid interval "${interval}" supplied to getPricesHistory`);
        }

        const client = await this.getClient();
        const response = await client.getPricesHistory({market: resolvedMarket, interval: intervalToUse});
        const history = Array.isArray(response) ? response : response?.history;

        if (!Array.isArray(history)) {
            throw new Error("Failed to fetch price history: unexpected response shape");
        }

        return {history};
    }

    /**
     * 获取盘口最优挂单价格
     * @param side
     * @param tokenId
     * @returns {Promise<*>}
     */
    async getPrice(side, tokenId = this.tokenId) {
        if (!side) {
            throw new Error("side is required to fetch price");
        }

        const client = await this.getClient();
        return (await client.getPrice(tokenId, side)).price;
    }

    /**
     * {
     *   market: '0xcb111226a8271fed0c71bb5ec1bd67b2a4fd72f1eb08466e2180b9efa99d3f32',
     *   asset_id: '87769991026114894163580777793845523168226980076553814689875238288185044414090',
     *   timestamp: '1762410814537',
     *   hash: '8b1e40b2abe4f2ebeead7274a154378fd017776e',
     *   bids: [
     *     { price: '0.62', size: '103009' },
     *     { price: '0.63', size: '59690.95' },
     *     { price: '0.64', size: '53862.45' }
     *   ],
     *   asks: [
     *     { price: '0.67', size: '131578.44' },
     *     { price: '0.66', size: '76207.09' },
     *     { price: '0.65', size: '88731.56' }
     *   ],
     *   min_order_size: '5',
     *   tick_size: '0.01',
     *   neg_risk: true
     * }
     * @param tokenId
     * @returns {Promise<*|OrderBookSummary>}
     */
    async getOrderBook(tokenId = this.tokenId) {
        const client = await this.getClient();
        return client.getOrderBook(tokenId);
    }

    /**
     * https://polymarket.com/api/rewards/markets?orderBy=rate_per_day&position=DESC&query=&showFavorites=false&tagSlug=all&makerAddress=0x8d544db9152b95cd0c34595183cd54bc0dc37edc&authenticationType=eoa&nextCursor=MA%3D%3D&requestPath=%2Frewards%2Fuser%2Fmarkets&onlyMergeable=false&noCompetition=false&onlyOpenOrders=false&onlyPositions=false
     * @returns {Promise<void>|{
     *   market_id: '570361',
     *   condition_id: '0xcb111226a8271fed0c71bb5ec1bd67b2a4fd72f1eb08466e2180b9efa99d3f32',
     *   question: 'Fed decreases interest rates by 25 bps after December 2025 meeting?',
     *   market_slug: 'fed-decreases-interest-rates-by-25-bps-after-december-2025-meeting',
     *   volume_24hr: 649406.9018239997,
     *   event_id: '35090',
     *   event_slug: 'fed-decision-in-december',
     *   image: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/jerome+powell+glasses1.png',
     *   maker_address: '0x0000000000000000000000000000000000000000',
     *   tokens: [
     *     {
     *       token_id: '87769991026114894163580777793845523168226980076553814689875238288185044414090',
     *       outcome: 'Yes',
     *       price: 0.645
     *     },
     *     {
     *       token_id: '13411284055273560855537595688801764123705139415061660246624128667183605973730',
     *       outcome: 'No',
     *       price: 0.355
     *     }
     *   ],
     *   rewards_config: [
     *     {
     *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
     *       start_date: '2025-08-01',
     *       end_date: '2500-12-31',
     *       rate_per_day: 600,
     *       total_rewards: 0
     *     }
     *   ],
     *   earnings: [
     *     {
     *       asset_address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
     *       earnings: 0,
     *       asset_rate: 0.999726
     *     }
     *   ],
     *   rewards_max_spread: 3.5,
     *   rewards_min_size: 200,
     *   earning_percentage: 0,
     *   spread: 0.01,
     *   market_competitiveness: 101.826847
     * }}
     */
    async listRewardMarket({
                               orderBy = "rate_per_day",
                               position = "DESC",
                               limit = 100,
                               query = "",
                               showFavorites = false,
                               tagSlug = "all",
                               makerAddress = "",
                               authenticationType = "eoa",
                               nextCursor = "MA==",
                               requestPath = "/rewards/user/markets",
                               onlyMergeable = false,
                               noCompetition = false,
                               onlyOpenOrders = false,
                               onlyPositions = false,
                           } = {}) {
        const url = `${this.rewardsHost}/rewards/markets`;
        const response = await axios.get(url, {
            params: {
                orderBy,
                position,
                query,
                showFavorites,
                tagSlug,
                makerAddress,
                authenticationType,
                nextCursor,
                requestPath,
                onlyMergeable,
                noCompetition,
                onlyOpenOrders,
                onlyPositions,
            },
        });
        let data = response.data;
        data = data.data.filter(ele => {
            return ele.market_competitiveness > 0;
        }).slice(0, limit).sort((e1, e2) => {
            // 奖励降序
            const s1 = e2.rewards_config[0].rate_per_day - e1.rewards_config[0].rate_per_day;
            // 奖励相等、竞争程度生序
            const s2 = e1['market_competitiveness'] - e2['market_competitiveness'];
            return s1 === 0 ? s2 : s1;
        });
        return data;
    }


    /**
     * tags:
     *  Crypto  21
     *  Bitcoin 235
     *  Ethereum 39
     *
     * @returns {Promise<*>|[{
     *   id: '667904',
     *   question: 'XRP Up or Down on November 7?',
     *   conditionId: '0xac55160440e2c4454489876d9d199d1fdd220d15c112ded3f4073d9990872a26',
     *   slug: 'xrp-up-or-down-on-november-7',
     *   endDate: '2025-11-07T17:00:00Z',
     *   startDate: '2025-11-06T15:45:35.060882Z',
     *   outcomes: '["Up", "Down"]',
     *   outcomePrices: '["0.235", "0.765"]',
     *   createdAt: '2025-11-06T15:43:13.836836Z',
     *   questionID: '0x5a907af36fe26c01bc3e5fd94cf6b2d0b4f88a5745cd237b6a5e7dcc5d75e041',
     *   volumeNum: 15335.862565,
     *   liquidityNum: 4729.564,
     *   endDateIso: '2025-11-07',
     *   startDateIso: '2025-11-06',
     *   volume24hr: 5242.988726000001,
     *   clobTokenIds: '["97711861920064027535319065937365233742617188771659696434894133073960855768916", "68162071516944456424576500851165757545095711828887453678098036980269779289193"]',
     *   events: [
     *     {
     *       id: '74648',
     *       ticker: 'xrp-up-or-down-on-november-7',
     *       slug: 'xrp-up-or-down-on-november-7',
     *       title: 'XRP Up or Down on November 7?',
     *       startDate: '2025-11-06T15:46:37.460046Z',
     *       endDate: '2025-11-07T17:00:00Z',
     *     }
     *   ],
     *   lastTradePrice: 0.26,
     *   bestBid: 0.21,
     *   bestAsk: 0.26,
     *   eventStartTime: '2025-11-06T17:00:00Z',
     * }]}
     */
    async listCryptoMarketSortedByEndDate(tagId = 21) {
        const url = `${this.marketHost}/markets`;
        const endDateMin = new Date().toISOString();
        const endDateMax = new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 7).toISOString();
        const startDateMax = new Date(new Date().getTime() - 1000 * 60 * 60 * 24).toISOString();
        const params = {
            tag_id: tagId,
            closed: false,
            active: true,
            enableOrderBook: true,
            volume_num_min: 0,
            order: 'endDate',
            ascending: true,
            end_date_min: endDateMin,
            end_date_max: endDateMax,
            start_date_max: startDateMax,
            limit: 100,
        };
        // 仅发送有值的查询参数，避免污染默认查询
        const filteredParams = Object.entries(params).reduce((result, [key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                result[key] = value;
            }
            return result;
        }, {});

        const response = await axios.get(url, {params: filteredParams});
        let dataArr = response?.data;
        return dataArr.filter(ele => {
            return (ele.lastTradePrice >= 0.01 && ele.lastTradePrice <= 0.99) && (ele.bestAsk >= 0.01 && ele.bestAsk <= 0.99);
        });
    }


    async getMarketByConditionId(conditionIds) {
        const url = `${this.marketHost}/markets`;
        const params = {
            condition_ids: conditionIds,
        }
        const response = await axios.get(url, {params: params});
        let dataArr = response?.data;
        return dataArr.length ? dataArr[0] : null;
    }

    /**
     * https://gamma-api.polymarket.com/events?tag_id=235&closed=false&volume_num_min=100000&order=endDate&end_date_min=2025-11-14T12:00:00Z&ascending=true&limit=1
     * @param tagId
     * @returns {Promise<*>| {
     *   id: '70558',
     *   ticker: 'bitcoin-above-on-november-8',
     *   slug: 'bitcoin-above-on-november-8',
     *   title: 'Bitcoin above ___ on November 8?',
     *   description: 'This market will resolve to "Yes" if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title. Otherwise, this market will resolve to "No".\n' +
     *   startDate: '2025-11-01T16:02:31.831418Z',
     *   endDate: '2025-11-08T17:00:00Z',
     *   markets: [
     *     {
     *       id: '659979',
     *       question: 'Will the price of Bitcoin be above $102,000 on November 8?',
     *       conditionId: '0x234bd2733db8d0dae572c45fb5bcc5352e6a0eb4f8b903b8e14ac985667d49c4',
     *       slug: 'bitcoin-above-102k-on-november-8',
     *       endDate: '2025-11-08T17:00:00Z',
     *       description: 'This market will resolve to "Yes" if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title. Otherwise, this market will resolve to "No".\n' +
     *       outcomes: '["Yes", "No"]',
     *       outcomePrices: '["0.145", "0.855"]',
     *     },
     *     {
     *       question: 'Will the price of Bitcoin be above $106,000 on November 8?',
     *     }
     *   ],
     *   series: [
     *     {
     *       ticker: 'btc-multi-strikes-weekly',
     *     }
     *   ],
     *   tags: [
     *     {
     *       id: '235',
     *       label: 'Bitcoin',
     *     },
     *     {
     *       id: '102264',
     *       label: 'Weekly',
     *     },
     *     {
     *       id: '21',
     *       label: 'Crypto',
     *       slug: 'crypto',
     *     },
     *   ]
     * }}
     */
    async listCryptoEvents(tagId = 235) {
        const url = `${this.marketHost}/events`;
        const endDateMin = new Date().toISOString();
        const endDateMax = new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * 7).toISOString();
        const startDateMax = new Date(new Date().getTime() - 1000 * 60 * 60 * 24).toISOString();
        const params = {
            tag_id: tagId,
            closed: false,
            active: true,
            enableOrderBook: true,
            volume_num_min: 0,
            order: 'endDate',
            ascending: true,
            end_date_min: endDateMin,
            end_date_max: endDateMax,
            start_date_max: startDateMax,
            limit: 100,
        };
        // 仅发送有值的查询参数，避免污染默认查询
        const filteredParams = Object.entries(params).reduce((result, [key, value]) => {
            if (value !== undefined && value !== null && value !== "") {
                result[key] = value;
            }
            return result;
        }, {});

        const response = await axios.get(url, {params: filteredParams});
        return response?.data;
    }


    /*================交易API===================*/

    /**
     * 获取所有挂单，可按市场或资产过滤
     * @param market
     * @param assetId
     * @returns {Promise<import("@polymarket/clob-client").OpenOrder[]>}
     */
    async listOpenOrders({market, assetId} = {}) {
        const client = await this.getClient();
        const params = {};
        if (market) {
            params.market = market;
        }
        if (assetId) {
            params.asset_id = assetId;
        }

        const orders = await client.getOpenOrders(Object.keys(params).length ? params : undefined);
        if (!Array.isArray(orders)) {
            throw new Error("Failed to fetch open orders");
        }
        return orders;
    }


    /**
     * curl --request GET \ --url 'https://data-api.polymarket.com/positions?sizeThreshold=1&limit=100&sortBy=TOKENS&sortDirection=DESC&user=0x'
     * @param price
     * @param size
     * @param side
     * @param tokenId
     * @returns {Promise<any>|{
     *   errorMsg: '',
     *   orderID: '0x8e818dd295884776b0929b768ceaa43104ec2a34866127ca3d765280e3498054',
     *   takingAmount: '',
     *   makingAmount: '',
     *   status: 'live',
     *   success: true
     * }|{
     *   side: SELL,
     *   errorMsg: '',
     *   orderID: '0xa8add687ee56023e70bae2d8220e2f67fa159b1f040568c96baa3c4f6d2e54df',
     *   takingAmount: '18.3',
     *   makingAmount: '61',
     *   status: 'matched',
     *   transactionsHashes: [
     *     '0x8c06c5fc194837bcb18a37bb10669b16c772eee76e1d546962f9c23967c35e86'
     *   ],
     *   success: true
     * }}
     */
    async placeOrder(price, size, side, tokenId = this.tokenId) {
        side = side.toUpperCase();
        const client = await this.getClient();
        const [tickSize, negRisk] = await Promise.all([client.getTickSize(tokenId), client.getNegRisk(tokenId),]);

        const orderRequest = {
            tokenID: tokenId, price, side, size, feeRateBps: 0,
        };

        const orderOptions = {
            tickSize, negRisk,
        };

        return client.createAndPostOrder(orderRequest, orderOptions, this.orderType);
    }

    /**
     *
     * @param orderID
     * @returns {Promise<*>|{
     *   not_canceled: {},
     *   canceled: [
     *     '0x8e818dd295884776b0929b768ceaa43104ec2a34866127ca3d765280e3498054'
     *   ]
     * }}
     */
    async cancelOrder(orderID) {
        if (!orderID) {
            throw new Error("orderID is required to cancel an order");
        }

        const client = await this.getClient();
        return client.cancelOrder({orderID});
    }


    /*================持仓API===================*/
    /**
     * 获取当前地址的公开持仓（不需要签名）
     * @returns {Promise<any[]>}
     */
    async listPositions() {
        const address = this.funderAddress || this.signer.address;
        const url = `${this.dataHost}/positions`;
        const params = {
            sizeThreshold: 1, limit: 100, sortBy: "TOKENS", sortDirection: "DESC", user: address,
        };

        const response = await axios.get(url, {params});
        return response?.data;
    }


    /*================订单API===================*/
    /**
     *
     * 获取自身相关的成交记录（仅限作为做市方时）
     * @returns {Promise<import("@polymarket/clob-client").Trade[]>|    [{
     *         "order_id": "0xa94f3ce348c7d31f3da8961abb222b2396ba7428eb0713fca4009c7a3fb692ed",
     *         "owner": "d6f87978-2818-3071-ef1b-7ace08b61496",
     *         "maker_address": "0x864d76EE827AE3448ED327A426B6e190C5C97FA5",
     *         "matched_amount": "0.92",
     *         "price": "0.99",
     *         "fee_rate_bps": "0",
     *         "asset_id": "105165553321039703998642662980715548079401423982436479056728401620251275461058",
     *         "outcome": "Up",
     *         "side": "SELL"
     *     }]}
     */
    async listMyTrades({makerAddress} = {}) {
        const client = await this.getClient();
        const resolvedAddress = (makerAddress || this.funderAddress || await client.signer.getAddress()).toLowerCase();
        const trades = await client.getTrades({maker_address: resolvedAddress});
        if (!Array.isArray(trades)) {
            throw new Error("Failed to fetch personal trade history");
        }
        const cache = new Map();
        const rlt = [];
        for (let trade of trades) {
            let conditionId = trade.market;
            let market = cache.get(conditionId);
            if (!market) {
                market = await this.getMarketByConditionId(conditionId);
                cache.set(conditionId, market);
            }
            if (trade.maker_address === makerAddress) {
                rlt.push({
                    "question": market.question,
                    "order_id": trade.taker_order_id,
                    "owner": trade.owner,
                    "maker_address": makerAddress,
                    "matched_amount": trade.size,
                    "price": trade.price,
                    "asset_id": trade.asset_id,
                    "outcome": trade.outcome,
                    "side": trade.side,
                    "transaction_hash":trade.transaction_hash
                })
            } else {
                let makerOrders = trade.maker_orders.filter(order => {
                    return order.maker_address === makerAddress
                }).map(order => {
                    order.question = market.question;
                    order.transaction_hash = trade.transaction_hash;
                    return order;
                });
                rlt.push(...makerOrders);
            }
        }
        return rlt;
    }

    /**
     * 获取 USDC 余额（collateral）
     * @returns {Promise<string>}
     */
    async getUsdcBalance() {
        const client = await this.getClient();
        const response = await client.getBalanceAllowance({asset_type: AssetType.COLLATERAL});
        if (!response) {
            throw new Error("Failed to fetch USDC balance: empty response");
        }
        if (response.error) {
            throw new Error(`Failed to fetch USDC balance: ${response.error}`);
        }

        if (typeof response.balance === "string") {
            return response.balance;
        }

        if (response.balance && typeof response.balance.balance === "string") {
            return response.balance.balance;
        }

        throw new Error("Failed to fetch USDC balance: unexpected response shape");
    }

}


export const PolySide = Side;
export const PolyAssetType = AssetType;
