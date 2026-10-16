import { useState, useCallback, useRef, useEffect } from 'react';
import type { CodeNavRequest, CodeNavResponse } from '@plannotator/shared/code-nav';

export type { CodeNavRequest, CodeNavResponse };

export interface ReferenceTarget {
  filePath: string;
  line: number;
  side: 'old' | 'new';
  /** Absent for jumps whose coordinates already belong to the review. */
  snippet?: string;
}

interface Visit {
  target: ReferenceTarget | null;
  result: CodeNavResponse | null;
  symbol: string | null;
}

interface Navigation {
  entries: Visit[];
  index: number;
}

const empty: Navigation = { entries: [], index: -1 };

function append(history: Navigation, visit: Visit): Navigation {
  const current = history.entries[history.index];
  const a = current?.target, b = visit.target;
  if (current?.result === visit.result && current?.symbol === visit.symbol
    && a?.filePath === b?.filePath && a?.line === b?.line && a?.side === b?.side) {
    // A repeated click still requests a fresh jump without adding a duplicate stop.
    return { ...history, entries: history.entries.map((entry, i) => i === history.index ? visit : entry) };
  }
  const entries = [...history.entries.slice(0, history.index + 1), visit];
  return { entries, index: entries.length - 1 };
}

export function useCodeNav(snapshotId?: string) {
  const [history, setHistory] = useState<Navigation>(empty);
  const [pendingSymbol, setPendingSymbol] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const current = history.entries[history.index];

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingSymbol(null);
  }, []);

  const clear = useCallback(() => {
    cancel();
    setHistory(empty);
  }, [cancel]);

  useEffect(() => {
    clear();
    return () => abortRef.current?.abort();
  }, [snapshotId, clear]);

  const resolve = useCallback(async (request: CodeNavRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPendingSymbol(request.symbol);
    setHistory(previous => append(previous, {
      target: { filePath: request.filePath, line: request.line, side: request.side },
      result: previous.entries[previous.index]?.result ?? null,
      symbol: previous.entries[previous.index]?.symbol ?? request.symbol,
    }));

    try {
      const res = await fetch('/api/code-nav/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Failed');
      const result: CodeNavResponse = await res.json();
      if (controller.signal.aborted) return;
      const first = result.definitions[0] ?? result.references[0];
      setHistory(previous => append(previous, {
        target: first ? { ...first, side: 'new' } : null, result, symbol: request.symbol,
      }));
    } catch (err) {
      if (controller.signal.aborted) return;
      setHistory(previous => append(previous, { target: null, result: null, symbol: request.symbol }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setPendingSymbol(null);
      }
    }
  }, []);

  const select = useCallback((target: ReferenceTarget) => {
    cancel();
    setHistory(previous => append(previous, {
      target, result: previous.entries[previous.index]?.result ?? null,
      symbol: previous.entries[previous.index]?.symbol ?? null,
    }));
  }, [cancel]);

  const go = useCallback((direction: -1 | 1) => {
    cancel();
    setHistory(previous => ({ ...previous, index: Math.max(0, Math.min(previous.entries.length - 1, previous.index + direction)) }));
  }, [cancel]);

  return {
    result: current?.result ?? null,
    target: current?.target ?? null,
    isLoading: pendingSymbol !== null,
    activeSymbol: pendingSymbol ?? current?.symbol ?? null,
    isAtSource: history.index === 0,
    backReturnsToSource: history.index === 1,
    canGoBack: history.index > 0,
    canGoForward: history.index < history.entries.length - 1,
    resolve, select, go, clear,
  };
}
