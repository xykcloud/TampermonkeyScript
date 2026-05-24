// ==UserScript==
// @name         Gemini配额查询/Gemini Quota Query
// @namespace    http://tampermonkey.net/
// @version      11.0.0
// @description  Gemini 用量查询 / Gemini Quota Query
// @author       JDC
// @match        https://gemini.google.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    var CACHE_KEY     = 'gemini_quota_v7';
    var WIDGET_ID     = 'gq-monitor-v11';
    var AUTO_INTERVAL = 10 * 60 * 1000;
    var POLL_MAX      = 40;
    var autoTimer     = null;

    /* ══════════════════════════════════════════════
       语言检测与文本
    ══════════════════════════════════════════════ */
    function isZh() {
        var lang = (navigator.language || navigator.userLanguage || 'zh').toLowerCase();
        return lang.startsWith('zh');
    }

    var T = {
        title:        isZh() ? 'Gemini 配额'        : 'Gemini Quota',
        loading:      isZh() ? '后台读取中…'         : 'Loading in background…',
        nodata:       isZh() ? '暂无数据，点击 ↻ 获取' : 'No data, click ↻ to fetch',
        refresh:      isZh() ? '立即刷新'             : 'Refresh now',
        current:      isZh() ? '当前用量'             : 'Current Usage',
        weekly:       isZh() ? '每周限额'             : 'Weekly Limit',
        reset:        isZh() ? '重置: '               : 'Resets: ',
        justNow:      isZh() ? '刚刚更新'             : 'Just updated',
        minutesAgo:   isZh() ? ' 分钟前更新'          : ' min ago',
        autoRefresh:  isZh() ? '定时自动刷新'         : 'Auto refresh'
    };

    /* ── 工具 ── */
    function isDark() {
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

    function getCached() {
        try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
    }

    /* ══════════════════════════════════════════════
       usage 页面逻辑（中英双语解析）
    ══════════════════════════════════════════════ */
    function readFromDOM() {
        var container = document.querySelector('.gxu-items-container');
        if (!container) return null;

        var text = container.innerText || container.textContent || '';

        // 中文特征
        var isChinese = text.includes('已使用') && text.includes('重置时间');
        // 英文特征
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
                // 英文："38% used" / "Resets on May 27" / "Resets in 1h"
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
            // 降级：从整体文本顺序提取
            if (isChinese) {
                var usageMatches = text.match(/已使用\s*(\d+%)/g) || [];
                var resetMatches = text.match(/重置时间[：:]\s*([^\n]+)/g) || [];
                if (usageMatches[0]) cu = usageMatches[0].replace(/已使用\s*/, '');
                if (usageMatches[1]) wu = usageMatches[1].replace(/已使用\s*/, '');
                if (resetMatches[0]) cr = resetMatches[0].replace(/重置时间[：:]\s*/, '').trim();
                if (resetMatches[1]) wr = resetMatches[1].replace(/重置时间[：:]\s*/, '').trim();
            } else {
                var usageMatchesEn = text.match(/(\d+%)\s*used/gi) || [];
                var resetMatchesEn = text.match(/resets?(?:\s+on|\s+in)?\s*([^\n]+)/gi) || [];
                if (usageMatchesEn[0]) cu = (usageMatchesEn[0].match(/(\d+%)/) || [])[1] || '—';
                if (usageMatchesEn[1]) wu = (usageMatchesEn[1].match(/(\d+%)/) || [])[1] || '—';
                if (resetMatchesEn[0]) cr = resetMatchesEn[0].replace(/resets?(?:\s+on|\s+in)?\s*/i, '').trim();
                if (resetMatchesEn[1]) wr = resetMatchesEn[1].replace(/resets?(?:\s+on|\s+in)?\s*/i, '').trim();
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
                var blurGuard = setInterval(function () { window.blur(); }, 200);
                setTimeout(function () { clearInterval(blurGuard); }, 20000);
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
                    if (data) {
                        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
                        console.log('[GeminiQuota] 读取成功:', data);
                    }
                    if (location.hash === '#gq-auto') {
                        setTimeout(function () { window.close(); }, 300);
                    }
                    return;
                }
            }
            if (attempts >= POLL_MAX) {
                clearInterval(timer);
                console.warn('[GeminiQuota] usage 页面等待超时');
                if (location.hash === '#gq-auto') { window.close(); }
            }
        }, 500);
    }

    /* ══════════════════════════════════════════════
       主页面：后台弹窗刷新（多重隐藏）
    ══════════════════════════════════════════════ */
    function openUsageWindow() {
        var beforeTs = 0;
        var c = getCached();
        if (c) beforeTs = c.ts;

        var features = [
            'width=1',
            'height=1',
            'left=99999',
            'top=99999',
            'toolbar=no',
            'menubar=no',
            'scrollbars=no',
            'resizable=no',
            'status=no',
            'location=no',
            'alwaysLowered=yes',
            'alwaysRaised=no'
        ].join(',');

        var tab = window.open(getUsageUrl() + '#gq-auto', '_blank', features);

        if (tab) {
            // A：立即失焦
            try { tab.blur(); window.focus(); } catch (e) {}

            // B：加载完成后再次强制移位
            try {
                tab.onload = function () {
                    try {
                        tab.resizeTo(1, 1);
                        tab.moveTo(99999, 99999);
                        tab.blur();
                        window.focus();
                    } catch (e) {}
                };
            } catch (e) {}

            // C：持续保持主窗口焦点
            var focusGuard = setInterval(function () {
                try {
                    if (tab.closed) { clearInterval(focusGuard); return; }
                    tab.blur();
                    window.focus();
                } catch (e) { clearInterval(focusGuard); }
            }, 300);
            setTimeout(function () { clearInterval(focusGuard); }, 25000);

        } else {
            window.open(getUsageUrl() + '#gq-auto', '_blank');
        }

        render('loading', null);

        var attempts = 0;
        var poll = setInterval(function () {
            attempts++;
            var d = getCached();
            if (d && d.ts > beforeTs) {
                clearInterval(poll);
                render('ok', d);
                scheduleNext();
                return;
            }
            if (attempts > POLL_MAX) {
                clearInterval(poll);
                var latest = getCached();
                render(latest ? 'ok' : 'nodata', latest);
                console.warn('[GeminiQuota] 等待新数据超时');
            }
        }, 500);
    }

    function scheduleNext() {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(function () {
            console.log('[GeminiQuota] ' + T.autoRefresh);
            openUsageWindow();
        }, AUTO_INTERVAL);
    }

    /* ══════════════════════════════════════════════
       DOM 工厂
    ══════════════════════════════════════════════ */
    function mkDiv()  { return document.createElement('div'); }
    function mkSpan() { return document.createElement('span'); }
    function setText(el, txt) { el.textContent = txt; return el; }

    function applyWidgetStyle(el, dark) {
        el.style.position      = 'fixed';
        el.style.bottom        = '20px';
        el.style.right         = '20px';
        el.style.minWidth      = '210px';
        el.style.maxWidth      = '260px';
        el.style.background    = dark ? 'rgba(28,28,30,0.93)' : 'rgba(255,255,255,0.97)';
        el.style.color         = dark ? '#f2f2f7' : '#1c1c1e';
        el.style.border        = '1px solid ' + (dark ? '#3a3a3c' : '#d1d1d6');
        el.style.borderRadius  = '14px';
        el.style.padding       = '14px 16px';
        el.style.fontFamily    = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
        el.style.fontSize      = '13px';
        el.style.lineHeight    = '1.5';
        el.style.boxShadow     = '0 6px 24px ' + (dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.12)');
        el.style.zIndex        = '2147483647';
        el.style.display       = 'flex';
        el.style.flexDirection = 'column';
        el.style.gap           = '6px';
    }

    /* ══════════════════════════════════════════════
       渲染 Widget
    ══════════════════════════════════════════════ */
    function render(state, data) {
        var dark     = isDark();
        var textMain = dark ? '#f2f2f7' : '#1c1c1e';
        var textSub  = dark ? '#8e8e93' : '#6e6e73';
        var accent   = dark ? '#64d2ff' : '#007aff';
        var border   = dark ? '#3a3a3c' : '#d1d1d6';

        var w = document.getElementById(WIDGET_ID);
        if (!w) {
            w = mkDiv();
            w.id = WIDGET_ID;
            applyWidgetStyle(w, dark);
            document.body.appendChild(w);
        } else {
            while (w.firstChild) w.removeChild(w.firstChild);
            applyWidgetStyle(w, dark);
        }

        /* 标题栏 */
        var hd = mkDiv();
        hd.style.display        = 'flex';
        hd.style.justifyContent = 'space-between';
        hd.style.alignItems     = 'center';
        hd.style.paddingBottom  = '8px';
        hd.style.borderBottom   = '1px solid ' + border;

        var title = mkSpan();
        title.style.fontWeight = '600';
        title.style.fontSize   = '13px';
        title.style.color      = textMain;
        setText(title, T.title);

        var btn = mkSpan();
        btn.style.cursor     = 'pointer';
        btn.style.fontSize   = '15px';
        btn.style.color      = textSub;
        btn.style.userSelect = 'none';
        setText(btn, '↻');
        btn.title   = T.refresh;
        btn.onclick = function () { openUsageWindow(); };

        hd.appendChild(title);
        hd.appendChild(btn);
        w.appendChild(hd);

        /* 状态内容 */
        if (state === 'loading') {
            var ld = mkDiv();
            ld.style.color     = textSub;
            ld.style.fontSize  = '12px';
            ld.style.padding   = '8px 0';
            ld.style.textAlign = 'center';
            setText(ld, T.loading);
            w.appendChild(ld);
            return;
        }

        if (state === 'nodata') {
            var nd = mkDiv();
            nd.style.color     = textSub;
            nd.style.fontSize  = '12px';
            nd.style.padding   = '8px 0';
            nd.style.textAlign = 'center';
            setText(nd, T.nodata);
            w.appendChild(nd);
            return;
        }

        /* 数据行 */
        function addRow(label, val, reset) {
            var wrap = mkDiv();
            wrap.style.display       = 'flex';
            wrap.style.flexDirection = 'column';
            wrap.style.gap           = '1px';

            var top = mkDiv();
            top.style.display        = 'flex';
            top.style.justifyContent = 'space-between';
            top.style.alignItems     = 'baseline';

            var lb = mkSpan();
            lb.style.color    = textSub;
            lb.style.fontSize = '12px';
            setText(lb, label);

            var vl = mkSpan();
            vl.style.fontWeight = '600';
            vl.style.fontSize   = '14px';
            vl.style.color      = accent;
            setText(vl, val);

            top.appendChild(lb);
            top.appendChild(vl);

            var rs = mkDiv();
            rs.style.color    = textSub;
            rs.style.fontSize = '11px';
            setText(rs, T.reset + reset);

            wrap.appendChild(top);
            wrap.appendChild(rs);
            w.appendChild(wrap);
        }

        if (state === 'ok' && data) {
            addRow(T.current, data.cu, data.cr);
            addRow(T.weekly,  data.wu, data.wr);

            var age = Math.round((Date.now() - data.ts) / 60000);
            var ageStr = age < 1 ? T.justNow : (age + T.minutesAgo);

            var ts = mkDiv();
            ts.style.fontSize  = '10px';
            ts.style.color     = textSub;
            ts.style.textAlign = 'right';
            ts.style.marginTop = '2px';
            setText(ts, ageStr);
            w.appendChild(ts);
        }
    }

    /* ══════════════════════════════════════════════
       主页面启动
    ══════════════════════════════════════════════ */
    function boot() {
        var cached = getCached();
        render(cached ? 'ok' : 'nodata', cached);

        window.addEventListener('storage', function (e) {
            if (e.key === CACHE_KEY && e.newValue) {
                try { render('ok', JSON.parse(e.newValue)); } catch (ex) {}
            }
        });

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
            render(getCached() ? 'ok' : 'nodata', getCached());
        });

        var lastPath = location.pathname;
        new MutationObserver(function () {
            if (location.pathname !== lastPath) {
                lastPath = location.pathname;
                if (!isUsagePage() && !document.getElementById(WIDGET_ID)) {
                    render(getCached() ? 'ok' : 'nodata', getCached());
                }
            }
        }).observe(document.body, { childList: true, subtree: true });

        if (!cached) {
            setTimeout(openUsageWindow, 800);
        } else {
            scheduleNext();
        }
    }

    /* ══════════════════════════════════════════════
       入口
    ══════════════════════════════════════════════ */
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
