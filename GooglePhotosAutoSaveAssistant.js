// ==UserScript==
// @name         谷歌相册自动保存助手/Google Photos AutoSave Assistant
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  https://github.com/xykcloud/TampermonkeyScript
// @author       xykcloud
// @match        *://photos.google.com/*
// @match        *://photos.google.com/share/*
// @match        *://photos.google.com/partner/*
// @match        *://*.googleusercontent.com/*
// @license      GPL v3
// @grant        none
// @run-at       document-start
// @allFrames    true
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
        FIXED_TODAY: ""
    };

    var userSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    var CONFIG = Object.assign({}, DEFAULT_CONFIG, userSettings);

    if (!CONFIG.BASE_PHOTO_LIMIT) CONFIG.BASE_PHOTO_LIMIT = CONFIG.PHOTO_LIMIT;

    var logContainer, tempLastDate = "";

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
        title.textContent = '谷歌相册自动保存助手 v73.0';
        title.style.cssText = 'font-weight:bold; color:#1a73e8; text-align:center; margin-bottom:12px; font-size:15px; user-select:none; border-bottom: 2px solid #eee; padding-bottom: 8px;';
        panel.appendChild(title);

        var settingsForm = document.createElement('div');
        settingsForm.style.cssText = 'display:flex; flex-wrap:wrap; justify-content:space-between; font-size:11px; background:#f8f9fa; padding:10px; border-radius:6px; margin-bottom:12px; border:1px solid #ddd; cursor:default;';

        var fields = [
            {label: '保存进度', key: 'STORAGE_VAL', isDisk: true, w:'48%'},
            {label: '寻址目标', key: 'TARGET_SCROLL_DATE', hint: '', w:'48%'},
            {label: '无图模式', key: 'BLOCK_MEDIA', isToggle: true, w:'32%'},
            {label: '状态高亮', key: 'HIGHLIGHT_STATE', isToggle: true, w:'32%'},
            {key: 'FILE_MODE', isModeSwitch: true, w:'32%'},
            {label: '手动保存', key: 'MANUAL_SAVE', isToggle: true, w:'48%'},
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
            {label: '日期校准', key: 'FIXED_TODAY', w:'48%'}
        ];

        fields.forEach(function(f) {
            var row = document.createElement('div');
            row.style.cssText = `width:${f.w}; margin-bottom:6px; display:flex; align-items:center;`;

            if (f.isModeSwitch) {
                var toggleBtn = document.createElement('button');
                toggleBtn.id = 'gp-mode-toggle-btn';
                var updateBtnStyle = function() {
                    if (CONFIG.FILE_MODE === true) {
                        toggleBtn.style.cssText = 'width:100%; height:24px; border:1px solid #1a73e8; border-radius:4px; background:#1a73e8; color:#fff; font-size:11px; font-weight:bold; cursor:pointer; transition:0.2s;';
                        toggleBtn.textContent = '🗂️ 文件模式';
                    } else {
                        toggleBtn.style.cssText = 'width:100%; height:24px; border:1px solid #34a853; border-radius:4px; background:#e6f4ea; color:#137333; font-size:11px; font-weight:bold; cursor:pointer; transition:0.2s;';
                        toggleBtn.textContent = '📅 日期模式';
                    }
                };
                updateBtnStyle();
                toggleBtn.onclick = function(e) {
                    e.preventDefault(); e.stopPropagation();
                    CONFIG.FILE_MODE = !CONFIG.FILE_MODE;
                    localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
                    updateBtnStyle();
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
                    localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
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
                        addLog("进度设为 -> " + (this.value || "起始"), "#d93025");
                    } else {
                        var val = (f.key === 'FIXED_TODAY' || f.key === 'TARGET_SCROLL_DATE') ? this.value : parseInt(this.value);
                        CONFIG[f.key] = val;
                        if (f.key === 'PHOTO_LIMIT') { CONFIG.BASE_PHOTO_LIMIT = val; localStorage.setItem(LAST_RESULT_KEY, 'none'); }
                        localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
                        addLog(f.label + " -> " + this.value, "#1a73e8");
                    }
                };
                row.appendChild(lblT); row.appendChild(inpT);
            }
            settingsForm.appendChild(row);
        });
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

        var checkedNodesStack = [];

        if (CONFIG.JUST_SCROLL) {
            if (!CONFIG.TARGET_SCROLL_DATE) {
                alert("请输入【寻址目标】日期"); localStorage.setItem(AUTO_RUN_KEY, 'false'); return;
            }
            baseDate = new Date(CONFIG.TARGET_SCROLL_DATE.replace(/\./g, '/'));
        } else {
            if (diskSaved === "") { baseDate = new Date("2099.01.01"); isInfiniteTarget = true; }
            else {
                baseDate = new Date(diskSaved.replace(/\./g, '/'));
                if (!CONFIG.FILE_MODE) baseDate.setDate(baseDate.getDate() + CONFIG.REDUNDANCY_DAYS);
            }
        }

        var targetTS = baseDate.getTime();
        var activeBufferDays = CONFIG.WARP_BUFFER_DAYS;
        var warpThresholdTS = targetTS + (activeBufferDays * 24 * 60 * 60 * 1000);

        tempLastDate = diskSaved;
        var lastList = "", retry = 0;
        var loggedScans = {};

        await new Promise(r => setTimeout(r, 1000));
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

            if (!isInfiniteTarget && minDateInView && (minDateInView > warpThresholdTS)) {
                var showDate = new Date(minDateInView).toLocaleDateString();
                var warpStatusStr = CONFIG.FILE_MODE ? "🚀 全速直达 (" : "🚀 跃迁 (";
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

            if (CONFIG.FILE_MODE) {
                var photos = document.querySelectorAll('.rtIMgb');
                var stat_total = 0, stat_saved = 0, stat_future = 0, stat_clicked = 0;
                var latestScannedFileDate = "";

                for (var i = 0; i < photos.length; i++) {
                    var p = photos[i];
                    var cb = p.querySelector('div[role="checkbox"]');
                    if (!cb) continue;
                    var ariaLabel = cb.getAttribute('aria-label') || "";
                    var shortLog = (ariaLabel.split('-').pop() || "").trim();
                    latestScannedFileDate = shortLog;
                    var dObj = parseDate(ariaLabel);
                    stat_total++;

                    if (dObj && dObj.getTime() <= targetTS) {
                        var isSaved = p.querySelector('.Q3N5Kd svg') !== null;
                        if (isSaved) { stat_saved++; }
                        else {
                            if (cb.getAttribute('aria-checked') === 'false') {
                                stat_clicked++;
                                addLog("[排雷勾选] " + shortLog, "#34a853");
                                updateUIStatus(shadow, "🎯 锁定: " + shortLog, getCount(), CONFIG.PHOTO_LIMIT);
                                var evts = ['mouseover', 'mousedown', 'mouseup', 'click'];
                                evts.forEach(t => cb.dispatchEvent(new MouseEvent(t, {bubbles: true})));

                                var aTag = p.querySelector('a.p137Zd');
                                var hrefId = aTag ? aTag.getAttribute('href') : null;
                                checkedNodesStack.push({ type: 'file', id: hrefId, dateStr: shortLog, dObj: dObj });

                                tempLastDate = dObj.getFullYear() + '.' + (dObj.getMonth() + 1) + '.' + dObj.getDate();
                                await new Promise(r => setTimeout(r, CONFIG.ACTION_SPEED));
                                if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') return;
                                if (getCount() >= CONFIG.PHOTO_LIMIT) break;
                            }
                        }
                    } else { stat_future++; }
                }
                if (latestScannedFileDate && stat_clicked === 0) updateUIStatus(shadow, "👁️ 扫视: " + latestScannedFileDate, getCount(), CONFIG.PHOTO_LIMIT);
                if (stat_total > 0 && getCount() < CONFIG.PHOTO_LIMIT) {
                    if (stat_saved > 0 || stat_future > 0) addLog(`雷达: 扫${stat_total}|存${stat_saved}|拦${stat_future}|勾${stat_clicked}`, "#888");
                }
            } else {
                for (var j = 0; j < sections.length; j++) {
                    var s = sections[j], h2 = s.querySelector('h2.ZEmz6b');
                    if (!h2) continue;
                    var dateStr = h2.textContent;
                    updateUIStatus(shadow, "👁️ 扫视: " + dateStr, getCount(), CONFIG.PHOTO_LIMIT);
                    if (!loggedScans[dateStr]) { loggedScans[dateStr] = true; addLog("[扫描] " + dateStr, "#9aa0a6"); }
                    var dObjDate = parseDate(dateStr);
                    if (dObjDate && dObjDate.getTime() <= targetTS) {
                        var cbDate = s.querySelector('div[role="checkbox"]');
                        if (cbDate && cbDate.getAttribute('aria-checked') === 'false') {
                            addLog("[日期模式] " + dateStr, "#34a853");
                            updateUIStatus(shadow, "🎯 锁定: " + dateStr, getCount(), CONFIG.PHOTO_LIMIT);

                            var dateAriaLabel = cbDate.getAttribute('aria-label');

                            var evtsDate = ['mouseover', 'mousedown', 'mouseup', 'click'];
                            evtsDate.forEach(t => cbDate.dispatchEvent(new MouseEvent(t, {bubbles: true})));

                            checkedNodesStack.push({ type: 'date', id: dateStr, ariaLabel: dateAriaLabel, dateStr: dateStr, dObj: dObjDate });

                            tempLastDate = dObjDate.getFullYear() + '.' + (dObjDate.getMonth() + 1) + '.' + dObjDate.getDate();
                            await new Promise(r => setTimeout(r, CONFIG.ACTION_SPEED));
                            if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') return;
                            if (getCount() >= CONFIG.PHOTO_LIMIT) break;
                        }
                    }
                }
            }

            if (!CONFIG.JUST_SCROLL && getCount() >= CONFIG.PHOTO_LIMIT) break;
            var anchors = document.querySelectorAll('.rtIMgb, .K0a18'), lastA = anchors[anchors.length - 1];
            if (lastA) lastA.scrollIntoView({ behavior: 'auto', block: 'end' });
            else window.scrollBy(0, 1500);
            await new Promise(r => setTimeout(r, CONFIG.SCROLL_WAIT));

            if (currentList === lastList && sections.length > 0) {
                retry++; addLog("触底探测 (" + retry + "/" + CONFIG.MAX_RETRY + ")", "yellow");
                if (retry >= CONFIG.MAX_RETRY) { addLog("物理触底，结算...", "white"); break; }
            } else { retry = 0; lastList = currentList; }
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

            var sBtn = document.querySelector('button[aria-label="保存"]');
            if (sBtn) {
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
                        if (CONFIG.FILE_MODE && tempLastDate !== "") {
                            var arr = tempLastDate.split('.');
                            if (arr.length === 3) {
                                var tempD = new Date(parseInt(arr[0]), parseInt(arr[1]) - 1, parseInt(arr[2]));
                                tempD.setDate(tempD.getDate() + 1);
                                dateToSave = tempD.getFullYear() + '.' + (tempD.getMonth() + 1) + '.' + tempD.getDate();
                            }
                        }
                        localStorage.setItem(STORAGE_KEY, dateToSave);
                        if (lastRes === 'fail' && !isAtBase) CONFIG.PHOTO_LIMIT = CONFIG.BASE_PHOTO_LIMIT;
                        else if (CONFIG.SUCCESS_ADD_PCT > 0) CONFIG.PHOTO_LIMIT = Math.floor(CONFIG.PHOTO_LIMIT * (1 + CONFIG.SUCCESS_ADD_PCT / 100));
                        localStorage.setItem(LAST_RESULT_KEY, 'success');
                        localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
                        setTimeout(() => window.location.reload(), 1500);
                    }

                    if ((toast && toast.textContent.indexOf("无法添加") !== -1) || (sec >= CONFIG.SAVE_TIMEOUT)) {
                        clearInterval(timer);
                        document.querySelectorAll('.zyTWof-gIZMF').forEach(el => el.remove());

                        if (CONFIG.FILE_MODE && finalCount <= 100) {
                            addLog("严重异常: 数量极低 (" + finalCount + ") 仍保存失败！", "red");
                            localStorage.setItem(AUTO_RUN_KEY, 'false');
                            updateUIStatus(shadow, "❌ 致命异常挂起", finalCount, CONFIG.PHOTO_LIMIT);
                            var btnM = shadow.getElementById('gp-main-run-btn');
                            if (btnM) { btnM.textContent = '全自动运行开始'; btnM.style.background = '#1a73e8'; }
                            alert("⚠️ 严重异常拦截：\n\n勾选的文件数量已降至 100 以下，但仍然无法保存。\n可能是网络阻断或谷歌相册空间已满，任务已强行挂起，请人工检查！");
                            return;
                        }

                        if (!CONFIG.FILE_MODE && checkedNodesStack.length <= 1) {
                            addLog("单日数据超载，准备切换【文件模式】并重启...", "magenta");
                            CONFIG.FILE_MODE = true;
                            localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));

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
                                localStorage.setItem(SETTINGS_KEY, JSON.stringify(CONFIG));
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

                                        // 【修改点1】：极大缩短文件模式视口同步等待，光速取消
                                        var viewSyncWait = CONFIG.FILE_MODE ? Math.max(5, Math.floor(CONFIG.ACTION_SPEED / 10)) : 150;
                                        await new Promise(r => setTimeout(r, viewSyncWait));

                                        var e = ['mouseover', 'mousedown', 'mouseup', 'click'];
                                        e.forEach(t => cbT.dispatchEvent(new MouseEvent(t, {bubbles: true})));

                                        addLog("⏪ 倒序撤销: " + nodeData.dateStr, "orange");
                                        updateUIStatus(shadow, "⏪ 撤销中...", getCount(), CONFIG.PHOTO_LIMIT);

                                        // 【修改点2】：文件模式取消后摇缩短至操作速度的 1/10
                                        var cancelWait = CONFIG.FILE_MODE ? Math.max(5, Math.floor(CONFIG.ACTION_SPEED / 10)) : 600;
                                        await new Promise(r => setTimeout(r, cancelWait));
                                    } else {
                                        addLog("⚠️ 节点已丢失或被回收 (" + nodeData.dateStr + ")", "red");
                                    }
                                }

                                if (localStorage.getItem(AUTO_RUN_KEY) !== 'true') return;

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
        }

        executeSaveSequence();
    }

    var boot = setInterval(function() {
        if (document.body || document.documentElement) { injectUI(); clearInterval(boot); }
    }, 500);
})();
