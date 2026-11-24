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
#ui .tod { margin: 22px auto 0; width: fit-content; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); border: 1px solid var(--line); }
#ui .tod-label { padding: 0 10px 0 12px; font-size: 13px; color: rgba(238, 243, 248, 0.55); letter-spacing: 0.1em; }
#ui .tod-btn {
  padding: 7px 18px; border: 0; border-radius: 999px; cursor: pointer; background: transparent; color: rgba(238, 243, 248, 0.75);
  font: 600 14px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; letter-spacing: 0.12em; transition: background 0.15s, color 0.15s;
}
#ui .tod-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
#ui .tod-btn.active { color: #04141a; background: linear-gradient(180deg, #5fe0f0, var(--accent-2)); }
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
#ui .version { margin-top: 6px; font-size: 11px; letter-spacing: 0.04em; color: rgba(238, 243, 248, 0.38); }

/* ---------- pause menu ---------- */
#pause { background: radial-gradient(ellipse at 50% 55%, rgba(6, 9, 16, 0.35), rgba(6, 9, 16, 0.82)); animation-duration: 0.18s; }
#ui .pause-card { width: min(400px, 92vw); padding: 26px 30px 20px; }
#ui .pause-info { margin-top: 8px; font-size: 14px; color: rgba(238, 243, 248, 0.75); }
#ui .pause-actions { margin-top: 18px; display: flex; flex-direction: column; gap: 8px; }
#ui .pbtn {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 11px 16px 11px 20px;
  border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); cursor: pointer;
  font: 600 16px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; letter-spacing: 0.12em; color: #eef3f8;
  transition: background 0.12s, border-color 0.12s, opacity 0.2s; outline: none;
}
#ui .pbtn kbd { font-size: 11px; line-height: 16px; opacity: 0.8; }
#ui .pbtn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
#ui .pbtn:focus-visible, #ui .pbtn:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(46, 200, 222, 0.45); }
#ui .pbtn.primary { color: #04141a; border-color: transparent; background: linear-gradient(180deg, #5fe0f0, var(--accent-2)); }
#ui .pbtn.primary kbd { color: #04141a; background: rgba(255, 255, 255, 0.35); border-color: rgba(4, 20, 26, 0.3); }
#ui .pbtn.primary:focus { box-shadow: 0 0 0 2px #fff, 0 0 0 4px rgba(46, 200, 222, 0.6); }
#ui .pbtn:disabled { opacity: 0.38; cursor: default; }
#ui .pause-row { margin-top: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; }
#ui .pause-row .tod { margin: 0; }
#ui .tod-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
#ui .pbtn.mute-toggle { width: auto; padding: 7px 10px 7px 14px; border-radius: 999px; font-size: 13px; letter-spacing: 0.08em; }
#ui .pbtn.mute-toggle.off { color: var(--warn); border-color: rgba(255, 181, 71, 0.5); }
#ui .pause-card .btn-hint { margin-top: 14px; }
#ui.paused #countdown span, #ui.paused #hud .turn.near, #ui.paused #hud .slow { animation-play-state: paused; }

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
#hud .top-left { position: absolute; top: 18px; left: 18px; width: 300px; }
#hud .minimap { overflow: hidden; background: rgba(9, 13, 22, 0.66); }
#hud .section { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 9px 14px 0; }
#hud .section-name { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .cp { font-size: 12px; color: rgba(238, 243, 248, 0.75); white-space: nowrap; }
#hud .mm-canvas { display: block; }
#hud .mm-mode {
  position: absolute; left: 8px; bottom: 6px; padding: 1px 7px; border-radius: 999px; font-size: 10px; letter-spacing: 0.08em;
  color: rgba(238, 243, 248, 0.7); background: rgba(9, 13, 22, 0.6); border: 1px solid var(--line);
}
#hud .mm-scale { position: absolute; right: 10px; bottom: 8px; height: 4px; border: 1.5px solid rgba(238, 243, 248, 0.75); border-top: 0; }
#hud .mm-scale span {
  position: absolute; right: 100%; bottom: -3px; margin-right: 5px; font-size: 10px; line-height: 1; white-space: nowrap;
  color: rgba(238, 243, 248, 0.8); text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7);
}
#hud .version-tag {
  position: absolute; left: 14px; bottom: 9px; font-size: 10px; letter-spacing: 0.04em; color: rgba(238, 243, 248, 0.5);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}

