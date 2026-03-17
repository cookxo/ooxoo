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

// 周期转秒数
const intervalSeconds = {
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200, '1d': 86400
};

// ==================== 工具函数 ====================
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
      })).reverse(); // 正序
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
  if (marginMode === 'cross' || marginMode === 'isolated') {
    account.balance -= initialMargin; // 全仓/逐仓都扣除保证金
  }

  const position = {
    side,
    size,
    entryPrice: execPrice,
    openTime: klineTime,       // 开仓的K线时间（毫秒）
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
async function closePosition(strategy, account, price, pnlOnly = false) {
  const position = account.position;
  if (!position) return null;

  const execPrice = getExecutedPrice(position.side === 'long' ? 'short' : 'long', price);
  const size = position.size;
  const pnl = position.side === 'long'
    ? (execPrice - position.entryPrice) * size
    : (position.entryPrice - execPrice) * size;
  const fee = size * execPrice * TAKER_FEE_RATE;

  if (position.marginMode === 'cross') {
    account.balance += (size * position.entryPrice / position.leverage) + pnl - fee;
  } else {
    account.balance += position.margin + pnl - fee;
  }

  account.realizedPnl += pnl;
  account.totalReturn = account.realizedPnl / DEFAULT_BALANCE;
  account.history.push({ type: 'close', side: position.side, size, price: execPrice, pnl, fee, time: now() });
  account.position = null;
  account.equity = account.balance;
  return pnl;
}

// ==================== 策略核心（严格按规则）====================
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval } = strategy.config;
  const klines = await fetchKlines(symbol, interval, 2); // 只需最近2根
  if (!klines || klines.length < 2) return;

  const prevKline = klines[0];      // 上一根已收盘K线
  const currentKline = klines[1];   // 当前正在形成的K线
  const account = strategy.account;
  const nowSec = now() * 1000;       // 当前毫秒

  // 计算当前K线结束时间
  const intervalSec = intervalSeconds[interval] || 60;
  const currentEndTime = currentKline.time + intervalSec * 1000;
  const timeToClose = currentEndTime - nowSec; // 毫秒

  // 只在收盘前59秒内执行操作
  if (timeToClose > 59000 || timeToClose < 0) return; // 大于59秒或已收盘则跳过

  // 状态变量
  if (!account.strategyState) account.strategyState = { nextAction: null };

  // 无持仓
  if (!account.position) {
    // 初始化等待方向（根据上一根K线）
    if (account.strategyState.nextAction === null) {
      account.strategyState.nextAction = prevKline.close > prevKline.open ? 'short' : 'long';
    }

    // 检查是否需要开仓
    const isBull = prevKline.close > prevKline.open;
    const isBear = prevKline.close < prevKline.open;

    if (account.strategyState.nextAction === 'long' && isBull) {
      // 下跌后出现第一根阳线 → 开多
      await openPosition(strategy, account, 'long', prevKline.close, prevKline.time);
      account.strategyState.nextAction = null; // 进入持仓，等待下一根
    } else if (account.strategyState.nextAction === 'short' && isBear) {
      // 上涨后出现第一根阴线 → 开空
      await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
      account.strategyState.nextAction = null;
    }
  } else {
    // 有持仓，根据上一根K线决定操作
    const position = account.position;
    const isBull = prevKline.close > prevKline.open;
    const isBear = prevKline.close < prevKline.open;

    if (position.side === 'long') {
      // 持有多仓
      if (isBull) {
        // 第二根收阳 → 止盈平多
        await closePosition(strategy, account, prevKline.close);
        // 平仓后，等待阴线做空（规则：之后继续阳线不交易，直到出现阴线做空）
        account.strategyState.nextAction = 'short';
      } else if (isBear) {
        // 第二根收阴 → 止损平多，并反手做空
        await closePosition(strategy, account, prevKline.close);
        // 反手开空（用相同资金）
        await openPosition(strategy, account, 'short', prevKline.close, prevKline.time);
        // 反手后状态为持仓空，无需设置nextAction
      }
    } else if (position.side === 'short') {
      // 持有空仓
      if (isBear) {
        // 第二根收阴 → 止盈平空
        await closePosition(strategy, account, prevKline.close);
        account.strategyState.nextAction = 'long';
      } else if (isBull) {
        // 第二根收阳 → 止损平空，并反手做多
        await closePosition(strategy, account, prevKline.close);
        await openPosition(strategy, account, 'long', prevKline.close, prevKline.time);
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

// 每分钟定时执行（实际每10秒检查一次，提高精度）
setInterval(() => {
  for (const userId in userData) {
    for (const id in userData[userId].strategies) {
      runStrategy(userData[userId].strategies[id]).catch(e => console.error(e));
    }
  }
}, 10 * 1000); // 10秒一次，确保能捕捉到收盘前59秒

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
      strategyState: { nextAction: null }
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

  await closePosition(strategy, account, currentPrice);
  res.json({ success: true });
});

app.get('/', (req, res) => res.send('K线之王后端运行中'));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
