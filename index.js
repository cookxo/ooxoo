const express = require('express');
const axios = require('axios');

const app = express();

// 允许跨域
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ========== 内存存储（模拟数据库） ==========
const userConfigs = {};      // 存储用户配置
const userAccounts = {};     // 存储用户账户

const USER_ID = 'demo_user';

// 默认账户
const defaultAccount = {
  balance: 10000,
  equity: 10000,
  position: null,
  history: [],
  realizedPnl: 0,
  totalReturn: 0,
  markPrice: 0,
  strategyState: { nextAction: null }
};

// 初始化
if (!userAccounts[USER_ID]) {
  userAccounts[USER_ID] = { ...defaultAccount };
}

// ========== 模拟参数 ==========
const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;

const now = () => Math.floor(Date.now() / 1000);

// ========== 获取K线数据（公共API） ==========
async function fetchKlines(symbol, interval) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${interval}&limit=2`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      return res.data.data.map(item => ({
        time: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      }));
    }
  } catch (err) {
    console.error('获取K线失败', err);
  }
  return null;
}

// ========== 模拟成交价格 ==========
function getExecutedPrice(side, basePrice) {
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

function calculateSize(usdtAmount, leverage, price) {
  return (usdtAmount * leverage) / price;
}

// ========== 开仓 ==========
async function openPosition(userId, config, account, side, kline) {
  const { leverage, marginMode, amountUsdt } = config;
  const price = getExecutedPrice(side, kline.close);
  const size = calculateSize(amountUsdt, leverage, price);
  if (size <= 0) return;

  const initialMargin = (size * price) / leverage;
  if (account.balance < initialMargin) return;

  const fee = size * price * TAKER_FEE_RATE;
  account.balance -= fee;

  const position = {
    side,
    size,
    entryPrice: price,
    openTime: kline.time,
    leverage,
    marginMode,
    margin: initialMargin,
    unrealizedPnl: 0
  };

  if (marginMode === 'cross') {
    account.balance -= initialMargin;
  }

  account.position = position;
  account.history.push({
    type: 'open',
    side,
    size,
    price,
    fee,
    time: now()
  });

  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
}

// ========== 平仓 ==========
async function closePosition(userId, config, account, currentPrice) {
  const position = account.position;
  if (!position) return;

  const closePrice = getExecutedPrice(position.side === 'long' ? 'short' : 'long', currentPrice);
  const size = position.size;

  const pnl = position.side === 'long'
    ? (closePrice - position.entryPrice) * size
    : (position.entryPrice - closePrice) * size;

  const fee = size * closePrice * TAKER_FEE_RATE;

  if (position.marginMode === 'cross') {
    account.balance += (size * position.entryPrice / position.leverage) + pnl - fee;
  } else {
    account.balance += position.margin + pnl - fee;
  }

  account.realizedPnl += pnl;
  account.totalReturn = account.realizedPnl / 10000;

  account.history.push({
    type: 'close',
    side: position.side,
    size,
    price: closePrice,
    pnl,
    fee,
    time: now()
  });

  account.position = null;
  account.equity = account.balance;
}

// ========== 策略运行 ==========
async function runStrategy(userId) {
  const config = userConfigs[userId];
  if (!config || !config.active) return;

  const klines = await fetchKlines(config.symbol, config.interval);
  if (!klines || klines.length < 2) return;

  const lastClosed = klines[0];
  const current = klines[1];

  let account = userAccounts[userId] || { ...defaultAccount };
  account.markPrice = current.close;

  if (account.position) {
    if (lastClosed.time > account.position.openTime) {
      await closePosition(userId, config, account, lastClosed.close);
    }
  } else {
    if (!account.strategyState) account.strategyState = { nextAction: null };

    const isBull = lastClosed.close > lastClosed.open;
    const isBear = lastClosed.close < lastClosed.open;

    if (account.strategyState.nextAction === null) {
      if (isBull) account.strategyState.nextAction = 'long';
      else if (isBear) account.strategyState.nextAction = 'short';
    } else {
      if (account.strategyState.nextAction === 'long' && isBull) {
        await openPosition(userId, config, account, 'long', lastClosed);
        account.strategyState.nextAction = null;
      } else if (account.strategyState.nextAction === 'short' && isBear) {
        await openPosition(userId, config, account, 'short', lastClosed);
        account.strategyState.nextAction = null;
      }
    }
  }

  if (account.position) {
    const upnl = account.position.side === 'long'
      ? (current.close - account.position.entryPrice) * account.position.size
      : (account.position.entryPrice - current.close) * account.position.size;
    account.position.unrealizedPnl = upnl;
    account.equity = account.balance + upnl;
  } else {
    account.equity = account.balance;
  }

  userAccounts[userId] = account;
}

// ========== HTTP API ==========
app.get('/status', (req, res) => {
  const userId = req.query.user || USER_ID;
  const account = userAccounts[userId] || { ...defaultAccount };
  const config = userConfigs[userId];
  res.json({
    equity: account.equity,
    balance: account.balance,
    position: account.position,
    history: account.history,
    realizedPnl: account.realizedPnl,
    totalReturn: account.totalReturn,
    markPrice: account.markPrice || 0,
    klines: [],
    strategyActive: config ? config.active : false
  });
});

app.post('/config', (req, res) => {
  const userId = req.query.user || USER_ID;
  const config = req.body;
  if (!config.symbol || !config.interval || !config.leverage || !config.amountUsdt) {
    return res.status(400).json({ error: '参数不完整' });
  }
  userConfigs[userId] = config;
  res.json({ success: true });
});

app.post('/control', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { active } = req.body;
  const config = userConfigs[userId] || {};
  config.active = active;
  userConfigs[userId] = config;
  res.json({ success: true });
});

app.get('/export', (req, res) => {
  const userId = req.query.user || USER_ID;
  const account = userAccounts[userId] || {};
  const config = userConfigs[userId];
  const exportData = { config, account, exportTime: new Date().toISOString() };
  res.setHeader('Content-Disposition', `attachment; filename=kline_king_${userId}_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(exportData, null, 2));
});

// 启动服务器
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
