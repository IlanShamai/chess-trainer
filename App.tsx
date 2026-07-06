import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";

/**
 * =========================
 * Types
 * =========================
 */

type MoveAnnotation = {
  san: string;
  from: string;
  to: string;
  color: "w" | "b";
  fenBefore: string;
  fenAfter: string;
  evalBefore: number | null;
  evalAfter: number | null;
  cpLoss: number | null;
  label: MoveLabel;
};

type MoveLabel =
  | "Brilliant"
  | "Best"
  | "Excellent"
  | "Good"
  | "Inaccuracy"
  | "Mistake"
  | "Blunder";

type EngineInfo = {
  score?: number;
  depth?: number;
  pv?: string;
};

/**
 * =========================
 * Stockfish Worker
 * =========================
 */

function createEngine() {
  const code = `
    let engine;
    let latestId = 0;

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
        latestId++;
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

function labelFromCpLoss(loss: number): MoveLabel {
  if (loss < 20) return "Best";
  if (loss < 50) return "Excellent";
  if (loss < 120) return "Good";
  if (loss < 250) return "Inaccuracy";
  if (loss < 600) return "Mistake";
  return "Blunder";
}

function cpToLabel(cp: number | null): number {
  if (cp === null) return 0;
  return cp;
}

/**
 * =========================
 * App
 * =========================
 */

export default function App() {
  const gameRef = useRef(new Chess());
  const engineRef = useRef<Worker | null>(null);

  const [fen, setFen] = useState(gameRef.current.fen());
  const [moves, setMoves] = useState<MoveAnnotation[]>([]);
  const [analysis, setAnalysis] = useState<EngineInfo>({});
  const [bestMove, setBestMove] = useState("");
  const [depth] = useState(14);

  /**
   * Engine init
   */
  useEffect(() => {
    const w = createEngine();
    engineRef.current = w;

    w.onmessage = (e: MessageEvent<any>) => {
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
   * Evaluate position
   */
  function evalPosition(fen: string) {
    return new Promise<number>((resolve) => {
      if (!engineRef.current) return resolve(0);

      const handler = (e: MessageEvent<any>) => {
        if (e.data.type === "info" && e.data.score != null) {
          engineRef.current?.removeEventListener("message", handler as any);
          resolve(e.data.score);
        }
      };

      engineRef.current.addEventListener("message", handler as any);

      engineRef.current.postMessage({
        type: "eval",
        fen,
        depth,
      });

      setTimeout(() => resolve(0), 800);
    });
  }

  /**
   * Make move with full analysis
   */
  async function makeMove(from: string, to: string) {
    const game = gameRef.current;

    const fenBefore = game.fen();

    const evalBefore = await evalPosition(fenBefore);

    const move = game.move({ from, to, promotion: "q" });
    if (!move) return false;

    const fenAfter = game.fen();

    const evalAfter = await evalPosition(fenAfter);

    const cpLoss = Math.abs(evalBefore - evalAfter);

    const annotation: MoveAnnotation = {
      san: move.san,
      from,
      to,
      color: move.color,
      fenBefore,
      fenAfter,
      evalBefore,
      evalAfter,
      cpLoss,
      label: labelFromCpLoss(cpLoss),
    };

    setMoves((m) => [...m, annotation]);
    setFen(fenAfter);

    return true;
  }

  /**
   * Undo
   */
  function undo() {
    const game = gameRef.current;
    game.undo();
    setMoves((m) => m.slice(0, -1));
    setFen(game.fen());
  }

  /**
   * Reset
   */
  function reset() {
    const g = new Chess();
    gameRef.current = g;
    setMoves([]);
    setFen(g.fen());
    setBestMove("");
  }

  /**
   * Evaluation display
   */
  function evalText() {
    const cp = analysis.score ?? 0;
    const v = cp / 100;
    return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  }

  /**
   * Accuracy summary
   */
  const accuracy = useMemo(() => {
    if (moves.length === 0) return 100;
    const bad = moves.filter(
      (m) => m.label === "Mistake" || m.label === "Blunder"
    ).length;
    return Math.max(0, Math.round(100 - (bad / moves.length) * 100));
  }, [moves]);

  /**
   * UI
   */
  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      {/* Top bar */}
      <div className="flex justify-between p-3 border-b border-zinc-800">
        <div className="font-bold">Chess Coach Pro</div>
        <div className="flex gap-3 text-sm">
          <button onClick={undo}>Undo</button>
          <button onClick={reset}>Reset</button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row flex-1">
        {/* Board */}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="w-[420px]">
            <Chessboard
              position={fen}
              onPieceDrop={(f, t) => makeMove(f, t)}
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full md:w-[380px] border-l border-zinc-800 p-4 space-y-4">
          {/* Eval */}
          <div className="bg-zinc-900 p-3 rounded">
            <div className="text-sm text-zinc-400">Evaluation</div>
            <div className="text-xl">{evalText()}</div>
            <div className="text-xs text-zinc-500">
              Depth {analysis.depth}
            </div>
          </div>

          {/* Accuracy */}
          <div className="bg-zinc-900 p-3 rounded">
            <div className="text-sm text-zinc-400">Accuracy</div>
            <div className="text-xl">{accuracy}%</div>
          </div>

          {/* Best move */}
          <div className="bg-zinc-900 p-3 rounded">
            <div className="text-sm text-zinc-400">Best Move</div>
            <div className="text-lg">{bestMove || "—"}</div>
          </div>

          {/* Moves */}
          <div className="bg-zinc-900 p-3 rounded max-h-[300px] overflow-auto">
            <div className="text-sm text-zinc-400 mb-2">Moves</div>
            <div className="text-xs space-y-1">
              {moves.map((m, i) => (
                <div key={i} className="flex justify-between">
                  <span>
                    {i + 1}. {m.san}
                  </span>
                  <span className="text-zinc-400">{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* PV */}
          <div className="bg-zinc-900 p-3 rounded">
            <div className="text-sm text-zinc-400">PV</div>
            <div className="text-xs text-zinc-300">
              {analysis.pv || "—"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
