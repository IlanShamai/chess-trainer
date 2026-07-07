import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
const levelToDepth = {
    easy: 8,
    medium: 12,
    hard: 16,
};
/**
 * =========================
 * Stockfish Worker
 * =========================
 */
function createEngine() {
    const code = `
    let engine;

    function send(cmd){ engine.postMessage(cmd); }

    self.onmessage = function(e){
      const msg = e.data;

      if(msg.type === 'init'){
        engine = new Worker(msg.url);

        engine.onmessage = function(ev){
          const line = ev.data;

          if(line.startsWith('bestmove')){
            postMessage({ type:'bestMove', move: line.split(' ')[1] });
          }

          if(line.startsWith('info')){
            let score, depth, pv;

            const parts = line.split(' ');
            for(let i=0;i<parts.length;i++){
              if(parts[i]==='depth') depth = parseInt(parts[i+1]);
              if(parts[i]==='score' && parts[i+1]==='cp') score = parseInt(parts[i+2]);
              if(parts[i]==='pv') pv = parts.slice(i+1).join(' ');
            }

            postMessage({ type:'info', score, depth, pv });
          }
        };

        send('uci');
        send('isready');
      }

      if(msg.type === 'eval'){
        send('position fen ' + msg.fen);
        send('go depth ' + msg.depth);
      }

      if(msg.type === 'stop'){
        send('stop');
      }
    };
  `;
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.postMessage({
        type: "init",
        url: "https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish.js",
    });
    return w;
}
/**
 * =========================
 * Evaluation helpers
 * =========================
 */
function labelFromCpLoss(loss) {
    if (loss < 20)
        return "Best";
    if (loss < 50)
        return "Excellent";
    if (loss < 120)
        return "Good";
    if (loss < 250)
        return "Inaccuracy";
    if (loss < 600)
        return "Mistake";
    return "Blunder";
}
/**
 * =========================
 * App
 * =========================
 */
