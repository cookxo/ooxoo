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

const userData = {};
const USER_ID = 'demo_user';
const DEFAULT_BALANCE = 10000;
if (!userData[USER_ID]) userData[USER_ID] = { strategies: {} };

const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0;
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

async function fetchKlines(symbol, interval, limit = 2) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      const all = res.data.data.map(item => ({
        time: parseInt(item[0]),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      })).reverse();
      // 必须确保所有返回的K线都是有效的
      for (let i = 0; i < all.length; i++) {
        if (all[i].close <= 0 || all[i].open <= 0 || all[i].time <= 0) {
          console.error(`无效K线数据: ${JSON.stringify(all[i])}`);
          return null;
        }
      }
      return all;
    }
  } catch (err) {
    console.error(`获取K线失败 ${symbol} ${interval}`, err.message);
  }
  return null;
}

let instrumentsCache = { data: null, timestamp: 0 };
async function fetchAllSwapInstruments() {
  const now = Date.now();
  if (instrumentsCache.data && now - instrumentsCache.timestamp < 3600000) return instrumentsCache.data;
  try {
    const url = `${OKX_API_BASE}/api/v5/public/instruments?instType=SWAP`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      instrumentsCache = { data: res.data.data.map(item => item.instId), timestamp: now };
      return instrumentsCache.data;
    }
  } catch (err) { console.error('获取合约列表失败', err.message); }
  return null;
}

