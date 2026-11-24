export const HUD_CSS = /* css */ `
#ui {
  position: fixed; inset: 0; pointer-events: none; z-index: 10; color: #eef3f8;
  font-family: -apple-system, 'SF Pro Display', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  --accent: #2ec8de; --accent-2: #1ba3bc; --warn: #ffb547;
  --panel: rgba(9, 13, 22, 0.58); --line: rgba(255, 255, 255, 0.1);
  -webkit-font-smoothing: antialiased; user-select: none;
}
#ui .num { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; }
#ui .hidden { display: none !important; }
#ui .panel {
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
}
#ui .label { font-size: 11px; letter-spacing: 0.14em; color: rgba(238, 243, 248, 0.55); text-transform: uppercase; }

/* ---------- overlays (menu / result) ---------- */
#ui .screen {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 50% 60%, rgba(6, 9, 16, 0.2), rgba(6, 9, 16, 0.78));
  pointer-events: auto; animation: szd-fade 0.35s ease-out;
}
#ui .card { width: min(560px, 92vw); padding: 34px 38px 30px; text-align: center; }
#ui .title { margin: 0; font-size: 40px; font-weight: 800; letter-spacing: 0.08em; line-height: 1.1; }
#ui .title em { font-style: normal; color: var(--accent); }
#ui .title .sep { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
#ui .subtitle { display: block; margin-top: 10px; font-size: 22px; font-weight: 600; letter-spacing: 0.3em; color: rgba(238, 243, 248, 0.9); }
#ui .route {
  margin: 22px auto 0; display: inline-flex; align-items: center; gap: 10px; padding: 8px 16px;
  border-radius: 999px; background: rgba(46, 200, 222, 0.12); border: 1px solid rgba(46, 200, 222, 0.35); font-size: 14px;
}
#ui .route .arrow { color: var(--accent); }
#ui .controls { margin: 24px 0 0; display: grid; grid-template-columns: auto auto; gap: 8px 18px; justify-content: center; text-align: left; font-size: 14px; color: rgba(238, 243, 248, 0.8); }
#ui .controls .keys { text-align: right; }
#ui kbd {
  display: inline-block; min-width: 22px; padding: 2px 6px; margin: 0 2px; border-radius: 6px; text-align: center;
  font: 600 12px/18px -apple-system, 'Segoe UI', sans-serif; color: #fff;
  background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.22); border-bottom-width: 2px;
}
#ui .best { margin-top: 20px; font-size: 14px; color: rgba(238, 243, 248, 0.7); min-height: 20px; }
#ui .best b { color: #fff; font-weight: 700; }
#ui .btn {
  margin-top: 22px; padding: 13px 54px; border: 0; border-radius: 999px; cursor: pointer;
  font: 700 17px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; letter-spacing: 0.2em; color: #04141a;
  background: linear-gradient(180deg, #5fe0f0, var(--accent-2)); box-shadow: 0 6px 24px rgba(46, 200, 222, 0.35);
  transition: transform 0.12s ease, box-shadow 0.12s ease, opacity 0.2s;
}
#ui .btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 30px rgba(46, 200, 222, 0.5); }
#ui .btn:disabled { cursor: default; opacity: 0.55; background: rgba(255, 255, 255, 0.25); color: #fff; box-shadow: none; }
#ui .btn-hint { margin-top: 10px; font-size: 12px; color: rgba(238, 243, 248, 0.45); }
#ui .error { margin-top: 14px; color: #ff8a80; font-size: 13px; }
#ui .credit { margin-top: 18px; font-size: 11px; color: rgba(238, 243, 248, 0.35); }

#ui .result-title { font-size: 15px; letter-spacing: 0.4em; color: var(--accent); font-weight: 700; }
#ui .result-dest { margin-top: 6px; font-size: 14px; color: rgba(238, 243, 248, 0.7); }
#ui .result-time { margin-top: 14px; font-size: 64px; font-weight: 800; letter-spacing: 0.02em; }
#ui .record {
  display: inline-block; margin-top: 6px; padding: 4px 14px; border-radius: 999px; font-weight: 800; font-size: 15px;
  letter-spacing: 0.15em; color: #1a1200; background: linear-gradient(180deg, #ffe08a, var(--warn));
  animation: szd-pop 0.5s cubic-bezier(0.2, 1.6, 0.4, 1);
}
#ui .note { margin-top: 10px; font-size: 12px; color: var(--warn); }

/* ---------- HUD ---------- */
#hud { position: absolute; inset: 0; }
#hud .top-left { position: absolute; top: 18px; left: 18px; padding: 12px 16px 14px; width: 300px; }
#hud .section { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
#hud .section-name { font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .cp { font-size: 13px; color: rgba(238, 243, 248, 0.7); white-space: nowrap; }
#hud .bar { position: relative; margin-top: 10px; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.14); }
#hud .bar-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 3px; background: linear-gradient(90deg, var(--accent-2), var(--accent)); }
#hud .tick { position: absolute; top: -3px; width: 2px; height: 12px; margin-left: -1px; border-radius: 1px; background: rgba(255, 255, 255, 0.45); }
#hud .tick.done { background: var(--accent); }
#hud .tick.flag { width: 4px; margin-left: -2px; background: repeating-linear-gradient(0deg, #fff 0 3px, #111 3px 6px); }
#hud .bar-ends { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; color: rgba(238, 243, 248, 0.5); }

#hud .top-center { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 10px; }
#hud .timer { padding: 8px 22px 9px; text-align: center; }
#hud #hud-time { font-size: 34px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.1; }
#hud .timer-best { font-size: 11px; color: rgba(238, 243, 248, 0.5); margin-top: 1px; }
#hud .turn {
  display: flex; align-items: center; gap: 12px; padding: 9px 18px 9px 12px; font-size: 18px; font-weight: 700;
  border-color: rgba(255, 181, 71, 0.55); background: rgba(40, 26, 6, 0.62); animation: szd-fade 0.3s ease-out;
}
#hud .turn svg { width: 34px; height: 34px; flex: none; }
#hud .turn.near { animation: szd-pulse 0.9s ease-in-out infinite; }

#hud .bottom-right { position: absolute; right: 22px; bottom: 22px; padding: 10px 20px 12px; text-align: right; min-width: 150px; }
#hud #hud-speed { font-size: 64px; font-weight: 800; line-height: 1; letter-spacing: -0.01em; }
#hud .unit { font-size: 13px; font-weight: 600; color: rgba(238, 243, 248, 0.6); letter-spacing: 0.1em; }
#hud .speed-bar { margin-top: 8px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
#hud .speed-fill { height: 100%; width: 0; background: linear-gradient(90deg, var(--accent-2), var(--accent), #fff); }

#hud .toast {
  position: absolute; top: 24%; left: 50%; transform: translateX(-50%); padding: 10px 24px; font-size: 20px; font-weight: 700;
  white-space: nowrap; border-color: rgba(46, 200, 222, 0.5); animation: szd-toast 0.35s ease-out;
}
#hud .toast .num { color: var(--accent); margin-left: 12px; }
#hud .hint {
  position: absolute; bottom: 28px; left: 50%; transform: translateX(-50%); padding: 9px 20px; font-size: 16px; font-weight: 600;
  border-color: rgba(255, 181, 71, 0.5); animation: szd-fade 0.3s ease-out;
}
#hud .mute { position: absolute; top: 18px; right: 18px; padding: 6px 12px; font-size: 12px; color: rgba(238, 243, 248, 0.75); }

#countdown {
  position: absolute; left: 0; right: 0; top: 14vh; display: flex; justify-content: center;
  font-size: 180px; font-weight: 900; color: #fff; text-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 30px rgba(46, 200, 222, 0.45);
}
#countdown span { animation: szd-count 1s ease-out both; }
#countdown span.go { color: var(--accent); }

#debug {
  position: absolute; left: 18px; bottom: 18px; padding: 8px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.6);
  font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre; color: #b8f5c0;
}

@keyframes szd-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes szd-toast { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes szd-pop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes szd-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(255, 181, 71, 0); } 50% { box-shadow: 0 0 22px rgba(255, 181, 71, 0.55); } }
@keyframes szd-count { 0% { transform: scale(1.5); opacity: 0; } 12% { transform: scale(1); opacity: 1; } 85% { opacity: 1; } 100% { transform: scale(0.9); opacity: 0; } }
`;
