/* Kodeoff 网页客户端：登录（邮箱/账号码三态自适应）+ 注册（invite 邀请制，仅
 * invite 模式出现）+ 收件箱（文件下载、剪贴板文本查看/复制/删除）+ 登出（吊销
 * 本浏览器设备）。
 *
 * 纪律（红线，逐条有理由）：
 * - 零依赖纯静态：无框架无构建，浏览器直连用户自部署 relay（HTTPS 页 →
 *   http://127.0.0.1:PORT，靠服务端 CORS 放行）。
 * - XSS：剪贴板文本、file_name、account_code、错误 message 等一切服务端可控
 *   字符串一律 Node.textContent / document.createElement 渲染，绝不调用任何
 *   把字符串当 HTML 解析或当作代码执行的接口（API 名不在此复述——本文件是
 *   机器 grep『零命中』断言的对象，注释里出现原词即破防）——剪贴板文本是
 *   任意内容的注入载体，不进 HTML 解析器即无注入面。a.download=file_name 是
 *   属性赋值非 HTML 解析，安全。URL 拼接一律 encodeURIComponent(record_name)。
 * - 4xx 一律不自动重试：服务端 login_guard 是全服持久熔断（20 次失败/600s），
 *   自动重试会烧全服登录名额殃及 native 端；401 分支只清凭据回登录页，不重试。
 * - 网页注册入口仅在 invite 模式出现：发码步持有效邀请码方可消耗全服发信配额
 *   （服务端把邀请码门放在发信配额之前，配额只被持码人消耗）；open 模式网页仍
 *   不做注册/重发验证码/密码重置——原红线对 open 保留：全服发信桶 30/h 共享，
 *   网页重发不节流会烧全服邮件配额（同址冷却 60s 失败不返还）。
 * - cursor 是十进制数字字符串（服务端 str(cursor)），当不透明 token 原样回传，
 *   绝不 parseInt——超过 2^53 的整数在 JS number 里会失真。
 * - since/limit/wait 越界服务端直接 400 不钳制：本页只传 since=<cursor>，
 *   不传 limit/wait（用服务端默认值）。
 */
