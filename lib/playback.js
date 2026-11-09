// Monotonic packet counter: never reset loop progress to zero inside a catch-up loop.
export function packetPlayer(write, { now = () => performance.now(), interval = setInterval, clear = clearInterval } = {}) {
  let timer = null, finish = null;
  const stop = () => { if (timer !== null) clear(timer); timer = null; finish?.(); finish = null; };
  const play = (packets, { loop = false } = {}) => {
    stop();
    if (!packets.length) return Promise.resolve();
    return new Promise(resolve => {
      finish = resolve; const start = now(); let sent = 0;
      const tick = () => {
        const due = Math.floor((now() - start) / 20) + 1;
        // At most five packets per tick, even after long event-loop stalls.
        const target = Math.min(due, sent + 5);
        while (sent < target) {
          if (!loop && sent >= packets.length) return stop();
          write(packets[sent % packets.length], sent); sent++;
        }
        if (!loop && sent >= packets.length) stop();
      };
      timer = interval(tick, 10);
    });
  };
  return { play, stop };
}