export default function App() {
    const gameRef = useRef(new Chess());
    const engineRef = useRef(null);
    const [fen, setFen] = useState(gameRef.current.fen());
    const [moves, setMoves] = useState([]);
    const [analysis, setAnalysis] = useState({});
    const [bestMove, setBestMove] = useState("");
    const [playerColor, setPlayerColor] = useState("w");
    const [botLevel, setBotLevel] = useState("medium");
    const [statusText, setStatusText] = useState("Your turn");
    const [botThinking, setBotThinking] = useState(false);
    const depth = useMemo(() => levelToDepth[botLevel], [botLevel]);
    /**
     * Init engine
     */
    useEffect(() => {
        const w = createEngine();
        engineRef.current = w;
        w.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === "info") {
                setAnalysis((a) => ({
                    ...a,
                    score: msg.score,
                    depth: msg.depth,
                    pv: msg.pv,
                }));
            }
            if (msg.type === "bestMove") {
                setBestMove(msg.move);
            }
        };
        return () => w.terminate();
    }, []);
    /**
     * Async engine evaluation
     */
    function evalPosition(fen) {
        return new Promise((resolve) => {
            if (!engineRef.current)
                return resolve(0);
            const handler = (e) => {
                if (e.data.type === "info" && e.data.score != null) {
                    resolve(e.data.score);
                }
            };
            engineRef.current.addEventListener("message", handler);
            engineRef.current.postMessage({
                type: "eval",
                fen,
                depth,
            });
            setTimeout(() => resolve(0), 800);
        });
    }
    /**
     * Async analysis (NOT responsible for move validity)
     */
    async function analyzeMove(from, to) {
        const game = gameRef.current;
        const fenBefore = game.fen();
        const evalBefore = await evalPosition(fenBefore);
        const fenAfter = game.fen();
        const evalAfter = await evalPosition(fenAfter);
        const cpLoss = Math.abs(evalBefore - evalAfter);
        const moveObj = game.history({ verbose: true }).slice(-1)[0];
        const annotation = {
            san: moveObj.san,
            from,
            to,
            color: moveObj.color,
            fenBefore,
            fenAfter,
            evalBefore,
            evalAfter,
            cpLoss,
            label: labelFromCpLoss(cpLoss),
        };
        setMoves((m) => [...m, annotation]);
    }
    function requestEngineMove(fen) {
        return new Promise((resolve) => {
            const worker = engineRef.current;
            if (!worker)
                return resolve(null);
            const handler = (event) => {
                if (event.data.type === "bestMove") {
                    worker.removeEventListener("message", handler);
                    resolve(event.data.move);
                }
            };
            worker.addEventListener("message", handler);
            worker.postMessage({ type: "eval", fen, depth });
        });
    }
    async function playBotMove(color) {
        const game = gameRef.current;
        if (game.isGameOver() || game.turn() !== color)
            return;
        setBotThinking(true);
        setStatusText("Bot is thinking...");
        const move = await requestEngineMove(game.fen());
        setBotThinking(false);
        if (!move || move === "(none)") {
            setStatusText("Your turn");
            return;
        }
        const parsedMove = game.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.length === 5 ? move[4] : "q",
        });
        if (!parsedMove) {
            setStatusText("Your turn");
            return;
        }
        setFen(game.fen());
        setBestMove(move);
        void analyzeMove(parsedMove.from, parsedMove.to);
        setStatusText(game.isGameOver() ? "Game over" : "Your turn");
    }
    async function showHint() {
        const game = gameRef.current;
        if (game.isGameOver())
            return;
        const move = await requestEngineMove(game.fen());
        if (!move || move === "(none)")
            return;
        setBestMove(move);
        setStatusText("Hint ready");
    }
    function onPieceDrop(from, to) {
        const game = gameRef.current;
        const piece = game.get(from);
        if (!piece || botThinking)
            return false;
        if (piece.color !== playerColor || game.turn() !== playerColor)
            return false;
        const move = game.move({
            from,
            to,
            promotion: "q",
        });
        if (!move)
            return false;
        setFen(game.fen());
        setBestMove("");
        setStatusText("Bot is thinking...");
        void analyzeMove(from, to);
        if (!game.isGameOver() && game.turn() === (playerColor === "w" ? "b" : "w")) {
            void playBotMove(playerColor === "w" ? "b" : "w");
        }
        else {
            setStatusText(game.isGameOver() ? "Game over" : "Your turn");
        }
        return true;
    }
    /**
     * Undo
     */
    function undo() {
        const game = gameRef.current;
        game.undo();
        setFen(game.fen());
        setMoves((m) => m.slice(0, -1));
    }
    /**
     * Reset
     */
    function reset() {
        const g = new Chess();
        gameRef.current = g;
        setFen(g.fen());
        setMoves([]);
        setBestMove("");
        setAnalysis({});
        setBotThinking(false);
        setStatusText("Your turn");
    }
    /**
     * Accuracy
     */
    const accuracy = useMemo(() => {
        if (moves.length === 0)
            return 100;
        const bad = moves.filter((m) => m.label === "Mistake" || m.label === "Blunder").length;
        return Math.max(0, Math.round(100 - (bad / moves.length) * 100));
    }, [moves]);
    /**
     * Eval display
     */
    function evalText() {
        const cp = analysis.score ?? 0;
        const v = cp / 100;
        return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
    }
    return (_jsx("div", { className: "min-h-screen bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.15),_transparent_40%),linear-gradient(135deg,_#09090b,_#111827)] text-white", children: _jsxs("div", { className: "mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8", children: [_jsxs("header", { className: "mb-4 flex flex-col gap-3 rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur md:flex-row md:items-center md:justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xl font-semibold", children: "Chess Coach Pro" }), _jsx("div", { className: "text-sm text-zinc-400", children: "Play against a bot, get hints, and sharpen your game." })] }), _jsxs("div", { className: "flex flex-wrap gap-2 text-sm", children: [_jsx("button", { type: "button", onClick: showHint, className: "rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sky-200 transition hover:bg-sky-500/20", children: "Hint" }), _jsx("button", { type: "button", onClick: undo, className: "rounded-full border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-200 transition hover:bg-zinc-700", children: "Undo" }), _jsx("button", { type: "button", onClick: reset, className: "rounded-full border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-200 transition hover:bg-zinc-700", children: "Reset" })] })] }), _jsxs("div", { className: "grid flex-1 gap-4 lg:grid-cols-[1.2fr_0.8fr]", children: [_jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-3 shadow-2xl backdrop-blur", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between rounded-2xl bg-zinc-800/70 px-3 py-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Trainer status" }), _jsx("div", { className: "font-medium", children: statusText })] }), _jsx("div", { className: "rounded-full bg-emerald-500/15 px-3 py-1 text-sm text-emerald-300", children: botThinking ? "Bot thinking..." : "Live training" })] }), _jsx("div", { className: "flex justify-center rounded-2xl bg-zinc-950/70 p-2", children: _jsx("div", { className: "w-full max-w-[480px]", children: _jsx(Chessboard, { position: fen, onPieceDrop: onPieceDrop, boardWidth: 420 }) }) })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "mb-3 text-sm text-zinc-400", children: "Trainer setup" }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "mb-2 text-sm font-medium", children: "Play as" }), _jsx("div", { className: "flex gap-2", children: ["w", "b"].map((color) => (_jsx("button", { type: "button", onClick: () => setPlayerColor(color), className: `rounded-full px-3 py-2 text-sm transition ${playerColor === color
                                                                    ? "bg-sky-500 text-white"
                                                                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`, children: color === "w" ? "White" : "Black" }, color))) })] }), _jsxs("div", { children: [_jsx("label", { className: "mb-2 block text-sm font-medium", htmlFor: "level", children: "Bot level" }), _jsxs("select", { id: "level", value: botLevel, onChange: (event) => setBotLevel(event.target.value), className: "w-full rounded-2xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none", children: [_jsx("option", { value: "easy", children: "Easy" }), _jsx("option", { value: "medium", children: "Medium" }), _jsx("option", { value: "hard", children: "Hard" })] })] })] })] }), _jsxs("div", { className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-1", children: [_jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Evaluation" }), _jsx("div", { className: "mt-1 text-2xl font-semibold", children: evalText() })] }), _jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Accuracy" }), _jsxs("div", { className: "mt-1 text-2xl font-semibold", children: [accuracy, "%"] })] })] }), _jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "mb-2 text-sm text-zinc-400", children: "Best move" }), _jsx("div", { className: "text-sm text-zinc-200", children: bestMove || "—" })] }), _jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "mb-2 text-sm text-zinc-400", children: "Recent moves" }), _jsx("div", { className: "max-h-[240px] space-y-1 overflow-auto text-xs", children: moves.map((m, i) => (_jsxs("div", { className: "flex items-center justify-between rounded-xl bg-zinc-800/70 px-2 py-1.5", children: [_jsxs("span", { children: [i + 1, ". ", m.san] }), _jsx("span", { className: "text-zinc-400", children: m.label })] }, i))) })] }), _jsxs("div", { className: "rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-4 shadow-2xl backdrop-blur", children: [_jsx("div", { className: "mb-2 text-sm text-zinc-400", children: "Variation" }), _jsx("div", { className: "text-xs text-zinc-300", children: analysis.pv || "—" })] })] })] })] }) }));
}
