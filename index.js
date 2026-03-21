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

// ==================== 内存存储 ====================
const userData = {};
const USER_ID = 'demo_user';
const DEFAULT_BALANCE = 10000;
if (!userData[USER_ID]) userData[USER_ID] = { strategies: {} };

// ==================== 常量 ====================
const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;
const now = () => Math.floor(Date.now() / 1000);

const intervalMs = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
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
async function fetchKlines(symbol, interval, limit = 2) {
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
    console.error(`获取K线失败 ${symbol} ${interval}`, err.message);
  }
  return null;
}

// 获取所有永续合约列表（用于上影线策略）
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
      const instruments = res.data.data.map(item => item.instId);
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
async function openPosition(strategy, account, side, price, klineTime, symbol) {
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
    symbol,
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
  account.history.push({ type: 'open', side, size, price: execPrice, fee, time: now(), symbol });
  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
  strategy.state.status = side === 'long' ? 'in_long' : 'in_short';
  strategy.state.openKlineTime = klineTime;
  strategy.state.openSymbol = symbol;
  strategy.state.barsSinceOpen = 0; // 重置计数器
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
  account.history.push({ type: 'close', side: position.side, size, price: execPrice, pnl, fee, time: now(), reason, symbol: position.symbol });
  account.position = null;
  account.equity = account.balance;
  return pnl;
}

// ==================== 策略核心（精确版本） ====================
async function runKlineKing(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval, direction, shrink } = strategy.config;

  // 获取最近2根K线（当前未收盘和上一根已收盘）
  const klines = await fetchKlines(symbol, interval, 2);
  if (!klines || klines.length < 2) return;

  const latestKline = klines[klines.length - 1]; // 当前未收盘K线
  const prevKline = klines[klines.length - 2];   // 上一根已收盘K线

  // 检测新K线出现（即上一根K线时间戳变化）
  if (strategy.lastProcessedKlineTime === prevKline.time) return;
  strategy.lastProcessedKlineTime = prevKline.time;

  const account = strategy.account;
  if (!strategy.state) strategy.state = { status: 'idle' };
  const state = strategy.state;

  // 缩量检查（需要3根K线）
  let volumeOk = true;
  if (shrink) {
    const moreKlines = await fetchKlines(symbol, interval, 3);
    if (moreKlines && moreKlines.length >= 3) {
      const prevPrevKline = moreKlines[moreKlines.length - 3];
      volumeOk = prevKline.volume < prevPrevKline.volume;
    } else {
      volumeOk = false; // 数据不足时不满足
    }
  }

  // ========== 无持仓 ==========
  if (!account.position) {
    // 反转信号定义
    const isBullReversal = (prevKline.close < prevKline.open) && (latestKline.close > latestKline.open); // 阴后阳
    const isBearReversal = (prevKline.close > prevKline.open) && (latestKline.close < latestKline.open); // 阳后阴

    let shouldOpen = false;
    let openSide = null;

    if (direction === 'both' || direction === 'long') {
      if (isBullReversal && volumeOk) {
        shouldOpen = true;
        openSide = 'long';
      }
    }
    if (direction === 'both' || direction === 'short') {
      if (isBearReversal && volumeOk) {
        shouldOpen = true;
        openSide = 'short';
      }
    }

    if (shouldOpen) {
      await openPosition(strategy, account, openSide, latestKline.close, latestKline.time, symbol);
      console.log(`[${new Date().toISOString()}] 开仓 ${openSide} 价格 ${latestKline.close}`);
    }
  } else {
    // ========== 有持仓 ==========
    const position = account.position;
    // 开仓后经历的K线数（每次新K线出现时加1）
    state.barsSinceOpen = (state.barsSinceOpen || 0) + 1;

    // 当开仓后已出现至少1根新K线时，立即平仓
    if (state.barsSinceOpen >= 1) {
      // 根据持仓方向和平仓K线（即当前处理的 prevKline）决定操作
      if (position.side === 'long') {
        if (prevKline.close > prevKline.open) {
          // 平仓K线为阳线 → 止盈平多
          await closePosition(strategy, account, prevKline.close, 'take profit');
          console.log(`[${new Date().toISOString()}] 止盈平多 价格 ${prevKline.close}`);
          state.status = 'idle';
          state.barsSinceOpen = 0;
        } else if (prevKline.close < prevKline.open) {
          // 平仓K线为阴线 → 止损平多，并立即反手做空（如果方向允许）
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          console.log(`[${new Date().toISOString()}] 止损平多 价格 ${prevKline.close}`);
          if (direction === 'both' || direction === 'short') {
            await openPosition(strategy, account, 'short', prevKline.close, prevKline.time, symbol);
            console.log(`[${new Date().toISOString()}] 反手开空 价格 ${prevKline.close}`);
          } else {
            state.status = 'idle';
            state.barsSinceOpen = 0;
          }
        }
      } else if (position.side === 'short') {
        if (prevKline.close < prevKline.open) {
          // 平仓K线为阴线 → 止盈平空
          await closePosition(strategy, account, prevKline.close, 'take profit');
          console.log(`[${new Date().toISOString()}] 止盈平空 价格 ${prevKline.close}`);
          state.status = 'idle';
          state.barsSinceOpen = 0;
        } else if (prevKline.close > prevKline.open) {
          // 平仓K线为阳线 → 止损平空，并立即反手做多（如果方向允许）
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          console.log(`[${new Date().toISOString()}] 止损平空 价格 ${prevKline.close}`);
          if (direction === 'both' || direction === 'long') {
            await openPosition(strategy, account, 'long', prevKline.close, prevKline.time, symbol);
            console.log(`[${new Date().toISOString()}] 反手开多 价格 ${prevKline.close}`);
          } else {
            state.status = 'idle';
            state.barsSinceOpen = 0;
          }
        }
      }
      // 平仓后重置计数器（已在各分支内重置）
    }
  }

  // 更新未实现盈亏
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