#hud .top-center { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 10px; }
#hud .timer { padding: 8px 22px 9px; text-align: center; }
#hud #hud-time { font-size: 34px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.1; }
#hud .timer-best { font-size: 11px; color: rgba(238, 243, 248, 0.5); margin-top: 1px; }
#hud .turn {
  display: flex; align-items: center; gap: 12px; padding: 9px 18px 9px 12px; font-size: 18px; font-weight: 700;
  border-color: rgba(255, 181, 71, 0.55); background: rgba(40, 26, 6, 0.62); animation: szd-fade 0.3s ease-out;
}
#hud .turn svg { width: 34px; height: 34px; flex: none; color: var(--warn); }
#hud .turn-dist { font-size: 24px; font-weight: 800; min-width: 74px; }
#hud .turn-road { font-size: 18px; font-weight: 700; white-space: nowrap; }
#hud .turn.near { animation: szd-pulse 0.9s ease-in-out infinite; }
#hud .slow {
  padding: 8px 20px; font-size: 22px; font-weight: 800; letter-spacing: 0.06em; color: #fff;
  background: rgba(150, 18, 18, 0.78); border-color: rgba(255, 90, 80, 0.8); animation: szd-alarm 0.7s ease-in-out infinite;
}

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
#hud .top-right { position: absolute; top: 18px; right: 18px; display: flex; gap: 8px; align-items: center; }
#hud .mute { padding: 6px 12px; font-size: 12px; color: rgba(238, 243, 248, 0.75); }
#hud .rec-ind {
  display: flex; align-items: center; gap: 6px; padding: 5px 11px; font-size: 12px; font-weight: 800; letter-spacing: 0.12em;
  color: #ff6b6b; border-color: rgba(255, 90, 90, 0.45);
}
#hud .rec-ind i { width: 8px; height: 8px; border-radius: 50%; background: #ff3b3b; animation: szd-blink 1.2s steps(2, jump-none) infinite; }

/* ---------- recording controls ---------- */
#ui .opt-row { margin: 22px auto 0; display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap; }
#ui .opt-row .tod { margin: 0; }
#ui .pbtn.rec-toggle { width: auto; padding: 7px 14px 7px 12px; border-radius: 999px; font-size: 13px; letter-spacing: 0.08em; justify-content: flex-start; gap: 8px; }
#ui .rec-toggle i { width: 8px; height: 8px; border-radius: 50%; background: rgba(238, 243, 248, 0.35); }
#ui .rec-toggle.on i { background: #ff3b3b; box-shadow: 0 0 8px rgba(255, 59, 59, 0.8); }
#ui .rec-block { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
#ui .pbtn.rec-download { justify-content: center; letter-spacing: 0.06em; font-size: 15px; }
#ui .pbtn.rec-download.busy { opacity: 0.7; }
#ui .rec-note { margin-top: 8px; font-size: 12px; color: rgba(238, 243, 248, 0.5); }

#countdown {
  position: absolute; left: 0; right: 0; top: 14vh; display: flex; justify-content: center;
  font-size: 180px; font-weight: 900; color: #fff; text-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 30px rgba(46, 200, 222, 0.45);
}
#countdown span { animation: szd-count 1s ease-out both; }
#countdown span.go { color: var(--accent); }

#debug {
  position: absolute; left: 18px; bottom: 30px; padding: 8px 12px; border-radius: 8px; background: rgba(0, 0, 0, 0.6);
  font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre; color: #b8f5c0;
}

@keyframes szd-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes szd-blink { from { opacity: 1; } to { opacity: 0.25; } }
@keyframes szd-toast { from { opacity: 0; transform: translate(-50%, -8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes szd-pop { from { transform: scale(0.4); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes szd-alarm { 0%, 100% { box-shadow: 0 0 0 rgba(255, 70, 60, 0); } 50% { box-shadow: 0 0 26px rgba(255, 70, 60, 0.75); } }
@keyframes szd-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(255, 181, 71, 0); } 50% { box-shadow: 0 0 22px rgba(255, 181, 71, 0.55); } }
@keyframes szd-count { 0% { transform: scale(1.5); opacity: 0; } 12% { transform: scale(1); opacity: 1; } 85% { opacity: 1; } 100% { transform: scale(0.9); opacity: 0; } }
`;
