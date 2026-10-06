// ==UserScript==
// @name         谷歌相册自动保存助手/Google Photos AutoSave Assistant
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  谷歌相册自动保存助手/Google Photos AutoSave Assistant，https://github.com/xykcloud/TampermonkeyScript
// @author       xykcloud
// @match        *://photos.google.com/*
// @match        *://photos.google.com/share/*
// @match        *://photos.google.com/partner/*
// @match        *://*.googleusercontent.com/*
// @license      GPL v3
// @grant        none
// @run-at       document-start
// @allFrames    true
// @downloadURL https://update.greasyfork.org/scripts/579577/%E8%B0%B7%E6%AD%8C%E7%9B%B8%E5%86%8C%E8%87%AA%E5%8A%A8%E4%BF%9D%E5%AD%98%E5%8A%A9%E6%89%8BGoogle%20Photos%20AutoSave%20Assistant.user.js
// @updateURL https://update.greasyfork.org/scripts/579577/%E8%B0%B7%E6%AD%8C%E7%9B%B8%E5%86%8C%E8%87%AA%E5%8A%A8%E4%BF%9D%E5%AD%98%E5%8A%A9%E6%89%8BGoogle%20Photos%20AutoSave%20Assistant.meta.js
// ==/UserScript==

(function() {
    'use strict';

    if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) {
        window.trustedTypes.createPolicy('default', { createHTML: function(s) { return s; } });
    }

    var STORAGE_KEY = 'gp_save_prog_v1';
    var AUTO_RUN_KEY = 'gp_active_v1';
    var SETTINGS_KEY = 'gp_settings_v1';
    var LAST_RESULT_KEY = 'gp_last_res_v1';
    var ANCHOR_KEY = 'gp_resume_anchor_v1'; // 全量·文件粒度：边界日内的精确续传锚点
    var REWIND_KEY = 'gp_rewind_v1';        // 差异模式补扫回退的上一次位置，防止同一位置反复回退

    (function migrateOldData() {
        var current = localStorage.getItem(STORAGE_KEY);
        if (!current || current === "") {
            var legacy = localStorage.getItem('gp_save_prog_v72') || localStorage.getItem('gp_save_prog_v71') || localStorage.getItem('gp_save_prog_v70');
            if (legacy) localStorage.setItem(STORAGE_KEY, legacy);
        }
    })();

    // --- 1. 配置参数 ---
    var DEFAULT_CONFIG = {
        DEFAULT_START_DATE: "",
        TARGET_SCROLL_DATE: "",
        SAVE_STRATEGY: 'full',   // 'full' 全量保存：不论是否已保存都勾选；'diff' 差异保存：只勾选未保存
        FILE_MODE: false,
        BLOCK_MEDIA: false,
        HIGHLIGHT_STATE: false,
        MANUAL_SAVE: false,
        JUST_SCROLL: false,
        PHOTO_LIMIT: 1000,
        BASE_PHOTO_LIMIT: 1000,
        SUCCESS_ADD_PCT: 0,
        FAIL_SUB_PCT: 20,
        REDUNDANCY_DAYS: 1,
        WARP_BUFFER_DAYS: 5,
        ACTION_SPEED: 100,
        SCROLL_WAIT: 150,
        MAX_RETRY: 250,
        SAVE_TIMEOUT: 120,
        LOAD_TIMEOUT: 8000,      // 稳扫：单屏等待照片加载完成的最长时间 (ms)
        FIXED_TODAY: ""
    };

    var userSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    var CONFIG = Object.assign({}, DEFAULT_CONFIG, userSettings);

    if (!CONFIG.BASE_PHOTO_LIMIT) CONFIG.BASE_PHOTO_LIMIT = CONFIG.PHOTO_LIMIT;

    // 旧版本没有保存策略：旧"文件模式"本身就会跳过已保存照片，迁移为差异模式，保持原有行为不变
    if (userSettings.SAVE_STRATEGY !== 'full' && userSettings.SAVE_STRATEGY !== 'diff') {
        CONFIG.SAVE_STRATEGY = CONFIG.FILE_MODE ? 'diff' : 'full';
        saveConfig();
    }

    var logContainer, tempLastDate = "";

    // --- 通用小工具 ---
    function saveConfig() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG)); }
    function isRunning() { return localStorage.getItem(AUTO_RUN_KEY) === 'true'; }
    function isDiffMode() { return CONFIG.SAVE_STRATEGY === 'diff'; }
    // 日期复选框会把整天（含已保存）一并勾上，差异模式必须逐张判断，因此差异模式固定为文件粒度
    function isFileGranularity() { return CONFIG.FILE_MODE || isDiffMode(); }
    function strategyLabel() {
        return (isDiffMode() ? '差异保存' : '全量保存') + ' · ' + (isFileGranularity() ? '文件粒度' : '日期粒度');
    }
    function loadTimeout() { return CONFIG.LOAD_TIMEOUT > 0 ? CONFIG.LOAD_TIMEOUT : 8000; }
    function fmtDate(d) { return d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate(); }
    function parseYMD(s) {
        var a = String(s || '').split('.');
        return a.length === 3 ? new Date(parseInt(a[0]), parseInt(a[1]) - 1, parseInt(a[2])) : null;
    }
    function ymdTime(s) { var d = parseYMD(s); return d ? d.getTime() : NaN; }
    function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    function loadAnchor() {
        try { return JSON.parse(localStorage.getItem(ANCHOR_KEY) || 'null'); } catch (e) { return null; }
    }
    function saveAnchor(a) { localStorage.setItem(ANCHOR_KEY, JSON.stringify(a)); }
    function clearAnchor() { localStorage.removeItem(ANCHOR_KEY); }

    // --- 2. 动态样式引擎 (物理销毁重绘) ---
    function applyDynamicStyles() {
        var styleId = 'gp-dynamic-styles';
        var oldEl = document.getElementById(styleId);
        if (oldEl) oldEl.remove();

        var el = document.createElement('style');
        el.id = styleId;

        var cssRules = '';
        if (CONFIG.BLOCK_MEDIA) {
            cssRules += `
                .rtIMgb .RY3tic, .K0a18 .RY3tic, div[jsname="NwW5ce"] .RY3tic { background-image: none !important; background-color: #e8eaed !important; }
                img, video { visibility: hidden !important; opacity: 0 !important; }
            `;
        }
        if (CONFIG.HIGHLIGHT_STATE) {
            cssRules += `
                .rtIMgb:has(.Q3N5Kd svg) .RY3tic { border: 4px solid #34a853 !important; box-sizing: border-box !important; }
                .rtIMgb:not(:has(.Q3N5Kd svg)) .RY3tic { border: 4px solid #ea4335 !important; box-sizing: border-box !important; }
            `;
        }
        el.textContent = cssRules;
        (document.head || document.documentElement).appendChild(el);
    }

    var styleInit = setInterval(function() {
        if (document.documentElement) { applyDynamicStyles(); clearInterval(styleInit); }
    }, 10);

    // --- 3. 人工接管确认弹窗 ---
    function createFailureDialog(onYes, onNo) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.65); z-index:2147483647; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(2px);';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff; padding:25px; border-radius:12px; width:340px; box-shadow:0 15px 40px rgba(0,0,0,0.4); text-align:center; border-top: 6px solid #ea4335;';
        var title = document.createElement('h3');
        title.style.cssText = 'color:#ea4335; margin:0 0 10px 0; font-size:20px;';
        title.textContent = '⚠️ 保存异常拦截';
        var msg = document.createElement('p');
        msg.style.cssText = 'color:#333; font-size:14px; margin:0 0 15px 0; line-height:1.6; font-weight:bold;';
        msg.innerHTML = '脚本检测到保存失败或超时。<br>是否要暂停自动化，由人工接管处理？';
        var cdText = document.createElement('div');
        cdText.style.cssText = 'font-size:36px; font-weight:bold; color:#d93025; margin-bottom:25px;';
        cdText.textContent = '10s';
        var btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex; justify-content:space-between; gap:15px;';
        var btnYes = document.createElement('button');
        btnYes.textContent = '是 (人工接管)';
        btnYes.style.cssText = 'flex:1; padding:12px 0; border:none; border-radius:6px; background:#1a73e8; color:#fff; font-size:14px; font-weight:bold; cursor:pointer;';
        var btnNo = document.createElement('button');
        btnNo.textContent = '否 (免刷新重试)';
        btnNo.style.cssText = 'flex:1; padding:12px 0; border:none; border-radius:6px; background:#f1f3f4; color:#5f6368; font-size:14px; font-weight:bold; cursor:pointer; border:1px solid #dadce0;';
        btnWrap.appendChild(btnYes); btnWrap.appendChild(btnNo);
        box.appendChild(title); box.appendChild(msg); box.appendChild(cdText); box.appendChild(btnWrap);
        overlay.appendChild(box);
        (document.body || document.documentElement).appendChild(overlay);

        var timeLeft = 10;
        var timer = setInterval(function() {
            timeLeft--; cdText.textContent = timeLeft + 's';
            if (timeLeft <= 0) { clearInterval(timer); overlay.remove(); onNo(); }
        }, 1000);
        btnYes.onclick = function() { clearInterval(timer); overlay.remove(); onYes(); };
        btnNo.onclick = function() { clearInterval(timer); overlay.remove(); onNo(); };
    }

    // --- 4. UI 构建 ---
    function injectUI() {
        var existing = document.getElementById('gp-helper-root');
        if (existing) existing.remove();

        var host = document.createElement('div');
        host.id = 'gp-helper-root';
        host.style.cssText = 'position:fixed; top:80px; right:40px; z-index:2147483646; font-family:monospace; cursor:move;';

        var shadow = host.attachShadow({mode: 'open'});
        var isActive = localStorage.getItem(AUTO_RUN_KEY) === 'true';

        var panel = document.createElement('div');
        panel.style.cssText = 'background:#fff; padding:15px; border:4px solid #1a73e8; border-radius:12px; box-shadow:0 10px 30px rgba(0,0,0,0.4); width:390px; pointer-events:auto;';

        var title = document.createElement('div');
        title.textContent = '谷歌相册自动保存助手';
        title.style.cssText = 'font-weight:bold; color:#1a73e8; text-align:center; margin-bottom:12px; font-size:15px; user-select:none; border-bottom: 2px solid #eee; padding-bottom: 8px;';
        panel.appendChild(title);

        var settingsForm = document.createElement('div');
        settingsForm.style.cssText = 'display:flex; flex-wrap:wrap; justify-content:space-between; font-size:11px; background:#f8f9fa; padding:10px; border-radius:6px; margin-bottom:12px; border:1px solid #ddd; cursor:default;';

        // 两个切换按钮（保存策略 / 勾选粒度）相互影响，统一刷新
        var switchRefreshers = [];
        var refreshSwitches = function() { switchRefreshers.forEach(function(fn) { fn(); }); };
        var SWITCH_BASE_CSS = 'width:100%; height:24px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer; transition:0.2s;';

        var fields = [
            {label: '保存进度', key: 'STORAGE_VAL', isDisk: true, w:'48%'},
            {label: '寻址目标', key: 'TARGET_SCROLL_DATE', hint: '', w:'48%'},
            {key: 'SAVE_STRATEGY', isStrategySwitch: true, w:'48%'},
            {key: 'FILE_MODE', isModeSwitch: true, w:'48%'},
            {label: '无图模式', key: 'BLOCK_MEDIA', isToggle: true, w:'32%'},
            {label: '状态高亮', key: 'HIGHLIGHT_STATE', isToggle: true, w:'32%'},
            {label: '手动保存', key: 'MANUAL_SAVE', isToggle: true, w:'32%'},
            {label: '仅翻页寻址', key: 'JUST_SCROLL', isToggle: true, w:'48%'},
            {label: '当前限额', key: 'PHOTO_LIMIT', w:'48%'},
            {label: '冗余天数', key: 'REDUNDANCY_DAYS', w:'48%'},
            {label: '成功涨幅%', key: 'SUCCESS_ADD_PCT', w:'48%'},
            {label: '失败跌幅%', key: 'FAIL_SUB_PCT', w:'48%'},
            {label: '跃迁缓冲', key: 'WARP_BUFFER_DAYS', w:'48%'},
            {label: '探测极限', key: 'MAX_RETRY', w:'48%'},
            {label: '操作速度', key: 'ACTION_SPEED', w:'48%'},
            {label: '翻页间隔', key: 'SCROLL_WAIT', w:'48%'},
            {label: '保存超时', key: 'SAVE_TIMEOUT', w:'48%'},
            {label: '日期校准', key: 'FIXED_TODAY', w:'48%'},
            {label: '加载超时', key: 'LOAD_TIMEOUT', w:'48%'}
        ];

        fields.forEach(function(f) {
            var row = document.createElement('div');
            row.style.cssText = `width:${f.w}; margin-bottom:6px; display:flex; align-items:center;`;

            if (f.isStrategySwitch) {
                var stratBtn = document.createElement('button');
                stratBtn.id = 'gp-strategy-toggle-btn';
                switchRefreshers.push(function() {
                    if (isDiffMode()) {
                        stratBtn.style.cssText = SWITCH_BASE_CSS + 'border:1px solid #f9ab00; background:#fef7e0; color:#b06000;';
                        stratBtn.textContent = '🔍 差异保存';
                        stratBtn.title = '只按顺序勾选未保存（红框）的照片';
                    } else {
                        stratBtn.style.cssText = SWITCH_BASE_CSS + 'border:1px solid #d93025; background:#d93025; color:#fff;';
                        stratBtn.textContent = '♾️ 全量保存';
                        stratBtn.title = '不论是否已保存，全部按顺序勾选';
                    }
                });
                stratBtn.onclick = function(e) {
                    e.preventDefault(); e.stopPropagation();
                    if (isRunning()) { addLog("运行中无法切换策略，请先停止", "yellow"); return; }
                    CONFIG.SAVE_STRATEGY = isDiffMode() ? 'full' : 'diff';
                    saveConfig();
                    refreshSwitches();
                    addLog("保存策略 -> " + strategyLabel(), "#1a73e8");
                };
                row.appendChild(stratBtn);
            } else if (f.isModeSwitch) {
                var toggleBtn = document.createElement('button');
                toggleBtn.id = 'gp-mode-toggle-btn';
                switchRefreshers.push(function() {
                    if (isDiffMode()) {
                        toggleBtn.style.cssText = SWITCH_BASE_CSS + 'border:1px dashed #9aa0a6; background:#f1f3f4; color:#5f6368; cursor:not-allowed;';
                        toggleBtn.textContent = '🗂️ 文件(差异锁定)';
                        toggleBtn.title = '差异模式需要逐张判断是否已保存，固定按文件勾选';
                    } else if (CONFIG.FILE_MODE === true) {
                        toggleBtn.style.cssText = SWITCH_BASE_CSS + 'border:1px solid #1a73e8; background:#1a73e8; color:#fff;';
                        toggleBtn.textContent = '🗂️ 文件模式';
                        toggleBtn.title = '逐张勾选';
                    } else {
                        toggleBtn.style.cssText = SWITCH_BASE_CSS + 'border:1px solid #34a853; background:#e6f4ea; color:#137333;';
                        toggleBtn.textContent = '📅 日期模式';
                        toggleBtn.title = '按日期整天勾选';
                    }
                });
                toggleBtn.onclick = function(e) {
                    e.preventDefault(); e.stopPropagation();
                    if (isDiffMode()) { addLog("差异模式固定按文件逐张勾选", "yellow"); return; }
                    if (isRunning()) { addLog("运行中无法切换粒度，请先停止", "yellow"); return; }
                    CONFIG.FILE_MODE = !CONFIG.FILE_MODE;
                    saveConfig();
                    refreshSwitches();
                    addLog("模式切换 -> " + toggleBtn.textContent, "#1a73e8");
                };
                row.appendChild(toggleBtn);
            } else if (f.isToggle) {
                var lbl = document.createElement('span');
                lbl.textContent = f.label + ':';
                lbl.style.cssText = 'width:68px; display:inline-block; color:#444; font-weight:bold;';

                var inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.checked = CONFIG[f.key];
                inp.style.cssText = 'margin:0; width:15px; height:15px; cursor:pointer;';
                inp.addEventListener('change', function(e) {
                    CONFIG[f.key] = e.target.checked;
                    saveConfig();
                    addLog(f.label + (e.target.checked ? " 开启" : " 关闭"), "#1a73e8");
                    if (f.key === 'BLOCK_MEDIA' || f.key === 'HIGHLIGHT_STATE') {
                        applyDynamicStyles();
                    }
                });
                row.appendChild(lbl); row.appendChild(inp);
            } else {
                var lblT = document.createElement('span');
                lblT.textContent = f.label + ':';
                lblT.style.cssText = 'width:68px; display:inline-block; color:#444; font-weight:bold;';
                var inpT = document.createElement('input');
                inpT.value = f.isDisk ? (localStorage.getItem(STORAGE_KEY) || "") : CONFIG[f.key];
                inpT.style.cssText = 'flex:1; border:1px solid #ccc; padding:3px; border-radius:3px; min-width:0;';
                inpT.onchange = function() {
                    if (f.isDisk) {
                        localStorage.setItem(STORAGE_KEY, this.value);
                        clearAnchor(); // 手动改进度后，旧续传锚点失效
                        addLog("进度设为 -> " + (this.value || "起始"), "#d93025");
                    } else {
                        var val = (f.key === 'FIXED_TODAY' || f.key === 'TARGET_SCROLL_DATE') ? this.value : parseInt(this.value);
                        CONFIG[f.key] = val;
                        if (f.key === 'PHOTO_LIMIT') { CONFIG.BASE_PHOTO_LIMIT = val; localStorage.setItem(LAST_RESULT_KEY, 'none'); }
                        saveConfig();
                        addLog(f.label + " -> " + this.value, "#1a73e8");
                    }
                };
                row.appendChild(lblT); row.appendChild(inpT);
            }
            settingsForm.appendChild(row);
        });
        refreshSwitches();
        panel.appendChild(settingsForm);

        var statusBox = document.createElement('div');
        statusBox.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:8px;';
        var curDateInfo = document.createElement('div');
        curDateInfo.id = 'dang-info';
        curDateInfo.style.cssText = 'font-size:12px; font-weight:bold; color:#1a73e8;';
        curDateInfo.textContent = '当前扫描: 待机中...';
        statusBox.appendChild(curDateInfo);
        var progressInfo = document.createElement('div');
        progressInfo.id = 'progress-info';
        progressInfo.style.cssText = 'font-size:12px; font-weight:bold; color:#34a853;';
        progressInfo.textContent = '进度: 0 / ' + CONFIG.PHOTO_LIMIT;
        statusBox.appendChild(progressInfo);
        panel.appendChild(statusBox);

        var logBox = document.createElement('div');
        logBox.style.cssText = 'height:100px; overflow-y:auto; background:#000; color:#0f0; font-size:10px; padding:6px; border-radius:6px; margin-bottom:12px; border:2px solid #333; line-height:1.4;';
        logContainer = logBox; panel.appendChild(logBox);

        var mainBtn = document.createElement('button');
        mainBtn.id = 'gp-main-run-btn';
        mainBtn.style.cssText = 'width:100%; padding:12px; border:none; border-radius:8px; color:#fff; font-size:14px; font-weight:bold; cursor:pointer; background:' + (isActive ? '#d93025' : '#1a73e8');
        mainBtn.textContent = isActive ? '停止运行' : '全自动运行开始';

        mainBtn.onclick = function(e) {
            e.stopPropagation();
            if (localStorage.getItem(AUTO_RUN_KEY) === 'true') {
                localStorage.setItem(AUTO_RUN_KEY, 'false');
                this.textContent = '全自动运行开始'; this.style.background = '#1a73e8';
                addLog("已下达停止指令...", "yellow");
            } else {
                localStorage.setItem(AUTO_RUN_KEY, 'true');
                this.textContent = '停止运行'; this.style.background = '#d93025';
                addLog("任务激活，点火启动...", "lime");
                startAutomation(shadow);
            }
        };
        panel.appendChild(mainBtn);

        shadow.appendChild(panel);
        (document.body || document.documentElement).appendChild(host);

        var isDragging = false, offsetX, offsetY;
        host.onmousedown = function(e) {
            if (e.target === host || e.composedPath().includes(title) || e.target === panel) {
                isDragging = true; var rect = host.getBoundingClientRect();
                offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
            }
        };
        document.onmousemove = function(e) {
            if (isDragging) { host.style.left = (e.clientX - offsetX) + 'px'; host.style.top = (e.clientY - offsetY) + 'px'; host.style.right = 'auto'; }
        };
        document.onmouseup = function() { isDragging = false; };

        if (isActive) { addLog("任务自动唤醒中...", "lime"); startAutomation(shadow); }
    }

    // --- 5. 工具函数 ---
    function updateUIStatus(shadow, statusText, count, limit) {
        var elDang = shadow.getElementById('dang-info');
        if (elDang && statusText) elDang.textContent = statusText;
        var elProg = shadow.getElementById('progress-info');
        if (elProg) elProg.textContent = '进度: ' + count + ' / ' + limit;
    }
    function haltRun(shadow, statusText) {
        localStorage.setItem(AUTO_RUN_KEY, 'false');
        if (statusText) updateUIStatus(shadow, statusText, getCount(), CONFIG.PHOTO_LIMIT);
        var b = shadow.getElementById('gp-main-run-btn');
        if (b) { b.textContent = '全自动运行开始'; b.style.background = '#1a73e8'; }
    }
    function getCount() {
        var el = document.querySelector('.rtExYb');
        if (!el) return 0;
        var m = el.innerText.match(/\d+/); return m ? parseInt(m[0]) : 0;
    }
    function parseDate(str) {
        var today = CONFIG.FIXED_TODAY ? new Date(CONFIG.FIXED_TODAY.replace(/\./g, '/')) : new Date();
        today.setHours(0,0,0,0);
        var m = str.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
        if (m) {
            var y = m[1] ? parseInt(m[1]) : today.getFullYear();
            var mon = parseInt(m[2]) - 1;
            if (!m[1] && mon > today.getMonth()) y -= 1;
            return new Date(y, mon, parseInt(m[3]));
        }
        return null;
    }
    function addLog(msg, color) {
        if (!logContainer) return;
        var entry = document.createElement('div');
        entry.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
        if (color) entry.style.color = color;
        logContainer.appendChild(entry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    // --- 稳扫引擎：几何判定 / 加载判定 / 可靠点击 / 步进翻页 ---
    function rectOf(el) {
        var r = el.getBoundingClientRect();
        return (r.width > 0 && r.height > 0) ? r : null;
    }
    // 完整处于视口内
    function isFullyVisible(r) { return r.top >= -2 && r.bottom <= window.innerHeight + 2; }
    // 已翻过或正完整处于视口内（视口下方、尚未完整露出的不算）
    function isReached(r) { return r.bottom <= window.innerHeight + 2; }
    // 缩略图数据已到位（内联 background-image；无图模式只是用 CSS 盖住，不影响这里的判断）
    function hasThumb(p) {
        var t = p.querySelector('.RY3tic');
        var st = t ? (t.getAttribute('style') || '') : '';
        return st.indexOf('url(') !== -1;
    }
    // 轻推一次，让虚拟列表重新计算可见区并补齐渲染（不改变滚动位置）
    function nudgeRender() {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        try { window.dispatchEvent(new Event('scroll')); document.dispatchEvent(new Event('scroll')); } catch (e) {}
    }
    function contentSignature() {
        var tiles = document.querySelectorAll('.rtIMgb');
        var last = tiles[tiles.length - 1];
        var a = last ? last.querySelector('a.p137Zd') : null;
        return tiles.length + '|' + (a ? a.getAttribute('href') : '') + '|' + document.querySelectorAll('h2.ZEmz6b').length;
    }
    // 步进翻页：把第一个"未完整露出"的元素滚到视口顶部，保证每个格子都会完整出现在视口里至少一次，
    // 不再像原来那样一下跳到 DOM 最后一个元素（会把预渲染但还没加载完的几行直接甩过去）
    async function stepScroll() {
        var vh = window.innerHeight;
        var els = document.querySelectorAll('.rtIMgb, h2.ZEmz6b');
        var next = null, nextTop = Infinity, lastEl = null, lastBottom = -Infinity;
        for (var i = 0; i < els.length; i++) {
            var r = rectOf(els[i]);
            if (!r) continue;
            if (r.bottom > lastBottom) { lastBottom = r.bottom; lastEl = els[i]; }
            if (r.bottom > vh + 2 && r.top < nextTop) { nextTop = r.top; next = els[i]; }
        }
        var target = next || lastEl;
        if (!target) return false;
        var block = (next && nextTop <= 5) ? 'end' : 'start';
        var before = target.getBoundingClientRect().top;
        target.scrollIntoView({ behavior: 'auto', block: block });
        await sleep(30);
        if (!target.isConnected) return true;
        return (before - target.getBoundingClientRect().top) > 2;
    }
    // 点击复选框并确认生效：aria-checked 变为 true 或"已选择"计数增加才算成功；未生效最多补点 2 次
    async function clickAndVerify(cb) {
        var baseWait = Math.max(30, CONFIG.ACTION_SPEED || 0);
        for (var attempt = 0; attempt < 3; attempt++) {
            if (!cb.isConnected) return 'detached';
            if (cb.getAttribute('aria-checked') === 'true') return 'ok';
            var before = getCount();
            ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(function(t) {
                cb.dispatchEvent(new MouseEvent(t, {bubbles: true}));
            });
            await sleep(baseWait);
            for (var waited = 0; waited <= 800; waited += 50) {
                if (getCount() > before || cb.getAttribute('aria-checked') === 'true') return 'ok';
                if (!cb.isConnected) return 'detached';
                await sleep(50);
            }
        }
        return 'fail';
    }

    // 【核心引擎：逆向视点追踪与双重指纹校验】
    async function findElementWithScroll(nodeData) {
        var cbTarget = null;
        var scrollUpTries = 0;

        while (!cbTarget && scrollUpTries < 20) {
            if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') return null; // 每一帧检测全局急停

            if (nodeData.type === 'file') {
                if (nodeData.id) {
                    var targetA = document.querySelector('a.p137Zd[href="' + nodeData.id + '"]');
                    if (targetA && targetA.parentElement) cbTarget = targetA.parentElement.querySelector('div[role="checkbox"]');
                }
            } else {
                if (nodeData.ariaLabel) {
                    var cbs = document.querySelectorAll('div[role="checkbox"]');
                    for (var c = 0; c < cbs.length; c++) {
                        if (cbs[c].getAttribute('aria-label') === nodeData.ariaLabel) {
                            cbTarget = cbs[c];
                            break;
                        }
                    }
                }
                if (!cbTarget) {
                    var sectionsD = document.querySelectorAll('.K0a18');
                    for (var m = 0; m < sectionsD.length; m++) {
                        var h2D = sectionsD[m].querySelector('h2.ZEmz6b');
                        if (h2D && h2D.textContent === nodeData.id) {
                            cbTarget = sectionsD[m].querySelector('div[role="checkbox"]');
                            break;
                        }
                    }
                }
            }

            if (!cbTarget) {
                window.scrollBy(0, -800);
                await new Promise(r => setTimeout(r, 250));
                scrollUpTries++;
            }
        }
        return cbTarget;
    }

    // --- 6. 自动化核心逻辑 ---
    async function startAutomation(shadow) {
        var diskSaved = localStorage.getItem(STORAGE_KEY) || "";
        var baseDate, isInfiniteTarget = false;

        // 已勾选节点，按日期从新到旧排列：栈顶 = 最旧的已勾选项（回退时先撤最旧的，进度取栈顶）
        var checkedNodesStack = [];

        // 全量·文件粒度的续传锚点：上一批最后保存的那张照片。
        // 边界日内锚点之前的照片直接跳过，避免"单日照片数 > 限额"时每批都从当天开头重来、原地打转。
        var resumeAnchor = null, anchorPassed = false;

        if (CONFIG.JUST_SCROLL) {
            if (!CONFIG.TARGET_SCROLL_DATE) {
                alert("请输入【寻址目标】日期"); localStorage.setItem(AUTO_RUN_KEY, 'false'); return;
            }
            baseDate = new Date(CONFIG.TARGET_SCROLL_DATE.replace(/\./g, '/'));
        } else {
            if (diskSaved === "") { baseDate = new Date("2099.01.01"); isInfiniteTarget = true; }
            else {
                baseDate = new Date(diskSaved.replace(/\./g, '/'));
                if (!isFileGranularity()) baseDate.setDate(baseDate.getDate() + CONFIG.REDUNDANCY_DAYS);
                if (isFileGranularity() && !isDiffMode()) {
                    var savedAnchor = loadAnchor();
                    if (savedAnchor && savedAnchor.href && savedAnchor.date === diskSaved) resumeAnchor = savedAnchor;
                }
            }
        }

        var targetTS = baseDate.getTime();
        var activeBufferDays = CONFIG.WARP_BUFFER_DAYS;
        var warpThresholdTS = targetTS + (activeBufferDays * 24 * 60 * 60 * 1000);

        tempLastDate = diskSaved;
        var lastList = "", retry = 0;
        var loggedScans = {};

        // 稳扫状态
        var clickFails = {};      // key -> 点击未生效的轮数
        var givenUp = {};         // key -> true：多次点击无效、已放弃的项
        var notedMissed = {};     // key -> true：已计入遗漏，避免重复计数
        var missed = { count: 0, newest: null };   // 本批始终未能勾选的照片
        var labelSampleLogged = false;

        // 进度 = 栈顶（最旧的、仍处于勾选状态的节点）
        function syncProgressFromStack() {
            var top = checkedNodesStack[checkedNodesStack.length - 1];
            tempLastDate = top ? fmtDate(top.dObj) : diskSaved;
        }
        // 按日期有序插入（同日期按处理顺序追加），保证补点的照片不会打乱回退顺序
        function pushNode(node) {
            var i = checkedNodesStack.length;
            while (i > 0 && checkedNodesStack[i - 1].dObj.getTime() < node.dObj.getTime()) i--;
            checkedNodesStack.splice(i, 0, node);
            syncProgressFromStack();
        }
        function noteMissedOnce(key, dObj) {
            if (dObj && dObj.getTime() > targetTS) return;   // 超出范围的本来就不处理
            if (key) { if (notedMissed[key]) return; notedMissed[key] = true; }
            missed.count++;
            if (dObj && (!missed.newest || dObj.getTime() > missed.newest.getTime())) missed.newest = dObj;
        }

        // ---- 文件粒度单轮扫描：只处理已翻过/完整可见的照片；完整可见但未加载完的计入 pending ----
        async function processFilePass(force) {
            var st = { total: 0, saved: 0, future: 0, clicked: 0, resumed: 0, pending: 0, guessed: 0, lastLabel: "", pendingSample: "", stop: false, full: false };
            var els = document.querySelectorAll('h2.ZEmz6b, .rtIMgb');
            var headerDate = null;

            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.classList.contains('ZEmz6b')) { headerDate = parseDate(el.textContent) || headerDate; continue; }

                var r = rectOf(el);
                if (!r || !isReached(r)) continue;          // 视口下方的等翻到再处理
                var visible = isFullyVisible(r);

                var cb = el.querySelector('div[role="checkbox"]');
                var aTag = el.querySelector('a.p137Zd');
                var hrefId = aTag ? aTag.getAttribute('href') : null;
                var ariaLabel = cb ? (cb.getAttribute('aria-label') || "") : "";
                var key = hrefId || ariaLabel || null;
                if (key && givenUp[key]) continue;

                var checkedAttr = cb ? cb.getAttribute('aria-checked') : null;
                var cbReady = !!cb && (checkedAttr === 'true' || checkedAttr === 'false');
                var labelDate = ariaLabel ? parseDate(ariaLabel) : null;
                var loaded = cbReady && (labelDate || hasThumb(el));

                if (!loaded) {
                    if (!visible) continue;                   // 已翻过视口：当时已等待/记录过
                    if (!force) {
                        st.pending++;
                        if (!st.pendingSample) st.pendingSample = ariaLabel || '(无标签)';
                        continue;
                    }
                    // 超时兜底：连复选框都没有，无法勾选，记为遗漏；有复选框则按所在分组日期继续处理
                    if (!cbReady) { noteMissedOnce(key, labelDate || headerDate); continue; }
                }

                var dObj = labelDate || headerDate;
                if (!dObj) {
                    if (visible) { if (force) noteMissedOnce(key, null); else st.pending++; }
                    continue;
                }
                if (!labelDate) {
                    st.guessed++;
                    if (!labelSampleLogged) {
                        labelSampleLogged = true;
                        addLog("ℹ️ 标签内无日期，改用分组日期 " + fmtDate(dObj) + "，样例: " + (ariaLabel.slice(0, 30) || '(空)'), "#9aa0a6");
                    }
                }

                st.total++;
                var shortLog = (labelDate ? (ariaLabel.split('-').pop() || "").trim() : "") || fmtDate(dObj);
                st.lastLabel = shortLog;

                if (dObj.getTime() > targetTS) { st.future++; continue; }

                var isSaved = el.querySelector('.Q3N5Kd svg') !== null; // 与"状态高亮"同一判定：有图标 = 已保存

                // 全量续传：边界日内，锚点之前的照片上一批已保存过
                if (resumeAnchor && !anchorPassed) {
                    if (dObj.getTime() === targetTS) {
                        if (hrefId && hrefId === resumeAnchor.href) {
                            anchorPassed = true;
                            addLog("📍 定位到续传锚点: " + shortLog, "#1a73e8");
                            if (isSaved) { st.resumed++; continue; }
                        } else if (isSaved) {
                            // 锚点之前且已保存：跳过；锚点之前但未保存的照常勾选，保证不漏
                            st.resumed++; continue;
                        }
                    } else {
                        anchorPassed = true;
                        addLog("⚠️ 未定位到续传锚点，边界日已按差异方式补齐", "orange");
                    }
                }

                // 差异模式：已保存（绿框）直接跳过
                if (isDiffMode() && isSaved) { st.saved++; continue; }
                if (checkedAttr !== 'false') continue;          // 已经勾上

                updateUIStatus(shadow, "🎯 锁定: " + shortLog, getCount(), CONFIG.PHOTO_LIMIT);
                var res = await clickAndVerify(cb);
                if (!isRunning()) { st.stop = true; return st; }

                if (res === 'ok') {
                    st.clicked++;
                    if (isSaved) st.saved++;
                    addLog((isSaved ? "[全量重存] " : "[排雷勾选] ") + shortLog, isSaved ? "#81c995" : "#34a853");
                    pushNode({ type: 'file', id: hrefId, dateStr: shortLog, dObj: dObj });
                    if (getCount() >= CONFIG.PHOTO_LIMIT) { st.full = true; return st; }
                } else {
                    if (res === 'fail' && key) {
                        clickFails[key] = (clickFails[key] || 0) + 1;
                        if (clickFails[key] >= 2) {
                            givenUp[key] = true;
                            noteMissedOnce(key, dObj);
                            addLog("⚠️ 多次点击未生效，已跳过: " + shortLog, "red");
                            continue;
                        }
                    }
                    st.pending++;   // 未确认勾上（元素被重绘或点击未生效），下一轮重新核验
                }
            }
            return st;
        }

        // ---- 日期粒度单轮扫描（仅全量）：勾选日期复选框，整天照片不论是否已保存全部选中 ----
        async function processDatePass(force) {
            var st = { total: 0, saved: 0, future: 0, clicked: 0, resumed: 0, pending: 0, guessed: 0, lastLabel: "", pendingSample: "", stop: false, full: false };
            var sections = document.querySelectorAll('.K0a18');

            for (var j = 0; j < sections.length; j++) {
                var s = sections[j], h2 = s.querySelector('h2.ZEmz6b');
                if (!h2) continue;
                var r = rectOf(h2);
                if (!r || !isReached(r)) continue;
                var visible = isFullyVisible(r);
                var dateStr = h2.textContent;
                var dObjDate = parseDate(dateStr);
                if (!dObjDate) continue;

                var cbDate = s.querySelector('div[role="checkbox"]');
                var ca = cbDate ? cbDate.getAttribute('aria-checked') : null;
                if (!cbDate || (ca !== 'true' && ca !== 'false')) {
                    if (visible) {
                        if (force) noteMissedOnce(dateStr, dObjDate);
                        else { st.pending++; if (!st.pendingSample) st.pendingSample = dateStr; }
                    }
                    continue;
                }
                if (givenUp[dateStr]) continue;

                st.total++;
                st.lastLabel = dateStr;
                if (!loggedScans[dateStr]) { loggedScans[dateStr] = true; addLog("[扫描] " + dateStr, "#9aa0a6"); }
                if (dObjDate.getTime() > targetTS) { st.future++; continue; }
                if (ca !== 'false') continue;

                updateUIStatus(shadow, "🎯 锁定: " + dateStr, getCount(), CONFIG.PHOTO_LIMIT);
                var dateAriaLabel = cbDate.getAttribute('aria-label');
                var res = await clickAndVerify(cbDate);
                if (!isRunning()) { st.stop = true; return st; }

                if (res === 'ok') {
                    st.clicked++;
                    addLog("[日期模式] " + dateStr, "#34a853");
                    pushNode({ type: 'date', id: dateStr, ariaLabel: dateAriaLabel, dateStr: dateStr, dObj: dObjDate });
                    if (getCount() >= CONFIG.PHOTO_LIMIT) { st.full = true; return st; }
                } else {
                    if (res === 'fail') {
                        clickFails[dateStr] = (clickFails[dateStr] || 0) + 1;
                        if (clickFails[dateStr] >= 2) {
                            givenUp[dateStr] = true;
                            noteMissedOnce(dateStr, dObjDate);
                            addLog("⚠️ 多次点击未生效，已跳过: " + dateStr, "red");
                            continue;
                        }
                    }
                    st.pending++;
                }
            }
            return st;
        }

        await new Promise(r => setTimeout(r, 1000));
        if (!CONFIG.JUST_SCROLL) {
            addLog("策略: " + strategyLabel() + " | 稳扫" + (resumeAnchor ? " | 续传锚点: " + resumeAnchor.date : ""), "cyan");
        }
        updateUIStatus(shadow, "⏳ 引擎运转中...", getCount(), CONFIG.PHOTO_LIMIT);

        while (true) {
            if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') {
                updateUIStatus(shadow, "⏸️ 已挂起", getCount(), CONFIG.PHOTO_LIMIT); return;
            }
            if (!CONFIG.JUST_SCROLL && getCount() >= CONFIG.PHOTO_LIMIT) break;

            var sections = document.querySelectorAll('.K0a18');
            var currentList = "";
            var minDateInView = null;

            for (var k = 0; k < sections.length; k++) {
                var h2T = sections[k].querySelector('h2.ZEmz6b');
                if (h2T) {
                    currentList += h2T.textContent + "|";
                    var tObj = parseDate(h2T.textContent);
                    if (tObj) {
                        var ts = tObj.getTime();
                        if (!minDateInView || ts < minDateInView) minDateInView = ts;
                    }
                }
            }

            // 跃迁：只用于快速越过"比 目标日期+缓冲天数 更新"的部分，这一段不勾选任何照片
            if (!isInfiniteTarget && minDateInView && (minDateInView > warpThresholdTS)) {
                var showDate = new Date(minDateInView).toLocaleDateString();
                var warpStatusStr = isFileGranularity() ? "🚀 全速直达 (" : "🚀 跃迁 (";
                updateUIStatus(shadow, warpStatusStr + showDate + ")", getCount(), CONFIG.PHOTO_LIMIT);

                var warpWait = Math.max(5, Math.floor(CONFIG.SCROLL_WAIT / 10));

                if (!loggedScans[showDate]) {
                    loggedScans[showDate] = true;
                    addLog("[跃迁] 跨越: " + showDate + " (" + warpWait + "ms)", "#d292ff");
                }

                var anchorsW = document.querySelectorAll('.rtIMgb, .K0a18');
                var lastAW = anchorsW[anchorsW.length - 1];
                if (lastAW) lastAW.scrollIntoView({ behavior: 'auto', block: 'end' });
                else window.scrollBy(0, 3000);

                if (currentList === lastList && sections.length > 0) {
                    retry++; addLog("跃迁探测 (" + retry + "/" + CONFIG.MAX_RETRY + ")", "magenta");
                    if (retry >= CONFIG.MAX_RETRY) { addLog("触底结算...", "white"); break; }
                } else { retry = 0; lastList = currentList; }

                await new Promise(r => setTimeout(r, warpWait));
                continue;
            }

            if (CONFIG.JUST_SCROLL) {
                // 仅翻页寻址：抵达目标日期即停，不勾选
                if (minDateInView && minDateInView <= targetTS) { addLog("📍 已抵达寻址目标", "lime"); break; }
                updateUIStatus(shadow, "🧭 寻址中...", getCount(), CONFIG.PHOTO_LIMIT);
            } else {
                // ===== 稳扫：当前视口全部加载就绪、全部勾选并核验通过后才下翻 =====
                var screenStart = Date.now(), settleStart = Date.now(), nudged = false;
                var lastSt = null, clickedSum = 0, isFull = false;

                while (true) {
                    var st = isFileGranularity() ? await processFilePass(false) : await processDatePass(false);
                    if (st.stop) { updateUIStatus(shadow, "⏸️ 已挂起", getCount(), CONFIG.PHOTO_LIMIT); return; }
                    lastSt = st; clickedSum += st.clicked;
                    if (st.full) { isFull = true; break; }
                    if (st.pending === 0 && st.clicked === 0) break;     // 一整轮无待加载、无新勾选 = 本屏核验通过
                    if (st.clicked > 0) settleStart = Date.now();       // 有进展就重新计时

                    if (st.pending > 0) {
                        updateUIStatus(shadow, "⏳ 等待加载 (" + st.pending + ")", getCount(), CONFIG.PHOTO_LIMIT);
                        if (Date.now() - settleStart > loadTimeout()) {
                            if (!nudged) {
                                nudged = true; settleStart = Date.now();
                                addLog("⏳ 本屏 " + st.pending + " 项超时未加载，尝试唤醒渲染… 样例: " + String(st.pendingSample).slice(0, 30), "orange");
                                nudgeRender();
                            } else {
                                var missedBefore = missed.count;
                                var fst = isFileGranularity() ? await processFilePass(true) : await processDatePass(true);
                                if (fst.stop) { updateUIStatus(shadow, "⏸️ 已挂起", getCount(), CONFIG.PHOTO_LIMIT); return; }
                                lastSt = fst; clickedSum += fst.clicked;
                                if (fst.full) isFull = true;
                                var lost = missed.count - missedBefore;
                                if (lost > 0) addLog("⚠️ 本屏 " + lost + " 项始终未加载，无法勾选" + (isDiffMode() ? "（保存成功后进度回退以便补扫）" : ""), "red");
                                break;
                            }
                        }
                    }
                    await sleep(st.clicked > 0 ? 50 : 150);
                }

                if (lastSt && lastSt.total > 0) {
                    if (clickedSum === 0 && lastSt.lastLabel) updateUIStatus(shadow, "👁️ 扫视: " + lastSt.lastLabel, getCount(), CONFIG.PHOTO_LIMIT);
                    if (isFileGranularity()) {
                        var waitMs = Date.now() - screenStart;
                        var tail = (lastSt.guessed ? `|分组日期${lastSt.guessed}` : '') + (waitMs > 1000 ? `|等待${(waitMs / 1000).toFixed(1)}s` : '');
                        if (isDiffMode()) {
                            addLog(`雷达[差异]: 扫${lastSt.total}|跳过已存${lastSt.saved}|超范围${lastSt.future}|勾${clickedSum}` + tail, "#888");
                        } else {
                            addLog(`雷达[全量]: 扫${lastSt.total}|超范围${lastSt.future}|勾${clickedSum}` + (lastSt.resumed ? `|续传跳过${lastSt.resumed}` : '') + tail, "#888");
                        }
                    }
                }
                if (isFull) break;
            }

            if (!CONFIG.JUST_SCROLL && getCount() >= CONFIG.PHOTO_LIMIT) break;

            // 步进下翻（每次只翻到第一个未完整露出的元素）
            var sigBefore = contentSignature();
            var moved = await stepScroll();
            await new Promise(r => setTimeout(r, CONFIG.SCROLL_WAIT));
            if (!moved && contentSignature() === sigBefore) {
                retry++; addLog("触底探测 (" + retry + "/" + CONFIG.MAX_RETRY + ")", "yellow");
                if (retry >= CONFIG.MAX_RETRY) { addLog("物理触底，结算...", "white"); break; }
            } else { retry = 0; }
            lastList = currentList;
        }

        // --- 7. 内循环保存架构 ---
        async function executeSaveSequence() {
            if (CONFIG.JUST_SCROLL) {
                addLog("✅ 寻址完毕", "lime"); localStorage.setItem(AUTO_RUN_KEY, 'false');
                var btnElJ = shadow.getElementById('gp-main-run-btn');
                if (btnElJ) { btnElJ.textContent = '全自动运行开始'; btnElJ.style.background = '#1a73e8'; }
                return;
            }

            var finalCount = getCount();
            if (finalCount <= 0) {
                addLog("无数据，结束任务。", "white"); localStorage.setItem(AUTO_RUN_KEY, 'false');
                setTimeout(() => window.location.reload(), 1500); return;
            }

            // 工具栏可能晚于计数渲染，稍等片刻；仍找不到则挂起，而不是静默卡住
            var sBtn = document.querySelector('button[aria-label="保存"]');
            for (var w = 0; !sBtn && w < 10; w++) {
                await sleep(500);
                sBtn = document.querySelector('button[aria-label="保存"]');
            }
            if (!sBtn) {
                addLog("未找到【保存】按钮" + (isDiffMode() ? "" : "（所选照片可能均已保存）") + "，任务挂起", "red");
                haltRun(shadow, "❌ 未找到保存按钮");
                return;
            }

            if (CONFIG.MANUAL_SAVE) {
                addLog("手动模式：已挂起", "magenta"); localStorage.setItem(AUTO_RUN_KEY, 'false');
                var btnElM = shadow.getElementById('gp-main-run-btn');
                if (btnElM) { btnElM.textContent = '全自动运行开始'; btnElM.style.background = '#1a73e8'; }
                return;
            }

            addLog("提交数据 (" + finalCount + ")...", "cyan");
            updateUIStatus(shadow, "💾 准备提交事务...", finalCount, CONFIG.PHOTO_LIMIT);
            sBtn.click();

            var sec = 0, timer = setInterval(function() {
                sec++;
                var toast = document.querySelector('.zyTWof-gIZMF');
                var lastRes = localStorage.getItem(LAST_RESULT_KEY);
                var isAtBase = (CONFIG.PHOTO_LIMIT === CONFIG.BASE_PHOTO_LIMIT);

                if (toast && toast.textContent.indexOf("已保存") !== -1) {
                    clearInterval(timer);
                    var dateToSave = tempLastDate;
                    var topNode = checkedNodesStack[checkedNodesStack.length - 1];

                    if (isFileGranularity() && tempLastDate !== "") {
                        if (!isDiffMode() && topNode && topNode.id) {
                            // 全量·文件：进度停在边界日，并记录最后一张照片作为锚点，下一批从它之后精确续传
                            saveAnchor({ date: tempLastDate, href: topNode.id });
                        } else {
                            // 差异·文件：已保存的会被自动跳过，进度 +1 天回扫边界日即可
                            var arr = tempLastDate.split('.');
                            if (arr.length === 3) {
                                var tempD = new Date(parseInt(arr[0]), parseInt(arr[1]) - 1, parseInt(arr[2]));
                                tempD.setDate(tempD.getDate() + 1);
                                dateToSave = fmtDate(tempD);
                            }
                            clearAnchor();
                        }
                    } else {
                        clearAnchor();
                    }

                    // 本批有照片始终未能勾选：差异模式回退进度以便补扫（同一位置只回退一次，防止死循环）
                    if (missed.count > 0) {
                        if (isDiffMode()) {
                            var rewindStr = diskSaved;
                            if (missed.newest) {
                                var rd = new Date(missed.newest.getTime());
                                rd.setDate(rd.getDate() + 1);
                                rewindStr = fmtDate(rd);
                            }
                            var needRewind = (rewindStr === "")
                                ? (dateToSave !== "")
                                : (dateToSave !== "" && ymdTime(rewindStr) > ymdTime(dateToSave));
                            if (needRewind) {
                                if (localStorage.getItem(REWIND_KEY) === rewindStr) {
                                    addLog("⚠️ " + (rewindStr || "起始") + " 附近补扫后仍有遗漏，不再回退，请人工检查", "red");
                                } else {
                                    localStorage.setItem(REWIND_KEY, rewindStr);
                                    dateToSave = rewindStr;
                                    addLog("↩️ 本批 " + missed.count + " 张未能勾选，进度回退至 " + (rewindStr || "起始") + " 以便补扫", "orange");
                                }
                            }
                        } else {
                            addLog("⚠️ 本批 " + missed.count + " 张未能勾选（全量模式不回退进度），建议之后用差异模式补扫", "orange");
                        }
                    } else {
                        localStorage.removeItem(REWIND_KEY);
                    }

                    localStorage.setItem(STORAGE_KEY, dateToSave);
                    if (lastRes === 'fail' && !isAtBase) CONFIG.PHOTO_LIMIT = CONFIG.BASE_PHOTO_LIMIT;
                    else if (CONFIG.SUCCESS_ADD_PCT > 0) CONFIG.PHOTO_LIMIT = Math.floor(CONFIG.PHOTO_LIMIT * (1 + CONFIG.SUCCESS_ADD_PCT / 100));
                    localStorage.setItem(LAST_RESULT_KEY, 'success');
                    saveConfig();
                    setTimeout(() => window.location.reload(), 1500);
                }

                if ((toast && toast.textContent.indexOf("无法添加") !== -1) || (sec >= CONFIG.SAVE_TIMEOUT)) {
                    clearInterval(timer);
                    document.querySelectorAll('.zyTWof-gIZMF').forEach(el => el.remove());

                    if (isFileGranularity() && finalCount <= 100) {
                        addLog("严重异常: 数量极低 (" + finalCount + ") 仍保存失败！", "red");
                        localStorage.setItem(AUTO_RUN_KEY, 'false');
                        updateUIStatus(shadow, "❌ 致命异常挂起", finalCount, CONFIG.PHOTO_LIMIT);
                        var btnM = shadow.getElementById('gp-main-run-btn');
                        if (btnM) { btnM.textContent = '全自动运行开始'; btnM.style.background = '#1a73e8'; }
                        alert("⚠️ 严重异常拦截：\n\n勾选的文件数量已降至 100 以下，但仍然无法保存。\n可能是网络阻断或谷歌相册空间已满，任务已强行挂起，请人工检查！");
                        return;
                    }

                    if (!isFileGranularity() && checkedNodesStack.length <= 1) {
                        addLog("单日数据超载，准备切换【文件模式】并重启...", "magenta");
                        CONFIG.FILE_MODE = true;
                        saveConfig();
                        clearAnchor();

                        (async function() {
                            if (checkedNodesStack.length === 1) {
                                var singleNode = checkedNodesStack.pop();
                                var cbTarget = await findElementWithScroll(singleNode);
                                if (cbTarget && cbTarget.getAttribute('aria-checked') !== 'false') {
                                    cbTarget.scrollIntoView({ behavior: 'auto', block: 'center' });
                                    await new Promise(r => setTimeout(r, 150));
                                    var evts = ['mouseover', 'mousedown', 'mouseup', 'click'];
                                    evts.forEach(t => cbTarget.dispatchEvent(new MouseEvent(t, {bubbles: true})));
                                }
                            }
                            updateUIStatus(shadow, "🔄 模式切换刷新中...", 0, CONFIG.PHOTO_LIMIT);
                            setTimeout(() => window.location.reload(), 1500);
                        })();
                        return;
                    }

                    createFailureDialog(
                        function() {
                            addLog("已人工接管，引擎挂起", "magenta");
                            localStorage.setItem(AUTO_RUN_KEY, 'false');
                            var b = shadow.getElementById('gp-main-run-btn');
                            if (b) { b.textContent = '全自动运行开始'; b.style.background = '#1a73e8'; }
                        },
                        async function() {
                            if (lastRes === 'success' && !isAtBase) {
                                CONFIG.PHOTO_LIMIT = CONFIG.BASE_PHOTO_LIMIT;
                                addLog("退回基准限额: " + CONFIG.PHOTO_LIMIT, "red");
                            } else if (CONFIG.FAIL_SUB_PCT > 0) {
                                CONFIG.PHOTO_LIMIT = Math.max(50, Math.floor(CONFIG.PHOTO_LIMIT * (1 - CONFIG.FAIL_SUB_PCT / 100)));
                                addLog("连败降级，限额缩减至: " + CONFIG.PHOTO_LIMIT, "red");
                            }
                            localStorage.setItem(LAST_RESULT_KEY, 'fail');
                            saveConfig();
                            updateUIStatus(shadow, "🔄 启动逆向排雷...", getCount(), CONFIG.PHOTO_LIMIT);

                            while (getCount() > CONFIG.PHOTO_LIMIT && checkedNodesStack.length > 0) {
                                if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') {
                                    addLog("已按下停止，回退中止", "yellow"); return;
                                }

                                var nodeData = checkedNodesStack.pop();
                                var cbT = await findElementWithScroll(nodeData);

                                if (!cbT && localStorage.getItem(AUTO_RUN_KEY) !== 'true') return;

                                if (cbT && cbT.getAttribute('aria-checked') !== 'false') {
                                    cbT.scrollIntoView({ behavior: 'auto', block: 'center' });

                                    // 文件粒度视口同步等待极短，光速取消
                                    var viewSyncWait = isFileGranularity() ? Math.max(5, Math.floor(CONFIG.ACTION_SPEED / 10)) : 150;
                                    await new Promise(r => setTimeout(r, viewSyncWait));

                                    var e = ['mouseover', 'mousedown', 'mouseup', 'click'];
                                    e.forEach(t => cbT.dispatchEvent(new MouseEvent(t, {bubbles: true})));

                                    addLog("⏪ 倒序撤销: " + nodeData.dateStr, "orange");
                                    updateUIStatus(shadow, "⏪ 撤销中...", getCount(), CONFIG.PHOTO_LIMIT);

                                    // 文件粒度取消后摇缩短至操作速度的 1/10
                                    var cancelWait = isFileGranularity() ? Math.max(5, Math.floor(CONFIG.ACTION_SPEED / 10)) : 600;
                                    await new Promise(r => setTimeout(r, cancelWait));
                                } else {
                                    addLog("⚠️ 节点已丢失或被回收 (" + nodeData.dateStr + ")", "red");
                                }
                            }

                            if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') return;

                            // 进度回退到仍处于勾选状态的最后一个节点，被撤销的部分下次会重新处理
                            syncProgressFromStack();

                            if (getCount() <= 0) {
                                addLog("环境彻底崩坏，执行安全强刷", "red");
                                setTimeout(() => window.location.reload(), 1000);
                                return;
                            }

                            await new Promise(r => setTimeout(r, 1000));
                            addLog("✅ 逆向排雷完毕！达标触发二次冲锋", "cyan");
                            executeSaveSequence();
                        }
                    );
                }
            }, 1000);
        }

        executeSaveSequence();
    }

    var boot = setInterval(function() {
        if (document.body || document.documentElement) { injectUI(); clearInterval(boot); }
    }, 500);
})();
