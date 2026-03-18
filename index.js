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
const SLIPPAGE_RATE = 0.0003;
const now = () => Math.floor(Date.now() / 1000);

const intervalMs = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
};

// ==================== 技术指标函数 ====================
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema[i] = (data[i] - ema[i-1]) * k + ema[i-1];
  }
  return ema;
}

function calculateATR(klines, period) {
  if (klines.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i-1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let sum = 0;
  for (let i = tr.length - period; i < tr.length; i++) {
    sum += tr[i];
  }
  return sum / period;
}

async function fetchKlines(symbol, interval, limit = 200) {
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

// ==================== 交易执行 ====================
function getExecutedPrice(side, basePrice) {
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

function calculateSize(usdtAmount, leverage, price) {
  return (usdtAmount * leverage) / price;
}

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
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval, emaPeriod, atrMultiplier } = strategy.config;
  const intervalMsVal = intervalMs[interval] || 30 * 60 * 1000;

  // 获取足够多的K线用于计算指标（至少需要 max(emaPeriod, 14) 根）
  const neededBars = Math.max(emaPeriod || 20, 14) + 5;
  const klines = await fetchKlines(symbol, interval, neededBars);
  if (!klines || klines.length < neededBars) return;

  const latestKline = klines[klines.length - 1];
  const prevKline = klines[klines.length - 2];

  const account = strategy.account;
  const nowMs = Date.now();

  const prevKlineEndTime = prevKline.time + intervalMsVal;
  if (prevKlineEndTime > nowMs) return;
  if (strategy.lastProcessedKlineTime === prevKline.time) return;
  strategy.lastProcessedKlineTime = prevKline.time;

  // 计算指标
  const closes = klines.map(k => k.close);
  const ema = calculateEMA(closes, emaPeriod || 20).pop();
  const atr = calculateATR(klines, 14); // ATR周期固定为14，常用值
  if (!ema || !atr) return;

  const multiplier = atrMultiplier || 2.0;

  if (!strategy.state) strategy.state = { status: 'idle' };
  const state = strategy.state;

  // ========== 无持仓 ==========
  if (!account.position) {
    if (state.status === 'idle') {
      if (prevKline.close < prevKline.open && prevKline.close < ema) {
        state.status = 'wait_long';
      } else if (prevKline.close > prevKline.open && prevKline.close > ema) {
        state.status = 'wait_short';
      }
    } else if (state.status === 'wait_long') {
      if (prevKline.close > prevKline.open && prevKline.close > ema) {
        await openPosition(strategy, account, 'long', prevKline.close, prevKline.time);
      }
    } else if (state.status === 'wait_short') {
      if (prevKline.close < prevKline.open && prevKline.close < ema) {
        await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
      }
    }
  } else {
    // ========== 有持仓 ==========
    const position = account.position;
    const openKlineTime = state.openKlineTime;

    if (prevKline.time >= openKlineTime + intervalMsVal) {
      if (position.side === 'long') {
        const stopPrice = position.entryPrice - atr * multiplier;
        if (prevKline.close < stopPrice) {
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          state.status = 'wait_short';
        } else {
          if (prevKline.close > prevKline.open) {
            await closePosition(strategy, account, prevKline.close, 'take profit');
            state.status = 'wait_short';
          } else if (prevKline.close < prevKline.open) {
            await closePosition(strategy, account, prevKline.close, 'stop loss');
            await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
          }
        }
      } else if (position.side === 'short') {
        const stopPrice = position.entryPrice + atr * multiplier;
        if (prevKline.close > stopPrice) {
          await closePosition(strategy, account, prevKline.close, 'stop loss');
          state.status = 'wait_long';
        } else {
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
    symbol: s.config.symbol,
    interval: s.config.interval,
    leverage: s.config.leverage,
    amountUsdt: s.config.amountUsdt,
    marginMode: s.config.marginMode,
    emaPeriod: s.config.emaPeriod,
    atrMultiplier: s.config.atrMultiplier,
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
  const { name, symbol, interval, leverage, amountUsdt, marginMode, emaPeriod, atrMultiplier } = req.body;
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
      emaPeriod: parseInt(emaPeriod) || 20,
      atrMultiplier: parseFloat(atrMultiplier) || 2.0,
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
    const klines = await fetchKlines(strategy.config.symbol, '1m', 1);
    if (klines && klines[0]) currentPrice = klines[0].close;
  }
  if (!currentPrice) return res.status(500).json({ error: '无法获取价格' });

  await closePosition(strategy, account, currentPrice, 'manual');
  strategy.state.status = 'idle';
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('K线之王后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