(function () {
  'use strict';

  var RELAY_KEY = 'kodeoff.web.relay';     // 非敏感偏好：服务器地址
  var SESSION_KEY = 'kodeoff.web.session'; // {device_token,device_id,account_code,base}
  var CLIPBOARD_UTI = 'public.utf8-plain-text';
  var DEVICE_NAME = 'Web Browser';         // 1-128 UTF-8 字节（服务端硬限），固定值
  var serviceConfiguration = window.KodeoffServiceConfiguration || {};
  var DEFAULT_BASE = serviceConfiguration.baseURL || '';
  var PREVIEW_CHARS = 10000;               // 剪贴板 <pre> 截断：mac 端可投递任意大记录，全文塞 DOM 必卡死
  var VERIFY_MAX = 32 * 1024 * 1024;       // ≤32MB 做 SHA-256 校验；>32MB 跳过（大 buffer digest 的内存/CPU/超时代价）
  var BIG_FILE = 64 * 1024 * 1024;         // >64MB 下载前 confirm（见 downloadRow 注释）
  var BATCH = 50;                          // DOM 分批渲染（1000 条上限 ÷ 50 = 20 批封顶）
  var MAX_PAGES = 50;                      // has_more 翻页护栏（limit 默认 200，正常远用不到）
  var UPLOAD_MAX = 100 * 1024 * 1024;      // 网页上传上限：sha256 需把文件整读进 JS 堆算（内存依据见上传段注释）
  var SOURCE_VERSION = 'web-1.0.0';        // 上传登记的 source_version（服务端 1..256 字节非空）
  // 上传登记的扩展名 → UTI 映射（iPhone 收件箱按 uti 分流：图片/视频/其余全落
  // 「文件」栏）。红线：本表永不包含剪贴板文本 UTI（CLIPBOARD_UTI 常量）——
  // .txt 钉死 public.plain-text；若把文件误归成 CLIPBOARD_UTI，收件箱会整卡按
  // 剪贴板文本渲染（buildCard 按 uti 分流），文件打不开。未命中/无扩展名 →
  // public.data（native 同款回退：DeliveryUploadQueue declared typeIdentifier
  // ?? 按扩展名 ?? public.data）。值全部取 iOS UTType 注册表可解析串。
  var UPLOAD_UTI = {
    jpg: 'public.jpeg', jpeg: 'public.jpeg',
    png: 'public.png',
    gif: 'com.compuserve.gif',
    webp: 'org.webmproject.webp',
    bmp: 'com.microsoft.bmp',
    heic: 'public.heic', heif: 'public.heif',
    tif: 'public.tiff', tiff: 'public.tiff',
    mp4: 'public.mpeg-4',
    mov: 'com.apple.quicktime-movie',
    m4v: 'com.apple.m4v-video',
    mp3: 'public.mp3',
    m4a: 'public.mpeg-4-audio',
    wav: 'com.microsoft.waveform-audio',
    aif: 'public.aiff-audio', aiff: 'public.aiff-audio',
    pdf: 'com.adobe.pdf',
    txt: 'public.plain-text',
    md: 'net.daringfireball.markdown', markdown: 'net.daringfireball.markdown',
    json: 'public.json',
    csv: 'public.comma-separated-values-text',
    html: 'public.html', htm: 'public.html',
    zip: 'public.zip-archive',
    doc: 'com.microsoft.word.doc',
    docx: 'org.openxmlformats.wordprocessingml.document',
    xls: 'com.microsoft.excel.xls',
    xlsx: 'org.openxmlformats.spreadsheetml.sheet',
    ppt: 'com.microsoft.powerpoint.ppt',
    pptx: 'org.openxmlformats.presentationml.presentation'
  };

  var MSG = {
    connect: '暂时无法连接，请稍后重试',
    probe: '在线服务暂不可用，请稍后重试',
    revoked: '登录已失效（本浏览器设备已被吊销，或账号密码已被重置），请重新登录',
    fallback: '操作失败，请稍后再试'
  };

  // 已知信封码 → 固定文案（服务端 message 缺失时的兜底；有 message 则原样透传）。
  // 同是 429 的三张面孔必须区分：login_locked/email_locked=登录锁定，rate_limited=IP 洪峰。
  var KNOWN = {
    login_invalid: '账号码或邮箱密码不正确',
    email_login_invalid: '邮箱或密码不正确',
    login_locked: '登录尝试过多，请稍后再试',
    email_locked: '登录尝试过多，请稍后再试',
    rate_limited: '操作过于频繁，请稍后再试',
    email_unavailable: '此服务器未启用邮箱登录',
    unknown_record: '该记录不存在或已被删除',
    unknown_device: '该设备不存在或已被吊销',
    // 注册门控四码（registration_mode 三态审批）：与 Shared RelayErrorMapping
    // （AccountRelay.swift）及服务端信封 message（kodeoff_relay.py REG_MSG_*）
    // 逐字同串——website/check.sh 一致性断言钉死，改文案必须三端同步。
    registration_closed: '服务器未开放注册',
    invite_required: '此服务器注册需要邀请码',
    invite_invalid: '邀请码无效或已过期',
    invite_exhausted: '邀请码已被用完'
  };

  // ---- 状态 ----
  var d = document;
  var viewLogin, viewInbox, relayInput, relayWarn, tabRow, tabEmail, tabCode,
      panelEmail, panelCode, emailInput, passwordInput, codeInput, closedNote,
      loginForm, loginSubmit, loginNotice, accountLine, refreshBtn, logoutBtn,
      inboxStatus, emptyCard, inboxList, moreBtn,
      registerBlock, registerForm, regNotice, regStep1, regStep2, regInviteInput,
      regEmailInput, regSendBtn, regSentNote, regPasswordInput, regPassword2Input,
      regCodeInput, regCreateBtn, regBackBtn,
      uploadBtn, uploadInput;
  var session = null;      // 当前会话（null=未登录）
  var sessionRevision = 0;
  var items = [];          // 投递行全量持有于 JS 数组，DOM 分批渲染
  var rendered = 0;        // 已渲染条数
  var loginMode = 'email'; // 'email' | 'code'
  var emailClosed = false; // 能力探测结论：此服务器未启用邮箱（只渲染账号码表单）
  var regMode = 'unknown'; // 注册门控探测结论：'open'|'invite'|'closed'；unknown=未探/探针失败/地址已改
  var regBusy = false;     // 注册请求进行中（发码/建号共用一把）
  var regCodeSent = false; // 注册两步态：true=验证码已发（展示密码/验证码步）
  var regEmail = '';       // 发码时冻结的邮箱（建号步原样回传，防两步间被改）
  var regInviteCode = '';  // 发码时冻结的邀请码（建号步原样回传；服务端核销在建号事务）
  var busy = false;        // 登录提交进行中
  var loading = false;     // 收件箱加载进行中
  var uploadBusy = false;  // 上传进行中（按钮此刻是「取消上传」入口）
  var uploadXhr = null;    // 上传中的 XHR（登出/被吊销时由 resetInboxState abort）
  var uploadCancel = null; // 上传中的取消动作（abort+删 pending 登记，见 uploadFile）

  // ---- 小工具 ----
  function $(id) { return d.getElementById(id); }

  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, val) { try { window.localStorage.setItem(key, val); } catch (e) {} }
  function lsRemove(key) { try { window.localStorage.removeItem(key); } catch (e) {} }

  function normalizeBase(raw) {
    // 只收 http(s):// 开头；去尾部斜杠防拼接出 //
    var s = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(s)) return null;
    s = s.replace(/\/+$/, '');
    try {
      var u = new URL(s);
      if (!u.host) return null;
      return { base: s, protocol: u.protocol, host: u.hostname };
    } catch (e) { return null; }
  }

  // 本机回环豁免混合内容拦截：127.0.0.1 是 IP 字面量（主用例），localhost 同豁免
  function isLoopback(host) {
    var h = String(host || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  }

  function readJson(res) {
    // 统一按 Content-Type 分流：只有 application/json 才解析，非 JSON 一律 null
    var ct = res.headers.get('Content-Type') || '';
    if (ct.indexOf('application/json') === -1) return Promise.resolve(null);
    return res.json().then(
      function (j) { return (j && typeof j === 'object') ? j : null; },
      function () { return null; });
  }

  // 错误文案三层兜底：
  // 1) JSON 信封且码在表 → 原样透传服务端 message（缺失用固定文案）；
  // 2) JSON 信封但码不在表（500 internal_error / 502 email_send_failed 等）→
  //    『服务器返回错误』前缀 + message，message 缺失则通用文案；
  // 3) 非 JSON / 网络断（fetch reject，含 CORS 未放行被浏览器拦）→ 连接失败。
  function messageFor(env) {
    if (env && typeof env.error === 'string') {
      if (Object.prototype.hasOwnProperty.call(KNOWN, env.error)) {
        return (typeof env.message === 'string' && env.message) ? env.message : KNOWN[env.error];
      }
      if (typeof env.message === 'string' && env.message) return '服务器返回错误：' + env.message;
      return MSG.fallback;
    }
    return MSG.connect;
  }

  function fmtBytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return '未知大小';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (Math.round(v * 10) / 10) + ' ' + u[i];
  }

  function fmtTime(ms) {
    // created_at 是 unix 毫秒整数（契约 §2 通用约定）
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
  }

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  // 上传登记的 uti：扩展名先归一小写再查表；未命中/无扩展名 → public.data
  function utiForName(name) {
    var m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    if (!m) return 'public.data';
    var hit = UPLOAD_UTI[m[1].toLowerCase()];
    return hit || 'public.data';
  }

  // 上传登记的 record_name：本地生成 v4 UUID（36 位 hex/连字符，恰为服务端
  // RECORD_NAME_RE 字符集）。randomUUID 仅安全上下文可用，而上传已硬性要求
  // 安全上下文（sha256 的 crypto.subtle 同源约束）；getRandomValues 无该限制，
  // 手拼 8-4-4-4-12 两种环境行为一致。
  function newRecordName() {
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = bytesToHex(b);
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16)
      + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
  }

  // ---- 视图切换（无路由：纯 DOM display 切换）----
  function showLoginView() { viewLogin.hidden = false; viewInbox.hidden = true; }
  function showInboxView() { viewLogin.hidden = true; viewInbox.hidden = false; }

  function showLoginNotice(msg) { loginNotice.textContent = msg; loginNotice.hidden = false; }
  function hideLoginNotice() { loginNotice.textContent = ''; loginNotice.hidden = true; }

  function setStatus(msg, isError) {
    inboxStatus.textContent = msg || '';
    inboxStatus.className = isError ? 'status is-error' : 'status';
  }

  // ---- 401 全局处理（对齐 native 端 SendChannelService.swift『吊销/401 清凭据』惯例）----
  // 触发场景（如实）：用户在 native 设备管理删除「Web Browser」设备，或邮箱重置
  // 密码吊销全部设备 token。没有此分支时，收件箱所有按钮会持续报错且永远回不到
  // 登录页。动作：清 session → 回登录视图 → 表单上方提示；绝不自动重试（防循环）。
  function handleRevoked() {
    if (!session) return; // 幂等：并行请求的第二个 401 直接短路
    session = null;
    sessionRevision += 1;
    lsRemove(SESSION_KEY);
    resetInboxState();
    showLoginView();
    showLoginNotice(MSG.revoked);
  }

  function resetInboxState() {
    loading = false;
    refreshBtn.disabled = false;
    items = [];
    rendered = 0;
    inboxList.textContent = ''; // 清空子节点（卡片闭包持有的 blob/text 一并释放）
    moreBtn.hidden = true;
    emptyCard.hidden = true;
    accountLine.textContent = '';
    // 上传复位（传一半即登出/被吊销：按钮绝不残留「取消上传」态）。两处调方
    // （handleRevoked/onLogout）都先递增 sessionRevision 再进这里，abort 触发的
    // XHR 回调经 revision 守卫一律静默，不会改写任何状态。
    if (uploadXhr) { try { uploadXhr.abort(); } catch (e) {} }
    uploadBusy = false;
    uploadBtn.textContent = '上传文件';
  }

  // ---- 统一 fetch 包装：所有带 token 的请求必经此处 ----
  // 返回 Promise：
  //   null               = 401 已被全局接管（调用方直接 return，不重试）；
  //   {networkError:true}= 断网/CORS 被拦（fetch reject）；
  //   {response:Response}= 其余（调用方按 response.ok + Content-Type 自行分流）。
  // 绝不在包装里读 body——payload 下载的 body 属于调用方（Response body 只能读一次）。
  function api(path, opts) {
    opts = opts || {};
    var owner = session;
    if (!owner) return Promise.resolve(null);
    function current() { return session === owner; }
    var headers = {};
    var body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    if (opts.auth) headers['Authorization'] = 'Bearer ' + owner.device_token;
    return fetch(owner.base + path, { method: opts.method || 'GET', headers: headers, body: body })
      .then(function (res) {
        if (!current()) return null;
        if (res.status !== 401) return { response: res, current: current };
        // 本页只调设备域端点，其唯一 401 生产者是服务端 _auth 的 device_revoked
        // 信封；读 body 只为核实。任何 401 都按吊销处理（诚实且保守）。
        return readJson(res).then(function (j) {
          if (!current()) return null;
          if (!j || j.error === 'device_revoked') { handleRevoked(); return null; }
          return { response: res, envelope: j, current: current };
        });
      })
      .catch(function () { return current() ? { networkError: true, current: current } : null; });
  }

  // ---- 登录视图 ----
  function updateRelayWarn() {
    // 非 127.0.0.1 的明文 http 地址：HTTPS 托管页会被浏览器混合内容拦截
    var v = relayInput.value.trim();
    var warn = false;
    if (/^http:\/\//i.test(v)) {
      var n = normalizeBase(v);
      if (n && !isLoopback(n.host)) warn = true;
    }
    relayWarn.hidden = !warn;
  }

  function setMode(mode) {
    loginMode = mode;
    tabEmail.setAttribute('aria-selected', String(mode === 'email'));
    tabCode.setAttribute('aria-selected', String(mode === 'code'));
    panelEmail.hidden = mode !== 'email';
    panelCode.hidden = mode !== 'code';
  }

  function applyLoginMode() {
    // 能力探测冻结三态：email_enabled=false → 只渲染账号码表单+提示（503 面
    // 由能力位预判，不打实际请求）；true → 双 tab 默认邮箱
    if (emailClosed) {
      tabRow.hidden = true;
      panelEmail.hidden = true;
      panelCode.hidden = false;
      closedNote.hidden = false;
    } else {
      tabRow.hidden = false;
      closedNote.hidden = true;
      setMode(loginMode);
    }
  }

  // registration_mode 解析：契约值 open/invite/closed；缺键（旧服务端无此键）/
  // 非字符串/未知值一律回落 open——open 与 closed 在网页同为不显示注册区块，回落
  // open 不放大任何面，只是绝不让零信息（旧服务端）解锁新入口。
  function parseRegistrationMode(v) {
    if (v === 'open' || v === 'invite' || v === 'closed') return v;
    return 'open';
  }

  // 能力探测：GET /health。地址错/未启动/旧版服务端（无 CORS，fetch 被浏览器
  // 拦成 TypeError）同面不猜——统一『无法连接服务器』。email_enabled 严格检查
  // 零改动；registration_mode 缺键回落 open（显示策略见 applyRegistrationVisibility）。
  function probeHealth(base) {
    return fetch(base + '/health')
      .then(function (res) {
        if (!res.ok) return { fail: true };
        return readJson(res).then(function (j) {
          if (!j || j.status !== 'ok' || typeof j.email_enabled !== 'boolean') return { fail: true };
          return { fail: false, email: j.email_enabled, registration: parseRegistrationMode(j.registration_mode) };
        });
      })
      .catch(function () { return { fail: true }; });
  }

  function onLoginSubmit(ev) {
    ev.preventDefault();
    if (busy) return;
    hideLoginNotice();

    var n = normalizeBase(relayInput.value || DEFAULT_BASE); // 空值回落默认本机回环
    if (!n) { showLoginNotice('服务器地址需以 http:// 或 https:// 开头'); return; }
    var base = n.base;

    // 客户端空值预检：每次失败登录都计入服务端全服熔断（login_guard 20 次/600s），
    // 无谓的 400 既是浪费也是在烧全服名额
    var useEmail = !emailClosed && loginMode === 'email';
    var email = emailInput.value.trim();
    var password = passwordInput.value;
    var code = codeInput.value.trim();
    if (useEmail) {
      if (!email) { showLoginNotice('请输入邮箱'); return; }
      if (email.indexOf('@') < 1) { showLoginNotice('请输入有效的邮箱地址'); return; }
      if (!password) { showLoginNotice('请输入密码'); return; }
    } else if (!code) {
      showLoginNotice('请输入账号码');
      return;
    }

    busy = true;
    var revision = sessionRevision;
    loginSubmit.disabled = true;
    loginSubmit.textContent = '登录中…';

    function done(msg) {
      if (revision !== sessionRevision) return;
      busy = false;
      loginSubmit.disabled = false;
      loginSubmit.textContent = '登录';
      if (msg) showLoginNotice(msg);
    }

    probeHealth(base).then(function (p) {
      if (revision !== sessionRevision) return null;
      if (p.fail) { done(MSG.probe); return null; }
      if (!p.email) {
        emailClosed = true;
        applyLoginMode(); // 切到只渲染账号码表单
        if (useEmail) { done('此服务器未启用邮箱登录，请改用账号码登录'); return null; }
        // 用户本就在账号码页签：继续走账号码登录
      }
      regMode = p.registration;      // 登录探针兼作注册模式刷新（invite → 注册区块显示）
      applyRegistrationVisibility();
      var path = useEmail ? '/v1/email/login' : '/v1/login';
      var payload = useEmail
        ? { email: email, password: password, device_name: DEVICE_NAME }
        : { account_code: code, device_name: DEVICE_NAME };
      return fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return readJson(res).then(function (j) { return { res: res, j: j }; });
      });
    }).then(function (step) {
      if (!step || revision !== sessionRevision) return;
      if (step.res.ok && step.j && typeof step.j.device_token === 'string' && step.j.device_token) {
        // 201 三件套入会话（localStorage 单键：收件箱低频查看、跨标签页/重启保持；
        // XSS 缓解=零依赖+textContent 纪律+登出吊销兜底）
        session = {
          device_token: step.j.device_token,
          device_id: String(step.j.device_id || ''),
          account_code: String(step.j.account_code || ''),
          base: base
        };
        sessionRevision += 1;
        lsSet(SESSION_KEY, JSON.stringify(session));
        lsSet(RELAY_KEY, base); // 非敏感偏好：下次免输
        passwordInput.value = '';
        codeInput.value = '';
        hideLoginNotice();
        showInboxView();
        loadAccount();
        loadInbox();
        busy = false;
        loginSubmit.disabled = false;
        loginSubmit.textContent = '登录';
        return;
      }
      done(messageFor(step.j)); // 非 JSON（j=null）→ 连接失败文案
    }).catch(function () {
      done(MSG.connect); // 登录请求网络断/被拦
    });
  }

  // ---- 注册（invite 邀请制，仅 invite 模式出现）----
  // 显示策略（裁决：网页注册入口只在 invite 模式出现）：open 模式网页无注册——
  // 无门控的发码步会烧全服发信配额（头注红线）；invite 下服务端把邀请码门放在
  // 发信配额之前，配额只被持码人消耗，网页才安全开放。closed/unknown（未探/
  // 探针失败/地址已改）一律隐藏——closed 无需专门面（本无入口）；探针失败=网页
  // 无注册路，静态页无重探 UI，如实降级可接受，登录不受影响。emailClosed
  // （email_enabled=false）时邮箱注册链路不存在，同隐藏。
  function applyRegistrationVisibility() {
    var show = regMode === 'invite' && !emailClosed;
    registerBlock.hidden = !show;
    if (!show) resetRegistration(); // 隐藏即弃置：邀请码/密码不残留 DOM
  }

  function resetRegistration() {
    regBusy = false;
    regCodeSent = false;
    regEmail = '';
    regInviteCode = '';
    regInviteInput.value = '';
    regEmailInput.value = '';
    regPasswordInput.value = '';
    regPassword2Input.value = '';
    regCodeInput.value = '';
    regSendBtn.disabled = false;
    regSendBtn.textContent = '发送验证码';
    regCreateBtn.disabled = false;
    regCreateBtn.textContent = '创建账号';
    regStep1.hidden = false;
    regStep2.hidden = true;
    regSentNote.textContent = '';
    regNotice.textContent = '';
    regNotice.hidden = true;
  }

  function showRegNotice(msg) { regNotice.textContent = msg; regNotice.hidden = false; }
  function hideRegNotice() { regNotice.textContent = ''; regNotice.hidden = true; }

  function setRegStep(codeSent) {
    regCodeSent = codeSent;
    regStep1.hidden = codeSent;
    regStep2.hidden = !codeSent;
  }

  function onRegisterSubmit(ev) {
    ev.preventDefault();
    if (regCodeSent) onRegCreate(); else onRegSend();
  }

  // 第 1 步：POST /v1/email/register/code {email, invite_code} → 202。邀请码门在
  // 服务端发信配额消费之前：无码/错码连发信桶都烧不到，网页发起才安全（头注红线
  // 的收窄依据）。202 是反枚举面：邮箱已被注册时服务端发中性通知而非验证码，响应
  // 零差异——已发送提示如实措辞不区分。email/invite_code 两步间冻结，建号步原样
  // 回传（发码步只校验不消费，核销在 /v1/email/register 建号事务内）。
  function onRegSend() {
    if (regBusy) return;
    hideRegNotice();
    var n = normalizeBase(relayInput.value || DEFAULT_BASE);
    if (!n) { showRegNotice('服务器地址需以 http:// 或 https:// 开头'); return; }
    var invite = regInviteInput.value.trim();
    var email = regEmailInput.value.trim();
    if (!invite) { showRegNotice('请输入邀请码'); return; }
    if (!email) { showRegNotice('请输入邮箱'); return; }
    if (email.indexOf('@') < 1) { showRegNotice('请输入有效的邮箱地址'); return; }

    regBusy = true;
    var revision = sessionRevision;
    regSendBtn.disabled = true;
    regSendBtn.textContent = '发送中…';

    function done(msg) {
      if (revision !== sessionRevision) return;
      regBusy = false;
      regSendBtn.disabled = false;
      regSendBtn.textContent = '发送验证码';
      if (msg) showRegNotice(msg);
    }

    fetch(n.base + '/v1/email/register/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, invite_code: invite })
    }).then(function (res) {
      return readJson(res).then(function (j) { return { res: res, j: j }; });
    }).then(function (step) {
      if (!step || revision !== sessionRevision) return;
      if (step.res.ok) {
        regEmail = email;
        regInviteCode = invite;
        setRegStep(true);
        regBusy = false;
        regSendBtn.disabled = false;
        regSendBtn.textContent = '发送验证码';
        // 服务端可控字符串（邮箱）经 textContent 渲染，无 HTML 解析（XSS 红线）
        regSentNote.textContent = '若该邮箱可用于注册，验证码已发送至 ' + email
          + '（10 分钟内有效）；没收到请检查垃圾邮件。';
        return;
      }
      done(messageFor(step.j)); // 四门控码经 KNOWN 表冻结文案兜底
    }).catch(function () {
      done(MSG.connect);
    });
  }

  // 第 2 步：POST /v1/email/register {email, password, code, device_name,
  // invite_code} → 201 三件套入 session（复用 onLoginSubmit 的收尾形态）。
  // 密码一致性/验证码形态先本地预检：服务端表单校验在邮箱验证码消费之前，
  // 不烧码，但少打一次无谓请求总是对的。device_name 用 DEVICE_NAME。
  function onRegCreate() {
    if (regBusy) return;
    hideRegNotice();
    var n = normalizeBase(relayInput.value || DEFAULT_BASE);
    if (!n) { showRegNotice('服务器地址需以 http:// 或 https:// 开头'); return; }
    if (!regEmail || !regInviteCode) { setRegStep(false); showRegNotice('请先发送验证码'); return; }
    var password = regPasswordInput.value;
    var password2 = regPassword2Input.value;
    var vcode = regCodeInput.value.trim();
    if (!password || !password2) { showRegNotice('请输入密码'); return; }
    if (password !== password2) { showRegNotice('两次输入的密码不一致'); return; }
    if (password.length < 8) { showRegNotice('密码至少 8 个字符'); return; }
    if (!/^[0-9]{6}$/.test(vcode)) { showRegNotice('请输入 6 位数字验证码'); return; }

    regBusy = true;
    var revision = sessionRevision;
    regCreateBtn.disabled = true;
    regCreateBtn.textContent = '创建中…';

    function done(msg) {
      if (revision !== sessionRevision) return;
      regBusy = false;
      regCreateBtn.disabled = false;
      regCreateBtn.textContent = '创建账号';
      if (msg) showRegNotice(msg);
    }

    fetch(n.base + '/v1/email/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: regEmail,
        password: password,
        code: vcode,
        device_name: DEVICE_NAME,
        invite_code: regInviteCode
      })
    }).then(function (res) {
      return readJson(res).then(function (j) { return { res: res, j: j }; });
    }).then(function (step) {
      if (!step || revision !== sessionRevision) return;
      if (step.res.ok && step.j && typeof step.j.device_token === 'string' && step.j.device_token) {
        // 201 三件套入 session（形态同 onLoginSubmit 收尾：localStorage 单键、
        // XSS 缓解同源）；随后弃置注册态——邀请码已核销，输入框即刻清空
        session = {
          device_token: step.j.device_token,
          device_id: String(step.j.device_id || ''),
          account_code: String(step.j.account_code || ''),
          base: n.base
        };
        sessionRevision += 1;
        lsSet(SESSION_KEY, JSON.stringify(session));
        lsSet(RELAY_KEY, n.base); // 非敏感偏好：下次免输
        resetRegistration();
        hideLoginNotice();
        showInboxView();
        loadAccount();
        loadInbox();
        return;
      }
      done(messageFor(step.j)); // invite_invalid/exhausted 等门控面同出此处
    }).catch(function () {
      done(MSG.connect);
    });
  }

  function onRegBack() {
    // 返回登录：弃置密码/验证码（已发验证码作废不返还——服务端 TTL 收口），
    // 邀请码/邮箱保留供修正重发；焦点交回登录邮箱框
    setRegStep(false);
    regPasswordInput.value = '';
    regPassword2Input.value = '';
    regCodeInput.value = '';
    regSentNote.textContent = '';
    hideRegNotice();
    emailInput.focus();
  }

  // ---- 收件箱 ----
  function loadAccount() {
    api('/v1/account', { auth: true }).then(function (r) {
      if (r === null) return;
      if (r.networkError) { accountLine.textContent = MSG.connect; return; }
      readJson(r.response).then(function (j) {
        if (!r.current()) return;
        if (!(r.response.ok && j && typeof j.account_code === 'string')) {
          accountLine.textContent = messageFor(j);
          return;
        }
        // account_code/email 是服务端可控字符串——textContent 渲染，无 HTML 解析
        var parts = ['账号码 ' + j.account_code];
        if (typeof j.email === 'string' && j.email) parts.push(j.email);
        if (j.storage) {
          parts.push('存储 ' + fmtBytes(j.storage.used_bytes) + ' / ' + fmtBytes(j.storage.quota_bytes)
            + ' · ' + j.storage.delivery_count + ' 条投递');
        }
        accountLine.textContent = parts.join(' · ');
      });
    });
  }

  function loadInbox() {
    if (!session || loading) return;
    var owner = session;
    loading = true;
    refreshBtn.disabled = true;
    setStatus('正在加载收件箱…', false);

    var rows = [];
    var since = '0'; // 十进制数字字符串，不透明 token 原样回传（绝不 parseInt）
    var pages = 0;

    function finishLoad() {
      if (session !== owner) return;
      loading = false;
      refreshBtn.disabled = false;
    }
    function failLoad(msg) {
      if (session !== owner) return;
      finishLoad();
      setStatus(msg, true);
    }
    function step() {
      if (session !== owner) return;
      pages += 1;
      if (pages > MAX_PAGES) { failLoad('收件箱分页异常，请刷新重试'); return; }
      api('/v1/deliveries?since=' + encodeURIComponent(since), { auth: true }).then(function (r) {
        if (r === null) { finishLoad(); return; } // 401 已接管
        if (r.networkError) { failLoad(MSG.connect); return; }
        readJson(r.response).then(function (j) {
          if (!r.current()) return;
          if (!(r.response.ok && j && typeof j.has_more === 'boolean')) { failLoad(messageFor(j)); return; }
          // 首拉 since=0：deliveries 即当前在册集合；tombstones 是增量拉取的删除
          // 回执，全量首拉对账用不上（不在册的记录根本不会出现在 deliveries 里）。
          var ds = j.deliveries;
          if (ds) {
            for (var i = 0; i < ds.length; i++) {
              // 行恒 8 字段：record_name/file_name/uti/file_size/sha256/
              // source_device/source_version/created_at
              if (ds[i] && typeof ds[i].record_name === 'string') rows.push(ds[i]);
            }
          }
          if (j.has_more && typeof j.cursor === 'string' && j.cursor) {
            since = j.cursor; // 续拉游标（服务端 str(cursor) 十进制字符串）
            step();
            return;
          }
          items = rows.slice().reverse(); // 账本升序 → 最新在前展示
          rendered = 0;
          inboxList.textContent = ''; // 刷新重置到第一批
          finishLoad();
          if (!items.length) {
            // 空态（冻结文案）
            emptyCard.hidden = false;
            moreBtn.hidden = true;
            setStatus('', false);
          } else {
            emptyCard.hidden = true;
            renderBatch();
            setStatus('', false);
          }
        });
      });
    }
    step();
  }

  function updateMoreBtn() {
    var left = items.length - rendered;
    if (left > 0) {
      moreBtn.hidden = false;
      moreBtn.textContent = '显示更多（剩余 ' + left + ' 条）';
    } else {
      moreBtn.hidden = true;
    }
  }

  // 体量护栏：1000 条上限 × 8 字段元数据由 JS 数组全量持有（≈200KB 无碍），
  // DOM 每批 50 条以 DocumentFragment 插入——防上千卡片一次性渲染卡死。
  function renderBatch() {
    var frag = d.createDocumentFragment();
    var end = Math.min(rendered + BATCH, items.length);
    for (; rendered < end; rendered++) frag.appendChild(buildCard(items[rendered]));
    inboxList.appendChild(frag);
    updateMoreBtn();
  }

  // ---- payload 拉取（fetch 带 Authorization 头无法用 a[href] 直链流式下载，
  //      整体载入内存是本方案已知代价；512MB 服务端上限内不硬拒绝）----
  function fetchBlob(row, state) {
    var owner = session;
    if (!owner) return Promise.resolve(null);
    // state 提供则缓存（剪贴板卡在查看/复制/下载间复用）；文件卡传 null 不缓存，
    // 下载完即让 blob 可被 GC。
    if (state && state.blob) return Promise.resolve({ blob: state.blob });
    return api('/v1/deliveries/' + encodeURIComponent(row.record_name) + '/payload', { auth: true })
      .then(function (r) {
        if (r === null) return null; // 401 已接管
        if (r.networkError) throw new Error(MSG.connect);
        if (!r.response.ok) {
          return readJson(r.response).then(function (j) {
            if (!r.current()) return null;
            throw new Error(messageFor(j));
          });
        }
        return r.response.blob().then(function (blob) {
          if (!r.current()) return null;
          if (state) state.blob = blob;
          return { blob: blob };
        });
      });
  }

  function fetchText(row, state) {
    var owner = session;
    if (!owner) return Promise.resolve(null);
    if (state && state.text !== null) return Promise.resolve({ blob: state.blob, text: state.text });
    return fetchBlob(row, state).then(function (got) {
      if (got === null) return null;
      return got.blob.text().then(function (text) {
        if (session !== owner) return null;
        if (state) state.text = text;
        return { blob: got.blob, text: text };
      });
    });
  }

  // SHA-256 校验：≤32MB 时做；digest 吃下载已持有的同一 buffer
  // （blob.arrayBuffer() 是把 blob 内部数据暴露成 ArrayBuffer，不额外复制第二份
  // 内存）。>32MB 跳过（大 buffer digest 的内存/CPU 开销与超时风险）。
  // crypto.subtle 仅安全上下文（HTTPS/localhost）存在——拿不到就跳过校验，不阻断下载。
  function verifySha(row, blob) {
    if (typeof row.file_size !== 'number' || row.file_size > VERIFY_MAX) return Promise.resolve(true);
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') return Promise.resolve(true);
    return blob.arrayBuffer().then(function (buf) {
      return subtle.digest('SHA-256', buf).then(function (dig) {
        var hex = bytesToHex(new Uint8Array(dig));
        return !row.sha256 || hex === String(row.sha256).toLowerCase();
      });
    }).catch(function () { return true; }); // 校验基础设施故障不拦下载
  }

  function saveBlob(row, blob) {
    var url = URL.createObjectURL(blob);
    var a = d.createElement('a');
    a.href = url;
    a.download = row.file_name || 'kodeoff-file'; // 属性赋值非 HTML 解析，安全
    d.body.appendChild(a);
    a.click();
    d.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function downloadRow(row, state, isText) {
    var owner = session;
    if (!owner) return;
    // 大文件护栏：>64MB confirm——浏览器需要把文件整体载入内存后才能保存，
    // 大文件建议在 Mac 或手机客户端下载；用户确认自担
    if (typeof row.file_size === 'number' && row.file_size > BIG_FILE) {
      if (!window.confirm('文件较大（' + fmtBytes(row.file_size) + '），浏览器需要把它整体载入内存后才能保存；大文件建议在 Mac 或手机客户端下载。继续吗？')) return;
    }
    fetchBlob(row, isText ? state : null).then(function (got) {
      if (got === null || session !== owner) return;
      return verifySha(row, got.blob).then(function (ok) {
        if (session !== owner) return;
        if (!ok) { setStatus('下载内容校验失败（SHA-256 不匹配），请重试', true); return; }
        saveBlob(row, got.blob);
        setStatus('', false);
      });
    }).catch(function (err) {
      if (session !== owner) return;
      setStatus(err && err.message ? err.message : MSG.connect, true);
    });
  }

  // ---- 剪贴板文本卡 ----
  function toggleText(row, state, pre, truncNote, btn) {
    var owner = session;
    if (!owner) return;
    if (state.open) {
      state.open = false;
      pre.hidden = true;
      truncNote.hidden = true;
      btn.textContent = '查看';
      return;
    }
    if (state.loading) return;
    state.loading = true;
    btn.disabled = true;
    fetchText(row, state).then(function (got) {
      if (session !== owner) return;
      state.loading = false;
      btn.disabled = false;
      if (got === null) return; // 401 已接管
      var text = got.text || '';
      // <pre> 只渲染前 10000 字符；完整内容只走复制/下载（不做『展开全部』——
      // 几十 MB 全文塞 DOM 必卡死）。textContent 渲染，无 HTML 解析。
      pre.textContent = text.slice(0, PREVIEW_CHARS);
      if (text.length > PREVIEW_CHARS) {
        truncNote.textContent = '文本较长（共 ' + text.length + ' 字符），已截断显示；复制可获取完整内容';
        truncNote.hidden = false;
      } else {
        truncNote.hidden = true;
      }
      pre.hidden = false;
      state.open = true;
      btn.textContent = '收起';
    }).catch(function (err) {
      if (session !== owner) return;
      state.loading = false;
      btn.disabled = false;
      setStatus(err && err.message ? err.message : MSG.connect, true);
    });
  }

  function legacyCopy(text) {
    // 已废弃的 execCommand 同步兜底：页面失焦/clipboard 权限被拒时
    // navigator.clipboard.writeText 会 reject，这一层在实测里仍然实用
    var ta = d.createElement('textarea');
    ta.value = text; // 属性赋值，非 HTML 解析
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    d.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = d.execCommand('copy'); } catch (e) { ok = false; }
    d.body.removeChild(ta);
    return ok;
  }

  function copyText(row, state, pre, truncNote, viewBtn) {
    var owner = session;
    if (!owner) return;
    // 复制三层兜底：1) navigator.clipboard（完整 blob.text()，不经过 DOM 截断）
    // 2) execCommand 同步兜底 3) 提示手动复制并自动聚焦 <pre> 全选
    fetchText(row, state).then(function (got) {
      if (got === null || session !== owner) return;
      var text = got.text || '';
      var viaApi = (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; })
        : Promise.resolve(false);
      return viaApi.then(function (ok) {
        if (session !== owner) return;
        if (ok) { setStatus('已复制到剪贴板。', false); return; }
        if (legacyCopy(text)) { setStatus('已复制到剪贴板。', false); return; }
        // 第三层：保证 <pre> 已展开，再聚焦全选给手动 ⌘C/Ctrl+C
        setStatus('自动复制失败，请手动选中文本复制（⌘C/Ctrl+C）', true);
        if (!state.open) {
          state.open = true;
          pre.textContent = text.slice(0, PREVIEW_CHARS);
          if (text.length > PREVIEW_CHARS) {
            truncNote.textContent = '文本较长（共 ' + text.length + ' 字符），已截断显示；复制可获取完整内容';
            truncNote.hidden = false;
          }
          pre.hidden = false;
          viewBtn.textContent = '收起';
        }
        pre.focus();
        var range = d.createRange();
        range.selectNodeContents(pre);
        var sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      });
    }).catch(function (err) {
      if (session !== owner) return;
      setStatus(err && err.message ? err.message : MSG.connect, true);
    });
  }

  // ---- 删除 ----
  function deleteRow(row, card) {
    if (!window.confirm('删除「' + (row.file_name || '该记录') + '」？此操作会从服务器移除，不可撤销。')) return;
    api('/v1/deliveries/' + encodeURIComponent(row.record_name), { method: 'DELETE', auth: true })
      .then(function (r) {
        if (r === null) return; // 401 已接管
        if (r.networkError) { setStatus(MSG.connect, true); return; }
        if (r.response.ok || r.response.status === 404) {
          // 404=别端已删，同面处理：本地移除即可
          if (card.parentNode) card.parentNode.removeChild(card);
          var idx = items.indexOf(row);
          if (idx >= 0) items.splice(idx, 1);
          if (!items.length) emptyCard.hidden = false;
          updateMoreBtn();
          return;
        }
        readJson(r.response).then(function (j) { if (r.current()) setStatus(messageFor(j), true); });
      });
  }

  // ---- 上传（浏览器 → 本账号收件箱；同账号 iPhone「文件」栏可见）----
  // 与下载镜像的第二条投递链路：① 本地预检（零网络）→ ② file.arrayBuffer()
  // + crypto.subtle 整读算 SHA-256——服务端 PUT 恒时比对，客户端必须自己算，
  // 绝不沿用下载侧 subtle 缺失即跳过校验的惯例：那条护栏对下载是宽容，对上传
  // 等于 422 → ③ POST /v1/deliveries 登记（走 api()：JSON 形态 + 401 全局接管，
  // 绝不重试——头注红线）→ ④ PUT payload（裸 XHR：api() 会把 body 强转 JSON，
  // 原始字节流只能直连，形态照 onLogout；send(File) 由浏览器自动带
  // Content-Length，不触发服务端 411；无总超时——浏览器断连与服务端清 .part
  // 兜底，行留 pending 可整重传或约 1 小时后自动清扫）。
  // 上限 100MiB 的内存依据：digest 需要约等于文件大小的 ArrayBuffer 整读进
  // JS 堆（服务端默认上限 512MiB 整读在旧机型是内存事故面，取紧安全系数≥3，
  // 与下载侧护栏同数量级）；PUT body 传 File 本体，浏览器流式读盘不占 JS 堆。
  function uploadFile(file) {
    if (uploadBusy || !session) return;
    var owner = session;
    // ---- ① 本地预检（零网络；>100MiB 不发起任何请求，无磁盘实占无上行）----
    if (typeof file.size !== 'number' || file.size < 0) { setStatus('无法读取文件大小，请重试', true); return; }
    if (file.size > UPLOAD_MAX) {
      setStatus('文件超过网页上传上限（100 MB）。更大的文件请在 Kodeoff App 中发送。', true);
      return;
    }
    if (typeof file.arrayBuffer !== 'function') {
      setStatus('当前浏览器版本过旧，无法读取文件内容，请更换现代浏览器后重试', true);
      return;
    }
    var name = String(file.name || '');
    var nameBytes = -1;
    try { nameBytes = new TextEncoder().encode(name).length; } catch (e) { nameBytes = -1; }
    if (nameBytes < 0) { setStatus('无法读取文件名，请重命名后重试', true); return; }
    if (nameBytes > 1024) { setStatus('文件名过长（上限 1024 字节），请重命名后重试', true); return; }
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      setStatus('当前页面不是 HTTPS，浏览器未提供加密模块，无法计算文件校验值；请通过 HTTPS 访问本页再上传', true);
      return;
    }

    // owner + revision 双捕获（onLogout 同款最严形态）：owner 供 PUT 直连取
    // base/token，revision 供一切异步回调守卫——会话建立/清除必递增，迟到回调
    // 一律静默（复位已由 resetInboxState 收口，此处不再改写状态）
    uploadBusy = true;
    var revision = sessionRevision;
    uploadBtn.textContent = '取消上传';
    var recordName = newRecordName();
    var cancelled = false;

    function endUpload() {
      uploadBusy = false;
      uploadXhr = null;
      uploadCancel = null;
      if (revision === sessionRevision) uploadBtn.textContent = '上传文件';
    }

    // 取消：abort 在传请求 + 尝试 DELETE 已登记的 pending 行（即刻腾出配额；
    // pending 可删，失败/断网不阻塞——登记约 1 小时后服务端自动清扫）
    uploadCancel = function () {
      if (cancelled) return;
      cancelled = true;
      if (uploadXhr) { try { uploadXhr.abort(); } catch (e) {} }
      endUpload();
      setStatus('已取消上传。', false);
      api('/v1/deliveries/' + encodeURIComponent(recordName), { method: 'DELETE', auth: true }).then(function (r) {
        if (revision !== sessionRevision) return;
        if (r === null) return; // 401 已全局接管
        if (r.networkError || (!r.response.ok && r.response.status !== 404)) {
          setStatus('已取消上传。未传完的部分将在约 1 小时后自动释放。', false);
          return;
        }
        loadAccount(); // 删除成功：存储用量/条数即刻回落
      });
    };

    // ---- ② 计算 SHA-256（single-pass：哈希阶段无字节进度，不假装进度条）----
    setStatus(file.size > UPLOAD_MAX / 2
      ? '正在计算文件校验值…（大文件可能需要十几秒）'
      : '正在计算文件校验值…', false);
    file.arrayBuffer().then(function (buf) {
      if (cancelled || revision !== sessionRevision) return null;
      return subtle.digest('SHA-256', buf).then(function (dig) {
        if (cancelled || revision !== sessionRevision) return;
        startRegister(bytesToHex(new Uint8Array(dig)));
      });
    }).catch(function () {
      if (cancelled || revision !== sessionRevision) return;
      endUpload();
      setStatus('无法读取文件内容，请重试', true);
    });

    // ---- ③ 登记（走 api()：401 由全局分支接管回登录页）----
    function startRegister(sha) {
      setStatus('正在登记…', false);
      api('/v1/deliveries', {
        method: 'POST',
        auth: true,
        body: {
          record_name: recordName,
          file_name: name,
          uti: utiForName(name),
          file_size: file.size,
          sha256: sha,
          source_device: DEVICE_NAME,
          source_version: SOURCE_VERSION
        }
      }).then(function (r) {
        if (cancelled) return;
        if (r === null) { endUpload(); return; } // 401 已接管（resetInboxState 已复位）
        if (r.networkError) { endUpload(); setStatus(MSG.connect, true); return; }
        if (!r.response.ok) {
          return readJson(r.response).then(function (j) {
            if (cancelled || !r.current()) return;
            endUpload();
            setStatus(messageFor(j), true); // 413/507/409 等信封 message 透传
          });
        }
        startPut();
      });
    }

    // ---- ④ 传字节（裸 XHR，onLogout 直连形态）----
    function startPut() {
      if (cancelled || revision !== sessionRevision) return;
      var xhr = new XMLHttpRequest();
      uploadXhr = xhr;
      xhr.open('PUT', owner.base + '/v1/deliveries/' + encodeURIComponent(recordName) + '/payload');
      xhr.setRequestHeader('Authorization', 'Bearer ' + owner.device_token);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      var lastNote = '';
      xhr.upload.onprogress = function (ev) {
        if (cancelled || revision !== sessionRevision || !ev || !ev.lengthComputable) return;
        var note = '正在上传 ' + Math.floor((ev.loaded / ev.total) * 100)
          + '%（' + fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total) + '）…';
        if (note === lastNote) return;
        lastNote = note;
        setStatus(note, false);
      };
      xhr.onload = function () {
        if (cancelled || revision !== sessionRevision) return;
        uploadXhr = null;
        if (xhr.status === 401) { endUpload(); handleRevoked(); return; } // POST→PUT 之间凭据被吊销
        if (xhr.status >= 200 && xhr.status < 300) {
          endUpload();
          // 成功文案不承诺秒到：服务端 finalize 会唤醒 App 长轮询（通常秒级），
          // 但网络时延不可承诺；file_name 只经文本渲染（XSS 红线）
          setStatus('已上传「' + name + '」。手机 Kodeoff 收件箱「文件」栏即可看到。', false);
          loadAccount(); // 存储用量/条数同步（刷新按钮双调惯例）
          loadInbox();   // 新条目上屏（恰逢 loading=true 被互斥跳过时，用户点刷新即见）
          return;
        }
        // 其余状态码：JSON 信封走 messageFor 三层兜底；5xx HTML/空体同面
        var env = null;
        try {
          var ct = xhr.getResponseHeader('Content-Type') || '';
          if (xhr.responseText && ct.indexOf('application/json') !== -1) {
            var j = JSON.parse(xhr.responseText);
            if (j && typeof j === 'object') env = j;
          }
        } catch (e) { env = null; }
        endUpload();
        setStatus(messageFor(env), true);
      };
      xhr.onerror = function () {
        if (cancelled || revision !== sessionRevision) return;
        uploadXhr = null;
        endUpload();
        setStatus(MSG.connect, true); // 断网/CORS 拦/混合内容；服务端已清 .part（行留 pending）
      };
      xhr.onabort = function () {
        if (revision !== sessionRevision) return; // 会话复位路径：resetInboxState 已收尾，静默
        uploadXhr = null; // 用户取消路径：UI 已由 uploadCancel 收尾
      };
      xhr.send(file); // File 本体：浏览器流式读盘，自动带 Content-Length（不触发 411）
    }
  }

  function onUploadButton() {
    if (!session) return;
    if (uploadBusy) { if (uploadCancel) uploadCancel(); return; }
    uploadInput.click(); // 触发文件选择器（无 multiple：多文件多次单发）
  }

  function onUploadInputChange() {
    if (!session) return;
    var file = uploadInput.files && uploadInput.files[0];
    uploadInput.value = ''; // 复位：同一文件二次选择也能再次触发 change
    if (file) uploadFile(file);
  }

  // ---- 登出：吊销本浏览器设备 ----
  function onLogout() {
    if (!session) return;
    if (!window.confirm('退出当前账号？本浏览器的登录信息会清除，服务器上的文件与其他设备保留。')) return;
    var owner = session;
    session = null;
    sessionRevision += 1;
    var revision = sessionRevision;
    lsRemove(SESSION_KEY);
    resetInboxState();
    passwordInput.value = '';
    codeInput.value = '';
    showLoginView();
    showLoginNotice('已退出登录。');
    // Local logout is immediate; revocation uses only the captured session. A
    // late revocation response must not clear a newly logged-in account.
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 10000);
    fetch(owner.base + '/v1/devices/' + encodeURIComponent(owner.device_id), {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + owner.device_token }, signal: controller.signal
    }).then(function (res) {
      if (sessionRevision !== revision) return;
      if (!(res.ok || res.status === 401 || res.status === 404)) {
        showLoginNotice('已退出本机登录。服务器吊销未成功，可在其他设备中移除「Web Browser」。');
      }
    }).catch(function () {
      if (sessionRevision === revision) {
        showLoginNotice('已退出本机登录。服务器暂不可达，可在其他设备中移除「Web Browser」。');
      }
    }).finally(function () { clearTimeout(timer); });
  }

  // ---- 卡片构建（一切字段经 textContent/属性赋值渲染，XSS 红线）----
  function mkBtn(label, handler) {
    var b = d.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-secondary';
    b.textContent = label;
    b.addEventListener('click', handler);
    return b;
  }

  function buildCard(row) {
    // 按 uti 分流而非 Content-Type（payload 响应恒 application/octet-stream）
    var isText = row.uti === CLIPBOARD_UTI;
    var card = d.createElement('article');
    card.className = 'item-card';

    var head = d.createElement('div');
    head.className = 'item-head';
    var titleWrap = d.createElement('div');
    if (isText) {
      var kind = d.createElement('span');
      kind.className = 'item-kind';
      kind.textContent = '剪贴板文本';
      titleWrap.appendChild(kind);
    }
    var title = d.createElement('p');
    title.className = 'item-title';
    title.textContent = row.file_name || '(未命名)';
    var meta = d.createElement('p');
    meta.className = 'item-meta';
    meta.textContent = fmtBytes(row.file_size) + (fmtTime(row.created_at) ? ' · ' + fmtTime(row.created_at) : '');
    titleWrap.appendChild(title);
    titleWrap.appendChild(meta);

    var actions = d.createElement('div');
    actions.className = 'item-actions';

    // 卡内闭包状态：payload blob 与全文文本只在首次取用时拉取并缓存（刷新即释放）
    var state = { blob: null, text: null, open: false, loading: false };
    var pre = null, truncNote = null, viewBtn = null;

    if (isText) {
      pre = d.createElement('pre');
      pre.className = 'text-view';
      pre.tabIndex = 0; // 手动复制兜底时需要 focus
      pre.hidden = true;
      truncNote = d.createElement('p');
      truncNote.className = 'text-trunc';
      truncNote.hidden = true;
      viewBtn = mkBtn('查看', function () { toggleText(row, state, pre, truncNote, viewBtn); });
      actions.appendChild(viewBtn);
      actions.appendChild(mkBtn('复制', function () { copyText(row, state, pre, truncNote, viewBtn); }));
      actions.appendChild(mkBtn('下载', function () { downloadRow(row, state, true); }));
    } else {
      actions.appendChild(mkBtn('下载', function () { downloadRow(row, state, false); }));
    }
    actions.appendChild(mkBtn('删除', function () { deleteRow(row, card); }));

    head.appendChild(titleWrap);
    head.appendChild(actions);
    card.appendChild(head);
    if (isText) { card.appendChild(pre); card.appendChild(truncNote); }
    return card;
  }

  // ---- 初始化 ----
  function init() {
    viewLogin = $('view-login');
    viewInbox = $('view-inbox');
    relayInput = $('relay-base');
    relayWarn = $('relay-warn');
    tabRow = $('tab-row');
    tabEmail = $('tab-email');
    tabCode = $('tab-code');
    panelEmail = $('panel-email');
    panelCode = $('panel-code');
    emailInput = $('login-email');
    passwordInput = $('login-password');
    codeInput = $('login-code');
    closedNote = $('email-closed-note');
    loginForm = $('login-form');
    loginSubmit = $('login-submit');
    loginNotice = $('login-notice');
    accountLine = $('account-line');
    refreshBtn = $('btn-refresh');
    logoutBtn = $('btn-logout');
    inboxStatus = $('inbox-status');
    emptyCard = $('inbox-empty');
    inboxList = $('inbox-list');
    moreBtn = $('btn-more');
    uploadBtn = $('btn-upload');
    uploadInput = $('upload-input');
    registerBlock = $('register-block');
    registerForm = $('register-form');
    regNotice = $('register-notice');
    regStep1 = $('register-step1');
    regStep2 = $('register-step2');
    regInviteInput = $('reg-invite');
    regEmailInput = $('reg-email');
    regSendBtn = $('reg-send');
    regSentNote = $('reg-sent-note');
    regPasswordInput = $('reg-password');
    regPassword2Input = $('reg-password2');
    regCodeInput = $('reg-code');
    regCreateBtn = $('reg-create');
    regBackBtn = $('reg-back');

    var saved = lsGet(RELAY_KEY);
    relayInput.value = saved || DEFAULT_BASE;
    $('server-settings').hidden = serviceConfiguration.showsServerConfiguration !== true;
    updateRelayWarn();
    relayInput.addEventListener('input', function () {
      updateRelayWarn();
      if (emailClosed) { emailClosed = false; applyLoginMode(); } // 换地址后重探，恢复双 tab
      regMode = 'unknown'; // 换地址：注册模式结论作废，区块先隐藏（载入/登录提交探针再定）
      applyRegistrationVisibility();
    });
    tabEmail.addEventListener('click', function () { setMode('email'); });
    tabCode.addEventListener('click', function () { setMode('code'); });
    loginForm.addEventListener('submit', onLoginSubmit);
    registerForm.addEventListener('submit', onRegisterSubmit); // 发送验证码/创建账号都是 submit，Enter 同路
    regBackBtn.addEventListener('click', onRegBack);
    refreshBtn.addEventListener('click', function () { if (session) { loadAccount(); loadInbox(); } });
    logoutBtn.addEventListener('click', onLogout);
    moreBtn.addEventListener('click', renderBatch);
    uploadBtn.addEventListener('click', onUploadButton);
    uploadInput.addEventListener('change', onUploadInputChange);

    // 会话恢复：本地有 session 直接进收件箱（首个请求若 401 会被全局分支送回登录页）
    var raw = lsGet(SESSION_KEY);
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && typeof s.device_token === 'string' && s.device_token
            && typeof s.base === 'string' && normalizeBase(s.base)) {
          session = {
            device_token: s.device_token,
            device_id: typeof s.device_id === 'string' ? s.device_id : '',
            account_code: typeof s.account_code === 'string' ? s.account_code : '',
            base: normalizeBase(s.base).base
          };
          showInboxView();
          loadAccount();
          loadInbox();
          return;
        }
        lsRemove(SESSION_KEY); // 形态不对：视作无会话
      } catch (e) { lsRemove(SESSION_KEY); }
    }
    showLoginView();
  }

  // 载入即探注册模式（与登录提交共用 probeHealth）：invite → 显示注册区块；
  // open/closed → 保持隐藏；探针失败 → 保持现状（hidden）——不因网络抖动收起已
  // 显示区块，也绝不在零信息时解锁入口。顺带落地 emailClosed（email_enabled=
  // false 载入即知，免去提交时才发现）。boot 与 init 分立的原因：tools/web-
  // session-test 的测试挂钩只调 init()（其 document 无网络环境），载入探针只属
  // 生产路径——挂进 init 会给既有 requests[0] 断言塞进杂散 fetch。
  function probeRegistration() {
    var n = normalizeBase(relayInput.value || DEFAULT_BASE);
    if (!n) return; // 无地址可探：区块保持隐藏
    probeHealth(n.base).then(function (p) {
      if (p.fail) return;
      if (!p.email) { emailClosed = true; applyLoginMode(); }
      regMode = p.registration;
      applyRegistrationVisibility();
    });
  }

  function boot() {
    init();
    if (!session) probeRegistration(); // 已有会话直进收件箱，注册探针无意义
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
