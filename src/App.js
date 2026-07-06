import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
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
    const [depth] = useState(14);
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
    function setTurnForColor(color) {
        const game = gameRef.current;
        const fenParts = game.fen().split(" ");
        if (fenParts.length < 2)
            return;
        fenParts[1] = color;
        game.load(fenParts.join(" "));
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
        if (game.isGameOver())
            return;
        setTurnForColor(color);
        const move = await requestEngineMove(game.fen());
        if (!move || move === "(none)")
            return;
        const parsedMove = game.move({
            from: move.slice(0, 2),
            to: move.slice(2, 4),
            promotion: move.length === 5 ? move[4] : "q",
        });
        if (!parsedMove)
            return;
        setFen(game.fen());
        setBestMove(move);
        void analyzeMove(parsedMove.from, parsedMove.to);
    }
    async function showHint() {
        const game = gameRef.current;
        if (game.isGameOver())
            return;
        const move = await requestEngineMove(game.fen());
        if (!move || move === "(none)")
            return;
        setBestMove(move);
    }
    function onPieceDrop(from, to) {
        const game = gameRef.current;
        const piece = game.get(from);
        if (!piece)
            return false;
        const color = piece.color;
        if (game.turn() !== color) {
            setTurnForColor(color);
        }
        const move = game.move({
            from,
            to,
            promotion: "q",
        });
        if (!move)
            return false;
        setFen(game.fen());
        setBestMove("");
        void analyzeMove(from, to);
        if (!game.isGameOver()) {
            void playBotMove(color === "w" ? "b" : "w");
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
    return (_jsxs("div", { className: "min-h-screen bg-zinc-950 text-white flex flex-col", children: [_jsxs("div", { className: "flex justify-between p-3 border-b border-zinc-800", children: [_jsx("div", { className: "font-bold", children: "Chess Coach Pro" }), _jsxs("div", { className: "flex gap-3 text-sm", children: [_jsx("button", { onClick: showHint, children: "Hint" }), _jsx("button", { onClick: undo, children: "Undo" }), _jsx("button", { onClick: reset, children: "Reset" })] })] }), _jsxs("div", { className: "flex flex-col md:flex-row flex-1", children: [_jsx("div", { className: "flex-1 flex items-center justify-center p-4", children: _jsx("div", { className: "w-[420px]", children: _jsx(Chessboard, { position: fen, onPieceDrop: onPieceDrop }) }) }), _jsxs("div", { className: "w-full md:w-[380px] border-l border-zinc-800 p-4 space-y-4", children: [_jsxs("div", { className: "bg-zinc-900 p-3 rounded", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Evaluation" }), _jsx("div", { className: "text-xl", children: evalText() })] }), _jsxs("div", { className: "bg-zinc-900 p-3 rounded", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Accuracy" }), _jsxs("div", { className: "text-xl", children: [accuracy, "%"] })] }), _jsxs("div", { className: "bg-zinc-900 p-3 rounded", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "Best Move" }), _jsx("div", { children: bestMove || "—" })] }), _jsxs("div", { className: "bg-zinc-900 p-3 rounded max-h-[300px] overflow-auto", children: [_jsx("div", { className: "text-sm text-zinc-400 mb-2", children: "Moves" }), _jsx("div", { className: "text-xs space-y-1", children: moves.map((m, i) => (_jsxs("div", { className: "flex justify-between", children: [_jsxs("span", { children: [i + 1, ". ", m.san] }), _jsx("span", { className: "text-zinc-400", children: m.label })] }, i))) })] }), _jsxs("div", { className: "bg-zinc-900 p-3 rounded", children: [_jsx("div", { className: "text-sm text-zinc-400", children: "PV" }), _jsx("div", { className: "text-xs text-zinc-300", children: analysis.pv || "—" })] })] })] })] }));
}