function getExecutedPrice(side, basePrice) {
  if (!basePrice || basePrice <= 0) return 0;
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

function calculateSize(usdtAmount, leverage, price) {
  if (!price || price <= 0) return 0;
  return (usdtAmount * leverage) / price;
}

async function openPosition(strategy, account, side, price, klineTime, symbol) {
  if (!price || price <= 0) {
    console.error(`[开仓失败] 价格无效: ${price}`);
    return false;
  }
  const { leverage, marginMode, amountUsdt } = strategy.config;
  const execPrice = getExecutedPrice(side, price);
  if (execPrice <= 0) {
    console.error(`[开仓失败] 执行价格无效: ${execPrice}`);
    return false;
  }
  const size = calculateSize(amountUsdt, leverage, execPrice);
  if (size <= 0) {
    console.error(`[开仓失败] 数量无效: ${size}`);
    return false;
  }
  const initialMargin = (size * execPrice) / leverage;
  if (account.balance < initialMargin) {
    console.error(`[开仓失败] 余额不足，需要 ${initialMargin.toFixed(2)}，余额 ${account.balance.toFixed(2)}`);
    return false;
  }
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
  strategy.state.openTime = klineTime;
  console.log(`[${new Date().toISOString()}] 开仓 ${side} ${size.toFixed(4)}张 @ ${execPrice.toFixed(2)}，保证金 ${initialMargin.toFixed(2)}，余额 ${account.balance.toFixed(2)}`);
  return true;
}

async function closePosition(strategy, account, price, reason = '') {
  const position = account.position;
  if (!position) return null;
  if (!price || price <= 0) {
    console.error(`[平仓失败] 价格无效: ${price}`);
    return;
  }
  const execPrice = getExecutedPrice(position.side === 'long' ? 'short' : 'long', price);
  if (execPrice <= 0) return;
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
  console.log(`[${new Date().toISOString()}] 平仓 ${position.side} ${size.toFixed(4)}张 @ ${execPrice.toFixed(2)}，盈亏 ${pnl.toFixed(2)}，余额 ${account.balance.toFixed(2)}，原因 ${reason}`);
  return pnl;
}

// 全新策略核心：基于时间戳简单粗暴判断
async function runKlineKing(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval, direction, shrink } = strategy.config;
  const intervalMsVal = intervalMs[interval];
  if (!intervalMsVal) return;

  // 获取最近2根K线（只取最近两根已收盘的？不，需要3根来确保有历史）
  const klines = await fetchKlines(symbol, interval, 3);
  if (!klines || klines.length < 3) return;

  const nowMs = Date.now();

  // 取最后三根，下标 0,1,2 按时间正序
  const k0 = klines[0]; // 最老
  const k1 = klines[1]; // 中间
  const k2 = klines[2]; // 最新

  // 判断k1是否已收盘：结束时间 <= 当前时间
  const k1EndTime = k1.time + intervalMsVal;
  if (nowMs < k1EndTime) return;

  // 初始化：首次运行时，记录k1时间，不交易
  if (strategy.lastProcessedKlineTime === undefined) {
    strategy.lastProcessedKlineTime = k1.time;
    console.log(`[${new Date().toISOString()}] 策略启动，等待下一根K线`);
    return;
  }

  // 如果这根K线已经处理过，跳过
  if (strategy.lastProcessedKlineTime === k1.time) return;
  strategy.lastProcessedKlineTime = k1.time;

  const account = strategy.account;
  if (!strategy.state) strategy.state = { status: 'idle' };
  const state = strategy.state;

  // 缩量检查
  let volumeOk = true;
  if (shrink) {
    volumeOk = k1.volume < k0.volume;
  }

  // 无持仓
  if (!account.position) {
    // 反转信号
    const isBullReversal = (k0.close < k0.open) && (k1.close > k1.open);
    const isBearReversal = (k0.close > k0.open) && (k1.close < k1.open);

    let shouldOpen = false;
    let openSide = null;

    if (direction === 'both' || direction === 'long') {
      if (isBullReversal && volumeOk) shouldOpen = true, openSide = 'long';
    }
    if (direction === 'both' || direction === 'short') {
      if (isBearReversal && volumeOk) shouldOpen = true, openSide = 'short';
    }

    if (shouldOpen) {
      await openPosition(strategy, account, openSide, k1.close, k1.time, symbol);
    }
  } else {
    // 有持仓
    const position = account.position;
    const openTime = state.openTime;
    if (!openTime || openTime <= 0) {
      console.error(`开仓时间无效，重置状态`);
      state.status = 'idle';
      account.position = null;
      return;
    }

    // 平仓时机：当前时间 >= 开仓K线时间 + 2*周期（即开仓后的下一根K线已收盘）
    if (nowMs >= openTime + 2 * intervalMsVal) {
      if (position.side === 'long') {
        if (k1.close > k1.open) {
          await closePosition(strategy, account, k1.close, 'take profit');
          state.status = 'idle';
        } else if (k1.close < k1.open) {
          await closePosition(strategy, account, k1.close, 'stop loss');
          if (direction === 'both' || direction === 'short') {
            await openPosition(strategy, account, 'short', k1.close, k1.time, symbol);
          } else {
            state.status = 'idle';
          }
        }
      } else if (position.side === 'short') {
        if (k1.close < k1.open) {
          await closePosition(strategy, account, k1.close, 'take profit');
          state.status = 'idle';
        } else if (k1.close > k1.open) {
          await closePosition(strategy, account, k1.close, 'stop loss');
          if (direction === 'both' || direction === 'long') {
            await openPosition(strategy, account, 'long', k1.close, k1.time, symbol);
          } else {
            state.status = 'idle';
          }
        }
      }
    }
  }

  // 更新未实现盈亏
  if (account.position) {
    const upnl = account.position.side === 'long'
      ? (k2.close - account.position.entryPrice) * account.position.size
      : (account.position.entryPrice - k2.close) * account.position.size;
    account.position.unrealizedPnl = upnl;
    account.equity = account.balance + upnl;
  } else {
    account.equity = account.balance;
  }
  account.markPrice = k2.close;
}

// 上影线策略占位（保留）
async function runWickAny(strategy) {
  if (!strategy.config || !strategy.config.active) return;
  if (strategy.scanning) return;
  // 略
}

async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;
  const type = strategy.config.type;
  if (type === 'kline_king') await runKlineKing(strategy);
  else if (type === 'wick_any') await runWickAny(strategy);
}

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
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('双策略后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
