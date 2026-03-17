const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// 内存存储
const userData = {};
const USER_ID = 'demo_user';
const DEFAULT_BALANCE = 10000;
if (!userData[USER_ID]) userData[USER_ID] = { strategies: {} };

// 常量
const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;
const now = () => Math.floor(Date.now() / 1000);

// 周期转毫秒
const intervalMs = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
};

// 获取K线
async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      return res.data.data.map(item => ({
        time: parseInt(item[0]),           // 毫秒
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      })).reverse();
    }
  } catch (err) {
    console.error('获取K线失败', err.message);
  }
  return null;
}

// 模拟成交价
function getExecutedPrice(side, basePrice) {
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

// 计算张数
function calculateSize(usdtAmount, leverage, price) {
  return (usdtAmount * leverage) / price;
}

// 开仓
async function openPosition(strategy, account, side, price, klineTime) {
  const { leverage, marginMode, amountUsdt } = strategy.config;
  const execPrice = getExecutedPrice(side, price);
  const size = calculateSize(amountUsdt, leverage, execPrice);
  if (size <= 0) return;

  const initialMargin = (size * execPrice) / leverage;
  if (account.balance < initialMargin) return;

  const fee = size * execPrice * TAKER_FEE_RATE;
  account.balance -= fee;
  account.balance -= initialMargin; // 扣除保证金

  const position = {
    side,
    size,
    entryPrice: execPrice,
    openTime: klineTime,      // 开仓时的K线时间（毫秒）
    leverage,
    marginMode,
    margin: initialMargin,
    unrealizedPnl: 0
  };
  account.position = position;
  account.history.push({ type: 'open', side, size, price: execPrice, fee, time: now() });
  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
}

// 平仓
async function closePosition(strategy, account, price, reason = '') {
  const position = account.position;
  if (!position) return null;

  const execPrice = getExecutedPrice(position.side === 'long' ? 'short' : 'long', price);
  const size = position.size;
  const pnl = position.side === 'long'
    ? (execPrice - position.entryPrice) * size
    : (position.entryPrice - execPrice) * size;
  const fee = size * execPrice * TAKER_FEE_RATE;

  account.balance += (size * position.entryPrice / position.leverage) + pnl - fee;

  account.realizedPnl += pnl;
  account.totalReturn = account.realizedPnl / DEFAULT_BALANCE;
  account.history.push({ type: 'close', side: position.side, size, price: execPrice, pnl, fee, time: now(), reason });
  account.position = null;
  account.equity = account.balance;
  return pnl;
}

// 策略核心（每秒执行）
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval } = strategy.config;
  const klines = await fetchKlines(symbol, interval, 3); // 取最近3根
  if (!klines || klines.length < 3) return;

  const currentKline = klines[klines.length - 1]; // 当前未收盘K线
  const prevKline = klines[klines.length - 2];    // 上一根已收盘K线
  const prevPrevKline = klines[klines.length - 3]; // 上上一根（用于趋势判断）

  const account = strategy.account;
  const nowMs = Date.now();

  // 当前K线结束时间
  const intervalMsVal = intervalMs[interval] || 30 * 60 * 1000;
  const currentEndTime = currentKline.time + intervalMsVal;
  const timeToCloseMs = currentEndTime - nowMs; // 毫秒

  // 严格在收盘前59秒内执行
  if (timeToCloseMs > 59000 || timeToCloseMs < 0) return;

  // 无持仓
  if (!account.position) {
    // 判断当前K线是否满足开仓条件
    // 下跌趋势中的第一根阳线：当前K线为阳线，且上一根K线为阴线
    const isBullReversal = (currentKline.close > currentKline.open) && (prevKline.close < prevKline.open);
    // 上涨趋势中的第一根阴线：当前K线为阴线，且上一根K线为阳线
    const isBearReversal = (currentKline.close < currentKline.open) && (prevKline.close > prevKline.open);

    if (isBullReversal) {
      // 在收盘前59秒买入做多
      await openPosition(strategy, account, 'long', currentKline.close, currentKline.time);
      account.strategyState = { lastAction: 'open', openKlineTime: currentKline.time };
    } else if (isBearReversal) {
      // 在收盘前59秒卖出做空
      await openPosition(strategy, account, 'short', currentKline.close, currentKline.time);
      account.strategyState = { lastAction: 'open', openKlineTime: currentKline.time };
    }
  } else {
    // 有持仓，检查是否到了平仓时机（即开仓后的第二根K线）
    const position = account.position;
    const openKlineTime = account.strategyState?.openKlineTime;

    // 判断当前K线是否是开仓后的第二根K线
    // 开仓发生在第一根K线收盘前59秒，现在需要等第二根K线收盘前59秒平仓
    // 如何判断第二根K线？当前K线的时间 > 开仓时间 + 一个周期，并且我们还没有平仓
    if (openKlineTime && (currentKline.time >= openKlineTime + intervalMsVal)) {
      // 根据上一根K线（即开仓后的第一根已收盘K线）的阴阳决定操作
      if (position.side === 'long') {
        if (prevKline.close > prevKline.open) {
          // 第二根收阳 → 止盈平多
          await closePosition(strategy, account, currentKline.close, 'take profit');
          account.strategyState = { nextAction: 'short' }; // 等待阴线做空
        } else if (prevKline.close < prevKline.open) {
          // 第二根收阴 → 止损平多，并反手做空
          await closePosition(strategy, account, currentKline.close, 'stop loss');
          await openPosition(strategy, account, 'short', currentKline.close, currentKline.time);
          account.strategyState = { lastAction: 'open', openKlineTime: currentKline.time };
        }
      } else if (position.side === 'short') {
        if (prevKline.close < prevKline.open) {
          // 第二根收阴 → 止盈平空
          await closePosition(strategy, account, currentKline.close, 'take profit');
          account.strategyState = { nextAction: 'long' };
        } else if (prevKline.close > prevKline.open) {
          // 第二根收阳 → 止损平空，并反手做多
          await closePosition(strategy, account, currentKline.close, 'stop loss');
          await openPosition(strategy, account, 'long', currentKline.close, currentKline.time);
          account.strategyState = { lastAction: 'open', openKlineTime: currentKline.time };
        }
      }
    }
  }

  // 更新未实现盈亏
  if (account.position) {
    const upnl = account.position.side === 'long'
      ? (currentKline.close - account.position.entryPrice) * account.position.size
      : (account.position.entryPrice - currentKline.close) * account.position.size;
    account.position.unrealizedPnl = upnl;
    account.equity = account.balance + upnl;
  } else {
    account.equity = account.balance;
  }
}

