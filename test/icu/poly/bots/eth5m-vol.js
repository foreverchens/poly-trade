import ccxt from 'ccxt';
import * as ss from 'simple-statistics';

const annFactor5m = Math.sqrt(365*24*12);  // 年化因子：5min 粒度

// 对数收益
const logReturns = (closes) => {
  const r = [];
  for (let i=1;i<closes.length;i++) r.push(Math.log(closes[i]) - Math.log(closes[i-1]));
  return r;
};

const ex = new ccxt.binance({ enableRateLimit: true });

// 1) 拿 7 天的 5m K线
const k = await (async function fetchAll5m(days=7) {
  const tf='5m', per=1000, until=Date.now();
  let since=until-days*24*60*60*1000, all=[];
  while (true) {
    const page = await ex.fetchOHLCV('ETH/USDT', tf, since, per);
    if (!page.length) break;
    all.push(...page.filter(r=>r[0]<=until));
    const last = page.at(-1)[0];
    if (page.length < per || last >= until) break;
    since = last + 1;
    await ex.sleep(100);
  }
  const map = new Map(all.map(r=>[r[0], r]));
  return [...map.values()].sort((a,b)=>a[0]-b[0]);
})();

// 2) 计算波动
const closes = k.map(r=>r[4]);
const r = logReturns(closes);

const mean5m   = ss.mean(r);
const med5m    = ss.median(r);
const std5m    = ss.sampleStandardDeviation(r);     // 建议用样本标准差
const annVol   = std5m * annFactor5m;

const sorted = [...r].sort((a,b)=>a-b);
const p95 = ss.quantileSorted(sorted, 0.95);
const p99 = ss.quantileSorted(sorted, 0.99);

console.log({
  samples: r.length,
  mean5m, med5m, std5m, annVol,
  p95, p99,
  meanAbs: ss.mean(r.map(Math.abs)),
  medAbs:  ss.median(r.map(Math.abs)),
});
