/**
 *
 * GPT & Gemini 双重检测 (加速优化版) (适配 Sub-Store Node.js 版)
 *
 * 同时检测节点是否可用 Chat GPT 和 Gemini 服务.
 * 在检查单个节点时，并行发起 GPT 和 Gemini 的检测请求，以提高效率。
 * GPT 检测沿用网页状态码+Body判断.
 * Gemini 检测沿用 API Endpoint+Body关键词判断 (尝试更准确判断区域限制).
 *
 * 欢迎加入 Telegram 群组 https://t.me/zhetengsha
 *
 * HTTP META(https://github.com/xream/http-meta) 参数
 * - [http_meta_protocol] 协议 默认: http
 * - [http_meta_host] 服务地址 默认: 127.0.0.1
 * - [http_meta_port] 端口号 默认: 9876
 * - [http_meta_authorization] Authorization 默认无
 * - [http_meta_start_delay] 初始启动延时(单位: 毫秒) 默认: 3000 (可适当调小如果HTTP META启动很快)
 * - [http_meta_proxy_timeout] 每个节点耗时(单位: 毫秒). 此参数是为了防止脚本异常退出未关闭核心. 设置过小将导致核心过早退出. 目前逻辑: 启动初始的延时 + 每个节点耗时. 默认: 10000
 *
 * 其它参数
 * - [timeout] 请求超时(单位: 毫秒) 默认 5000 (可适当调小，但可能导致慢速节点被误判)
 * - [retries] 重试次数 默认 1 (可设为 0 减少时间，但可能因临时网络波动误判)
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000 (可适当调小)
 * - [concurrency] 并发数 默认 10 (推荐根据机器性能和HTTP META负载适当调大，这是影响速度的关键参数之一)
 * - [method] GPT检测请求方法. 默认 get. Gemini检测固定使用 get.
 * - [client] GPT检测的客户端类型. 默认 iOS. (Android: https://android.chat.openai.com, iOS: https://ios.chat.openai.com)
 * - [gpt_prefix] GPT 可用显示前缀. 默认为 "[GPT] "
 * - [gemini_prefix] Gemini 可用显示前缀. 默认为 "[Gemini] "
 * - [gpt_gemini_prefix] GPT 和 Gemini 同时可用显示前缀. 默认为 "[GPTxGemini] "
 * 注: 节点上新增 _gpt, _gpt_latency, _gemini, _gemini_latency 字段, 可用于脚本筛选和排序.
 * - [cache] 使用缓存, 默认不使用缓存 (启用缓存可以极大地加速重复检测)
 * - [disable_failed_cache/ignore_failed_error] 禁用失败缓存. 即不缓存失败结果. 仅当缓存结果同时失败时生效.
 * 关于缓存时长
 * 当使用相关脚本时, 若在对应的脚本中使用参数开启缓存, 可设置持久化缓存 sub-store-csr-expiration-time 的值来自定义默认缓存时长, 默认为 172800000 (48 * 3600 * 1000, 即 48 小时)
 * 🎈Loon 可在插件中设置
 * 其他平台同理, 持久化缓存数据在 JSON 里
 */

