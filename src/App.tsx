import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

/**
 * =========================
 * Types
 * =========================
 */

type Move = {
  san: string;
  from: string;
  to: string;
  color: "w" | "b";
};

type EngineMessage =
  | { type: "bestMove"; move: string }
  | { type: "info"; score?: number; depth?: number; pv?: string };

/**
 * =========================
 * Stockfish Worker (inline)
 * =========================
 */

function createStockfishWorker() {
  const code = `
    let engine;
    let queue = [];
    let isReady = false;

    function send(cmd) {
      engine.postMessage(cmd);
    }

    self.onmessage = function(e) {
      const msg = e.data;

      if (msg.type === 'init') {
        engine = new Worker(msg.url);
        engine.onmessage = function(ev) {
          const line = ev.data;

          if (line === 'uciok') {
            isReady = true;
          }

          if (line.startsWith('bestmove')) {
            postMessage({ type: 'bestMove', move: line.split(' ')[1] });
          }

          if (line.startsWith('info')) {
            let score;
            let depth;

            const parts = line.split(' ');
            for (let i = 0; i < parts.length; i++) {
              if (parts[i] === 'score' && parts[i+1] === 'cp') {
                score = parseInt(parts[i+2]);
              }
              if (parts[i] === 'depth') {
                depth = parseInt(parts[i+1]);
              }
            }

            postMessage({ type: 'info', score, depth });
          }
        };

        send('uci');
        send('isready');
      }

      if (msg.type === 'evaluate') {
        send('position fen ' + msg.fen);
        send('go depth ' + (msg.depth || 12));
      }

      if (msg.type === 'stop') {
        send('stop');
      }
    };
  `;

  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);

  const worker = new Worker(url);

  worker.postMessage({
    type: "init",
    url: "https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish.js",
  });

  return worker;
}

/**
 * =========================
 * Main App
 * =========================
 */

export default function App() {
  const gameRef = useRef(new Chess());
  const workerRef = useRef<Worker | null>(null);

  const [fen, setFen] = useState(gameRef.current.fen());
  const [moves, setMoves] = useState<Move[]>([]);
  const [bestMove, setBestMove] = useState<string>("");
  const [evaluation, setEvaluation] = useState<number | null>(null);
  const [depth, setDepth] = useState<number>(0);
  const [analysisMode, setAnalysisMode] = useState(false);

  /**
   * Init engine
   */
  useEffect(() => {
    const worker = createStockfishWorker();
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<EngineMessage>) => {
      const msg = e.data;

      if (msg.type === "bestMove") {
        setBestMove(msg.move);
      }

      if (msg.type === "info") {
        if (msg.score !== undefined) setEvaluation(msg.score);
        if (msg.depth !== undefined) setDepth(msg.depth);
      }
    };

    return () => worker.terminate();
  }, []);

  /**
   * Engine evaluation trigger
   */
  useEffect(() => {
    if (!workerRef.current) return;

    workerRef.current.postMessage({
      type: "evaluate",
      fen,
      depth: analysisMode ? 16 : 10,
    });
  }, [fen, analysisMode]);

  /**
   * Make move
   */
  function makeMove(from: string, to: string) {
    const game = gameRef.current;

    const move = game.move({
      from,
      to,
      promotion: "q",
    });

    if (!move) return false;

    setFen(game.fen());

    setMoves((prev) => [
      ...prev,
      {
        san: move.san,
        from,
        to,
        color: move.color,
      },
    ]);

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
    const game = new Chess();
    gameRef.current = game;
    setFen(game.fen());
    setMoves([]);
    setBestMove("");
    setEvaluation(null);
  }

  /**
   * PGN export/import
   */
  function exportPGN() {
    return gameRef.current.pgn();
  }

  function importPGN(pgn: string) {
    const game = new Chess();
    game.loadPgn(pgn);
    gameRef.current = game;
    setFen(game.fen());
    setMoves([]);
  }

  /**
   * Evaluation color
   */
  function evalLabel() {
    if (evaluation === null) return "—";
    const v = evaluation / 100;
    return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  }

  /**
   * UI
   */
  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      {/* Top Bar */}
      <div className="p-3 border-b border-zinc-800 flex justify-between items-center">
        <div className="font-semibold">Chess Coach</div>

        <div className="flex gap-3 text-sm">
          <button onClick={() => setAnalysisMode(!analysisMode)}>
            {analysisMode ? "Analysis ON" : "Analysis OFF"}
          </button>
          <button onClick={undo}>Undo</button>
          <button onClick={reset}>Reset</button>
        </div>
      </div>

      {/* Main */}
      <div className="flex flex-1 flex-col md:flex-row">
        {/* Board */}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-[420px]">
            <Chessboard
              position={fen}
              onPieceDrop={(from, to) => makeMove(from, to)}
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full md:w-[360px] border-l border-zinc-800 p-4 space-y-4">
          {/* Evaluation */}
          <div className="p-3 bg-zinc-900 rounded">
            <div className="text-sm text-zinc-400">Evaluation</div>
            <div className="text-xl">{evalLabel()}</div>
            <div className="text-xs text-zinc-500">Depth: {depth}</div>
          </div>

          {/* Best Move */}
          <div className="p-3 bg-zinc-900 rounded">
            <div className="text-sm text-zinc-400">Best Move</div>
            <div className="text-lg">{bestMove || "—"}</div>
          </div>

          {/* Moves */}
          <div className="p-3 bg-zinc-900 rounded max-h-[300px] overflow-auto">
            <div className="text-sm text-zinc-400 mb-2">Moves</div>
            <div className="text-sm space-y-1">
              {moves.map((m, i) => (
                <div key={i} className="flex justify-between">
                  <span>{i + 1}. {m.san}</span>
                  <span className="text-zinc-500">{m.color}</span>
                </div>
              ))}
            </div>
          </div>

          {/* PGN */}
          <div className="p-3 bg-zinc-900 rounded space-y-2">
            <div className="text-sm text-zinc-400">PGN</div>
            <textarea
              className="w-full h-24 bg-zinc-800 p-2 text-xs"
              defaultValue={exportPGN()}
              onBlur={(e) => importPGN(e.target.value)}
            />
          </div>

          {/* FEN */}
          <div className="p-3 bg-zinc-900 rounded space-y-2">
            <div className="text-sm text-zinc-400">FEN</div>
            <textarea
              className="w-full h-20 bg-zinc-800 p-2 text-xs"
              value={fen}
              onChange={(e) => {
                try {
                  const game = new Chess(e.target.value);
                  gameRef.current = game;
                  setFen(game.fen());
                } catch {}
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
