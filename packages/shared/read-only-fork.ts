export interface ReadOnlyFork {
  answer(prompt: string, signal: AbortSignal, onActivity?: () => void): Promise<{ sessionId: string; text: string }>;
  dispose(): void;
}