async function operator(proxies = [], targetPlatform, context) {
  const cacheEnabled = $arguments.cache
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error
  const cache = scriptResourceCache
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1'
  const http_meta_port = $arguments.http_meta_port ?? 9876
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http'
  const http_meta_authorization = $arguments.http_meta_authorization ?? ''
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000)
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000)

  // GPT check parameters
  const gptCheckMethod = $arguments.method || 'get';
  const gptUrl = $arguments.client === 'Android' ? `https://android.chat.openai.com` : `https://ios.chat.openai.com`;

  // Gemini check parameters
  const geminiCheckMethod = 'get'; // Gemini API endpoint check fixed to GET
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models`; // API Endpoint for Gemini
   // Common patterns for regional blocking errors from Google APIs
  const geminiRegionalBlockPatterns = [
    /unsupported_country/i,
    /region_restricted/i,
    /location blocked/i,
    /requests from this region are not supported/i,
    /service is not available in your region/i
  ];

  // Prefixes
  const gptPrefix = $arguments.gpt_prefix ?? '[GPT] ';
  const geminiPrefix = $arguments.gemini_prefix ?? '[Gemini] ';
  const combinedPrefix = $arguments.gpt_gemini_prefix ?? '[GPTxGemini] ';


  const $ = $substore
  const internalProxies = []
  proxies.map((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0]
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key]
          }
        }
        internalProxies.push({ ...node, _proxies_index: index })
      }
    } catch (e) {
      $.error(`Proxy conversion error for ${proxy.name || index}: ${e.message ?? e}`)
    }
  })
  $.info(`核心支持节点数: ${internalProxies.length}/${proxies.length}`)
  if (!internalProxies.length) return proxies

  // Initial Cache check (same logic as before)
  if (cacheEnabled) {
    try {
      let allCachedAndUsed = true;
      for (var i = 0; i < internalProxies.length; i++) {
        const proxy = internalProxies[i]
        const id = getCacheId({ proxy, gptUrl, geminiUrl })
        const cached = cache.get(id)

        if (cached && cached.hasOwnProperty('gpt') && cached.hasOwnProperty('gemini')) {
             if (!disableFailedCache || (cached.gpt || cached.gemini)) {
                if (cached.gpt && cached.gemini) {
                    proxies[proxy._proxies_index].name = `${combinedPrefix}${proxies[proxy._proxies_index].name}`;
                } else if (cached.gpt) {
                    proxies[proxy._proxies_index].name = `${gptPrefix}${proxies[proxy._proxies_index].name}`;
                } else if (cached.gemini) {
                     proxies[proxy._proxies_index].name = `${geminiPrefix}${proxies[proxy._proxies_index].name}`;
                }
                proxies[proxy._proxies_index]._gpt = cached.gpt;
                proxies[proxy._proxies_index]._gpt_latency = cached.gpt_latency || 0;
                proxies[proxy._proxies_index]._gemini = cached.gemini;
                proxies[proxy._proxies_index]._gemini_latency = cached.gemini_latency || 0;
             } else {
                allCachedAndUsed = false;
             }
        } else {
          allCachedAndUsed = false;
        }
      }
      if (allCachedAndUsed) {
        $.info('所有节点都有有效缓存或失败缓存且禁用失败缓存未开启，完成双重检测');
        return proxies;
      } else {
          $.info('部分节点缓存缺失或无效，开始实时检测...');
      }
    } catch (e) {
         $.error(`缓存读取错误: ${e.message ?? e}`);
    }
  }


  const http_meta_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout

  let http_meta_pid
  let http_meta_ports = []
  // 启动 HTTP META
  try {
      const res = await http({
          retries: 0,
          method: 'post',
          url: `${http_meta_api}/start`,
          headers: {
              'Content-type': 'application/json',
              Authorization: http_meta_authorization,
          },
          body: JSON.stringify({
              proxies: internalProxies,
              timeout: http_meta_timeout,
          }),
      });
      let body = res.body;
      try {
          body = JSON.parse(body);
      } catch (e) {
           body = res.rawBody || res.body || String(res);
      }
      const { ports, pid } = body || {};

      if (!pid || !ports || !Array.isArray(ports) || ports.length !== internalProxies.length) {
          const errorMsg = `HTTP META 启动失败或返回数据异常: ${typeof body === 'object' ? JSON.stringify(body, null, 2) : body}`;
          $.error(errorMsg);
          return proxies;
      }
      http_meta_pid = pid;
      http_meta_ports = ports;
      $.info(
          `\n======== HTTP META 启动 ====\n[端口] ${ports}\n[PID] ${pid}\n[超时] 若未手动关闭 ${
              Math.round(http_meta_timeout / 60 / 10) / 100
          } 分钟后自动关闭\n`
      );
      $.info(`等待 ${http_meta_start_delay / 1000} 秒后开始双重检测`);
      await $.wait(http_meta_start_delay);

      const concurrency = parseInt($arguments.concurrency || 16);
      // Execute the check function concurrently for all internal proxies
      await executeAsyncTasks(
          internalProxies.map(proxy => () => check(proxy)),
          { concurrency }
      );

  } catch (e) {
      $.error(`HTTP META 操作异常: ${e.message ?? e}`);
  } finally {
      if (http_meta_pid) {
          try {
              const res = await http({
                  method: 'post',
                  url: `${http_meta_api}/stop`,
                  headers: {
                      'Content-type': 'application/json',
                      Authorization: http_meta_authorization,
                  },
                  body: JSON.stringify({
                      pid: [http_meta_pid],
                  }),
              });
              $.info(`\n======== HTTP META 关闭 ====\n${JSON.stringify(res, null, 2)}`);
          } catch (e) {
              $.error(`HTTP META 关闭异常: ${e.message ?? e}`);
          }
      } else {
           $.info('\n======== HTTP META 未成功启动, 无需关闭 ========');
      }
  }

  return proxies

  // Combined check function for a single proxy
  async function check(proxy) {
    const id = getCacheId({ proxy, gptUrl, geminiUrl })
    let isGptCapable = false;
    let gptLatency = 0;
    let isGeminiCapable = false;
    let geminiLatency = 0;
    let usedCache = false;

    // Check cache again (needed for concurrency chunks)
    if (cacheEnabled) {
        const cached = cache.get(id);
        if (cached && cached.hasOwnProperty('gpt') && cached.hasOwnProperty('gemini')) {
             if (!disableFailedCache || (cached.gpt || cached.gemini)) {
                isGptCapable = cached.gpt;
                gptLatency = cached.gpt_latency || 0;
                isGeminiCapable = cached.gemini;
                geminiLatency = cached.gemini_latency || 0;
                usedCache = true;
                // Log using original name as the name might be modified later
                $.info(`[${proxies[proxy._proxies_index].name}] 使用缓存结果 (GPT: ${isGptCapable}, Gemini: ${isGeminiCapable})`);
             }
        }
    }

    if (!usedCache) {
         const index = internalProxies.indexOf(proxy);
         if (index === -1 || !http_meta_ports[index]) {
             $.error(`[${proxies[proxy._proxies_index].name}] Proxy not found in internal list or missing port`);
             isGptCapable = false;
             isGeminiCapable = false;
         } else {
             const proxyPort = http_meta_ports[index];
             const startedAt = Date.now(); // Capture start time for latency calculation

             // --- Perform GPT and Gemini Checks in Parallel ---
             // Using Promise.allSettled to ensure both promises run regardless of individual success/failure
             const [resGptResult, resGeminiResult] = await Promise.allSettled([
                 // GPT Check Promise
                 http({
                     proxy: `http://${http_meta_host}:${proxyPort}`,
                     method: gptCheckMethod,
                     headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Mobile/15E148 Safari/604.1' },
                     url: gptUrl,
                     timeout: parseFloat($arguments.timeout || 5000)
                 }).catch(err => ({ status: 'rejected', reason: err })), // Catch errors to make Promise.allSettled work

                 // Gemini Check Promise
                 http({
                     proxy: `http://${http_meta_host}:${proxyPort}`,
                     method: geminiCheckMethod,
                     headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', 'Accept': 'application/json' },
                     url: geminiUrl,
                     timeout: parseFloat($arguments.timeout || 5000)
                 }).catch(err => ({ status: 'rejected', reason: err })) // Catch errors
             ]);

             // --- Process GPT Result ---
             if (resGptResult.status === 'fulfilled') {
                 const resGpt = resGptResult.value;
                 const statusGpt = parseInt(resGpt?.status || resGpt?.statusCode || 0);
                 let bodyGpt = String(resGpt?.body ?? resGpt?.rawBody ?? '');
                 let bodyGptJson = null;
                 try { if (bodyGpt.trim().startsWith('{')) bodyGptJson = JSON.parse(bodyGpt); } catch (e) {}
                 const msgGpt = bodyGptJson?.error?.code || bodyGptJson?.error?.error_type || bodyGptJson?.cf_details || bodyGpt.substring(0, 100);

                 isGptCapable = (statusGpt === 403 && !/unsupported_country/i.test(msgGpt));
                 gptLatency = Date.now() - startedAt; // Latency relative to the start of the combined check
                 $.info(`[${proxies[proxy._proxies_index].name}] GPT Check: status=${statusGpt}, capable=${isGptCapable}, latency=${gptLatency}`);
             } else {
                 $.error(`[${proxies[proxy._proxies_index].name}] GPT Check Error: ${resGptResult.reason?.message ?? resGptResult.reason}`);
                 isGptCapable = false;
                 gptLatency = 0;
             }

             // --- Process Gemini Result ---
             if (resGeminiResult.status === 'fulfilled') {
                 const resGemini = resGeminiResult.value;
                 const statusGemini = parseInt(resGemini?.status || resGemini?.statusCode || 0);
                 let bodyGemini = String(resGemini?.body ?? resGemini?.rawBody ?? '');
                 let bodyGeminiJson = null;
                 try { if (bodyGemini.trim().startsWith('{')) bodyGeminiJson = JSON.parse(bodyGemini); } catch (e) {}

                 let isGeminiBlocked = false;
                 let failureReason = '';

                 if (statusGemini === 0) {
                      isGeminiBlocked = true; failureReason = 'Network Error/Timeout';
                 } else if (bodyGeminiJson && bodyGeminiJson.error) {
                     const errorMessage = bodyGeminiJson.error.message || '';
                     const errorStatus = bodyGeminiJson.error.status || '';
                     if (geminiRegionalBlockPatterns.some(pattern => pattern.test(errorMessage) || pattern.test(errorStatus))) {
                          isGeminiBlocked = true; failureReason = 'Regional Block (API Error)';
                      }
                 } else if (bodyGemini.trim().length > 0 && geminiRegionalBlockPatterns.some(pattern => pattern.test(bodyGemini))) {
                      isGeminiBlocked = true; failureReason = 'Regional Block (Body Pattern)';
                 } else if (statusGemini >= 400) {
                      isGeminiBlocked = true; failureReason = `HTTP Status ${statusGemini}`;
                 }

                 isGeminiCapable = !isGeminiBlocked && statusGemini !== 0;
                 geminiLatency = Date.now() - startedAt; // Latency relative to the start of the combined check
                 $.info(`[${proxies[proxy._proxies_index].name}] Gemini Check: status=${statusGemini}, capable=${isGeminiCapable}, reason=${failureReason || 'N/A'}, latency=${geminiLatency}`);

             } else {
                  $.error(`[${proxies[proxy._proxies_index].name}] Gemini Check Error: ${resGeminiResult.reason?.message ?? resGeminiResult.reason}`);
                  isGeminiCapable = false;
                  geminiLatency = 0;
             }


             // --- Cache Result ---
              if (cacheEnabled) {
                   $.info(`[${proxies[proxy._proxies_index].name}] 设置缓存结果 (GPT: ${isGptCapable}, Gemini: ${isGeminiCapable})`);
                   cache.set(id, {
                       gpt: isGptCapable,
                       gpt_latency: gptLatency,
                       gemini: isGeminiCapable,
                       gemini_latency: geminiLatency
                   });
              }
         } // End else (port exists)
    } // End if (!usedCache)


    // --- Apply Tags and Fields based on combined results ---
    // Use the original name before applying the prefix
    const originalName = proxies[proxy._proxies_index].name;
    if (isGptCapable && isGeminiCapable) {
         proxies[proxy._proxies_index].name = `${combinedPrefix}${originalName}`;
         proxies[proxy._proxies_index]._gpt = true;
         proxies[proxy._proxies_index]._gpt_latency = gptLatency;
         proxies[proxy._proxies_index]._gemini = true;
         proxies[proxy._proxies_index]._gemini_latency = geminiLatency;
    } else if (isGptCapable) {
         proxies[proxy._proxies_index].name = `${gptPrefix}${originalName}`;
         proxies[proxy._proxies_index]._gpt = true;
         proxies[proxy._proxies_index]._gpt_latency = gptLatency;
         proxies[proxy._proxies_index]._gemini = false;
         proxies[proxy._proxies_index]._gemini_latency = 0;
    } else if (isGeminiCapable) {
         proxies[proxy._proxies_index].name = `${geminiPrefix}${originalName}`;
         proxies[proxy._proxies_index]._gemini = true;
         proxies[proxy._proxies_index]._gemini_latency = geminiLatency;
         proxies[proxy._proxies_index]._gpt = false;
         proxies[proxy._proxies_index]._gpt_latency = 0;
    } else {
         // Neither is capable, ensure fields are false/0, do not add prefix
         proxies[proxy._proxies_index]._gpt = false;
         proxies[proxy._proxies_index]._gpt_latency = 0;
         proxies[proxy._proxies_index]._gemini = false;
         proxies[proxy._proxies_index]._gemini_latency = 0;
    }

  } // End combined check function


  // 请求 (HTTP utility function, handles retries)
  async function http(opt = {}) {
    const METHOD = opt.method || $arguments.method || 'get';
    const TIMEOUT = parseFloat(opt.timeout || $arguments.timeout || 5000);
    const RETRIES = parseFloat(opt.retries ?? $arguments.retries ?? 1);
    const RETRY_DELAY = parseFloat(opt.retry_delay ?? $arguments.retry_delay ?? 1000);

    let count = 0
    const fn = async () => {
      try {
        const res = await $.http[METHOD](opt);
        // Check for common Cloudflare blockage markers in response
        if (res?.status >= 400 && String(res?.body ?? res?.rawBody ?? '').includes('challenge-form')) {
             throw new Error(`Cloudflare challenge detected (status ${res.status})`);
        }
        return res;
      } catch (e) {
        if (count < RETRIES) {
          count++;
          const delay = RETRY_DELAY * count;
          // Use original name from proxies array for more consistent logging before modification
          const logName = proxies[internalProxies.findIndex(p => p === opt._proxy_ref)]?.name || opt.proxy?.substring(0,30) || 'HTTP';
          $.info(`[${logName}] ${opt.url.substring(0, 30)}... 第 ${count} 次请求失败: ${e.message || e}, 等待 ${delay / 1000}s 后重试`)
          await $.wait(delay)
          return await fn()
        } else {
           // If all retries fail, return a response object with status 0 or re-throw
           if (e.response) {
               return e.response; // Return response object (potentially with status 0 on network errors)
           }
           // If error doesn't have a response property, create a minimal one
           return { status: 0, statusCode: 0, body: null, rawBody: `Error: ${e.message || e}`, error: e };
        }
      }
    }
    // Pass proxy ref to http function for better logging
    const optWithRef = {...opt, _proxy_ref: internalProxies.find(p => `http://${http_meta_host}:${http_meta_ports[internalProxies.indexOf(p)]}` === opt.proxy)};
    return await fn(optWithRef);
  }

  // Cache ID function (includes both URLs to ensure uniqueness)
  function getCacheId({ proxy = {}, gptUrl, geminiUrl }) {
     const proxyDetails = Object.fromEntries(
          Object.entries(proxy).filter(([key]) => !/^(name|collectionName|subName|id|_.*)$/i.test(key))
     );
     const separator = '::';
     return `http-meta:gpt_gemini_combined:${gptUrl}${separator}${geminiUrl}${separator}${JSON.stringify(proxyDetails)}`;
 }


  // executeAsyncTasks utility function (unchanged)
  function executeAsyncTasks(tasks, { wrap, result, concurrency = 1 } = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        let running = 0
        const results = []

        let index = 0

        function executeNextTask() {
          while (index < tasks.length && running < concurrency) {
            const taskIndex = index++
            const currentTask = tasks[taskIndex]
            running++

            currentTask()
              .then(data => {
                if (result) {
                  results[taskIndex] = wrap ? { data } : data
                }
              })
              .catch(error => {
                if (result) {
                  results[taskIndex] = wrap ? { error } : error
                }
              })
              .finally(() => {
                running--
                executeNextTask()
              })
          }

          if (running === 0) {
            return resolve(result ? results : undefined)
          }
        }

        await executeNextTask()
      } catch (e) {
        reject(e)
      }
    })
  }
}