// 每秒执行一次
setInterval(() => {
  for (const userId in userData) {
    for (const id in userData[userId].strategies) {
      runStrategy(userData[userId].strategies[id]).catch(e => console.error(e));
    }
  }
}, 1000);

// API 路由（与之前相同，略，但保证返回完整字段）
app.get('/strategies', (req, res) => {
  const userId = req.query.user || USER_ID;
  const strategies = userData[userId]?.strategies || {};
  const list = Object.entries(strategies).map(([id, s]) => ({
    id,
    name: s.config.name || id,
    symbol: s.config.symbol,
    interval: s.config.interval,
    leverage: s.config.leverage,
    amountUsdt: s.config.amountUsdt,
    marginMode: s.config.marginMode,
    active: s.config.active || false,
    equity: s.account.equity,
    position: s.account.position,
    markPrice: s.account.markPrice || 0,
    totalReturn: s.account.totalReturn,
    history: s.account.history
  }));
  res.json(list);
});

app.post('/strategy', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { name, symbol, interval, leverage, amountUsdt, marginMode } = req.body;
  if (!symbol || !interval || !leverage || !amountUsdt) {
    return res.status(400).json({ error: '参数不完整' });
  }
  const strategyId = uuidv4();
  const newStrategy = {
    config: {
      name: name || strategyId,
      symbol,
      interval,
      leverage: parseInt(leverage),
      amountUsdt: parseFloat(amountUsdt),
      marginMode: marginMode || 'cross',
      active: false
    },
    account: {
      balance: DEFAULT_BALANCE,
      equity: DEFAULT_BALANCE,
      position: null,
      history: [],
      realizedPnl: 0,
      totalReturn: 0,
      markPrice: 0,
      strategyState: {}
    }
  };
  userData[userId].strategies[strategyId] = newStrategy;
  res.json({ id: strategyId });
});

app.delete('/strategy/:id', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  if (userData[userId].strategies[id]) {
    delete userData[userId].strategies[id];
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '策略不存在' });
  }
});

app.get('/strategy/:id', async (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });

  let klines = [];
  if (strategy.config.symbol) {
    klines = await fetchKlines(strategy.config.symbol, strategy.config.interval, 100);
  }
  res.json({
    config: strategy.config,
    account: strategy.account,
    klines: klines || []
  });
});

app.post('/strategy/:id/control', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const { active } = req.body;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });
  strategy.config.active = active;
  res.json({ success: true });
});

app.post('/strategy/:id/close', async (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });

  const account = strategy.account;
  if (!account.position) return res.status(400).json({ error: '无持仓' });

  let currentPrice = account.markPrice;
  if (!currentPrice || currentPrice <= 0) {
    const klines = await fetchKlines(strategy.config.symbol, '1m', 1);
    if (klines && klines[0]) currentPrice = klines[0].close;
  }
  if (!currentPrice) return res.status(500).json({ error: '无法获取价格' });

  await closePosition(strategy, account, currentPrice, 'manual');
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('K线之王后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
