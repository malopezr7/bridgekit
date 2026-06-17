// ---------------------------------------------------------------------------
// useDemoState — all stateful logic for the BridgekitDemo screen.
// Centralised here so the screen component stays thin (pure layout/composition).
// ---------------------------------------------------------------------------

import { getDefaultBridgeKit, GLOBAL_SCOPE } from '@malopezr7/bridgekit';
import type { BridgeContract } from '@malopezr7/bridgekit/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EchoEntry } from './components/EchoFeed';
import { useDemoHost } from './contracts/demo-host.contract';
import { useDemoReverse } from './contracts/demo-reverse.contract';
import { useLocalhost } from './contracts/localhost.contract';
import { demoReverseImpl, jsInfoImpl } from './providers';

const MOOD_CYCLE = ['happy', 'focused', 'caffeinated', 'puzzled', 'shipping'] as const;

export function useDemoState() {
  // ---- Providers (JS provides → native consumes) ---------------------------

  // demo.jsinfo and demo.local are provided at the JS entry
  // (registerHostProviders.ts) — NOT here. demo.local must exist before this
  // hook builds its first consumer snapshot, otherwise its state handle would
  // fall through to the native transport instead of LocalStateMirror.

  // demo.reverse: all four markers — needs Binding ref to call setState
  const reverseBindingRef = useRef<import('@malopezr7/bridgekit').Binding | null>(null);

  // Mount effect: provide demo.reverse (external system registration — effect correct here)
  useEffect(() => {
    const bk = getDefaultBridgeKit();
    const contract = useDemoReverse as unknown as BridgeContract<typeof demoReverseImpl>;
    const binding = bk.provide(contract, demoReverseImpl);
    reverseBindingRef.current = binding;
    return () => {
      binding.close('final');
      reverseBindingRef.current = null;
    };
  }, []);

  // Cycle jsStatus every 3s
  const statusIdxRef = useRef(0);
  const statusLabels = ['js-idle', 'js-loading', 'js-ready', 'js-active'];
  useEffect(() => {
    const iv = setInterval(() => {
      const binding = reverseBindingRef.current;
      if (!binding) return;
      statusIdxRef.current = (statusIdxRef.current + 1) % statusLabels.length;
      const next = statusLabels[statusIdxRef.current] ?? 'js-idle';
      binding.setState('jsStatus', next);
      setJsStatus(next);
    }, 3000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Consumers (JS consumes native or local) ----------------------------

  // Single snapshot call — destructure methods, streams AND state handles together
  // to avoid two separate buildSnapshot() calls that could produce mismatched mirrors.
  const { ping, increment, say, ticker, echoes, state: hostState } = useDemoHost();
  // counterHandle: StateHandle<number> from the same snapshot as increment/ping/ticker.
  const counterHandle = hostState.counter;
  const { getMotto, greet, state: localhostState } = useLocalhost();
  const localhostMoodHandle = localhostState.mood;

  // ---- Local UI state ------------------------------------------------------

  // Ping
  const [pingMessage, setPingMessage] = useState('hello from RN');
  const [pingResult, setPingResult] = useState('—');
  const [pinging, setPinging] = useState(false);

  // Counter
  const [counterValue, setCounterValue] = useState<number>(counterHandle.get());

  // Ticker
  const [tickerValues, setTickerValues] = useState<number[]>([]);

  // Echo
  const [echoInput, setEchoInput] = useState('');
  const [echoEntries, setEchoEntries] = useState<EchoEntry[]>([]);

  // JS-provided values shown on screen (demo.jsinfo readout)
  const [rnVersion, setRnVersion] = useState('—');
  const [userLevel, setUserLevel] = useState<{ level: number; label: string } | null>(null);
  const [userSegments, setUserSegments] = useState<string[]>([]);
  const [clockTickValues, setClockTickValues] = useState<number[]>([]);

  // jsStatus (from demo.reverse state updates)
  const [jsStatus, setJsStatus] = useState('js-idle');

  // Local
  const [motto, setMotto] = useState('');
  const [greetName, setGreetName] = useState('');
  const [greetResult, setGreetResult] = useState('—');
  const [mood, setMood] = useState('happy');
  const moodIdxRef = useRef(0);

  // ---- Effects: subscriptions & one-time loads ----------------------------

  // Counter subscription
  useEffect(() => {
    return counterHandle.subscribe(setCounterValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticker stream
  useEffect(() => {
    const stream = ticker();
    const unsub = stream.subscribe((value) => {
      setTickerValues((prev) => {
        const next = [...prev, value];
        return next.length > 20 ? next.slice(-20) : next;
      });
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Echo stream (native echoes back uppercased 'say' payloads)
  useEffect(() => {
    const stream = echoes();
    const unsub = stream.subscribe((text) => {
      setEchoEntries((prev) => [
        ...prev.slice(-19),
        { id: `recv-${Date.now()}`, direction: 'received', text, ts: Date.now() },
      ]);
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mood subscription (local-first state)
  useEffect(() => {
    return localhostMoodHandle.subscribe(setMood);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve motto on mount
  useEffect(() => {
    try {
      const m = (getMotto as () => string)();
      setMotto(m);
    } catch {
      setMotto('(unavailable)');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // JS-provided values: resolve once on mount so screen can display them
  useEffect(() => {
    jsInfoImpl
      .getReactNativeVersion()
      .then(setRnVersion)
      .catch(() => setRnVersion('error'));
    jsInfoImpl
      .getUserLevel()
      .then(setUserLevel)
      .catch(() => setUserLevel(null));
    jsInfoImpl
      .getUserSegments()
      .then(setUserSegments)
      .catch(() => setUserSegments([]));

    // Show clock ticks locally too (same source as what native subscribes to)
    const src = jsInfoImpl.clockTicks();
    const unsub = src.subscribe((v) => {
      setClockTickValues((prev) => {
        const next = [...prev, v];
        return next.length > 20 ? next.slice(-20) : next;
      });
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Handlers -----------------------------------------------------------

  const handlePing = useCallback(async () => {
    setPinging(true);
    try {
      const r = await ping({ message: pingMessage || 'hello from RN' });
      setPingResult(`${r.reply}  ·  epoch ${r.epoch}`);
    } catch (err) {
      setPingResult(`Error: ${String(err)}`);
    } finally {
      setPinging(false);
    }
  }, [ping, pingMessage]);

  const handleIncrement = useCallback(async () => {
    try {
      await increment();
    } catch (err) {
      console.warn('[BridgekitDemo] increment error:', err);
    }
  }, [increment]);

  const handleSay = useCallback(() => {
    if (!echoInput.trim()) return;
    const text = echoInput.trim();
    setEchoEntries((prev) => [
      ...prev.slice(-19),
      { id: `sent-${Date.now()}`, direction: 'sent', text, ts: Date.now() },
    ]);
    try {
      say({ text });
    } catch (err) {
      console.warn('[BridgekitDemo] say error:', err);
    }
    setEchoInput('');
  }, [say, echoInput]);

  const handleGreet = useCallback(async () => {
    try {
      const name = greetName.trim() || 'World';
      const result = await (greet as (p: { name: string }) => Promise<string>)({ name });
      setGreetResult(result);
    } catch (err) {
      setGreetResult(`Error: ${String(err)}`);
    }
  }, [greet, greetName]);

  const handleMoodCycle = useCallback(() => {
    moodIdxRef.current = (moodIdxRef.current + 1) % MOOD_CYCLE.length;
    const next = MOOD_CYCLE[moodIdxRef.current] ?? 'happy';
    // Update through the real provider binding. The mood subscription above owns
    // the React state update; no parallel local-only setState fallback.
    getDefaultBridgeKit()
      .registry.resolve(useLocalhost.id, GLOBAL_SCOPE)
      ?.binding.setState('mood', next);
  }, []);

  return {
    // Ping
    pingResult,
    pinging,
    pingMessage,
    setPingMessage,
    handlePing,
    // Counter
    counterValue,
    handleIncrement,
    // Ticker
    tickerValues,
    // Echo
    echoInput,
    setEchoInput,
    handleSay,
    echoEntries,
    // JS-provided readout
    rnVersion,
    userLevel,
    userSegments,
    clockTickValues,
    jsStatus,
    // Local
    motto,
    greetName,
    setGreetName,
    greetResult,
    handleGreet,
    mood,
    handleMoodCycle,
  };
}
