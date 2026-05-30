// ==UserScript==
// @name         Gemini配额查询/Gemini Quota Query
// @namespace    http://tampermonkey.net/
// @version      2.3.0
// @description  Gemini配额查询/Gemini Quota Query，https://github.com/xykcloud/TampermonkeyScript
// @author       xykcloud
// @match        https://gemini.google.com/*
// @grant        none
// @license      GPL v3
// ==/UserScript==
 
(function () {
    'use strict';
 
    var CACHE_KEY        = 'gemini_quota_v7';
    var SKIN_KEY         = 'gemini_quota_skin';
    var INTERVAL_KEY     = 'gemini_quota_interval';
    var WIDGET_ID        = 'gq-monitor-v32';
    var POLL_MAX         = 40;
    var INTERVAL_OPTIONS = [1, 2, 3, 5, 10, 0];
 
    var autoTimer      = null;
    var uiRefreshTimer = null;
    var countdownSecs  = 0;
    var _lastState     = 'nodata';
    var _lastData      = null;
 
    /* ── 字体：微软雅黑优先，降级到系统中英文默认字体 ── */
    var FONT = '"Microsoft YaHei","微软雅黑","PingFang SC","Hiragino Sans GB","WenQuanYi Micro Hei",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';
 
    /* ── 语言 ── */
    function isZh() {
        var lang = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
        return lang.startsWith('zh');
    }
 
    var ZH  = isZh();
    var COL = ZH ? '：' : ': ';
 
    var T = {
        title:       ZH ? 'Gemini 配额'         : 'Gemini Quota',
        loading:     ZH ? '读取中…'             : 'Loading…',
        nodata:      ZH ? '暂无数据，点击↻获取'  : 'No data, click ↻',
        refresh:     ZH ? '立即刷新'             : 'Refresh now',
        current:     ZH ? '当前用量'             : 'Current',
        weekly:      ZH ? '每周限额'             : 'Weekly',
        resetLabel:  ZH ? '重置时间' + COL       : 'Resets' + COL,
        justNow:     ZH ? '刚刚更新'             : 'Just updated',
        minutesAgo:  ZH ? ' 分钟前'              : ' min ago',
        toggleSkin:  ZH ? '切换皮肤'             : 'Toggle skin',
        timerSetting:ZH ? '切换刷新周期'         : 'Cycle interval',
        timerOff:    ZH ? '关'                   : 'OFF',
        timerMin:    ZH ? '分钟'                 : 'min',
        cdLabel:     ZH ? '刷新倒计时' + COL     : 'Next refresh' + COL,
        autoRefOff:  ZH ? '自动刷新' + COL + '关': 'Auto refresh: OFF'
    };
 
    /* ── 工具 ── */
    // 优先检测 Gemini 自身的 body class（dark-theme / light-theme），降级到系统 prefers-color-scheme
    function isDark() {
        var body = document.body;
        if (body) {
            if (body.classList.contains('dark-theme'))  return true;
            if (body.classList.contains('light-theme')) return false;
        }
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    function getAccountIndex() {
        var m = location.pathname.match(/^\/u\/(\d+)/);
        return m ? m[1] : null;
    }
    function isUsagePage() {
        return location.pathname.includes('/usage');
    }
    function getUsageUrl() {
        var idx = getAccountIndex();
        return idx !== null
            ? 'https://gemini.google.com/u/' + idx + '/usage'
            : 'https://gemini.google.com/usage';
    }
    function getCached(key) {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
    }
    function getSkinMode() {
        return localStorage.getItem(SKIN_KEY) || 'standard';
    }
    function getRefreshIntervalMinutes() {
        var val = localStorage.getItem(INTERVAL_KEY);
        if (val === null) return 1;
        return parseInt(val, 10);
    }
    function fmtCountdown(secs) {
        if (secs <= 0) return '00:00';
        var m = Math.floor(secs / 60);
        var s = secs % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
 
    /* ── DOM 工厂 ── */
    function mkDiv()  { return document.createElement('div'); }
    function mkSpan() { return document.createElement('span'); }
    function setText(el, txt) { el.textContent = txt; return el; }
 
    function createHollowShirtIcon() {
        var ns  = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '13');
        svg.setAttribute('height', '13');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M20.38 3.46L16 2a4 4 0 01-8 0L3.62 3.46a2 2 0 00-1.34 2.23l.58 3.47a1 1 0 00.99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 002-2V10h2.15a1 1 0 00.99-.84l.58-3.47a2 2 0 00-1.34-2.23z');
        svg.appendChild(path);
        return svg;
    }
 
    /* ══════════════════════════════════════════════
       Usage 页面解析
    ══════════════════════════════════════════════ */
    function readFromDOM() {
        var container = document.querySelector('.gxu-items-container');
        if (!container) return null;
        var text = container.innerText || container.textContent || '';
        var isChinese = text.includes('已使用') && text.includes('重置时间');
        var isEnglish = /\d+%\s*used/i.test(text) && /resets/i.test(text);
        if (!isChinese && !isEnglish) return null;
 
        var cu = '—', cr = '—', wu = '—', wr = '—';
 
        function extractFromBlock(block) {
            if (!block) return { usage: '—', reset: '—' };
            var t = block.innerText || block.textContent || '';
            var usage = '—', reset = '—';
            if (isChinese) {
                var um = t.match(/已使用\s*(\d+%)/);
                var rm = t.match(/重置时间[：:]\s*([^\n]+)/);
                if (um) usage = um[1];
                if (rm) reset = rm[1].trim();
            } else {
                var um2 = t.match(/(\d+%)\s*used/i);
                var rm2 = t.match(/resets?(?:\s+on|\s+in)?\s*([^\n]+)/i);
                if (um2) usage = um2[1];
                if (rm2) reset = rm2[1].trim();
            }
            return { usage: usage, reset: reset };
        }
 
        var currentBlock = container.querySelector('.gxu-currently');
        var weeklyBlock  = container.querySelector('.gxu-weekly') ||
                           container.querySelector('[class*="gxu-item"]:not(.gxu-currently)');
 
        if (currentBlock || weeklyBlock) {
            var cur = extractFromBlock(currentBlock);
            var wkl = extractFromBlock(weeklyBlock);
            cu = cur.usage; cr = cur.reset;
            wu = wkl.usage; wr = wkl.reset;
        } else {
            if (isChinese) {
                var um1 = text.match(/已使用\s*(\d+%)/g) || [];
                var rm1 = text.match(/重置时间[：:]\s*([^\n]+)/g) || [];
                if (um1[0]) cu = um1[0].replace(/已使用\s*/, '');
                if (um1[1]) wu = um1[1].replace(/已使用\s*/, '');
                if (rm1[0]) cr = rm1[0].replace(/重置时间[：:]\s*/, '').trim();
                if (rm1[1]) wr = rm1[1].replace(/重置时间[：:]\s*/, '').trim();
            } else {
                var um3 = text.match(/(\d+%)\s*used/gi) || [];
                var rm3 = text.match(/resets?(?:\s+on|\s+in)?\s*([^\n]+)/gi) || [];
                if (um3[0]) cu = (um3[0].match(/(\d+%)/) || [])[1] || '—';
                if (um3[1]) wu = (um3[1].match(/(\d+%)/) || [])[1] || '—';
                if (rm3[0]) cr = rm3[0].replace(/resets?(?:\s+on|\s+in)?\s*/i, '').trim();
                if (rm3[1]) wr = rm3[1].replace(/resets?(?:\s+on|\s+in)?\s*/i, '').trim();
            }
        }
 
        if (cu === '—' && wu === '—') return null;
        return { cu: cu, cr: cr, wu: wu, wr: wr, ts: Date.now() };
    }
 
    function runOnUsagePage() {
        if (location.hash === '#gq-auto') {
            try {
                window.resizeTo(1, 1);
                window.moveTo(99999, 99999);
                window.blur();
                var bg = setInterval(function () { window.blur(); }, 200);
                setTimeout(function () { clearInterval(bg); }, 20000);
            } catch (e) {}
        }
        var attempts = 0;
        var timer = setInterval(function () {
            attempts++;
            var container = document.querySelector('.gxu-items-container');
            if (container) {
                var text = container.innerText || '';
                var ready = (text.includes('已使用') && text.includes('重置时间')) ||
                            (/\d+%\s*used/i.test(text) && /resets/i.test(text));
                if (ready) {
                    clearInterval(timer);
                    var data = readFromDOM();
                    if (data) localStorage.setItem(CACHE_KEY, JSON.stringify(data));
                    if (location.hash === '#gq-auto') setTimeout(function () { window.close(); }, 300);
                    return;
                }
            }
            if (attempts >= POLL_MAX) {
                clearInterval(timer);
                if (location.hash === '#gq-auto') window.close();
            }
        }, 500);
    }
 
    /* ══════════════════════════════════════════════
       后台弹窗刷新
    ══════════════════════════════════════════════ */
    function openUsageWindow() {
        var beforeTs = 0;
        var c = getCached(CACHE_KEY);
        if (c) beforeTs = c.ts;
 
        var features = [
            'width=1', 'height=1', 'left=99999', 'top=99999',
            'toolbar=no', 'menubar=no', 'scrollbars=no', 'resizable=no',
            'status=no', 'location=no', 'alwaysLowered=yes', 'alwaysRaised=no'
        ].join(',');
 
        var tab = window.open(getUsageUrl() + '#gq-auto', '_blank', features);
        if (tab) {
            try { tab.blur(); window.focus(); } catch (e) {}
            try {
                tab.onload = function () {
                    try { tab.resizeTo(1,1); tab.moveTo(99999,99999); tab.blur(); window.focus(); } catch(e) {}
                };
            } catch (e) {}
            var fg = setInterval(function () {
                try {
                    if (tab.closed) { clearInterval(fg); return; }
                    tab.blur(); window.focus();
                } catch (e) { clearInterval(fg); }
            }, 300);
            setTimeout(function () { clearInterval(fg); }, 25000);
        } else {
            window.open(getUsageUrl() + '#gq-auto', '_blank');
        }
 
        render('loading', null);
 
        var attempts = 0;
        var poll = setInterval(function () {
            attempts++;
            var d = getCached(CACHE_KEY);
            if (d && d.ts > beforeTs) {
                clearInterval(poll);
                render('ok', d);
                scheduleNext();
                return;
            }
            if (attempts > POLL_MAX) {
                clearInterval(poll);
                var latest = getCached(CACHE_KEY);
                render(latest ? 'ok' : 'nodata', latest);
                scheduleNext();
            }
        }, 500);
    }
 
    /* ── 定时器与倒计时 ── */
    function scheduleNext() {
        if (autoTimer)      { clearTimeout(autoTimer);       autoTimer      = null; }
        if (uiRefreshTimer) { clearInterval(uiRefreshTimer); uiRefreshTimer = null; }
 
        var intervalMins = getRefreshIntervalMinutes();
        if (intervalMins === 0) {
            countdownSecs = 0;
            updateCountdownDisplay();
            return;
        }
 
        countdownSecs = intervalMins * 60;
        updateCountdownDisplay();
 
        uiRefreshTimer = setInterval(function () {
            if (countdownSecs > 0) countdownSecs--;
            updateCountdownDisplay();
        }, 1000);
 
        autoTimer = setTimeout(function () {
            if (uiRefreshTimer) { clearInterval(uiRefreshTimer); uiRefreshTimer = null; }
            openUsageWindow();
        }, intervalMins * 60 * 1000);
    }
 
    function updateCountdownDisplay() {
        var intervalMins = getRefreshIntervalMinutes();
 
        var cdStd = document.getElementById('gq-countdown');
        if (cdStd) {
            setText(cdStd, intervalMins === 0
                ? T.autoRefOff
                : T.cdLabel + fmtCountdown(countdownSecs));
        }
 
        var cdMin = document.getElementById('gq-countdown-min');
        if (cdMin) {
            setText(cdMin, intervalMins === 0
                ? T.timerOff
                : fmtCountdown(countdownSecs));
        }
 
        var ageNode = document.getElementById('gq-age-text');
        if (ageNode && _lastData) {
            var age = Math.round((Date.now() - _lastData.ts) / 60000);
            setText(ageNode, age < 1 ? T.justNow : (age + T.minutesAgo));
        }
    }
 
    /* ── 皮肤 & 周期切换 ── */
    function toggleSkinMode() {
        localStorage.setItem(SKIN_KEY, getSkinMode() === 'standard' ? 'minimal' : 'standard');
        render(_lastState, _lastData);
    }
 
    function cycleRefreshInterval() {
        var cur = getRefreshIntervalMinutes();
        var idx = INTERVAL_OPTIONS.indexOf(cur);
        if (idx === -1) idx = 0;
        localStorage.setItem(INTERVAL_KEY, INTERVAL_OPTIONS[(idx + 1) % INTERVAL_OPTIONS.length]);
        scheduleNext();
        render(_lastState, _lastData);
    }
 
    /* ── 按钮组 ── */
    function createActionControls(theme) {
        var group = mkDiv();
        group.style.display    = 'flex';
        group.style.alignItems = 'center';
        group.style.gap        = '8px';
        group.style.userSelect = 'none';
        group.style.flexShrink = '0';
 
        var intervalMins = getRefreshIntervalMinutes();
        var timerLabel   = intervalMins === 0 ? T.timerOff : intervalMins + T.timerMin;
 
        var timerBtn = mkSpan();
        timerBtn.style.cursor     = 'pointer';
        timerBtn.style.fontSize   = '13px';
        timerBtn.style.color      = theme.textSub;
        timerBtn.style.fontFamily = FONT;
        setText(timerBtn, '⏱');
        timerBtn.title   = T.timerSetting + ' (' + timerLabel + ')';
        timerBtn.onclick = cycleRefreshInterval;
 
        var skinBtn = mkSpan();
        skinBtn.style.cursor     = 'pointer';
        skinBtn.style.color      = theme.textSub;
        skinBtn.style.display    = 'flex';
        skinBtn.style.alignItems = 'center';
        skinBtn.title   = T.toggleSkin;
        skinBtn.onclick = toggleSkinMode;
        skinBtn.appendChild(createHollowShirtIcon());
 
        var refreshBtn = mkSpan();
        refreshBtn.style.cursor     = 'pointer';
        refreshBtn.style.fontSize   = '15px';
        refreshBtn.style.color      = theme.textSub;
        refreshBtn.style.fontFamily = FONT;
        setText(refreshBtn, '↻');
        refreshBtn.title   = T.refresh;
        refreshBtn.onclick = openUsageWindow;
 
        group.appendChild(timerBtn);
        group.appendChild(skinBtn);
        group.appendChild(refreshBtn);
        return group;
    }
 
    /* ══════════════════════════════════════════════
       标准皮肤
    ══════════════════════════════════════════════ */
    function buildStandardView(w, state, data, theme) {
        var dark = isDark();
 
        w.style.position      = 'fixed';
        w.style.bottom        = '20px';
        w.style.right         = '20px';
        w.style.minWidth      = '200px';
        w.style.maxWidth      = '240px';
        w.style.background    = dark ? 'rgba(60,60,65,0.96)' : 'rgba(255,255,255,0.98)';
        w.style.color         = dark ? '#ffffff' : '#1c1c1e';
        w.style.border        = '1px solid ' + theme.border;
        w.style.borderRadius  = '12px';
        w.style.padding       = '10px 14px';
        w.style.fontFamily    = FONT;
        w.style.fontSize      = '13px';
        w.style.lineHeight    = '1.6';
        w.style.boxShadow     = '0 4px 16px ' + (dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.08)');
        w.style.zIndex        = '2147483647';
        w.style.display       = 'flex';
        w.style.flexDirection = 'column';
        w.style.gap           = '0px';
 
        /* 第一行：标题左，按钮组右 */
        var hd = mkDiv();
        hd.style.display        = 'flex';
        hd.style.justifyContent = 'space-between';
        hd.style.alignItems     = 'center';
        hd.style.paddingBottom  = '8px';
        hd.style.marginBottom   = '4px';
        hd.style.borderBottom   = '1px solid ' + theme.border;
 
        var title = mkSpan();
        title.style.fontSize   = '13px';
        title.style.color      = theme.textMain;
        title.style.fontFamily = FONT;
        setText(title, T.title);
 
        hd.appendChild(title);
        hd.appendChild(createActionControls(theme));
        w.appendChild(hd);
 
        /* 状态行 */
        if (state === 'loading' || state === 'nodata') {
            var msg = mkDiv();
            msg.style.color      = theme.textSub;
            msg.style.fontSize   = '12px';
            msg.style.fontFamily = FONT;
            msg.style.padding    = '8px 0';
            msg.style.textAlign  = 'center';
            setText(msg, state === 'loading' ? T.loading : T.nodata);
            w.appendChild(msg);
            return;
        }
 
        /*
         * 数据行布局（标准皮肤）：
         *
         * 当前用量：          68%
         * 重置：01:55
         *
         * 每周限额：          11%
         * 重置：5月27日11:55
         */
        function addRow(label, val, resetVal) {
            /* 主行：标签名左，百分比右，两端对齐 */
            var row = mkDiv();
            row.style.display        = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.alignItems     = 'baseline';
            row.style.marginTop      = '6px';
 
            var lb = mkSpan();
            lb.style.color      = theme.textMain;
            lb.style.fontSize   = '13px';
            lb.style.fontFamily = FONT;
            setText(lb, label + COL);
 
            var vl = mkSpan();
            vl.style.fontWeight = '700';
            vl.style.fontSize   = '15px';
            vl.style.color      = theme.accent;
            vl.style.fontFamily = FONT;
            setText(vl, val);
 
            row.appendChild(lb);
            row.appendChild(vl);
            w.appendChild(row);
 
            /* 重置时间行：左对齐 */
            var rs = mkDiv();
            rs.style.fontSize   = '11px';
            rs.style.color      = theme.textSub;
            rs.style.fontFamily = FONT;
            rs.style.marginTop  = '1px';
            rs.style.marginBottom = '2px';
            setText(rs, T.resetLabel + resetVal);
            w.appendChild(rs);
        }
 
        if (state === 'ok' && data) {
            addRow(T.current, data.cu, data.cr);
            addRow(T.weekly,  data.wu, data.wr);
 
            /* 分割线 */
            var divider = mkDiv();
            divider.style.borderTop  = '1px solid ' + theme.border;
            divider.style.marginTop  = '8px';
            divider.style.paddingTop = '6px';
            w.appendChild(divider);
 
            /* 底部：更新时间（左）+ 刷新倒计时（右） */
            var footer = mkDiv();
            footer.style.display        = 'flex';
            footer.style.justifyContent = 'space-between';
            footer.style.alignItems     = 'center';
 
            var ageSpan = mkSpan();
            ageSpan.id             = 'gq-age-text';
            ageSpan.style.fontSize = '11px';
            ageSpan.style.color    = theme.textSub;
            ageSpan.style.fontFamily = FONT;
            var age = Math.round((Date.now() - data.ts) / 60000);
            setText(ageSpan, age < 1 ? T.justNow : (age + T.minutesAgo));
 
            var cdSpan = mkSpan();
            cdSpan.id              = 'gq-countdown';
            cdSpan.style.fontSize  = '11px';
            cdSpan.style.color     = theme.textSub;
            cdSpan.style.fontFamily = FONT;
            var iMins = getRefreshIntervalMinutes();
            setText(cdSpan, iMins === 0
                ? T.autoRefOff
                : T.cdLabel + fmtCountdown(countdownSecs));
 
            footer.appendChild(ageSpan);
            footer.appendChild(cdSpan);
            w.appendChild(footer);
        }
    }
 
    /* ══════════════════════════════════════════════
       极简皮肤
       格式：当前用量：68%|01:55|每周限额：11%|5月27日11:55|1 分钟前|XX:XX|按钮
    ══════════════════════════════════════════════ */
    function buildMinimalView(w, state, data, theme) {
        var dark = isDark();
 
        w.style.position      = 'fixed';
        w.style.bottom        = '20px';
        w.style.right         = '20px';
        w.style.background    = dark ? 'rgba(60,60,65,0.96)' : 'rgba(255,255,255,0.98)';
        w.style.color         = dark ? '#ffffff' : '#1c1c1e';
        w.style.border        = '1px solid ' + theme.border;
        w.style.borderRadius  = '20px';
        w.style.padding       = '5px 12px';
        w.style.fontFamily    = FONT;
        w.style.fontSize      = '11px';
        w.style.boxShadow     = '0 4px 14px ' + (dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)');
        w.style.zIndex        = '2147483647';
        w.style.display       = 'flex';
        w.style.flexDirection = 'row';
        w.style.flexWrap      = 'nowrap';
        w.style.whiteSpace    = 'nowrap';
        w.style.alignItems    = 'center';
        w.style.gap           = '0px';
        w.style.minWidth      = 'auto';
        w.style.maxWidth      = 'none';
        w.style.width         = 'auto';
        w.style.height        = 'auto';
 
        function mkSep() {
            var s = mkSpan();
            s.style.display    = 'inline-block';
            s.style.margin     = '0 5px';
            s.style.color      = theme.border;
            s.style.flexShrink = '0';
            setText(s, '|');
            return s;
        }
 
        function mkPiece(txt, color) {
            var s = mkSpan();
            s.style.color       = color || theme.textSub;
            s.style.flexShrink  = '0';
            s.style.fontFamily  = FONT;
            setText(s, txt);
            return s;
        }
 
        if (state === 'loading' || state === 'nodata') {
            w.appendChild(mkPiece(state === 'loading' ? T.loading : T.nodata, theme.textSub));
            w.appendChild(mkSep());
            w.appendChild(createActionControls(theme));
            return;
        }
 
        if (state === 'ok' && data) {
            /* 当前用量：68% */
            w.appendChild(mkPiece(T.current + COL, theme.textSub));
            w.appendChild(mkPiece(data.cu, theme.accent));
            w.appendChild(mkSep());
 
            /* 01:55 */
            w.appendChild(mkPiece(data.cr, theme.textSub));
            w.appendChild(mkSep());
 
            /* 每周限额：11% */
            w.appendChild(mkPiece(T.weekly + COL, theme.textSub));
            w.appendChild(mkPiece(data.wu, theme.accent));
            w.appendChild(mkSep());
 
            /* 5月27日11:55 */
            w.appendChild(mkPiece(data.wr, theme.textSub));
            w.appendChild(mkSep());
 
            /* 1 分钟前 */
            var ageSpan = mkSpan();
            ageSpan.id              = 'gq-age-text';
            ageSpan.style.color     = theme.textSub;
            ageSpan.style.flexShrink = '0';
            ageSpan.style.fontFamily = FONT;
            var age = Math.round((Date.now() - data.ts) / 60000);
            setText(ageSpan, age < 1 ? T.justNow : (age + T.minutesAgo));
            w.appendChild(ageSpan);
            w.appendChild(mkSep());
 
            /* XX:XX（倒计时，仅数字） */
            var cdSpan = mkSpan();
            cdSpan.id               = 'gq-countdown-min';
            cdSpan.style.color      = theme.textSub;
            cdSpan.style.flexShrink = '0';
            cdSpan.style.fontFamily = FONT;
            var iMins = getRefreshIntervalMinutes();
            setText(cdSpan, iMins === 0 ? T.timerOff : fmtCountdown(countdownSecs));
            w.appendChild(cdSpan);
            w.appendChild(mkSep());
        }
 
        w.appendChild(createActionControls(theme));
    }
 
    /* ══════════════════════════════════════════════
       主渲染入口
    ══════════════════════════════════════════════ */
    function render(state, data) {
        _lastState = state;
        _lastData  = data;
 
        var dark  = isDark();
        var theme = {
            textMain: dark ? '#ffffff'  : '#1c1c1e',
            textSub:  dark ? '#c8c8cc'  : '#6e6e73',
            accent:   dark ? '#64d2ff'  : '#007aff',
            border:   dark ? '#48484a'  : '#d1d1d6'
        };
 
        var w = document.getElementById(WIDGET_ID);
        if (!w) {
            w = mkDiv();
            w.id = WIDGET_ID;
            document.body.appendChild(w);
        } else {
            while (w.firstChild) w.removeChild(w.firstChild);
            w.removeAttribute('style');
        }
 
        if (getSkinMode() === 'minimal') {
            buildMinimalView(w, state, data, theme);
        } else {
            buildStandardView(w, state, data, theme);
        }
    }
 
    /* ══════════════════════════════════════════════
       启动
    ══════════════════════════════════════════════ */
    function boot() {
        var cached = getCached(CACHE_KEY);
        render(cached ? 'ok' : 'nodata', cached);
        scheduleNext();
 
        window.addEventListener('storage', function (e) {
            if (e.key === CACHE_KEY && e.newValue) {
                try { render('ok', JSON.parse(e.newValue)); } catch (ex) {}
            }
        });
 
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
            render(getCached(CACHE_KEY) ? 'ok' : 'nodata', getCached(CACHE_KEY));
        });
 
        // 监听 Gemini body class 变化（dark-theme / light-theme），实时同步插件配色
        var _lastDark = isDark();
        new MutationObserver(function () {
            var nowDark = isDark();
            if (nowDark !== _lastDark) {
                _lastDark = nowDark;
                render(_lastState, _lastData);
            }
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
 
        var lastPath = location.pathname;
        new MutationObserver(function () {
            if (location.pathname !== lastPath) {
                lastPath = location.pathname;
                if (!isUsagePage() && !document.getElementById(WIDGET_ID)) {
                    render(getCached(CACHE_KEY) ? 'ok' : 'nodata', getCached(CACHE_KEY));
                }
            }
        }).observe(document.body, { childList: true, subtree: true });
 
        setTimeout(openUsageWindow, 800);
    }
 
    /* ── 入口 ── */
    if (window.top !== window.self) {
        if (isUsagePage()) runOnUsagePage();
        return;
    }
 
    if (isUsagePage()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', runOnUsagePage);
        } else {
            runOnUsagePage();
        }
        return;
    }
 
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
 
})();
