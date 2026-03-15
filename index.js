const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ==================== 跨域配置 ====================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ==================== 内存数据存储 ====================
const userData = {}; // { userId: { strategies: { strategyId: { config, account } } } }

const USER_ID = 'demo_user';
const DEFAULT_BALANCE = 10000;

// 初始化用户数据
if (!userData[USER_ID]) {
  userData[USER_ID] = { strategies: {} };
}

// ==================== 工具函数 ====================
const OKX_API_BASE = 'https://www.okx.com';
const TAKER_FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0003;
const now = () => Math.floor(Date.now() / 1000);

// 获取K线数据（用于图表和策略）
async function fetchKlines(symbol, interval, limit = 30) {
  try {
    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      // 欧易返回的数据是倒序的（最新在前），转为正序便于图表
      return res.data.data.map(item => ({
        time: item[0],
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

// 模拟成交价格（考虑滑点）
function getExecutedPrice(side, basePrice) {
  const slippage = basePrice * SLIPPAGE_RATE;
  return side === 'long' ? basePrice + slippage : basePrice - slippage;
}

// 根据USDT金额和杠杆计算张数（合约面值1 USDT）
function calculateSize(usdtAmount, leverage, price) {
  return (usdtAmount * leverage) / price;
}

// 开仓
async function openPosition(strategy, account, side, kline) {
  const { leverage, marginMode, amountUsdt } = strategy.config;
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
  if (marginMode === 'cross') account.balance -= initialMargin;

  account.position = position;
  account.history.push({ type: 'open', side, size, price, fee, time: now() });
  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
}

// 平仓
async function closePosition(strategy, account, currentPrice) {
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
  account.totalReturn = account.realizedPnl / DEFAULT_BALANCE;
  account.history.push({ type: 'close', side: position.side, size, price: closePrice, pnl, fee, time: now() });
  account.position = null;
  account.equity = account.balance;
}

// 运行单个策略
async function runStrategy(strategy) {
  if (!strategy.config || !strategy.config.active) return;

  const { symbol, interval } = strategy.config;
  const klines = await fetchKlines(symbol, interval, 2);
  if (!klines || klines.length < 2) return;

  const lastClosed = klines[0];
  const current = klines[1];
  const account = strategy.account;
  account.markPrice = current.close;

  if (account.position) {
    // 持仓中：检查是否到了平仓时间（开仓后下一根K线收盘）
    if (lastClosed.time > account.position.openTime) {
      await closePosition(strategy, account, lastClosed.close);
    }
  } else {
    // 无持仓：根据状态等待开仓
    if (!account.strategyState) account.strategyState = { nextAction: null };
    const isBull = lastClosed.close > lastClosed.open;
    const isBear = lastClosed.close < lastClosed.open;

    if (account.strategyState.nextAction === null) {
      // 初始状态：根据最新K线决定第一个方向
      if (isBull) account.strategyState.nextAction = 'long';
      else if (isBear) account.strategyState.nextAction = 'short';
    } else {
      // 等待方向与当前K线一致时开仓
      if (account.strategyState.nextAction === 'long' && isBull) {
        await openPosition(strategy, account, 'long', lastClosed);
        account.strategyState.nextAction = null;
      } else if (account.strategyState.nextAction === 'short' && isBear) {
        await openPosition(strategy, account, 'short', lastClosed);
        account.strategyState.nextAction = null;
      }
    }
  }

  // 更新未实现盈亏
  if (account.position) {
    const upnl = account.position.side === 'long'
      ? (current.close - account.position.entryPrice) * account.position.size
      : (account.position.entryPrice - current.close) * account.position.size;
    account.position.unrealizedPnl = upnl;
    account.equity = account.balance + upnl;
  } else {
    account.equity = account.balance;
  }
}

// 定时任务：每分钟遍历所有用户的策略，执行
setInterval(() => {
  for (const userId in userData) {
    const strategies = userData[userId].strategies;
    for (const strategyId in strategies) {
      runStrategy(strategies[strategyId]).catch(err => {
        console.error(`策略 ${strategyId} 执行出错`, err);
      });
    }
  }
}, 60 * 1000);

// ==================== API 路由 ====================
// 获取所有策略概览
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
    markPrice: s.account.markPrice || 0
  }));
  res.json(list);
});

// 创建新策略
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

// 删除策略
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

// 获取单个策略详情（包括K线数据）
app.get('/strategy/:id', async (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });

  let klines = [];
  if (strategy.config.symbol) {
    klines = await fetchKlines(strategy.config.symbol, strategy.config.interval, 30);
  }
  res.json({
    config: strategy.config,
    account: strategy.account,
    klines: klines || []
  });
});

// 更新策略配置
app.post('/strategy/:id/config', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });

  const { symbol, interval, leverage, amountUsdt, marginMode } = req.body;
  if (symbol) strategy.config.symbol = symbol;
  if (interval) strategy.config.interval = interval;
  if (leverage) strategy.config.leverage = parseInt(leverage);
  if (amountUsdt) strategy.config.amountUsdt = parseFloat(amountUsdt);
  if (marginMode) strategy.config.marginMode = marginMode;
  res.json({ success: true });
});

// 控制策略启动/停止
app.post('/strategy/:id/control', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const { active } = req.body;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });
  strategy.config.active = active;
  res.json({ success: true });
});

// 导出单个策略数据
app.get('/strategy/:id/export', (req, res) => {
  const userId = req.query.user || USER_ID;
  const { id } = req.params;
  const strategy = userData[userId]?.strategies[id];
  if (!strategy) return res.status(404).json({ error: '策略不存在' });

  const exportData = {
    config: strategy.config,
    account: strategy.account,
    exportTime: new Date().toISOString()
  };
  res.setHeader('Content-Disposition', `attachment; filename=strategy_${id}_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(exportData, null, 2));
});

// 健康检查
app.get('/', (req, res) => res.send('多策略K线之王后端运行中'));

// ==================== 启动服务器 ====================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ 多策略服务器运行在端口 ${port}`);
});
