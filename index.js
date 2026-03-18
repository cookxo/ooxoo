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
  '1d': 24 * 60 * 60 * 1000
};

// ==================== 工具函数 ====================
async function fetchKlines(symbol, interval, limit = 100) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      return res.data.data.map(item => ({
        time: parseInt(item[0]),
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

// 获取所有永续合约列表（缓存1小时）
let instrumentsCache = { data: null, timestamp: 0 };
async function fetchAllSwapInstruments() {
  const now = Date.now();
  if (instrumentsCache.data && now - instrumentsCache.timestamp < 3600000) {
    return instrumentsCache.data;
  }
  try {
    const url = `${OKX_API_BASE}/api/v5/public/instruments?instType=SWAP`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      const instruments = res.data.data.map(item => ({
        instId: item.instId,
        listTime: parseInt(item.listTime) // 上线时间戳（毫秒）
      }));
      instrumentsCache = { data: instruments, timestamp: now };
      return instruments;
    }
  } catch (err) {
    console.error('获取合约列表失败', err.message);
  }
  return null;
}

function getExecutedPrice(side, basePrice) {
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

function calculateSize(usdtAmount, leverage, price) {
  return (usdtAmount * leverage) / price;
}

// ==================== 交易执行 ====================
async function openPosition(strategy, account, side, price, klineTime) {
  const { leverage, marginMode, amountUsdt } = strategy.config;
  const execPrice = getExecutedPrice(side, price);
  const size = calculateSize(amountUsdt, leverage, execPrice);
  if (size <= 0) return;

  const initialMargin = (size * execPrice) / leverage;
  if (account.balance < initialMargin) return;

  const fee = size * execPrice * TAKER_FEE_RATE;
  account.balance -= fee;
  account.balance -= initialMargin;

  const position = {
    side,
    size,
    entryPrice: execPrice,
    openTime: klineTime,
    leverage,
    marginMode,
    margin: initialMargin,
    unrealizedPnl: 0
  };
  account.position = position;
  account.history.push({ type: 'open', side, size, price: execPrice, fee, time: now() });
  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
  // 更新策略状态
  strategy.state.status = side === 'long' ? 'in_long' : 'in_short';
  strategy.state.openKlineTime = klineTime;
}

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

// ==================== 策略核心 ====================
// K线之王策略（原基础版）
async function runKlineKing(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval } = strategy.config;
  const intervalMsVal = intervalMs[interval] || 30 * 60 * 1000;

  const klines = await fetchKlines(symbol, interval, 2);
  if (!klines || klines.length < 2) return;

  const latestKline = klines[klines.length - 1];
  const prevKline = klines[klines.length - 2];
  const account = strategy.account;
  const nowMs = Date.now();

  const prevKlineEndTime = prevKline.time + intervalMsVal;
  if (prevKlineEndTime > nowMs) return;
  if (strategy.lastProcessedKlineTime === prevKline.time) return;
  strategy.lastProcessedKlineTime = prevKline.time;

  if (!strategy.state) strategy.state = { status: 'idle' };
  const state = strategy.state;

  if (!account.position) {
    if (state.status === 'idle') {
      if (prevKline.close < prevKline.open) state.status = 'wait_long';
      else if (prevKline.close > prevKline.open) state.status = 'wait_short';
    } else if (state.status === 'wait_long' && prevKline.close > prevKline.open) {
      await openPosition(strategy, account, 'long', prevKline.close, prevKline.time);
    } else if (state.status === 'wait_short' && prevKline.close < prevKline.open) {
      await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
    }
  } else {
    const position = account.position;
    const openKlineTime = state.openKlineTime;
    if (prevKline.time >= openKlineTime + intervalMsVal) {
      if (position.side === 'long') {
        if (prevKline.close > prevKline.open) {
          await closePosition(strategy, account, prevKline.close, 'take profit');
          state.status = 'wait_short';
        } else if (prevKline.close < prevKline.open) {
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
        }
      } else if (position.side === 'short') {
        if (prevKline.close < prevKline.open) {
          await closePosition(strategy, account, prevKline.close, 'take profit');
          state.status = 'wait_long';
        } else if (prevKline.close > prevKline.open) {
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          await openPosition(strategy, account, 'long', prevKline.close, prevKline.time);
        }
      }
    }
  }

  if (account.position) {
    const upnl = account.position.side === 'long'
      ? (latestKline.close - account.position.entryPrice) * account.position.size
      : (account.position.entryPrice - latestKline.close) * account.position.size;
    account.position.unrealizedPnl = upnl;
    account.equity = account.balance + upnl;
  } else {
    account.equity = account.balance;
  }
  account.markPrice = latestKline.close;
}

// 上引空策略：每天23:59:59筛选上线最久且收阴的合约做空
async function runDailyShort(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const account = strategy.account;
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  // 仅在23:59:00 - 23:59:59之间执行
  if (currentHour !== 23 || currentMinute !== 59) return;

  const intervalMsVal = intervalMs['1d']; // 86400000 ms

  // 如果当天已经处理过，避免重复开仓（通过记录最后开仓日）
  const today = now.toISOString().split('T')[0];
  if (strategy.lastProcessedDate === today) return;
  strategy.lastProcessedDate = today;

  // 获取所有永续合约
  const instruments = await fetchAllSwapInstruments();
  if (!instruments || instruments.length === 0) return;

  // 计算每个合约的上线天数，找出上线最久的
  let longestListTime = Infinity; // 上线时间戳越小越早
  let longestContract = null;
  for (const inst of instruments) {
    if (inst.listTime < longestListTime) {
      longestListTime = inst.listTime;
      longestContract = inst.instId;
    }
  }
  if (!longestContract) return;

  // 获取该合约的日K线（最近一根）
  const klines = await fetchKlines(longestContract, '1d', 1);
  if (!klines || klines.length === 0) return;
  const latestDaily = klines[0]; // 最新日K线（23:59:59时应该已收盘）

  // 判断是否收阴
  if (latestDaily.close >= latestDaily.open) return; // 不是阴线，不开仓

  // 如果有持仓，先平仓（持有一天）
  if (account.position) {
    await closePosition(strategy, account, latestDaily.close, 'daily close');
  }

  // 开空
  await openPosition(strategy, account, 'short', latestDaily.close, latestDaily.time);
}

// 主调度函数
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;
  const type = strategy.config.type || 'kline_king';
  if (type === 'kline_king') {
    await runKlineKing(strategy);
  } else if (type === 'daily_short') {
    await runDailyShort(strategy);
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

// ==================== API 路由 ====================
app.get('/strategies', (req, res) => {
  const userId = req.query.user || USER_ID;
  const strategies = userData[userId]?.strategies || {};
  const list = Object.entries(strategies).map(([id, s]) => ({
    id,
    name: s.config.name || id,
    type: s.config.type || 'kline_king',
    symbol: s.config.symbol || '',
    interval: s.config.interval,
    leverage: s.config.leverage,
    amountUsdt: s.config.amountUsdt,
    marginMode: s.config.marginMode,
    active: s.config.active || false,
    equity: s.account.equity,
    position: s.account.position,
    markPrice: s.account.markPrice || 0,
    totalReturn: s.account.totalReturn,
    history: s.account.history,
    status: s.state?.status || 'idle'
  }));
  res.json(list);
});

app.post('/strategy', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { name, type, symbol, interval, leverage, amountUsdt, marginMode } = req.body;
  if (!interval || !leverage || !amountUsdt) {
    return res.status(400).json({ error: '参数不完整' });
  }
  // 如果是K线之王，必须有symbol
  if (type !== 'daily_short' && !symbol) {
    return res.status(400).json({ error: '请选择交易对' });
  }
  const strategyId = uuidv4();
  const newStrategy = {
    config: {
      name: name || strategyId,
      type: type || 'kline_king',
      symbol: type === 'daily_short' ? '' : symbol,
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
    },
    state: { status: 'idle' }
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
    const klines = await fetchKlines(strategy.config.symbol || 'BTC-USDT-SWAP', '1m', 1);
    if (klines && klines[0]) currentPrice = klines[0].close;
  }
  if (!currentPrice) return res.status(500).json({ error: '无法获取价格' });

  await closePosition(strategy, account, currentPrice, 'manual');
  strategy.state.status = 'idle';
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('双策略后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
