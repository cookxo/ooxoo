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

// ==================== 工具函数 ====================
async function fetchKlines(symbol, interval, limit = 2) {
  try {
    let apiInterval = interval;
    if (interval === '1h') apiInterval = '1H';
    else if (interval === '2h') apiInterval = '2H';
    else if (interval === '4h') apiInterval = '4H';
    else if (interval === '6h') apiInterval = '6H';
    else if (interval === '12h') apiInterval = '12H';
    else if (interval === '1d') apiInterval = '1D';

    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${apiInterval}&limit=${limit}`;
    const res = await axios.get(url);
    if (res.data.code === '0' && res.data.data) {
      let all = res.data.data.map(item => ({
        time: parseInt(item[0]),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        volume: parseFloat(item[5])
      }));
      // 严格按时间升序排序
      all.sort((a, b) => a.time - b.time);
      // 过滤无效K线（价格为0或时间为0）
      const valid = all.filter(k => k.time > 0 && k.close > 0 && k.open > 0);
      // 只要有效K线数量 >= 2，就返回（不足2根时无法判断反转，但可以返回后续重试）
      if (valid.length < 2) return null;
      return valid;
    } else {
      console.error(`[K线API错误] ${symbol} ${interval}: ${res.data.msg}`);
      return null;
    }
  } catch (err) {
    console.error(`[获取K线失败] ${symbol} ${interval}`, err.message);
    return null;
  }
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

// 开仓
async function openPosition(strategy, account, side, price, klineStartTime, symbol) {
  if (!price || price <= 0) {
    const errMsg = `开仓失败: 价格无效 ${price}`;
    console.error(`[${strategy.id}] ${errMsg}`);
    strategy.state.error = errMsg;
    return false;
  }
  const { leverage, marginMode, amountUsdt } = strategy.config;
  const execPrice = getExecutedPrice(side, price);
  if (execPrice <= 0) {
    const errMsg = `开仓失败: 执行价格无效 ${execPrice}`;
    console.error(`[${strategy.id}] ${errMsg}`);
    strategy.state.error = errMsg;
    return false;
  }
  const size = calculateSize(amountUsdt, leverage, execPrice);
  if (size <= 0) {
    const errMsg = `开仓失败: 数量无效 ${size}`;
    console.error(`[${strategy.id}] ${errMsg}`);
    strategy.state.error = errMsg;
    return false;
  }
  const initialMargin = (size * execPrice) / leverage;
  if (account.balance < initialMargin) {
    const errMsg = `开仓失败: 余额不足，需要 ${initialMargin.toFixed(2)}，余额 ${account.balance.toFixed(2)}`;
    console.error(`[${strategy.id}] ${errMsg}`);
    strategy.state.error = errMsg;
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
    openKlineStart: klineStartTime,
    leverage,
    marginMode,
    margin: initialMargin,
    unrealizedPnl: 0
  };
  account.position = position;
  account.history.push({ type: 'open', side, size, price: execPrice, fee, time: now(), symbol });
  account.equity = account.balance + (position.size * position.entryPrice / position.leverage);
  strategy.state.status = side === 'long' ? 'in_long' : 'in_short';
  strategy.state.openKlineStart = klineStartTime;
  strategy.state.error = null;
  console.log(`[${strategy.id}] 开仓 ${side} ${size.toFixed(4)}张 @ ${execPrice.toFixed(2)}，开仓K线开始时间=${new Date(klineStartTime).toISOString()}`);
  return true;
}

// 平仓
async function closePosition(strategy, account, price, reason = '') {
  const position = account.position;
  if (!position) return null;
  if (!price || price <= 0) {
    const errMsg = `平仓失败: 价格无效 ${price}`;
    console.error(`[${strategy.id}] ${errMsg}`);
    strategy.state.error = errMsg;
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
  strategy.state.error = null;
  console.log(`[${strategy.id}] 平仓 ${position.side} ${size.toFixed(4)}张 @ ${execPrice.toFixed(2)}，盈亏 ${pnl.toFixed(2)}，原因 ${reason}`);
  return pnl;
}

// ==================== 策略核心（绝对时间比较） ====================
async function runKlineKing(strategy) {
  try {
    if (!strategy.config || !strategy.config.active) return;

    const { symbol, interval, direction, shrink } = strategy.config;
    const intervalMsVal = intervalMs[interval];
    if (!intervalMsVal) return;

    // 获取最近3根K线（确保有足够历史数据判断反转）
    const klines = await fetchKlines(symbol, interval, 3);
    if (!klines || klines.length < 3) {
      // 数据不足，不执行，也不报错（等待下次）
      return;
    }

    const nowMs = Date.now();

    const k0 = klines[0];  // 更早一根已收盘
    const k1 = klines[1];  // 最近一根已收盘
    const k2 = klines[2];  // 当前未收盘

    // 判断k1是否已收盘：其结束时间 <= 当前时间
    const k1EndTime = k1.time + intervalMsVal;
    if (nowMs < k1EndTime) return;

    // 初始化：首次运行时，记录k1时间，不交易
    if (strategy.lastProcessedKlineTime === undefined) {
      strategy.lastProcessedKlineTime = k1.time;
      console.log(`[${strategy.id}] 策略启动，等待下一根K线`);
      return;
    }

    // 避免重复处理同一根K线
    if (strategy.lastProcessedKlineTime === k1.time) return;
    strategy.lastProcessedKlineTime = k1.time;

    const account = strategy.account;
    if (!strategy.state) strategy.state = { status: 'idle', error: null };
    const state = strategy.state;
    state.error = null;

    // 缩量检查（k1与k0比较）
    let volumeOk = true;
    if (shrink) {
      volumeOk = k1.volume < k0.volume;
    }

    // ========== 无持仓 ==========
    if (!account.position) {
      // 反转信号：k0阴且k1阳 → 做多；k0阳且k1阴 → 做空
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
      // ========== 有持仓 ==========
      const position = account.position;
      const openKlineStart = state.openKlineStart;
      // 平仓条件：最近一根已收盘K线的时间 >= 开仓K线开始时间 + 周期
      if (k1.time >= openKlineStart + intervalMsVal) {
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
  } catch (err) {
    console.error(`[${strategy.id}] 策略执行异常:`, err);
    strategy.state.error = `策略异常: ${err.message}`;
  }
}

// 上影线策略占位
async function runWickAny(strategy) { return; }

async function runStrategy(strategy) {
  try {
    if (!strategy.config || !strategy.config.active) return;
    const type = strategy.config.type;
    if (type === 'kline_king') await runKlineKing(strategy);
    else if (type === 'wick_any') await runWickAny(strategy);
  } catch (err) {
    console.error(`调度策略失败:`, err);
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
  try {
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
      status: s.state?.status || 'idle',
      error: s.state?.error || null
    }));
    res.json(list);
  } catch (err) {
    console.error('获取策略列表失败', err);
    res.status(500).json({ error: '获取策略失败' });
  }
});

app.post('/strategy', (req, res) => {
  try {
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
      id: strategyId,
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
      state: { status: 'idle', error: null }
    };
    userData[userId].strategies[strategyId] = newStrategy;
    res.json({ id: strategyId });
  } catch (err) {
    console.error('创建策略失败', err);
    res.status(500).json({ error: '创建策略失败' });
  }
});

app.delete('/strategy/:id', (req, res) => {
  try {
    const userId = req.query.user || USER_ID;
    const { id } = req.params;
    if (userData[userId].strategies[id]) {
      delete userData[userId].strategies[id];
      res.json({ success: true });
    } else {
      res.status(404).json({ error: '策略不存在' });
    }
  } catch (err) {
    console.error('删除策略失败', err);
    res.status(500).json({ error: '删除失败' });
  }
});

app.get('/strategy/:id', async (req, res) => {
  try {
    const userId = req.query.user || USER_ID;
    const { id } = req.params;
    const strategy = userData[userId]?.strategies[id];
    if (!strategy) return res.status(404).json({ error: '策略不存在' });

    let klines = [];
    if (strategy.config.symbol) {
      // 前端K线图请求50根，减少负载
      klines = await fetchKlines(strategy.config.symbol, strategy.config.interval, 50);
    }
    res.json({
      config: strategy.config,
      account: strategy.account,
      klines: klines || []
    });
  } catch (err) {
    console.error('获取策略详情失败', err);
    res.status(500).json({ error: '获取策略详情失败' });
  }
});

app.post('/strategy/:id/control', (req, res) => {
  try {
    const userId = req.query.user || USER_ID;
    const { id } = req.params;
    const { active } = req.body;
    const strategy = userData[userId]?.strategies[id];
    if (!strategy) return res.status(404).json({ error: '策略不存在' });
    strategy.config.active = active;
    res.json({ success: true });
  } catch (err) {
    console.error('控制策略失败', err);
    res.status(500).json({ error: '控制失败' });
  }
});

app.post('/strategy/:id/close', async (req, res) => {
  try {
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
  } catch (err) {
    console.error('手动平仓失败', err);
    res.status(500).json({ error: '平仓失败' });
  }
});

app.get('/', (req, res) => res.send('双策略后端运行中'));

// 全局异常捕获
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ 服务器运行在端口 ${port}`));
