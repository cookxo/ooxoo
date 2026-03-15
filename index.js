const express = require('express');
const TableStore = require('tablestore');
const axios = require('axios');

const app = express();

// 允许所有跨域请求（关键！）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// 表格存储客户端（从环境变量获取）
const client = new TableStore.Client({
  accessKeyId: process.env.ACCESS_KEY_ID || 'dummy',
  secretAccessKey: process.env.ACCESS_KEY_SECRET || 'dummy',
  endpoint: process.env.TABLE_STORE_ENDPOINT || 'dummy',
  instancename: process.env.TABLE_STORE_INSTANCE || 'dummy'
});

const USER_TABLE = 'user_config';
const ACCOUNT_TABLE = 'user_account';
const USER_ID = 'demo_user';

const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;

const now = () => Math.floor(Date.now() / 1000);

// 读取用户配置
async function getUserConfig(userId) {
  try {
    const res = await client.getRow({
      tableName: USER_TABLE,
      primaryKey: [{ user_id: userId }]
    });
    if (res.row && res.row.attributes) {
      return JSON.parse(res.row.attributes.config);
    }
  } catch (err) {
    console.error('读取配置失败', err);
  }
  return null;
}

// 保存用户配置
async function saveUserConfig(userId, config) {
  await client.putRow({
    tableName: USER_TABLE,
    primaryKey: { user_id: userId },
    attributeColumns: {
      config: JSON.stringify(config),
      updated_at: now()
    }
  });
}

// 读取账户状态
async function getAccount(userId) {
  try {
    const res = await client.getRow({
      tableName: ACCOUNT_TABLE,
      primaryKey: [{ user_id: userId }]
    });
    if (res.row && res.row.attributes) {
      return {
        balance: parseFloat(res.row.attributes.balance) || 0,
        equity: parseFloat(res.row.attributes.equity) || 0,
        position: res.row.attributes.position ? JSON.parse(res.row.attributes.position) : null,
        history: res.row.attributes.history ? JSON.parse(res.row.attributes.history) : [],
        realizedPnl: parseFloat(res.row.attributes.realizedPnl) || 0,
        totalReturn: parseFloat(res.row.attributes.totalReturn) || 0,
      };
    }
  } catch (err) {
    console.error('读取账户失败', err);
  }
  return {
    balance: 10000,
    equity: 10000,
    position: null,
    history: [],
    realizedPnl: 0,
    totalReturn: 0
  };
}

// 保存账户状态
async function saveAccount(userId, account) {
  const { balance, equity, position, history, realizedPnl, totalReturn } = account;
  await client.putRow({
    tableName: ACCOUNT_TABLE,
    primaryKey: { user_id: userId },
    attributeColumns: {
      balance: balance.toString(),
      equity: equity.toString(),
      position: position ? JSON.stringify(position) : '',
      history: JSON.stringify(history.slice(-50)),
      realizedPnl: realizedPnl.toString(),
      totalReturn: totalReturn.toString(),
      updated_at: now()
    }
  });
}

// 获取K线数据
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

// 获取标记价格
async function fetchMarkPrice(symbol) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/ticker?instId=${symbol}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data[0]) {
      return parseFloat(res.data.data[0].last);
    }
  } catch (err) {
    console.error('获取价格失败', err);
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

async function runStrategy(userId) {
  const config = await getUserConfig(userId);
  if (!config || !config.active) return;

  const klines = await fetchKlines(config.symbol, config.interval);
  if (!klines || klines.length < 2) return;

  const lastClosed = klines[0];
  const current = klines[1];

  let account = await getAccount(userId);
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

  await saveAccount(userId, account);
}

// HTTP API 路由
app.get('/status', async (req, res) => {
  const userId = req.query.user || USER_ID;
  try {
    const account = await getAccount(userId);
    const config = await getUserConfig(userId);
    let klines = [];
    if (config && config.symbol) {
      klines = await fetchKlines(config.symbol, config.interval || '30m');
    }
    res.json({
      equity: account.equity,
      balance: account.balance,
      position: account.position,
      history: account.history,
      realizedPnl: account.realizedPnl,
      totalReturn: account.totalReturn,
      markPrice: account.markPrice || 0,
      klines: klines ? klines.slice(-30) : [],
      strategyActive: config ? config.active : false
    });
  } catch (err) {
    res.status(500).json({ error: '获取状态失败' });
  }
});

app.post('/config', async (req, res) => {
  const userId = req.query.user || USER_ID;
  const config = req.body;
  if (!config.symbol || !config.interval || !config.leverage || !config.amountUsdt) {
    return res.status(400).json({ error: '参数不完整' });
  }
  try {
    await saveUserConfig(userId, config);
    res.json({ success: true });
  } catch (err) {
    console.error('保存配置失败', err);
    res.status(500).json({ error: '保存失败' });
  }
});

app.post('/control', async (req, res) => {
  const userId = req.query.user || USER_ID;
  const { active } = req.body;
  try {
    const config = await getUserConfig(userId) || {};
    config.active = active;
    await saveUserConfig(userId, config);
    res.json({ success: true });
  } catch (err) {
    console.error('控制失败', err);
    res.status(500).json({ error: '操作失败' });
  }
});

app.get('/export', async (req, res) => {
  const userId = req.query.user || USER_ID;
  try {
    const account = await getAccount(userId);
    const config = await getUserConfig(userId);
    const exportData = { config, account, exportTime: new Date().toISOString() };
    res.setHeader('Content-Disposition', `attachment; filename=kline_king_${userId}_${Date.now()}.json`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    console.error('导出失败', err);
    res.status(500).json({ error: '导出失败' });
  }
});

// 启动服务器（Railway 会自动设置 PORT 环境变量）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