// 全市场最长上影线做空策略（保持兼容）
async function runWickAny(strategy) {
  if (!strategy.config || !strategy.config.active) return;
  if (strategy.scanning) return;

  const account = strategy.account;
  const interval = strategy.config.interval;
  const intervalMsVal = intervalMs[interval];
  if (!intervalMsVal) return;

  const allSymbols = await fetchAllSwapInstruments();
  if (!allSymbols || allSymbols.length === 0) return;

  const nowMs = Date.now();

  if (account.position) {
    const openKlineTime = strategy.state.openKlineTime;
    if (nowMs >= openKlineTime + 2 * intervalMsVal) {
      const klines = await fetchKlines(account.position.symbol, interval, 1);
      if (klines && klines[0]) {
        await closePosition(strategy, account, klines[0].close, 'wick exit');
      }
    }
    return;
  }

  // 收盘前59秒窗口
  const now = new Date();
  let endTime;
  if (interval.endsWith('m')) {
    const minutes = parseInt(interval);
    const cycleStart = Math.floor(now.getMinutes() / minutes) * minutes;
    endTime = new Date(now);
    endTime.setMinutes(cycleStart + minutes);
    endTime.setSeconds(0);
    endTime.setMilliseconds(0);
  } else if (interval.endsWith('h')) {
    const hours = parseInt(interval);
    const cycleStart = Math.floor(now.getHours() / hours) * hours;
    endTime = new Date(now);
    endTime.setHours(cycleStart + hours);
    endTime.setMinutes(0);
    endTime.setSeconds(0);
    endTime.setMilliseconds(0);
  } else if (interval === '1d') {
    endTime = new Date(now);
    endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(0, 0, 0, 0);
  } else {
    return;
  }

  const endMs = endTime.getTime();
  const timeToClose = endMs - nowMs;
  if (timeToClose > 59000 || timeToClose <= 0) return;

  strategy.scanning = true;
  try {
    const BATCH_SIZE = 10;
    const results = [];
    for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
      const batch = allSymbols.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async symbol => {
        const klines = await fetchKlines(symbol, interval, 1);
        if (klines && klines[0]) {
          const k = klines[0];
          if (k.close < k.open) {
            const wick = k.high - Math.max(k.open, k.close);
            if (wick > 0) return { symbol, wick, kline: k };
          }
        }
        return null;
      }));
      results.push(...batchResults.filter(r => r));
      if (i + BATCH_SIZE < allSymbols.length) await new Promise(r => setTimeout(r, 1000));
    }

    let maxWick = 0;
    let target = null;
    results.forEach(r => {
      if (r.wick > maxWick) {
        maxWick = r.wick;
        target = r;
      }
    });

    if (target) {
      await openPosition(strategy, account, 'short', target.kline.close, target.kline.time, target.symbol);
    }
  } finally {
    strategy.scanning = false;
  }
}

// 主调度函数
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;
  const type = strategy.config.type;
  if (type === 'kline_king') {
    await runKlineKing(strategy);
  } else if (type === 'wick_any') {
    await runWickAny(strategy);
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
    type: s.config.type,
    symbol: s.config.symbol || '',
    interval: s.config.interval,
    leverage: s.config.leverage,
    amountUsdt: s.config.amountUsdt,
    marginMode: s.config.marginMode,
    direction: s.config.direction || 'both',
    shrink: s.config.shrink || false,
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
  const { name, type, symbol, interval, leverage, amountUsdt, marginMode, direction, shrink } = req.body;
  if (!type || !interval || !leverage || !amountUsdt) {
    return res.status(400).json({ error: '参数不完整' });
  }
  if (type === 'kline_king' && !symbol) {
    return res.status(400).json({ error: 'K线之王需要选择交易对' });
  }
  const strategyId = uuidv4();
  const newStrategy = {
    config: {
      name: name || strategyId,
      type,
      symbol: type === 'kline_king' ? symbol : '',
      interval,
      leverage: parseInt(leverage),
      amountUsdt: parseFloat(amountUsdt),
      marginMode: marginMode || 'cross',
      direction: direction || 'both',
      shrink: shrink === true,
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
  strategy.state.barsSinceOpen = 0;
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('双策略后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
