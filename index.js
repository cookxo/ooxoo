// ==================== 统一版 fetchKlines ====================
async function fetchKlines(symbol, interval, limit = 2) {
  try {
    // 参数格式转换（欧易API要求大写）
    let apiInterval = interval;
    if (interval === '1h') apiInterval = '1H';
    else if (interval === '2h') apiInterval = '2H';
    else if (interval === '4h') apiInterval = '4H';
    else if (interval === '6h') apiInterval = '6H';
    else if (interval === '12h') apiInterval = '12H';
    else if (interval === '1d') apiInterval = '1D';

    const url = `${OKX_API_BASE}/api/v5/market/candles?instId=${symbol}&bar=${apiInterval}&limit=${limit}`;
    console.log(`[K线请求] ${symbol} ${interval} -> ${apiInterval} limit=${limit}`);
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
      // 强制按时间升序排序（确保 k0 < k1 < k2）
      all.sort((a, b) => a.time - b.time);

      const valid = all.filter(k => k.time > 0 && k.close > 0 && k.open > 0);
      console.log(`[K线原始] ${symbol} ${interval} 收到 ${all.length} 根，有效 ${valid.length} 根`);
      if (valid.length < limit) {
        console.warn(`[K线警告] ${symbol} ${interval} 有效K线不足 ${limit} 根，实际 ${valid.length} 根`);
        // 即使不足，只要至少2根就返回（策略会处理），否则返回null
        if (valid.length >= 2) return valid;
        return null;
      }
      return valid;
    } else {
      console.error(`[K线错误] ${symbol} ${interval} API返回错误: ${res.data.code} ${res.data.msg}`);
      return null;
    }
  } catch (err) {
    console.error(`获取K线失败 ${symbol} ${interval}`, err.message);
  }
  return null;
}

// ==================== 统一版 runKlineKing ====================
async function runKlineKing(strategy) {
  try {
    if (!strategy.config || !strategy.config.active) return;

    const { symbol, interval, direction, shrink } = strategy.config;
    const intervalMsVal = intervalMs[interval];
    if (!intervalMsVal) return;

    // 获取最近3根K线（用于反转信号和平仓判断）
    const klines = await fetchKlines(symbol, interval, 3);
    if (!klines || klines.length < 3) {
      console.log(`[${strategy.id}] ${interval} K线不足3根，无法执行策略`);
      return;
    }

    const nowMs = Date.now();

    // 正序数组：k0（最老），k1（中间），k2（最新）
    const k0 = klines[0];
    const k1 = klines[1];
    const k2 = klines[2];

    // 打印关键K线信息（便于排查）
    console.log(`[${strategy.id}] ${interval} 当前时间: ${new Date(nowMs).toISOString()}`);
    console.log(`[${strategy.id}] k0: 时间=${new Date(k0.time).toISOString()}, 开=${k0.open}, 收=${k0.close}, 阳=${k0.close > k0.open}`);
    console.log(`[${strategy.id}] k1: 时间=${new Date(k1.time).toISOString()}, 开=${k1.open}, 收=${k1.close}, 阳=${k1.close > k1.open}`);
    console.log(`[${strategy.id}] k2: 时间=${new Date(k2.time).toISOString()}, 开=${k2.open}, 收=${k2.close}, 阳=${k2.close > k2.open}`);

    // 判断k1是否已收盘
    const k1EndTime = k1.time + intervalMsVal;
    if (nowMs < k1EndTime) {
      console.log(`[${strategy.id}] k1未收盘: 当前时间 ${nowMs} < 结束时间 ${k1EndTime}`);
      return;
    }

    // 初始化：首次运行时，记录k1时间，不交易
    if (strategy.lastProcessedKlineTime === undefined) {
      strategy.lastProcessedKlineTime = k1.time;
      console.log(`[${strategy.id}] 策略启动，等待下一根K线`);
      return;
    }

    // 避免重复处理同一根K线
    if (strategy.lastProcessedKlineTime === k1.time) {
      console.log(`[${strategy.id}] 已处理过k1，跳过`);
      return;
    }
    strategy.lastProcessedKlineTime = k1.time;

    const account = strategy.account;
    if (!strategy.state) strategy.state = { status: 'idle' };
    const state = strategy.state;

    // 缩量检查
    let volumeOk = true;
    if (shrink) {
      volumeOk = k1.volume < k0.volume;
      console.log(`[${strategy.id}] 缩量条件: k1体积=${k1.volume}, k0体积=${k0.volume}, 满足=${volumeOk}`);
    }

    // ========== 无持仓 ==========
    if (!account.position) {
      // 反转信号
      const isBullReversal = (k0.close < k0.open) && (k1.close > k1.open);
      const isBearReversal = (k0.close > k0.open) && (k1.close < k1.open);
      console.log(`[${strategy.id}] 反转信号: 做多=${isBullReversal}, 做空=${isBearReversal}`);

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
        console.log(`[${strategy.id}] 满足开仓条件，即将开仓 ${openSide}`);
        await openPosition(strategy, account, openSide, k1.close, k1.time, symbol);
      } else {
        console.log(`[${strategy.id}] 不满足开仓条件`);
      }
    } else {
      // ========== 有持仓 ==========
      const position = account.position;
      // 计数器增加
      state.barsSinceOpen = (state.barsSinceOpen || 0) + 1;
      console.log(`[${strategy.id}] 开仓后经历K线数: ${state.barsSinceOpen}`);

      // 当开仓后至少经历1根新K线时，平仓
      if (state.barsSinceOpen >= 1) {
        console.log(`[${strategy.id}] 平仓检查: k1阴阳=${k1.close > k1.open ? '阳' : '阴'}, 持仓方向=${position.side}`);
        if (position.side === 'long') {
          if (k1.close > k1.open) {
            await closePosition(strategy, account, k1.close, 'take profit');
            state.status = 'idle';
            state.barsSinceOpen = 0;
          } else if (k1.close < k1.open) {
            await closePosition(strategy, account, k1.close, 'stop loss');
            if (direction === 'both' || direction === 'short') {
              await openPosition(strategy, account, 'short', k1.close, k1.time, symbol);
            } else {
              state.status = 'idle';
            }
            state.barsSinceOpen = 0;
          }
        } else if (position.side === 'short') {
          if (k1.close < k1.open) {
            await closePosition(strategy, account, k1.close, 'take profit');
            state.status = 'idle';
            state.barsSinceOpen = 0;
          } else if (k1.close > k1.open) {
            await closePosition(strategy, account, k1.close, 'stop loss');
            if (direction === 'both' || direction === 'long') {
              await openPosition(strategy, account, 'long', k1.close, k1.time, symbol);
            } else {
              state.status = 'idle';
            }
            state.barsSinceOpen = 0;
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
  }
}
